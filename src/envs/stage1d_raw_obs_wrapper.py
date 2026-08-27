"""Stage 1D - raw observation pathway for end-to-end CNN+PPO training.

Unlike Stage1CObservationWrapper (frozen, precomputes 384-dim CNN
embeddings via a numpy forward pass - preserved unmodified as a reference/
ablation path), this wrapper emits the RAW per-corridor 30-day windows so
a trainable CNN living inside the policy network (see
models/ppo_actor_critic.py) can process them with gradients flowing back.

Output per transaction (a dict, not a single flat vector - the policy
network is responsible for slicing/reshaping):
    "raw_features": (31,) float32   [amount + 6 slots x (capacity, fee, congestion, risk, mask)]
    "windows":      (6, 2, 30) float32  normalized liquidity/congestion windows, one per slot
                                          (zeros for padded slots 3-5, per Stage 1C's convention)

Reuses stage1c_windowing.build_window() directly (not duplicated) for the
actual windowing math, and the SAME frozen normalization stats. This
module only differs from Stage 1C in WHAT it hands back (raw windows
instead of precomputed embeddings) and in resolving the corridor's 3
distinct venue bridge_uids instead of Stage 1C's fixed 3-corridor slot
map.
"""
import numpy as np
import pandas as pd
import gymnasium as gym
from gymnasium import spaces

from .cbdc_env import CBDCLiquidityEnv
from .dynamic_bridge_state import _parquet_bridge_id
from ..models.stage1c_windowing import (
    load_daily_series,
    load_normalization_stats,
    build_window,
    validate_simulation_date,
    SEQUENCE_LENGTH,
    MAX_SLOTS,
    NUM_CHANNELS,
)

RAW_FEATURES_PER_SLOT = 5
RAW_OBS_DIM = 1 + MAX_SLOTS * RAW_FEATURES_PER_SLOT  # 31, matches Stage 1A/1C


def _z(value, stats_entry):
    """Applies (value - mean) / std using a frozen stats dict entry.
    Returns 0.0 (not the raw value) if stats_entry is missing, since a
    silently-unnormalized feature would reintroduce the exact bug this
    correction fixes - better to fail loudly upstream (see
    normalize_raw_features) than silently pass raw scale through here."""
    return (float(value) - stats_entry["mean"]) / stats_entry["std"]


def normalize_raw_features(raw_obs, bridges, sender, receiver, stats):
    """Applies FROZEN train-only normalization to the 31-dim raw Stage 1A
    feature vector, per slot: [capacity, fee, congestion, risk, mask].
    amount (index 0) is normalized globally. mask bits (index 5 of each
    slot) are left EXACTLY 0/1, never normalized. Padded slots (all
    zeros in raw_obs) stay exactly zero after normalization is skipped
    for them (normalizing a padding zero would produce a nonzero,
    misleading value - padding must remain a clean 0 signal).

    Raises KeyError (loudly, not silently) if a required stats entry is
    missing for a populated slot's bridge_uid/corridor - this is a
    required-correction guarantee, not an optional best-effort pass.
    """
    from .dynamic_bridge_state import _parquet_bridge_id

    out = np.array(raw_obs, dtype=np.float32, copy=True)
    out[0] = _z(raw_obs[0], stats["amount"])

    corridor_key = f"{sender}->{receiver}"
    n_populated = len(bridges)

    for i in range(MAX_SLOTS):
        base = 1 + i * RAW_FEATURES_PER_SLOT
        is_populated = i < n_populated and raw_obs[base + 4] > 0.5  # mask bit
        if not is_populated:
            # padding slot: leave exactly zero (capacity/fee/congestion/
            # risk/mask all already 0.0 from _get_observation), do not
            # normalize a padding zero into a nonzero value.
            continue

        bridge_uid = bridges[i]["bridge_id"]
        parquet_id = _parquet_bridge_id(bridge_uid)

        out[base + 0] = _z(raw_obs[base + 0], stats["capacity"][bridge_uid])       # capacity
        out[base + 1] = _z(raw_obs[base + 1], stats["fee"])                        # fee (global)
        out[base + 2] = _z(raw_obs[base + 2], stats["congestion_level"][parquet_id])  # congestion
        out[base + 3] = _z(raw_obs[base + 3], stats["risk_proxy"][corridor_key])   # risk
        # out[base + 4] (mask) left exactly as-is: 0.0 or 1.0

    return out


class Stage1DRawObservationWrapper(gym.Wrapper):
    """Sibling to Stage1CObservationWrapper - does NOT rewrite it.

    Returns a dict observation {"raw_features": (31,), "windows": (6,2,30)}
    instead of a single flat vector, since the trainable CNN needs the
    windows in their un-flattened, un-embedded form.
    """

    def __init__(self, env: CBDCLiquidityEnv, daily_parquet_path=None, normalization_stats_path=None):
        super().__init__(env)
        if not isinstance(env.unwrapped, CBDCLiquidityEnv):
            raise TypeError("Stage1DRawObservationWrapper requires a CBDCLiquidityEnv (or wrapper thereof).")

        self._daily_df = load_daily_series(daily_parquet_path) if daily_parquet_path else load_daily_series()
        self._stats = (
            load_normalization_stats(normalization_stats_path)
            if normalization_stats_path
            else load_normalization_stats()
        )

        if "simulation_date" not in env.unwrapped.requests_df.columns:
            raise ValueError(
                "Stage1DRawObservationWrapper requires a 'simulation_date' column in the requests frame."
            )

        self.observation_space = spaces.Dict({
            "raw_features": spaces.Box(low=-1e9, high=1e9, shape=(RAW_OBS_DIM,), dtype=np.float32),
            "windows": spaces.Box(low=-1e9, high=1e9, shape=(MAX_SLOTS, NUM_CHANNELS, SEQUENCE_LENGTH), dtype=np.float32),
        })

    def _current_request(self):
        base_env = self.env.unwrapped
        step = min(base_env.current_step, base_env.max_steps - 1)
        return base_env.requests_df.iloc[step]

    def _wrap_obs(self, raw_obs):
        req = self._current_request()
        sender, receiver = req["sender_country"], req["receiver_country"]
        mask, bridges, _ = self.env.unwrapped.get_feasibility_mask(req)
        windows = self._build_windows_from(req, mask, bridges)
        normalized_raw = normalize_raw_features(raw_obs, bridges, sender, receiver, self._stats)
        return {"raw_features": normalized_raw.astype(np.float32), "windows": windows}

    def _build_windows_from(self, req, mask, bridges):
        sim_date = pd.Timestamp(req["simulation_date"])
        validate_simulation_date(sim_date)
        windows = np.zeros((MAX_SLOTS, NUM_CHANNELS, SEQUENCE_LENGTH), dtype=np.float32)
        for i, bridge in enumerate(bridges[:MAX_SLOTS]):
            bridge_uid = bridge["bridge_id"]
            parquet_id = _parquet_bridge_id(bridge_uid)
            windows[i] = build_window(self._daily_df, self._stats, parquet_id, sim_date)
        return windows

    def reset(self, **kwargs):
        obs, info = self.env.reset(**kwargs)
        return self._wrap_obs(obs), info

    def step(self, action):
        obs, reward, terminated, truncated, info = self.env.step(action)
        return self._wrap_obs(obs), reward, terminated, truncated, info
