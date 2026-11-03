"""route() behaviour: defaults, validation codes, regulatory rejection, contract field rules."""
import math

import pytest

from cbdc_inference.engine import ReplayState, ScenarioState, Transaction
from cbdc_inference.engine import errors as E

GBR_PHL = Transaction("GBR", "PHL", 300000.0)
DATE = "2024-06-14"


def test_default_policy_is_waterfall(worker):
    r = worker.route(GBR_PHL, ReplayState(DATE), None)
    assert (r.policy, r.policy_status) == ("waterfall", "default")
    assert worker.route(GBR_PHL, ReplayState(DATE)) == r


def test_cheapest_feasible_status(worker):
    r = worker.route(GBR_PHL, ReplayState(DATE), "cheapest_feasible")
    assert (r.policy, r.policy_status) == ("cheapest_feasible", "baseline")
    assert sum(1 for a in r.action if a == 1.0) == 1


@pytest.mark.parametrize("policy,exc", [("ppo_projected", E.PolicyDisabled), ("ppo_original", E.ValidationFailed),
                                        ("WATERFALL", E.ValidationFailed)])
def test_policy_errors(worker, policy, exc):
    with pytest.raises(exc) as ei:
        worker.route(GBR_PHL, ReplayState(DATE), policy)
    assert ei.value.details == {"field": "policy"}


def test_policy_disabled_code_and_status(worker):
    with pytest.raises(E.PolicyDisabled) as ei:
        worker.route(GBR_PHL, ReplayState(DATE), "ppo_projected")
    assert (ei.value.code, ei.value.http_status) == ("POLICY_DISABLED", 409)


@pytest.mark.parametrize("amount,exc", [(0.0, E.InvalidAmount), (-1.0, E.InvalidAmount), (math.nan, E.InvalidAmount),
                                        (math.inf, E.InvalidAmount), (True, E.ValidationFailed),
                                        ("100", E.ValidationFailed)])
def test_amount_validation(worker, amount, exc):
    with pytest.raises(exc):
        worker.route(Transaction("GBR", "PHL", amount), ReplayState(DATE))


@pytest.mark.parametrize("s,r", [("USA", "PHL"), ("PHL", "GBR"), ("gbr", "phl")])
def test_unsupported_corridor(worker, s, r):
    with pytest.raises(E.UnsupportedCorridor):
        worker.route(Transaction(s, r, 1000.0), ReplayState(DATE))


@pytest.mark.parametrize("date,exc", [
    ("2010-12-31", E.DateOutOfRange), ("2025-10-01", E.DateOutOfRange),
    ("2011-01-15", E.DateInGapBuffer), ("2021-12-20", E.DateInGapBuffer), ("2022-01-25", E.DateInGapBuffer),
    ("2025-09-15", E.DateInGapBuffer),
    ("2024/06/14", E.ValidationFailed), ("20240614", E.ValidationFailed), ("2024-02-30", E.ValidationFailed),
])
def test_date_validation(worker, date, exc):
    with pytest.raises(exc):
        worker.route(GBR_PHL, ReplayState(date))


def test_unknown_scenario(worker):
    with pytest.raises(E.UnknownScenario):
        worker.route(GBR_PHL, ScenarioState(DATE, "liquidity_minus99"))


def test_explicit_mode_not_implemented(worker):
    with pytest.raises(E.ValidationFailed):
        worker.route(GBR_PHL, {"mode": "explicit"})


def test_regulatory_rejection_is_a_result_not_an_error(worker):
    r = worker.route(Transaction("GBR", "PHL", 600000.0), ReplayState(DATE))
    assert r.allowed is False
    assert r.reason == "Transaction amount exceeds single transfer policy limit."
    assert r.decisive_fact_ids == ("global_max_single_transfer_usd",)
    assert r.allocations == () and r.executed_usd == 0.0 and r.requested_usd == 0.0
    assert r.unrouted_env_usd == 0.0 and r.unrouted_amount_based_usd == 600000.0
    assert r.completed is False and r.completion_ratio == 0.0
    assert r.reward_env == 0.0 and r.reward_amount_based == -1.0


def test_contract_field_rules_hold(worker):
    for policy in ("waterfall", "cheapest_feasible"):
        for state in (ReplayState(DATE), ScenarioState(DATE, "cheapest_venue_outage")):
            r = worker.route(GBR_PHL, state, policy)
            assert r.allowed and r.reason is None and r.corridor == "GBR->PHL"
            assert [a.slot for a in r.allocations] == sorted(a.slot for a in r.allocations)
            for a in r.allocations:
                assert a.amount_executed_usd == min(a.amount_requested_usd, a.liquidity_usd)
                assert a.amount_clipped_usd == a.amount_requested_usd - a.amount_executed_usd
                assert a.share_before_projection is None
            assert len({a.risk for a in r.allocations}) == 1  # corridor risk shared by all venues
            assert r.unrouted_amount_based_usd == max(r.amount_usd - r.executed_usd, 0.0)
            assert r.completed == (r.unrouted_amount_based_usd <= 1e-4 * r.amount_usd)
            assert ("PARTIAL_COMPLETION" in {w.code for w in r.warnings}) == (not r.completed)
            assert r.reward_weights["status"] == "placeholder"
            assert r.split == "test"


def test_provenance_by_mode(worker):
    replay = worker.route(GBR_PHL, ReplayState(DATE))
    assert (replay.state_mode, replay.values_provenance, replay.scenario_id) == \
        ("historical_replay", "synthetic_simulation", None)
    assert replay.state_frame_sha256 == replay.daily_state_sha256
    outage = worker.route(GBR_PHL, ScenarioState(DATE, "cheapest_venue_outage"))
    assert (outage.state_mode, outage.values_provenance, outage.scenario_id) == \
        ("scenario", "synthetic_scenario", "cheapest_venue_outage")
    assert outage.state_frame_sha256 != outage.daily_state_sha256
    assert outage.state_date == outage.simulation_date == DATE


def test_are_mex_carries_synthetic_cost_anchor(worker):
    r = worker.route(Transaction("ARE", "MEX", 1000.0), ReplayState(DATE))
    assert "SYNTHETIC_COST_ANCHOR" in {w.code for w in r.warnings}


def test_client_reference_echoed(worker):
    r = worker.route(Transaction("GBR", "PHL", 1000.0, "ref-1"), ReplayState(DATE))
    assert r.client_reference == "ref-1"


def test_deterministic(worker):
    a = worker.route(GBR_PHL, ScenarioState(DATE, "combined_stress"), "waterfall")
    b = worker.route(GBR_PHL, ScenarioState(DATE, "combined_stress"), "waterfall")
    assert a == b
