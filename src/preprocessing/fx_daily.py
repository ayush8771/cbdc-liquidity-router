"""Real daily FX data loader (Stage 1B Specification v3 §1/§7).

Expects FRED-format CSVs at data/raw/fred/{SERIES_ID}.csv:
    DEXINUS.csv (INR), DEXUSUK.csv (GBP), DEXMXUS.csv (MXN)

If a file is absent, this loader returns None for that currency rather
than fabricating data - the caller (macro_risk.py) is responsible for
falling back to the CPI/WDI-derived component and tagging accordingly.
This is NOT an error condition; graceful degradation is the approved
design (Specification v3 §1, PHP/AED already use this same path).
"""
import os
import pandas as pd
import logging

logger = logging.getLogger(__name__)

# Per approved Specification v3 §1/§7 - verified series, not guessed.
FRED_SERIES = {
    "INR": "DEXINUS",
    "GBP": "DEXUSUK",
    "MXN": "DEXMXUS",
}


def load_fred_daily(currency, raw_dir="data/raw/fred"):
    """Returns a DataFrame [date, rate] for the given currency's FRED
    series, or None if the file isn't present. Never fabricates values.
    """
    series_id = FRED_SERIES.get(currency)
    if series_id is None:
        return None  # PHP/AED and any other currency: no series defined, by design.

    path = os.path.join(raw_dir, f"{series_id}.csv")
    if not os.path.exists(path):
        logger.info(
            f"[fx_daily] {series_id}.csv not found at {path} - "
            f"{currency} falls back to CPI/WDI-derived macro_risk_proxy "
            "component, per Specification v3's approved graceful-degradation design."
        )
        return None

    df = pd.read_csv(path)
    # Accept either FRED's typical DATE/VALUE header or a series-ID-named
    # value column, without guessing at other formats.
    date_col = "DATE" if "DATE" in df.columns else df.columns[0]
    value_col = "VALUE" if "VALUE" in df.columns else series_id
    if value_col not in df.columns:
        logger.warning(f"[fx_daily] {path} missing expected value column '{value_col}' - ignoring file.")
        return None

    out = df[[date_col, value_col]].rename(columns={date_col: "date", value_col: "rate"})
    out["date"] = pd.to_datetime(out["date"], errors="coerce")
    out["rate"] = pd.to_numeric(out["rate"], errors="coerce")
    out = out.dropna(subset=["date"])
    return out.sort_values("date").reset_index(drop=True)
