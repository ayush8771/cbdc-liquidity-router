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


def fit_fee_and_risk_proxy_stats(train_transactions_df, bridge_network_df, corridor_risk_proxy_fn):
    """Stage 1D addition (correction pass). Fits train-only stats for:
      - fee: GLOBAL across all bridge venues' static fee values (not
        per-venue - each venue has exactly one fixed fee, so a per-venue
        z-score would always normalize to 0 for every venue, destroying
        the relative-fee signal the policy needs; a global fit over all
        venues' fees preserves that signal).
      - risk_proxy: PER-CORRIDOR (distinct from the existing `risk` key,
        which is Stage 1B's destination-country risk used for the daily-
        series GENERATOR's conditioning - a different quantity from the
        Stage 1D corridor-risk-proxy used in reward/observation). Fit by
        sampling corridor_risk_proxy_fn at each TRAIN transaction's
        (corridor, simulation_date).

    Returns {"fee": {...}, "risk_proxy": {corridor_key: {...}}}.
    """
    fees = bridge_network_df["latency_fee_pct"].astype(float)
    fee_std = float(fees.std()) if len(fees) > 1 else 1.0
    fee_stats = {
        "mean": float(fees.mean()), "std": fee_std if fee_std and not pd.isna(fee_std) else 1.0,
        "n": int(len(fees)), "train_start": str(TRAIN_START.date()), "train_end": str(TRAIN_END.date()),
    }

    risk_samples = {}
    for _, row in train_transactions_df.iterrows():
        corridor_key = f"{row['sender_country']}->{row['receiver_country']}"
        try:
            r = corridor_risk_proxy_fn(row["sender_country"], row["receiver_country"], row["simulation_date"])
        except KeyError:
            continue
        if r is None or (isinstance(r, float) and r != r):
            continue
        risk_samples.setdefault(corridor_key, []).append(r)

    risk_proxy_stats = {}
    for corridor_key, samples in risk_samples.items():
        arr = pd.Series(samples, dtype=float)
        std = float(arr.std()) if len(arr) > 1 else 1.0
        risk_proxy_stats[corridor_key] = {
            "mean": float(arr.mean()), "std": std if std and not pd.isna(std) else 1.0,
            "n": int(len(arr)), "train_start": str(TRAIN_START.date()), "train_end": str(TRAIN_END.date()),
        }

    return {"fee": fee_stats, "risk_proxy": risk_proxy_stats}


def fit_raw_ppo_feature_stats(train_transactions_df, corridor_venue_uids_fn, get_dynamic_state_fn):
    """Stage 1D addition. Fits train-only mean/std for the continuous raw
    PPO observation features:
      - amount (global, one value regardless of corridor)
      - fee (per-bridge-uid, static - but stats fit here for consistency)
      - capacity/liquidity (per-bridge-uid, DYNAMIC - sampled at each
        train transaction's simulation_date, not a single static number)
      - congestion, risk are already covered by Stage 1C's existing
        liquidity_level/congestion_level and the risk proxy respectively;
        NOT refit here to avoid duplicate/conflicting stats for the same
        underlying quantity.

    `train_transactions_df` must be ONLY train-split rows (caller's
    responsibility - this function does not filter by split itself, to
    keep it a pure function over whatever frame it's given).

    The mask bit is NEVER normalized (stays a hardcoded 0/1) - not
    handled here since it isn't fit from data at all.

    Returns a dict: {"amount": {...}, "capacity": {bridge_uid: {...}}}
    (fee omitted from per-bridge fitting here since fee is a fixed
    constant per bridge_uid, not a distribution - see note in caller).
    """
    amounts = train_transactions_df["amount_usd"].astype(float)
    amount_stats = {
        "mean": float(amounts.mean()), "std": float(amounts.std()) if len(amounts) > 1 else 1.0,
        "n": int(len(amounts)), "train_start": str(TRAIN_START.date()), "train_end": str(TRAIN_END.date()),
    }
    amount_stats["std"] = amount_stats["std"] if amount_stats["std"] and not pd.isna(amount_stats["std"]) else 1.0

    capacity_samples = {}
    for _, row in train_transactions_df.iterrows():
        corridor = (row["sender_country"], row["receiver_country"])
        for uid in corridor_venue_uids_fn(corridor):
            liq, _cong = get_dynamic_state_fn(uid, row["simulation_date"])
            capacity_samples.setdefault(uid, []).append(liq)

    capacity_stats = {}
    for uid, samples in capacity_samples.items():
        arr = pd.Series(samples, dtype=float)
        std = float(arr.std()) if len(arr) > 1 else 1.0
        capacity_stats[uid] = {
            "mean": float(arr.mean()), "std": std if std and not pd.isna(std) else 1.0,
            "n": int(len(arr)), "train_start": str(TRAIN_START.date()), "train_end": str(TRAIN_END.date()),
        }

    return {"amount": amount_stats, "capacity": capacity_stats}


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
