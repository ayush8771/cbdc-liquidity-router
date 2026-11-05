"""Allocation invariants, training-range warnings and the rejection/metrics rules.

Contract §2.4, §2.8 and §9.1 A-7, A-8, A-9:
  * a broken allocation invariant returns 500 INTERNAL_ERROR with no result (fail closed);
  * `STATE_OUTSIDE_TRAINING_RANGE` is a warning only, raised in all three state modes, never
    from `/v1/state`, and it never blocks a baseline policy;
  * a regulatory rejection has `requested_usd = 0`, `allocations = []`, a full non-null
    `metrics` with zero fee and execution costs, and no `PARTIAL_COMPLETION`;
  * `fee_cost_usd` = sum(executed x fee_pct) on every decision.
"""
import math

import pytest

from cbdc_inference.engine import (ExplicitHistory, ExplicitState, ExplicitVenue, ReplayState, ScenarioState,
                                   Transaction)
from cbdc_inference.engine import errors as E

DATE = "2024-06-14"
GBR_PHL = ("GBR->PHL#0", "GBR->PHL#1", "GBR->PHL#2")
TX = Transaction("GBR", "PHL", 300000.0)
CAP_EXCEEDED = Transaction("GBR", "PHL", 600000.0)  # above the $500K cap -> regulatory rejection


def _codes(result):
    return [w.code for w in result.warnings]


# ------------------------------------------------------------------ allocation invariant (§2.8)
def test_weight_on_a_padding_slot_fails_closed(worker, monkeypatch):
    """§2.8: no infeasible venue or padding slot may carry a non-zero weight. A violation
    returns INTERNAL_ERROR with no result -- a wrong allocation is never returned."""
    real = worker._p.baselines.liquidity_aware_waterfall_action

    def weight_on_padding(bridges, mask, amount, date):
        action = real(bridges, mask, amount, date)
        action[len(bridges)] = 0.25  # a padding slot beyond the corridor's venues
        return action
    monkeypatch.setattr(worker._p.baselines, "liquidity_aware_waterfall_action", weight_on_padding)
    with pytest.raises(E.EngineIntegrityError) as ei:
        worker.route(TX, ReplayState(DATE))
    assert (ei.value.code, ei.value.http_status) == ("INTERNAL_ERROR", 500)


def test_requested_total_mismatch_fails_closed(worker, monkeypatch):
    """The other half of the invariant: `totals.requested_usd` must equal the sum of the
    per-venue requested amounts."""
    real = worker._check_allocation_invariant

    def tampered(action, allocations, requested_total, mask):
        return real(action, allocations, requested_total + 1.0, mask)
    monkeypatch.setattr(worker, "_check_allocation_invariant", tampered)
    with pytest.raises(E.EngineIntegrityError):
        worker.route(TX, ReplayState(DATE))


def test_the_invariant_holds_on_normal_decisions(worker):
    for state in (ReplayState(DATE), ScenarioState(DATE, "combined_stress")):
        for policy in ("waterfall", "cheapest_feasible"):
            r = worker.route(TX, state, policy)
            assert math.isclose(r.requested_usd, sum(a.amount_requested_usd for a in r.allocations), abs_tol=1e-6)
            # One entry per FEASIBLE venue only; padding slots never appear.
            assert len(r.allocations) <= len(r.action)
            assert [a.slot for a in r.allocations] == sorted(a.slot for a in r.allocations)


# ------------------------------------------------------------------ STATE_OUTSIDE_TRAINING_RANGE (A-7)
def _extreme_explicit(worker, with_history=False):
    """An explicit state far outside any training window."""
    liq, cong = 1e12, 50.0
    history = ExplicitHistory(tuple([liq] * 30), tuple([cong] * 30)) if with_history else None
    return ExplicitState(DATE, tuple(ExplicitVenue(u, liq, cong, history) for u in GBR_PHL))


def test_bounds_were_computed_from_the_training_windows(worker):
    """§2.4: per-venue bounds over the union of the actual 30-day windows of all training
    transactions, not the min-max over the whole train-split calendar."""
    assert worker._training_bounds, "training-window bounds should be available in this repository"
    for bounds in worker._training_bounds.values():
        assert set(bounds) == {"liquidity", "congestion"}
        for lo, hi in bounds.values():
            assert lo <= hi


def test_warning_in_explicit_mode_and_it_never_blocks_a_baseline(worker):
    r = worker.route(TX, _extreme_explicit(worker), "waterfall")
    assert "STATE_OUTSIDE_TRAINING_RANGE" in _codes(r)
    # A warning only: the baseline still routed.
    assert r.allowed is True and r.executed_usd > 0


def test_normal_replay_values_are_inside_the_bounds(worker):
    """The warning is not emitted for ordinary replay values, so it is not vacuous."""
    assert "STATE_OUTSIDE_TRAINING_RANGE" not in _codes(worker.route(TX, ReplayState(DATE)))


def test_warning_in_scenario_mode(worker):
    """§2.4: the values checked are the EFFECTIVE ones, after the scenario multiplier, so a
    scenario can push a venue out of range even though the replay values were inside it."""
    stressed = {s: _codes(worker.route(TX, ScenarioState(DATE, s), "waterfall"))
                for s in ("liquidity_minus50", "cheapest_venue_outage", "congestion_x2", "combined_stress")}
    assert any("STATE_OUTSIDE_TRAINING_RANGE" in codes for codes in stressed.values()), stressed


def test_warning_applies_in_all_three_modes(worker, monkeypatch):
    """A-7: one case per state mode. Replay is forced by shrinking the bounds, since the
    replay values are inside them by construction."""
    tight = {bid: {"liquidity": (0.0, 1.0), "congestion": (0.0, 1e-9)}
             for bid in worker._training_bounds}
    monkeypatch.setattr(worker, "_training_bounds", tight)
    for state in (ReplayState(DATE), ScenarioState(DATE, "baseline"), _extreme_explicit(worker)):
        assert "STATE_OUTSIDE_TRAINING_RANGE" in _codes(worker.route(TX, state, "waterfall")), state.mode


def test_state_view_never_emits_the_warning(worker):
    """§2.4 (owner decision): only /v1/route and /v1/compare emit it, because the values
    checked depend on the policy. The bridge monitor therefore cannot show it."""
    for state in (ReplayState(DATE), ScenarioState(DATE, "combined_stress")):
        view = worker.state_view("GBR->PHL", state)
        assert "STATE_OUTSIDE_TRAINING_RANGE" not in [w["code"] for w in view["warnings"]]


def test_compare_emits_the_warning_per_result(worker):
    out = worker.compare(TX, _extreme_explicit(worker), ["waterfall", "cheapest_feasible"])
    assert out["results"]
    for r in out["results"]:
        assert "STATE_OUTSIDE_TRAINING_RANGE" in _codes(r)


def test_unknown_bounds_never_emit_the_warning(worker, monkeypatch):
    """With no training split available the bounds are unknown, and a warning is never
    invented. It is a warning only, so an empty mapping never blocks routing."""
    monkeypatch.setattr(worker, "_training_bounds", {})
    r = worker.route(TX, _extreme_explicit(worker), "waterfall")
    assert "STATE_OUTSIDE_TRAINING_RANGE" not in _codes(r)
    assert r.executed_usd > 0


# ------------------------------------------------------------------ rejection and metrics (A-8, A-9)
def test_regulatory_rejection_fields(worker):
    r = worker.route(CAP_EXCEEDED, ReplayState(DATE))
    assert r.allowed is False and r.reason and r.decisive_fact_ids == ("global_max_single_transfer_usd",)
    assert r.allocations == () and r.requested_usd == 0.0
    assert r.executed_usd == 0.0 and r.completion_ratio == 0.0 and r.completed is False
    assert r.bridges_used == 0
    # The two unrouted figures differ deliberately, and both are non-null (§2.8).
    assert r.unrouted_env_usd == 0.0 and r.unrouted_term_env == 0.0 and r.reward_env == 0.0
    assert r.unrouted_amount_based_usd == CAP_EXCEEDED.amount_usd
    assert r.unrouted_term_amount_based == 1.0
    assert r.reward_amount_based == -r.reward_weights["lambda_unrouted"]


def test_rejection_metrics_are_present_and_zero(worker):
    """§2.8: `metrics` is always present with every field non-null, including on a rejection,
    where the fee cost and every execution-related cost are 0."""
    r = worker.route(CAP_EXCEEDED, ReplayState(DATE))
    assert r.fee_cost_usd == 0.0
    assert (r.cost_term, r.latency_term, r.risk_term) == (0.0, 0.0, 0.0)
    for field in ("fee_cost_usd", "baseline_cost_pct", "cost_term", "latency_term", "risk_term",
                  "unrouted_term_env", "unrouted_term_amount_based", "reward_env", "reward_amount_based"):
        assert getattr(r, field) is not None, field
    assert r.reward_weights["status"] == "placeholder"


def test_rejection_carries_neither_partial_completion_nor_risk_fallback(worker):
    """§2.8 C14 and A-8: a rejection never carries PARTIAL_COMPLETION, and never
    RISK_FALLBACK_USED, because the rejection prevents the risk lookup."""
    codes = _codes(worker.route(CAP_EXCEEDED, ReplayState(DATE)))
    assert "PARTIAL_COMPLETION" not in codes
    assert "RISK_FALLBACK_USED" not in codes


def test_partial_completion_only_when_allowed(worker):
    """PARTIAL_COMPLETION requires `completed` false AND `feasibility.allowed` true."""
    starved = ExplicitState(DATE, tuple(ExplicitVenue(u, 1000.0, 0.3) for u in GBR_PHL))
    partial = worker.route(TX, starved)
    assert partial.allowed is True and partial.completed is False
    assert "PARTIAL_COMPLETION" in _codes(partial)


def test_risk_fallback_warning_appears_exactly_when_the_lookup_falls_back(worker):
    """A-8: on allowed decisions the warning appears exactly when the proxy lookup falls back.
    A risk of 0.0 alone does not imply it."""
    for corridor, date in ((("GBR", "PHL"), DATE), (("USA", "IND"), "2023-03-01"),
                           (("ARE", "MEX"), "2016-07-07"), (("USA", "IND"), "2015-05-05")):
        tx = Transaction(corridor[0], corridor[1], 100000.0)
        r = worker.route(tx, ReplayState(date))
        fell_back = worker._risk_fell_back(corridor[0], corridor[1], date)
        assert ("RISK_FALLBACK_USED" in _codes(r)) is fell_back, (corridor, date)
        if fell_back:
            assert all(a.risk == 0.0 for a in r.allocations)


def test_fee_cost_uses_executed_amounts_only(worker):
    """§2.8 / A-9: `fee_cost_usd` = sum(executed x fee_pct), never requested or clipped
    amounts, with `fee_pct` as the bridge network defines it (a fraction)."""
    starved = ExplicitState(DATE, tuple(ExplicitVenue(u, 50000.0, 0.3) for u in GBR_PHL))
    for state in (ReplayState(DATE), ScenarioState(DATE, "cheapest_venue_outage"), starved):
        for policy in ("waterfall", "cheapest_feasible"):
            r = worker.route(TX, state, policy)
            expected = sum(a.amount_executed_usd * a.fee_pct for a in r.allocations)
            assert math.isclose(r.fee_cost_usd, expected, rel_tol=1e-12, abs_tol=1e-9)
            # Clipping actually happens in at least the starved case, so this is not vacuous.
            assert r.fee_cost_usd <= sum(a.amount_requested_usd * a.fee_pct for a in r.allocations) + 1e-9


def test_clipped_allocations_are_not_redistributed(worker):
    """§2.8: `amount_clipped_usd` = requested - executed, and clipped amounts are never
    redistributed to another venue."""
    starved = ExplicitState(DATE, tuple(ExplicitVenue(u, 10000.0, 0.3) for u in GBR_PHL))
    r = worker.route(TX, starved, "cheapest_feasible")
    assert any(a.amount_clipped_usd > 0 for a in r.allocations)
    for a in r.allocations:
        assert math.isclose(a.amount_clipped_usd, a.amount_requested_usd - a.amount_executed_usd, abs_tol=1e-9)
        assert a.amount_executed_usd <= a.liquidity_usd + 1e-9


def test_bridges_used_counts_shares_above_the_threshold(worker):
    """§2.8: `bridges_used` counts allocations with `share_requested` > 1e-6."""
    r = worker.route(TX, ReplayState(DATE))
    assert r.bridges_used == sum(1 for a in r.allocations if a.share_requested > 1e-6)


def test_completed_uses_the_amount_based_rule(worker):
    """§2.8: `completed` is the Stage 1F amount-based rule, max(amount - executed, 0) <=
    1e-4 x amount, not the environment's figure."""
    for state in (ReplayState(DATE), ScenarioState(DATE, "cheapest_venue_outage")):
        r = worker.route(TX, state)
        assert r.completed == (max(r.amount_usd - r.executed_usd, 0.0) <= 1e-4 * r.amount_usd)
        assert math.isclose(r.completion_ratio, r.executed_usd / r.amount_usd, rel_tol=1e-12)
        assert math.isclose(r.unrouted_amount_based_usd, max(r.amount_usd - r.executed_usd, 0.0), abs_tol=1e-9)
        assert math.isclose(r.unrouted_env_usd, r.requested_usd - r.executed_usd, abs_tol=1e-6)
