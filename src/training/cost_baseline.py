"""Stage 1D - real RPW cost-baseline lookup, lagged-quarter, reused by
cbdc_env.py's reward computation. NEVER uses the current/future quarter
relative to simulation_date - reuses split.py's existing
build_lagged_quarterly_dict, not a new lagging implementation.

For ARE->MEX (no real RPW data - synthetic_no_real_anchor), falls back to
the same are_mex_fallback frame already used elsewhere in Stage 1B/1D,
consistent with how that corridor is treated everywhere else in the
pipeline (never silently presented as real RPW-derived).
"""
import pandas as pd

from ..preprocessing.split import build_lagged_quarterly_dict

RPW_PARQUET_PATH = "data/processed/rpw_corridor_quarterly.parquet"
DEFAULT_BASELINE_COST_PCT_PLACEHOLDER = 0.05  # same placeholder as reward.py, used only if lookup fails

_cache = {}


def _lagged_dict_for_corridor(source, target, rpw_path=RPW_PARQUET_PATH):
    cache_key = (source, target, rpw_path)
    if cache_key in _cache:
        return _cache[cache_key]

    if (source, target) == ("ARE", "MEX"):
        from ..preprocessing.are_mex_fallback import build_are_mex_fallback
        from ..preprocessing.country_reference import build_country_reference_clean
        rpw_df = pd.read_parquet(rpw_path)
        countries_clean = build_country_reference_clean("data/structured/countries.csv")
        corridor_data, _ = build_are_mex_fallback(rpw_df, countries_clean)
    else:
        rpw_df = pd.read_parquet(rpw_path)
        corridor_data = rpw_df[(rpw_df["source_code"] == source) & (rpw_df["destination_code"] == target)]

    lagged = build_lagged_quarterly_dict(corridor_data, "real_cost_baseline")
    _cache[cache_key] = lagged
    return lagged


def lagged_real_cost_baseline_pct(source, target, simulation_date, rpw_path=RPW_PARQUET_PATH):
    """Returns the lagged-quarter real_cost_baseline (as a fraction, e.g.
    0.05 = 5%) for (source, target) at simulation_date's quarter, or None
    if unavailable (caller should fall back to the placeholder)."""
    simulation_date = pd.Timestamp(simulation_date)
    q = (simulation_date.year, (simulation_date.month - 1) // 3 + 1)
    lagged = _lagged_dict_for_corridor(source, target, rpw_path)
    value = lagged.get(q)
    if value is None or (isinstance(value, float) and value != value):  # None or NaN
        return None
    return float(value)
