"""Tests for infra/scripts/check_contracts.py.

Each negative test copies contracts/ into a temporary root, breaks one rule and
checks that the checker reports it. Run: pytest infra/scripts/tests
"""
import json
import shutil
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
REPO = SCRIPTS.parents[1]
sys.path.insert(0, str(SCRIPTS))

import check_contracts  # noqa: E402

FIX = "contracts/fixtures"


@pytest.fixture
def root(tmp_path):
    shutil.copytree(REPO / "contracts", tmp_path / "contracts")
    return tmp_path


def edit(root, rel, change):
    path = root / FIX / rel
    data = json.loads(path.read_text(encoding="utf-8"))
    change(data)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def problems(root):
    return check_contracts.Checker(root).run()


def assert_reported(found, *fragments):
    assert any(all(f in p for f in fragments) for p in found), "\n".join(found) or "no problems reported"


def test_repository_contracts_conform():
    assert check_contracts.Checker(REPO).run() == []


def test_main_exit_status(root, capsys):
    assert check_contracts.main(["--root", str(REPO)]) == 0
    edit(root, "inference/route/200_waterfall_replay.json", lambda d: d["response"]["body"].update(policy="nonsense"))
    assert check_contracts.main(["--root", str(root)]) == 1
    assert "FAIL" in capsys.readouterr().out


@pytest.mark.parametrize("key, app_key", [
    ("unrouted_amount_based_usd", "unroutedAmountBasedUsd"),
    ("daily_state_sha256", "dailyStateSha256"),
    ("lambda_unrouted", "lambdaUnrouted"),
    ("request_id", "requestId"),
])
def test_camel_case_keys(key, app_key):
    assert check_contracts.camel(key) == app_key


def test_to_app_maps_only_policy_and_mode_values():
    engine = {"policy": "ppo_projected", "policies": ["waterfall", "cheapest_feasible"],
              "provenance": {"state_mode": "historical_replay", "values_provenance": "synthetic_simulation",
                             "scenario_id": "cheapest_venue_outage"},
              "diagnostics": {"regime": "splitting_needed"},
              "warnings": [{"code": "PARTIAL_COMPLETION"}], "bridge_uid": "GBR->PHL#1"}
    assert check_contracts.to_app(engine) == {
        "policy": "ppoProjected", "policies": ["waterfall", "cheapestFeasible"],
        "provenance": {"stateMode": "historicalReplay", "valuesProvenance": "synthetic_simulation",
                       "scenarioId": "cheapest_venue_outage"},
        "diagnostics": {"regime": "splitting_needed"},
        "warnings": [{"code": "PARTIAL_COMPLETION"}], "bridgeUid": "GBR->PHL#1"}


def test_executed_above_liquidity_is_reported(root):
    def change(d):
        a = d["response"]["body"]["allocations"][1]
        a["amount_executed_usd"] = a["amount_requested_usd"] = 200000.0
    edit(root, "inference/route/200_cheapest_feasible_partial.json", change)
    assert_reported(problems(root), "200_cheapest_feasible_partial", "min(requested, liquidity)")


def test_reward_inconsistent_with_terms_is_reported(root):
    edit(root, "inference/route/200_waterfall_replay.json",
         lambda d: d["response"]["body"]["metrics"].update(reward_env=0.5))
    assert_reported(problems(root), "metrics.reward_env")


def test_completed_must_use_amount_based_unrouted(root):
    # D7: the explicit fixture has env unrouted 0 but amount-based unrouted 40,000.
    edit(root, "inference/route/200_waterfall_explicit_exceeds_combined.json",
         lambda d: d["response"]["body"]["totals"].update(completed=True))
    assert_reported(problems(root), "totals.completed")


def test_missing_partial_completion_warning_is_reported(root):
    edit(root, "inference/route/200_cheapest_feasible_partial.json",
         lambda d: d["response"]["body"].update(warnings=[]))
    assert_reported(problems(root), "PARTIAL_COMPLETION")


def test_ppo_without_experimental_warning_is_reported(root):
    edit(root, "inference/route/200_ppo_projected_replay.json",
         lambda d: d["response"]["body"].update(warnings=[]))
    assert_reported(problems(root), "EXPERIMENTAL_POLICY")


def test_wrong_policy_default_is_reported(root):
    # The request omits policy, so the engine must answer with waterfall.
    edit(root, "inference/route/200_waterfall_replay.json",
         lambda d: d["response"]["body"].update(policy="cheapest_feasible", policy_status="baseline"))
    assert_reported(problems(root), "requested waterfall")


def test_explain_decision_id_must_match_route(root):
    edit(root, "inference/explain/200_waterfall_replay.json",
         lambda d: d["response"]["body"].update(decision_id="sha256:" + "0" * 64))
    assert_reported(problems(root), "different decision_id")


def test_undocumented_response_field_is_reported(root):
    edit(root, "inference/route/200_waterfall_replay.json",
         lambda d: d["response"]["body"]["totals"].update(extra_field=1))
    assert_reported(problems(root), "response schema", "extra_field")


def test_settable_risk_in_explicit_state_must_be_rejected(root):
    # A fixture that presents a risk field as a valid request contradicts §2.4.
    edit(root, "inference/errors/422_validation_error_unknown_state_field.json", lambda d: d.pop("request_valid"))
    assert_reported(problems(root), "request schema", "risk")


def test_error_code_with_wrong_status_is_reported(root):
    edit(root, "inference/errors/504_engine_timeout.json", lambda d: d["response"].update(status=503))
    assert_reported(problems(root), "ENGINE_TIMEOUT must be HTTP 504")


def test_engine_busy_without_retry_after_is_reported(root):
    edit(root, "inference/errors/503_engine_busy.json", lambda d: d["response"]["headers"].pop("Retry-After"))
    assert_reported(problems(root), "Retry-After")


def test_app_decision_that_recomputes_a_value_is_reported(root):
    edit(root, "app/transactions/201_waterfall_replay.json",
         lambda d: d["response"]["body"]["decision"]["totals"].update(completionRatio=0.99))
    assert_reported(problems(root), "201_waterfall_replay", "camelCase mapping", "completionRatio")


def test_app_enum_not_mapped_is_reported(root):
    edit(root, "app/transactions/201_cheapest_feasible_partial.json",
         lambda d: d["response"]["body"]["decision"].update(policy="cheapest_feasible"))
    assert_reported(problems(root), "201_cheapest_feasible_partial")


def test_app_request_that_does_not_map_is_reported(root):
    edit(root, "app/transactions/201_regulatory_rejection.json", lambda d: d["request"]["body"].update(amountUsd=1.0))
    assert_reported(problems(root), "does not map to the engine request")


def test_secured_app_operation_without_token_is_reported(root):
    edit(root, "app/auth/200_me_viewer.json", lambda d: d["request"]["headers"].pop("Authorization"))
    assert_reported(problems(root), "without an Authorization header")


def test_real_looking_token_is_reported(root):
    edit(root, "app/auth/200_me_viewer.json",
         lambda d: d["request"]["headers"].update(Authorization="Bearer " + "ab" * 32))
    assert_reported(problems(root), "64-hex bearer token")


def test_missing_success_fixture_is_reported(root):
    (root / FIX / "inference/meta/200_scenarios.json").unlink()
    (root / FIX / "app/meta/200_scenarios.json").unlink()
    assert_reported(problems(root), "coverage/inference", "/v1/scenarios")


def test_missing_error_code_fixture_is_reported(root):
    (root / FIX / "app/errors/409_decision_mismatch.json").unlink()
    assert_reported(problems(root), "coverage/app", "DECISION_MISMATCH")


# ---------------------------------------------------------------- v0.4 rules

def test_regulatory_rejection_with_partial_completion_is_reported(root):
    # C14: a rejection never carries PARTIAL_COMPLETION.
    edit(root, "inference/route/200_regulatory_rejection.json",
         lambda d: d["response"]["body"]["warnings"].append({"code": "PARTIAL_COMPLETION", "message": "x"}))
    assert_reported(problems(root), "200_regulatory_rejection", "PARTIAL_COMPLETION")


def test_regulatory_rejection_with_requested_amount_is_reported(root):
    edit(root, "inference/route/200_regulatory_rejection.json",
         lambda d: d["response"]["body"]["totals"].update(requested_usd=600000.0))
    assert_reported(problems(root), "200_regulatory_rejection", "requested_usd=0")


def test_requested_usd_equal_to_amount_instead_of_allocations_is_reported(root):
    # In the explicit exceeds-combined fixture the waterfall requests 360,000 of 400,000.
    def change(d):
        totals = d["response"]["body"]["totals"]
        totals["requested_usd"] = totals["amount_usd"]
    edit(root, "inference/route/200_waterfall_explicit_exceeds_combined.json", change)
    assert_reported(problems(root), "200_waterfall_explicit_exceeds_combined", "totals.requested_usd")


def test_method_not_allowed_without_allow_header_is_reported(root):
    edit(root, "inference/errors/405_method_not_allowed.json", lambda d: d["response"]["headers"].pop("Allow"))
    assert_reported(problems(root), "405_method_not_allowed", "Allow")


def test_allow_header_missing_a_method_is_reported(root):
    edit(root, "app/errors/405_method_not_allowed.json", lambda d: d["response"]["headers"].update(Allow="GET"))
    assert_reported(problems(root), "405_method_not_allowed", "every method")


def test_failed_record_with_decision_or_corridor_is_reported(root):
    edit(root, "app/transactions/200_get_failed.json",
         lambda d: d["response"]["body"]["transaction"].update(corridor="GBR->PHL"))
    assert_reported(problems(root), "200_get_failed", "corridor must be null")


def test_routed_record_with_failure_is_reported(root):
    edit(root, "app/transactions/200_get_routed.json",
         lambda d: d["response"]["body"].update(failure={"code": "ENGINE_BUSY", "message": "x"}))
    assert_reported(problems(root), "200_get_routed", "failure must be set exactly")


def test_failure_that_differs_from_the_post_error_is_reported(root):
    edit(root, "app/transactions/200_get_failed.json",
         lambda d: d["response"]["body"]["failure"].update(message="Something else."))
    assert_reported(problems(root), "200_get_failed", "503_engine_busy")


def test_failed_list_item_with_decision_field_is_reported(root):
    def change(d):
        failed = next(i for i in d["response"]["body"]["items"] if i["status"] == "failed")
        failed["policyStatus"] = "default"
    edit(root, "app/transactions/200_list.json", change)
    assert_reported(problems(root), "200_list", "policyStatus must be null")


def test_passthrough_4xx_must_forward_engine_message(root):
    edit(root, "app/errors/409_policy_disabled_passthrough.json",
         lambda d: d["response"]["body"]["error"].update(message="Rewritten by the backend."))
    assert_reported(problems(root), "409_policy_disabled_passthrough", "forwards the engine message")


def test_unknown_app_request_field_is_rejected(root):
    # §1: requests are strict; a misspelt field must not route with a default.
    def change(d):
        d["request"]["body"]["polcy"] = "waterfall"
    edit(root, "app/transactions/201_waterfall_replay.json", change)
    assert_reported(problems(root), "201_waterfall_replay", "request schema", "polcy")


def test_semantic_context_must_be_null(root):
    edit(root, "inference/explain/200_waterfall_replay.json",
         lambda d: d["response"]["body"].update(semantic_context={"facts": []}))
    assert_reported(problems(root), "200_waterfall_replay", "semantic_context")
