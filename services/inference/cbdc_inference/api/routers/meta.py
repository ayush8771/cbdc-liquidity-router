"""GET /v1/health and GET /v1/version (API contract §2.1, §2.2).

Both are answered by the FastAPI process from startup metadata and the pool's
in-memory health; neither queues a task on an engine worker.
"""
from __future__ import annotations

import datetime as _dt

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ... import API_VERSION, ENGINE_VERSION, PHASE1_BASELINE_TAG
from ...checkpoints import REASON_NOT_CONFIGURED
from ...engine.errors import EngineNotReady
from ...engine.types import DEFAULT_POLICY, POLICY_STATUS
from ..metadata import artefact_checks, lock_file_for

router = APIRouter(prefix="/v1", tags=["metadata"])

NOT_READY_RETRY_AFTER_S = 5


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


def _policies(gate, ppo_enabled: bool) -> list:
    """§2.2. `ppo_projected` is enabled only when the approval gate resolved an approved
    checkpoint AND the engine worker re-verified its SHA-256 itself (§7)."""
    entry = {"policy": "ppo_projected", "status": POLICY_STATUS["ppo_projected"], "enabled": bool(ppo_enabled)}
    if not ppo_enabled:
        entry["disabled_reason"] = gate.reason or REASON_NOT_CONFIGURED
    return [
        {"policy": "waterfall", "status": POLICY_STATUS["waterfall"], "enabled": True},
        {"policy": "cheapest_feasible", "status": POLICY_STATUS["cheapest_feasible"], "enabled": True},
        entry,
    ]


@router.get("/version")
def get_version(request: Request):
    app = request.app
    meta = app.state.engine_metadata
    if meta is None:
        raise EngineNotReady("Service is not ready: engine metadata not loaded yet.")
    static, settings = app.state.static_metadata, app.state.settings
    artefacts = meta["artefacts"]
    return {
        "api_version": API_VERSION,
        "engine_version": ENGINE_VERSION,
        "phase1_baseline_tag": PHASE1_BASELINE_TAG,
        # Provenance only: read at build time, never hard-coded, and NOT part of decision_id (§2.11).
        "git_commit": static["git_commit"],
        "default_policy": DEFAULT_POLICY,
        "policies": _policies(app.state.checkpoint_gate, meta.get("ppo_enabled", False)),
        "checkpoint": meta.get("checkpoint"),
        # The Phase 2 SERVICE knowledge hash (CRLF->LF normalised), never Phase 1's raw-byte
        # KnowledgeBase.sha256 (§2.2).
        "knowledge": {"knowledge_version": meta["knowledge_version"], "sha256": artefacts["knowledge_sha256"]},
        # Exactly the fingerprints decision_id hashes, plus scenarios_sha256, which is a cache
        # key only and does not enter decision_id (§2.2, §2.11).
        "data": {"daily_state_sha256": artefacts["daily_state_sha256"],
                 "bridge_network_sha256": artefacts["bridge_network_sha256"],
                 "normalization_stats_sha256": artefacts["normalization_stats_sha256"],
                 "macro_risk_proxy_sha256": artefacts["macro_risk_proxy_sha256"],
                 "rpw_corridor_quarterly_sha256": artefacts["rpw_corridor_quarterly_sha256"],
                 "scenarios_sha256": meta["scenarios_sha256"],
                 "date_range": meta["date_range"]},
        "reward_weights": meta["reward_weights"],
        "runtime": {"platform": static["platform"], "python": static["python"], "torch": meta["torch"],
                    "device": settings.device, "lock_file": lock_file_for(static["platform"], meta["torch"])},
    }
