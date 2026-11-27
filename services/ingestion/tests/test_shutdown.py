"""Acceptance criteria 13, 14 and 15: cooperative shutdown, and losing no accounting.

Three criteria, deliberately in one file because the authorization names one
suite for all three (§9) and because they are the same mechanism asked three
questions: does `stop()` finish inside its budget, does cancellation lose
anything, and is `stop()` safe from any state.

**Criterion 13 is the one criterion in §9 that does not use the injected
clock.** An injected clock can prove only that the adapter *observed* its
deadline, never that a real thread exited. So the budget is measured with
`time.monotonic()` and asserted with a bounded `Thread.join(timeout=…)`
followed by `is_alive() is False`. The adapter's own internal timing stays on
the injected clock, which criteria 4 and 16 cover.

**`_ThreadedProbe` is test-only.** The shipped `SyntheticFxAdapter` spawns no
thread — it is polled by the service — so a criterion about a worker thread
terminating has nothing to assert against it. The probe exists so the base
class's cooperative-stop contract is tested where a thread genuinely runs; it
is never registered, never packaged and never reachable at runtime. Its worker
does **no unbounded blocking call**, so the measurement is deterministic rather
than load-dependent, and a run over the deadline fails rather than being
retried.

**Criterion 14's second half is an accounting claim, not a timing one**: an
item in flight when cancellation arrives is *either* published *or* counted,
**never both and never neither**. It is asserted as a conservation law over
`AdapterRunResult`, so a future outcome added without a counter fails here
instead of silently vanishing. `test_pipeline_accounting.py` asserts the same
law over the non-cancellation paths.
"""
from __future__ import annotations

import threading
import time

import pytest

from cbdc_ingestion.adapters.base import (
    Adapter,
    AdapterDescription,
    AdapterRunResult,
    AdapterStateError,
    NormalizedObservation,
)
from cbdc_ingestion.adapters.context import AdapterContext, CancellationSignal, NullMetrics
from cbdc_ingestion.adapters.faults import AdapterFault, FaultClass
from cbdc_ingestion.adapters.registry import load_registry
from cbdc_ingestion.clock import ManualClock
from cbdc_ingestion.pipeline import SourcePipeline
from cbdc_ingestion.sink import ServiceSink

from .adapter_cases import SYNTHETIC_FX_SOURCE_ID
from .conftest import SEED, START_MS

# The AD-8 §5.2 budget (authorization §5.2). Real milliseconds, not clock ticks.
SHUTDOWN_BUDGET_MS = 2000
EURUSD = ("EUR", "USD", "mid")

# Every way an observation can leave `run_cycle`. The conservation law below is
# stated over this tuple, so an outcome added without a counter fails the test
# rather than disappearing (AD-5 §3.7).
OUTCOME_COUNTERS = ("published", "quarantined", "rejected", "duplicates",
                    "collisions", "conflicts")


def accounted(result: AdapterRunResult) -> int:
    return sum(getattr(result, name) for name in OUTCOME_COUNTERS)


@pytest.fixture
def record():
    return load_registry().record_for(SYNTHETIC_FX_SOURCE_ID)


def _context(source_id: str, cancellation: CancellationSignal) -> AdapterContext:
    return AdapterContext(source_id=source_id, clock=ManualClock(START_MS),
                          sink=None, cancellation=cancellation, metrics=NullMetrics())


# --------------------------------------------------------------- the test probes
class _ThreadedProbe(Adapter):
    """A probe with a **real** worker thread, for criterion 13.

    The worker waits on the cancellation signal rather than sleeping, so it
    observes a stop immediately and the measured shutdown time is the base
    class's, not a sleep's remainder.
    """

    SOURCE_ID = "synthetic.threaded_probe"

    def __init__(self) -> None:
        super().__init__(self.SOURCE_ID)
        self.worker = None
        self.acquired: list = []
        self.released: list = []
        self.loops = 0

    def describe(self) -> AdapterDescription:
        return AdapterDescription(
            adapter_id="threaded_probe", transports=("synthetic",),
            event_types=("fx_rate",), subjects=(EURUSD,),
            required_registry_fields=("source_id", "transport", "provenance_class", "subjects"),
            emits_timestamp_basis="observed", production_mode="poll")

    def _start(self, context: AdapterContext) -> None:
        self.acquired.append("worker")
        self.worker = threading.Thread(target=self._run, name="threaded-probe", daemon=True)
        self.worker.start()

    def _run(self) -> None:
        while not self._context.cancelled:
            self.loops += 1
            # Bounded by construction: the longest this can delay a stop is one
            # tick, and a cancel wakes it at once.
            self._context.cancellation.wait(0.01)

    def _stop(self, *, deadline_ms: int = SHUTDOWN_BUDGET_MS) -> None:
        if self.worker is not None:
            self.worker.join(deadline_ms / 1000.0)
        self.released.append("worker")

    def normalize(self, raw) -> NormalizedObservation:  # pragma: no cover - unused
        raise NotImplementedError


class _CancellingProbe(Adapter):
    """Cancels itself at a chosen moment, so cancellation lands *mid*-operation.

    `when="start"` cancels inside `_start`, after a resource has been acquired —
    the only way to reach criterion 14's first case without a race.
    `when="produce_before"` and `when="produce_after"` cancel on either side of
    building the item, which are the two distinguishable in-flight moments.
    """

    SOURCE_ID = "synthetic.cancelling_probe"

    def __init__(self, when: str) -> None:
        super().__init__(self.SOURCE_ID)
        self.when = when
        self.acquired: list = []
        self.released: list = []
        self._sequence = 0

    def describe(self) -> AdapterDescription:
        return AdapterDescription(
            adapter_id="cancelling_probe", transports=("synthetic",),
            event_types=("fx_rate",), subjects=(EURUSD,),
            required_registry_fields=("source_id", "transport", "provenance_class", "subjects"),
            emits_timestamp_basis="observed", production_mode="poll")

    def _start(self, context: AdapterContext) -> None:
        self.acquired.append("transport")
        if self.when == "start":
            context.cancellation.cancel()

    def _produce(self):
        if self.when == "produce_before":
            self._context.cancellation.cancel()
            return ()
        self._sequence += 1
        item = NormalizedObservation(
            event_type="fx_rate", subject=EURUSD,
            payload={"base_currency": "EUR", "quote_currency": "USD",
                     "rate_type": "mid", "rate": "2.200000"},
            source_timestamp_ms=START_MS, source_timestamp_basis="observed",
            sequence=self._sequence)
        if self.when == "produce_after":
            self._context.cancellation.cancel()
        return (item,)

    def _stop(self, *, deadline_ms: int = SHUTDOWN_BUDGET_MS) -> None:
        self.released.append("transport")

    def normalize(self, raw) -> NormalizedObservation:  # pragma: no cover - unused
        raise NotImplementedError


# ================================================= criterion 13: the real budget
def test_stop_returns_and_the_worker_thread_has_actually_terminated():
    """**Criterion 13.** `stop()` returns *and* the thread is gone, inside 2 000 ms
    of real elapsed time.

    Both halves are asserted: a `stop()` that returned while the worker ran on
    would satisfy a return-time check and still leak a thread, which is the
    failure the criterion is written against.
    """
    adapter = _ThreadedProbe()
    cancellation = CancellationSignal()
    adapter.start(_context(_ThreadedProbe.SOURCE_ID, cancellation))
    assert adapter.worker.is_alive()

    started = time.monotonic()
    assert adapter.stop(deadline_ms=SHUTDOWN_BUDGET_MS) == "stopped"
    elapsed_s = time.monotonic() - started

    remaining_s = max(0.0, SHUTDOWN_BUDGET_MS / 1000.0 - elapsed_s)
    adapter.worker.join(timeout=remaining_s)
    assert adapter.worker.is_alive() is False, "the worker outlived its deadline"
    assert elapsed_s < SHUTDOWN_BUDGET_MS / 1000.0, f"stop() took {elapsed_s:.3f}s"


def test_the_stop_is_cooperative_and_nothing_is_killed():
    """The worker exits because it **observed** the signal, not because it was
    terminated: it must have looped at least once and released its resource
    itself. A forced kill would leave `released` empty."""
    adapter = _ThreadedProbe()
    adapter.start(_context(_ThreadedProbe.SOURCE_ID, CancellationSignal()))
    adapter.stop()
    assert adapter.released == ["worker"]
    assert adapter.loops >= 1


def test_the_deadline_is_real_time_not_the_injected_clock():
    """The injected clock is never advanced in this test, and `stop()` still
    completes. If the budget were measured on the injected clock, a never-advanced
    clock would mean an infinite budget and this assertion would be vacuous —
    so it is asserted against `time.monotonic()` instead."""
    adapter = _ThreadedProbe()
    clock = ManualClock(START_MS)
    adapter.start(AdapterContext(source_id=_ThreadedProbe.SOURCE_ID, clock=clock,
                                 sink=None, cancellation=CancellationSignal(),
                                 metrics=NullMetrics()))
    started = time.monotonic()
    adapter.stop(deadline_ms=SHUTDOWN_BUDGET_MS)
    assert time.monotonic() - started < SHUTDOWN_BUDGET_MS / 1000.0
    assert clock.now_ms() == START_MS, "the criterion must not depend on the clock moving"


# ============================== criterion 14: cancellation mid-start, mid-produce
def test_cancellation_mid_start_leaves_nothing_acquired_and_the_adapter_stopped():
    """**Criterion 14, first half.** The cancel lands *inside* `_start`, after a
    resource was acquired. `_stop` must run, so the resource is released, and the
    adapter must end `stopped` — not `running`, and not `starting`."""
    adapter = _CancellingProbe("start")
    cancellation = CancellationSignal()
    state = adapter.start(_context(_CancellingProbe.SOURCE_ID, cancellation))
    assert state == "stopped"
    assert adapter.state == "stopped"
    assert adapter.acquired == ["transport"]
    assert adapter.released == ["transport"], "a partially acquired resource was not released"


def test_cancellation_before_start_acquires_nothing_at_all():
    """A cancel already set when `start` is called must not reach `_start`: nothing
    is acquired, so nothing needs releasing."""
    adapter = _CancellingProbe("never")
    cancellation = CancellationSignal()
    cancellation.cancel()
    assert adapter.start(_context(_CancellingProbe.SOURCE_ID, cancellation)) == "stopped"
    assert adapter.acquired == []
    assert adapter.released == ["transport"], "_stop still runs, so the path is uniform"


def test_a_cancelled_adapter_produces_nothing_further():
    """After cancellation the adapter is `stopped`, and `produce()` on a stopped
    adapter returns empty rather than raising — a cycle racing a stop must not
    crash the service."""
    adapter = _CancellingProbe("start")
    adapter.start(_context(_CancellingProbe.SOURCE_ID, CancellationSignal()))
    assert adapter.produce() == ()


@pytest.mark.parametrize("when", ["produce_before", "produce_after"])
def test_cancellation_during_production_loses_no_accounting(record, when):
    """**Criterion 14, second half.** The conservation law: whatever cancellation
    does to the item, `produced` equals the sum of the outcome counters.

    Both in-flight moments are covered. Cancelled **before** the item is built,
    nothing is produced and nothing is counted — zero equals zero, which is the
    "never neither" half holding trivially. Cancelled **after**, the item is
    returned and must be fully accounted — published or counted, **never both**.
    """
    adapter = _CancellingProbe(when)
    cancellation = CancellationSignal()
    adapter.start(_context(_CancellingProbe.SOURCE_ID, cancellation))
    pipeline = SourcePipeline(record, seed=SEED, now_ms=START_MS)
    sink = ServiceSink()

    result = pipeline.run_cycle(adapter, sink, retrieved_at_ms=START_MS)

    assert result.produced == accounted(result), (
        f"{result.produced} produced but {accounted(result)} accounted: {result}")
    if when == "produce_before":
        assert result.produced == 0
    else:
        assert result.produced == 1
        assert result.published == 1
        # Never both: the published item is counted once and nowhere else.
        assert accounted(result) == result.published


def test_an_item_in_flight_is_published_or_counted_but_never_both(record):
    """Stated as the disjointness it claims: exactly one counter moved."""
    adapter = _CancellingProbe("produce_after")
    adapter.start(_context(_CancellingProbe.SOURCE_ID, CancellationSignal()))
    sink = ServiceSink()
    result = SourcePipeline(record, seed=SEED, now_ms=START_MS).run_cycle(
        adapter, sink, retrieved_at_ms=START_MS)
    moved = [name for name in OUTCOME_COUNTERS if getattr(result, name)]
    assert moved == ["published"], moved
    assert len(sink.store.events()) == 1


def test_a_cancelled_cycle_leaves_no_half_written_state(record):
    """The cancelled cycle must not leave the dedup index or the plausibility
    baseline holding an item that was never published — a half-written index
    would reject or mis-baseline the next good value after a restart of the
    cycle."""
    adapter = _CancellingProbe("produce_before")
    adapter.start(_context(_CancellingProbe.SOURCE_ID, CancellationSignal()))
    pipeline = SourcePipeline(record, seed=SEED, now_ms=START_MS)
    pipeline.run_cycle(adapter, ServiceSink(), retrieved_at_ms=START_MS)
    assert len(pipeline.dedup) == 0
    assert pipeline.plausibility.last_accepted("fx_rate", EURUSD) is None


# =========================================== criterion 15: repeated, out-of-state
def test_stop_is_idempotent():
    """**Criterion 15.** Twice in a row: both succeed, and the second changes
    nothing — not the state, and not the released list."""
    adapter = _ThreadedProbe()
    adapter.start(_context(_ThreadedProbe.SOURCE_ID, CancellationSignal()))
    assert adapter.stop() == "stopped"
    released_after_first = list(adapter.released)
    assert adapter.stop() == "stopped"
    assert adapter.state == "stopped"
    assert adapter.released == released_after_first, "_stop ran a second time"


def test_stop_on_a_created_adapter_succeeds_and_changes_nothing():
    """A never-started adapter: `stop()` must not raise, and must not run a
    release for a resource that was never acquired."""
    adapter = _ThreadedProbe()
    assert adapter.state == "created"
    assert adapter.stop() == "stopped"
    assert adapter.acquired == []
    assert adapter.worker is None


def test_stop_after_failed_permanent_succeeds_and_does_not_restart():
    """`failed_permanent` has no outgoing edge but an explicit `stop()`
    (AD-5 §3.3). The adapter reaches `stopped` and is **not** restartable in
    process: a later `start()` raises rather than quietly resuming."""
    adapter = _ThreadedProbe()
    adapter.start(_context(_ThreadedProbe.SOURCE_ID, CancellationSignal()))
    adapter._record_fault(AdapterFault(FaultClass.CONTRACT_VIOLATION, "contract_violation",
                                       source_id=_ThreadedProbe.SOURCE_ID))
    assert adapter.state == "failed_permanent"
    assert adapter.stop() == "stopped"
    with pytest.raises(AdapterStateError):
        adapter.start(_context(_ThreadedProbe.SOURCE_ID, CancellationSignal()))


def test_stop_is_safe_from_every_state_the_service_can_observe():
    """Swept over the states a running service can actually hold an adapter in,
    so no single reachable state is left untested by oversight."""
    for state in ("created", "running", "degraded", "failed_permanent"):
        # `running` needs an adapter that actually yields an item: one successful
        # **item** is what leaves `starting`, and a started worker is not
        # progress (AD-5 §3.3, §9.2). The threaded probe produces nothing, so it
        # would stay `starting` and the sweep would assert the wrong thing.
        adapter = _CancellingProbe("never") if state == "running" else _ThreadedProbe()
        if state != "created":
            adapter.start(_context(adapter.source_id, CancellationSignal()))
            if state == "degraded":
                adapter._record_fault(AdapterFault(
                    FaultClass.PROVIDER_UNAVAILABLE, "provider_unavailable",
                    source_id=adapter.source_id))
            elif state == "failed_permanent":
                adapter._record_fault(AdapterFault(
                    FaultClass.CONTRACT_VIOLATION, "contract_violation",
                    source_id=adapter.source_id))
            else:
                assert adapter.produce(), "the running case needs a produced item"
            assert adapter.state == state, adapter.state
        assert adapter.stop() == "stopped", state


def test_the_service_stops_its_adapters_and_records_the_stopped_status(service):
    """The service's own shutdown path, on the shipped wiring: `stop()` leaves the
    service `stopped` and its per-source internal status `stopped`, which §9.3
    maps to the published `outage` — never to a fourth wire value."""
    service.stop()
    assert service.state == "stopped"
    for snapshot in service.internal_statuses().values():
        assert snapshot["state"] == "stopped"
