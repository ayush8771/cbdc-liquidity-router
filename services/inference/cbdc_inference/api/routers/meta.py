"""GET /v1/health and GET /v1/version (API contract §2.1, §2.2).

Both are answered by the FastAPI process from startup metadata and the pool's
in-memory health; neither queues a task on an engine worker.
"""
from __future__ import annotations

import datetime as _dt

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ... import API_VERSION, ENGINE_VERSION, PHASE1_BASELINE_TAG
from ...engine.errors import EngineNotReady
from ...engine.types import DEFAULT_POLICY, POLICY_STATUS
from ..metadata import artefact_checks, lock_file_for

router = APIRouter(prefix="/v1", tags=["metadata"])

NOT_READY_RETRY_AFTER_S = 5
PPO_NOT_IMPLEMENTED_REASON = "ppo_projected is not implemented in this engine version"


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def health_body(app) -> tuple[dict, bool]:
    pool_health = app.state.pool.health()
    checks = artefact_checks(app.state.settings.repo_root_resolved)
    artefacts_ok = all(v == "ok" for v in checks.values())
    checks["engine_workers"] = pool_health["engine_workers"]
    checks["ppo_checkpoint"] = app.state.checkpoint_gate.status
    # Ready = artefacts present, at least one worker able to take a task, and the engine
    # metadata loaded (so a 200 here guarantees /v1/version answers too).
    serving = any(s["state"] == "ready" for s in pool_health["slots"])
    ready = artefacts_ok and serving and app.state.engine_metadata is not None
    status = "degraded" if checks["engine_workers"] in ("rebuilding", "error") else "ok"
    return {"status": status, "ready": ready, "checks": checks, "engine_pool": pool_health["engine_pool"],
            "time": _now()}, ready


@router.get("/health")
def get_health(request: Request):
    body, ready = health_body(request.app)
    if ready:
        return JSONResponse(status_code=200, content=body)
    return JSONResponse(status_code=503, content=body, headers={"Retry-After": str(NOT_READY_RETRY_AFTER_S)})


def _policies(gate) -> list:
    ppo_reason = gate.reason if not gate.enabled else PPO_NOT_IMPLEMENTED_REASON
    return [
        {"policy": "waterfall", "status": POLICY_STATUS["waterfall"], "enabled": True},
        {"policy": "cheapest_feasible", "status": POLICY_STATUS["cheapest_feasible"], "enabled": True},
        # ppo_projected stays disabled until PPO is wired into the engine AND a checkpoint is approved.
        {"policy": "ppo_projected", "status": POLICY_STATUS["ppo_projected"], "enabled": False,
         "disabled_reason": ppo_reason},
    ]


@router.get("/version")
def get_version(request: Request):
    app = request.app
    meta = app.state.engine_metadata
    if meta is None:
        raise EngineNotReady("Service is not ready: engine metadata not loaded yet.")
    static, settings = app.state.static_metadata, app.state.settings
    return {
        "api_version": API_VERSION,
        "engine_version": ENGINE_VERSION,
        "phase1_baseline_tag": PHASE1_BASELINE_TAG,
        "git_commit": static["git_commit"],
        "default_policy": DEFAULT_POLICY,
        "policies": _policies(app.state.checkpoint_gate),
        "checkpoint": None,
        "knowledge": {"knowledge_version": meta["knowledge_version"], "sha256": meta["knowledge_sha256"]},
        "data": {"daily_state_sha256": meta["daily_state_sha256"],
                 "bridge_network_sha256": static["data"]["bridge_network_sha256"],
                 "normalization_stats_sha256": static["data"]["normalization_stats_sha256"],
                 "date_range": meta["date_range"]},
        "reward_weights": meta["reward_weights"],
        "runtime": {"platform": static["platform"], "python": static["python"], "torch": meta["torch"],
                    "device": settings.device, "lock_file": lock_file_for(static["platform"], meta["torch"])},
    }
