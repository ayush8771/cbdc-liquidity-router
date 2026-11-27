"""The A-4 adapter: a synthetic FX source reached through a **transport seam**.

This is the adapter that makes AD-5 §7.1's network classes *reachable*, which
`faults.py` records as the reason they were unexercised in Phase 3.3-A: its one
adapter wrapped a local generator and so had nothing to fault.

**It is additive, and it changes nothing that exists.**

- `SyntheticFxAdapter` is **untouched**, so acceptance criteria 1 to 16 and the
  cross-restart determinism of criterion 4 are unaffected.
- **No registry record selects this adapter.** `registry/sources.json` names
  `adapter_id: synthetic_fx`, and `check_description` makes a mismatch a startup
  failure, so the service path cannot reach this class. It is driven by the A-4
  suite and by the demonstration CLI, through the **real** `SourcePipeline` —
  the real admission, the unchanged `envelope.py`, the unchanged
  `validation.py`, the real dedup classifier, the real plausibility guard, the
  real internal status machine and the real sink — which is what makes the
  exercise evidence about the system rather than about a mock.
- `CBDC_INGESTION_SOURCES` stays empty by default, so the **D-24 generator
  remains the service default** and its behaviour is bit-identical.

**It observes the same values as the D-24 path.** `rate_for` is imported from
the unchanged `generator.py` and *called*, so a given `(seed, pair, sequence)`
yields the same decimal string here, on the 3.3-A adapter path and on the D-24
path. A fault case therefore differs from a clean case in its **faults only**,
never in its values — which is what lets the demonstration show recovery
converging back onto the expected series.

**Backoff is honoured without sleeping.** The adapter holds a `next_attempt_ms`
gate read from the **injected** clock (AD-5 §3.5): while the gate is in the
future `produce()` returns nothing and makes **no transport call**. A test
advances the clock instead of waiting, so the whole A-4 suite runs in
milliseconds and gives the same result on every machine.

**Nothing here opens a connection.** The transport is supplied by the caller and
must declare `kind == "in_process_simulation"` (`transport.assert_admissible`);
there is no fallback that fetches by itself, so an adapter with no transport
produces nothing rather than reaching for one.
"""
from __future__ import annotations

from typing import Optional, Sequence

from ..generator import PAIR_INTERVAL_MS
from ..pairs import PAIRS, RATE_TYPE
from .base import Adapter, AdapterDescription, NormalizedObservation
from .context import AdapterContext
from .faults import AdapterFault, FaultClass
from .response import ITEM_FIELDS, read_response
from .retry import BackoffPolicy, CircuitBreaker
from .simulation import SIMULATION_TIMING, SimulatedTimingProfile
from .transport import assert_admissible

ADAPTER_ID = "simulated_transport_fx"

SUBJECTS = tuple((pair.base, pair.quote, RATE_TYPE) for pair in PAIRS)

REQUIRED_REGISTRY_FIELDS = (
    "source_id", "transport", "provenance_class", "subjects", "event_types",
    "freshness_profile", "plausibility", "timestamp_basis", "dedup",
)

# Why a cycle made no transport call. Counted, never silent (AD-5 §7.5).
DEFERRED_BACKOFF = "deferred_backoff"
DEFERRED_BREAKER_OPEN = "deferred_breaker_open"
DEFERRED_CEILING = "deferred_self_imposed_ceiling"


class SimulatedTransportFxAdapter(Adapter):
    """One synthetic FX source pulled through a scripted, in-process transport.

    The transport is **pull-only** and in-process. The adapter's own state
    machine, fault classification and terminal path are the base class's, so
    this adapter reaches `failed_permanent` on exactly the classes every other
    adapter does.
    """

    def __init__(self, source_id: str, seed: int, *,
                 transport=None,
                 profile: SimulatedTimingProfile = SIMULATION_TIMING,
                 jitter=None, jitter_seed: int = 0,
                 interval_ms: int = PAIR_INTERVAL_MS) -> None:
        super().__init__(source_id)
        if not profile.is_simulation:
            raise ValueError("A-4 runs on a SIMULATION_ONLY profile")
        if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed <= 2 ** 53 - 1:
            raise ValueError("seed must be an integer in [0, 2^53 - 1] (AD-4 §3.2)")
        self.seed = int(seed)
        self.profile = profile
        self.interval_ms = int(interval_ms)
        self.backoff = BackoffPolicy(profile, jitter=jitter, seed=jitter_seed)
        self.breaker = CircuitBreaker(source_id, profile)
        self._transport = None
        if transport is not None:
            self.attach(transport)
        # Gates, in injected-clock milliseconds. `None` means "no gate".
        self.next_attempt_ms: Optional[int] = None
        self.last_request_ms: Optional[int] = None
        # Counters a test and the demonstration read. No payload, ever.
        self.transport_calls = 0
        self.deferrals: dict = {DEFERRED_BACKOFF: 0, DEFERRED_BREAKER_OPEN: 0,
                                DEFERRED_CEILING: 0}
        self.last_decision = None
        self.retry_after_reasons: list = []

    # ------------------------------------------------------------------ describe
    def describe(self) -> AdapterDescription:
        """Static capabilities (AD-5 §3.2).

        `transports` is `("synthetic",)`: the **source** is still synthetic — no
        provider, no endpoint, no credential, no egress. The transport seam is
        how its values are *delivered* in the simulation, not a claim that the
        source became a provider. A registry record's `transport` field keeps its
        approved meaning, and no new transport value is introduced.
        """
        return AdapterDescription(
            adapter_id=ADAPTER_ID,
            transports=("synthetic",),
            event_types=("fx_rate",),
            subjects=SUBJECTS,
            required_registry_fields=REQUIRED_REGISTRY_FIELDS,
            emits_timestamp_basis="observed",
            production_mode="poll",
        )

    # ----------------------------------------------------------------- transport
    def attach(self, transport) -> str:
        """Attaches a transport, refusing any kind this scope does not admit."""
        kind = assert_admissible(transport)
        self._transport = transport
        return kind

    @property
    def transport(self):
        return self._transport

    # ----------------------------------------------------------------- lifecycle
    def _start(self, context: AdapterContext) -> None:
        """Acquires nothing: the transport is in-process and already supplied.

        A missing transport is a **permanent** `contract_violation` rather than a
        silent idle: an adapter configured without its source would otherwise
        look like a healthy source that happens to be quiet, which is exactly the
        confusion AD-5 §9.1 separates status from freshness to avoid.
        """
        if self._transport is None:
            raise AdapterFault(FaultClass.CONTRACT_VIOLATION, "no_transport_attached",
                               source_id=self.source_id)

    def _stop(self, *, deadline_ms: int = 2000) -> None:
        """Releases nothing. There is no connection to close."""
        self._transport = None

    # ------------------------------------------------------------------- produce
    def _produce(self) -> Sequence[NormalizedObservation]:
        """One poll: the gates, then the transport, then the §7.3 judgement.

        The order is the whole point. A refused poll **makes no transport call**,
        so the breaker's cooldown genuinely costs nothing, and a test asserts
        `transport_calls` did not move rather than trusting the claim.
        """
        now_ms = self._context.now_ms()

        if self._transport is None:
            raise AdapterFault(FaultClass.CONTRACT_VIOLATION, "no_transport_attached",
                               source_id=self.source_id)

        # Gate 1: the breaker. Refused without contacting anything (AD-5 §7.4).
        if not self.breaker.allow(now_ms):
            self.deferrals[DEFERRED_BREAKER_OPEN] += 1
            self._count(DEFERRED_BREAKER_OPEN)
            return ()

        # Gate 2: the computed backoff (AD-5 §7.2).
        if self.next_attempt_ms is not None and now_ms < self.next_attempt_ms:
            # The breaker has already admitted this poll as its probe, so the
            # probe must be released or it stays in flight for ever and every
            # later poll is refused (D-1).
            self.breaker.release_probe(now_ms)
            self.deferrals[DEFERRED_BACKOFF] += 1
            self._count(DEFERRED_BACKOFF)
            return ()

        # Gate 3: the adapter's own ceiling, strictly below any provider limit
        # (AD-5 §7.4: "the provider's limit is a cliff, not a target").
        if self.last_request_ms is not None and \
                now_ms - self.last_request_ms < self.profile.min_request_interval_ms:
            self.breaker.release_probe(now_ms)
            self.deferrals[DEFERRED_CEILING] += 1
            self._count(DEFERRED_CEILING)
            return ()

        self.transport_calls += 1
        self.last_request_ms = now_ms
        try:
            response = self._transport.fetch()
        except AdapterFault:
            raise
        except Exception as exc:  # noqa: BLE001 - a scaffold defect is `internal`
            self._on_failure(now_ms, FaultClass.INTERNAL, None)
            raise AdapterFault(FaultClass.INTERNAL, type(exc).__name__,
                               source_id=self.source_id) from None

        try:
            items, retry_after = read_response(
                response, source_id=self.source_id, allowed_subjects=SUBJECTS,
                profile=self.profile)
        except AdapterFault as fault:
            self._on_failure(now_ms, fault.fault_class, response.header("Retry-After"))
            raise

        # The poll succeeded. A **connection** is not progress (AD-5 §7.2), so an
        # empty response resets nothing: it is the silence criterion's input, and
        # `status.tick` is what notices it.
        if not items:
            self.backoff.on_connect_success()
            # Neither a success nor a failure, so a half-open probe that ended
            # here has no verdict to report; releasing it is what lets a later
            # cooldown admit another one (D-1).
            self.breaker.release_probe(now_ms)
            return ()

        # **One bad item does not discard a good response** (AD-5 §7.1, §7.3).
        # Each item is normalized on its own and an item fault is recorded and
        # skipped, so the rest of the response still reaches the service. The
        # fault is queued for `drain_faults()`, which is how it reaches a
        # counter: an item fault changes no adapter state, so without the queue
        # it would leave no trace at all.
        observations = []
        for item in items:
            try:
                observations.append(self.normalize(item))
            except AdapterFault as fault:
                if not fault.item_level:
                    raise
                self._record_fault(fault)

        if not observations:
            # The response was well formed and the items were not. That is
            # neither a transport success nor a transport failure: nothing
            # resets, nothing opens the breaker, and the silence criterion is
            # left to notice that no item arrived. The probe is still released,
            # because an unreported probe would wedge the breaker (D-1).
            self.breaker.release_probe(now_ms)
            return ()

        # One successful item is what resets the counter and closes the breaker.
        self.backoff.on_item_success()
        self.breaker.record_success(now_ms)
        self.next_attempt_ms = None
        return tuple(observations)

    def _on_failure(self, now_ms: int, fault_class: FaultClass,
                    retry_after) -> None:
        """Records the failure against the breaker and sets the next gate.

        A **permanent** class gets no gate at all: `failed_permanent` has no
        backoff because it has no retry (AD-5 §7.2), and leaving a wait on it
        would suggest one.
        """
        self.breaker.record_failure(now_ms)
        decision = self.backoff.next_decision(fault_class, retry_after=retry_after)
        self.last_decision = decision
        self.retry_after_reasons.append(decision.retry_after_reason)
        if decision.retry:
            self.next_attempt_ms = int(now_ms) + int(decision.wait_ms)
        else:
            self.next_attempt_ms = None

    def _count(self, reason: str) -> None:
        context = self._context
        if context is not None:
            context.metrics.increment("adapter_polls_deferred", 1,
                                      source_id=self.source_id, reason=reason)

    # ----------------------------------------------------------------- normalize
    def normalize(self, raw) -> NormalizedObservation:
        """One wire item as a normalized observation. **Format work only.**

        A missing or badly typed field is an **item** rejection and never a
        default (AD-5 §4, acceptance criterion 7); the response around it is
        unaffected. The rate stays the decimal string the producer sent, with its
        digits intact — never round-tripped through a float, because a trailing
        zero is significant to the payload hash.
        """
        for field in ITEM_FIELDS:
            if field not in raw:
                raise AdapterFault(FaultClass.ITEM_INVALID, f"missing_{field}",
                                   source_id=self.source_id)
        rate = raw["rate"]
        if not isinstance(rate, str):
            raise AdapterFault(FaultClass.ITEM_INVALID, "rate_not_a_decimal_string",
                               source_id=self.source_id)
        try:
            at_ms = int(raw["at_ms"])
            sequence = int(raw["sequence"])
        except (TypeError, ValueError):
            raise AdapterFault(FaultClass.ITEM_INVALID, "non_integer_timing_field",
                               source_id=self.source_id) from None
        if raw["rate_type"] != RATE_TYPE:
            raise AdapterFault(FaultClass.ITEM_INVALID, "unknown_rate_type",
                               source_id=self.source_id)
        # **A4-19, Target A classification.** A well-formed item for a subject
        # this adapter does not declare is **one item's** problem, so it is a
        # non-permanent `item_invalid`: the response's shape is fine, the other
        # items in it are good, and §7.3's whole-response checks have already
        # passed it. Rejecting the item here rather than letting it travel on to
        # the service's admission keeps the verdict with the party that knows the
        # subject allowlist, and keeps it out of the permanent classes — a
        # provider adding a pair we do not consume must not retire the source.
        if (raw["base"], raw["quote"], RATE_TYPE) not in SUBJECTS:
            raise AdapterFault(FaultClass.ITEM_INVALID, "unlisted_subject",
                               source_id=self.source_id)
        return NormalizedObservation(
            event_type="fx_rate",
            subject=(raw["base"], raw["quote"], RATE_TYPE),
            payload={
                "base_currency": raw["base"],
                "quote_currency": raw["quote"],
                "rate": rate,
                "rate_type": RATE_TYPE,
            },
            source_timestamp_ms=at_ms,
            source_timestamp_basis="observed",
            sequence=sequence,
        )

    # ------------------------------------------------------------------ reporting
    def snapshot(self) -> dict:
        """Counters and states only — no payload, no rate (AD-1 §3.4)."""
        return {
            "source_id": self.source_id,
            "state": self.state,
            "transport_calls": self.transport_calls,
            "deferrals": dict(self.deferrals),
            "breaker": self.breaker.snapshot(),
            "backoff_attempt": self.backoff.attempt,
            "next_attempt_ms": self.next_attempt_ms,
        }
