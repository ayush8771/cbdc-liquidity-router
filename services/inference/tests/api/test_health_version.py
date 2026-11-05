"""/v1/health, /v1/version and engine-error mapping, with a stand-in pool (no processes)."""
import datetime as dt
import re

import pytest
from fastapi.testclient import TestClient

from cbdc_inference import API_VERSION, ENGINE_VERSION
from cbdc_inference.api.app import create_app
from cbdc_inference.engine import errors as E
from cbdc_inference.settings import Settings

HEALTH_KEYS = {"status", "ready", "checks", "engine_pool", "time"}
CHECK_KEYS = {"structured_data", "daily_state", "knowledge_base", "engine_workers", "ppo_checkpoint"}
VERSION_KEYS = {"api_version", "engine_version", "phase1_baseline_tag", "git_commit", "default_policy", "policies",
                "checkpoint", "knowledge", "data", "reward_weights", "runtime"}


def _client(settings, factory):
    return TestClient(create_app(settings, pool_factory=factory))


# ------------------------------------------------------------------ /v1/health
def test_health_ok(repo_settings, fake_pool_factory):
    _, factory = fake_pool_factory()
    with _client(repo_settings, factory) as c:
        r = c.get("/v1/health", headers={"X-Request-Id": "h-1"})
    assert r.status_code == 200 and r.headers["X-Request-Id"] == "h-1"
    b = r.json()
    assert set(b) == HEALTH_KEYS and set(b["checks"]) == CHECK_KEYS
    assert (b["status"], b["ready"]) == ("ok", True)
    assert b["checks"] == {"structured_data": "ok", "daily_state": "ok", "knowledge_base": "ok",
                           "engine_workers": "ok", "ppo_checkpoint": "disabled"}
    assert b["engine_pool"] == {"workers": 2, "ready_workers": 2, "queued": 0, "max_queue": 32,
                               "rebuilds_since_start": 0}
    assert dt.datetime.strptime(b["time"], "%Y-%m-%dT%H:%M:%SZ")
    assert "Retry-After" not in r.headers


def test_one_worker_rebuilding_is_degraded_but_ready(repo_settings, fake_pool_factory):
    _, factory = fake_pool_factory(slot_states=("ready", "rebuilding"), engine_workers="rebuilding", rebuilds=1)
    with _client(repo_settings, factory) as c:
        r = c.get("/v1/health")
    b = r.json()
    assert r.status_code == 200
    assert (b["status"], b["ready"], b["checks"]["engine_workers"]) == ("degraded", True, "rebuilding")
    assert b["engine_pool"]["rebuilds_since_start"] == 1
    # One worker is still warming up, so only the other can take a task (§2.1).
    assert b["engine_pool"]["ready_workers"] == 1


@pytest.mark.parametrize("states,workers_status", [(("rebuilding", "rebuilding"), "rebuilding"),
                                                    (("starting", "starting"), "rebuilding"),
                                                    (("error", "error"), "error")])
def test_no_serving_worker_is_not_ready(repo_settings, fake_pool_factory, states, workers_status):
    _, factory = fake_pool_factory(slot_states=states, engine_workers=workers_status)
    with _client(repo_settings, factory) as c:
        r = c.get("/v1/health")
    assert r.status_code == 503 and r.headers["Retry-After"] == "5"
    b = r.json()
    assert set(b) == HEALTH_KEYS  # same body shape as 200 (contract §2.1)
    assert (b["status"], b["ready"], b["checks"]["engine_workers"]) == ("degraded", False, workers_status)
    assert b["engine_pool"]["ready_workers"] == 0  # `ready` is false until a worker has warmed up


def test_missing_artefacts_are_not_ready(tmp_path, fake_pool_factory):
    _, factory = fake_pool_factory()
    with _client(Settings(repo_root=tmp_path), factory) as c:
        r = c.get("/v1/health")
    assert r.status_code == 503
    checks = r.json()["checks"]
    assert (checks["structured_data"], checks["daily_state"], checks["knowledge_base"]) == ("error",) * 3


def test_not_ready_until_engine_metadata_loaded(repo_settings, fake_pool_factory):
    _, factory = fake_pool_factory(submit_error=E.EngineNotReady("no engine worker is available"))
    with _client(repo_settings, factory) as c:
        r = c.get("/v1/health")
    assert r.status_code == 503 and r.json()["ready"] is False
    assert r.json()["status"] == "ok"  # workers fine; readiness only waits for metadata


def test_health_does_not_use_a_worker(repo_settings, fake_pool_factory):
    pool, factory = fake_pool_factory()
    with _client(repo_settings, factory) as c:
        pool.submit_error = AssertionError("health must not submit tasks")
        assert c.get("/v1/health").status_code == 200


def test_ppo_checkpoint_error_is_reported(monkeypatch, fake_pool_factory, repo_settings):
    monkeypatch.setattr("cbdc_inference.api.app.resolve_gate",
                        lambda *a: __import__("cbdc_inference.checkpoints", fromlist=["x"]).CheckpointGate(
                            "error", "approved checkpoint SHA-256 mismatch"))
    _, factory = fake_pool_factory()
    with _client(repo_settings, factory) as c:
        b = c.get("/v1/health").json()
        v = c.get("/v1/version").json()
    assert b["checks"]["ppo_checkpoint"] == "error" and b["status"] == "ok"  # contract: only workers degrade
    ppo = [p for p in v["policies"] if p["policy"] == "ppo_projected"][0]
    assert ppo["enabled"] is False and ppo["disabled_reason"] == "approved checkpoint SHA-256 mismatch"


# ------------------------------------------------------------------ /v1/version
def test_version_shape_and_values(repo_settings, fake_pool_factory):
    pool, factory = fake_pool_factory()
    meta = pool.metadata
    with _client(repo_settings, factory) as c:
        r = c.get("/v1/version")
    assert r.status_code == 200
    v = r.json()
    assert set(v) == VERSION_KEYS
    assert (v["api_version"], v["engine_version"], v["phase1_baseline_tag"], v["default_policy"]) == \
        (API_VERSION, ENGINE_VERSION, "phase1-complete", "waterfall")
    assert re.fullmatch(r"[0-9a-f]{7,40}", v["git_commit"])
    assert v["policies"] == [
        {"policy": "waterfall", "status": "default", "enabled": True},
        {"policy": "cheapest_feasible", "status": "baseline", "enabled": True},
        {"policy": "ppo_projected", "status": "experimental", "enabled": False,
         "disabled_reason": "no approved checkpoint configured"}]
    assert v["checkpoint"] is None
    # The knowledge hash is the Phase 2 SERVICE hash the worker computed (§2.2).
    assert v["knowledge"] == {"knowledge_version": meta["knowledge_version"],
                              "sha256": meta["artefacts"]["knowledge_sha256"]}
    assert v["data"] == {"daily_state_sha256": meta["artefacts"]["daily_state_sha256"],
                         "bridge_network_sha256": meta["artefacts"]["bridge_network_sha256"],
                         "normalization_stats_sha256": meta["artefacts"]["normalization_stats_sha256"],
                         "macro_risk_proxy_sha256": meta["artefacts"]["macro_risk_proxy_sha256"],
                         "rpw_corridor_quarterly_sha256": meta["artefacts"]["rpw_corridor_quarterly_sha256"],
                         "scenarios_sha256": meta["scenarios_sha256"],
                         "date_range": {"start": "2011-01-01", "end": "2025-09-30"}}
    assert v["reward_weights"]["status"] == "placeholder"
    rt = v["runtime"]
    assert set(rt) == {"platform", "python", "torch", "device", "lock_file"}
    assert (rt["torch"], rt["device"]) == ("2.13.0+cpu", "cpu")
    assert rt["lock_file"] == f"services/inference/requirements/{rt['platform']}-cpu.txt"


def test_version_not_ready_until_engine_metadata_loads(repo_settings, fake_pool_factory):
    _, factory = fake_pool_factory(submit_error=E.EngineNotReady("no engine worker is available"))
    with _client(repo_settings, factory) as c:
        r = c.get("/v1/version", headers={"X-Request-Id": "v-1"})
    assert r.status_code == 503 and r.headers["Retry-After"] == "5"
    assert r.json()["error"]["code"] == "NOT_READY" and r.json()["error"]["request_id"] == "v-1"


@pytest.mark.parametrize("torch_version,expected", [("2.13.0+cpu", "cpu"), ("2.13.0+cu130", "cu130"),
                                                    ("2.13.0", "cpu")])
def test_lock_file_follows_torch_build(torch_version, expected):
    from cbdc_inference.api.metadata import lock_file_for
    assert lock_file_for("windows-x86_64", torch_version) == f"services/inference/requirements/windows-x86_64-{expected}.txt"


# ------------------------------------------------------------------ engine error mapping (contract §4)
ENGINE_ERRORS = [
    (E.ValidationFailed("bad", {"field": "policy"}), 422, "VALIDATION_ERROR", None),
    (E.StateVenueMismatch("venues", {"field": "state.venues"}), 422, "STATE_VENUE_MISMATCH", None),
    (E.InvalidStateValue("value", {"field": "state.venues[0].congestion"}), 422, "INVALID_STATE_VALUE", None),
    (E.PolicyUnavailableForState("needs history", {"field": "state.venues"}), 422,
     "POLICY_UNAVAILABLE_FOR_STATE", None),
    (E.UnsupportedCorridor("x"), 422, "UNSUPPORTED_CORRIDOR", None),
    (E.InvalidAmount("x"), 422, "INVALID_AMOUNT", None),
    (E.DateOutOfRange("x"), 422, "DATE_OUT_OF_RANGE", None),
    (E.DateInGapBuffer("x"), 422, "DATE_IN_GAP_BUFFER", None),
    (E.UnknownScenario("x"), 422, "UNKNOWN_SCENARIO", None),
    (E.PolicyDisabled("ppo off", {"field": "policy"}), 409, "POLICY_DISABLED", None),
    (E.EngineBusy("full", {"max_queue": 32}), 503, "ENGINE_BUSY", "1"),
    (E.EngineTimeout("slow", {"timeout_s": 10.0}), 504, "ENGINE_TIMEOUT", None),
]


@pytest.mark.parametrize("exc,status,code,retry_after", ENGINE_ERRORS, ids=[c for _, _, c, _ in ENGINE_ERRORS])
def test_engine_errors_map_to_contract_envelope(repo_settings, fake_pool_factory, exc, status, code, retry_after):
    _, factory = fake_pool_factory()
    app = create_app(repo_settings, pool_factory=factory)

    def raiser():
        raise exc
    app.add_api_route("/v1/_raise", raiser)
    with TestClient(app) as c:
        r = c.get("/v1/_raise", headers={"X-Request-Id": "e-1"})
    assert r.status_code == status
    # §4: VALIDATION_ERROR carries `details.errors[]`; other 422 codes may carry `details.field`.
    # Everything else an engine error carries is dropped, so no internal value can leak.
    if code == "VALIDATION_ERROR":
        details = {"errors": [{"field": "policy", "message": exc.message}]}
    else:
        details = {"field": exc.details["field"]} if "field" in exc.details else {}
    assert r.json() == {"error": {"code": code, "message": exc.message, "details": details, "request_id": "e-1"}}
    assert r.headers.get("Retry-After") == retry_after
    assert r.headers["X-Request-Id"] == "e-1"


def test_not_ready_never_reveals_which_artefacts_are_missing(repo_settings, fake_pool_factory):
    """§4: a 4xx/503 message never exposes internal filesystem paths (owner decision)."""
    _, factory = fake_pool_factory()
    app = create_app(repo_settings, pool_factory=factory)

    def raiser():
        raise E.EngineNotReady("required Phase 1 artefacts missing under /repo",
                               {"missing": ["data/processed/secret.parquet"]})
    app.add_api_route("/v1/_raise", raiser)
    with TestClient(app) as c:
        r = c.get("/v1/_raise")
    assert r.status_code == 503 and r.headers["Retry-After"] == "5"
    err = r.json()["error"]
    assert err["code"] == "NOT_READY" and err["details"] == {}
    assert "/repo" not in err["message"] and "parquet" not in err["message"]


@pytest.mark.parametrize("exc", [E.EngineIntegrityError("integrity failed", {"problems": ["cache replaced"]}),
                                 E.EngineWorkerCrashed("crashed", {"exitcode": 7}),
                                 E.EngineError("Unexpected internal error.")])
def test_internal_errors_hide_details(repo_settings, fake_pool_factory, exc):
    _, factory = fake_pool_factory()
    app = create_app(repo_settings, pool_factory=factory)

    def raiser():
        raise exc
    app.add_api_route("/v1/_raise", raiser)
    with TestClient(app) as c:
        r = c.get("/v1/_raise", headers={"X-Request-Id": "e-2"})
    assert r.status_code == 500
    assert r.json() == {"error": {"code": "INTERNAL_ERROR", "message": "Unexpected internal error.", "details": {},
                                  "request_id": "e-2"}}
