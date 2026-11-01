"""Holdout overlap analysis: sensitivity check (option 1) + date-disjoint holdout (option 2).

Run from the repository root:
    python run_holdout_overlap_analysis.py

Option 1 - sensitivity (no re-evaluation): re-aggregates the saved per-transaction
results of the authoritative holdout run (HOLDOUT_RUN) on three subsets:
    full                        all 500 holdout rows
    excl_shared_corridor_date   rows whose (corridor, date) is not in the examined test split
    excl_shared_date            rows whose date is not in the examined test split (any corridor)

Option 2 - date-disjoint holdout: draws rows with the existing generator
(generate_split, "test" window, new seed) and keeps, in generation order, only
rows whose simulation_date is NOT a date of the examined test split (any
corridor), until 500 are kept. The generator itself is unchanged; filtering
is applied after generation. The six checkpoints are then evaluated with
the three policies using run_holdout_evaluation.evaluate_checkpoint /
aggregate (unchanged; only its HOLDOUT_CSV module attribute is pointed at
the new file).

Historical-window overlap is documented for every row: the 30-day history
windows of two dates in the same corridor share max(0, 30 - |days apart|)
days. Only 2024-02-01..2025-08-30 has data and valid dates, so this overlap
cannot be removed without extending the data.

No training, tuning, or model/environment/reward/checkpoint changes.
"""

from __future__ import annotations

import hashlib
import json
import platform
import subprocess
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import torch

import run_holdout_evaluation as rhe
from src.models.stage1c_windowing import SEQUENCE_LENGTH
from src.training.transaction_generator import generate_split

TEST_CSV = Path("data/processed/stage1d_transactions_test.csv")
HOLDOUT_RUN = Path("outputs/experiments/stage1d_holdout_eval_20261101_225445")
HOLDOUT1_CSV = Path("data/processed/stage1d_transactions_holdout_seed20261102.csv")

DISJOINT_SEED = 20261103
DISJOINT_N = 500
DISJOINT_DRAW = 2000            # rows drawn before filtering (generation order preserved)
DISJOINT_START_ID = 500000
DISJOINT_CSV = Path(f"data/processed/stage1d_transactions_holdout_datedisjoint_seed{DISJOINT_SEED}.csv")
EXISTING = [Path(f"data/processed/stage1d_transactions_{s}.csv") for s in ("train", "validation", "test")] + [HOLDOUT1_CSV]


def _sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def _git(*args):
    try:
        return subprocess.check_output(["git", *args], text=True).strip()
    except Exception:
        return None


def _save(path, obj):
    path.write_text(json.dumps(obj, indent=2, default=lambda v: v.item() if hasattr(v, "item") else str(v)),
                    encoding="utf-8")


def overlap_columns(df, test):
    """Per-row overlap with the examined test split."""
    t = test.assign(d=pd.to_datetime(test.simulation_date), corridor=test.sender_country + "->" + test.receiver_country)
    by_corr = {c: np.sort(g.d.values) for c, g in t.groupby("corridor")}
    all_dates = np.sort(t.d.unique())
    corr = df.sender_country + "->" + df.receiver_country
    d = pd.to_datetime(df.simulation_date).values
    near_any = np.array([np.abs((all_dates - x).astype("timedelta64[D]").astype(int)).min() for x in d])
    near_corr = np.array([np.abs((by_corr[c] - x).astype("timedelta64[D]").astype(int)).min() if c in by_corr else 10**6
                          for c, x in zip(corr, d)])
    keys = set(zip(t.corridor, test.simulation_date))
    return df.assign(
        corridor=corr,
        shares_corridor_date_with_test=[k in keys for k in zip(corr, df.simulation_date)],
        shares_date_with_test=df.simulation_date.isin(set(test.simulation_date)),
        days_to_nearest_test_date_any_corridor=near_any,
        days_to_nearest_test_date_same_corridor=near_corr,
        window_overlap_days_same_corridor=np.clip(SEQUENCE_LENGTH - near_corr, 0, SEQUENCE_LENGTH),
    )


def overlap_summary(df):
    w = df.window_overlap_days_same_corridor
    return {
        "n": len(df),
        "rows_sharing_corridor_date_with_test": int(df.shares_corridor_date_with_test.sum()),
        "rows_sharing_date_with_test": int(df.shares_date_with_test.sum()),
        "rows_with_any_30d_window_overlap_same_corridor": int((w > 0).sum()),
        "window_overlap_days_same_corridor": {"mean": float(w.mean()), "median": float(w.median()),
                                              "max": int(w.max()), "share_of_window_mean": float(w.mean() / SEQUENCE_LENGTH)},
        "days_to_nearest_test_date_same_corridor": {"min": int(df.days_to_nearest_test_date_same_corridor.min()),
                                                    "median": float(df.days_to_nearest_test_date_same_corridor.median())},
        "days_to_nearest_test_date_any_corridor": {"min": int(df.days_to_nearest_test_date_any_corridor.min()),
                                                   "median": float(df.days_to_nearest_test_date_any_corridor.median())},
    }


def write_tables(out_dir, per_tx, tag=""):
    per_ckpt, per_ckpt_regime, overall, by_regime = rhe.aggregate(per_tx)
    per_ckpt.to_csv(out_dir / f"metrics_per_checkpoint{tag}.csv", index=False)
    per_ckpt_regime.to_csv(out_dir / f"metrics_per_checkpoint_regime{tag}.csv", index=False)
    overall.to_csv(out_dir / f"metrics_overall_across_checkpoints{tag}.csv", index=False)
    by_regime.to_csv(out_dir / f"metrics_by_regime_across_checkpoints{tag}.csv", index=False)
    piv = per_ckpt.pivot(index="checkpoint", columns="policy")
    paired = {}
    for m in ("amount_completion_rate", "mean_reward", "mean_cost_term", "mean_latency_cost", "liquidity_utilization"):
        paired[m] = {
            "projected_minus_original": (piv[m]["ppo_projected"] - piv[m]["ppo_original"]).describe()[["mean", "std", "min", "max"]].to_dict(),
            "projected_minus_waterfall": (piv[m]["ppo_projected"] - piv[m]["liquidity_waterfall"]).describe()[["mean", "std", "min", "max"]].to_dict(),
        }
    paired["checkpoints_projected_reward_gt_waterfall"] = int((piv["mean_reward"]["ppo_projected"] > piv["mean_reward"]["liquidity_waterfall"]).sum())
    return overall, by_regime, paired


def common_provenance(ts, kind):
    status = _git("status", "--porcelain")
    code = ["run_holdout_overlap_analysis.py", "run_holdout_evaluation.py", "src/training/capacity_projection.py",
            "src/training/transaction_generator.py"]
    return {
        "experiment": kind, "started_at": ts, "training_performed": False, "tuning_performed": False,
        "git_head": _git("rev-parse", "HEAD"), "git_dirty": bool(status), "git_dirty_files": status.splitlines() if status else [],
        "code_sha256": {f: _sha(f) for f in code}, "code_git_blob": {f: _git("hash-object", f) for f in code},
        "test_split_sha256": _sha(TEST_CSV), "history_window_days": SEQUENCE_LENGTH,
        "python": platform.python_version(), "torch": torch.__version__, "device": rhe.DEVICE,
        "unrouted_definitions": {"env_unrouted": "requested - executed", "amount_unrouted": "max(amount - executed, 0)"},
    }


def option1(ts, test):
    out = Path("outputs/experiments") / f"stage1d_holdout_sensitivity_{ts}"
    out.mkdir(parents=True, exist_ok=False)
    per_tx = pd.read_csv(HOLDOUT_RUN / "per_transaction.csv")
    hold = overlap_columns(pd.read_csv(HOLDOUT1_CSV), test)
    per_tx = per_tx.merge(hold[["transaction_id", "shares_corridor_date_with_test", "shares_date_with_test",
                                "window_overlap_days_same_corridor"]], on="transaction_id", how="left")
    assert per_tx.shares_date_with_test.notna().all()
    hold.to_csv(out / "holdout_overlap_per_row.csv", index=False)
    subsets = {"full": per_tx,
               "excl_shared_corridor_date": per_tx[~per_tx.shares_corridor_date_with_test],
               "excl_shared_date": per_tx[~per_tx.shares_date_with_test]}
    results = {}
    for name, sub in subsets.items():
        overall, by_regime, paired = write_tables(out, sub, f"_{name}")
        results[name] = {"n_transactions": int(sub.transaction_id.nunique()),
                         "regime_counts": sub.drop_duplicates("transaction_id").regime.value_counts().to_dict(),
                         "overlap": overlap_summary(hold[hold.transaction_id.isin(sub.transaction_id)]),
                         "overall": overall.to_dict(orient="records"), "by_regime": by_regime.to_dict(orient="records"),
                         "paired": paired}
    prov = common_provenance(ts, "stage1d_holdout_sensitivity")
    prov.update({"source_run": str(HOLDOUT_RUN), "source_per_transaction_sha256": _sha(HOLDOUT_RUN / "per_transaction.csv"),
                 "source_provenance_sha256": _sha(HOLDOUT_RUN / "provenance.json"),
                 "holdout_csv": str(HOLDOUT1_CSV), "holdout_sha256": _sha(HOLDOUT1_CSV), "re_evaluated": False})
    _save(out / "provenance.json", prov)
    _save(out / "summary.json", results)
    return out, results


def make_disjoint_holdout(test):
    before = {str(p): _sha(p) for p in EXISTING}
    drawn = generate_split("test", DISJOINT_DRAW, seed=DISJOINT_SEED, start_id=DISJOINT_START_ID)
    excluded_dates = set(test.simulation_date)
    keep = drawn[~drawn.simulation_date.isin(excluded_dates)]
    if len(keep) < DISJOINT_N:
        raise RuntimeError(f"only {len(keep)} date-disjoint rows in {DISJOINT_DRAW} draws")
    df = keep.head(DISJOINT_N).reset_index(drop=True)
    if DISJOINT_CSV.exists():
        import io
        if not pd.read_csv(io.StringIO(df.to_csv(index=False))).equals(pd.read_csv(DISJOINT_CSV)):
            raise FileExistsError(f"{DISJOINT_CSV} exists and differs; refusing to overwrite")
        reused = True
    else:
        df.to_csv(DISJOINT_CSV, index=False)
        reused = False
    assert before == {str(p): _sha(p) for p in EXISTING}, "existing datasets changed"
    existing = pd.concat([pd.read_csv(p).assign(source=p.stem) for p in EXISTING])
    key = ["sender_country", "receiver_country", "simulation_date", "amount_usd"]
    dups = df[key + ["transaction_id"]].merge(existing[key + ["transaction_id", "source"]], on=key,
                                              suffixes=("_holdout", "_existing"))
    last_draw_used = int(keep.index[DISJOINT_N - 1])
    return df, {
        "generator": "src.training.transaction_generator.generate_split (unchanged)", "window": "test",
        "seed": DISJOINT_SEED, "rows_drawn": DISJOINT_DRAW, "rows_kept": DISJOINT_N,
        "draws_consumed_to_reach_n": last_draw_used + 1,
        "rows_rejected_before_n": int(last_draw_used + 1 - DISJOINT_N),
        "filter": "simulation_date not in the examined test split's dates (any corridor)",
        "excluded_dates": len(excluded_dates), "start_id": DISJOINT_START_ID,
        "path": str(DISJOINT_CSV), "sha256": _sha(DISJOINT_CSV), "file_reused_after_identity_check": reused,
        "existing_datasets_sha256_unchanged": before,
        "date_range": [df.simulation_date.min(), df.simulation_date.max()],
        "true_regime_counts": df.regime.value_counts().to_dict(),
        "corridor_counts": (df.sender_country + "->" + df.receiver_country).value_counts().to_dict(),
        "regime_counts_all_drawn": drawn.regime.value_counts().to_dict(),
        "exact_duplicate_rows_with_existing": dups.to_dict(orient="records"),
        "rows_sharing_any_date_with": {p.stem: int(df.simulation_date.isin(pd.read_csv(p).simulation_date).sum()) for p in EXISTING},
    }


def option2(ts, test):
    out = Path("outputs/experiments") / f"stage1d_holdout_datedisjoint_eval_{ts}"
    out.mkdir(parents=True, exist_ok=False)
    df, hprov = make_disjoint_holdout(test)
    hold = overlap_columns(df, test)
    hold.to_csv(out / "holdout_overlap_per_row.csv", index=False)
    assert not hold.shares_date_with_test.any() and not hold.shares_corridor_date_with_test.any()

    specs = [(f"seed{s}_{c}", s, coef, rhe.MULTISEED_DIR / f"seed{s}" / c / "ppo_checkpoint.pt")
             for s in rhe.SEEDS for c, coef in rhe.CONDITIONS]
    prov = common_provenance(ts, "stage1d_holdout_datedisjoint_evaluation")
    prov.update({"holdout": hprov, "policies": list(rhe.POLICIES),
                 "evaluation_function": "run_holdout_evaluation.evaluate_checkpoint (HOLDOUT_CSV attribute pointed at this holdout)",
                 "checkpoints": [{"label": l, "seed": s, "entropy_coef": c, "checkpoint": str(ck), "sha256": _sha(ck)}
                                 for l, s, c, ck in specs]})
    _save(out / "provenance.json", prov)

    original = rhe.HOLDOUT_CSV
    rhe.HOLDOUT_CSV = DISJOINT_CSV
    try:
        frames = []
        for label, seed, coef, ck in specs:
            print(f"  evaluating {label} ...", flush=True)
            frames.append(rhe.evaluate_checkpoint(label, ck).assign(seed=seed, entropy_coef=coef))
    finally:
        rhe.HOLDOUT_CSV = original
    per_tx = pd.concat(frames, ignore_index=True).merge(
        hold[["transaction_id", "window_overlap_days_same_corridor"]], on="transaction_id", how="left")
    per_tx.to_csv(out / "per_transaction.csv", index=False)
    overall, by_regime, paired = write_tables(out, per_tx)
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
    results = {"holdout": {k: hprov[k] for k in ("seed", "rows_kept", "draws_consumed_to_reach_n", "date_range",
                                                "true_regime_counts", "corridor_counts")},
               "overlap": overlap_summary(hold), "overall": overall.to_dict(orient="records"),
               "by_regime": by_regime.to_dict(orient="records"), "paired": paired, "checks": checks}
    _save(out / "summary.json", results)
    return out, results


def _print(title, overall, by_regime):
    cols = ["policy", "amount_completion_rate_mean", "env_completion_rate_mean", "amount_total_unrouted_mean",
            "mean_reward_mean", "mean_reward_sd", "mean_cost_term_mean", "mean_latency_cost_mean", "liquidity_utilization_mean"]
    print(f"\n=== {title} ===")
    print(pd.DataFrame(overall)[cols].to_string(index=False))
    print(pd.DataFrame(by_regime)[["regime", "n"] + cols].to_string(index=False))


def main():
    pd.set_option("display.width", 250, "display.max_columns", 40)
    test = pd.read_csv(TEST_CSV)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")

    print("OPTION 1: sensitivity on", HOLDOUT_RUN)
    out1, r1 = option1(ts, test)
    for name, r in r1.items():
        print(f"\n[{name}] n={r['n_transactions']} regimes={r['regime_counts']} overlap={json.dumps(r['overlap'])}")
        _print(f"OPTION 1 - {name}", r["overall"], r["by_regime"])
        print("paired:", json.dumps(r["paired"]))
    print(f"\nOption 1 outputs: {out1.resolve()}")

    print("\nOPTION 2: date-disjoint holdout")
    out2, r2 = option2(ts, test)
    print("holdout:", json.dumps(r2["holdout"]), "\noverlap:", json.dumps(r2["overlap"]))
    _print("OPTION 2 - date-disjoint holdout", r2["overall"], r2["by_regime"])
    print("paired:", json.dumps(r2["paired"]), "\nchecks:", json.dumps(r2["checks"]))
    print(f"\nOption 2 outputs: {out2.resolve()}")


if __name__ == "__main__":
    main()
