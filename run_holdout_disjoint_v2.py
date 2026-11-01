"""Date-disjoint holdout v2: excludes the dates of BOTH examined sets.

Run from the repository root:
    python run_holdout_disjoint_v2.py

Draws rows with the existing generator (generate_split, "test" window, seed
HOLDOUT_SEED; the generator is unchanged) and keeps, in generation order, only rows
whose simulation_date appears in NEITHER examined set:
  - the original test split (data/processed/stage1d_transactions_test.csv)
  - the previously evaluated 500-row holdout (seed 20261102)
until 500 rows are kept. The excluded set is the UNION of their dates, in any corridor.

It evaluates the six multi-seed checkpoints with the three policies through
run_holdout_evaluation.evaluate_checkpoint / aggregate, which are unchanged; only their
HOLDOUT_CSV module attribute is pointed at the new file. It documents the remaining
30-day history-window overlap with each examined set, and also with the
seed-20261103 date-disjoint holdout (which only excluded test dates).

No training, tuning, or model/environment/reward/checkpoint changes.
Outputs: outputs/experiments/stage1d_holdout_datedisjoint_v2_eval_<timestamp>/
"""

from __future__ import annotations

import io
import json
from datetime import datetime
from pathlib import Path

import pandas as pd

import run_holdout_evaluation as rhe
import run_holdout_overlap_analysis as rhoa
from src.training.transaction_generator import generate_split

HOLDOUT_SEED = 20261104
HOLDOUT_N = 500
DRAW = 3000                     # rows drawn before filtering (generation order preserved)
START_ID = 600000
HOLDOUT_CSV = Path(f"data/processed/stage1d_transactions_holdout_datedisjoint_v2_seed{HOLDOUT_SEED}.csv")

TEST_CSV = Path("data/processed/stage1d_transactions_test.csv")
HOLDOUT1_CSV = Path("data/processed/stage1d_transactions_holdout_seed20261102.csv")
HOLDOUT2_CSV = Path("data/processed/stage1d_transactions_holdout_datedisjoint_seed20261103.csv")
EXAMINED = {"test_split": TEST_CSV, "holdout_seed20261102": HOLDOUT1_CSV}
EXISTING = [Path(f"data/processed/stage1d_transactions_{s}.csv") for s in ("train", "validation", "test")] \
    + [HOLDOUT1_CSV, HOLDOUT2_CSV]


def make_holdout():
    before = {str(p): rhoa._sha(p) for p in EXISTING}
    examined = {k: pd.read_csv(p) for k, p in EXAMINED.items()}
    excluded = set().union(*(set(df.simulation_date) for df in examined.values()))

    drawn = generate_split("test", DRAW, seed=HOLDOUT_SEED, start_id=START_ID)
    keep = drawn[~drawn.simulation_date.isin(excluded)]
    if len(keep) < HOLDOUT_N:
        raise RuntimeError(f"only {len(keep)} disjoint rows in {DRAW} draws")
    df = keep.head(HOLDOUT_N).reset_index(drop=True)
    if HOLDOUT_CSV.exists():
        if not pd.read_csv(io.StringIO(df.to_csv(index=False))).equals(pd.read_csv(HOLDOUT_CSV)):
            raise FileExistsError(f"{HOLDOUT_CSV} exists and differs; refusing to overwrite")
        reused = True
    else:
        df.to_csv(HOLDOUT_CSV, index=False)
        reused = False
    assert before == {str(p): rhoa._sha(p) for p in EXISTING}, "existing datasets changed"
    assert not df.simulation_date.isin(excluded).any()

    others = pd.concat([pd.read_csv(p).assign(source=p.stem) for p in EXISTING])
    key = ["sender_country", "receiver_country", "simulation_date", "amount_usd"]
    dups = df[key + ["transaction_id"]].merge(others[key + ["transaction_id", "source"]], on=key,
                                              suffixes=("_holdout", "_existing"))
    last = int(keep.index[HOLDOUT_N - 1])
    return df, examined, {
        "generator": "src.training.transaction_generator.generate_split (unchanged)", "window": "test",
        "seed": HOLDOUT_SEED, "rows_drawn": DRAW, "rows_kept": HOLDOUT_N,
        "draws_consumed_to_reach_n": last + 1, "rows_rejected_before_n": last + 1 - HOLDOUT_N,
        "filter": "simulation_date not in the UNION of dates of the test split and holdout seed20261102 (any corridor)",
        "excluded_dates": {"test_split": int(examined["test_split"].simulation_date.nunique()),
                           "holdout_seed20261102": int(examined["holdout_seed20261102"].simulation_date.nunique()),
                           "union": len(excluded)},
        "distinct_dates_used": int(df.simulation_date.nunique()), "start_id": START_ID,
        "path": str(HOLDOUT_CSV), "sha256": rhoa._sha(HOLDOUT_CSV), "file_reused_after_identity_check": reused,
        "existing_datasets_sha256_unchanged": before,
        "date_range": [df.simulation_date.min(), df.simulation_date.max()],
        "true_regime_counts": df.regime.value_counts().to_dict(),
        "intended_regime_counts": df.intended_regime.value_counts().to_dict(),
        "corridor_counts": (df.sender_country + "->" + df.receiver_country).value_counts().to_dict(),
        "exact_duplicate_rows_with_existing": dups.to_dict(orient="records"),
        "rows_sharing_any_date_with": {p.stem: int(df.simulation_date.isin(pd.read_csv(p).simulation_date).sum())
                                       for p in EXISTING},
    }


def main():
    pd.set_option("display.width", 250, "display.max_columns", 40)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out = Path("outputs/experiments") / f"stage1d_holdout_datedisjoint_v2_eval_{ts}"
    out.mkdir(parents=True, exist_ok=False)

    df, examined, hprov = make_holdout()
    print("holdout:", json.dumps({k: hprov[k] for k in ("excluded_dates", "draws_consumed_to_reach_n", "distinct_dates_used",
                                                       "true_regime_counts", "rows_sharing_any_date_with")}), flush=True)

    # Remaining 30-day history overlap, against each examined set, their union, and the seed-20261103 holdout.
    refs = {**examined, "union_test_and_holdout_seed20261102": pd.concat(examined.values()),
            "holdout_datedisjoint_seed20261103": pd.read_csv(HOLDOUT2_CSV)}
    overlap = {}
    per_row = df.copy()
    for name, ref in refs.items():
        o = rhoa.overlap_columns(df, ref)
        overlap[name] = rhoa.overlap_summary(o)
        for c in ("shares_date_with_test", "shares_corridor_date_with_test", "window_overlap_days_same_corridor",
                  "days_to_nearest_test_date_same_corridor"):
            per_row[f"{name}__{c.replace('_test', '_ref')}"] = o[c].values
    per_row.to_csv(out / "holdout_overlap_per_row.csv", index=False)
    u = "union_test_and_holdout_seed20261102"
    assert overlap[u]["rows_sharing_date_with_test"] == 0

    specs = [(f"seed{s}_{c}", s, coef, rhe.MULTISEED_DIR / f"seed{s}" / c / "ppo_checkpoint.pt")
             for s in rhe.SEEDS for c, coef in rhe.CONDITIONS]
    prov = rhoa.common_provenance(ts, "stage1d_holdout_datedisjoint_v2_evaluation")
    prov["code_sha256"]["run_holdout_disjoint_v2.py"] = rhoa._sha("run_holdout_disjoint_v2.py")
    prov["code_git_blob"]["run_holdout_disjoint_v2.py"] = rhoa._git("hash-object", "run_holdout_disjoint_v2.py")
    prov.update({"holdout": hprov, "policies": list(rhe.POLICIES), "overlap_reference_sets": list(refs),
                 "evaluation_function": "run_holdout_evaluation.evaluate_checkpoint (HOLDOUT_CSV attribute pointed at this holdout)",
                 "checkpoints": [{"label": l, "seed": s, "entropy_coef": c, "checkpoint": str(ck), "sha256": rhoa._sha(ck)}
                                 for l, s, c, ck in specs]})
    rhoa._save(out / "provenance.json", prov)

    original = rhe.HOLDOUT_CSV
    rhe.HOLDOUT_CSV = HOLDOUT_CSV
    try:
        frames = []
        for label, seed, coef, ck in specs:
            print(f"  evaluating {label} ...", flush=True)
            frames.append(rhe.evaluate_checkpoint(label, ck).assign(seed=seed, entropy_coef=coef))
    finally:
        rhe.HOLDOUT_CSV = original
    per_tx = pd.concat(frames, ignore_index=True).merge(
        per_row[["transaction_id", f"{u}__window_overlap_days_same_corridor"]], on="transaction_id", how="left")
    per_tx.to_csv(out / "per_transaction.csv", index=False)
    overall, by_regime, paired = rhoa.write_tables(out, per_tx)

    tol = rhe.RELATIVE_UNROUTED_TOLERANCE
    gap = (per_tx.env_unrouted - per_tx.amount_unrouted).abs()
    checks = {
        "n_rows": len(per_tx), "rejected_rows": int(per_tx.rejected.sum()),
        "env_vs_amount_completion_disagree_rows": {f"{p}|{r}": int(n) for (p, r), n in per_tx[
            per_tx.env_completed != per_tx.amount_completed].groupby(["policy", "regime"]).size().items()},
        "env_vs_amount_unrouted_material_rows": {f"{p}|{r}": int(n) for (p, r), n in per_tx[
            gap > tol * per_tx.amount].groupby(["policy", "regime"]).size().items()},
        "max_over_executed_usd": float(per_tx.over_executed.max()),
        "waterfall_identical_across_checkpoints": bool(
            per_tx[per_tx.policy == "liquidity_waterfall"].groupby("row_index").reward.nunique().max() == 1),
    }
    rhoa._save(out / "summary.json", {
        "holdout": {k: hprov[k] for k in ("seed", "rows_kept", "excluded_dates", "draws_consumed_to_reach_n",
                                         "distinct_dates_used", "date_range", "true_regime_counts", "corridor_counts")},
        "history_overlap": overlap, "overall": overall.to_dict(orient="records"),
        "by_regime": by_regime.to_dict(orient="records"), "paired": paired, "checks": checks})

    rhoa._print("DATE-DISJOINT v2 HOLDOUT (excludes test + holdout seed20261102 dates)", overall.to_dict(orient="records"),
                by_regime.to_dict(orient="records"))
    print("\noverlap:", json.dumps(overlap))
    print("paired:", json.dumps(paired), "\nchecks:", json.dumps(checks))
    print(f"\nOutputs: {out.resolve()}")


if __name__ == "__main__":
    main()
