"""The real EnginePool behind the FastAPI app: startup, readiness, recovery, shutdown."""
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from cbdc_inference.api.app import create_app
from cbdc_inference.engine import ScenarioState, tasks
from cbdc_inference.engine import errors as E
from cbdc_inference.settings import Settings

REPO_ROOT = Path(__file__).resolve().parents[4]


def _poll(client, path, status, timeout=180.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        r = client.get(path)
        if r.status_code == status:
            return r
        time.sleep(0.1)
    raise AssertionError(f"{path} never returned {status}; last: {r.status_code} {r.text}")


@pytest.fixture(scope="module")
def live(phase1_unchanged):
    """One worker, so a rebuild makes the service not ready (deterministic)."""
    app = create_app(Settings(repo_root=REPO_ROOT, engine_workers=1, engine_task_timeout_s=4.0))
    client = TestClient(app)
    client.__enter__()
    yield app, client
    client.__exit__(None, None, None)


def test_startup_does_not_block_and_becomes_ready(live):
    app, client = live
    first = client.get("/v1/health")
    assert first.status_code in (200, 503)  # workers warm up in the background
    r = _poll(client, "/v1/health", 200)
    b = r.json()
    assert (b["status"], b["ready"], b["checks"]["engine_workers"]) == ("ok", True, "ok")
    assert b["engine_pool"] == {"workers": 1, "ready_workers": 1, "queued": 0, "max_queue": 32,
                                "rebuilds_since_start": 0}


def test_version_reports_the_real_engine(live, worker):
    _, client = live
    v = _poll(client, "/v1/version", 200).json()
    assert v["data"]["daily_state_sha256"] == worker.daily_state_sha256  # frame fingerprint from a worker
    assert v["knowledge"] == {"knowledge_version": worker.knowledge.knowledge_version,
                              "sha256": worker.knowledge.sha256}
    assert v["data"]["date_range"] == {"start": "2011-01-01", "end": "2025-09-30"}
    assert v["runtime"]["torch"] == worker._p.torch.__version__
    assert v["checkpoint"] is None


def test_reference_endpoints_with_real_workers(live, worker):
    _, client = live
    _poll(client, "/v1/health", 200)
    assert client.get("/v1/network").json() == worker.network()
    assert client.get("/v1/replay/calendar").json() == worker.replay_calendar()
    assert client.get("/v1/scenarios").json() == worker.scenario_list()
    r = client.get("/v1/state", params={"corridor": "GBR->PHL", "mode": "scenario", "date": "2024-06-14",
                                        "scenario_id": "cheapest_venue_outage", "include_history": "true"})
    assert r.status_code == 200
    assert r.json() == worker.state_view("GBR->PHL", ScenarioState("2024-06-14", "cheapest_venue_outage"), True)
    bad = client.get("/v1/state", params={"corridor": "USA->PHL", "mode": "historical_replay", "date": "2024-06-14"})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "UNSUPPORTED_CORRIDOR"
    gap = client.get("/v1/state", params={"corridor": "GBR->PHL", "mode": "historical_replay", "date": "2022-01-10"})
    assert gap.status_code == 422 and gap.json()["error"]["code"] == "DATE_IN_GAP_BUFFER"
    assert client.get("/v1/health").json()["engine_pool"]["rebuilds_since_start"] == 0  # errors don't rebuild


def test_route_concurrent_mixed_modes_equal_serial_engine(live, worker):
    """Isolation end to end: replay, scenario and explicit requests on the same corridor and
    date, sent concurrently over HTTP to real worker processes, equal serial in-process results."""
    from concurrent.futures import ThreadPoolExecutor
    from cbdc_inference.api.routers.route import route_response
    from cbdc_inference.engine import state_from_dict, Transaction
    _, client = live
    _poll(client, "/v1/health", 200)
    explicit = {"mode": "explicit", "reference_date": "2024-06-14", "venues": [
        {"bridge_uid": "GBR->PHL#0", "liquidity_usd": 90000.0, "congestion": 0.4},
        {"bridge_uid": "GBR->PHL#1", "liquidity_usd": 20000.0, "congestion": 0.8},
        {"bridge_uid": "GBR->PHL#2", "liquidity_usd": 400000.0, "congestion": 0.1}]}
    states = [{"mode": "historical_replay", "date": "2024-06-14"},
              {"mode": "scenario", "date": "2024-06-14", "scenario_id": "cheapest_venue_outage"}, explicit]
    payloads = [{"transaction": {"sender_country": "GBR", "receiver_country": "PHL", "amount_usd": 300000.0},
                 "state": s, "policy": p} for s in states for p in ("waterfall", "cheapest_feasible")]
    order = [i % len(payloads) for i in range(24)]
    with ThreadPoolExecutor(max_workers=8) as clients:
        responses = list(clients.map(lambda i: client.post("/v1/route", json=payloads[i]), order))
    static = dict(live[0].state.static_metadata)
    meta = live[0].state.engine_metadata
    expected = [route_response(worker.route(Transaction("GBR", "PHL", 300000.0), state_from_dict(p["state"]),
                                            p["policy"]), static, meta, "cpu") for p in payloads]
    assert all(r.status_code == 200 for r in responses)
    assert [r.json() for r in responses] == [expected[i] for i in order]


def test_worker_crash_degrades_then_recovers(live):
    app, client = live
    _poll(client, "/v1/health", 200)
    with pytest.raises(E.EngineWorkerCrashed):
        app.state.pool.submit(tasks.fault_crash).result(60)
    r = client.get("/v1/health")
    assert r.status_code == 503 and r.headers["Retry-After"] == "5"
    assert (r.json()["status"], r.json()["ready"], r.json()["checks"]["engine_workers"]) == \
        ("degraded", False, "rebuilding")
    r = _poll(client, "/v1/health", 200)
    assert r.json()["status"] == "ok" and r.json()["engine_pool"]["rebuilds_since_start"] == 1


def test_shutdown_stops_workers():
    app = create_app(Settings(repo_root=REPO_ROOT, engine_workers=1))
    with TestClient(app) as client:
        _poll(client, "/v1/health", 200)
        pool = app.state.pool
        procs = [s.proc for s in pool._slots]
        assert all(p.is_alive() for p in procs)
    assert all(not p.is_alive() for p in procs)
    assert all(s["state"] == "stopped" for s in pool.health()["slots"])
    with pytest.raises(E.EngineNotReady):
        pool.submit(tasks.ping_task)


def test_missing_artefacts_start_but_never_become_ready(tmp_path):
    app = create_app(Settings(repo_root=tmp_path, engine_workers=1))
    with TestClient(app) as client:
        deadline = time.monotonic() + 60
        while app.state.pool.health()["engine_workers"] != "error" and time.monotonic() < deadline:
            time.sleep(0.1)
        r = client.get("/v1/health")
        assert r.status_code == 503
        b = r.json()
        assert b["checks"]["engine_workers"] == "error" and b["checks"]["structured_data"] == "error"
        assert client.get("/v1/version").json()["error"]["code"] == "NOT_READY"
