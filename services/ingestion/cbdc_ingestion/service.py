"""The ingestion service: lifecycle, the generator loop and the response body.

One `IngestionService` owns a seeded `FxGenerator`, a bounded `LatestStore` and
the background thread that moves events from one to the other. It is separate
from the HTTP layer (`http_api.py`) so that every rule can be tested without a
socket, and so that the HTTP layer holds no state of its own.

Lifecycle (AD-1 §3.1): `starting` before the loop runs, `running` once it does,
then `stopping` and `stopped`. `GET /v1/latest` answers `503 NOT_READY` unless
the state is `running`. `running` says nothing about whether any event exists
yet: before the first one the endpoint answers `200` with `events: []`, which
AD-1 §3.1 requires in place of `204` or `404`.

`instance_id` is a fresh UUID at each start (AD-1 §3.1) and is **diagnostic
only**: AD-1 §3.4 says consumers order by `source_timestamp` and that an
ingestion restart needs no reset, so nothing may key state on it.

---

**Phase 3.3-A: the adapter path is additive, and the generator path is the
default** (authorization §7.2).

`IngestionService(seed, ...)` behaves **exactly** as it did: it owns an
`FxGenerator`, `tick()` drives it, and **nothing reads the registry, the
allocation file or the adapters package**. D-24 behaviour is unchanged, and
`test_seed_allocation.py` asserts both halves — that the generator starts with
no registry record and no allocation entry, and that the default path never
calls `load_registry`.

The adapter path exists only when a caller passes `sources=` (from
`CBDC_INGESTION_SOURCES`, empty by default). It is **off unless named**: no
registry record selects it, and selecting one is a deliberate act.

The adapter path is **not activatable today** — `pipeline.build_envelope`
refuses by name, because `envelope.py` writes a constant `source_id` and is
untouched by rule (§7.3). See `pipeline.py`'s docstring: it needs an owner
decision and is not taken here. **Also still missing from the §3.4 path:**
`dedup.py` (AD5-Q1, AD5-Q8), `status.py` (AD-5 §9.2) and the plausibility
bounds. Until they exist the adapter path is incomplete, and it says so rather
than appearing complete.
"""
from __future__ import annotations

import logging
import threading
import uuid
from typing import Optional, Sequence

from . import PROTOCOL_VERSION, SOURCE_ID
from .clock import Clock, SystemClock, format_timestamp
from .generator import FxGenerator
from .store import LatestStore

logger = logging.getLogger(__name__)

# How long the loop sleeps when nothing is due. Short enough that the 500 ms
# stagger is honoured, long enough that an idle process is not a busy loop.
LOOP_TICK_S = 0.05

# One log line at most per this many seconds, per reason (AD-1 §3.4's
# "rate-limited logs"). A fault that repeats every tick must not fill a disk.
LOG_INTERVAL_MS = 10_000

STATES = ("starting", "running", "stopping", "stopped")


class IngestionService:
    """The component's state and its generator thread."""

    def __init__(self, seed: int, *, clock: Optional[Clock] = None, case_id: str = "normal",
                 start_ms: Optional[int] = None,
                 sources: Sequence[str] = (),
                 registry_path=None, allocations_path=None) -> None:
        self.clock: Clock = clock or SystemClock()
        self.instance_id = str(uuid.uuid4())
        self.store = LatestStore()
        self.generator = FxGenerator(seed, self.clock, start_ms=start_ms, case_id=case_id)
        # Phase 3.3-A. Empty by default, so the three lines below do nothing and
        # the registry is never read: the D-24 path is exactly as it was.
        self.sources = tuple(sources)
        self._registry_path = registry_path
        self._allocations_path = allocations_path
        self._adapters: list = []
        self._sink = None
        self._state = "starting"
        self._state_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._last_log_ms: dict = {}

    # ---------------------------------------------------------------- lifecycle
    @property
    def state(self) -> str:
        with self._state_lock:
            return self._state

    def _set_state(self, value: str) -> None:
        assert value in STATES
        with self._state_lock:
            self._state = value

    @property
    def ready(self) -> bool:
        """Whether `GET /v1/latest` may answer 200 (AD-1 §3.1)."""
        return self.state == "running"

    def start(self, run_loop: bool = True) -> "IngestionService":
        """Marks the service running and starts the generator thread. Idempotent.

        `run_loop=False` marks it running **without** the background thread, so a
        caller drives time itself with `tick(now_ms)` on a `ManualClock`. The tests
        use it: a background loop ticking against the same manual clock would race
        with the test's own ticks and make the empty state unobservable.
        """
        if self._thread is not None or self.state == "running":
            return self
        # The registry is loaded **only** when a source was named. With none
        # named this is a no-op and the default path is untouched (§7.2).
        if self.sources:
            self._start_adapters()
        if not run_loop:
            self._set_state("running")
            return self
        self._thread = threading.Thread(target=self._loop, name="fx-generator", daemon=True)
        self._set_state("running")
        self._thread.start()
        logger.info("ingestion started: instance_id=%s source_id=%s seed=%d (synthetic, display-only)",
                    self.instance_id, SOURCE_ID, self.generator.seed)
        return self

    def stop(self, timeout_s: float = 2.0) -> None:
        """Stops the generator thread and leaves the service unready. Idempotent."""
        if self.state in ("stopping", "stopped") and self._thread is None:
            return
        self._set_state("stopping")
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=timeout_s)
        # Cooperative, and idempotent from any state (AD-5 §5.2, authorization
        # §5.2): the cancellation signal is delivered and the adapter returns.
        # Nothing is killed and no thread is terminated from outside.
        for adapter, _record, _seed in self._adapters:
            adapter.stop(deadline_ms=2000)
        self._adapters = []
        self._set_state("stopped")
        logger.info("ingestion stopped: %s", self.store.counters())

    def __enter__(self) -> "IngestionService":
        return self.start()

    def __exit__(self, *exc) -> None:
        self.stop()

    # ------------------------------------------------------------------ the loop
    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception:  # noqa: BLE001 - the loop must outlive one bad tick
                # No payload and no envelope is logged: only the traceback of a defect
                # in this component, which has no external input to leak.
                logger.exception("generator tick failed; continuing")
            self._stop.wait(LOOP_TICK_S)

    def tick(self, now_ms: Optional[int] = None) -> int:
        """Applies every event due now. Returns how many became current.

        Called by the loop, and directly by tests with a `ManualClock`, so no test
        of the acceptance or ordering rules needs a real wait.
        """
        applied = 0
        # **Mutually exclusive, and that is the owner's condition** (the
        # Phase 3.3-A Option B decision of 27 November 2026). The D-24
        # generator and the registry-selected adapter share `source_id`
        # `synthetic.fx`, so only one generator configuration may be active for
        # it at any time. Selecting a record **replaces** the generator; it does
        # not run beside it. With no record selected the generator runs exactly
        # as it does today, which is §7.2's "until a registry record selects the
        # adapter path".
        if self._adapters:
            return self._tick_adapters(now_ms)
        for event in self.generator.due(now_ms):
            if self.store.apply(event):
                applied += 1
            else:
                self._log_withheld(event)
        return applied

    # ----------------------------------------------------------- the adapter path
    def _start_adapters(self) -> None:
        """Loads the registry, validates it, and starts each selected adapter.

        **Every check is a startup failure, never a warning** (AD-5 §2.1,
        acceptance criteria 1, 2 and 8): the registry and the allocations are
        validated, each record's `describe()` is checked against it, and each
        adapter's seed comes from its **recorded allocation** — never from the
        record and never from `CBDC_INGESTION_SEED`, which belongs to the
        exempt D-24 generator.

        Imported here, not at module import, so the default path does not even
        load the adapters package.
        """
        from .adapters.registry import (
            RegistryInvalid, check_description, load_registry, selected_records)
        from .adapters.synthetic_fx import SyntheticFxAdapter
        from .adapters.context import AdapterContext, CancellationSignal, NullMetrics
        from .sink import ServiceSink

        registry = load_registry(self._registry_path, self._allocations_path)
        records = selected_records(registry, self.sources)
        # The owner's Option B condition, enforced rather than trusted: at most
        # one active generator configuration per `source_id`. Two selected
        # records sharing one is a **startup failure**, not a warning.
        chosen = [r.source_id for r in records]
        if len(set(chosen)) != len(chosen):
            raise RegistryInvalid(
                "two selected records share a source_id; only one generator "
                "configuration may be active for a source_id at a time "
                "(Phase 3.3-A Option B decision, AD4P2-Q2)")
        self._sink = ServiceSink(self.store)
        for record in records:
            allocation = registry.allocation_for(record.source_id)
            if allocation is None:  # unreachable: load_registry already refused
                raise RuntimeError(f"{record.source_id}: no active seed allocation")
            adapter = SyntheticFxAdapter.for_record(record, allocation.seed)
            check_description(record, adapter.describe())
            context = AdapterContext(
                source_id=record.source_id, clock=self.clock, sink=self._sink,
                cancellation=CancellationSignal(), metrics=NullMetrics(),
            )
            adapter.start(context)
            self._adapters.append((adapter, record, allocation.seed))
            logger.info("adapter started: source_id=%s adapter_id=%s state=%s",
                        record.source_id, record.adapter_id, adapter.state)

    def _tick_adapters(self, now_ms: Optional[int] = None) -> int:
        """One production cycle per started adapter. A no-op when none is."""
        if not self._adapters:
            return 0
        from .pipeline import run_cycle

        published = 0
        for adapter, record, seed in self._adapters:
            result = run_cycle(adapter, record, self._sink, seed=seed,
                               retrieved_at_ms=self.clock.now_ms() if now_ms is None else now_ms)
            published += result.published
            for reason in result.reasons:
                self._log_adapter_reason(record.source_id, reason)
        return published

    def _log_adapter_reason(self, source_id: str, reason: str) -> None:
        """Rate-limited, and the reason code only — never a payload (AD-1 §3.4)."""
        key = f"{source_id}:{reason}"
        now_ms = self.clock.now_ms()
        if now_ms - self._last_log_ms.get(key, -LOG_INTERVAL_MS) < LOG_INTERVAL_MS:
            return
        self._last_log_ms[key] = now_ms
        logger.warning("adapter item withheld: source_id=%s reason=%s", source_id, reason)

    def _log_withheld(self, event: dict) -> None:
        """Rate-limited diagnostics for an event that did not become current.

        AD-1 §3.4 allows the reason and, when the event is well formed, the
        `event_id`. Nothing else: no payload, no rate, no timestamps.
        """
        status = event.get("validation", {}).get("status")
        reasons = event.get("validation", {}).get("reasons") or []
        reason = ",".join(reasons) if status == "quarantined" else "not_current"
        now_ms = self.clock.now_ms()
        if now_ms - self._last_log_ms.get(reason, -LOG_INTERVAL_MS) < LOG_INTERVAL_MS:
            return
        self._last_log_ms[reason] = now_ms
        event_id = event.get("event_id") if isinstance(event.get("event_id"), str) else None
        logger.warning("event withheld: reason=%s event_id=%s", reason, event_id)

    # --------------------------------------------------------------- the payload
    def latest_response(self) -> dict:
        """The `GET /v1/latest` 200 body (AD-1 §3.1). A closed shape, all fields required."""
        return {
            "protocol_version": PROTOCOL_VERSION,
            "instance_id": self.instance_id,
            "source_id": SOURCE_ID,
            "generated_at": format_timestamp(self.clock.now_ms()),
            "events": self.store.events(),
        }
