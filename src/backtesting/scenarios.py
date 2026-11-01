"""Stage 1F - stress scenarios applied to the synthetic daily bridge state.

A scenario is a deterministic transformation of the daily liquidity /
congestion table (data/processed/synthetic_liquidity_congestion_daily.parquet).
It is applied IN MEMORY only, to the whole series (all dates), so the CNN's
30-day history windows, the raw observation, environment execution, baselines
and regime labels all see one consistent stressed state. No file, no
environment/reward/PPO code and no normalization statistics are changed;
stressed values are normalized with the frozen train-only statistics, which
is exactly what makes them out-of-distribution stress.

Injection points (both read-only from the code's point of view):
  * src.envs.dynamic_bridge_state._daily_df_cache[DAILY_PARQUET_PATH]
    -> get_dynamic_state() used by execution, raw observations, baselines, regimes
  * Stage1DRawObservationWrapper._daily_df -> CNN windows
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass

import pandas as pd

from ..envs import dynamic_bridge_state as dbs
from ..training.transaction_generator import CORRIDOR_VENUE_UIDS, VENUE_FEES

# Fee-cheapest venue per corridor, as parquet bridge ids (venue #0 is stored bare).
CHEAPEST_PARQUET_IDS = sorted(
    dbs._parquet_bridge_id(min(uids, key=lambda u: VENUE_FEES[u])) for uids in CORRIDOR_VENUE_UIDS.values())


@dataclass(frozen=True)
class Scenario:
    name: str
    description: str
    liquidity_multiplier: float = 1.0
    congestion_multiplier: float = 1.0
    cheapest_venue_liquidity_multiplier: float = 1.0  # applied on top of liquidity_multiplier


SCENARIOS = {
    s.name: s for s in [
        Scenario("baseline", "Unmodified synthetic bridge state."),
        Scenario("liquidity_minus30", "All venues' liquidity scaled by 0.7.", liquidity_multiplier=0.7),
        Scenario("liquidity_minus50", "All venues' liquidity scaled by 0.5.", liquidity_multiplier=0.5),
        Scenario("cheapest_venue_outage", "Fee-cheapest venue of each corridor at 10% liquidity.",
                 cheapest_venue_liquidity_multiplier=0.1),
        Scenario("congestion_x2", "All venues' congestion doubled.", congestion_multiplier=2.0),
        Scenario("combined_stress", "Liquidity x0.7 and congestion x1.5 on all venues.",
                 liquidity_multiplier=0.7, congestion_multiplier=1.5),
    ]
}


def perturb(daily_df: pd.DataFrame, scenario: Scenario) -> pd.DataFrame:
    """Returns a NEW, sorted DataFrame; the input is never modified."""
    if not isinstance(scenario, Scenario):
        raise TypeError("scenario must be a Scenario")
    for m in (scenario.liquidity_multiplier, scenario.congestion_multiplier, scenario.cheapest_venue_liquidity_multiplier):
        if not (m >= 0 and m == m and m != float("inf")):
            raise ValueError(f"invalid multiplier {m!r} in scenario {scenario.name}")
    df = daily_df.copy(deep=True)
    df["liquidity_level"] = df["liquidity_level"] * scenario.liquidity_multiplier
    if scenario.cheapest_venue_liquidity_multiplier != 1.0:
        cheap = df["bridge_id"].isin(CHEAPEST_PARQUET_IDS)
        df.loc[cheap, "liquidity_level"] = df.loc[cheap, "liquidity_level"] * scenario.cheapest_venue_liquidity_multiplier
    df["congestion_level"] = df["congestion_level"] * scenario.congestion_multiplier
    return df.sort_values(["bridge_id", "date"]).reset_index(drop=True)


@contextmanager
def injected_daily_state(daily_df: pd.DataFrame):
    """Temporarily makes get_dynamic_state() read `daily_df`; restores the previous
    cache entry (or its absence) on exit, even on error."""
    cache, key = dbs._daily_df_cache, dbs.DAILY_PARQUET_PATH
    had, previous = key in cache, cache.get(key)
    cache[key] = daily_df
    try:
        yield daily_df
    finally:
        if had:
            cache[key] = previous
        else:
            cache.pop(key, None)
