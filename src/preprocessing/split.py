"""Train/val/test split boundaries and date-aware utilities (Stage 1B
Specification v3 §9, and date-aware-windowing requirement from §13/v3 §6).
"""
import pandas as pd

SPLIT_BOUNDARIES = {
    "train": (pd.Timestamp("2011-01-01"), pd.Timestamp("2021-12-31")),
    "validation": (pd.Timestamp("2022-01-01"), pd.Timestamp("2023-12-31")),
    "test": (pd.Timestamp("2024-01-01"), pd.Timestamp("2025-09-30")),
}
GAP_BUFFER_DAYS = 30
SEED = 42


def assign_split(date):
    for name, (start, end) in SPLIT_BOUNDARIES.items():
        if start <= date <= end:
            return name
    return None  # outside all three ranges entirely


def in_gap_buffer(date):
    """True if `date` falls within GAP_BUFFER_DAYS of any split boundary -
    such rows/windows must be excluded from both adjacent splits."""
    for start, end in SPLIT_BOUNDARIES.values():
        if abs((date - start).days) <= GAP_BUFFER_DAYS or abs((date - end).days) <= GAP_BUFFER_DAYS:
            return True
    return False


def lagged_quarter(year, quarter):
    """Returns the (year, quarter) tuple for the PREVIOUS quarter - used
    for the mandatory real-conditioning lag (never use the current/future
    quarter's real value)."""
    if quarter == 1:
        return year - 1, 4
    return year, quarter - 1


def lagged_month(year, month):
    if month == 1:
        return year - 1, 12
    return year, month - 1


def build_lagged_quarterly_dict(corridor_quarterly_df, value_col):
    """(year, quarter) -> value, keyed by the quarter WHOSE data should be
    used going forward (i.e. already shifted +1 quarter from the source
    row, so a direct dict lookup on the target quarter gives the correctly
    lagged value)."""
    out = {}
    for _, row in corridor_quarterly_df.iterrows():
        y, q = int(row["year"]), int(row["quarter"])
        target_y, target_q = _next_quarter(y, q)
        val = row.get(value_col)
        if pd.notna(val):
            out[(target_y, target_q)] = val
    return out


def _next_quarter(year, quarter):
    if quarter == 4:
        return year + 1, 1
    return year, quarter + 1


def build_lagged_monthly_dict(macro_risk_df):
    out = {}
    for _, row in macro_risk_df.iterrows():
        m = row["month"]
        y, mo = m.year, m.month
        target_y, target_mo = (y + 1, 1) if mo == 12 else (y, mo + 1)
        val = row.get("macro_risk_proxy")
        if pd.notna(val):
            out[(target_y, target_mo)] = val
    return out
