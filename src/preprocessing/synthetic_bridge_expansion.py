"""Stage 1D - synthetic multi-bridge network expansion.

Adds 2 additional synthetic venues per corridor (USA->IND, GBR->PHL,
ARE->MEX), for 3 venues per corridor total. This is REQUIRED because the
approved Stage 1D audit found that with exactly 1 bridge/corridor, the
Dirichlet allocation action has no real intra-corridor competition and
multi-bridge routing/splitting cannot be learned.

Reuses the SAME OU/jump-diffusion machinery already validated in Stage 1B
(`synthetic_generator.generate_daily_series`) and the SAME real-conditioning
inputs (lagged corridor friction/speed, lagged destination macro risk) as
the existing #0 venue for that corridor - the new venues are not a
different/unrelated generator, they are the same mechanism applied with a
different base_capacity and a different master_seed offset (so their
trajectories are not copies of #0's).

Every new venue is explicitly tagged `synthetic_bridge_expansion` in the
daily parquet's `data_source_tag` column, and the existing 3 corridors'
#0 rows (and their tags: `real_rpw_derived` / `synthetic_no_real_anchor`
for ARE->MEX) are NEVER modified or relabeled.

Outputs (both APPENDED to, never overwritten/rewritten in place for
existing rows):
    data/structured/bridge_network.csv         (+6 rows, +bridge_uid col)
    data/processed/synthetic_liquidity_congestion_daily.parquet (+6 series)

Fee/capacity spread (ASSUMPTION, not measured, proposed and approved for
initial development):
    #0 (existing) - unchanged
    #1 (new) - ~30% cheaper fee, ~40% larger capacity  (cheap/large/slower)
    #2 (new) - ~50% pricier fee, ~25% smaller capacity (premium/small/faster)
"""
import os
import pandas as pd

from .synthetic_generator import generate_daily_series
from .split import SPLIT_BOUNDARIES, SEED, build_lagged_quarterly_dict, build_lagged_monthly_dict

CORRIDORS = [("USA", "IND"), ("GBR", "PHL"), ("ARE", "MEX")]
NEW_VENUE_TAG = "synthetic_bridge_expansion"

# (fee_multiplier, capacity_multiplier) for venues #1 and #2, applied to
# the existing #0 venue's fee/capacity for that corridor.
#
# CORRECTED (per required correction #4, discovered via
# regime_verification_report): the original design made the cheapest-fee
# venue ALSO the highest-capacity venue, which meant no amount under the
# frozen $500K regulatory cap could ever exceed that venue's liquidity
# alone - "splitting_needed"/"exceeds_combined" were then structurally
# UNREACHABLE regardless of generator logic, not just mislabeled. Fixed
# by making the cheapest-fee venue meaningfully SMALLER (genuine scarcity
# below the cap), while venue #0 (unchanged, real/original) remains the
# large-capacity option - so a policy has a genuine
# cheap-but-scarce vs. pricier-but-larger trade-off, and single-venue
# liquidity shortfall is actually reachable under the cap.
VENUE_MULTIPLIERS = {
    1: {"fee": 0.70, "capacity": 0.32},   # cheap / SMALL / creates real scarcity under the $500K cap
    2: {"fee": 1.50, "capacity": 0.18},   # premium / smallest / fastest, rarely the primary choice
}


def run(structured_dir="data/structured", processed_dir="data/processed"):
    bridge_csv_path = os.path.join(structured_dir, "bridge_network.csv")
    daily_parquet_path = os.path.join(processed_dir, "synthetic_liquidity_congestion_daily.parquet")
    rpw_path = os.path.join(processed_dir, "rpw_corridor_quarterly.parquet")
    are_mex_provenance_path = os.path.join(processed_dir, "are_mex_fallback_provenance.json")
    macro_risk_path = os.path.join(processed_dir, "macro_risk_proxy.parquet")
    norm_stats_path = os.path.join(processed_dir, "normalization_stats.json")

    bridge_df = pd.read_csv(bridge_csv_path)
    daily_df = pd.read_parquet(daily_parquet_path)
    rpw_df = pd.read_parquet(rpw_path)
    macro_risk_df = pd.read_parquet(macro_risk_path)

    import json
    with open(norm_stats_path) as f:
        norm_stats = json.load(f)

    # ARE->MEX real-conditioning fallback uses the same synthetic fallback
    # frame Stage 1B already built (not re-derived here) - regenerate it
    # via the same function used in run_stage1b.py, reusing its output
    # exactly, not a parallel implementation.
    from .are_mex_fallback import build_are_mex_fallback
    from .country_reference import build_country_reference_clean
    countries_clean = build_country_reference_clean(os.path.join(structured_dir, "countries.csv"))
    are_mex_fallback, _ = build_are_mex_fallback(rpw_df, countries_clean)

    sim_start = SPLIT_BOUNDARIES["train"][0]
    sim_end = SPLIT_BOUNDARIES["test"][1]
    date_range = pd.date_range(sim_start, sim_end, freq="D")

    # --- 1. Assign explicit bridge_uid to existing rows (#0), unchanged IDs ---
    # Existing bridge_network.csv rows are in the same order as CORRIDORS,
    # so their pre-existing auto-derived id ("SRC->TGT#idx") is reproduced
    # exactly as an explicit column - no behavior change for existing rows.
    bridge_df = bridge_df.reset_index(drop=True)
    bridge_df["bridge_uid"] = [
        f"{row.source_node}->{row.target_node}#0" for row in bridge_df.itertuples()
    ]
    bridge_df["data_source_tag"] = [
        "synthetic_no_real_anchor" if (row.source_node, row.target_node) == ("ARE", "MEX") else "real_static_bridge"
        for row in bridge_df.itertuples()
    ]

    new_bridge_rows = []
    new_daily_frames = []

    for (source, target) in CORRIDORS:
        existing_row = bridge_df[(bridge_df.source_node == source) & (bridge_df.target_node == target)].iloc[0]
        base_fee = float(existing_row["latency_fee_pct"])
        base_capacity = float(existing_row["liquidity_capacity"])
        bridge_id_0 = f"{source}->{target}#0"

        is_are_mex = (source, target) == ("ARE", "MEX")
        corridor_data = are_mex_fallback if is_are_mex else rpw_df[
            (rpw_df["source_code"] == source) & (rpw_df["destination_code"] == target)
        ]
        friction_dict = build_lagged_quarterly_dict(corridor_data, "corridor_friction")
        speed_dict = build_lagged_quarterly_dict(corridor_data, "corridor_baseline_speed_log1p")
        dest_iso = target
        macro_sub = macro_risk_df[macro_risk_df["iso3"] == dest_iso]
        risk_dict = build_lagged_monthly_dict(macro_sub)

        friction_stats = norm_stats["friction"][f"{source}->{target}"]
        risk_stats = norm_stats["risk"][dest_iso]

        for venue_idx in (1, 2):
            mult = VENUE_MULTIPLIERS[venue_idx]
            new_fee = round(base_fee * mult["fee"], 6)
            new_capacity = round(base_capacity * mult["capacity"], 2)
            bridge_uid = f"{source}->{target}#{venue_idx}"

            new_bridge_rows.append({
                "source_node": source, "target_node": target,
                "liquidity_capacity": new_capacity, "latency_fee_pct": new_fee,
                "bridge_uid": bridge_uid, "data_source_tag": NEW_VENUE_TAG,
            })

            series = generate_daily_series(
                bridge_id=bridge_uid,
                base_capacity=new_capacity,
                date_range=date_range,
                quarterly_friction=friction_dict,
                quarterly_speed_log1p=speed_dict,
                monthly_macro_risk=risk_dict,
                friction_mean=friction_stats["mean"], friction_std=friction_stats["std"],
                risk_mean=risk_stats["mean"], risk_std=risk_stats["std"],
                # Distinct seed offset per venue index so #1/#2 series are
                # not copies of #0's or of each other's.
                master_seed=SEED * 1000 + venue_idx,
                data_source_tag=NEW_VENUE_TAG,
            )
            new_daily_frames.append(series)

        # Also relabel the #0 bridge_id used inside the daily parquet to
        # match the new explicit bridge_uid scheme ("SRC->TGT#0" instead
        # of bare "SRC->TGT") - see note below on why this is necessary
        # and how existing Stage 1C code is kept compatible.

    # --- 2. Rename existing daily-parquet bridge_id values to the #0 scheme ---
    # Stage 1C's SLOT_BRIDGE_IDS used bare "USA->IND" etc. To keep Stage 1C
    # completely unmodified (frozen, per instruction), we do NOT rename the
    # existing rows' bridge_id in the daily parquet. Instead, new venues use
    # the "#N" suffix scheme and Stage 1D's own corridor slot map (see
    # dynamic_bridge_state.py) treats bare "SRC->TGT" as venue #0
    # implicitly. This preserves 100% Stage 1C compatibility.
    bridge_df_out = pd.concat([bridge_df.drop(columns=[]), pd.DataFrame(new_bridge_rows)], ignore_index=True)
    daily_df_out = pd.concat([daily_df] + new_daily_frames, ignore_index=True)

    bridge_df_out.to_csv(bridge_csv_path, index=False)
    daily_df_out.to_parquet(daily_parquet_path, index=False)

    return {
        "bridges_added": len(new_bridge_rows),
        "daily_rows_added": sum(len(f) for f in new_daily_frames),
        "total_bridges": len(bridge_df_out),
        "total_daily_rows": len(daily_df_out),
    }


if __name__ == "__main__":
    print(run())
