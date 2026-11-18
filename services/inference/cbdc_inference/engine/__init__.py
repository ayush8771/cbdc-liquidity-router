"""Engine layer (arch §5.1, §6). Never imports FastAPI.

Phase 1 `src` is imported only when an `EngineWorker` is constructed (inside an
engine worker process), never at package import time, so the API process holds
no Phase 1 state.

Implemented:
  * `EngineWorker.route(transaction, state, policy)` for `waterfall` (default),
    `cheapest_feasible` and `ppo_projected`, in historical_replay, scenario and
    explicit modes, each result carrying its own `decision_id` (§2.11);
  * `EngineWorker.compare(...)` (§2.9): several policies on ONE request-scoped
    state frame, in one task, so `same_state` holds;
  * `EngineWorker.explain(...)` (§2.10): a structured explanation of a decision,
    with `semantic_context` always null in v1;
  * `EnginePool` (pool.py): isolated spawned worker processes with a bounded
    queue, the request deadline and minimum start budget (§5), the worker
    execution timeout and individual worker recycling.

`ppo_projected` is served only with an approved checkpoint whose SHA-256 the
worker re-verified itself, and only with the inference-time capacity projection
(contract §7, arch D2-D4). Raw PPO is never exposed.
"""
from .errors import EngineError
from .state import state_from_dict, validate_explicit_values
from .types import (DEFAULT_POLICY, POLICIES, ExplicitHistory, ExplicitState, ExplicitVenue, ReplayState,
                    RouteResult, ScenarioState, Transaction)
from .pool import EnginePool
from .worker import EngineWorker, init_worker, run_route

route = run_route  # the unified route(transaction, state, policy) entry point inside a worker process

__all__ = ["EngineError", "EnginePool", "EngineWorker", "init_worker", "run_route", "route", "DEFAULT_POLICY", "POLICIES",
           "ReplayState", "ScenarioState", "ExplicitState", "ExplicitVenue", "ExplicitHistory", "RouteResult",
           "Transaction", "state_from_dict", "validate_explicit_values"]
