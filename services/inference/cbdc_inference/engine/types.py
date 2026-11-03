"""Plain dataclasses for engine inputs and outputs (picklable; no Phase 1 or FastAPI types).

Field names follow the snake_case names of API contract §2.8 so the API layer
can map them without recomputing anything.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Union

POLICIES = ("waterfall", "cheapest_feasible", "ppo_projected")
DEFAULT_POLICY = "waterfall"
POLICY_STATUS = {"waterfall": "default", "cheapest_feasible": "baseline", "ppo_projected": "experimental"}


@dataclass(frozen=True)
class Transaction:
    sender_country: str
    receiver_country: str
    amount_usd: float
    client_reference: Optional[str] = None


@dataclass(frozen=True)
class ReplayState:
    date: str  # YYYY-MM-DD
    mode: str = field(default="historical_replay", init=False)


@dataclass(frozen=True)
class ScenarioState:
    date: str  # YYYY-MM-DD
    scenario_id: str
    mode: str = field(default="scenario", init=False)


StateSpec = Union[ReplayState, ScenarioState]  # explicit mode: not implemented yet


@dataclass(frozen=True)
class Allocation:
    slot: int
    bridge_uid: str
    data_source_tag: Optional[str]
    fee_pct: float
    liquidity_usd: float
    congestion: float
    risk: float
    share_requested: float
    amount_requested_usd: float
    amount_executed_usd: float
    amount_clipped_usd: float
    share_before_projection: Optional[float] = None


@dataclass(frozen=True)
class EngineWarning:
    code: str
    message: str


@dataclass(frozen=True)
class RouteResult:
    # policy
    policy: str
    policy_status: str
    # transaction echo
    sender_country: str
    receiver_country: str
    corridor: str
    amount_usd: float
    simulation_date: str
    client_reference: Optional[str]
    # feasibility (StaticMemoryProvider via CBDCLiquidityEnv)
    allowed: bool
    reason: Optional[str]
    decisive_fact_ids: tuple
    knowledge_version: str
    # the policy's action over all MAX_SLOTS slots, exactly as passed to env.step()
    action: tuple
    allocations: tuple
    # totals (env.step() info, plus the Stage 1F amount-based figure)
    requested_usd: float
    executed_usd: float
    unrouted_env_usd: float
    unrouted_amount_based_usd: float
    completion_ratio: float
    completed: bool
    bridges_used: int
    # metrics (env.step() reward_components, unchanged, plus amount-based reward)
    fee_cost_usd: float
    baseline_cost_pct: float
    cost_term: float
    latency_term: float
    risk_term: float
    unrouted_term_env: float
    unrouted_term_amount_based: float
    reward_env: float
    reward_amount_based: float
    reward_weights: dict
    # diagnostics
    regime: str
    combined_liquidity_usd: float
    projection_applied: bool
    # provenance
    state_mode: str
    state_date: str
    split: str
    scenario_id: Optional[str]
    values_provenance: str
    state_frame_sha256: str
    daily_state_sha256: str
    warnings: tuple
