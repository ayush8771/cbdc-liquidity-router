"""POST /v1/route (API contract §2.8).

The request is parsed here (no Phase 1 imports), routed in an engine worker via
the EnginePool, and the engine's RouteResult is mapped field for field onto the
contract's RouteResponse. Nothing is recomputed in this process.

Blocked by unresolved decisions (reported, not guessed):
* `decision_id` is returned as null: its canonical form (C7) and the
  cross-platform hashing of artefacts (C5) are undecided.
* STATE_OUTSIDE_TRAINING_RANGE is never emitted: its definition is undecided.
* Unknown fields outside `state` (top level, `transaction`) are ignored (C8 open);
  unknown fields inside `state` are rejected (§2.4).
"""
from __future__ import annotations

import asyncio
from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, Body, Request

from ... import ENGINE_VERSION
from ...engine.errors import EngineNotReady, ValidationFailed
from ...engine.state import state_from_dict
from ...engine.tasks import route_task
from ...engine.types import Transaction

router = APIRouter(prefix="/v1", tags=["routing"])


def _required(obj: dict, key: str, path: str):
    if key not in obj:
        raise ValidationFailed("Field required.", {"field": f"{path}.{key}" if path else key})
    return obj[key]


def parse_route_request(payload: Any):
    if not isinstance(payload, dict):
        raise ValidationFailed("Request body must be a JSON object.", {"field": "body"})
    tx = _required(payload, "transaction", "")
    if not isinstance(tx, dict):
        raise ValidationFailed("transaction must be an object.", {"field": "transaction"})
    sender = _required(tx, "sender_country", "transaction")
    receiver = _required(tx, "receiver_country", "transaction")
    for name, value in (("sender_country", sender), ("receiver_country", receiver)):
        if not isinstance(value, str):
            raise ValidationFailed("Must be a string.", {"field": f"transaction.{name}"})
    amount = _required(tx, "amount_usd", "transaction")  # number/finite/>0 checked by the engine
    client_reference = tx.get("client_reference")
    if client_reference is not None and not isinstance(client_reference, str):
        raise ValidationFailed("Must be a string or null.", {"field": "transaction.client_reference"})
    state = state_from_dict(_required(payload, "state", ""))
    policy = payload.get("policy")
    if policy is not None and not isinstance(policy, str):
        raise ValidationFailed("Must be a string.", {"field": "policy"})
    return Transaction(sender, receiver, amount, client_reference), state, policy


def route_response(r, static: dict, device: str) -> dict:
    """RouteResult -> contract §2.8 RouteResponse, in the contract's field order."""
    return {
        "decision_id": None,  # blocked: C5/C7
        "policy": r.policy,
        "policy_status": r.policy_status,
        "transaction": {"sender_country": r.sender_country, "receiver_country": r.receiver_country,
                        "amount_usd": r.amount_usd, "corridor": r.corridor, "simulation_date": r.simulation_date,
                        "client_reference": r.client_reference},
        "feasibility": {"allowed": r.allowed, "reason": r.reason, "decisive_fact_ids": list(r.decisive_fact_ids),
                        "knowledge_version": r.knowledge_version},
        "allocations": [asdict(a) for a in r.allocations],
        "totals": {"amount_usd": r.amount_usd, "requested_usd": r.requested_usd, "executed_usd": r.executed_usd,
                   "unrouted_env_usd": r.unrouted_env_usd, "unrouted_amount_based_usd": r.unrouted_amount_based_usd,
                   "completion_ratio": r.completion_ratio, "completed": r.completed, "bridges_used": r.bridges_used},
        "metrics": {"fee_cost_usd": r.fee_cost_usd, "baseline_cost_pct": r.baseline_cost_pct,
                    "cost_term": r.cost_term, "latency_term": r.latency_term, "risk_term": r.risk_term,
                    "unrouted_term_env": r.unrouted_term_env,
                    "unrouted_term_amount_based": r.unrouted_term_amount_based,
                    "reward_env": r.reward_env, "reward_amount_based": r.reward_amount_based,
                    "reward_weights": dict(r.reward_weights)},
        "diagnostics": {"regime": r.regime, "combined_liquidity_usd": r.combined_liquidity_usd,
                        "projection_applied": r.projection_applied},
        "provenance": {"state_mode": r.state_mode, "state_date": r.state_date, "split": r.split,
                       "scenario_id": r.scenario_id, "values_provenance": r.values_provenance,
                       "engine_version": ENGINE_VERSION, "git_commit": static["git_commit"],
                       "knowledge_sha256": static.get("knowledge_sha256"),
                       "daily_state_sha256": r.daily_state_sha256, "state_frame_sha256": r.state_frame_sha256,
                       "checkpoint": None, "device": device, "platform": static["platform"]},
        "warnings": [{"code": w.code, "message": w.message} for w in r.warnings],
    }


@router.post("/route")
async def post_route(request: Request, payload: Any = Body(...)):
    transaction, state, policy = parse_route_request(payload)
    meta = request.app.state.engine_metadata
    if meta is None:  # same readiness rule as /v1/health
        raise EngineNotReady("Service is not ready: engine metadata not loaded yet.")
    result = await asyncio.wrap_future(request.app.state.pool.submit(route_task, transaction, state, policy))
    static = dict(request.app.state.static_metadata)
    static["knowledge_sha256"] = meta["knowledge_sha256"]  # same raw-bytes value as /v1/version (C5 open)
    return route_response(result, static, request.app.state.settings.device)
