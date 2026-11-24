"""POST /v1/route, /v1/compare and /v1/explain (API contract §2.8–§2.10).

Requests are parsed and validated here (no Phase 1 imports), executed in an engine worker via
the EnginePool, and the engine's result is mapped field for field onto the contract's response.
Nothing is recomputed in this process: `decision_id` is produced by the engine worker, which is
the single source of truth for the artefact fingerprints it hashes (§2.11, §9.1 A-1).

Requests are **strict** (§1): every request body object, at every level, accepts only the
fields this contract defines, so a misspelt field never silently falls back to its default.
"""
from __future__ import annotations

import asyncio
from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, Body, Request

from ... import ENGINE_VERSION
from ...engine.errors import EngineNotReady, ValidationFailed
from ...engine.state import state_from_dict
from ...engine.tasks import compare_task, explain_task, route_task
from ...engine.types import Transaction
from ...hashing import unsafe_numbers

router = APIRouter(prefix="/v1", tags=["routing"])

# §1: the complete set of fields each request body object accepts. Anything else is a 422.
ROUTE_KEYS = {"transaction", "state", "policy"}
COMPARE_KEYS = {"transaction", "state", "policies"}
TRANSACTION_KEYS = {"sender_country", "receiver_country", "amount_usd", "client_reference"}
# §2.8: at most 200 characters, counted as Unicode code points -- which is what len() counts
# in Python, and what the backend counts with [...s].length.
MAX_CLIENT_REFERENCE = 200
UNSAFE_NUMBER_MESSAGE = ("Integer-valued numbers outside the safe range (absolute value above 2^53 - 1) are "
                         "rejected, never rounded.")
_MISSING = object()


class ValidationErrors(ValidationFailed):
    """Several field errors in one `details.errors[]` array (§4)."""

    def __init__(self, errors: list):
        super().__init__("Request failed validation.", {"errors": errors})


def _fail(field, message: str):
    """One field error. `field` is None for an error about no single field, and `field` is then
    omitted from the item entirely (§4, owner decision)."""
    raise ValidationErrors([{"message": message} if field is None else {"field": field, "message": message}])


def _reject_unknown(obj: dict, allowed: set, path: str = "") -> None:
    for key in obj:
        if key not in allowed:
            _fail(f"{path}.{key}" if path else key, "Unknown field.")


def _required(obj: dict, key: str, path: str):
    if key not in obj:
        _fail(f"{path}.{key}" if path else key, "Field required.")
    return obj[key]


def _unsafe_number_errors(payload: dict) -> list:
    """§2.11: every integer-valued number in `transaction` or `state` whose absolute value
    exceeds 2^53 - 1, reported together so one response lists them all.

    The rule depends on the **value**, not its spelling, so the backend's `JSON.parse` and the
    engine cannot disagree. Such a value is rejected, never rounded.
    """
    errors = []
    for key in ("transaction", "state"):
        node = payload.get(key)
        if isinstance(node, (dict, list)):
            errors += [{"field": path, "message": UNSAFE_NUMBER_MESSAGE} for path in unsafe_numbers(node, key)]
    return errors


def _parse_transaction(payload: dict) -> Transaction:
    tx = _required(payload, "transaction", "")
    if not isinstance(tx, dict):
        _fail("transaction", "transaction must be an object.")
    _reject_unknown(tx, TRANSACTION_KEYS, "transaction")
    for name in ("sender_country", "receiver_country"):
        if not isinstance(_required(tx, name, "transaction"), str):
            _fail(f"transaction.{name}", "Must be a string.")
    amount = _required(tx, "amount_usd", "transaction")  # > 0 and finite is checked by the engine
    if isinstance(amount, bool) or not isinstance(amount, (int, float)):
        _fail("transaction.amount_usd", "Must be a number.")
    client_reference = tx.get("client_reference")
    if client_reference is not None:
        if not isinstance(client_reference, str):
            _fail("transaction.client_reference", "Must be a string or null.")
        if len(client_reference) > MAX_CLIENT_REFERENCE:
            _fail("transaction.client_reference",
                  f"Must be at most {MAX_CLIENT_REFERENCE} characters.")
    return Transaction(tx["sender_country"], tx["receiver_country"], amount, client_reference)


def _parse_common(payload: Any, allowed: set):
    """The parts `/v1/route`, `/v1/compare` and `/v1/explain` share."""
    if not isinstance(payload, dict):
        _fail(None, "Request body must be a JSON object.")
    _reject_unknown(payload, allowed)
    unsafe = _unsafe_number_errors(payload)
    if unsafe:
        raise ValidationErrors(unsafe)
    transaction = _parse_transaction(payload)
    state = state_from_dict(_required(payload, "state", ""))
    return transaction, state


def parse_route_request(payload: Any):
    """`/v1/route` and `/v1/explain` take the same body (§2.10)."""
    transaction, state = _parse_common(payload, ROUTE_KEYS)
    policy = payload.get("policy", _MISSING)
    if policy is _MISSING:
        policy = None  # an omitted policy takes its default, `waterfall` (§2.8)
    elif policy is None:
        # `policy: null` is rejected; only an OMITTED policy defaults (§1).
        _fail("policy", "Must be a policy name; null is not accepted.")
    elif not isinstance(policy, str):
        _fail("policy", "Must be a string.")
    return transaction, state, policy


def parse_compare_request(payload: Any):
    """`/v1/compare` (§2.9). An omitted `policies` means every enabled policy, which the
    engine resolves, because only it knows whether a checkpoint is enabled."""
    transaction, state = _parse_common(payload, COMPARE_KEYS)
    policies = payload.get("policies", _MISSING)
    if policies is _MISSING or policies is None:
        return transaction, state, None
    if not isinstance(policies, list):
        _fail("policies", "Must be a list of policy names.")
    for i, name in enumerate(policies):
        if not isinstance(name, str):
            _fail(f"policies[{i}]", "Must be a string.")
    return transaction, state, policies


def _metadata(request: Request) -> dict:
    meta = request.app.state.engine_metadata
    if meta is None:  # the same readiness rule as /v1/health
        raise EngineNotReady("Service is not ready: engine metadata not loaded yet.")
    return meta


async def _run(request: Request, fn, *args):
    return await asyncio.wrap_future(request.app.state.pool.submit(fn, *args))


def route_response(r, static: dict, meta: dict, device: str) -> dict:
    """RouteResult -> contract §2.8 RouteResponse, in the contract's field order."""
    return {
        "decision_id": r.decision_id,
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
                       # The Phase 2 SERVICE knowledge hash (CRLF->LF normalised), the same value
                       # /v1/version reports and decision_id hashes (§2.2, §2.11).
                       "knowledge_sha256": meta["artefacts"]["knowledge_sha256"],
                       "daily_state_sha256": r.daily_state_sha256, "state_frame_sha256": r.state_frame_sha256,
                       "checkpoint": r.checkpoint_sha256, "device": device, "platform": static["platform"]},
        "warnings": [{"code": w.code, "message": w.message} for w in r.warnings],
    }


@router.post("/route")
async def post_route(request: Request, payload: Any = Body(...)):
    transaction, state, policy = parse_route_request(payload)
    meta = _metadata(request)
    result = await _run(request, route_task, transaction, state, policy)
    return route_response(result, request.app.state.static_metadata, meta, request.app.state.settings.device)


@router.post("/compare")
async def post_compare(request: Request, payload: Any = Body(...)):
    """§2.9: several policies on ONE request-scoped state frame, in one engine task, so
    `same_state` holds and every result carries the same `state_frame_sha256`. A disabled or
    state-unavailable policy goes into `skipped` instead of failing the request."""
    transaction, state, policies = parse_compare_request(payload)
    meta = _metadata(request)
    outcome = await _run(request, compare_task, transaction, state, policies)
    static, device = request.app.state.static_metadata, request.app.state.settings.device
    return {
        "results": [route_response(r, static, meta, device) for r in outcome["results"]],
        "skipped": [dict(s) for s in outcome["skipped"]],
        "same_state": outcome["same_state"],
        "note": outcome["note"],
    }


@router.post("/explain")
async def post_explain(request: Request, payload: Any = Body(...)):
    """§2.10: the same body as `/v1/route`. The decision is recomputed deterministically, so the
    `decision_id` here equals the one `/v1/route` returned. `include_semantic_context` was
    removed from v1, so the strict request rule rejects it (§1)."""
    transaction, state, policy = parse_route_request(payload)
    _metadata(request)
    return await _run(request, explain_task, transaction, state, policy)
