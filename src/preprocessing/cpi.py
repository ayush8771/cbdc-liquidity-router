"""CPI preprocessing (Stage 1B Specification v3 §2, approved: NSA file,
self-computed matched-month YoY).

REAL: cpi_level.
DERIVED: cpi_yoy_pct (matched-calendar-month, self-computed), cpi_volatility_12m.
No imputation - missing months stay NaN.
"""
import pandas as pd
import logging

logger = logging.getLogger(__name__)

# Real-country name -> ISO-3 mismatches, verified individually against
# countries.csv (Stage 1B Specification v3 investigation). Aggregates
# ("Developing Asia", "High Income Countries", etc.) are NOT included here
# and are dropped, not mapped.
MANUAL_NAME_CROSSWALK = {
    "Cote d'Ivoire": "CIV",
    "Congo, Rep.": None,       # verified NOT present in countries.csv - unresolved
    "Czech Republic": "CZE",
    "Lao, PDR": "LAO",
    "Moldova, Rep.": "MDA",
    "Sao Tome and Principe": "STP",
    "Slovakia": "SVK",
    "Turkey": "TUR",
    "Taiwan, China": None,     # verified NOT present in countries.csv - unresolved
}


def build_name_to_iso3_crosswalk(cpi_xlsx, countries_csv, sheet_name="monthly"):
    countries = pd.read_csv(countries_csv)
    name_to_iso = dict(zip(countries["Country name"], countries["ISO 3166-1 alpha-3 country code"]))

    cpi = pd.read_excel(cpi_xlsx, sheet_name=sheet_name)
    cpi_names = [c for c in cpi.columns if c != "Unnamed: 0"]

    rows = []
    for name in cpi_names:
        if name in name_to_iso:
            rows.append({"cpi_country_name": name, "iso3": name_to_iso[name], "match_type": "exact"})
        elif name in MANUAL_NAME_CROSSWALK and MANUAL_NAME_CROSSWALK[name] is not None:
            rows.append({"cpi_country_name": name, "iso3": MANUAL_NAME_CROSSWALK[name], "match_type": "manual"})
        else:
            rows.append({"cpi_country_name": name, "iso3": None, "match_type": "unresolved"})
    return pd.DataFrame(rows)


def build_cpi_features(cpi_xlsx, countries_csv, sheet_name="monthly"):
    crosswalk = build_name_to_iso3_crosswalk(cpi_xlsx, countries_csv, sheet_name)
    resolved = crosswalk[crosswalk["iso3"].notna()]

    cpi = pd.read_excel(cpi_xlsx, sheet_name=sheet_name)
    month_col = cpi.columns[0]
    cpi = cpi.rename(columns={month_col: "period_str"}).dropna(subset=["period_str"])

    # 'YYYYMmm' -> real calendar month timestamp
    cpi["month"] = pd.to_datetime(cpi["period_str"].str.replace("M", "-"), format="%Y-%m", errors="coerce")
    cpi = cpi.dropna(subset=["month"])

    rows = []
    for _, xwalk_row in resolved.iterrows():
        name, iso3 = xwalk_row["cpi_country_name"], xwalk_row["iso3"]
        if name not in cpi.columns:
            continue
        sub = cpi[["month", name]].rename(columns={name: "cpi_level"}).dropna(subset=["cpi_level"])
        sub["iso3"] = iso3
        rows.append(sub[["iso3", "month", "cpi_level"]])

    if not rows:
        return pd.DataFrame(columns=["iso3", "month", "cpi_level", "cpi_yoy_pct", "cpi_volatility_12m"]), crosswalk

    df = pd.concat(rows, ignore_index=True).sort_values(["iso3", "month"]).reset_index(drop=True)

    # Matched-calendar-month YoY: value(month) / value(same month, prior year) - 1.
    # Self-computed (not the pre-built SA-YoY file) per the approved decision -
    # nets out seasonality by construction since we compare identical calendar months.
    def _yoy(group):
        g = group.set_index("month")["cpi_level"]
        g_prior = g.copy()
        g_prior.index = g_prior.index + pd.DateOffset(years=1)
        aligned = g_prior.reindex(g.index)
        return ((g / aligned) - 1.0) * 100.0

    df = df.set_index("iso3")
    yoy_parts = []
    for iso3, group in df.groupby(level=0):
        yoy = _yoy(group.reset_index())
        yoy_parts.append(pd.DataFrame({"iso3": iso3, "month": yoy.index, "cpi_yoy_pct": yoy.values}))
    yoy_df = pd.concat(yoy_parts, ignore_index=True)

    df = df.reset_index().merge(yoy_df, on=["iso3", "month"], how="left")
    df = df.sort_values(["iso3", "month"]).reset_index(drop=True)
    df["cpi_volatility_12m"] = (
        df.groupby("iso3")["cpi_yoy_pct"]
        .rolling(window=12, min_periods=6)
        .std()
        .reset_index(level=0, drop=True)
    )
    return df, crosswalk
