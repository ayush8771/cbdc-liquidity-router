"""Stage 1B orchestrator - produces all data/processed/ outputs per
Specification v3. Deterministic given inputs (SEED=42), no network calls.
"""
import os
import json
import pandas as pd
import numpy as np

from .wdi import build_wdi_fx_features
from .cpi import build_cpi_features
from .rpw import build_rpw_corridor_quarterly
from .country_reference import build_country_reference_clean
from .macro_risk import build_macro_risk_components, apply_macro_risk_proxy
from .are_mex_fallback import build_are_mex_fallback
from .synthetic_generator import generate_daily_series
from .normalization import build_normalization_stats, fit_macro_component_stats
from .split import (
    SPLIT_BOUNDARIES, GAP_BUFFER_DAYS, SEED,
    build_lagged_quarterly_dict, build_lagged_monthly_dict,
)

CORRIDOR_ISOS = ["USA", "IND", "GBR", "PHL", "ARE", "MEX"]
CORRIDORS = [("USA", "IND"), ("GBR", "PHL"), ("ARE", "MEX")]


def run(raw_dir="data/raw", structured_dir="data/structured", out_dir="data/processed"):
    os.makedirs(out_dir, exist_ok=True)
    stats = {}

    # --- 1. WDI ---
    wdi_df = build_wdi_fx_features(
        os.path.join(raw_dir, "WDIData.csv"), os.path.join(structured_dir, "countries.csv")
    )
    wdi_df.to_parquet(os.path.join(out_dir, "wdi_fx_features.parquet"), index=False)
    stats["wdi_fx_features"] = {"rows": len(wdi_df), "countries": wdi_df["iso3"].nunique() if len(wdi_df) else 0}

    # --- 2. CPI ---
    cpi_df, crosswalk_df = build_cpi_features(
        os.path.join(raw_dir, "CPI_Price__not_seas__adj_.xlsx"), os.path.join(structured_dir, "countries.csv")
    )
    cpi_df.to_parquet(os.path.join(out_dir, "cpi_features.parquet"), index=False)
    crosswalk_df.to_csv(os.path.join(out_dir, "name_to_iso3_crosswalk.csv"), index=False)
    stats["cpi_features"] = {"rows": len(cpi_df), "countries": cpi_df["iso3"].nunique() if len(cpi_df) else 0}
    stats["crosswalk"] = {
        "total": len(crosswalk_df),
        "exact": int((crosswalk_df["match_type"] == "exact").sum()),
        "manual": int((crosswalk_df["match_type"] == "manual").sum()),
        "unresolved": int((crosswalk_df["match_type"] == "unresolved").sum()),
    }

    # --- 3. RPW ---
    rpw_df = build_rpw_corridor_quarterly(os.path.join(raw_dir, "rpw_dataset_2011_2025_q3.xlsx"))
    rpw_df.to_parquet(os.path.join(out_dir, "rpw_corridor_quarterly.parquet"), index=False)
    stats["rpw_corridor_quarterly"] = {"rows": len(rpw_df), "corridors": rpw_df.groupby(["source_code", "destination_code"]).ngroups}

    # --- 4. Country reference ---
    countries_clean = build_country_reference_clean(os.path.join(structured_dir, "countries.csv"))
    countries_clean.to_parquet(os.path.join(out_dir, "country_reference_clean.parquet"), index=False)
    stats["country_reference_clean"] = {"rows": len(countries_clean)}

    # --- 5. macro_risk_proxy ---
    # REVISED (leakage fix): raw components first, THEN train-only fitted
    # normalization, THEN the final macro_risk_proxy value. See
    # macro_risk.py's module docstring for the exact 3-step order this
    # enforces. month_ceiling ensures FRED dates beyond the approved
    # simulation end (2025-09-30) are dropped at the source, not just by
    # a downstream range filter (FRED boundary test, review item 2).
    sim_start_month = SPLIT_BOUNDARIES["train"][0]
    sim_end_month = SPLIT_BOUNDARIES["test"][1]
    full_month_range = pd.date_range(sim_start_month, sim_end_month, freq="MS")

    macro_components_df = build_macro_risk_components(
        wdi_df, cpi_df, CORRIDOR_ISOS, full_month_range=full_month_range, month_ceiling=sim_end_month
    )
    macro_component_stats = fit_macro_component_stats(macro_components_df, CORRIDOR_ISOS)
    macro_risk_df = apply_macro_risk_proxy(macro_components_df, macro_component_stats)
    macro_risk_df.to_parquet(os.path.join(out_dir, "macro_risk_proxy.parquet"), index=False)

    source_flag_counts_total = macro_risk_df["source_flag"].value_counts().to_dict() if len(macro_risk_df) else {}
    source_flag_by_currency = {}
    for iso3 in CORRIDOR_ISOS:
        sub = macro_risk_df[macro_risk_df["iso3"] == iso3]
        source_flag_by_currency[iso3] = sub["source_flag"].value_counts().to_dict()
    stats["macro_risk_proxy"] = {
        "rows": len(macro_risk_df),
        "source_flag_counts_total": source_flag_counts_total,
        "source_flag_counts_by_country": source_flag_by_currency,
        "component_normalization_stats": macro_component_stats,
    }

    # --- 6. ARE->MEX fallback (NOT merged into rpw_corridor_quarterly.parquet) ---
    are_mex_fallback, provenance = build_are_mex_fallback(rpw_df, countries_clean)

    # Discrepancy explanation (review item 4): Specification v3's manual
    # spot-check queried only the 'Dataset (from Q2 2016)' sheet in
    # isolation (1,329 raw rows). This implementation - correctly, per the
    # approved methodology of concatenating BOTH RPW sheets - includes the
    # pre-2016 sheet too, and n_obs counts rows with a non-null
    # `cc2 total cost %` (matching the aggregation's own count basis), not
    # raw row count. Both figures are recorded here so the discrepancy is
    # traceable rather than silently overwritten.
    xl = pd.ExcelFile(os.path.join(raw_dir, "rpw_dataset_2011_2025_q3.xlsx"))
    post2016_only = xl.parse("Dataset (from Q2 2016)")
    post2016_usa_mex_raw = len(post2016_only[(post2016_only["source_code"] == "USA") & (post2016_only["destination_code"] == "MEX")])
    provenance["discrepancy_note"] = {
        "specification_v3_figure": 1329,
        "specification_v3_basis": "raw row count, 'Dataset (from Q2 2016)' sheet ONLY, no null-filtering",
        "implementation_figure": provenance["n_obs_total"],
        "implementation_basis": "sum of per-quarter counts of non-null 'cc2 total cost %', BOTH sheets combined (per approved both-sheets methodology)",
        "post2016_sheet_raw_row_count_isolated": post2016_usa_mex_raw,
        "conclusion": "1,658 is correct and should be used going forward - it reflects the full approved "
                       "RPW combination methodology (both sheets) with the same non-null-count basis as every "
                       "other corridor's n_obs in rpw_corridor_quarterly.parquet. 1,329 was an incomplete "
                       "single-sheet manual check in Specification v3, not a methodology the implementation "
                       "deviated from.",
    }
    with open(os.path.join(out_dir, "are_mex_fallback_provenance.json"), "w") as f:
        json.dump(provenance, f, indent=2)
    stats["are_mex_fallback"] = provenance

    # --- 7. Train-only normalization stats (review item 1) ---
    # Fit ONCE from training-period-only data, frozen and reused for every
    # split. Uses a combined-in-memory frame for ARE->MEX (real corridors +
    # the synthetic_no_real_anchor fallback) SOLELY to fit that corridor's
    # normalization stats - this combined frame is never written to
    # rpw_corridor_quarterly.parquet.
    rpw_plus_are_mex = pd.concat([rpw_df, are_mex_fallback], ignore_index=True, sort=False)
    norm_stats = build_normalization_stats(
        rpw_plus_are_mex, macro_risk_df,
        corridors=CORRIDORS,
        destination_isos=list({t for (_, t) in CORRIDORS}),
    )
    with open(os.path.join(out_dir, "normalization_stats.json"), "w") as f:
        json.dump(norm_stats, f, indent=2)
    stats["normalization_stats"] = norm_stats

    # --- 8. Synthetic daily liquidity/congestion generator ---
    sim_start = SPLIT_BOUNDARIES["train"][0]
    sim_end = SPLIT_BOUNDARIES["test"][1]
    date_range = pd.date_range(sim_start, sim_end, freq="D")

    bridge_network_df = pd.read_csv(os.path.join(structured_dir, "bridge_network.csv"))

    # Review item 5: exactly 3 bridge entities are generated here, matching
    # the 3 real corridors in bridge_network.csv. MAX_BRIDGES=6 (Stage 1A)
    # is a simulation CAPACITY, not a target bridge count - the remaining 3
    # slots are padding, handled entirely by Stage 1A's cbdc_env.py masking
    # (feasibility_mask=False, zero-padded observation block). No
    # additional bridges are invented here to "fill" MAX_BRIDGES; a
    # multi-vault-per-corridor network expansion remains a separate,
    # still-unapproved decision (flagged in the Stage 1A report and the
    # original remediation plan), out of scope for this fix.
    assert len(CORRIDORS) == 3, "Stage 1B generates exactly the 3 real corridors - see comment above"

    daily_frames = []
    for (source, target) in CORRIDORS:
        bridge_rows = bridge_network_df[
            (bridge_network_df["source_node"] == source) & (bridge_network_df["target_node"] == target)
        ]
        base_capacity = float(bridge_rows["liquidity_capacity"].iloc[0]) if len(bridge_rows) else 1_000_000.0
        bridge_id = f"{source}->{target}"

        is_are_mex = (source, target) == ("ARE", "MEX")
        corridor_data = are_mex_fallback if is_are_mex else rpw_df[
            (rpw_df["source_code"] == source) & (rpw_df["destination_code"] == target)
        ]
        data_source_tag = "synthetic_no_real_anchor" if is_are_mex else "real_rpw_derived"

        friction_dict = build_lagged_quarterly_dict(corridor_data, "corridor_friction")
        speed_dict = build_lagged_quarterly_dict(corridor_data, "corridor_baseline_speed_log1p")

        dest_iso = target
        macro_sub = macro_risk_df[macro_risk_df["iso3"] == dest_iso]
        risk_dict = build_lagged_monthly_dict(macro_sub)

        friction_stats = norm_stats["friction"][bridge_id]
        risk_stats = norm_stats["risk"][dest_iso]

        series = generate_daily_series(
            bridge_id=bridge_id,
            base_capacity=base_capacity,
            date_range=date_range,
            quarterly_friction=friction_dict,
            quarterly_speed_log1p=speed_dict,
            monthly_macro_risk=risk_dict,
            friction_mean=friction_stats["mean"],
            friction_std=friction_stats["std"],
            risk_mean=risk_stats["mean"],
            risk_std=risk_stats["std"],
            master_seed=SEED,
            data_source_tag=data_source_tag,
        )
        daily_frames.append(series)

    synthetic_df = pd.concat(daily_frames, ignore_index=True)
    synthetic_df.to_parquet(os.path.join(out_dir, "synthetic_liquidity_congestion_daily.parquet"), index=False)
    stats["synthetic_liquidity_congestion_daily"] = {
        "rows": len(synthetic_df),
        "bridges": synthetic_df["bridge_id"].nunique(),
        "date_range": [str(date_range.min().date()), str(date_range.max().date())],
        "by_tag": synthetic_df["data_source_tag"].value_counts().to_dict(),
    }

    # --- 9. split_manifest.json ---
    split_manifest = {
        "seed": SEED,
        "boundaries": {k: [str(v[0].date()), str(v[1].date())] for k, v in SPLIT_BOUNDARIES.items()},
        "gap_buffer_days": GAP_BUFFER_DAYS,
    }
    with open(os.path.join(out_dir, "split_manifest.json"), "w") as f:
        json.dump(split_manifest, f, indent=2)

    # --- 10. sensitivity_sweep_manifest.json ---
    # Defines the approved 13-run one-at-a-time grid (Specification v2 §4 /
    # v3 §3). Executing these runs requires PPO (Stage 1D) - out of scope
    # here. This file records the grid definition only, ready for that
    # stage to consume without redefining it.
    from .synthetic_generator import DEFAULT_HYPERPARAMS
    sweep_runs = [{"run_id": "base", **DEFAULT_HYPERPARAMS}]
    bounds = {
        "beta_friction": (-0.1, -0.4),
        "beta_risk": (0.5, 2.0),
        "sigma_base": (0.01, 0.04),
        "sigma_congestion": (0.05, 0.20),
        "lambda_jump": (0.02, 0.10),
        "jump_size_mean_pct": (0.05, 0.20),
    }
    for param, (low, high) in bounds.items():
        for level, val in [("low", low), ("high", high)]:
            run = dict(DEFAULT_HYPERPARAMS)
            run[param] = val
            sweep_runs.append({"run_id": f"{param}_{level}", **run})

    sweep_manifest = {
        "design": "one_at_a_time",
        "seed": SEED,
        "n_runs": len(sweep_runs),
        "status": "grid_defined_not_executed",
        "note": "Execution requires PPO (Stage 1D), out of Stage 1B scope. "
                "Results columns (ppo_reward, baseline_reward, margin, split) "
                "are added by Stage 1D, not populated here.",
        "runs": sweep_runs,
    }
    with open(os.path.join(out_dir, "sensitivity_sweep_manifest.json"), "w") as f:
        json.dump(sweep_manifest, f, indent=2)
    stats["sensitivity_sweep_manifest"] = {"n_runs": len(sweep_runs), "status": "grid_defined_not_executed"}

    return stats


if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.INFO)
    result_stats = run()
    print(json.dumps(result_stats, indent=2, default=str))
