"""The first adapter: the synthetic FX source (authorization §7.1).

It wraps the existing generator **at the value level**. `rate_for` and
`scheduled_ms` are imported from `generator.py` and **called, not copied**, so a
given `(seed, pair, sequence)` yields the same decimal string on this path as on
the D-24 path, and the two cannot drift. `generator.py` itself is **unchanged**
(§7.3): nothing here edits it, subclasses it or re-implements it.

**Values only — no envelope, no hash, no I/O** (§7.1, AD-5 §3.1). This adapter
deliberately does **not** call `FxGenerator.due()`, which builds envelopes:
envelope construction, canonical hashing, `event_id` derivation, schema
validation, the sink and the clock are the **service's** (AD-5 §3.4). An adapter
that built its own envelope would be a second implementation of AD-4, and two
implementations eventually disagree.

**What this adapter never does**

- **No network, no file, no credential.** It has no transport: a synthetic
  source is its own provider, so `transient_network`, `provider_unavailable`,
  `rate_limited` and `auth_failure` are unreachable here (`faults.py`).
- **It never sets `supersedes`** (AD5-Q10, authorization §4.4). The generator
  publishes no corrections, and inferring one from a value simply differing is
  what turns a C-a conflict into a silent overwrite.
- **It never reads a wall clock** (AD-5 §3.5). Every timestamp comes from the
  injected clock, so replay is deterministic and a test moves time without
  waiting.
- **It emits no bridge-state value, and no such event type exists**
  (criterion 12, AD-6 §1). The rates are deliberately unrealistic (AD-1 §3), and
  observations never reach routing.

**Timestamps are the scheduled moment, not the moment the poll happened**, which
is the rule the D-24 generator already follows: a late or coarse poll must not
make an observation look fresher than the thing it stands for.
"""
from __future__ import annotations

from typing import Optional, Sequence

from ..generator import PAIR_INTERVAL_MS, PAIR_STAGGER_MS, rate_for, scheduled_ms
from ..pairs import PAIRS, RATE_TYPE, Pair
from .base import Adapter, AdapterDescription, NormalizedObservation
from .context import AdapterContext
from .faults import AdapterFault, FaultClass

ADAPTER_ID = "synthetic_fx"

# The subjects this adapter can emit, in the AD-5 §6.3 tuple form and in the
# fixed (base, quote) order `pairs.py` defines once for the whole component.
SUBJECTS = tuple((pair.base, pair.quote, RATE_TYPE) for pair in PAIRS)

# The registry fields this adapter needs present. Checked against the record's
# field set at startup by `registry.check_description`.
REQUIRED_REGISTRY_FIELDS = (
    "source_id", "transport", "provenance_class", "subjects", "event_types",
    "freshness_profile", "plausibility", "timestamp_basis", "dedup",
)


class SyntheticFxAdapter(Adapter):
    """One registry-selected synthetic FX source.

    One instance serves exactly one `source_id` (AD-5 §3.1). It holds one
    sequence counter per pair and no event, so its memory is four integers
    whatever the run length — the same bound the D-24 generator keeps.
    """

    def __init__(self, source_id: str, seed: int, *,
                 interval_ms: int = PAIR_INTERVAL_MS,
                 stagger_ms: int = PAIR_STAGGER_MS) -> None:
        super().__init__(source_id)
        if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed <= 2 ** 53 - 1:
            raise ValueError("seed must be an integer in [0, 2^53 - 1] (AD-4 §3.2)")
        if interval_ms < 1 or stagger_ms < 0:
            raise ValueError("interval_ms must be positive and stagger_ms non-negative")
        self.seed = int(seed)
        self.interval_ms = int(interval_ms)
        self.stagger_ms = int(stagger_ms)
        self.start_ms: Optional[int] = None
        self._next_sequence = {pair.key: 1 for pair in PAIRS}
        self.skipped_ticks = 0

    # ------------------------------------------------------------------ describe
    def describe(self) -> AdapterDescription:
        """Static: it describes the code, not the configuration (AD-5 §3.2)."""
        return AdapterDescription(
            adapter_id=ADAPTER_ID,
            transports=("synthetic",),
            event_types=("fx_rate",),
            subjects=SUBJECTS,
            required_registry_fields=REQUIRED_REGISTRY_FIELDS,
            emits_timestamp_basis="observed",
            # A synthetic source produces on a schedule, so it polls. It is its
            # own provider, so what it reports it observed (AD-4 §5).
            production_mode="poll",
        )

    @classmethod
    def for_record(cls, record, seed: int) -> "SyntheticFxAdapter":
        """An adapter for one validated registry record (AD-5 §3.1).

        The seed comes from the record's **recorded allocation**, never from the
        record and never from the environment: AD-12 §3.1 mitigation 1 makes the
        allocation file the authority, so an adapter cannot be given a seed that
        no reviewed commit allocated.
        """
        return cls(record.source_id, seed,
                   interval_ms=record.freshness_profile.expected_interval_ms)

    # ----------------------------------------------------------------- lifecycle
    def _start(self, context: AdapterContext) -> None:
        """Acquires nothing: there is no transport to acquire.

        It records the injected clock's start moment, which is what makes the
        schedule reproducible — the same `start_ms`, seed and sequence give the
        same observations on any machine and at any time.
        """
        self.start_ms = context.now_ms()

    def _stop(self, *, deadline_ms: int = 2000) -> None:
        """Releases nothing, within any budget. Holding no resource is why
        `stop()` here cannot exceed AD-8's 2 000 ms (authorization §5.2)."""
        return None

    # ------------------------------------------------------------------- produce
    def _produce(self) -> Sequence[NormalizedObservation]:
        """The due observations, at most **one per pair per call**.

        Bounded on purpose: if the clock jumps forward, the skipped ticks are
        counted and dropped rather than replayed as a backlog. The ordering
        watermark ages an old value out safely, so there is nothing to gain from
        emitting it — the rule `generator.py` already applies.
        """
        if self.start_ms is None:
            raise AdapterFault(FaultClass.INTERNAL, "produce_before_start",
                               source_id=self.source_id)
        now_ms = self._context.now_ms()
        observations = []
        for index, pair in enumerate(PAIRS):
            sequence = self._next_sequence[pair.key]
            if self._scheduled(index, sequence) > now_ms:
                continue
            # Catch up arithmetically rather than by stepping, so a clock jumped
            # forward by a year costs one division instead of millions of loops.
            latest = (now_ms - self.start_ms - index * self.stagger_ms) // self.interval_ms + 1
            if latest < sequence:  # unreachable; a defect here is `internal`, not silent
                raise AdapterFault(FaultClass.INTERNAL, "due_sequence_before_next",
                                   source_id=self.source_id)
            self.skipped_ticks += latest - sequence
            self._next_sequence[pair.key] = latest + 1
            observations.append(self.normalize({
                "pair": pair,
                "rate": rate_for(self.seed, pair, latest),
                "at_ms": self._scheduled(index, latest),
                "sequence": latest,
            }))
        return tuple(observations)

    def _scheduled(self, pair_index: int, sequence: int) -> int:
        """When observation `sequence` (from 1) of pair `pair_index` falls due.

        Uses `generator.scheduled_ms` when this adapter runs at the generator's
        own interval and stagger, and the same arithmetic otherwise, so the two
        paths cannot drift at the default configuration.
        """
        if self.interval_ms == PAIR_INTERVAL_MS and self.stagger_ms == PAIR_STAGGER_MS:
            return scheduled_ms(self.start_ms, pair_index, sequence)
        return self.start_ms + pair_index * self.stagger_ms + (sequence - 1) * self.interval_ms

    # ----------------------------------------------------------------- normalize
    def normalize(self, raw) -> NormalizedObservation:
        """One raw item as a normalized observation. **Format work only** (AD-5 §4).

        No hashing, no envelope assembly and no I/O. The rate stays the **decimal
        string** `rate_for` produced, with its six places intact: a trailing zero
        is significant to the payload hash, so it is never round-tripped through
        a float. A missing required field is a **rejection** — an `item_invalid`
        fault — and never a default, which is what acceptance criterion 7 asserts.
        """
        for field in ("pair", "rate", "at_ms", "sequence"):
            if field not in raw:
                raise AdapterFault(FaultClass.ITEM_INVALID, f"missing_{field}",
                                   source_id=self.source_id)
        pair: Pair = raw["pair"]
        rate = raw["rate"]
        if not isinstance(rate, str):
            # AD-5 §4: a float here would already have lost the producer's digits.
            raise AdapterFault(FaultClass.ITEM_INVALID, "rate_not_a_decimal_string",
                               source_id=self.source_id)
        return NormalizedObservation(
            event_type="fx_rate",
            subject=(pair.base, pair.quote, RATE_TYPE),
            payload={
                "base_currency": pair.base,
                "quote_currency": pair.quote,
                "rate": rate,
                "rate_type": RATE_TYPE,
            },
            # Never filled from a local clock (AD-5 §3.5, AD-4 §5). The generator
            # is its own provider, so what it reports, it observed.
            source_timestamp_ms=int(raw["at_ms"]),
            source_timestamp_basis="observed",
            sequence=int(raw["sequence"]),
        )
