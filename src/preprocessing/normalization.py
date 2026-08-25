"""Train-only normalization statistics (fix per Stage 1B review, item 1).

Fits friction_mean/std (per corridor) and risk_mean/std (per country)
using ONLY rows dated within the training period (per split.SPLIT_BOUNDARIES),
then freezes them for use across train/validation/test. This prevents the
synthetic generator's z-score conditioning from ever depending on
validation/test-period values, in either direction (train stats changing
because of a future value, or a future period silently informing its own
conditioning via distributional statistics computed over its own range).

Quarterly rows are included if TRAIN_START <= quarter_start_date <= TRAIN_END.
Monthly rows are included if TRAIN_START <= month_start_date <= TRAIN_END.
"""
import pandas as pd
import numpy as np

from .split import SPLIT_BOUNDARIES

TRAIN_START, TRAIN_END = SPLIT_BOUNDARIES["train"]


def _quarter_start(year, quarter):
    return pd.Timestamp(year=year, month=(quarter - 1) * 3 + 1, day=1)


def fit_friction_stats(rpw_corridor_quarterly, source_code, destination_code):
    """Returns (mean, std, n, train_start, train_end) for one corridor,
    using only quarters whose start date falls within the training range."""
    sub = rpw_corridor_quarterly[
        (rpw_corridor_quarterly["source_code"] == source_code)
        & (rpw_corridor_quarterly["destination_code"] == destination_code)
    ].copy()
    sub["q_start"] = sub.apply(lambda r: _quarter_start(int(r["year"]), int(r["quarter"])), axis=1)
    train_sub = sub[(sub["q_start"] >= TRAIN_START) & (sub["q_start"] <= TRAIN_END)]
    values = train_sub["corridor_friction"].dropna()

    mean = float(values.mean()) if len(values) else 0.0
    std = float(values.std()) if len(values) > 1 else 1.0
    std = std if std and not pd.isna(std) else 1.0
    return {
        "mean": mean, "std": std, "n": int(len(values)),
        "train_start": str(TRAIN_START.date()), "train_end": str(TRAIN_END.date()),
    }


def fit_risk_stats(macro_risk_df, iso3):
    """Returns (mean, std, n, train_start, train_end) for one country's
    macro_risk_proxy, using only months whose start date falls within the
    training range AND whose source_flag is not unconditioned_default
    (a non-value shouldn't be counted into the fitted distribution)."""
    sub = macro_risk_df[macro_risk_df["iso3"] == iso3].copy()
    sub = sub[sub["source_flag"] != "unconditioned_default"]
    train_sub = sub[(sub["month"] >= TRAIN_START) & (sub["month"] <= TRAIN_END)]
    values = train_sub["macro_risk_proxy"].dropna()

    mean = float(values.mean()) if len(values) else 0.0
    std = float(values.std()) if len(values) > 1 else 1.0
    std = std if std and not pd.isna(std) else 1.0
    return {
        "mean": mean, "std": std, "n": int(len(values)),
        "train_start": str(TRAIN_START.date()), "train_end": str(TRAIN_END.date()),
    }


def fit_macro_component_stats(components_df, corridor_isos, columns=("real_fx_volatility", "fcrf_volatility_5y", "cpi_volatility_12m")):
    """Fits mean/std for each RAW macro-risk component, per country, using
    ONLY training-period rows with a non-null value for that component.
    Returns {iso3: {column: {"mean":.., "std":.., "n":.., "train_start":.., "train_end":..}}}.

    This is the fix for the macro_risk_proxy leakage path: these stats are
    computed BEFORE any z-scoring/combining happens (see macro_risk.py's
    apply_macro_risk_proxy, which is the only place these stats are used,
    always applied identically regardless of which split a row belongs to).
    """
    train_sub = components_df[(components_df["month"] >= TRAIN_START) & (components_df["month"] <= TRAIN_END)]

    out = {}
    for iso3 in corridor_isos:
        out[iso3] = {}
        country_train = train_sub[train_sub["iso3"] == iso3]
        for col in columns:
            values = country_train[col].dropna()
            mean = float(values.mean()) if len(values) else 0.0
            std = float(values.std()) if len(values) > 1 else 1.0
            std = std if std and not pd.isna(std) else 1.0
            out[iso3][col] = {
                "mean": mean, "std": std, "n": int(len(values)),
                "train_start": str(TRAIN_START.date()), "train_end": str(TRAIN_END.date()),
            }
    return out


def fit_daily_series_stats(daily_df, bridge_id, column):
    """Stage 1C addition. Returns (mean, std, n, train_start, train_end) for
    one bridge's daily series column (liquidity_level or congestion_level),
    using ONLY rows whose date falls within the training range. Mirrors
    fit_friction_stats/fit_risk_stats exactly - same shape, same
    train-only-then-freeze discipline, no new normalization mechanism
    introduced.
    """
    sub = daily_df[daily_df["bridge_id"] == bridge_id]
    train_sub = sub[(sub["date"] >= TRAIN_START) & (sub["date"] <= TRAIN_END)]
    values = train_sub[column].dropna()

    mean = float(values.mean()) if len(values) else 0.0
    std = float(values.std()) if len(values) > 1 else 1.0
    std = std if std and not pd.isna(std) else 1.0
    return {
        "mean": mean, "std": std, "n": int(len(values)),
        "train_start": str(TRAIN_START.date()), "train_end": str(TRAIN_END.date()),
    }


def build_daily_series_normalization_stats(daily_df, bridge_ids, columns=("liquidity_level", "congestion_level")):
    """Stage 1C addition. Returns {column: {bridge_id: stats_dict}} for the
    two daily CNN input channels, fit train-only and frozen. Does not
    modify or recompute any existing friction/risk stats."""
    stats = {}
    for col in columns:
        stats[col] = {}
        for bridge_id in bridge_ids:
            stats[col][bridge_id] = fit_daily_series_stats(daily_df, bridge_id, col)
    return stats


def build_normalization_stats(rpw_corridor_quarterly, macro_risk_df, corridors, destination_isos):
    """corridors: list of (source, destination) tuples.
    destination_isos: list of ISO-3 codes to fit risk stats for (the
    corridor destination countries - risk is conditioned on the
    destination leg per run_stage1b.py's existing convention)."""
    stats = {"friction": {}, "risk": {}}
    for source, destination in corridors:
        key = f"{source}->{destination}"
        stats["friction"][key] = fit_friction_stats(rpw_corridor_quarterly, source, destination)
    for iso3 in destination_isos:
        stats["risk"][iso3] = fit_risk_stats(macro_risk_df, iso3)
    return stats
