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
                     PolicyDisabled, PolicyUnavailableForState, StateVenueMismatch, UnknownScenario,
                     UnsupportedCorridor, ValidationFailed)
from .state import HISTORY_DAYS, validate_explicit_values
from .types import (DEFAULT_POLICY, POLICIES, POLICY_STATUS, Allocation, ExplicitState, ReplayState, RouteResult,
                    ScenarioState, Transaction, EngineWarning)

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
        # No checkpoint is approved and PPO is not wired into the engine yet (D2-D4).
        self.ppo_enabled = False

    # ------------------------------------------------------------------ validation
    def _validate_policy(self, policy: Optional[str]) -> str:
        policy = DEFAULT_POLICY if policy is None else policy
        if policy not in POLICIES:
            raise ValidationFailed(f"unsupported policy {policy!r}", {"field": "policy"})
        if policy == "ppo_projected" and not self.ppo_enabled:
            raise PolicyDisabled(PPO_DISABLED_MESSAGE, {"field": "policy"})
        return policy

    @staticmethod
    def _check_policy_for_state(policy: str, state) -> None:
        """ppo_projected needs 30-day history on every explicit venue: its CNN window would
        otherwise mix synthetic and replay values (§2.4, arch §9.1). Baselines read only the
        reference-date row, so they never need history."""
        if policy == "ppo_projected" and isinstance(state, ExplicitState) and not state.has_full_history:
            raise PolicyUnavailableForState("ppo_projected needs 30-day history on every venue in explicit mode",
                                            {"field": "state.venues"})

    def _validate_explicit_venues(self, state: ExplicitState, sender: str, receiver: str) -> ExplicitState:
        state = validate_explicit_values(state)
        expected = [b["bridge_id"] for b in self.corridors[(sender, receiver)]]
        given = [v.bridge_uid for v in state.venues]
        if len(given) != len(set(given)) or set(given) != set(expected):
            raise StateVenueMismatch("explicit venues must list exactly the corridor's venues, each once",
                                     {"field": "state.venues", "expected": expected, "given": given})
        return state

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
        if isinstance(state, ExplicitState):
            frame = self._explicit_frame(state)
            return frame, frame_fingerprint(frame), None, "user_supplied_synthetic"
        raise ValidationFailed("state.mode must be historical_replay, scenario or explicit", {"field": "state.mode"})

    def _explicit_frame(self, state: ExplicitState):
        """A request-scoped COPY of the baseline table with only the caller's venues
        overridden (arch §9.1): the reference-date row, plus the 29 preceding days when
        history is given. BASELINE_FRAME itself is never written. Fees, venue set, risk
        and the cost baseline are not in this table and stay Phase 1's."""
        pd, dbs = self._p.pd, self._p.dbs
        frame = self.baseline_frame.copy(deep=True)
        ref = pd.Timestamp(state.reference_date)
        dates = frame["date"].values
        bridge_ids = frame["bridge_id"].values
        liq_col = frame.columns.get_loc("liquidity_level")
        cong_col = frame.columns.get_loc("congestion_level")
        for v in state.venues:
            is_venue = bridge_ids == dbs._parquet_bridge_id(v.bridge_uid)  # Phase 1's uid -> parquet id mapping
            if v.history is None:
                rows = (is_venue & (dates == ref.to_datetime64())).nonzero()[0]
                liquidity, congestion = [v.liquidity_usd], [v.congestion]
            else:
                start = (ref - pd.Timedelta(days=HISTORY_DAYS - 1)).to_datetime64()
                rows = (is_venue & (dates >= start) & (dates <= ref.to_datetime64())).nonzero()[0]
                # history[0..28] for the preceding days, then the current value on the reference date
                liquidity = list(v.history.liquidity_usd[:-1]) + [v.liquidity_usd]
                congestion = list(v.history.congestion[:-1]) + [v.congestion]
            rows = rows[frame["date"].values[rows].argsort(kind="stable")]  # oldest first
            if len(rows) != len(liquidity):
                raise EngineIntegrityError("daily state has a gap where the explicit state is applied",
                                           {"bridge_uid": v.bridge_uid, "rows": int(len(rows))})
            frame.iloc[rows, liq_col] = liquidity
            frame.iloc[rows, cong_col] = congestion
        return frame

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
        if isinstance(state, ExplicitState):
            state = self._validate_explicit_venues(state, sender, receiver)
            date_str, split = self._validate_date(state.reference_date, "state.reference_date")
        elif isinstance(state, (ReplayState, ScenarioState)):
            date_str, split = self._validate_date(state.date, "state.date")
        else:
            raise ValidationFailed("state.mode must be historical_replay, scenario or explicit",
                                   {"field": "state.mode"})
        self._check_policy_for_state(policy, state)
        if policy == "ppo_projected":
            # reachable only if ppo_enabled is set; the PPO path itself is not implemented yet
            raise PolicyDisabled("ppo_projected is not implemented in this engine version", {"field": "policy"})
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


    # ------------------------------------------------------------------ reference data (§2.3, §2.5–2.7)
    def parse_corridor(self, corridor) -> tuple:
        if not isinstance(corridor, str) or corridor.count("->") != 1:
            raise ValidationFailed("corridor must look like 'GBR->PHL'", {"field": "corridor"})
        sender, receiver = corridor.split("->")
        if (sender, receiver) not in self.corridors:
            raise UnsupportedCorridor(f"corridor {corridor} is not in the network", {"field": "corridor"})
        return sender, receiver

    def network(self) -> dict:
        """Static corridor and venue metadata: bridge_network.csv and the knowledge base, unmodified."""
        caps = [f for f in self.knowledge.facts if f.rule_type == "max_single_transfer_usd"]
        enforced = self.env.memory_layer.constraints["max_single_transfer_usd"]  # what feasibility uses
        binding = min(caps, key=lambda f: (f.value, f.fact_id)) if caps else None
        corridors = []
        for (s, r), bridges in self.corridors.items():
            corridors.append({
                "corridor": f"{s}->{r}", "sender_country": s, "receiver_country": r,
                "venues": [{"slot": i, "bridge_uid": b["bridge_id"], "fee_pct": float(b["fee"]),
                            "baseline_capacity_usd": float(b["capacity"]), "data_source_tag": b.get("data_source_tag")}
                           for i, b in enumerate(bridges)],
            })
        return {"corridors": corridors, "max_single_transfer_usd": float(enforced),
                "max_single_transfer_provenance": binding.provenance_tag if binding else None}

    def state_view(self, corridor: str, state, include_history: bool = False) -> dict:
        """Bridge state for a corridor on a date, under replay or a scenario (§2.5)."""
        if not self.healthy:
            raise EngineNotReady("engine worker is unhealthy and must be rebuilt")
        sender, receiver = self.parse_corridor(corridor)
        if not isinstance(state, (ReplayState, ScenarioState)):
            raise ValidationFailed("mode must be historical_replay or scenario; explicit states are not looked up",
                                   {"field": "mode"})
        date_str, split = self._validate_date(state.date, "date")
        frame, _sha, scenario_id, values_provenance = self._frame_for(state)
        try:
            with self._p.scenarios.injected_daily_state(frame):
                body = self._state_on_installed_frame(frame, sender, receiver, date_str, values_provenance,
                                                      include_history)
        finally:
            self.tasks_run += 1
            self.check_integrity()
        body["state"] = {"mode": state.mode, "date": date_str, "split": split, "scenario_id": scenario_id}
        return body

    def _state_on_installed_frame(self, frame, sender, receiver, date_str, values_provenance, include_history):
        p, env = self._p, self.env
        bridges = self.corridors[(sender, receiver)]
        venues, risks = [], set()
        for i, b in enumerate(bridges):
            # the same lookup execution and reward use (CBDCLiquidityEnv._resolve_dynamic_state)
            liquidity, congestion, risk = env._resolve_dynamic_state(b, sender, receiver, date_str)
            risks.add(float(risk))
            venue = {"slot": i, "bridge_uid": b["bridge_id"], "fee_pct": float(b["fee"]),
                     "liquidity_usd": float(liquidity), "congestion": float(congestion),
                     "data_source_tag": b.get("data_source_tag"), "values_provenance": values_provenance}
            if include_history:
                venue["history"] = self._history(frame, b["bridge_id"], date_str)
            venues.append(venue)
        if len(risks) != 1:
            raise EngineIntegrityError("corridor risk differs across venues", {"risks": sorted(risks)})

        warnings = []
        if self._risk_fell_back(sender, receiver, date_str):
            warnings.append({"code": "RISK_FALLBACK_USED",
                             "message": "Corridor risk proxy unavailable; static placeholder used."})
        looked_up = p.cost_baseline.lagged_real_cost_baseline_pct(sender, receiver, date_str)
        if looked_up is None:
            warnings.append({"code": "COST_BASELINE_FALLBACK_USED",
                             "message": "No lagged RPW cost baseline for this quarter; reward default used."})
        if (sender, receiver) == ("ARE", "MEX"):
            warnings.append({"code": "SYNTHETIC_COST_ANCHOR",
                             "message": "ARE->MEX has no real RPW anchor; the documented USA->MEX fallback is used."})
        baseline_cost_pct = looked_up if looked_up is not None else p.reward.DEFAULT_BASELINE_COST_PCT_PLACEHOLDER
        return {"corridor": f"{sender}->{receiver}", "corridor_risk": risks.pop(),
                "baseline_cost_pct": float(baseline_cost_pct), "venues": venues, "warnings": warnings}

    def _history(self, frame, bridge_uid, date_str) -> dict:
        """30 raw daily values ending on the date, oldest first (§2.5), from the request's frame."""
        pd = self._p.pd
        end = pd.Timestamp(date_str)
        start = end - pd.Timedelta(days=29)
        pid = self._p.dbs._parquet_bridge_id(bridge_uid)  # Phase 1's uid -> parquet id mapping
        rows = frame[(frame["bridge_id"] == pid) & (frame["date"] >= start) & (frame["date"] <= end)] \
            .sort_values("date")
        if len(rows) != 30:
            raise EngineIntegrityError("daily state has a gap in the 30-day window",
                                       {"bridge_uid": bridge_uid, "rows": int(len(rows))})
        return {"dates": [d.date().isoformat() for d in rows["date"]],
                "liquidity_usd": [float(x) for x in rows["liquidity_level"]],
                "congestion": [float(x) for x in rows["congestion_level"]]}

    def replay_calendar(self) -> dict:
        """Valid dates and every range validate_simulation_date() rejects (§2.6), from Phase 1 split.py."""
        p = self._p
        bounds = p.split.SPLIT_BOUNDARIES
        start, end = min(b[0] for b in bounds.values()), max(b[1] for b in bounds.values())
        excluded, run_start, prev = [], None, None
        for day in p.pd.date_range(start, end, freq="D"):
            if p.split.in_gap_buffer(day):
                if run_start is None:
                    run_start = day
                prev = day
            elif run_start is not None:
                excluded.append({"start": run_start.date().isoformat(), "end": prev.date().isoformat()})
                run_start = None
        if run_start is not None:
            excluded.append({"start": run_start.date().isoformat(), "end": prev.date().isoformat()})
        return {
            "start": start.date().isoformat(), "end": end.date().isoformat(),
            "splits": {name: {"start": s.date().isoformat(), "end": e.date().isoformat()}
                       for name, (s, e) in bounds.items()},
            "gap_buffer_days": int(p.split.GAP_BUFFER_DAYS),
            "excluded_ranges": excluded,
            "note": "Synthetic daily bridge state. Not real CBDC telemetry. No data after 2025-09-30.",
        }

    def scenario_list(self) -> dict:
        return {
            "scenarios": [{"scenario_id": s.name, "description": s.description,
                           "liquidity_multiplier": float(s.liquidity_multiplier),
                           "congestion_multiplier": float(s.congestion_multiplier),
                           "cheapest_venue_liquidity_multiplier": float(s.cheapest_venue_liquidity_multiplier)}
                          for s in self._p.scenarios.SCENARIOS.values()],
            "note": "Uniform multipliers from Stage 1F, applied to the whole series. Not calibrated historical shocks.",
        }


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
