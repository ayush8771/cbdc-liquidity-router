"""Stage 1D - single shared dynamic bridge state lookup.

Provides (bridge_uid, simulation_date) -> current raw liquidity_level /
congestion_level, reading from the SAME
synthetic_liquidity_congestion_daily.parquet Stage 1C already uses for its
CNN windows. This module is the one authoritative path for "what is a
bridge's dynamic state right now" - reused by cbdc_env.py (execution +
reward), the baselines module, and the transaction generator, so PPO,
both baselines, and the environment can never silently diverge on what
"current state" means.

Values returned are RAW physical units (not z-scored) - execution math
needs real liquidity, not a normalized score. Stage 1C's CNN input
normalization is a separate, independently-frozen concern and is
untouched by this module.

Bridge identity note: venue #0 of each corridor is stored in the daily
parquet under its ORIGINAL bare bridge_id (e.g. "USA->IND", no suffix) -
this was a deliberate choice in synthetic_bridge_expansion.py to keep
Stage 1C's SLOT_BRIDGE_IDS/windowing code completely unmodified. Venues
#1/#2 are stored under their explicit bridge_uid (e.g. "USA->IND#1").
`_parquet_bridge_id()` below is the one place this mapping is applied.
"""
import pandas as pd

DAILY_PARQUET_PATH = "data/processed/synthetic_liquidity_congestion_daily.parquet"

_daily_df_cache = {}


def _parquet_bridge_id(bridge_uid):
    """Maps a bridge_network.csv bridge_uid (e.g. 'USA->IND#0',
    'USA->IND#1') to the corresponding bridge_id key used in the daily
    parquet. Venue #0 is stored bare ('USA->IND'); venues #1/#2 use their
    explicit suffixed uid unchanged."""
    if bridge_uid.endswith("#0"):
        return bridge_uid[:-2]
    return bridge_uid


def load_daily_series(parquet_path=DAILY_PARQUET_PATH):
    if parquet_path not in _daily_df_cache:
        df = pd.read_parquet(parquet_path)
        df = df.sort_values(["bridge_id", "date"]).reset_index(drop=True)
        _daily_df_cache[parquet_path] = df
    return _daily_df_cache[parquet_path]


def get_dynamic_state(bridge_uid, simulation_date, daily_df=None):
    """Returns (liquidity_level, congestion_level) as raw floats for the
    given bridge and date. Raises KeyError if no row exists for that
    exact (bridge, date) - callers should only pass dates known to be in
    range (the daily parquet spans the full simulation date range with no
    gaps, per the Stage 1B audit)."""
    if daily_df is None:
        daily_df = load_daily_series()
    simulation_date = pd.Timestamp(simulation_date)
    parquet_id = _parquet_bridge_id(bridge_uid)

    row = daily_df[(daily_df["bridge_id"] == parquet_id) & (daily_df["date"] == simulation_date)]
    if row.empty:
        raise KeyError(f"No dynamic state for bridge_uid={bridge_uid!r} (parquet id={parquet_id!r}) on {simulation_date.date()}")
    row = row.iloc[0]
    return float(row["liquidity_level"]), float(row["congestion_level"])
