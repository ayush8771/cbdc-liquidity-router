"""Stage 1D - derived corridor-level risk proxy.

Per the approved Stage 1D risk decision (Option A): NOT a measurement of
real bridge operational risk (no such telemetry exists anywhere in this
project). This is a DERIVED FROM REAL + ASSUMPTION signal:

    corridor_risk(source, target, month) =
        mean( macro_risk_proxy(source, month), macro_risk_proxy(target, month) )

macro_risk_proxy itself is REAL/DERIVED (WDI/CPI/FRED-sourced, built in
Stage 1B's macro_risk.py - untouched here). The MEAN-combination method
and its use as a per-corridor "risk" figure for reward/observation
purposes is the ASSUMPTION layer. This must never be described or logged
as measured bridge risk.
"""
import pandas as pd

MACRO_RISK_PARQUET_PATH = "data/processed/macro_risk_proxy.parquet"
DATA_SOURCE_TAG = "derived_corridor_risk_proxy_from_macro_risk"

_macro_risk_cache = {}


def load_macro_risk(parquet_path=MACRO_RISK_PARQUET_PATH):
    if parquet_path not in _macro_risk_cache:
        df = pd.read_parquet(parquet_path)
        _macro_risk_cache[parquet_path] = df
    return _macro_risk_cache[parquet_path]


def corridor_risk_proxy(source_iso, target_iso, simulation_date, macro_risk_df=None):
    """Returns a float corridor-risk proxy for (source_iso, target_iso) at
    the calendar month of simulation_date. Uses the SAME month as
    simulation_date (macro_risk_proxy.parquet values are themselves
    already lag-safe per Stage 1B's own methodology - build_lagged_monthly_dict
    is for the daily-series GENERATOR's real-conditioning, a distinct
    concern from this direct lookup). Raises KeyError if either country's
    month is missing (should not happen given full monthly coverage
    verified during the Stage 1D audit)."""
    if macro_risk_df is None:
        macro_risk_df = load_macro_risk()

    month = pd.Timestamp(simulation_date).replace(day=1)

    def _lookup(iso3):
        row = macro_risk_df[(macro_risk_df["iso3"] == iso3) & (macro_risk_df["month"] == month)]
        if row.empty:
            raise KeyError(f"No macro_risk_proxy for iso3={iso3!r} month={month.date()}")
        return float(row.iloc[0]["macro_risk_proxy"])

    source_risk = _lookup(source_iso)
    target_risk = _lookup(target_iso)
    return (source_risk + target_risk) / 2.0
