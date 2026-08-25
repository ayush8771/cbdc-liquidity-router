"""RPW preprocessing (Stage 1B Specification v3, approved: cc2 fields,
median aggregation across firm_type per corridor-quarter).

REAL: raw cc2 fx margin / total cost % / speed actual.
DERIVED (REAL-anchored): corridor_friction, real_cost_baseline,
    corridor_baseline_speed_hours/log1p, n_obs.
No imputation - corridor-quarters with zero surveyed observations are
absent from the output, not zero-filled.
"""
import os
import pandas as pd
import numpy as np
import logging

logger = logging.getLogger(__name__)

# openpyxl parsing of the ~254k-row RPW workbook measured at ~100s per call.
# Caching the concatenated-and-filtered result as parquet avoids repeating
# that cost on every pipeline/test run. Cache is invalidated automatically
# if the source .xlsx is newer than the cache file - this is a performance
# optimization only, not a change to any value in the data itself.
_CACHE_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "data", "raw", ".cache", "rpw_combined.parquet")

# Approved hour-midpoint mapping (Stage 1B Specification v2/v3 §1... wait, that
# was FINAL Approved Spec §1 for speed_actual). Casing variants normalized first.
SPEED_BUCKET_HOURS = {
    "less than one hour": 0.5,
    "same day": 12.0,
    "next day": 24.0,
    "2 days": 48.0,
    "3-5 days": 96.0,
    "6 days or more": 168.0,
}


def _normalize_speed_bucket(raw):
    if pd.isna(raw):
        return None
    key = str(raw).strip().lower()
    return SPEED_BUCKET_HOURS.get(key)  # malformed values (e.g. "1-3 days") -> None, dropped


def load_rpw_combined(rpw_xlsx, use_cache=True):
    """Concatenates both RPW sheets, keeping only the columns needed
    downstream (cc2 fields + identity/period fields present in both).
    See module-level note on _CACHE_PATH re: performance caching."""
    if use_cache and os.path.exists(_CACHE_PATH):
        if os.path.getmtime(_CACHE_PATH) >= os.path.getmtime(rpw_xlsx):
            return pd.read_parquet(_CACHE_PATH)
        logger.info("[rpw] Source .xlsx is newer than cache - re-parsing.")

    xl = pd.ExcelFile(rpw_xlsx)
    keep_cols = [
        "source_code", "destination_code", "period",
        "firm_type", "speed actual",
        "cc2 fx margin", "cc2 total cost %",
    ]

    frames = []
    for sheet in ["Dataset (up to Q1 2016)", "Dataset (from Q2 2016)"]:
        df = xl.parse(sheet)
        available = [c for c in keep_cols if c in df.columns]
        frames.append(df[available])

    combined = pd.concat(frames, ignore_index=True, sort=False)

    if use_cache:
        os.makedirs(os.path.dirname(_CACHE_PATH), exist_ok=True)
        combined.to_parquet(_CACHE_PATH, index=False)

    return combined


def _parse_period(period_str):
    """'2016_2Q' -> (year, quarter). Returns (None, None) on malformed input.
    Kept for reference/tests; build_rpw_corridor_quarterly uses a vectorized
    equivalent (see below) since row-wise .apply() over ~250k RPW rows is
    prohibitively slow (~100s measured)."""
    try:
        s = str(period_str)
        year_str, q_str = s.split("_")
        year = int(year_str)
        quarter = int(q_str[0])
        return year, quarter
    except Exception:
        return None, None


def build_rpw_corridor_quarterly(rpw_xlsx):
    df = load_rpw_combined(rpw_xlsx)
    df = df.dropna(subset=["source_code", "destination_code", "period"])

    # Vectorized period parsing: 'YYYY_NQ' -> year, quarter. Malformed rows
    # (e.g. the single known "1-3 days"-style outlier elsewhere in RPW, or
    # any period not matching this exact pattern) become NaN and are
    # dropped, same outcome as the row-wise version, ~1000x faster.
    period_str = df["period"].astype(str)
    extracted = period_str.str.extract(r"^(\d{4})_(\d)Q$")
    df["year"] = pd.to_numeric(extracted[0], errors="coerce")
    df["quarter"] = pd.to_numeric(extracted[1], errors="coerce")
    df = df.dropna(subset=["year", "quarter"])

    # Vectorized speed-bucket mapping via dict .map() instead of row-wise
    # function calls.
    normalized_key = df["speed actual"].astype(str).str.strip().str.lower()
    df["speed_hours"] = normalized_key.map(SPEED_BUCKET_HOURS)
    df["speed_log1p"] = np.log1p(df["speed_hours"])

    grouped = df.groupby(["source_code", "destination_code", "year", "quarter"])
    result = grouped.agg(
        corridor_friction=("cc2 fx margin", "median"),
        real_cost_baseline=("cc2 total cost %", "median"),
        corridor_baseline_speed_hours=("speed_hours", "median"),
        corridor_baseline_speed_log1p=("speed_log1p", "median"),
        n_obs=("cc2 total cost %", "count"),
    ).reset_index()

    result = result.rename(columns={"source_code": "source_code", "destination_code": "destination_code"})
    return result.sort_values(["source_code", "destination_code", "year", "quarter"]).reset_index(drop=True)
