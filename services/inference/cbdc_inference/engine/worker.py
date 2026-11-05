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

from .. import ENGINE_VERSION
from ..hashing import (UnsafeNumberError, binary64, compute_decision_id, daily_state_fingerprint,
                       scenarios_sha256, sha256_binary_file, sha256_text_file)
from .errors import (DateInGapBuffer, DateOutOfRange, EngineIntegrityError, EngineNotReady, InvalidAmount,
                     PolicyDisabled, PolicyUnavailableForState, StateVenueMismatch, UnknownScenario,
                     UnsupportedCorridor, ValidationFailed)
from .state import HISTORY_DAYS, state_to_hashable, validate_explicit_values
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
# The five file-backed `decision_id` artefacts (§2.11). The sixth, daily_state_sha256,
# is the fingerprint of the loaded frame, not of the parquet bytes.
# Text artefacts are hashed after CRLF->LF; binaries as they are.
TEXT_ARTEFACTS = {
    "knowledge_sha256": "data/knowledge/regulatory_facts.json",
    "bridge_network_sha256": "data/structured/bridge_network.csv",
    "normalization_stats_sha256": "data/processed/normalization_stats.json",
}
BINARY_ARTEFACTS = {
    "macro_risk_proxy_sha256": "data/processed/macro_risk_proxy.parquet",
    "rpw_corridor_quarterly_sha256": "data/processed/rpw_corridor_quarterly.parquet",
}
# Stage 1D train split: the source of the STATE_OUTSIDE_TRAINING_RANGE bounds (§2.4).
TRAIN_TRANSACTIONS_FILE = "data/processed/stage1d_transactions_train.csv"
MAX_SCENARIO_FRAMES = 6
PPO_DISABLED_MESSAGE = "ppo_projected is disabled: no approved checkpoint configured."
# §2.9: the mandatory caveat on every comparison. A single transaction under placeholder
# weights is not evidence that one policy is better (docs/STAGE1F_RESULTS.md).
COMPARE_NOTE = ("Single-transaction comparison under placeholder reward weights. Not evidence that one policy "
                "is better; see docs/STAGE1F_RESULTS.md.")
# Warning messages, shared so /v1/route, /v1/compare and /v1/state word them identically (§2.5, §2.8).
RISK_FALLBACK_MESSAGE = ("The corridor risk proxy is unavailable for this date, so the static placeholder 0.0 "
                         "is used.")
COST_BASELINE_FALLBACK_MESSAGE = "No lagged RPW cost baseline for this quarter; reward default used."
SYNTHETIC_COST_ANCHOR_MESSAGE = ("ARE->MEX has no real RPW anchor; the documented USA->MEX fallback is used.")
# §2.8 allocation invariant: the tolerance for requested_usd == sum of per-venue requests.
ALLOCATION_ABS_TOL = 1e-6
# §2.8 `bridges_used` counts shares above 1e-6: Phase 1's MEANINGFUL_ALLOCATION_THRESHOLD in
# src/training/metrics.py. The worker asserts the two still agree at start-up, because a change
# to this imported Phase 1 constant must bump ENGINE_VERSION (§2.2).
MEANINGFUL_SHARE = 1e-6


def frame_fingerprint(df) -> str:
    """The contract's scheme-1 daily-state fingerprint (§2.11), used for both
    `daily_state_sha256` and `state_frame_sha256`."""
    return daily_state_fingerprint(df)


def _import_phase1(repo_root: Path) -> SimpleNamespace:
    root = str(repo_root)
    if root not in sys.path:
        sys.path.insert(0, root)
    m = importlib.import_module
    return SimpleNamespace(
        pd=m("pandas"),
        np=m("numpy"),
        torch=m("torch"),
        obs_wrapper=m("src.envs.stage1d_raw_obs_wrapper"),
        ppo_model=m("src.models.ppo_actor_critic"),
        projection=m("src.training.capacity_projection"),
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
    def __init__(self, repo_root, checkpoint=None, device: str = "cpu"):
        """`checkpoint`: the approved entry the gate resolved (contract §7), or None.
        The worker re-verifies its SHA-256 itself before trusting it.
        `device`: CBDC_DEVICE. PPO values may differ in the last floating-point digits
        between cpu and cuda, which is why `provenance.device` is reported (§1)."""
        repo_root = Path(repo_root).expanduser().resolve()
        self.device = device
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
        if float(p.metrics.MEANINGFUL_ALLOCATION_THRESHOLD) != MEANINGFUL_SHARE:
            # Fail closed: an imported Phase 1 constant that affects outputs changed, so
            # ENGINE_VERSION must be bumped before this engine serves anything (§2.2).
            raise EngineNotReady(
                "Phase 1's MEANINGFUL_ALLOCATION_THRESHOLD no longer matches the engine's; "
                "ENGINE_VERSION must be bumped (contract §2.2)")
        self.daily_state_sha256 = frame_fingerprint(self.baseline_frame)
        self._scenario_frames: dict = {}
        self.healthy = True
        self.tasks_run = 0

        # The six decision_id artefact fingerprints (§2.11). daily_state_sha256 is the
        # frame fingerprint; the rest are file hashes with the text/binary rule.
        self.artefacts = {"daily_state_sha256": self.daily_state_sha256}
        for key, rel in TEXT_ARTEFACTS.items():
            self.artefacts[key] = sha256_text_file(repo_root / rel)
        for key, rel in BINARY_ARTEFACTS.items():
            self.artefacts[key] = sha256_binary_file(repo_root / rel)

        self.reward_weights = {
            "lambda_latency": float(p.reward.DEFAULT_LAMBDA_LATENCY_PLACEHOLDER),
            "lambda_risk": float(p.reward.DEFAULT_LAMBDA_RISK_PLACEHOLDER),
            "lambda_unrouted": float(p.reward.DEFAULT_LAMBDA_UNROUTED_PLACEHOLDER),
            "status": "placeholder",
        }
        # Per-venue training-window bounds for STATE_OUTSIDE_TRAINING_RANGE (§2.4).
        self._training_bounds = self._compute_training_bounds()
        # ppo_projected is served only with an approved checkpoint whose hash this worker
        # re-verified (§7). The projection is applied at inference (Stage 1D/1F finding).
        self.checkpoint = self._verify_checkpoint(checkpoint)
        self.ppo_enabled = self.checkpoint is not None
        self._ppo_policy = None  # loaded lazily on the first ppo_projected task

    # ------------------------------------------------------------------ setup helpers
    def _compute_training_bounds(self) -> dict:
        """Per-venue liquidity and congestion min-max bounds for STATE_OUTSIDE_TRAINING_RANGE (§2.4).

        Taken over the **union of the actual 30-day windows of all training transactions**, so
        they cover the days the model actually saw -- not the min-max over the whole train-split
        calendar. Returns {parquet_bridge_id: {"liquidity": (lo, hi), "congestion": (lo, hi)}}.

        If the Stage 1D train split is absent, the bounds are unknown and the warning is never
        emitted. It is a warning only, so an empty mapping never blocks routing.
        """
        pd = self._p.pd
        path = self.repo_root / TRAIN_TRANSACTIONS_FILE
        if not path.is_file():
            return {}
        dates = pd.to_datetime(pd.read_csv(path)["simulation_date"]).unique()
        window = set()
        for end in pd.DatetimeIndex(dates):
            window.update(pd.date_range(end - pd.Timedelta(days=HISTORY_DAYS - 1), end, freq="D"))
        frame = self.baseline_frame
        seen = frame[frame["date"].isin(window)]
        bounds = {}
        for bridge_id, rows in seen.groupby("bridge_id", sort=False):
            bounds[bridge_id] = {
                "liquidity": (float(rows["liquidity_level"].min()), float(rows["liquidity_level"].max())),
                "congestion": (float(rows["congestion_level"].min()), float(rows["congestion_level"].max())),
            }
        return bounds

    def _verify_checkpoint(self, checkpoint):
        """Each worker re-verifies the approved checkpoint's hash itself (§7). Any problem
        disables ppo_projected rather than serving unverified weights (fail closed)."""
        if checkpoint is None:
            return None
        path = self.repo_root / checkpoint.path
        try:
            actual = sha256_binary_file(path)
        except OSError:
            return None
        return checkpoint if actual == checkpoint.sha256 else None

    # ------------------------------------------------------------------ decision_id (§2.11)
    def decision_id(self, policy: str, sender: str, receiver: str, amount: float, state) -> str:
        """`decision_id` for ONE policy, over this decision's **inputs** (§2.11, A-1).

        Built from the already-validated, normalised request, so the values hashed are exactly
        the ones executed with. `engine_version`, the six artefact fingerprints, the scenario
        multipliers and the reward weights are included; `client_reference`, `git_commit`,
        `api_version`, the scenario `description`, the reward-weight `status` and every output
        field are excluded. In `/v1/compare` each result is hashed for its own policy, never
        over the `policies` list, so a compare entry's ID equals the `/v1/route` ID (A-9).
        """
        scenario = None
        if isinstance(state, ScenarioState):
            definition = self._p.scenarios.SCENARIOS.get(state.scenario_id)
            if definition is None:
                raise UnknownScenario(f"scenario_id {state.scenario_id!r} is not defined",
                                      {"field": "state.scenario_id"})
            scenario = {"scenario_id": definition.name,
                        "liquidity_multiplier": float(definition.liquidity_multiplier),
                        "congestion_multiplier": float(definition.congestion_multiplier),
                        "cheapest_venue_liquidity_multiplier":
                            float(definition.cheapest_venue_liquidity_multiplier)}
        return compute_decision_id({
            "engine_version": ENGINE_VERSION,
            "reward_weights": self.reward_weights,
            "artefacts": self.artefacts,
            "scenario": scenario,
            # Only ppo_projected hashes a checkpoint, so a checkpoint change never changes a
            # baseline ID. A ppo_projected request with no enabled checkpoint never reaches here.
            "checkpoint_sha256": self.checkpoint.sha256 if self.checkpoint is not None else None,
            "policy": policy,
            "request": {
                "transaction": {"sender_country": sender, "receiver_country": receiver,
                                "amount_usd": binary64(amount, "transaction.amount_usd")},
                "state": state_to_hashable(state),
            },
        })

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
        try:
            # §2.11: an integer-valued number outside +/-(2^53 - 1) is rejected, never rounded.
            # The API layer checks this too, over the whole body; this keeps the engine safe when
            # it is called directly, so hashing can never fail after execution has started.
            amount = binary64(amount, "transaction.amount_usd")
        except UnsafeNumberError as exc:
            raise ValidationFailed(
                "Integer-valued numbers outside the safe range (absolute value above 2^53 - 1) are rejected, "
                "never rounded.", {"field": exc.field}) from None
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
    def _validate_request(self, transaction: Transaction, state):
        """The validation every endpoint shares: transaction, corridor, explicit venues and date.

        It is policy-independent, so `/v1/compare` can run it once and then decide per policy
        which results to produce and which to put in `skipped`.
        """
        if not self.healthy:
            raise EngineNotReady("engine worker is unhealthy and must be rebuilt")
        (sender, receiver), amount = self._validate_transaction(transaction)
        if isinstance(state, ExplicitState):
            state = self._validate_explicit_venues(state, sender, receiver)
            date_str, split = self._validate_date(state.reference_date, "state.reference_date")
        elif isinstance(state, (ReplayState, ScenarioState)):
            date_str, split = self._validate_date(state.date, "state.date")
        else:
            raise ValidationFailed("state.mode must be historical_replay, scenario or explicit",
                                   {"field": "state.mode"})
        return (sender, receiver), amount, state, date_str, split

    def _finish(self, result: dict, policy, sender, receiver, amount, state, date_str, split,
                scenario_id, values_provenance, frame_sha) -> RouteResult:
        """Wraps one policy's execution output as a RouteResult, with its own `decision_id`."""
        return RouteResult(
            decision_id=self.decision_id(policy, sender, receiver, amount, state),
            **result, state_mode=state.mode, state_date=date_str, split=split,
            scenario_id=scenario_id, values_provenance=values_provenance,
            state_frame_sha256=frame_sha, daily_state_sha256=self.daily_state_sha256,
            checkpoint_sha256=self.checkpoint.sha256 if (policy == "ppo_projected" and self.checkpoint) else None)

    def route(self, transaction: Transaction, state, policy: Optional[str] = DEFAULT_POLICY) -> RouteResult:
        policy = self._validate_policy(policy)
        (sender, receiver), amount, state, date_str, split = self._validate_request(transaction, state)
        self._check_policy_for_state(policy, state)
        frame, frame_sha, scenario_id, values_provenance = self._frame_for(state)

        try:
            with self._p.scenarios.injected_daily_state(frame):
                result = self._route_on_installed_state(policy, transaction, sender, receiver, amount, date_str,
                                                        frame, split)
        finally:
            self.tasks_run += 1
            self.check_integrity()
        return self._finish(result, policy, sender, receiver, amount, state, date_str, split, scenario_id,
                            values_provenance, frame_sha)

    def compare(self, transaction: Transaction, state, policies=None) -> dict:
        """`POST /v1/compare` (§2.9): several policies on ONE request-scoped state frame.

        Every policy runs in this one engine task, inside a single `injected_daily_state` block,
        so `same_state` is guaranteed and every result carries the same `state_frame_sha256`.
        A policy that is disabled or unavailable for the state goes into `skipped` and does not
        fail the request. Each result's `decision_id` is computed for its own policy, so it
        equals the `/v1/route` ID for the same transaction, state and policy (§2.9, A-9).
        """
        (sender, receiver), amount, state, date_str, split = self._validate_request(transaction, state)
        if policies is None:
            requested = [p for p in POLICIES if p != "ppo_projected" or self.ppo_enabled]
        else:
            requested = list(policies)
            for i, name in enumerate(requested):
                if not isinstance(name, str) or name not in POLICIES:
                    raise ValidationFailed(f"unsupported policy {name!r}", {"field": f"policies[{i}]"})
            seen = set()
            requested = [p for p in requested if not (p in seen or seen.add(p))]
        frame, frame_sha, scenario_id, values_provenance = self._frame_for(state)

        results, skipped = [], []
        try:
            with self._p.scenarios.injected_daily_state(frame):
                for policy in requested:
                    try:
                        self._validate_policy(policy)
                        self._check_policy_for_state(policy, state)
                    except (PolicyDisabled, PolicyUnavailableForState) as exc:
                        skipped.append({"policy": policy, "code": exc.code, "message": exc.message})
                        continue
                    result = self._route_on_installed_state(policy, transaction, sender, receiver, amount,
                                                            date_str, frame, split)
                    results.append(self._finish(result, policy, sender, receiver, amount, state, date_str, split,
                                                scenario_id, values_provenance, frame_sha))
        finally:
            self.tasks_run += 1
            self.check_integrity()
        return {"results": tuple(results), "skipped": tuple(skipped), "same_state": True, "note": COMPARE_NOTE}

    # ------------------------------------------------------------------ ppo_projected
    def _load_ppo(self):
        """Loads the approved checkpoint once per worker, re-verifying its SHA-256 first (§7).

        Only the *projected* policy is ever served: Stage 1F found the trained policy barely
        responds to liquidity on its own, and the capacity projection is what makes it
        capacity-aware (`docs/STAGE1F_RESULTS.md`). Raw PPO is never exposed.
        """
        if self._ppo_policy is not None:
            return self._ppo_policy
        if self.checkpoint is None:
            raise PolicyDisabled(PPO_DISABLED_MESSAGE, {"field": "policy"})
        path = self.repo_root / self.checkpoint.path
        if sha256_binary_file(path) != self.checkpoint.sha256:
            # Fail closed: never serve weights whose hash does not match the registry.
            raise PolicyDisabled("approved checkpoint SHA-256 mismatch", {"field": "policy"})
        p = self._p
        net = p.ppo_model.PPOActorCritic().to(self.device)
        net.load_state_dict(p.torch.load(path, map_location=self.device, weights_only=True))
        net.eval()
        self._ppo_policy = net
        return net

    def _ppo_action(self, env, req, mask, bridges, amount, sender, receiver, simulation_date, frame):
        """The Stage 1F `ppo_projected` action: a deterministic PPO action, then the
        inference-time capped-simplex projection onto the current liquidity.

        It follows `src/backtesting/evaluation.py` exactly -- the same observation wrapper with
        `_daily_df` pinned to the request-scoped frame (so the CNN windows see the same state
        execution does), the same `deterministic=True` action and the same
        `project_capped_simplex` caps. Returns (projected_action, raw_action).
        """
        p, np = self._p, self._p.np
        net = self._load_ppo()
        wrapped = p.obs_wrapper.Stage1DRawObservationWrapper(env)
        wrapped._daily_df = frame  # CNN windows read the request-scoped state, as Stage 1F does
        obs = wrapped._wrap_obs(env._get_observation(req))
        rf = p.torch.tensor(np.stack([obs["raw_features"]]), dtype=p.torch.float32).to(self.device)
        wn = p.torch.tensor(np.stack([obs["windows"]]), dtype=p.torch.float32).to(self.device)
        mk = p.torch.tensor(np.stack([mask]), dtype=p.torch.bool).to(self.device)
        with p.torch.no_grad():
            raw = net.act(rf, wn, mk, deterministic=True)[0].cpu().numpy()[0]
        caps = np.zeros(len(mask))
        for j, b in enumerate(bridges):
            caps[j] = env._resolve_dynamic_state(b, sender, receiver, simulation_date)[0] / amount
        return p.projection.project_capped_simplex(raw, caps, mask), raw

    def _route_on_installed_state(self, policy, tx, sender, receiver, amount, date_str, frame,
                                  split=None) -> dict:
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
        raw_action = None
        if policy == "cheapest_feasible":
            action = p.baselines.cheapest_feasible_action(bridges, mask)
        elif policy == "ppo_projected":
            action, raw_action = self._ppo_action(env, req, mask, bridges, amount, sender, receiver,
                                                  simulation_date, frame)
        else:
            action = p.baselines.liquidity_aware_waterfall_action(bridges, mask, amount, simulation_date)
        env.current_step = 0
        _, reward, _, _, info = env.step(action)
        rc = info["reward_components"]

        # --- per-venue breakdown: same lookup and min(requested, liquidity) rule as env.step() ---
        # `allocations` has one entry per FEASIBLE venue, sorted by slot. Infeasible venues and
        # padding slots never appear in it (§2.8).
        allocations, executed_sum, fee_cost_usd = [], 0.0, 0.0
        action64 = [float(a) for a in action]
        for i, b in enumerate(bridges):
            liquidity, congestion, risk = env._resolve_dynamic_state(b, sender, receiver, simulation_date)
            requested = action64[i] * amount
            executed = min(requested, liquidity)
            executed_sum += executed
            fee_pct = float(b["fee"])
            # §2.8: fee_cost_usd = sum(executed x fee_pct). Executed amounts only, never
            # requested or clipped ones, with fee_pct as the bridge network defines it.
            fee_cost_usd += executed * fee_pct
            allocations.append(Allocation(
                slot=i, bridge_uid=b["bridge_id"], data_source_tag=b.get("data_source_tag"), fee_pct=fee_pct,
                liquidity_usd=float(liquidity), congestion=float(congestion), risk=float(risk),
                share_requested=action64[i], amount_requested_usd=requested, amount_executed_usd=executed,
                amount_clipped_usd=requested - executed,
                # The raw PPO share for ppo_projected; null for every other policy (§2.8).
                share_before_projection=None if raw_action is None else float(raw_action[i])))
        if executed_sum != info["executed_total"]:
            raise EngineIntegrityError("per-venue breakdown disagrees with CBDCLiquidityEnv.step()",
                                       {"breakdown": executed_sum, "env": info["executed_total"]})
        self._check_allocation_invariant(action64, allocations, float(info["requested_total"]), mask)

        executed_total = float(info["executed_total"])
        amount_unrouted = max(amount - executed_total, 0.0)  # Stage 1F amount-based figure (D7)
        completed = bool(p.metrics.is_completed(amount_unrouted, amount))
        lam_l = p.reward.DEFAULT_LAMBDA_LATENCY_PLACEHOLDER
        lam_r = p.reward.DEFAULT_LAMBDA_RISK_PLACEHOLDER
        lam_u = p.reward.DEFAULT_LAMBDA_UNROUTED_PLACEHOLDER
        reward_amount_based = rc["cost_term"] - lam_l * rc["latency_term"] - lam_r * rc["risk_term"] \
            - lam_u * amount_unrouted / amount

        # --- context the env uses silently; looked up again only to label it ---
        rejected = rejection is not None
        warnings = []
        looked_up = p.cost_baseline.lagged_real_cost_baseline_pct(sender, receiver, simulation_date)
        baseline_cost_pct = looked_up if looked_up is not None else p.reward.DEFAULT_BASELINE_COST_PCT_PLACEHOLDER
        # A regulatory rejection does no risk lookup, so it never carries this warning.
        # A risk of 0.0 alone does not imply the fallback (§2.8, A-8).
        if not rejected and bridges and self._risk_fell_back(sender, receiver, simulation_date):
            warnings.append(EngineWarning("RISK_FALLBACK_USED", RISK_FALLBACK_MESSAGE))
        if looked_up is None:
            warnings.append(EngineWarning("COST_BASELINE_FALLBACK_USED", COST_BASELINE_FALLBACK_MESSAGE))
        if (sender, receiver) == ("ARE", "MEX"):
            warnings.append(EngineWarning("SYNTHETIC_COST_ANCHOR", SYNTHETIC_COST_ANCHOR_MESSAGE))
        # §2.8 / C14: PARTIAL_COMPLETION only when feasibility.allowed is true. A regulatory
        # rejection routed nothing by rule, not by shortage, so it never carries it.
        if not completed and not rejected:
            warnings.append(EngineWarning("PARTIAL_COMPLETION",
                                     f"Executed {100.0 * executed_total / amount:.1f}% of the amount; the rest is unrouted."))
        warnings += self._training_range_warnings(policy, bridges, frame, sender, receiver, simulation_date)
        if policy == "ppo_projected":
            # Always present for ppo_projected (§2.8).
            warnings.append(EngineWarning(
                "EXPERIMENTAL_POLICY",
                "ppo_projected is experimental. It is not shown to beat the waterfall baseline on reward, and "
                "it is capacity-aware only because of the inference-time projection; see docs/STAGE1F_RESULTS.md."))
            if split == "train":
                warnings.append(EngineWarning(
                    "DATE_IN_TRAINING_SPLIT",
                    "This date is in the training split, so the policy was trained on it; the result is not "
                    "out-of-sample."))

        feas = env.memory_layer.explain(sender, receiver, amount)
        combined = sum(p.dbs.get_dynamic_state(b["bridge_id"], simulation_date)[0] for b in self.corridors[(sender, receiver)])

        totals_and_metrics = dict(
            allocations=tuple(allocations),
            requested_usd=float(info["requested_total"]), executed_usd=executed_total,
            unrouted_env_usd=float(info["unrouted"]), unrouted_amount_based_usd=amount_unrouted,
            completion_ratio=executed_total / amount, completed=completed,
            bridges_used=int(p.metrics.bridges_used(action64)),
            fee_cost_usd=fee_cost_usd,
            cost_term=float(rc["cost_term"]), latency_term=float(rc["latency_term"]), risk_term=float(rc["risk_term"]),
            unrouted_term_env=float(rc["unrouted_term"]), unrouted_term_amount_based=amount_unrouted / amount,
            reward_env=float(reward), reward_amount_based=float(reward_amount_based),
        )
        if rejected:
            # §2.8 regulatory rejection. The two unrouted figures differ deliberately:
            # the env's is requested - executed (so 0, since nothing was requested), while the
            # amount-based one is the whole amount. `metrics` stays present and fully non-null.
            totals_and_metrics = dict(
                allocations=(),
                requested_usd=0.0, executed_usd=0.0,
                unrouted_env_usd=0.0, unrouted_amount_based_usd=amount,
                completion_ratio=0.0, completed=False,
                bridges_used=0,
                fee_cost_usd=0.0,
                cost_term=0.0, latency_term=0.0, risk_term=0.0,
                unrouted_term_env=0.0, unrouted_term_amount_based=1.0,
                reward_env=0.0, reward_amount_based=-lam_u,
            )

        return dict(
            policy=policy, policy_status=POLICY_STATUS[policy],
            sender_country=sender, receiver_country=receiver, corridor=f"{sender}->{receiver}",
            amount_usd=amount, simulation_date=date_str, client_reference=tx.client_reference,
            allowed=not rejected, reason=rejection, decisive_fact_ids=tuple(feas["decisive_fact_ids"]),
            knowledge_version=feas["knowledge_version"],
            action=tuple(action64),
            baseline_cost_pct=float(baseline_cost_pct),
            reward_weights=dict(self.reward_weights),
            regime=p.tx_gen.true_regime_for_row(sender, receiver, amount, simulation_date),
            combined_liquidity_usd=float(combined), projection_applied=raw_action is not None,
            warnings=tuple(warnings),
            **totals_and_metrics,
        )

    @staticmethod
    def _check_allocation_invariant(action, allocations, requested_total, mask) -> None:
        """§2.8 allocation invariant, checked **fail closed** before any result is returned.

        Two checks: `totals.requested_usd` equals the sum of the per-venue requested amounts,
        and no infeasible venue or padding slot carried a non-zero weight. Either failure
        returns `500 INTERNAL_ERROR` with no result -- a wrong allocation is never returned.
        """
        breakdown = sum(a.amount_requested_usd for a in allocations)
        if abs(breakdown - requested_total) > ALLOCATION_ABS_TOL:
            raise EngineIntegrityError("allocation invariant failed: requested_usd != sum of per-venue requests",
                                       {"requested_total": requested_total, "breakdown": breakdown})
        feasible = len(allocations)
        for i, weight in enumerate(action):
            allowed = i < feasible and bool(mask[i])
            if weight != 0.0 and not allowed:
                raise EngineIntegrityError(
                    "allocation invariant failed: an infeasible venue or padding slot carried weight",
                    {"slot": i, "weight": weight})

    def _training_range_warnings(self, policy, bridges, frame, sender, receiver, simulation_date) -> list:
        """STATE_OUTSIDE_TRAINING_RANGE (§2.4): a **warning only**, never an error, and it never
        blocks a baseline policy.

        The values checked are the effective ones the selected policy actually reads, from the
        request-scoped frame, so any scenario multiplier or explicit override is included: the
        current day for `waterfall` and `cheapest_feasible`, and the whole 30-day window for
        `ppo_projected`. It applies in all three state modes. `/v1/state` never emits it.
        """
        if not self._training_bounds:
            return []
        outside = []
        for b in bridges:
            bounds = self._training_bounds.get(self._p.dbs._parquet_bridge_id(b["bridge_id"]))
            if bounds is None:
                continue
            if policy == "ppo_projected":
                window = self._history(frame, b["bridge_id"], simulation_date)
                series = {"liquidity": window["liquidity_usd"], "congestion": window["congestion"]}
            else:
                liquidity, congestion, _risk = self.env._resolve_dynamic_state(
                    b, sender, receiver, simulation_date)
                series = {"liquidity": [float(liquidity)], "congestion": [float(congestion)]}
            if any(v < bounds[channel][0] or v > bounds[channel][1]
                   for channel, values in series.items() for v in values):
                outside.append(b["bridge_id"])
        if not outside:
            return []
        return [EngineWarning("STATE_OUTSIDE_TRAINING_RANGE",
                              "A value this policy reads is outside the venue's training-window bounds, so the "
                              "model is out of distribution here. Routing by a baseline policy is unaffected. "
                              f"Venues: {', '.join(sorted(set(outside)))}.")]

    def _risk_fell_back(self, sender, receiver, simulation_date) -> bool:
        """Mirrors the fallback condition in CBDCLiquidityEnv._resolve_dynamic_state."""
        try:
            risk = self._p.risk_proxy.corridor_risk_proxy(sender, receiver, simulation_date)
        except KeyError:
            return True
        return risk is None or (isinstance(risk, float) and risk != risk)


    # ------------------------------------------------------------------ explain (§2.10)
    def explain(self, transaction: Transaction, state, policy: Optional[str] = DEFAULT_POLICY) -> dict:
        """`POST /v1/explain` (§2.10): a structured explanation of one routing decision.

        The decision is recomputed deterministically from the same inputs, so the returned
        `decision_id` equals the one `/v1/route` gave (A-9). The explanation describes what the
        policy did; it never invents a causal reason for a learned policy's choice.
        `semantic_context` is reserved and **always null in v1** (C6), whatever
        `CBDC_ENABLE_COGNEE` is set to.
        """
        result = self.route(transaction, state, policy)
        facts = self.env.memory_layer.provider.knowledge.facts
        active = [{"fact_id": f.fact_id, "rule_type": f.rule_type, "value": f.value,
                   "provenance_tag": f.provenance_tag, "verified": bool(f.verified), "source": f.source}
                  for f in facts if f.rule_type == "max_single_transfer_usd"]
        return {
            "decision_id": result.decision_id,
            "policy": result.policy,
            "summary": self._summary(result),
            "feasibility": {"allowed": result.allowed, "reason": result.reason, "active_facts": active,
                            "provider": type(self.env.memory_layer.provider).__name__},
            "venue_explanations": self._venue_explanations(result),
            "policy_notes": self._policy_notes(result),
            # Reserved; its inner shape is undefined until a later version defines it (§2.10).
            "semantic_context": None,
            "limitations": self._limitations(result),
        }

    @staticmethod
    def _money(x: float) -> str:
        return f"${x:,.0f}"

    def _summary(self, r: RouteResult) -> str:
        if not r.allowed:
            return (f"Rejected before routing: {r.reason} Nothing was routed, so the full "
                    f"{self._money(r.amount_usd)} is unrouted.")
        used = [a for a in r.allocations if a.share_requested > MEANINGFUL_SHARE]
        pct = 100.0 * r.completion_ratio
        where = f"across {len(used)} venue{'s' if len(used) != 1 else ''}"
        how = {"waterfall": "in fee order, each filled up to its simulated liquidity",
               "cheapest_feasible": "on the fee-cheapest feasible venue, clipped at its simulated liquidity",
               "ppo_projected": "by the learned policy's shares after the capacity projection"}[r.policy]
        return f"Routed {pct:.0f}% of {self._money(r.amount_usd)} {where} {how}."

    def _venue_explanations(self, r: RouteResult) -> list:
        """`used`/`unused` per venue, with the §2.10 reason codes. For a regulatory rejection
        every venue is `unused` with `INFEASIBLE_REGULATORY`. Ordered in fill order for the
        waterfall and in slot order for the other policies."""
        if not r.allowed:
            return [{"bridge_uid": b["bridge_id"], "outcome": "unused", "reason_code": "INFEASIBLE_REGULATORY",
                     "text": f"Not considered: {r.reason}"}
                    for b in self.corridors[(r.sender_country, r.receiver_country)]]
        out = []
        if r.policy == "waterfall":
            # Fill order is cheapest fee first, which is the order the waterfall filled them in.
            ordered = sorted(r.allocations, key=lambda a: (a.fee_pct, a.slot))
            first_used = True
            for a in ordered:
                if a.share_requested <= MEANINGFUL_SHARE:
                    code = "NO_LIQUIDITY" if a.liquidity_usd <= 0.0 else "AMOUNT_EXHAUSTED"
                    text = ("Unused: it has no simulated liquidity on this date."
                            if code == "NO_LIQUIDITY"
                            else "Not needed: the amount was fully routed by cheaper venues.")
                    out.append({"bridge_uid": a.bridge_uid, "outcome": "unused", "reason_code": code, "text": text})
                    continue
                filled = a.amount_clipped_usd > 0.0 or a.amount_executed_usd >= a.liquidity_usd
                if first_used:
                    code = "CHEAPEST_FILLED_TO_LIQUIDITY" if filled else "FILLED_TO_LIQUIDITY"
                    lead = f"Lowest fee ({100 * a.fee_pct:.2f}%)."
                    first_used = False
                else:
                    code = "FILLED_TO_LIQUIDITY" if filled else "NEXT_CHEAPEST_REMAINDER"
                    lead = f"Next-lowest fee ({100 * a.fee_pct:.2f}%)."
                tail = (f"Filled to its simulated liquidity of {self._money(a.liquidity_usd)}." if filled
                        else f"Took {self._money(a.amount_executed_usd)}.")
                out.append({"bridge_uid": a.bridge_uid, "outcome": "used", "reason_code": code,
                            "text": f"{lead} {tail}"})
            return out
        cheapest = min((a.fee_pct for a in r.allocations), default=None)
        for a in r.allocations:
            if a.share_requested <= MEANINGFUL_SHARE:
                if r.policy == "cheapest_feasible":
                    code, text = "NOT_CHEAPEST", (f"Not selected: its fee ({100 * a.fee_pct:.2f}%) is above the "
                                                  f"cheapest feasible venue's.")
                else:
                    code, text = "PPO_SHARE", "The policy allocated no share to this venue."
                out.append({"bridge_uid": a.bridge_uid, "outcome": "unused", "reason_code": code, "text": text})
                continue
            if r.policy == "cheapest_feasible":
                if a.amount_clipped_usd > 0.0:
                    code = "CLIPPED_AT_LIQUIDITY"
                    text = (f"Cheapest feasible venue ({100 * a.fee_pct:.2f}%). Clipped at its simulated liquidity "
                            f"of {self._money(a.liquidity_usd)}; {self._money(a.amount_clipped_usd)} was not routed.")
                else:
                    code = "CHEAPEST_SELECTED"
                    text = (f"Cheapest feasible venue ({100 * a.fee_pct:.2f}%). Took the whole "
                            f"{self._money(a.amount_requested_usd)}.")
            else:
                before = a.share_before_projection
                if before is None or abs(before - a.share_requested) <= MEANINGFUL_SHARE:
                    code = "PPO_SHARE"
                    text = f"Learned share {a.share_requested:.4f}, unchanged by the capacity projection."
                else:
                    code = ("PROJECTION_REDUCED_TO_CAPACITY" if a.share_requested < before
                            else "PROJECTION_INCREASED")
                    direction = "reduced" if a.share_requested < before else "increased"
                    text = (f"Learned share {before:.4f}; the capacity projection {direction} it to "
                            f"{a.share_requested:.4f} against a simulated liquidity of "
                            f"{self._money(a.liquidity_usd)}.")
            out.append({"bridge_uid": a.bridge_uid, "outcome": "used", "reason_code": code, "text": text})
        return out

    def _policy_notes(self, r: RouteResult) -> list:
        """For `ppo_projected`, the notes must state that the shares come from a learned policy
        with no causal explanation, that the projection adjusted them, and each slot's change
        (§2.10). **No made-up causal reasons for PPO's choices.**"""
        if r.policy != "ppo_projected":
            return []
        notes = [
            "The shares come from a learned PPO policy. It gives no causal reason for its choices, and none is "
            "inferred here.",
            "An inference-time capped-simplex projection was applied to the policy's raw shares. It is a "
            "correction applied after the policy, not learned behaviour; Stage 1F found the trained policy "
            "barely responds to liquidity on its own (docs/STAGE1F_RESULTS.md).",
        ]
        for a in r.allocations:
            if a.share_before_projection is None:
                continue
            delta = a.share_requested - a.share_before_projection
            notes.append(f"slot {a.slot} ({a.bridge_uid}): {a.share_before_projection:.6f} -> "
                         f"{a.share_requested:.6f} ({delta:+.6f}) after the projection.")
        return notes

    def _limitations(self, r: RouteResult) -> list:
        limits = [
            "Bridge liquidity and congestion are synthetic simulation values.",
            "Reward weights are uncalibrated placeholders.",
            "The only regulatory fact is an assumed $500K cap, not a real regulation.",
            "Each transaction is independent; routing does not deplete liquidity for later transactions.",
        ]
        if r.state_mode == "explicit":
            limits.append("Liquidity and congestion were supplied by the caller; the corridor risk and the cost "
                          "baseline come from reference_date, not from the supplied values.")
        if r.state_mode == "scenario":
            limits.append("Scenario stress is a uniform multiplier from Stage 1F, not a calibrated historical shock.")
        return limits

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
            warnings.append({"code": "RISK_FALLBACK_USED", "message": RISK_FALLBACK_MESSAGE})
        looked_up = p.cost_baseline.lagged_real_cost_baseline_pct(sender, receiver, date_str)
        if looked_up is None:
            warnings.append({"code": "COST_BASELINE_FALLBACK_USED", "message": COST_BASELINE_FALLBACK_MESSAGE})
        if (sender, receiver) == ("ARE", "MEX"):
            warnings.append({"code": "SYNTHETIC_COST_ANCHOR", "message": SYNTHETIC_COST_ANCHOR_MESSAGE})
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
        """§2.7. `scenarios` is always sorted by `scenario_id` in ascending ordinal (code-point)
        order, whatever the order of the Phase 1 definitions or of the dict they pass through.
        That is the same order `scenarios_sha256` hashes (§2.2), so the hash is independent of
        insertion order. `scenario_id` values must be unique, or the sorted order -- and so the
        hash -- would not be well defined."""
        scenarios = [{"scenario_id": s.name, "description": s.description,
                      "liquidity_multiplier": float(s.liquidity_multiplier),
                      "congestion_multiplier": float(s.congestion_multiplier),
                      "cheapest_venue_liquidity_multiplier": float(s.cheapest_venue_liquidity_multiplier)}
                     for s in self._p.scenarios.SCENARIOS.values()]
        ids = [s["scenario_id"] for s in scenarios]
        if len(ids) != len(set(ids)):
            raise EngineIntegrityError("duplicate scenario_id in the service's scenario definitions",
                                       {"count": len(ids)})
        scenarios.sort(key=lambda s: s["scenario_id"])
        return {
            "scenarios": scenarios,
            "note": "Uniform multipliers from Stage 1F, applied to the whole series. Not calibrated historical shocks.",
        }

    def scenarios_fingerprint(self) -> str:
        """`data.scenarios_sha256` (§2.2): the SHA-256 of the RFC 8785 serialisation of the
        `scenarios` array, sorted by `scenario_id`. It is a cache key (§5) and does **not**
        enter `decision_id`, because the scenario fields that affect a decision are hashed
        directly (§2.11)."""
        return scenarios_sha256(self.scenario_list()["scenarios"])


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
