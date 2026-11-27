"""A-4: the circuit breaker opening, cooling down and probing (AD-5 §7.4).

The breaker's whole value is that **a cooldown costs no requests**, so the
assertions are not only about its state: they check that the adapter made no
transport call while it was open. `transport.fetches` is the evidence, counted on
the transport itself rather than reported by the thing under test.
"""
from __future__ import annotations

import pytest

from cbdc_ingestion.adapters.retry import BreakerRegistry, CircuitBreaker
from cbdc_ingestion.adapters.simulated_fx import DEFERRED_BREAKER_OPEN
from cbdc_ingestion.adapters.simulation import SIMULATION_TIMING as P

from .a4_support import case, scripted_adapter
from .conftest import START_MS


# --------------------------------------------------------------- the unit itself
def breaker() -> CircuitBreaker:
    return CircuitBreaker("synthetic.fx", P)


def test_a_new_breaker_is_closed_and_allows():
    b = breaker()
    assert b.state == "closed" and b.allow(START_MS)


def test_it_opens_at_the_threshold_and_not_before():
    b = breaker()
    for n in range(1, P.breaker_failure_threshold):
        b.record_failure(START_MS + n)
        assert b.state == "closed", f"opened early, after {n} failures"
    b.record_failure(START_MS + P.breaker_failure_threshold)
    assert b.state == "open" and b.opened_count == 1


def test_failures_spread_wider_than_the_window_never_open_it():
    """A flapping source is not a failing one: the window is what tells them
    apart, so it is asserted rather than assumed."""
    b = breaker()
    now = START_MS
    for _ in range(P.breaker_failure_threshold * 3):
        now += P.breaker_window_ms + 1
        b.record_failure(now)
        assert b.state == "closed"


def test_an_open_breaker_refuses_until_the_cooldown_elapses():
    b = breaker()
    for n in range(P.breaker_failure_threshold):
        b.record_failure(START_MS + n)
    opened_at = START_MS + P.breaker_failure_threshold - 1
    assert b.allow(opened_at + P.breaker_cooldown_ms - 1) is False
    assert b.refusals >= 1
    assert b.allow(opened_at + P.breaker_cooldown_ms) is True, "cooldown elapsed: one probe"
    assert b.state == "half_open"


def test_half_open_admits_exactly_one_probe():
    b = breaker()
    for n in range(P.breaker_failure_threshold):
        b.record_failure(START_MS + n)
    after = START_MS + P.breaker_cooldown_ms + 10
    assert b.allow(after) is True
    assert b.allow(after) is False, "a second probe must not be admitted"
    assert b.allow(after + 1000) is False, "nor later, until the probe reports"
    assert b.probes_admitted == 1


def test_a_successful_probe_closes_the_breaker_and_clears_its_history():
    b = breaker()
    for n in range(P.breaker_failure_threshold):
        b.record_failure(START_MS + n)
    after = START_MS + P.breaker_cooldown_ms + 10
    b.allow(after)
    b.record_success(after)
    assert b.state == "closed"
    assert b.snapshot()["failures_in_window"] == 0
    # And the next failure starts a fresh count rather than re-opening at once.
    b.record_failure(after + 1)
    assert b.state == "closed"


def test_a_failed_probe_reopens_for_a_fresh_cooldown():
    b = breaker()
    for n in range(P.breaker_failure_threshold):
        b.record_failure(START_MS + n)
    after = START_MS + P.breaker_cooldown_ms + 10
    b.allow(after)
    assert b.state == "half_open"
    b.record_failure(after)
    assert b.state == "open" and b.opened_count == 2
    assert b.allow(after + P.breaker_cooldown_ms - 1) is False, "a fresh cooldown"
    assert b.allow(after + P.breaker_cooldown_ms) is True


def _opened(b) -> None:
    for n in range(P.breaker_failure_threshold):
        b.record_failure(START_MS + n)


def test_an_inconclusive_probe_is_released_for_a_fresh_cooldown():
    """D-1. A probe that ends with no verdict must report through the third
    channel, or it stays in flight and `allow()` refuses every later poll."""
    b = breaker()
    _opened(b)
    after = START_MS + P.breaker_cooldown_ms + 10
    assert b.allow(after) is True and b.state == "half_open"

    assert b.release_probe(after) == "open"

    assert b.probes_released == 1
    assert b.allow(after + P.breaker_cooldown_ms - 1) is False, "a fresh cooldown"
    assert b.allow(after + P.breaker_cooldown_ms) is True, "and then another probe"
    assert b.probes_admitted == 2


def test_releasing_a_probe_is_neither_a_success_nor_a_failure():
    """It must not count towards the threshold, nor clear the window, nor close
    the breaker: an empty response is not progress (AD-5 §7.2)."""
    b = breaker()
    _opened(b)
    opened_before = b.opened_count
    failures_before = b.snapshot()["failures_in_window"]
    after = START_MS + P.breaker_cooldown_ms + 10
    b.allow(after)

    b.release_probe(after)

    assert b.opened_count == opened_before, "not an extra opening"
    assert b.snapshot()["failures_in_window"] == failures_before, "window untouched"
    assert b.state == "open", "and certainly not closed"


def test_a_released_probe_does_not_bypass_the_one_probe_rule():
    """§7.4's "exactly one probe": the release must not re-admit on the very
    next poll, which would turn an inconclusive probe into a tight loop."""
    b = breaker()
    _opened(b)
    after = START_MS + P.breaker_cooldown_ms + 10
    b.allow(after)
    b.release_probe(after)
    assert b.allow(after) is False
    assert b.allow(after + 1) is False


def test_releasing_without_a_probe_in_flight_is_a_no_op():
    """So a caller on the normal closed path may call it unconditionally."""
    b = breaker()
    assert b.state == "closed"
    assert b.release_probe(START_MS) == "closed"
    assert b.probes_released == 0
    _opened(b)
    assert b.release_probe(START_MS) == "open", "open, with no probe admitted"
    assert b.probes_released == 0


def test_a_released_probe_still_reaches_a_verdict_on_a_later_probe():
    """The point of the release: recovery is still possible afterwards."""
    b = breaker()
    _opened(b)
    first = START_MS + P.breaker_cooldown_ms + 10
    b.allow(first)
    b.release_probe(first)
    second = first + P.breaker_cooldown_ms
    assert b.allow(second) is True

    assert b.record_success(second) == "closed"
    assert b.allow(second + 1) is True


def test_the_breaker_is_per_source_so_one_outage_cannot_silence_another():
    """AD-5 §7.4: "the breaker is per `source_id`, never global"."""
    registry = BreakerRegistry(P)
    failing = registry.for_source("synthetic.fx")
    healthy = registry.for_source("synthetic.other")
    assert failing is not healthy
    assert registry.for_source("synthetic.fx") is failing, "one breaker per source"
    for n in range(P.breaker_failure_threshold):
        failing.record_failure(START_MS + n)
    assert failing.state == "open"
    assert healthy.state == "closed" and healthy.allow(START_MS + 100) is True


# --------------------------------------------------- the breaker inside an adapter
def test_an_open_breaker_makes_the_adapter_stop_requesting_entirely():
    """The property that matters: while open, **no transport call is made**.

    Asserted on the transport's own counter. A breaker that merely recorded a
    state while the adapter kept polling would pass every state assertion above
    and still be useless.
    """
    unavailable = case("A4-04").step
    adapter, context, transport = scripted_adapter(
        [unavailable], repeating=True, jitter=lambda cap: 0)

    for _ in range(P.breaker_failure_threshold):
        context.clock.advance_ms(P.min_request_interval_ms)
        adapter.produce()
    assert adapter.breaker.state == "open"
    calls_when_opened = transport.fetches
    assert calls_when_opened == P.breaker_failure_threshold

    # Polled hard throughout the cooldown: not one request may be made.
    for _ in range(20):
        context.clock.advance_ms(P.breaker_cooldown_ms // 40 or 1)
        adapter.produce()
    assert transport.fetches == calls_when_opened, "the cooldown must cost no requests"
    assert adapter.deferrals[DEFERRED_BREAKER_OPEN] >= 1

    # Once the cooldown has elapsed, exactly one probe goes out.
    context.clock.advance_ms(P.breaker_cooldown_ms)
    adapter.produce()
    assert transport.fetches == calls_when_opened + 1


def test_the_deferred_poll_is_counted_rather_than_silent():
    """AD-5 §7.5: "every fault increments a counter and is visible". A refusal
    that left no trace would be exactly the silent degradation that forbids."""
    adapter, context, _ = scripted_adapter([case("A4-03").step], repeating=True,
                                           jitter=lambda cap: 0)
    for _ in range(P.breaker_failure_threshold):
        context.clock.advance_ms(P.min_request_interval_ms)
        adapter.produce()
    context.clock.advance_ms(1)
    adapter.produce()
    counters = context.metrics.snapshot()["counters"]
    assert any("adapter_polls_deferred" in key and DEFERRED_BREAKER_OPEN in key
               for key in counters), counters


def test_a_probe_that_succeeds_returns_the_adapter_to_service():
    """Recovery, end to end through the breaker: faults, cooldown, probe, values."""
    adapter, context, transport = scripted_adapter(
        [case("A4-04").step] * P.breaker_failure_threshold + [case("A4-17").step],
        repeating=True, jitter=lambda cap: 0)

    for _ in range(P.breaker_failure_threshold):
        context.clock.advance_ms(P.min_request_interval_ms)
        adapter.produce()
    assert adapter.breaker.state == "open" and adapter.state == "degraded"

    context.clock.advance_ms(P.breaker_cooldown_ms)
    items = adapter.produce()
    assert items, "the probe must deliver"
    assert adapter.breaker.state == "closed"
    assert adapter.state == "running", "one successful item leaves degraded (AD-5 §3.3)"


@pytest.mark.parametrize("state", ["closed", "open", "half_open"])
def test_the_snapshot_carries_counters_and_states_only(state):
    """AD-1 §3.4: counters by reason and nothing else — no payload, no rate."""
    b = breaker()
    snapshot = b.snapshot()
    assert set(snapshot) == {"source_id", "state", "failures_in_window",
                             "opened_count", "probes_admitted", "refusals"}
    assert state in ("closed", "open", "half_open")  # the parametrization is the catalogue
    assert all(not isinstance(v, (bytes, dict, list)) for v in snapshot.values())
