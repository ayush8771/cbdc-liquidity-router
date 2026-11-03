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


def test_passthrough_must_keep_the_engine_code(root):
    edit(root, "app/errors/409_policy_disabled_passthrough.json",
         lambda d: d["response"]["body"]["error"].update(code="DECISION_MISMATCH"))
    assert_reported(problems(root), "409_policy_disabled_passthrough", "keep the engine's code")


def test_passthrough_message_is_free_text(root):
    # Backend review: the backend may use its own message; only code and status are stable.
    edit(root, "app/errors/409_policy_disabled_passthrough.json",
         lambda d: d["response"]["body"]["error"].update(message="Rewritten by the backend."))
    assert not [p for p in problems(root) if "409_policy_disabled_passthrough" in p]


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


def test_state_view_with_range_warning_is_reported(root):
    edit(root, "inference/state/200_replay_gbr_phl.json", lambda d: d["response"]["body"]["warnings"].append(
        {"code": "STATE_OUTSIDE_TRAINING_RANGE", "message": "x"}))
    assert_reported(problems(root), "200_replay_gbr_phl", "never emits STATE_OUTSIDE_TRAINING_RANGE")


def test_risk_fallback_warning_with_real_risk_is_reported(root):
    def change(d):
        for a in d["response"]["body"]["allocations"]:
            a["risk"] = 0.087
    edit(root, "inference/route/200_waterfall_replay.json", change)
    assert_reported(problems(root), "200_waterfall_replay", "RISK_FALLBACK_USED")


def test_health_with_database_down_must_be_unavailable(root):
    edit(root, "app/meta/503_health_database_unavailable.json",
         lambda d: d["response"]["body"].update(status="degraded"))
    assert_reported(problems(root), "503_health_database_unavailable", "must be 'unavailable'")


def test_dashboard_not_derived_from_transactions_is_reported(root):
    edit(root, "app/dashboard/200_summary.json",
         lambda d: d["response"]["body"]["totals"].update(transactions=42))
    assert_reported(problems(root), "200_summary", "do not match the stored transactions")


def test_dashboard_completion_rate_counts_only_allowed(root):
    edit(root, "app/dashboard/200_summary.json",
         lambda d: d["response"]["body"]["byPolicy"][0].update(completionRate=0.123))
    assert_reported(problems(root), "200_summary", "completionRate must be")


def test_include_semantic_context_is_rejected(root):
    edit(root, "inference/explain/200_waterfall_replay.json",
         lambda d: d["request"]["body"].update(include_semantic_context=False))
    assert_reported(problems(root), "200_waterfall_replay", "include_semantic_context")


def test_wrong_length_history_must_fail_the_schema(root):
    edit(root, "inference/errors/422_validation_error_history_length.json", lambda d: d.pop("request_valid"))
    assert_reported(problems(root), "422_validation_error_history_length", "request schema")


def test_regulatory_rejection_with_risk_fallback_is_reported(root):
    edit(root, "inference/route/200_regulatory_rejection.json", lambda d: d["response"]["body"]["warnings"].append(
        {"code": "RISK_FALLBACK_USED", "message": "x"}))
    assert_reported(problems(root), "200_regulatory_rejection", "never carries RISK_FALLBACK_USED")


def test_dashboard_mean_fee_cost_pct_formula(root):
    edit(root, "app/dashboard/200_summary.json",
         lambda d: d["response"]["body"]["byPolicy"][0].update(meanFeeCostPct=1.0))
    assert_reported(problems(root), "200_summary", "meanFeeCostPct must be")


def test_dashboard_allowed_routed_and_corridor_routed(root):
    def change(d):
        d["response"]["body"]["byPolicy"][0]["allowedRouted"] += 1
        d["response"]["body"]["byCorridor"][0]["routed"] += 1
    edit(root, "app/dashboard/200_summary.json", change)
    found = problems(root)
    assert_reported(found, "200_summary", "allowedRouted must be")
    assert_reported(found, "200_summary", "routed must be")


def test_dashboard_means_use_allowed_routed_decisions(root):
    edit(root, "app/dashboard/200_summary.json",
         lambda d: d["response"]["body"]["byPolicy"][0].update(meanLatencyTerm=9.9))
    assert_reported(problems(root), "200_summary", "meanLatencyTerm must be the mean")


def test_non_positive_amount_is_invalid_amount_not_schema_error(root):
    # Owner decision: INVALID_AMOUNT is preserved for zero or negative amounts.
    import check_contracts as cc
    checker = cc.Checker(root)
    checker.load()
    fx = checker.fixtures["app/errors/422_invalid_amount.json"]
    schema = checker.specs["app"]["components"]["schemas"]["CreateTransactionRequest"]
    assert checker.schema_errors("app", schema, fx["request"]["body"]) == []
    assert fx["response"]["body"]["error"]["code"] == "INVALID_AMOUNT"


# ---------------------------------------------------------------- decision_id (§2.11, R3)

def _vector(name):
    data = json.loads((REPO / "contracts/test-vectors/decision_id.v1.json").read_text(encoding="utf-8"))
    return next(v for v in data["vectors"] if v["name"] == name)


@pytest.mark.parametrize("change", [
    lambda i: i.update(engine_version="0.1.1"),
    lambda i: i["reward_weights"].update(lambda_latency=2.0),
    lambda i: i["reward_weights"].update(lambda_risk=0.5),
    lambda i: i["reward_weights"].update(lambda_unrouted=3.0),
    lambda i: i["scenario"].update(liquidity_multiplier=0.9),
    lambda i: i["scenario"].update(congestion_multiplier=2.0),
    lambda i: i["scenario"].update(cheapest_venue_liquidity_multiplier=0.2),
    lambda i: i["artefacts"].update(macro_risk_proxy_sha256="0" * 64),
    lambda i: i["artefacts"].update(rpw_corridor_quarterly_sha256="0" * 64),
    lambda i: i["artefacts"].update(knowledge_sha256="0" * 64),
    lambda i: i["request"]["transaction"].update(amount_usd=300000.5),
    lambda i: i["request"].update(policy="waterfall"),
])
def test_every_hashed_input_changes_the_decision_id(change):
    vec = _vector("scenario_cheapest_feasible")
    inputs = json.loads(json.dumps(vec["inputs"]))
    change(inputs)
    assert check_contracts.decision_id(inputs) != vec["decision_id"]


@pytest.mark.parametrize("change", [
    lambda i: i["request"]["transaction"].update(client_reference="other"),
    lambda i: i["scenario"].update(description="Reworded."),
    lambda i: i["reward_weights"].update(status="calibrated"),
    lambda i: i.update(api_version="v2", git_commit="abc1234"),
    lambda i: i.update(checkpoint_sha256="f" * 64),  # a baseline ignores the checkpoint
])
def test_excluded_inputs_do_not_change_the_decision_id(change):
    vec = _vector("scenario_cheapest_feasible")
    inputs = json.loads(json.dumps(vec["inputs"]))
    change(inputs)
    assert check_contracts.decision_id(inputs) == vec["decision_id"]


def test_ppo_decision_id_depends_on_the_checkpoint():
    vec = _vector("explicit_ppo_projected")
    inputs = json.loads(json.dumps(vec["inputs"]))
    inputs["checkpoint_sha256"] = "f" * 64
    assert check_contracts.decision_id(inputs) != vec["decision_id"]


def test_tampered_test_vector_is_reported(root):
    path = root / "contracts/test-vectors/decision_id.v1.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["vectors"][0]["decision_id"] = "sha256:" + "0" * 64
    data["vectors"][2]["canonical"] = data["vectors"][2]["canonical"].replace('"id_scheme":1', '"id_scheme":2')
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    found = problems(root)
    assert_reported(found, "replay_waterfall_default_policy", "decision_id is not sha256")
    assert_reported(found, "scenario_cheapest_feasible", "canonical is not the RFC 8785")
    assert_reported(found, "replay_waterfall_integer_amount", "same decision_id as")


def test_version_reports_risk_and_rpw_fingerprints(root):
    edit(root, "inference/meta/200_version.json",
         lambda d: d["response"]["body"]["data"].pop("rpw_corridor_quarterly_sha256"))
    assert_reported(problems(root), "200_version", "rpw_corridor_quarterly_sha256")


# ---------------------------------------------------------------- risk fallback (Q13)

def test_missing_risk_fallback_warning_is_reported(root):
    # GBR->PHL in 2024-06 falls back (proxy NaN), so the warning is required.
    edit(root, "inference/route/200_waterfall_replay.json", lambda d: d["response"]["body"].update(
        warnings=[w for w in d["response"]["body"]["warnings"] if w["code"] != "RISK_FALLBACK_USED"]))
    assert_reported(problems(root), "200_waterfall_replay", "RISK_FALLBACK_USED required")


def test_zero_risk_alone_does_not_require_the_warning(root):
    # A fallback is known from the data table, never inferred from a risk of 0.0.
    def change(d):
        b = d["response"]["body"]
        b["state"]["date"] = "2023-06-14"  # a month not in RISK_FALLBACK_MONTHS
        b["warnings"] = [w for w in b["warnings"] if w["code"] != "RISK_FALLBACK_USED"]
    edit(root, "inference/state/200_replay_gbr_phl.json", change)
    assert not [p for p in problems(root) if "200_replay_gbr_phl" in p and "RISK_FALLBACK" in p]


def test_state_view_missing_fallback_warning_is_reported(root):
    edit(root, "inference/state/200_replay_gbr_phl.json", lambda d: d["response"]["body"].update(warnings=[]))
    assert_reported(problems(root), "200_replay_gbr_phl", "RISK_FALLBACK_USED required")


def test_fixture_line_endings_do_not_matter(root):
    # Windows checkouts may convert contracts/ files to CRLF; the checker must give the same result.
    for path in list((root / "contracts").rglob("*.json")) + list((root / "contracts").rglob("*.yaml")):
        text = path.read_text(encoding="utf-8").replace("\r\n", "\n")
        path.write_bytes(text.replace("\n", "\r\n").encode("utf-8"))
    assert problems(root) == []
