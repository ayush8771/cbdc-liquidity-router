"""Engine worker: one process-local wrapper around the unchanged Phase 1 code (arch §5.1, §6.2).

An `EngineWorker` is meant to live inside an engine worker process (spawned by
the future EnginePool; `init_worker` / `run_route` are the pool entry points).
It can also be constructed in-process, as the tests do.

What it does, all with Phase 1 functions:
  * initialiser: chdir to the repo root, import Phase 1, eagerly warm every lazy
    cache (daily state, macro risk, RPW cost baselines, knowledge base), build one
    CBDCLiquidityEnv, keep the daily table as BASELINE_FRAME and fingerprint it;
  * route(): validate, pick the request-scoped state frame (replay = BASELINE_FRAME,
    scenario = Stage 1F perturb() copy), install it with Stage 1F
    injected_daily_state(), then run exactly the steps of
    src.training.evaluate.run_baseline on a one-row requests_df;
  * integrity guard after every task (fail closed).

No routing, execution or reward logic is reimplemented here.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import importlib
import math
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Optional

from .errors import (DateInGapBuffer, DateOutOfRange, EngineIntegrityError, EngineNotReady, InvalidAmount,
                     PolicyDisabled, UnknownScenario, UnsupportedCorridor, ValidationFailed)
from .types import (DEFAULT_POLICY, POLICIES, POLICY_STATUS, Allocation, ReplayState, RouteResult, ScenarioState,
                    Transaction, EngineWarning)

# Files read at inference (README "Data read at inference"). data/raw is not read.
REQUIRED_FILES = (
    "data/structured/countries.csv",
    "data/structured/bridge_network.csv",
    "data/structured/transaction_requests.csv",
    "data/processed/synthetic_liquidity_congestion_daily.parquet",
    "data/processed/normalization_stats.json",
    "data/processed/macro_risk_proxy.parquet",
    "data/processed/rpw_corridor_quarterly.parquet",
    "data/knowledge/regulatory_facts.json",
)
MAX_SCENARIO_FRAMES = 6
PPO_DISABLED_MESSAGE = "ppo_projected is disabled: no approved checkpoint configured."


def frame_fingerprint(df) -> str:
    """SHA-256 of pandas' per-row hash (arch §6.2 step 3)."""
    import pandas as pd
    return hashlib.sha256(pd.util.hash_pandas_object(df, index=True).values.tobytes()).hexdigest()


def _import_phase1(repo_root: Path) -> SimpleNamespace:
    root = str(repo_root)
    if root not in sys.path:
        sys.path.insert(0, root)
    m = importlib.import_module
    return SimpleNamespace(
        pd=m("pandas"),
        torch=m("torch"),
        env_mod=m("src.envs.cbdc_env"),
        dbs=m("src.envs.dynamic_bridge_state"),
        reward=m("src.envs.reward"),
        baselines=m("src.training.baselines"),
        metrics=m("src.training.metrics"),
        risk_proxy=m("src.training.risk_proxy"),
        cost_baseline=m("src.training.cost_baseline"),
        tx_gen=m("src.training.transaction_generator"),
        split=m("src.preprocessing.split"),
        scenarios=m("src.backtesting.scenarios"),
    )


class EngineWorker:
    def __init__(self, repo_root):
        repo_root = Path(repo_root).expanduser().resolve()
        missing = [f for f in REQUIRED_FILES if not (repo_root / f).is_file()]
        if missing:
            raise EngineNotReady(f"required Phase 1 artefacts missing under {repo_root}", {"missing": missing})
        os.chdir(repo_root)  # Phase 1 opens relative paths (arch §4.2)
        self.repo_root = repo_root
        p = self._p = _import_phase1(repo_root)
        p.torch.set_num_threads(1)

        # Eager warm-up removes lazy-initialisation races (arch §6.2 step 3).
        self.baseline_frame = p.dbs.load_daily_series()  # BASELINE_FRAME: the cache entry itself
        self._macro_risk = p.risk_proxy.load_macro_risk()
        self.env = p.env_mod.CBDCLiquidityEnv()  # reads structured CSVs + knowledge base
        self.corridors = {}
        for (s, r) in p.tx_gen.CORRIDORS:
            bridges = self.env.bridge_network.get_bridges_for_corridor(s, r)
            if bridges:
                self.corridors[(s, r)] = bridges
                p.cost_baseline.lagged_real_cost_baseline_pct(s, r, "2024-01-01")  # warms cost_baseline._cache
        self.knowledge = self.env.memory_layer.provider.knowledge
        self.daily_state_sha256 = frame_fingerprint(self.baseline_frame)
        self._scenario_frames: dict = {}
        self.healthy = True
        self.tasks_run = 0

    # ------------------------------------------------------------------ validation
    def _validate_policy(self, policy: Optional[str]) -> str:
        policy = DEFAULT_POLICY if policy is None else policy
        if policy not in POLICIES:
            raise ValidationFailed(f"unsupported policy {policy!r}", {"field": "policy"})
        if policy == "ppo_projected":
            # No checkpoint is approved and PPO is not wired into the engine yet (D2-D4).
            raise PolicyDisabled(PPO_DISABLED_MESSAGE, {"field": "policy"})
        return policy

    def _validate_transaction(self, tx: Transaction):
        amount = tx.amount_usd
        if isinstance(amount, bool) or not isinstance(amount, (int, float)):
            raise ValidationFailed("amount_usd must be a number", {"field": "transaction.amount_usd"})
        if not math.isfinite(amount) or amount <= 0:
            raise InvalidAmount("amount_usd must be > 0 and finite", {"field": "transaction.amount_usd"})
        key = (tx.sender_country, tx.receiver_country)
        if key not in self.corridors:
            raise UnsupportedCorridor(f"corridor {tx.sender_country}->{tx.receiver_country} is not in the network",
                                      {"field": "transaction"})
        return key, float(amount)

    def _validate_date(self, value, field_name: str):
        if not isinstance(value, str):
            raise ValidationFailed(f"{field_name} must be a YYYY-MM-DD string", {"field": field_name})
        try:
            d = _dt.date.fromisoformat(value)
        except ValueError:
            raise ValidationFailed(f"{field_name} must be a YYYY-MM-DD date", {"field": field_name}) from None
        ts = self._p.pd.Timestamp(d)
        split = self._p.split.assign_split(ts)  # C16: out-of-range vs gap buffer, Phase 1 split.py
        if split is None:
            raise DateOutOfRange(f"{field_name} {d} is outside 2011-01-01 to 2025-09-30.", {"field": field_name})
        if self._p.split.in_gap_buffer(ts):
            raise DateInGapBuffer(f"{field_name} {d} falls within the 30-day gap buffer of a split boundary.",
                                  {"field": field_name})
        return d.isoformat(), split

    # ------------------------------------------------------------------ state frames
    def _frame_for(self, state):
        if isinstance(state, ReplayState):
            return self.baseline_frame, self.daily_state_sha256, None, "synthetic_simulation"
        if isinstance(state, ScenarioState):
            scenario = self._p.scenarios.SCENARIOS.get(state.scenario_id)
            if scenario is None:
                raise UnknownScenario(f"scenario_id {state.scenario_id!r} is not defined", {"field": "state.scenario_id"})
            if state.scenario_id not in self._scenario_frames:
                if len(self._scenario_frames) >= MAX_SCENARIO_FRAMES:
                    self._scenario_frames.clear()
                frame = self._p.scenarios.perturb(self.baseline_frame, scenario)  # new frame; input untouched
                self._scenario_frames[state.scenario_id] = (frame, frame_fingerprint(frame))
            frame, sha = self._scenario_frames[state.scenario_id]
            return frame, sha, state.scenario_id, "synthetic_scenario"
        raise ValidationFailed("state must be historical_replay or scenario (explicit mode is not implemented yet)",
                               {"field": "state.mode"})

    # ------------------------------------------------------------------ integrity
    def check_integrity(self):
        """Arch §6.2 step 5. Raises EngineIntegrityError and marks the worker unhealthy."""
        dbs = self._p.dbs
        problems = []
        if dbs._daily_df_cache.get(dbs.DAILY_PARQUET_PATH) is not self.baseline_frame:
            problems.append("daily-state cache entry is not BASELINE_FRAME")
        if self._p.risk_proxy._macro_risk_cache.get(self._p.risk_proxy.MACRO_RISK_PARQUET_PATH) is not self._macro_risk:
            problems.append("macro-risk cache entry replaced")
        if not problems and frame_fingerprint(self.baseline_frame) != self.daily_state_sha256:
            problems.append("BASELINE_FRAME fingerprint changed")
        if problems:
            self.healthy = False
            raise EngineIntegrityError("engine integrity check failed; no result returned", {"problems": problems})

    # ------------------------------------------------------------------ route
    def route(self, transaction: Transaction, state, policy: Optional[str] = DEFAULT_POLICY) -> RouteResult:
        if not self.healthy:
            raise EngineNotReady("engine worker is unhealthy and must be rebuilt")
        policy = self._validate_policy(policy)
        (sender, receiver), amount = self._validate_transaction(transaction)
        if not isinstance(state, (ReplayState, ScenarioState)):
            raise ValidationFailed("state must be historical_replay or scenario (explicit mode is not implemented yet)",
                                   {"field": "state.mode"})
        date_str, split = self._validate_date(state.date, "state.date")
        frame, frame_sha, scenario_id, values_provenance = self._frame_for(state)

        try:
            with self._p.scenarios.injected_daily_state(frame):
                result = self._route_on_installed_state(policy, transaction, sender, receiver, amount, date_str)
        finally:
            self.tasks_run += 1
            self.check_integrity()
        return RouteResult(**result, state_mode=state.mode, state_date=date_str, split=split,
                           scenario_id=scenario_id, values_provenance=values_provenance,
                           state_frame_sha256=frame_sha, daily_state_sha256=self.daily_state_sha256)

    def _route_on_installed_state(self, policy, tx, sender, receiver, amount, date_str) -> dict:
        p, env = self._p, self.env
        # One-row requests_df, as src.training.evaluate._make_eval_env / run_baseline use it.
        env.requests_df = p.pd.DataFrame([{"transaction_id": 0, "sender_country": sender, "receiver_country": receiver,
                                           "amount_usd": amount, "simulation_date": date_str}])
        env.max_steps = 1

        # --- the run_baseline steps, unchanged ---
        env.current_step = 0
        req = env._current_request()
        amount = float(req["amount_usd"])
        simulation_date = req["simulation_date"]
        mask, bridges, rejection = env.get_feasibility_mask(req)
        if policy == "cheapest_feasible":
            action = p.baselines.cheapest_feasible_action(bridges, mask)
        else:
            action = p.baselines.liquidity_aware_waterfall_action(bridges, mask, amount, simulation_date)
        env.current_step = 0
        _, reward, _, _, info = env.step(action)
        rc = info["reward_components"]

        # --- per-venue breakdown: same lookup and min(requested, liquidity) rule as env.step() ---
        allocations, executed_sum = [], 0.0
        action64 = [float(a) for a in action]
        for i, b in enumerate(bridges):
            liquidity, congestion, risk = env._resolve_dynamic_state(b, sender, receiver, simulation_date)
            requested = action64[i] * amount
            executed = min(requested, liquidity)
            executed_sum += executed
            allocations.append(Allocation(
                slot=i, bridge_uid=b["bridge_id"], data_source_tag=b.get("data_source_tag"), fee_pct=float(b["fee"]),
                liquidity_usd=float(liquidity), congestion=float(congestion), risk=float(risk),
                share_requested=action64[i], amount_requested_usd=requested, amount_executed_usd=executed,
                amount_clipped_usd=requested - executed))
        if executed_sum != info["executed_total"]:
            raise EngineIntegrityError("per-venue breakdown disagrees with CBDCLiquidityEnv.step()",
                                       {"breakdown": executed_sum, "env": info["executed_total"]})

        executed_total = float(info["executed_total"])
        amount_unrouted = max(amount - executed_total, 0.0)  # Stage 1F amount-based figure (D7)
        completed = bool(p.metrics.is_completed(amount_unrouted, amount))
        lam_l = p.reward.DEFAULT_LAMBDA_LATENCY_PLACEHOLDER
        lam_r = p.reward.DEFAULT_LAMBDA_RISK_PLACEHOLDER
        lam_u = p.reward.DEFAULT_LAMBDA_UNROUTED_PLACEHOLDER
        reward_amount_based = rc["cost_term"] - lam_l * rc["latency_term"] - lam_r * rc["risk_term"] \
            - lam_u * amount_unrouted / amount

        # --- context the env uses silently; looked up again only to label it ---
        warnings = []
        looked_up = p.cost_baseline.lagged_real_cost_baseline_pct(sender, receiver, simulation_date)
        baseline_cost_pct = looked_up if looked_up is not None else p.reward.DEFAULT_BASELINE_COST_PCT_PLACEHOLDER
        if bridges and self._risk_fell_back(sender, receiver, simulation_date):
            warnings.append(EngineWarning("RISK_FALLBACK_USED", "Corridor risk proxy unavailable; static placeholder used."))
        if looked_up is None:
            warnings.append(EngineWarning("COST_BASELINE_FALLBACK_USED",
                                     "No lagged RPW cost baseline for this quarter; reward default used."))
        if (sender, receiver) == ("ARE", "MEX"):
            warnings.append(EngineWarning("SYNTHETIC_COST_ANCHOR",
                                     "ARE->MEX has no real RPW anchor; the documented USA->MEX fallback is used."))
        if not completed:  # literal contract §2.8 rule; C14 (rejections) is still open
            warnings.append(EngineWarning("PARTIAL_COMPLETION",
                                     f"Executed {100.0 * executed_total / amount:.1f}% of the amount; the rest is unrouted."))

        feas = env.memory_layer.explain(sender, receiver, amount)
        combined = sum(p.dbs.get_dynamic_state(b["bridge_id"], simulation_date)[0] for b in self.corridors[(sender, receiver)])

        return dict(
            policy=policy, policy_status=POLICY_STATUS[policy],
            sender_country=sender, receiver_country=receiver, corridor=f"{sender}->{receiver}",
            amount_usd=amount, simulation_date=date_str, client_reference=tx.client_reference,
            allowed=rejection is None, reason=rejection, decisive_fact_ids=tuple(feas["decisive_fact_ids"]),
            knowledge_version=feas["knowledge_version"],
            action=tuple(action64), allocations=tuple(allocations),
            requested_usd=float(info["requested_total"]), executed_usd=executed_total,
            unrouted_env_usd=float(info["unrouted"]), unrouted_amount_based_usd=amount_unrouted,
            completion_ratio=executed_total / amount, completed=completed,
            bridges_used=int(p.metrics.bridges_used(action64)),
            fee_cost_usd=float(rc["actual_fee_cost"]), baseline_cost_pct=float(baseline_cost_pct),
            cost_term=float(rc["cost_term"]), latency_term=float(rc["latency_term"]), risk_term=float(rc["risk_term"]),
            unrouted_term_env=float(rc["unrouted_term"]), unrouted_term_amount_based=amount_unrouted / amount,
            reward_env=float(reward), reward_amount_based=float(reward_amount_based),
            reward_weights={"lambda_latency": lam_l, "lambda_risk": lam_r, "lambda_unrouted": lam_u,
                            "status": "placeholder"},
            regime=p.tx_gen.true_regime_for_row(sender, receiver, amount, simulation_date),
            combined_liquidity_usd=float(combined), projection_applied=False,
            warnings=tuple(warnings),
        )

    def _risk_fell_back(self, sender, receiver, simulation_date) -> bool:
        """Mirrors the fallback condition in CBDCLiquidityEnv._resolve_dynamic_state."""
        try:
            risk = self._p.risk_proxy.corridor_risk_proxy(sender, receiver, simulation_date)
        except KeyError:
            return True
        return risk is None or (isinstance(risk, float) and risk != risk)


# ---------------------------------------------------------------------- pool entry points
_WORKER: Optional[EngineWorker] = None


def init_worker(repo_root) -> None:
    """ProcessPoolExecutor initializer (spawn context)."""
    global _WORKER
    _WORKER = EngineWorker(repo_root)


def run_route(transaction: Transaction, state, policy: Optional[str] = DEFAULT_POLICY) -> RouteResult:
    if _WORKER is None:
        raise EngineNotReady("engine worker not initialised")
    return _WORKER.route(transaction, state, policy)
