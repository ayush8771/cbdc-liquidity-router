"""POST /v1/route (contract §2.8) through FastAPI, backed by the real in-process engine.

The stand-in pool runs each route task on the session EngineWorker, so every
response here is real engine output mapped by the API layer.
"""
import math
import re

import pytest
from fastapi.testclient import TestClient

from cbdc_inference import ENGINE_VERSION
from cbdc_inference.api.app import create_app
from cbdc_inference.engine import ReplayState, Transaction, state_from_dict
from cbdc_inference.engine import errors as E

DATE = "2024-06-14"
TOP_KEYS = ["decision_id", "policy", "policy_status", "transaction", "feasibility", "allocations", "totals",
            "metrics", "diagnostics", "provenance", "warnings"]
TX_KEYS = {"sender_country", "receiver_country", "amount_usd", "corridor", "simulation_date", "client_reference"}
ALLOC_KEYS = {"slot", "bridge_uid", "data_source_tag", "fee_pct", "liquidity_usd", "congestion", "risk",
              "share_requested", "amount_requested_usd", "amount_executed_usd", "amount_clipped_usd",
              "share_before_projection"}
TOTALS_KEYS = {"amount_usd", "requested_usd", "executed_usd", "unrouted_env_usd", "unrouted_amount_based_usd",
               "completion_ratio", "completed", "bridges_used"}
METRICS_KEYS = {"fee_cost_usd", "baseline_cost_pct", "cost_term", "latency_term", "risk_term", "unrouted_term_env",
                "unrouted_term_amount_based", "reward_env", "reward_amount_based", "reward_weights"}
PROV_KEYS = {"state_mode", "state_date", "split", "scenario_id", "values_provenance", "engine_version", "git_commit",
             "knowledge_sha256", "daily_state_sha256", "state_frame_sha256", "checkpoint", "device", "platform"}


@pytest.fixture
def client(worker, repo_settings, fake_pool_factory):
    def run(transaction, state, policy):
        return worker.route(transaction, state, policy)
    pool, factory = fake_pool_factory(results={"route_task": run},
                                      metadata={**_metadata(worker)})
    with TestClient(create_app(repo_settings, pool_factory=factory)) as c:
        c.pool = pool
        yield c


def _metadata(worker):
    from cbdc_inference.engine.tasks import metadata_task
    return metadata_task(worker)


def body(amount=300000.0, state=None, policy=None, **tx_extra):
    b = {"transaction": {"sender_country": "GBR", "receiver_country": "PHL", "amount_usd": amount, **tx_extra},
         "state": state or {"mode": "historical_replay", "date": DATE}}
    if policy is not None:
        b["policy"] = policy
    return b


def explicit_state(worker, with_history=False, date=DATE):
    view = worker.state_view("GBR->PHL", ReplayState(date), include_history=with_history)
    venues = []
    for v in view["venues"]:
        venues.append({"bridge_uid": v["bridge_uid"], "liquidity_usd": v["liquidity_usd"],
                       "congestion": v["congestion"], "history": v.get("history") and
                       {"liquidity_usd": v["history"]["liquidity_usd"], "congestion": v["history"]["congestion"]}})
    return {"mode": "explicit", "reference_date": date, "venues": venues}


def _error(r, status, code):
    assert r.status_code == status, r.text
    assert r.json()["error"]["code"] == code, r.json()
    return r.json()["error"]


def _fields(err) -> list:
    """The field paths of a VALIDATION_ERROR's `details.errors[]` (§4). An item about no single
    field omits `field` entirely, so a form-level error shows as None here."""
    return [e.get("field") for e in err["details"]["errors"]]


# ------------------------------------------------------------------ success
def test_schema_and_values_equal_engine_output(client, worker):
    r = client.post("/v1/route", json=body(client_reference="ref-9"), headers={"X-Request-Id": "rt-1"})
    assert r.status_code == 200 and r.headers["X-Request-Id"] == "rt-1"
    b = r.json()
    assert list(b) == TOP_KEYS
    assert set(b["transaction"]) == TX_KEYS and set(b["totals"]) == TOTALS_KEYS
    assert set(b["metrics"]) == METRICS_KEYS and set(b["provenance"]) == PROV_KEYS
    assert all(set(a) == ALLOC_KEYS for a in b["allocations"])

    e = worker.route(Transaction("GBR", "PHL", 300000.0, "ref-9"), ReplayState(DATE), None)
    # §2.11: "sha256:" + 64 lowercase hex characters, equal to the engine's own value.
    assert b["decision_id"] == e.decision_id
    assert re.fullmatch(r"sha256:[0-9a-f]{64}", b["decision_id"])
    assert (b["policy"], b["policy_status"]) == ("waterfall", "default")  # default policy
    assert b["transaction"] == {"sender_country": "GBR", "receiver_country": "PHL", "amount_usd": 300000.0,
                                "corridor": "GBR->PHL", "simulation_date": DATE, "client_reference": "ref-9"}
    assert b["feasibility"] == {"allowed": True, "reason": None, "decisive_fact_ids": [],
                                "knowledge_version": e.knowledge_version}
    assert [a["slot"] for a in b["allocations"]] == [a.slot for a in e.allocations]
    for got, want in zip(b["allocations"], e.allocations):
        assert got["amount_executed_usd"] == want.amount_executed_usd and got["share_requested"] == want.share_requested
        assert got["share_before_projection"] is None
    assert b["totals"]["executed_usd"] == e.executed_usd and b["totals"]["completed"] == e.completed
    assert b["metrics"]["reward_env"] == e.reward_env and b["metrics"]["reward_amount_based"] == e.reward_amount_based
    assert b["metrics"]["reward_weights"]["status"] == "placeholder"
    assert b["diagnostics"] == {"regime": e.regime, "combined_liquidity_usd": e.combined_liquidity_usd,
                                "projection_applied": False}
    p = b["provenance"]
    assert (p["state_mode"], p["state_date"], p["split"], p["scenario_id"], p["values_provenance"]) == \
        ("historical_replay", DATE, "test", None, "synthetic_simulation")
    assert p["engine_version"] == ENGINE_VERSION and p["checkpoint"] is None and p["device"] == "cpu"
    # The Phase 2 SERVICE hash (CRLF->LF normalised), NOT Phase 1's raw-byte KnowledgeBase.sha256 (§2.2).
    assert p["knowledge_sha256"] == worker.artefacts["knowledge_sha256"]
    assert p["daily_state_sha256"] == p["state_frame_sha256"] == worker.daily_state_sha256
    assert [w["code"] for w in b["warnings"]] == [w.code for w in e.warnings]


@pytest.mark.parametrize("policy,status", [("waterfall", "default"), ("cheapest_feasible", "baseline")])
@pytest.mark.parametrize("mode", ["historical_replay", "scenario", "explicit", "explicit_history"])
def test_every_mode_and_policy(client, worker, policy, status, mode):
    state = {"historical_replay": {"mode": "historical_replay", "date": DATE},
             "scenario": {"mode": "scenario", "date": DATE, "scenario_id": "cheapest_venue_outage"}}.get(mode)
    if mode.startswith("explicit"):
        state = explicit_state(worker, with_history=(mode == "explicit_history"))
    r = client.post("/v1/route", json=body(state=state, policy=policy))
    assert r.status_code == 200, r.text
    b = r.json()
    assert (b["policy"], b["policy_status"]) == (policy, status)
    expected = worker.route(Transaction("GBR", "PHL", 300000.0), state_from_dict(state), policy)
    assert b["totals"]["executed_usd"] == expected.executed_usd
    assert b["metrics"]["reward_env"] == expected.reward_env
    assert b["provenance"]["state_mode"] == state["mode"]
    assert b["provenance"]["values_provenance"] == {"historical_replay": "synthetic_simulation",
                                                    "scenario": "synthetic_scenario",
                                                    "explicit": "user_supplied_synthetic"}[state["mode"]]
    assert b["provenance"]["state_frame_sha256"] == expected.state_frame_sha256


def test_explicit_equal_to_replay_gives_identical_body(client, worker):
    replay = client.post("/v1/route", json=body()).json()
    explicit = client.post("/v1/route", json=body(state=explicit_state(worker))).json()
    for part in ("allocations", "totals", "metrics", "diagnostics", "feasibility", "warnings"):
        assert explicit[part] == replay[part], part
    assert explicit["provenance"]["state_frame_sha256"] == replay["provenance"]["daily_state_sha256"]


def test_regulatory_rejection_is_200(client):
    r = client.post("/v1/route", json=body(amount=600000.0))
    assert r.status_code == 200
    b = r.json()
    assert b["feasibility"]["allowed"] is False
    assert b["feasibility"]["reason"] == "Transaction amount exceeds single transfer policy limit."
    assert b["feasibility"]["decisive_fact_ids"] == ["global_max_single_transfer_usd"]
    assert b["allocations"] == [] and b["totals"]["executed_usd"] == 0.0 and b["totals"]["completed"] is False
    assert b["metrics"]["reward_env"] == 0.0 and b["metrics"]["reward_amount_based"] == -1.0


def test_integer_amount_accepted(client):
    r = client.post("/v1/route", json=body(amount=1000))
    assert r.status_code == 200 and r.json()["transaction"]["amount_usd"] == 1000.0


@pytest.mark.parametrize("mutate,field", [
    (lambda b: b.__setitem__("extra", 1), "extra"),
    (lambda b: b["transaction"].__setitem__("note", "x"), "transaction.note"),
    (lambda b: b.__setitem__("include_semantic_context", True), "include_semantic_context"),
])
def test_requests_are_strict(client, mutate, field):
    """§1: every request body object accepts only the fields the contract defines, so a
    misspelt field never silently falls back to its default. `include_semantic_context` was
    removed from v1 (§2.10), so it is rejected like any other unknown field."""
    b = body()
    mutate(b)
    err = _error(client.post("/v1/route", json=b), 422, "VALIDATION_ERROR")
    assert _fields(err) == [field]


def test_policy_null_is_rejected_but_omitted_policy_defaults(client):
    """§1: `policy: null` is a 422; only an OMITTED policy takes the `waterfall` default."""
    err = _error(client.post("/v1/route", json=body() | {"policy": None}), 422, "VALIDATION_ERROR")
    assert _fields(err) == ["policy"]
    assert client.post("/v1/route", json=body()).json()["policy"] == "waterfall"


@pytest.mark.parametrize("length,ok", [(200, True), (201, False)])
def test_client_reference_length_limit(client, length, ok):
    """§2.8: at most 200 characters, counted as Unicode code points."""
    r = client.post("/v1/route", json=body(client_reference="e" * length))
    if ok:
        assert r.status_code == 200
    else:
        assert _fields(_error(r, 422, "VALIDATION_ERROR")) == ["transaction.client_reference"]


@pytest.mark.parametrize("payload,fields", [
    (body(amount=9007199254740993), ["transaction.amount_usd"]),
    (body(amount=1e21), ["transaction.amount_usd"]),
])
def test_unsafe_integers_are_rejected_not_rounded(client, payload, fields):
    """§2.11: an integer-valued number outside +/-(2^53 - 1) in `transaction` or `state` is a
    VALIDATION_ERROR with the value's path, never rounded."""
    err = _error(client.post("/v1/route", json=payload), 422, "VALIDATION_ERROR")
    assert _fields(err) == fields


def test_every_unsafe_number_is_reported_together(client, worker):
    state = explicit_state(worker)
    state["venues"][1]["liquidity_usd"] = 2 ** 53
    err = _error(client.post("/v1/route", json=body(amount=1e21, state=state)), 422, "VALIDATION_ERROR")
    assert sorted(_fields(err)) == ["state.venues[1].liquidity_usd", "transaction.amount_usd"]


def test_deterministic(client):
    b = body(state={"mode": "scenario", "date": DATE, "scenario_id": "combined_stress"}, policy="cheapest_feasible")
    assert client.post("/v1/route", json=b).json() == client.post("/v1/route", json=b).json()


# ------------------------------------------------------------------ request errors
def test_malformed_json(client):
    r = client.post("/v1/route", content=b"{not json", headers={"Content-Type": "application/json"})
    _error(r, 400, "MALFORMED_REQUEST")


@pytest.mark.parametrize("payload,field", [
    ([], None),  # about no single field, so `field` is omitted (§4)
    ({"state": {"mode": "historical_replay", "date": DATE}}, "transaction"),
    ({"transaction": {"sender_country": "GBR", "receiver_country": "PHL", "amount_usd": 1.0}}, "state"),
    ({"transaction": "GBR->PHL", "state": {"mode": "historical_replay", "date": DATE}}, "transaction"),
    (body(amount=None) | {"transaction": {"sender_country": "GBR", "receiver_country": "PHL"}},
     "transaction.amount_usd"),
    (body() | {"transaction": {"sender_country": 1, "receiver_country": "PHL", "amount_usd": 1.0}},
     "transaction.sender_country"),
    (body(client_reference=5), "transaction.client_reference"),
    (body(policy=3), "policy"),
    (body(state={"mode": "historical_replay", "date": DATE, "scenario_id": "baseline"}), "state.scenario_id"),
    (body(state={"mode": "scenario", "date": DATE}), "state.scenario_id"),
    (body(state={"mode": "live", "date": DATE}), "state.mode"),
])
def test_validation_errors(client, payload, field):
    err = _error(client.post("/v1/route", json=payload), 422, "VALIDATION_ERROR")
    assert _fields(err) == [field]


@pytest.mark.parametrize("key", ["risk", "fee", "baseline_cost_pct", "data_source_tag"])
def test_explicit_cannot_set_phase1_values(client, worker, key):
    state = explicit_state(worker)
    state["venues"][0][key] = 0.5
    err = _error(client.post("/v1/route", json=body(state=state)), 422, "VALIDATION_ERROR")
    assert _fields(err) == [f"state.venues[0].{key}"] and "cannot be set" in err["message"]


@pytest.mark.parametrize("payload,status,code", [
    (body(amount=0), 422, "INVALID_AMOUNT"),
    (body(amount=-5.0), 422, "INVALID_AMOUNT"),
    (body(amount="100"), 422, "VALIDATION_ERROR"),
    (body() | {"transaction": {"sender_country": "USA", "receiver_country": "PHL", "amount_usd": 1.0}},
     422, "UNSUPPORTED_CORRIDOR"),
    (body(state={"mode": "historical_replay", "date": "2025-10-01"}), 422, "DATE_OUT_OF_RANGE"),
    (body(state={"mode": "historical_replay", "date": "2022-01-10"}), 422, "DATE_IN_GAP_BUFFER"),
    (body(state={"mode": "historical_replay", "date": "14/06/2024"}), 422, "VALIDATION_ERROR"),
    (body(state={"mode": "scenario", "date": DATE, "scenario_id": "meteor"}), 422, "UNKNOWN_SCENARIO"),
    (body(policy="ppo_original"), 422, "VALIDATION_ERROR"),
    (body(policy="ppo_projected"), 409, "POLICY_DISABLED"),
])
def test_engine_errors(client, payload, status, code):
    _error(client.post("/v1/route", json=payload), status, code)


def test_explicit_state_errors(client, worker):
    s = explicit_state(worker)
    s["venues"] = s["venues"][:2]
    _error(client.post("/v1/route", json=body(state=s)), 422, "STATE_VENUE_MISMATCH")
    s = explicit_state(worker)
    s["venues"][1]["liquidity_usd"] = -1.0
    _error(client.post("/v1/route", json=body(state=s)), 422, "INVALID_STATE_VALUE")
    s = explicit_state(worker, with_history=True)
    s["venues"][0]["history"]["liquidity_usd"] = s["venues"][0]["history"]["liquidity_usd"][:29]
    # A wrong LENGTH is a schema rule, so VALIDATION_ERROR, not INVALID_STATE_VALUE (§2.4).
    _error(client.post("/v1/route", json=body(state=s)), 422, "VALIDATION_ERROR")
    s = explicit_state(worker)
    s["reference_date"] = "2022-01-10"
    _error(client.post("/v1/route", json=body(state=s)), 422, "DATE_IN_GAP_BUFFER")


def test_non_finite_amount_rejected(client):
    # JSON has no NaN; a huge exponent overflows to inf in Python's parser
    r = client.post("/v1/route", content=b'{"transaction":{"sender_country":"GBR","receiver_country":"PHL",'
                                         b'"amount_usd":1e999},"state":{"mode":"historical_replay","date":"2024-06-14"}}',
                    headers={"Content-Type": "application/json"})
    assert math.isinf(1e999)
    _error(r, 422, "INVALID_AMOUNT")


# ------------------------------------------------------------------ pool errors
@pytest.mark.parametrize("exc,status,code,retry", [
    (E.EngineBusy("full", {"max_queue": 32}), 503, "ENGINE_BUSY", "1"),
    (E.EngineTimeout("slow", {"timeout_s": 10.0}), 504, "ENGINE_TIMEOUT", None),
    (E.EngineIntegrityError("bad", {"problems": ["x"]}), 500, "INTERNAL_ERROR", None),
    (E.EngineWorkerCrashed("crashed", {"exitcode": 3}), 500, "INTERNAL_ERROR", None),
])
def test_pool_errors(worker, repo_settings, fake_pool_factory, exc, status, code, retry):
    _, factory = fake_pool_factory(results={"route_task": exc}, metadata=_metadata(worker))
    with TestClient(create_app(repo_settings, pool_factory=factory)) as c:
        r = c.post("/v1/route", json=body(), headers={"X-Request-Id": "pe-1"})
    err = _error(r, status, code)
    assert r.headers.get("Retry-After") == retry and err["request_id"] == "pe-1"
    if code == "INTERNAL_ERROR":
        assert err["message"] == "Unexpected internal error." and err["details"] == {}


def test_not_ready_before_metadata(repo_settings, fake_pool_factory):
    _, factory = fake_pool_factory(submit_error=E.EngineNotReady("no engine worker is available"))
    with TestClient(create_app(repo_settings, pool_factory=factory)) as c:
        r = c.post("/v1/route", json=body())
    _error(r, 503, "NOT_READY")
    assert r.headers["Retry-After"] == "5"


def test_get_is_not_allowed(client):
    """§4 / A-5b: 405 METHOD_NOT_ALLOWED with an `Allow` header listing the path's methods."""
    r = client.get("/v1/route")
    err = _error(r, 405, "METHOD_NOT_ALLOWED")
    allow = {m.strip() for m in r.headers["Allow"].split(",")}
    assert "POST" in allow and "GET" not in allow
    assert err["details"] == {}
