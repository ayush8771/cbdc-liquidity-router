"""Acceptance criteria 13, 14 and 15: cooperative shutdown (AD-8 §5.2, authorization §5.2).

**Criterion 13 is measured on a real monotonic clock**, and deliberately not on
the injected one: an injected clock proves only that an adapter observed its
deadline, never that a thread exited. `stop()` must return and the worker thread
must actually have terminated within 2 000 ms, asserted with
`time.monotonic()`, a bounded `Thread.join(timeout=...)` and `is_alive() is
False`. A breach fails; it is never retried or marked flaky (authorization §12
item 11). The worker does no unbounded blocking call, so the measurement is
deterministic, not load-dependent.
"""
from __future__ import annotations

import threading
import time

import pytest

from cbdc_ingestion.adapters.base import Adapter
from cbdc_ingestion.adapters.faults import AdapterFault, FaultClass
from cbdc_ingestion.adapters.registry import load_registry
from cbdc_ingestion.pipeline import run_cycle
from cbdc_ingestion.service import IngestionService
from cbdc_ingestion.sink import ServiceSink

from .adapter_cases import ADAPTERS, _ContractProbe, make_context
from .conftest import SEED

BUDGET_S = 2.0  # AD-8 §5.2: 2 000 ms
WAIT_S = 5.0    # bounds *test setup* waits only; never part of the budget


def _wait_for(condition, what: str) -> None:
    deadline = time.monotonic() + WAIT_S
    while not condition():
        assert time.monotonic() < deadline, f"timed out waiting for {what}"
        time.sleep(0.005)


class _Releasing(_ContractProbe):
    """A probe that holds a countable resource between `_start` and `_stop`.

    `_stop` is idempotent, as AD-5 §5.2 requires of release.
    """

    def __init__(self) -> None:
        super().__init__()
        self.held = 0
        self.releases = 0
        self.cancel_inside_start = False

    def _start(self, context) -> None:
        self.held += 1
        if self.cancel_inside_start:
            context.cancellation.cancel()
        super()._start(context)

    def _stop(self, *, deadline_ms: int = 2000) -> None:
        if self.held:
            self.held = 0
            self.releases += 1


# ------------------------------------------------- criterion 13: real deadline
@pytest.mark.parametrize("name,factory", ADAPTERS, ids=[n for n, _ in ADAPTERS])
def test_a_worker_thread_exits_within_the_budget_on_a_real_clock(name, factory):
    adapter = factory()
    context = make_context(adapter)
    adapter.start(context)
    produced = threading.Event()

    def worker() -> None:  # cooperative: no unbounded blocking call
        while not context.cancelled:
            if adapter.produce():
                produced.set()
            context.clock.advance_ms(500)
            context.cancellation.wait(0.005)

    thread = threading.Thread(target=worker, name=f"worker-{name}", daemon=True)
    thread.start()
    assert produced.wait(WAIT_S) and thread.is_alive()

    started = time.monotonic()
    state = adapter.stop(deadline_ms=2000)
    thread.join(timeout=max(0.0, BUDGET_S - (time.monotonic() - started)))
    elapsed = time.monotonic() - started

    assert state == "stopped"
    assert thread.is_alive() is False, "the worker thread must actually have terminated"
    assert elapsed < BUDGET_S, f"stop took {elapsed * 1000:.0f} ms against a 2 000 ms budget"


def test_the_service_thread_and_adapter_stop_within_the_budget_on_a_real_clock():
    """The real service on the real system clock, with the adapter path selected."""
    service = IngestionService(SEED, sources=("synthetic.fx",))
    service.start()
    thread = service._thread
    adapters = [a for a, _record, _seed in service._adapters]
    assert thread is not None and thread.is_alive() and adapters
    _wait_for(lambda: service.store.events(), "a first event")

    started = time.monotonic()
    service.stop()
    thread.join(timeout=max(0.0, BUDGET_S - (time.monotonic() - started)))
    elapsed = time.monotonic() - started

    assert thread.is_alive() is False
    assert elapsed < BUDGET_S, f"stop took {elapsed * 1000:.0f} ms against a 2 000 ms budget"
    assert service.state == "stopped" and all(a.state == "stopped" for a in adapters)


# ------------------------------------------ criterion 14: during start and work
def test_cancellation_before_start_leaves_nothing_acquired_and_stopped():
    adapter = _Releasing()
    context = make_context(adapter)
    context.cancellation.cancel()
    assert adapter.start(context) == "stopped"
    assert adapter.held == 0 and adapter.state == "stopped"


def test_cancellation_inside_start_releases_what_was_acquired():
    adapter = _Releasing()
    adapter.cancel_inside_start = True
    assert adapter.start(make_context(adapter)) == "stopped"
    assert adapter.held == 0 and adapter.releases == 1, "nothing may remain acquired"
    assert adapter.produce() == ()


def _due_fx_adapter():
    adapter = next(factory for name, factory in ADAPTERS if name == "synthetic_fx")()
    context = make_context(adapter)
    adapter.start(context)
    context.clock.advance_ms(5_000)  # every pair is due
    return adapter, context


def test_cancellation_while_items_are_in_flight_loses_no_accounting():
    """Every produced item is published or counted — never both, never neither."""
    adapter, context = _due_fx_adapter()
    record = load_registry().record_for("synthetic.fx")
    sink = ServiceSink()
    publish = sink.publish
    calls = {"n": 0}

    def cancelling_publish(channel, item):
        calls["n"] += 1
        if calls["n"] == 1:
            context.cancellation.cancel()  # cancelled mid-batch, after the first item
        return publish(channel, item)

    sink.publish = cancelling_publish
    result = run_cycle(adapter, record, sink, seed=SEED, retrieved_at_ms=context.now_ms())

    assert result.produced == 4 == calls["n"]
    assert result.published + result.quarantined + result.rejected + result.duplicates == result.produced
    published = len(sink.store.events())
    assert published == result.published
    counted = sink.quarantine.total + sink.faults.total
    assert counted == result.quarantined + result.rejected
    assert published + counted + result.duplicates == result.produced  # no item twice, none lost
    assert adapter.produce() == (), "nothing more is produced once cancelled"
    assert adapter.stop() == "stopped"


def test_a_batch_already_returned_is_whole_and_nothing_more_follows_cancellation():
    adapter, context = _due_fx_adapter()
    batch = adapter.produce()
    assert len({o.subject for o in batch}) == 4
    context.cancellation.cancel()
    assert adapter.produce() == ()


# ------------------------------------------------ criterion 15: stop() is safe
def _fingerprint(adapter: Adapter, context) -> tuple:
    fault = adapter.last_fault
    return (adapter.state, None if fault is None else (fault.fault_class, fault.reason),
            context.metrics.snapshot()["counters"])


@pytest.mark.parametrize("name,factory", ADAPTERS, ids=[n for n, _ in ADAPTERS])
def test_stop_twice_succeeds_and_the_second_changes_nothing(name, factory):
    adapter = factory()
    context = make_context(adapter)
    adapter.start(context)
    assert adapter.stop() == "stopped"
    before = _fingerprint(adapter, context)
    assert adapter.stop() == "stopped"
    assert _fingerprint(adapter, context) == before


@pytest.mark.parametrize("name,factory", ADAPTERS, ids=[n for n, _ in ADAPTERS])
def test_stop_on_a_created_adapter_succeeds(name, factory):
    adapter = factory()
    assert adapter.state == "created"
    assert adapter.stop() == "stopped"
    assert adapter.stop() == "stopped"


@pytest.mark.parametrize("name,factory", ADAPTERS, ids=[n for n, _ in ADAPTERS])
def test_stop_after_failed_permanent_succeeds_and_keeps_the_fault(name, factory):
    adapter = factory()
    context = make_context(adapter)
    adapter.start(context)
    adapter._record_fault(AdapterFault(FaultClass.AUTH_FAILURE, "unreachable_in_this_scope"))
    assert adapter.state == "failed_permanent"
    assert adapter.stop() == "stopped"
    assert adapter.last_fault.fault_class is FaultClass.AUTH_FAILURE
    before = _fingerprint(adapter, context)
    assert adapter.stop() == "stopped"
    assert _fingerprint(adapter, context) == before


def test_release_is_not_repeated_by_a_second_stop():
    adapter = _Releasing()
    adapter.start(make_context(adapter))
    adapter.stop()
    adapter.stop()
    assert adapter.releases == 1
