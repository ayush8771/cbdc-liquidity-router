"""/v1/network, /v1/state, /v1/replay/calendar, /v1/scenarios through FastAPI, with a stand-in pool."""
import pytest
from fastapi.testclient import TestClient

from cbdc_inference.api.app import create_app
from cbdc_inference.engine import ReplayState, ScenarioState
from cbdc_inference.engine import errors as E

STATE_BODY = {"corridor": "GBR->PHL", "corridor_risk": 0.1, "baseline_cost_pct": 0.06, "venues": [],
              "warnings": [], "state": {"mode": "historical_replay", "date": "2024-06-14", "split": "test",
                                        "scenario_id": None}}


def _client(settings, factory):
    return TestClient(create_app(settings, pool_factory=factory))


def test_network_passes_worker_result(repo_settings, fake_pool_factory):
    net = {"corridors": [], "max_single_transfer_usd": 500000.0, "max_single_transfer_provenance": "project_assumption"}
    pool, factory = fake_pool_factory(results={"network_task": net})
    with _client(repo_settings, factory) as c:
        r = c.get("/v1/network", headers={"X-Request-Id": "n-1"})
    assert r.status_code == 200 and r.json() == net and r.headers["X-Request-Id"] == "n-1"
    assert ("network_task", ()) in pool.calls


def test_state_builds_the_engine_request(repo_settings, fake_pool_factory):
    pool, factory = fake_pool_factory(results={"state_task": STATE_BODY})
    with _client(repo_settings, factory) as c:
        r = c.get("/v1/state", params={"corridor": "GBR->PHL", "mode": "historical_replay", "date": "2024-06-14"})
        assert r.status_code == 200
        assert list(r.json()) == ["corridor", "state", "corridor_risk", "baseline_cost_pct", "venues", "warnings"]
        c.get("/v1/state", params={"corridor": "GBR->PHL", "mode": "scenario", "date": "2024-06-14",
                                   "scenario_id": "congestion_x2", "include_history": "true"})
    calls = [a for n, a in pool.calls if n == "state_task"]
    assert calls == [("GBR->PHL", ReplayState("2024-06-14"), False),
                     ("GBR->PHL", ScenarioState("2024-06-14", "congestion_x2"), True)]


@pytest.mark.parametrize("params,field", [
    ({"mode": "historical_replay", "date": "2024-06-14"}, "corridor"),
    ({"corridor": "GBR->PHL", "date": "2024-06-14"}, "mode"),
    ({"corridor": "GBR->PHL", "mode": "historical_replay"}, "date"),
])
def test_state_missing_query_parameter(repo_settings, fake_pool_factory, params, field):
    _, factory = fake_pool_factory(results={"state_task": STATE_BODY})
    with _client(repo_settings, factory) as c:
        r = c.get("/v1/state", params=params)
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION_ERROR"
    # §4: details.errors[] is a list of {field, message}; `field` is the value's path.
    assert any(e.get("field") == field for e in r.json()["error"]["details"]["errors"])


@pytest.mark.parametrize("params,field", [
    ({"mode": "explicit"}, "mode"),
    ({"mode": "replay"}, "mode"),
    ({"mode": "scenario"}, "scenario_id"),
    ({"mode": "historical_replay", "scenario_id": "baseline"}, "scenario_id"),
])
def test_state_invalid_mode_combinations(repo_settings, fake_pool_factory, params, field):
    pool, factory = fake_pool_factory(results={"state_task": STATE_BODY})
    with _client(repo_settings, factory) as c:
        r = c.get("/v1/state", params={"corridor": "GBR->PHL", "date": "2024-06-14", **params})
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["code"] == "VALIDATION_ERROR"
    assert [e["field"] for e in err["details"]["errors"]] == [field]
    assert not [n for n, _ in pool.calls if n == "state_task"]  # rejected before reaching a worker


def test_state_include_history_must_be_boolean(repo_settings, fake_pool_factory):
    _, factory = fake_pool_factory(results={"state_task": STATE_BODY})
    with _client(repo_settings, factory) as c:
        r = c.get("/v1/state", params={"corridor": "GBR->PHL", "mode": "historical_replay", "date": "2024-06-14",
                                       "include_history": "maybe"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION_ERROR"


@pytest.mark.parametrize("exc,status,code", [
    (E.UnsupportedCorridor("x", {"field": "corridor"}), 422, "UNSUPPORTED_CORRIDOR"),
    (E.DateInGapBuffer("x", {"field": "date"}), 422, "DATE_IN_GAP_BUFFER"),
    (E.DateOutOfRange("x", {"field": "date"}), 422, "DATE_OUT_OF_RANGE"),
    (E.UnknownScenario("x", {"field": "state.scenario_id"}), 422, "UNKNOWN_SCENARIO"),
    (E.EngineTimeout("slow", {"timeout_s": 10.0}), 504, "ENGINE_TIMEOUT"),
    (E.EngineIntegrityError("bad", {"problems": ["x"]}), 500, "INTERNAL_ERROR"),
])
def test_state_engine_errors(repo_settings, fake_pool_factory, exc, status, code):
    _, factory = fake_pool_factory(results={"state_task": exc})
    with _client(repo_settings, factory) as c:
        r = c.get("/v1/state", params={"corridor": "GBR->PHL", "mode": "historical_replay", "date": "2024-06-14"})
    assert r.status_code == status and r.json()["error"]["code"] == code


def test_busy_pool_returns_engine_busy(repo_settings, fake_pool_factory):
    pool, factory = fake_pool_factory()
    with _client(repo_settings, factory) as c:
        pool.submit_error = E.EngineBusy("full", {"max_queue": 32})
        r = c.get("/v1/network")
    assert r.status_code == 503 and r.headers["Retry-After"] == "1" and r.json()["error"]["code"] == "ENGINE_BUSY"


def test_calendar_and_scenarios_come_from_startup_metadata(repo_settings, fake_pool_factory):
    pool, factory = fake_pool_factory()
    with _client(repo_settings, factory) as c:
        cal, scen = c.get("/v1/replay/calendar"), c.get("/v1/scenarios")
    assert cal.status_code == scen.status_code == 200
    assert cal.json() == pool.metadata["replay_calendar"] and scen.json() == pool.metadata["scenarios"]
    assert [n for n, _ in pool.calls] == ["metadata_task"]  # no per-request worker task


@pytest.mark.parametrize("path", ["/v1/replay/calendar", "/v1/scenarios"])
def test_calendar_and_scenarios_not_ready_before_metadata(repo_settings, fake_pool_factory, path):
    _, factory = fake_pool_factory(submit_error=E.EngineNotReady("no engine worker is available"))
    with _client(repo_settings, factory) as c:
        r = c.get(path)
    assert r.status_code == 503 and r.headers["Retry-After"] == "5" and r.json()["error"]["code"] == "NOT_READY"
