"""Stage 1C - windowing, normalization application, and CNN embedding
assembly for the CBDC Liquidity Router.

Scope (per the approved Stage 1C specification):
    liquidity_level + congestion_level -> normalize -> 30-day window
    -> shared 1D CNN -> 64-dim embedding per populated bridge slot,
    zeros(64) for padded slots -> 384-dim CNN feature block.

Explicitly OUT of scope here (deferred to a later stage, per approval):
    macro-risk features, PPO/Stage 1D wiring, Cognee.

This module does not modify feature_extractor.py, bridge_network.py,
reward.py, or cbdc_env.py. It is a read-only consumer of:
    - data/processed/synthetic_liquidity_congestion_daily.parquet
    - data/processed/normalization_stats.json
and of the unmodified FeatureExtractor1DCNN class.

IMPORTANT: `simulation_date` values used anywhere downstream of this
module (see data/structured/transaction_requests.csv) are explicitly
synthetic simulation anchors chosen for the training/eval pipeline. They
are NOT real historical transaction timestamps and must never be
described as such.
"""
import json
import os

import numpy as np
import pandas as pd
import torch

from ..preprocessing.split import SPLIT_BOUNDARIES, GAP_BUFFER_DAYS, assign_split, in_gap_buffer
from .feature_extractor import FeatureExtractor1DCNN

SEQUENCE_LENGTH = 30
FEATURE_DIM = 64
NUM_CHANNELS = 2
MAX_SLOTS = 6

# Explicit, fixed slot mapping - per the approved spec, NOT derived from
# bridge_network.csv row order or any dict/iteration order. Stable across
# runs by construction (a hardcoded tuple, not a computed ordering).
SLOT_BRIDGE_IDS = (
    "USA->IND",  # slot 0
    "GBR->PHL",  # slot 1
    "ARE->MEX",  # slot 2
    None,        # slot 3 - padding
    None,        # slot 4 - padding
    None,        # slot 5 - padding
)
POPULATED_BRIDGE_IDS = tuple(b for b in SLOT_BRIDGE_IDS if b is not None)

DAILY_PARQUET_PATH = "data/processed/synthetic_liquidity_congestion_daily.parquet"
NORMALIZATION_STATS_PATH = "data/processed/normalization_stats.json"


class InvalidSimulationDateError(ValueError):
    """Raised when a simulation_date falls inside a split gap-buffer zone,
    or outside all defined split ranges - such a date cannot be
    unambiguously assigned a window/split per the approved spec."""


def load_daily_series(parquet_path=DAILY_PARQUET_PATH):
    df = pd.read_parquet(parquet_path)
    df = df.sort_values(["bridge_id", "date"]).reset_index(drop=True)
    return df


def load_normalization_stats(stats_path=NORMALIZATION_STATS_PATH):
    with open(stats_path) as f:
        return json.load(f)


def validate_simulation_date(simulation_date):
    """Raises InvalidSimulationDateError if simulation_date cannot be
    unambiguously assigned to a split (outside all ranges, or inside a
    gap-buffer zone). Returns the split name otherwise."""
    simulation_date = pd.Timestamp(simulation_date)
    split = assign_split(simulation_date)
    if split is None:
        raise InvalidSimulationDateError(
            f"simulation_date {simulation_date.date()} falls outside all "
            f"defined split ranges {SPLIT_BOUNDARIES}."
        )
    if in_gap_buffer(simulation_date):
        raise InvalidSimulationDateError(
            f"simulation_date {simulation_date.date()} falls within the "
            f"{GAP_BUFFER_DAYS}-day gap buffer of a split boundary and "
            "cannot be used to anchor a window."
        )
    return split


def build_window(daily_df, stats, bridge_id, simulation_date):
    """Returns a (2, 30) float32 numpy array for one bridge:
    row 0 = normalized liquidity_level, row 1 = normalized congestion_level,
    oldest (index 0) -> newest/simulation_date (index 29).

    Missing leading days (before the series' earliest date, or before the
    dataset start) are explicitly zero-filled - never repeated, never
    shrunk. The window always has shape (2, 30).
    """
    simulation_date = pd.Timestamp(simulation_date)
    # NOTE: split/gap-buffer validation is intentionally NOT enforced here.
    # It is a transaction-assignment concern (does this simulation_date
    # unambiguously belong to one split?), independent of window-building
    # mechanics (how do we fill 30 days of history ending at this date?).
    # Callers that anchor a real transaction to a simulation_date (e.g.
    # Stage1CObservationWrapper) must call validate_simulation_date()
    # themselves before relying on the result for train/val/test purposes.

    window_start = simulation_date - pd.Timedelta(days=SEQUENCE_LENGTH - 1)
    full_dates = pd.date_range(window_start, simulation_date, freq="D")
    assert len(full_dates) == SEQUENCE_LENGTH

    sub = daily_df[daily_df["bridge_id"] == bridge_id]
    sub = sub[(sub["date"] >= window_start) & (sub["date"] <= simulation_date)]
    sub = sub.set_index("date")

    liq_stats = stats["liquidity_level"][bridge_id]
    cong_stats = stats["congestion_level"][bridge_id]

    out = np.zeros((NUM_CHANNELS, SEQUENCE_LENGTH), dtype=np.float32)
    for i, d in enumerate(full_dates):
        if d in sub.index:
            row = sub.loc[d]
            liq_z = (float(row["liquidity_level"]) - liq_stats["mean"]) / liq_stats["std"]
            cong_z = (float(row["congestion_level"]) - cong_stats["mean"]) / cong_stats["std"]
            out[0, i] = liq_z
            out[1, i] = cong_z
        # else: leave as explicit 0.0 (zero-padding, not replication)

    return out


def build_all_windows(daily_df, stats, simulation_date):
    """Returns a (3, 2, 30) float32 numpy array, one window per populated
    bridge, in POPULATED_BRIDGE_IDS order (== slots 0,1,2)."""
    windows = [
        build_window(daily_df, stats, bridge_id, simulation_date)
        for bridge_id in POPULATED_BRIDGE_IDS
    ]
    return np.stack(windows, axis=0)


_shared_cnn = None


def get_shared_cnn():
    """Returns a single shared-weight FeatureExtractor1DCNN instance,
    instantiated exactly as approved: input_channels=2, sequence_length=30,
    feature_dim=64. Not modified from its original definition."""
    global _shared_cnn
    if _shared_cnn is None:
        _shared_cnn = FeatureExtractor1DCNN(
            input_channels=NUM_CHANNELS, sequence_length=SEQUENCE_LENGTH, feature_dim=FEATURE_DIM
        )
        _shared_cnn.eval()
    return _shared_cnn


def compute_cnn_block(daily_df, stats, simulation_date, cnn=None):
    """Returns a (384,) float32 numpy array: 6 slots x 64-dim, in fixed
    SLOT_BRIDGE_IDS order. Slots 0-2 (populated) are run through the
    shared CNN; slots 3-5 (padding) are exact zeros(64), never passed
    through the CNN."""
    if cnn is None:
        cnn = get_shared_cnn()

    populated_windows = build_all_windows(daily_df, stats, simulation_date)  # (3, 2, 30)
    with torch.no_grad():
        x = torch.from_numpy(populated_windows).float()  # (3, 2, 30)
        populated_embeddings = cnn(x).numpy()  # (3, 64)

    block = np.zeros((MAX_SLOTS, FEATURE_DIM), dtype=np.float32)
    block[0:3, :] = populated_embeddings
    # slots 3,4,5 remain exact zeros - never touched by the CNN
    return block.reshape(-1)  # (384,)
