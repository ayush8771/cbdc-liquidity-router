import gymnasium as gym
from gymnasium import spaces
import pandas as pd
import numpy as np
import os
import logging

from .bridge_network import BridgeNetwork, MAX_BRIDGES
from .reward import compute_reward_components
from .dynamic_bridge_state import get_dynamic_state
from ..memory.cognee_layer import CogneeMemoryLayer
from ..training.risk_proxy import corridor_risk_proxy
from ..training.cost_baseline import lagged_real_cost_baseline_pct

logger = logging.getLogger(__name__)

# Per-bridge observation block: [capacity, fee, congestion, risk, feasibility_mask]
FEATURES_PER_BRIDGE_SLOT = 5


class CBDCLiquidityEnv(gym.Env):
    """
    Custom Gymnasium Environment for CBDC Cross-Border Liquidity Routing.

    STAGE 1A SCOPE NOTE: this environment implements the approved network
    foundation, requested-vs-executed allocation semantics, and reward
    mechanics with PLACEHOLDER inputs where Stage 1B/1C data does not yet
    exist (congestion, risk, real cost baseline - see bridge_network.py and
    reward.py for exact placeholder documentation). The observation is a
    pre-CNN, pre-corridor-encoding raw feature vector; it is NOT the final
    PPO observation schema from the approved specification, which requires
    Stage 1B derived features and the Stage 1C CNN embeddings. See
    "Remaining Stage 1A issues" in the implementation report for the exact
    gap.
    """

    metadata = {"render_modes": ["human"]}

    def __init__(
        self,
        structured_dir="data/structured",
        raw_dir="data/raw",
        traditional_cost_baseline_pct=None,
        lambda_latency=None,
        lambda_risk=None,
        lambda_unrouted=None,
        max_transfer_usd=None,
    ):
        super(CBDCLiquidityEnv, self).__init__()

        # --- Load structured data ---
        self.nodes_df = pd.read_csv(os.path.join(structured_dir, "countries.csv"))
        self.network_df = pd.read_csv(os.path.join(structured_dir, "bridge_network.csv"))
        self.requests_df = pd.read_csv(os.path.join(structured_dir, "transaction_requests.csv"))

        self.bridge_network = BridgeNetwork(
            bridge_csv=os.path.join(structured_dir, "bridge_network.csv"),
            countries_csv=os.path.join(structured_dir, "countries.csv"),
        )

        # Regulatory hard-filter layer (pre-existing stub, NOT real Cognee -
        # per instruction, Cognee itself is not integrated at this stage).
        self.memory_layer = CogneeMemoryLayer()
        if max_transfer_usd is not None:
            self.memory_layer.constraints["max_single_transfer_usd"] = max_transfer_usd

        # --- Reward configuration (all PLACEHOLDERS unless explicitly overridden) ---
        # None of these are calibrated/approved final values - see reward.py.
        self._reward_kwargs = {}
        if traditional_cost_baseline_pct is not None:
            self._reward_kwargs["baseline_cost_pct"] = traditional_cost_baseline_pct
        if lambda_latency is not None:
            self._reward_kwargs["lambda_latency"] = lambda_latency
        if lambda_risk is not None:
            self._reward_kwargs["lambda_risk"] = lambda_risk
        if lambda_unrouted is not None:
            self._reward_kwargs["lambda_unrouted"] = lambda_unrouted

        self.current_step = 0
        self.max_steps = len(self.requests_df)

        # --- Action space: requested allocation vector over MAX_BRIDGES slots ---
        # Per approved Action/Execution Semantics: this represents the
        # REQUESTED allocation (e.g. a Dirichlet sample from the policy,
        # not yet implemented - Stage 1D). Regulatory/existence masking is
        # expected to have been applied UPSTREAM (before sampling) by the
        # policy; this environment does not re-mask or renormalize the
        # action, since doing so would change what was sampled and could
        # invalidate the policy's log-probability. It defensively detects
        # and reports (but does not silently fix) any weight placed on an
        # infeasible slot - see step().
        self.action_space = spaces.Box(
            low=0.0, high=1.0, shape=(MAX_BRIDGES,), dtype=np.float32
        )

        # --- Observation space ---
        # [amount] + MAX_BRIDGES * [capacity, fee, congestion, risk, mask_bit]
        obs_dim = 1 + MAX_BRIDGES * FEATURES_PER_BRIDGE_SLOT
        self.observation_space = spaces.Box(
            low=0.0, high=1e9, shape=(obs_dim,), dtype=np.float32
        )

    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        self.current_step = 0

        obs = self._get_observation()
        info = self._get_info()
        return obs, info

    def _current_request(self):
        return self.requests_df.iloc[self.current_step]

    def get_feasibility_mask(self, req=None):
        """Returns (mask, bridges, rejection_reason).

        mask: boolean array of length MAX_BRIDGES. True = a real bridge
            exists in this slot AND the transaction passed the regulatory
            check. False slots have no bridge assigned (padding) or the
            whole transaction was regulatorily rejected.
        bridges: list of bridge dicts (len <= MAX_BRIDGES) corresponding to
            the True-masked slots, in slot order.
        rejection_reason: str or None - set if the regulatory check failed.
        """
        if req is None:
            req = self._current_request()

        sender = req["sender_country"]
        receiver = req["receiver_country"]
        amount = float(req["amount_usd"])

        mask = np.zeros(MAX_BRIDGES, dtype=bool)
        ok, reason = self.memory_layer.check_transaction(sender, receiver, amount)
        if not ok:
            # Whole transaction blocked - no feasible slots at all.
            return mask, [], reason

        bridges = self.bridge_network.get_bridges_for_corridor(sender, receiver)
        bridges = bridges[:MAX_BRIDGES]  # defensive cap, no-op today (<=1 bridge/corridor)
        for i in range(len(bridges)):
            mask[i] = True

        return mask, bridges, None

    def _resolve_dynamic_state(self, bridge, sender, receiver, simulation_date):
        """Stage 1D: given a bridge dict (static capacity/fee from
        bridge_network.csv) and a simulation_date, returns
        (capacity, congestion, risk) using the SAME dynamic-state lookup
        for both execution and reward - this is the one path that closes
        the audited "decorative CNN" gap. `baseline_capacity` in the
        bridge dict is static metadata/reference only once a
        simulation_date is available; it is NEVER used to clip execution
        in that case (per the approved Stage 1D clarification #1).

        If simulation_date is None (e.g. a caller/test using the original
        3-row fixture with no simulation_date column, or a raw
        Stage 1A/1C fixture), falls back EXACTLY to the bridge dict's
        static capacity/congestion/risk fields - zero behavior change for
        any existing Stage 1A/1B/1C test or usage.
        """
        if simulation_date is None:
            return bridge["capacity"], bridge["congestion"], bridge["risk"]

        liquidity, congestion = get_dynamic_state(bridge["bridge_id"], simulation_date)
        try:
            risk = corridor_risk_proxy(sender, receiver, simulation_date)
            if risk is None or (isinstance(risk, float) and risk != risk):  # NaN check, no numpy import needed
                risk = bridge["risk"]  # legitimate unconditioned_default month - fall back, don't propagate NaN
        except KeyError:
            risk = bridge["risk"]  # fallback to static placeholder if proxy unavailable for this date
        return liquidity, congestion, risk

    def _get_observation(self, req=None):
        if req is None:
            if self.current_step >= self.max_steps:
                return np.zeros(self.observation_space.shape, dtype=np.float32)
            req = self._current_request()

        amount = float(req["amount_usd"])
        mask, bridges, _ = self.get_feasibility_mask(req)
        simulation_date = req["simulation_date"] if "simulation_date" in req.index and pd.notna(req["simulation_date"]) else None
        sender = req["sender_country"]
        receiver = req["receiver_country"]

        obs = [amount]
        for i in range(MAX_BRIDGES):
            if i < len(bridges):
                b = bridges[i]
                capacity, congestion, risk = self._resolve_dynamic_state(b, sender, receiver, simulation_date)
                obs.extend([capacity, b["fee"], congestion, risk, 1.0])
            else:
                obs.extend([0.0, 0.0, 0.0, 0.0, 0.0])
        return np.array(obs, dtype=np.float32)

    def _get_info(self):
        return {"step": self.current_step, "total_requests": self.max_steps}

    def step(self, action):
        action = np.asarray(action, dtype=np.float64)
        req = self._current_request()
        amount = float(req["amount_usd"])
        simulation_date = req["simulation_date"] if "simulation_date" in req.index and pd.notna(req["simulation_date"]) else None
        sender = req["sender_country"]
        receiver = req["receiver_country"]

        mask, bridges, rejection_reason = self.get_feasibility_mask(req)

        executed = []
        fees = []
        congestion = []
        risk = []
        total_requested = 0.0
        total_executed = 0.0

        for i in range(MAX_BRIDGES):
            requested_i = float(action[i]) * amount
            total_requested += requested_i

            if mask[i]:
                bridge = bridges[i]
                capacity, congestion_i, risk_i = self._resolve_dynamic_state(bridge, sender, receiver, simulation_date)
                executed_i = min(requested_i, capacity)
                executed.append(executed_i)
                fees.append(bridge["fee"])
                congestion.append(congestion_i)
                risk.append(risk_i)
                total_executed += executed_i
            else:
                # Defensive path: per the approved contract, an upstream
                # policy should never place nonzero weight on an infeasible
                # slot (masking happens before sampling). If it does anyway
                # (e.g. because Stage 1D masking isn't wired in yet, or a
                # test is deliberately probing this), the requested amount
                # is treated as unrouted rather than executed, and NOT
                # silently dropped or redistributed to other bridges.
                if requested_i > 0:
                    logger.warning(
                        f"[CBDCLiquidityEnv] Action requested {requested_i:.2f} "
                        f"on infeasible slot {i}; treating as unrouted "
                        f"(reason={rejection_reason or 'no bridge in this slot'})."
                    )

        unrouted = total_requested - total_executed

        reward_kwargs = dict(self._reward_kwargs)
        if simulation_date is not None:
            # Stage 1D: wire the real, lagged RPW cost baseline in place
            # of the static placeholder, when we have a real corridor and
            # date to look it up for. Falls back to whatever
            # self._reward_kwargs/reward.py default already specifies if
            # unavailable for this quarter - never silently invents a
            # number, and never overrides an EXPLICIT user-supplied
            # baseline_cost_pct from __init__.
            if "baseline_cost_pct" not in self._reward_kwargs:
                looked_up = lagged_real_cost_baseline_pct(sender, receiver, simulation_date)
                if looked_up is not None:
                    reward_kwargs["baseline_cost_pct"] = looked_up

        reward_components = compute_reward_components(
            amount=amount,
            executed=executed,
            fees=fees,
            congestion=congestion,
            risk=risk,
            unrouted=unrouted,
            **reward_kwargs,
        )
        reward = reward_components["total"]

        self.current_step += 1
        terminated = self.current_step >= self.max_steps
        truncated = False

        obs = self._get_observation()
        info = self._get_info()
        info.update(
            {
                "requested_total": total_requested,
                "executed_total": total_executed,
                "unrouted": unrouted,
                "reward_components": reward_components,
                "rejection_reason": rejection_reason,
                # Stage 1D bookkeeping only (per approved semantics #3):
                # NOT a second execution phase, no cross-transaction
                # carryover. remaining = the dynamic liquidity this
                # episode's execution didn't use, for logging/eval only.
                "remaining_liquidity": [
                    max(cap - ex, 0.0) for cap, ex in zip(
                        [self._resolve_dynamic_state(b, sender, receiver, simulation_date)[0] for b in bridges],
                        executed,
                    )
                ] if bridges else [],
            }
        )

        return obs, reward, terminated, truncated, info