"""Stage 1C observation wrapper.

Wraps the unmodified CBDCLiquidityEnv (Stage 1A, frozen) and extends its
31-dim raw observation with the 384-dim Stage 1C CNN feature block,
producing a 415-dim combined observation:

    1  amount
  + 30  raw per-slot Stage 1A features (6 slots x 5)
  + 384  CNN feature block (6 slots x 64)
  ------
  = 415

This wrapper reads `simulation_date` from the current transaction request
(added to data/structured/transaction_requests.csv as an explicitly
synthetic simulation anchor - see the Stage 1C specification) and does not
alter cbdc_env.py, bridge_network.py, or reward.py in any way.

Macro-risk features are explicitly NOT included here (deferred to a later
stage per the approved Stage 1C scope).
"""
import numpy as np
import pandas as pd
import gymnasium as gym
from gymnasium import spaces

from .cbdc_env import CBDCLiquidityEnv
from ..models.stage1c_windowing import (
    load_daily_series,
    load_normalization_stats,
    compute_cnn_block,
    get_shared_cnn,
    validate_simulation_date,
    FEATURE_DIM,
    MAX_SLOTS,
)

CNN_BLOCK_DIM = MAX_SLOTS * FEATURE_DIM  # 384
STAGE1C_OBS_DIM = None  # set below once RAW_OBS_DIM is known from the wrapped env


class Stage1CObservationWrapper(gym.ObservationWrapper):
    """Extends CBDCLiquidityEnv's observation with the Stage 1C CNN block.

    Does not modify CBDCLiquidityEnv itself - this wrapper reads the
    transaction request's `simulation_date` field independently and
    concatenates the CNN block onto the raw observation returned by the
    wrapped env.
    """

    def __init__(self, env: CBDCLiquidityEnv, daily_parquet_path=None, normalization_stats_path=None):
        super().__init__(env)
        if not isinstance(env.unwrapped, CBDCLiquidityEnv):
            raise TypeError("Stage1CObservationWrapper requires a CBDCLiquidityEnv (or wrapper thereof).")

        self._daily_df = load_daily_series(daily_parquet_path) if daily_parquet_path else load_daily_series()
        self._stats = (
            load_normalization_stats(normalization_stats_path)
            if normalization_stats_path
            else load_normalization_stats()
        )
        self._cnn = get_shared_cnn()

        # transaction_requests.csv must have a simulation_date column -
        # verified here rather than assumed, so a missing column fails
        # loudly at construction time rather than silently at step time.
        if "simulation_date" not in env.unwrapped.requests_df.columns:
            raise ValueError(
                "Stage1CObservationWrapper requires a 'simulation_date' "
                "column in transaction_requests.csv; none was found."
            )

        raw_obs_dim = env.observation_space.shape[0]
        combined_dim = raw_obs_dim + CNN_BLOCK_DIM
        self.observation_space = spaces.Box(
            low=-1e9, high=1e9, shape=(combined_dim,), dtype=np.float32
        )

    def _current_simulation_date(self):
        base_env = self.env.unwrapped
        if base_env.current_step >= base_env.max_steps:
            # Terminal/reset-boundary observation - no request to anchor
            # a window to. Use the last valid request's date so a window
            # can still be constructed deterministically for the final
            # zero observation, rather than raising mid-episode.
            step = base_env.max_steps - 1
        else:
            step = base_env.current_step
        req = base_env.requests_df.iloc[step]
        simulation_date = pd.Timestamp(req["simulation_date"])
        # Transaction-assignment concern: enforced here, at the point a
        # simulation_date is actually used to anchor a real transaction's
        # observation - not inside the window-building mechanics.
        validate_simulation_date(simulation_date)
        return simulation_date

    def observation(self, observation):
        simulation_date = self._current_simulation_date()
        cnn_block = compute_cnn_block(self._daily_df, self._stats, simulation_date, cnn=self._cnn)
        return np.concatenate([observation.astype(np.float32), cnn_block.astype(np.float32)])
