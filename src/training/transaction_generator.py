"""Stage 1D - synthetic transaction generator for PPO train/val/test.

Produces (transaction_id, sender, receiver, amount_usd, simulation_date,
split) rows. The 3-row data/structured/transaction_requests.csv fixture is
NEVER read or modified by this module - it remains a separate,
deterministic Stage 1A/1C integration-test fixture.

Amounts are regime-stratified (ASSUMPTION, not measured), not blindly
log-normal, so the generated dataset intentionally and verifiably
contains all four learning-relevant liquidity regimes relative to the
ACTUAL simulated liquidity at the sampled date (not a fixed number):

    1. below_cheapest   - amount < min(venue liquidity) at that date
    2. near_boundary    - amount within +/-15% of one venue's liquidity
    3. splitting_needed - amount > one venue's liquidity but <= combined
    4. exceeds_combined - amount > combined liquidity of all venues

Corridors: uniform over the 3 real corridors (not the synthetic
sub-venues - those are venue choices WITHIN a corridor, not separate
corridors). Dates: uniform over the requested split's interior date
range, excluding gap-buffer zones (reuses validate_simulation_date - no
new boundary logic). Seed 42, reused (not a new seed).
"""
import numpy as np
import pandas as pd

from ..envs.dynamic_bridge_state import get_dynamic_state
from ..models.stage1c_windowing import validate_simulation_date, InvalidSimulationDateError
from ..preprocessing.split import SPLIT_BOUNDARIES, GAP_BUFFER_DAYS, SEED

CORRIDORS = [("USA", "IND"), ("GBR", "PHL"), ("ARE", "MEX")]
CORRIDOR_VENUE_UIDS = {
    ("USA", "IND"): ["USA->IND#0", "USA->IND#1", "USA->IND#2"],
    ("GBR", "PHL"): ["GBR->PHL#0", "GBR->PHL#1", "GBR->PHL#2"],
    ("ARE", "MEX"): ["ARE->MEX#0", "ARE->MEX#1", "ARE->MEX#2"],
}
REGIMES = ["below_cheapest", "near_boundary", "splitting_needed", "exceeds_combined"]

# Explicit, deterministic per-split seed offsets - REQUIRED correction:
# Python's built-in hash() is randomized per-process by default
# (PYTHONHASHSEED), so hash(split_name) produced a DIFFERENT offset in
# every independent process, breaking cross-process reproducibility for
# the same seed=42. Fixed with explicit, stable integer offsets.
SPLIT_SEED_OFFSET = {"train": 0, "validation": 1, "test": 2}

# Static fees per venue (must match bridge_network.csv exactly - used
# only to determine fee-ordering for regime calibration, not re-derived
# from the CSV here to avoid a file-read per generated row).
VENUE_FEES = {
    "USA->IND#0": 0.015, "USA->IND#1": 0.0105, "USA->IND#2": 0.0225,
    "GBR->PHL#0": 0.02, "GBR->PHL#1": 0.014, "GBR->PHL#2": 0.03,
    "ARE->MEX#0": 0.012, "ARE->MEX#1": 0.0084, "ARE->MEX#2": 0.018,
}


def _valid_date_range_excluding_buffers(split_name, rng, n_candidates=2000):
    """Returns a pool of valid (non-gap-buffer) dates within the split,
    sampled candidate-then-filter (simple, deterministic given rng)."""
    start, end = SPLIT_BOUNDARIES[split_name]
    total_days = (end - start).days
    candidates = start + pd.to_timedelta(rng.integers(0, total_days + 1, size=n_candidates), unit="D")
    valid = []
    for d in candidates:
        try:
            validate_simulation_date(d)
            valid.append(d)
        except InvalidSimulationDateError:
            continue
    return valid


MAX_REGULATORY_TRANSFER_USD = 500000.0  # matches CogneeMemoryLayer's frozen constraint (cognee_layer.py) -
# amounts must stay under this or the transaction is blocked before routing ever happens, which would make
# a large fraction of "splitting_needed"/"exceeds_combined" regime transactions contribute zero learning
# signal (all-zero action every time, regardless of policy quality). NOT a change to the regulatory
# constraint itself - purely a generator-side adjustment so generated amounts land in the range the
# environment can actually route.
AMOUNT_SAFETY_MARGIN = 0.99


def _sample_amount(rng, regime, cheapest_fee_liquidity, combined_liquidity):
    """cheapest_fee_liquidity: the FEE-cheapest venue's current liquidity
    (what cheapest_feasible_action would actually use). combined_liquidity:
    sum of all 3 venues' current liquidity."""
    lo = cheapest_fee_liquidity
    combined = combined_liquidity
    cap = MAX_REGULATORY_TRANSFER_USD * AMOUNT_SAFETY_MARGIN

    if regime == "below_cheapest":
        amount = rng.uniform(0.05, 0.95) * lo
    elif regime == "near_boundary":
        # within +/-15% of the cheapest venue's liquidity
        amount = lo * rng.uniform(0.85, 1.15)
    elif regime == "splitting_needed":
        # exceeds the cheapest venue alone, fits within combined
        low_bound = lo * 1.05
        high_bound = min(combined * 0.95, cap)
        if high_bound <= low_bound:
            high_bound = min(low_bound * 1.5, cap)
        amount = rng.uniform(low_bound, max(high_bound, low_bound * 1.01))
    elif regime == "exceeds_combined":
        # Still "exceeds combined" in spirit (forces partial/unrouted
        # outcomes) but capped below the regulatory limit so the
        # transaction is actually processed by the router rather than
        # blocked outright. Uses the SMALLEST venue's liquidity as the
        # excess reference instead of combined, when combined*1.05 would
        # exceed the regulatory cap.
        reference = min(combined, cap / 1.05)
        amount = reference * rng.uniform(1.05, 1.3)
    else:
        raise ValueError(regime)

    return float(min(amount, cap))


def true_regime_for_row(sender, receiver, amount_usd, simulation_date):
    """Ground-truth regime classification for a single row, computed
    directly from ACTUAL dynamic liquidity at (corridor, simulation_date)
    - independent of whatever regime the generator intended when it
    picked the amount. Used to verify/relabel generated data rather than
    trust generation-time intent, per the required correction.

    NEAR_BOUNDARY_TOLERANCE: within +/-15% of the fee-cheapest venue's
    liquidity (matches the generator's own near_boundary sampling band).
    """
    corridor = (sender, receiver)
    venue_uids = CORRIDOR_VENUE_UIDS[corridor]
    venue_fees = [VENUE_FEES[uid] for uid in venue_uids]
    fee_order = sorted(range(3), key=lambda k: venue_fees[k])
    liquidities_fee_order = [get_dynamic_state(venue_uids[k], simulation_date)[0] for k in fee_order]
    cheapest_fee_liquidity = liquidities_fee_order[0]
    combined_liquidity = sum(liquidities_fee_order)

    if amount_usd > combined_liquidity:
        return "exceeds_combined"
    if 0.85 * cheapest_fee_liquidity <= amount_usd <= 1.15 * cheapest_fee_liquidity:
        return "near_boundary"
    if amount_usd > cheapest_fee_liquidity:
        return "splitting_needed"
    return "below_cheapest"


def verify_and_relabel_regimes(df):
    """Recomputes the ground-truth regime for every row and returns a
    copy of df with an added `regime_verified` column (the TRUE label)
    alongside the original `regime` column (the GENERATION-TIME intent).
    Does NOT silently overwrite `regime` - callers decide how to use the
    mismatch (see generate_all's reporting)."""
    df = df.copy()
    df["regime_verified"] = [
        true_regime_for_row(row["sender_country"], row["receiver_country"], row["amount_usd"], row["simulation_date"])
        for _, row in df.iterrows()
    ]
    return df


def regime_verification_report(df):
    """Returns a dict summarizing intended-vs-actual regime agreement,
    and specifically flags whether `exceeds_combined` is achievable at
    all under the current regulatory cap and network topology."""
    verified = verify_and_relabel_regimes(df)
    agreement = (verified["regime"] == verified["regime_verified"]).mean()
    true_counts = verified["regime_verified"].value_counts().to_dict()
    intended_counts = verified["regime"].value_counts().to_dict()
    mismatches_by_intended = {}
    for intended in REGIMES:
        sub = verified[verified["regime"] == intended]
        if len(sub) > 0:
            mismatches_by_intended[intended] = float((sub["regime"] != sub["regime_verified"]).mean())
    return {
        "n_rows": len(verified),
        "label_agreement_rate": float(agreement),
        "true_regime_counts": true_counts,
        "intended_regime_counts": intended_counts,
        "mismatch_rate_by_intended_regime": mismatches_by_intended,
        "exceeds_combined_true_count": int(true_counts.get("exceeds_combined", 0)),
        "exceeds_combined_achievable_under_cap": true_counts.get("exceeds_combined", 0) > 0,
    }


def generate_split(split_name, n_transactions, seed=SEED, start_id=100000):
    """Returns a pandas DataFrame of n_transactions generated rows for the
    given split ('train'/'validation'/'test')."""
    rng = np.random.default_rng(seed + SPLIT_SEED_OFFSET[split_name])
    valid_dates = _valid_date_range_excluding_buffers(split_name, rng)
    if not valid_dates:
        raise RuntimeError(f"No valid simulation dates found for split={split_name}")

    rows = []
    for i in range(n_transactions):
        corridor = CORRIDORS[rng.integers(0, len(CORRIDORS))]
        source, target = corridor
        sim_date = valid_dates[rng.integers(0, len(valid_dates))]

        venue_uids = CORRIDOR_VENUE_UIDS[corridor]
        # Sorted by FEE (matches cheapest_feasible_action's actual selection
        # logic), not by liquidity - see module docstring / fix note above.
        venue_fees = [VENUE_FEES[uid] for uid in venue_uids]
        fee_order = sorted(range(3), key=lambda k: venue_fees[k])
        liquidities_fee_order = [get_dynamic_state(venue_uids[k], sim_date)[0] for k in fee_order]
        # liquidities_fee_order[0] = cheapest-fee venue's liquidity - the
        # actual binding constraint for the cheapest_feasible baseline.
        cheapest_fee_liquidity = liquidities_fee_order[0]
        combined_liquidity = sum(liquidities_fee_order)

        regime = REGIMES[rng.integers(0, len(REGIMES))]
        amount = _sample_amount(rng, regime, cheapest_fee_liquidity, combined_liquidity)
        amount = max(amount, 1.0)  # floor to avoid degenerate zero/negative amounts

        rows.append({
            "transaction_id": start_id + i,
            "sender_country": source,
            "receiver_country": target,
            "amount_usd": round(amount, 2),
            "simulation_date": sim_date.strftime("%Y-%m-%d"),
            "intended_regime": regime,  # what the generator was targeting
            "regime": regime,  # placeholder, overwritten below with ground truth
        })

    df = pd.DataFrame(rows)
    # REQUIRED correction #4: overwrite `regime` with the GROUND-TRUTH
    # label verified against actual dynamic liquidity, not the
    # generation-time intent - exceeds_combined is never force-labeled
    # onto rows that don't actually satisfy the condition.
    df["regime"] = [
        true_regime_for_row(row["sender_country"], row["receiver_country"], row["amount_usd"], row["simulation_date"])
        for _, row in df.iterrows()
    ]
    return df


def generate_all(n_train=500, n_val=100, n_test=100, seed=SEED, out_dir="data/processed"):
    train_df = generate_split("train", n_train, seed=seed, start_id=100000)
    val_df = generate_split("validation", n_val, seed=seed, start_id=200000)
    test_df = generate_split("test", n_test, seed=seed, start_id=300000)

    reports = {
        name: regime_verification_report(df.rename(columns={"regime": "regime_check", "intended_regime": "regime"}))
        for name, df in (("train", train_df), ("validation", val_df), ("test", test_df))
    }

    train_df.to_csv(f"{out_dir}/stage1d_transactions_train.csv", index=False)
    val_df.to_csv(f"{out_dir}/stage1d_transactions_validation.csv", index=False)
    test_df.to_csv(f"{out_dir}/stage1d_transactions_test.csv", index=False)

    return train_df, val_df, test_df, reports


if __name__ == "__main__":
    train_df, val_df, test_df, reports = generate_all()
    for name, df in [("train", train_df), ("validation", val_df), ("test", test_df)]:
        print(name, len(df), "TRUE regime counts:", df["regime"].value_counts().to_dict())
        print("  mismatch (intended vs true):", reports[name]["mismatch_rate_by_intended_regime"])
        print("  exceeds_combined_achievable_under_cap:", reports[name]["exceeds_combined_achievable_under_cap"])
