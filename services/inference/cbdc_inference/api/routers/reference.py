"""GET /v1/network, /v1/state, /v1/replay/calendar, /v1/scenarios (API contract §2.3, §2.5–2.7).

Per contract §2, /v1/replay/calendar and /v1/scenarios are answered from metadata
loaded at startup (computed by an engine worker from Phase 1's split.py and
scenarios.py); /v1/network and /v1/state run as tasks in an engine worker.
This module imports no Phase 1 code.
"""
from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, Query, Request

from ...engine.errors import EngineNotReady, ValidationFailed
from ...engine.tasks import network_task, state_task
from ...engine.types import ReplayState, ScenarioState

router = APIRouter(prefix="/v1", tags=["metadata"])


def _metadata(request: Request) -> dict:
    meta = request.app.state.engine_metadata
    if meta is None:
        raise EngineNotReady("Service is not ready: engine metadata not loaded yet.")
    return meta


async def _run(request: Request, fn, *args):
    return await asyncio.wrap_future(request.app.state.pool.submit(fn, *args))


@router.get("/network")
async def get_network(request: Request):
    return await _run(request, network_task)


@router.get("/state")
async def get_state(request: Request,
                    corridor: str = Query(...),
                    mode: str = Query(...),
                    date: str = Query(...),
                    scenario_id: Optional[str] = Query(None),
                    include_history: bool = Query(False)):
    if mode == "historical_replay":
        if scenario_id is not None:
            # rejected rather than ignored, so a caller can't believe a scenario was applied
            raise ValidationFailed("scenario_id is only allowed with mode=scenario", {"field": "scenario_id"})
        state = ReplayState(date)
    elif mode == "scenario":
        if scenario_id is None:
            raise ValidationFailed("scenario_id is required when mode=scenario", {"field": "scenario_id"})
        state = ScenarioState(date, scenario_id)
    else:
        raise ValidationFailed("mode must be historical_replay or scenario; explicit states are not looked up",
                               {"field": "mode"})
    body = await _run(request, state_task, corridor, state, include_history)
    # response key order as in contract §2.5
    return {"corridor": body["corridor"], "state": body["state"], "corridor_risk": body["corridor_risk"],
            "baseline_cost_pct": body["baseline_cost_pct"], "venues": body["venues"], "warnings": body["warnings"]}


@router.get("/replay/calendar")
def get_replay_calendar(request: Request):
    return _metadata(request)["replay_calendar"]


@router.get("/scenarios")
def get_scenarios(request: Request):
    return _metadata(request)["scenarios"]
