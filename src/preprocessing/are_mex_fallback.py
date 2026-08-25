"""ARE->MEX fallback (Stage 1B Specification v3 §4).

RPW has zero observations for ARE->MEX. This module finds a real
substitute corridor via a 3-tier defensible-similarity search and
returns its values, TAGGED synthetic_no_real_anchor. These values are
NEVER written into rpw_corridor_quarterly.parquet as if they were real
ARE->MEX RPW rows - see run_stage1b.py.
"""
import pandas as pd


def find_tier1_exact_destination_match(rpw_corridor_quarterly, destination_iso3):
    """Corridors with an exact destination match, any source."""
    matches = rpw_corridor_quarterly[rpw_corridor_quarterly["destination_code"] == destination_iso3]
    return matches


def find_tier2_income_group_match(rpw_corridor_quarterly, countries_clean, source_iso3, destination_iso3):
    income_map = dict(zip(countries_clean["ISO 3166-1 alpha-3 country code"], countries_clean["Income Group"]))
    src_income = income_map.get(source_iso3)
    dst_income = income_map.get(destination_iso3)
    if src_income is None or dst_income is None:
        return pd.DataFrame()

    df = rpw_corridor_quarterly.copy()
    df["src_income"] = df["source_code"].map(income_map)
    df["dst_income"] = df["destination_code"].map(income_map)
    return df[(df["src_income"] == src_income) & (df["dst_income"] == dst_income)]


def build_are_mex_fallback(rpw_corridor_quarterly, countries_clean, min_corridors_tier2=5):
    """Returns (fallback_df, provenance_dict). fallback_df has the same
    columns as rpw_corridor_quarterly (source/destination overwritten to
    ARE/MEX) but is NEVER merged into the real RPW output file."""
    tier1 = find_tier1_exact_destination_match(rpw_corridor_quarterly, "MEX")

    if not tier1.empty:
        chosen_source = tier1["source_code"].value_counts().idxmax()
        n_obs_total = int(tier1[tier1["source_code"] == chosen_source]["n_obs"].sum())
        chosen = tier1[tier1["source_code"] == chosen_source].copy()
        tier_used = "tier1_exact_destination_match"
        provenance = {
            "tier_used": tier_used,
            "substitute_corridor": f"{chosen_source}->MEX",
            "n_obs_total": n_obs_total,
            "n_corridor_quarters": len(chosen),
        }
    else:
        tier2 = find_tier2_income_group_match(rpw_corridor_quarterly, countries_clean, "ARE", "MEX")
        if len(tier2["source_code"].unique()) >= min_corridors_tier2:
            grouped = tier2.groupby(["year", "quarter"]).agg(
                corridor_friction=("corridor_friction", "median"),
                real_cost_baseline=("real_cost_baseline", "median"),
                corridor_baseline_speed_hours=("corridor_baseline_speed_hours", "median"),
                corridor_baseline_speed_log1p=("corridor_baseline_speed_log1p", "median"),
                n_obs=("n_obs", "sum"),
            ).reset_index()
            chosen = grouped
            tier_used = "tier2_income_group_median"
            provenance = {
                "tier_used": tier_used,
                "n_source_corridors": len(tier2["source_code"].unique()),
                "n_obs_total": int(tier2["n_obs"].sum()),
            }
        else:
            grouped = rpw_corridor_quarterly.groupby(["year", "quarter"]).agg(
                corridor_friction=("corridor_friction", "median"),
                real_cost_baseline=("real_cost_baseline", "median"),
                corridor_baseline_speed_hours=("corridor_baseline_speed_hours", "median"),
                corridor_baseline_speed_log1p=("corridor_baseline_speed_log1p", "median"),
                n_obs=("n_obs", "sum"),
            ).reset_index()
            chosen = grouped
            tier_used = "tier3_global_median"
            provenance = {"tier_used": tier_used, "n_obs_total": int(rpw_corridor_quarterly["n_obs"].sum())}

    fallback = chosen.copy()
    fallback["source_code"] = "ARE"
    fallback["destination_code"] = "MEX"
    fallback["data_source_tag"] = "synthetic_no_real_anchor"
    cols = ["source_code", "destination_code", "year", "quarter", "corridor_friction",
            "real_cost_baseline", "corridor_baseline_speed_hours", "corridor_baseline_speed_log1p",
            "n_obs", "data_source_tag"]
    fallback = fallback[[c for c in cols if c in fallback.columns]]

    return fallback, provenance
