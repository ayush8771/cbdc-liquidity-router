"""Engine layer (arch §5.1, §6). Never imports FastAPI.

Phase 1 `src` is imported only when an `EngineWorker` is constructed (inside an
engine worker process), never at package import time, so the API process holds
no Phase 1 state.

Implemented: `EngineWorker.route(transaction, state, policy)` for `waterfall`
(default) and `cheapest_feasible`, in historical_replay, scenario and explicit modes.
`EnginePool` (pool.py) runs it in isolated spawned worker processes with a
bounded queue, per-task timeout and automatic rebuild.
Not yet: ppo_projected, decision_id, STATE_OUTSIDE_TRAINING_RANGE.
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
