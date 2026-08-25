"""WDI preprocessing (Stage 1B Specification v3, §1 of the Plan).

REAL: fcrf_value (from PA.NUS.FCRF, filtered to real ISO-3 countries).
DERIVED: fcrf_yoy_pct, fcrf_volatility_5y.
No imputation - missing years stay NaN.
"""
import csv
import pandas as pd
import logging

logger = logging.getLogger(__name__)

INDICATOR = "PA.NUS.FCRF"


def load_country_whitelist(countries_csv):
    df = pd.read_csv(countries_csv)
    return set(df["ISO 3166-1 alpha-3 country code"].dropna().astype(str))


def build_wdi_fx_features(wdi_csv, countries_csv):
    whitelist = load_country_whitelist(countries_csv)

    rows = []
    with open(wdi_csv, encoding="utf-8-sig") as f:
        r = csv.reader(f)
        header = next(r)
        year_cols = [h for h in header[4:] if h.strip().isdigit()]
        year_idx = {y: header.index(y) for y in year_cols}
        for row in r:
            if len(row) < 4:
                continue
            iso3, indicator_code = row[1], row[3]
            if indicator_code != INDICATOR:
                continue
            if iso3 not in whitelist:
                continue  # drop WDI aggregates (ARB, EAP, HIC, ...) per audit finding
            for y in year_cols:
                raw = row[year_idx[y]] if year_idx[y] < len(row) else ""
                if raw in ("", "\r"):
                    continue
                try:
                    val = float(raw)
                except ValueError:
                    continue
                rows.append({"iso3": iso3, "year": int(y), "fcrf_value": val})

    df = pd.DataFrame(rows).sort_values(["iso3", "year"]).reset_index(drop=True)
    if df.empty:
        return df

    df["fcrf_yoy_pct"] = df.groupby("iso3")["fcrf_value"].pct_change() * 100.0
    df["fcrf_volatility_5y"] = (
        df.groupby("iso3")["fcrf_yoy_pct"]
        .rolling(window=5, min_periods=3)
        .std()
        .reset_index(level=0, drop=True)
    )
    return df
