"""macro_risk_proxy construction (Stage 1B Specification v3 §1/§5).

REVISED per leakage-review follow-up: this module now produces RAW,
UN-NORMALIZED components only - `build_macro_risk_components()`. It does
NOT z-score or combine them into a single macro_risk_proxy value.

Reason: the previous version z-scored each component using that
component's own full 2011-2025 series (mean/std over ALL months,
including validation/test) before combining - this leaked validation/test
distribution information into macro_risk_proxy itself, independent of
(and prior to) the later train-only normalization already applied to the
synthetic generator's conditioning in normalization.py. Two leakage paths
existed; only one had been fixed.

Correct transformation order (enforced by construction, not just by
convention - see run_stage1b.py):
    1. build_macro_risk_components()   <- THIS module. Raw values only.
    2. normalization.fit_macro_component_stats()  <- fits mean/std PER
       COMPONENT PER COUNTRY using ONLY training-period, non-null rows.
    3. apply_macro_risk_proxy()        <- THIS module. Applies the frozen
       (already-fitted) stats to EVERY row (train, val, and test alike),
       producing the final macro_risk_proxy value. No step in this
       function reads or is affected by any value outside what was
       already frozen in step 2.

source_flag values (unchanged, per Specification v3 §7):
    real_daily_fx          - a real daily FRED series was available for this month
    cpi_wdi_derived         - WDI(annual, ffilled-within-year)+CPI(monthly) fallback
    unconditioned_default  - no real signal available for this iso3/month
"""
import pandas as pd
import numpy as np

from .fx_daily import load_fred_daily, FRED_SERIES

# ISO-3 -> FRED currency key, for the three corridors' non-USD legs.
ISO3_TO_CURRENCY = {
    "IND": "INR", "GBR": "GBP", "PHL": "PHP", "ARE": "AED", "MEX": "MXN",
}


def _real_daily_fx_monthly_vol(currency, month_ceiling=None):
    """Rolling 30-day-window std of daily % change, resampled to monthly.
    Returns None if no real series is available (graceful degradation).

    month_ceiling: if supplied, any monthly row beyond this date is
    dropped HERE, at the source, so a FRED file that happens to extend
    past the approved simulation end date (2025-09-30) can never reach
    any processed output even transiently - not relying solely on the
    downstream month-range merge to exclude it (see FRED boundary test).
    """
    daily = load_fred_daily(currency)
    if daily is None or daily.empty:
        return None
    daily = daily.sort_values("date").reset_index(drop=True)
    daily["pct_change"] = daily["rate"].pct_change() * 100.0
    daily["rolling_vol"] = daily["pct_change"].rolling(window=30, min_periods=15).std()
    daily["month"] = daily["date"].values.astype("datetime64[M]")
    monthly = daily.groupby("month")["rolling_vol"].mean().reset_index()
    monthly = monthly.rename(columns={"rolling_vol": "real_fx_volatility"})
    if month_ceiling is not None:
        monthly = monthly[monthly["month"] <= pd.Timestamp(month_ceiling)]
    return monthly


def build_macro_risk_components(wdi_fx_df, cpi_df, corridor_isos, full_month_range, month_ceiling=None):
    """Returns raw, UN-NORMALIZED components + source_flag. No z-scoring,
    no combining. full_month_range is REQUIRED (not optional) - every
    corridor country gets every month explicitly represented.
    """
    rows = []
    all_months = sorted(pd.DatetimeIndex(full_month_range).unique())

    for iso3 in corridor_isos:
        currency = ISO3_TO_CURRENCY.get(iso3)
        real_monthly = _real_daily_fx_monthly_vol(currency, month_ceiling=month_ceiling) if currency else None

        wdi_sub = wdi_fx_df[wdi_fx_df["iso3"] == iso3][["year", "fcrf_volatility_5y"]].dropna()
        wdi_monthly = None
        if not wdi_sub.empty:
            idx = pd.date_range(
                start=f"{int(wdi_sub['year'].min())}-01-01",
                end=f"{int(wdi_sub['year'].max())}-12-01",
                freq="MS",
            )
            wdi_monthly = pd.DataFrame({"month": idx})
            wdi_monthly["year"] = wdi_monthly["month"].dt.year
            wdi_monthly = wdi_monthly.merge(wdi_sub, on="year", how="left")

        cpi_sub = cpi_df[cpi_df["iso3"] == iso3][["month", "cpi_volatility_12m"]].dropna()

        frame = pd.DataFrame({"month": all_months})
        frame = frame.merge(real_monthly, on="month", how="left") if real_monthly is not None else frame.assign(real_fx_volatility=np.nan)
        frame = frame.merge(wdi_monthly[["month", "fcrf_volatility_5y"]], on="month", how="left") if wdi_monthly is not None else frame.assign(fcrf_volatility_5y=np.nan)
        frame = frame.merge(cpi_sub, on="month", how="left") if not cpi_sub.empty else frame.assign(cpi_volatility_12m=np.nan)

        def _flag(row):
            if pd.notna(row["real_fx_volatility"]):
                return "real_daily_fx"
            if pd.notna(row["fcrf_volatility_5y"]) or pd.notna(row["cpi_volatility_12m"]):
                return "cpi_wdi_derived"
            return "unconditioned_default"

        frame["source_flag"] = frame.apply(_flag, axis=1)
        frame["iso3"] = iso3
        rows.append(frame[["iso3", "month", "real_fx_volatility", "fcrf_volatility_5y", "cpi_volatility_12m", "source_flag"]])

    return pd.concat(rows, ignore_index=True).sort_values(["iso3", "month"]).reset_index(drop=True)


def apply_macro_risk_proxy(components_df, fitted_stats):
    """Applies FROZEN (already train-fitted) per-country per-component
    mean/std to every row - train, validation, and test alike - producing
    the final macro_risk_proxy. This function reads NOTHING from the rows
    themselves to decide the transform; it only ever applies numbers
    already computed by normalization.fit_macro_component_stats().

    fitted_stats: {iso3: {"real_fx_volatility": {"mean":..,"std":..}, ... }}
    """
    df = components_df.copy()

    def _z(value, iso3, col):
        if pd.isna(value):
            return np.nan
        stats = fitted_stats.get(iso3, {}).get(col)
        if stats is None or not stats.get("std"):
            return np.nan
        return (value - stats["mean"]) / stats["std"]

    def _row_proxy(row):
        iso3 = row["iso3"]
        if row["source_flag"] == "unconditioned_default":
            return np.nan
        if row["source_flag"] == "real_daily_fx":
            return _z(row["real_fx_volatility"], iso3, "real_fx_volatility")
        # cpi_wdi_derived: average whichever of the two is present
        z_wdi = _z(row["fcrf_volatility_5y"], iso3, "fcrf_volatility_5y")
        z_cpi = _z(row["cpi_volatility_12m"], iso3, "cpi_volatility_12m")
        comps = [v for v in (z_wdi, z_cpi) if pd.notna(v)]
        return float(np.mean(comps)) if comps else np.nan

    df["macro_risk_proxy"] = df.apply(_row_proxy, axis=1)
    return df
