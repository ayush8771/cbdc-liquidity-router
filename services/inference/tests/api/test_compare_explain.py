"""POST /v1/compare and POST /v1/explain (contract §2.9, §2.10, §9.1 A-9).

Backed by the real in-process engine, so every response is real engine output mapped by the
API layer.
"""
import re

import pytest
from fastapi.testclient import TestClient

from cbdc_inference.api.app import create_app
from cbdc_inference.engine.tasks import compare_task, explain_task, metadata_task, route_task

DATE = "2024-06-14"
SKIP_KEYS = {"policy", "code", "message"}
EXPLAIN_KEYS = ["decision_id", "policy", "summary", "feasibility", "venue_explanations", "policy_notes",
                "semantic_context", "limitations"]
WATERFALL_CODES = {"CHEAPEST_FILLED_TO_LIQUIDITY", "NEXT_CHEAPEST_REMAINDER", "FILLED_TO_LIQUIDITY",
                   "AMOUNT_EXHAUSTED", "NO_LIQUIDITY"}
CHEAPEST_CODES = {"CHEAPEST_SELECTED", "NOT_CHEAPEST", "CLIPPED_AT_LIQUIDITY"}
PPO_CODES = {"PPO_SHARE", "PROJECTION_REDUCED_TO_CAPACITY", "PROJECTION_INCREASED"}
ALL_CODES = WATERFALL_CODES | CHEAPEST_CODES | PPO_CODES | {"INFEASIBLE_REGULATORY"}


@pytest.fixture
def client(worker, repo_settings, fake_pool_factory):
    """Runs route, compare and explain tasks on the session EngineWorker."""
    results = {"route_task": lambda *a: route_task(worker, *a),
               "compare_task": lambda *a: compare_task(worker, *a),
               "explain_task": lambda *a: explain_task(worker, *a)}
    pool, factory = fake_pool_factory(results=results, metadata=metadata_task(worker))
    with TestClient(create_app(repo_settings, pool_factory=factory)) as c:
        yield c


def body(amount=300000.0, state=None, **extra):
    return {"transaction": {"sender_country": "GBR", "receiver_country": "PHL", "amount_usd": amount},
            "state": state or {"mode": "historical_replay", "date": DATE}, **extra}


def _error(r, status, code):
    assert r.status_code == status, r.text
    assert r.json()["error"]["code"] == code, r.json()
    return r.json()["error"]


# ------------------------------------------------------------------ /v1/compare
def test_compare_shape_and_note(client):
    r = client.post("/v1/compare", json=body())
    assert r.status_code == 200, r.text
    b = r.json()
    assert list(b) == ["results", "skipped", "same_state", "note"]
    assert b["same_state"] is True
    # §2.9: the mandatory caveat. A single transaction is not evidence that one policy is better.
    assert "Not evidence that one policy is better" in b["note"]
    assert "STAGE1F_RESULTS" in b["note"]


def test_default_policies_are_every_enabled_policy(client):
    """An omitted `policies` means every ENABLED policy. No checkpoint is approved in this
    repository, so ppo_projected is not enabled and is not silently included (§2.9, §7)."""
    b = client.post("/v1/compare", json=body()).json()
    assert [r["policy"] for r in b["results"]] == ["waterfall", "cheapest_feasible"]
    assert b["skipped"] == []


def test_every_result_shares_one_state_frame(client):
    """Every policy runs in ONE engine task on one request-scoped frame, which is what
    guarantees `same_state` and gives every result the same `state_frame_sha256` (§2.9)."""
    b = client.post("/v1/compare", json=body(
        state={"mode": "scenario", "date": DATE, "scenario_id": "cheapest_venue_outage"})).json()
    frames = {r["provenance"]["state_frame_sha256"] for r in b["results"]}
    assert len(frames) == 1
    assert {r["provenance"]["scenario_id"] for r in b["results"]} == {"cheapest_venue_outage"}


def test_compare_entry_equals_the_route_decision(client):
    """A-9: each result's `decision_id` is computed for its own policy, never over the
    `policies` list, so it equals the `/v1/route` ID for the same transaction and state."""
    payload = body(state={"mode": "scenario", "date": DATE, "scenario_id": "congestion_x2"})
    compared = client.post("/v1/compare", json={**payload, "policies": ["waterfall", "cheapest_feasible"]}).json()
    for entry in compared["results"]:
        routed = client.post("/v1/route", json={**payload, "policy": entry["policy"]}).json()
        assert entry["decision_id"] == routed["decision_id"]
        assert entry == routed


def test_disabled_policy_is_skipped_not_an_error(client):
    """§2.9: a disabled policy goes into `skipped`; it does not fail the request. In a
    comparison `POLICY_DISABLED` is never an error (§4)."""
    b = client.post("/v1/compare", json=body(policies=["waterfall", "ppo_projected"])).json()
    assert [r["policy"] for r in b["results"]] == ["waterfall"]
    assert len(b["skipped"]) == 1
    skip = b["skipped"][0]
    assert set(skip) == SKIP_KEYS
    assert (skip["policy"], skip["code"]) == ("ppo_projected", "POLICY_DISABLED")


def test_ppo_unavailable_for_an_explicit_state_without_history_is_skipped(client, worker, monkeypatch):
    """A policy unavailable FOR THE STATE is also skipped rather than failing the request."""
    monkeypatch.setattr(worker, "ppo_enabled", True)
    view = worker.state_view("GBR->PHL", __import__("cbdc_inference.engine", fromlist=["x"]).ReplayState(DATE))
    state = {"mode": "explicit", "reference_date": DATE,
             "venues": [{"bridge_uid": v["bridge_uid"], "liquidity_usd": v["liquidity_usd"],
                         "congestion": v["congestion"]} for v in view["venues"]]}
    b = client.post("/v1/compare", json=body(state=state, policies=["waterfall", "ppo_projected"])).json()
    assert [r["policy"] for r in b["results"]] == ["waterfall"]
    assert b["skipped"][0]["code"] == "POLICY_UNAVAILABLE_FOR_STATE"


def test_compare_is_deterministic(client):
    payload = body(policies=["cheapest_feasible", "waterfall"])
    assert client.post("/v1/compare", json=payload).json() == client.post("/v1/compare", json=payload).json()


def test_compare_rejects_a_policy_field(client):
    """§1: `/v1/compare` takes `policies`, not `policy`; an unknown field is a 422."""
    err = _error(client.post("/v1/compare", json=body(policy="waterfall")), 422, "VALIDATION_ERROR")
    assert [e.get("field") for e in err["details"]["errors"]] == ["policy"]


@pytest.mark.parametrize("policies,field", [("waterfall", "policies"), ([1], "policies[0]")])
def test_compare_policies_type_errors(client, policies, field):
    err = _error(client.post("/v1/compare", json=body(policies=policies)), 422, "VALIDATION_ERROR")
    assert [e.get("field") for e in err["details"]["errors"]] == [field]


def test_compare_unknown_policy_name(client):
    _error(client.post("/v1/compare", json=body(policies=["ppo_original"])), 422, "VALIDATION_ERROR")


def test_compare_get_is_not_allowed(client):
    r = client.get("/v1/compare")
    _error(r, 405, "METHOD_NOT_ALLOWED")
    assert "POST" in r.headers["Allow"]


# ------------------------------------------------------------------ /v1/explain
def test_explain_shape(client):
    r = client.post("/v1/explain", json=body())
    assert r.status_code == 200, r.text
    b = r.json()
    assert list(b) == EXPLAIN_KEYS
    assert re.fullmatch(r"sha256:[0-9a-f]{64}", b["decision_id"])
    assert b["policy"] == "waterfall"
    # §2.10 / C6: reserved and ALWAYS null in v1.
    assert b["semantic_context"] is None
    assert b["feasibility"]["provider"] == "StaticMemoryProvider"
    assert all(set(v) == {"bridge_uid", "outcome", "reason_code", "text"} for v in b["venue_explanations"])
    assert all(v["outcome"] in ("used", "unused") for v in b["venue_explanations"])  # C11: no other value
    assert all(v["reason_code"] in ALL_CODES for v in b["venue_explanations"])


def test_explain_decision_id_equals_route_and_compare(client):
    """A-9: the same request gives the same `decision_id` on route, compare and explain."""
    payload = body()
    routed = client.post("/v1/route", json=payload).json()["decision_id"]
    explained = client.post("/v1/explain", json=payload).json()["decision_id"]
    compared = client.post("/v1/compare", json={**payload, "policies": ["waterfall"]}).json()
    assert explained == routed == compared["results"][0]["decision_id"]


def test_explain_active_facts_are_the_knowledge_base_cap(client):
    facts = client.post("/v1/explain", json=body()).json()["feasibility"]["active_facts"]
    assert [f["fact_id"] for f in facts] == ["global_max_single_transfer_usd"]
    fact = facts[0]
    assert (fact["rule_type"], fact["value"]) == ("max_single_transfer_usd", 500000.0)
    # The only regulatory fact is an assumed cap, so it must not claim to be verified.
    assert fact["verified"] is False and fact["provenance_tag"] == "project_assumption"


def test_explain_mandatory_limitations(client):
    limits = client.post("/v1/explain", json=body()).json()["limitations"]
    assert any("synthetic" in text for text in limits)
    assert any("placeholder" in text for text in limits)
    assert any("not a real regulation" in text for text in limits)
    assert any("independent" in text for text in limits)


def test_explain_explicit_mode_states_the_extra_limitations(client, worker):
    """§2.10: in explicit mode, `limitations` also says the values were user-supplied and that
    risk and cost come from `reference_date`."""
    from cbdc_inference.engine import ReplayState
    view = worker.state_view("GBR->PHL", ReplayState(DATE))
    state = {"mode": "explicit", "reference_date": DATE,
             "venues": [{"bridge_uid": v["bridge_uid"], "liquidity_usd": v["liquidity_usd"],
                         "congestion": v["congestion"]} for v in view["venues"]]}
    limits = client.post("/v1/explain", json=body(state=state)).json()["limitations"]
    assert any("supplied by the caller" in text for text in limits)
    assert any("reference_date" in text for text in limits)


def test_explain_waterfall_is_in_fill_order(client):
    """§2.10: `venue_explanations` is in fill order for the waterfall, so cheapest fee first."""
    b = client.post("/v1/explain", json=body()).json()
    routed = client.post("/v1/route", json=body()).json()
    fees = {a["bridge_uid"]: a["fee_pct"] for a in routed["allocations"]}
    order = [fees[v["bridge_uid"]] for v in b["venue_explanations"]]
    assert order == sorted(order)
    assert b["venue_explanations"][0]["reason_code"] in WATERFALL_CODES


def test_explain_cheapest_feasible_is_in_slot_order(client):
    b = client.post("/v1/explain", json=body(policy="cheapest_feasible")).json()
    routed = client.post("/v1/route", json=body(policy="cheapest_feasible")).json()
    slots = {a["bridge_uid"]: a["slot"] for a in routed["allocations"]}
    assert [slots[v["bridge_uid"]] for v in b["venue_explanations"]] == sorted(slots.values())
    assert all(v["reason_code"] in CHEAPEST_CODES for v in b["venue_explanations"])


def test_explain_a_regulatory_rejection(client):
    """§2.10: for a rejection every venue is `unused` with `INFEASIBLE_REGULATORY`."""
    b = client.post("/v1/explain", json=body(amount=600000.0)).json()
    assert b["feasibility"]["allowed"] is False and b["feasibility"]["reason"]
    assert [v["outcome"] for v in b["venue_explanations"]] == ["unused"] * 3
    assert {v["reason_code"] for v in b["venue_explanations"]} == {"INFEASIBLE_REGULATORY"}
    assert "Rejected before routing" in b["summary"]


def test_explain_baseline_has_no_policy_notes(client):
    assert client.post("/v1/explain", json=body()).json()["policy_notes"] == []


def test_explain_rejects_the_removed_flag(client):
    """§2.10: `include_semantic_context` was removed from v1, so the strict request rule
    rejects it rather than ignoring it."""
    err = _error(client.post("/v1/explain", json=body(include_semantic_context=True)), 422, "VALIDATION_ERROR")
    assert [e.get("field") for e in err["details"]["errors"]] == ["include_semantic_context"]


def test_explain_propagates_request_errors(client):
    _error(client.post("/v1/explain", json=body(amount=0)), 422, "INVALID_AMOUNT")
    _error(client.post("/v1/explain", json=body(policy="ppo_projected")), 409, "POLICY_DISABLED")
