"""Regression tests for the two A-4 defects the Dev B review reproduced.

Each test asserts the **approved** AD-5 behaviour, not the current behaviour.
Against an implementation that still has the defect, these tests fail. That is
deliberate, and they must not be skipped, marked xfail or weakened to pass.

- **D-1, a half-open breaker that never resolves** (AD-5 §7.4: "then admits one
  probe"; §9.2: `outage` is left by one successful item). A probe that ends in
  any of three ways must not leave the breaker refusing every later poll for
  good: an empty response, a response whose every item is invalid, or a probe
  admitted by the breaker and then held back by the backoff gate.
- **D-2, malformed items escalated to a whole-response rejection** (AD-5 §7.1:
  "one bad item does not discard a good response"; a missing required field is
  `item_invalid`, as catalogue case A4-16 states). Two items that each lack their
  subject fields are two item faults, not two items "for the same subject".

Only the stable surface of `docs/PHASE3_A4_INTERFACE.md` is used, and no timing
number is hard-coded: everything is read from the simulation profile.
"""
from __future__ import annotations

import pytest

from cbdc_ingestion.adapters.faults import FaultClass
from cbdc_ingestion.adapters.simulation import SIMULATION_TIMING as P

from .a4_support import case, clean_values, pipeline_for, scripted_adapter

SETTLE_MS = 10_000


def _no_rate(items):
    return [{k: v for k, v in item.items() if k != "rate"} for item in items]


def _probe_exit_scripts():
    """The three half-open probe exits, each followed by a clean delivery that
    the recovered adapter must eventually reach."""
    from fake_provider import Deliver, Silence, StatusFault

    threshold = P.breaker_failure_threshold
    unavailable = [StatusFault(503)] * threshold
    clean = Deliver(values=clean_values())
    # A gate longer than the cooldown, set by the failure that opens the
    # breaker, so the half-open probe is admitted and then deferred.
    assert P.retry_after_max_ms > P.breaker_cooldown_ms, "precondition for the third exit"
    seconds = max(1, -(-(P.breaker_cooldown_ms + 1) // 1000))
    gated = [StatusFault(503)] * (threshold - 1) + [StatusFault(503, retry_after=str(seconds))]
    return {
        "empty_response": unavailable + [Silence(), clean],
        "all_items_invalid": unavailable + [Deliver(values=_no_rate(clean_values())), clean],
        "deferred_by_backoff_gate": gated + [clean],
    }


@pytest.mark.parametrize("exit_kind", sorted(_probe_exit_scripts()))
def test_a_half_open_probe_exit_never_wedges_the_breaker(exit_kind):
    """D-1. After the probe exits, the adapter must request again in a later
    cooldown and recover: the source reaches `ok` and the values are published."""
    script = _probe_exit_scripts()[exit_kind]
    pipeline, sink = pipeline_for()
    adapter, context, transport = scripted_adapter(script, jitter=lambda cap: 0,
                                                   repeating=True)

    for _ in range(P.breaker_failure_threshold):
        pipeline.run_cycle(adapter, sink, retrieved_at_ms=context.clock.now_ms())
        context.clock.advance_ms(P.min_request_interval_ms)
    assert adapter.breaker.state == "open", "precondition: the breaker opened"

    # The probe, exactly when the cooldown ends, so the third exit's gate (longer
    # than the cooldown) is still in the future when the probe is admitted.
    context.clock.advance_ms(P.breaker_cooldown_ms)
    pipeline.run_cycle(adapter, sink, retrieved_at_ms=context.clock.now_ms())
    assert adapter.breaker.snapshot()["probes_admitted"] == 1, "precondition: a probe"
    after_probe_calls = transport.fetches

    # Well beyond every gate the profile can set, several times over.
    horizon = P.breaker_cooldown_ms + P.retry_after_max_ms + P.backoff_ceiling_ms
    # The repeating clean step re-delivers one sequence, so after the first
    # publication later cycles are duplicates and the silence criterion may
    # legitimately return the source to `outage`. Recovery is therefore asserted
    # as "reached `ok`", observed cycle by cycle, not as the final state.
    seen = set()
    for advance in [horizon] * 6 + [SETTLE_MS]:
        context.clock.advance_ms(advance)
        pipeline.run_cycle(adapter, sink, retrieved_at_ms=context.clock.now_ms())
        seen.add(pipeline.status.state)

    assert transport.fetches > after_probe_calls, (
        f"{exit_kind}: no request after the probe; the breaker is stuck in "
        f"{adapter.breaker.state}")
    assert adapter.breaker.state == "closed"
    assert "ok" in seen, f"the source never recovered: {sorted(seen)}"
    assert len(sink.store.events()) == len(clean_values())


@pytest.mark.parametrize("missing", [("base", "quote"), ("base", "quote", "rate_type")])
def test_items_missing_their_subject_fields_are_isolated_item_faults(missing):
    """D-2. Two malformed items are two `item_invalid` faults; the good items in
    the same response are still observed and the adapter is not failed."""
    from fake_provider import Deliver

    values = clean_values()
    broken = [{k: v for k, v in item.items() if k not in missing} for item in values[:2]]
    adapter, _, _ = scripted_adapter([Deliver(values=broken + values[2:])])

    observations = adapter.produce()
    drained = adapter.drain_faults()

    assert adapter.state != "failed_permanent"
    assert [f.fault_class for f in drained] == [FaultClass.ITEM_INVALID] * 2
    assert len(observations) == len(values) - 2


def test_malformed_items_do_not_send_the_source_down_through_the_service():
    """D-2 through the real pipeline: item faults leave the source status alone
    (AD-5 §7.1 "Unchanged") and the good values are published."""
    from fake_provider import Deliver

    values = clean_values()
    broken = [{k: v for k, v in item.items() if k not in ("base", "quote")}
              for item in values[:2]]
    pipeline, sink = pipeline_for()
    adapter, context, _ = scripted_adapter([Deliver(values=broken + values[2:])])
    context.clock.advance_ms(SETTLE_MS)

    result = pipeline.run_cycle(adapter, sink, retrieved_at_ms=context.clock.now_ms())

    assert pipeline.status.state != "down"
    assert (result.faults, result.item_faults) == (0, 2)
    assert result.published == len(values) - 2


def test_a_single_subjectless_item_is_already_an_item_fault():
    """The control for D-2: one such item is handled correctly today, so the
    tests above isolate the two-item escalation, not field validation itself."""
    from fake_provider import Deliver

    values = clean_values()
    broken = {k: v for k, v in values[0].items() if k not in ("base", "quote")}
    adapter, _, _ = scripted_adapter([Deliver(values=[broken] + values[1:])])
    observations = adapter.produce()
    assert [f.fault_class for f in adapter.drain_faults()] == [FaultClass.ITEM_INVALID]
    assert len(observations) == len(values) - 1
    assert case("A4-16").fault_class is FaultClass.ITEM_INVALID
