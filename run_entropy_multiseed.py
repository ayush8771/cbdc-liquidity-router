"""Paired multi-seed Stage 1D PPO experiment: ENTROPY_COEF 0.0 vs 0.005.

Run from the repository root:
    python run_entropy_multiseed.py

Seeds 42, 123 and 2026, each trained under both coefficients with identical
splits, architecture, hyperparameters and checkpoint-selection rule (best
validation mean reward, inside ppo_train.train). Only ENTROPY_COEF changes,
set explicitly per run in memory and restored afterwards; no source file is
modified.

Comparison split: VALIDATION. The previously examined test split is NOT
loaded or evaluated here. Caveat: validation is also used for checkpoint
selection, so validation metrics of the selected checkpoint are optimistically
biased (equally for both conditions). Final claims still need a fresh holdout.

Outputs go to a new timestamped directory; earlier runs are never touched.
"""

from __future__ import annotations

import json
import platform
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import torch

from src.training import ppo_train
from src.training.evaluate import evaluate_all
from run_entropy_experiment import METRIC_KEYS, REGIME_METRIC_KEYS, _save_json

TRAIN_CSV = Path("data/processed/stage1d_transactions_train.csv")
VAL_CSV = Path("data/processed/stage1d_transactions_validation.csv")

N_EPOCHS = 20
BATCH_SIZE = 32
LEARNING_RATE = 3e-4
SEEDS = (42, 123, 2026)
CONDITIONS = (
    ("entropy000", 0.0),
    ("entropy005", ppo_train.EXPERIMENTAL_ENTROPY_COEF),
)
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


def _git(*args: str) -> str | None:
    try:
        return subprocess.check_output(["git", *args], text=True).strip()
    except Exception:
        return None


def _environment_info() -> dict[str, Any]:
    status = _git("status", "--porcelain")
    return {
        "git_head": _git("rev-parse", "HEAD"),
        "git_branch": _git("rev-parse", "--abbrev-ref", "HEAD"),
        "git_dirty": bool(status) if status is not None else None,
        "git_dirty_files": status.splitlines() if status else [],
        "python": platform.python_version(),
        "torch": torch.__version__,
        "numpy": np.__version__,
        "pandas": pd.__version__,
        "device": DEVICE,
        "gpu": torch.cuda.get_device_name(0) if DEVICE == "cuda" else None,
        "cudnn_deterministic": torch.backends.cudnn.deterministic,
    }


def _aggregate(per_seed: dict[int, dict[str, dict]]) -> dict[str, Any]:
    """Mean/SD across seeds of PPO validation metrics, per condition, plus
    per-seed paired deltas (entropy005 - entropy000)."""
    out: dict[str, Any] = {"overall": {}, "by_regime": {}, "paired_delta_per_seed": {}}
    seeds = sorted(per_seed)

    def stats(values: list[float]) -> dict[str, float]:
        arr = np.asarray(values, dtype=float)
        return {"mean": float(arr.mean()), "sd": float(arr.std(ddof=1)) if len(arr) > 1 else 0.0,
                "values": arr.tolist()}

    for key in METRIC_KEYS:
        row = {}
        for cond, _ in CONDITIONS:
            row[cond] = stats([per_seed[s][cond]["ppo"][key] for s in seeds])
        row["delta"] = stats([per_seed[s]["entropy005"]["ppo"][key] - per_seed[s]["entropy000"]["ppo"][key] for s in seeds])
        out["overall"][key] = row

    regimes = sorted(set.intersection(*[
        set(per_seed[s][c]["ppo"].get("by_regime", {})) for s in seeds for c, _ in CONDITIONS
    ])) if seeds else []
    for regime in regimes:
        out["by_regime"][regime] = {}
        for key in REGIME_METRIC_KEYS:
            if not all(key in per_seed[s][c]["ppo"]["by_regime"][regime] for s in seeds for c, _ in CONDITIONS):
                continue  # not every metric is reported per regime (e.g. total_unrouted)
            row = {}
            for cond, _ in CONDITIONS:
                row[cond] = stats([per_seed[s][cond]["ppo"]["by_regime"][regime][key] for s in seeds])
            row["delta"] = stats([
                per_seed[s]["entropy005"]["ppo"]["by_regime"][regime][key]
                - per_seed[s]["entropy000"]["ppo"]["by_regime"][regime][key] for s in seeds
            ])
            out["by_regime"][regime][key] = row

    for s in seeds:
        out["paired_delta_per_seed"][str(s)] = {
            key: per_seed[s]["entropy005"]["ppo"][key] - per_seed[s]["entropy000"]["ppo"][key]
            for key in METRIC_KEYS
        }
    out["n_seeds"] = len(seeds)
    out["note"] = ("Validation split; same split used for checkpoint selection. "
                   "Descriptive only - 3 seeds is not a significance test.")
    return out


def main() -> None:
    for csv_path in (TRAIN_CSV, VAL_CSV):
        if not csv_path.is_file():
            raise FileNotFoundError(f"Missing dataset: {csv_path}. Run from the project root.")
    train_df = pd.read_csv(TRAIN_CSV)
    val_df = pd.read_csv(VAL_CSV)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_root = Path("outputs/experiments") / f"stage1d_entropy_multiseed_{timestamp}"
    output_root.mkdir(parents=True, exist_ok=False)

    config = {
        "experiment": "stage1d_paired_entropy_multiseed",
        "conditions": [{"name": n, "entropy_coef": c} for n, c in CONDITIONS],
        "seeds": list(SEEDS),
        "epochs": N_EPOCHS, "batch_size": BATCH_SIZE, "learning_rate": LEARNING_RATE,
        "ppo_clip_eps": ppo_train.PPO_CLIP_EPS,
        "ppo_epochs_per_update": ppo_train.PPO_EPOCHS_PER_UPDATE,
        "gamma": ppo_train.GAMMA,
        "module_default_entropy_coef": float(ppo_train.ENTROPY_COEF),
        "checkpoint_selection": "best validation mean reward (deterministic), per ppo_train.train",
        "comparison_split": "validation",
        "test_split_used": False,
        "evaluation_mode": "deterministic PPO actions (normalized Dirichlet concentration)",
        "train_csv": str(TRAIN_CSV), "validation_csv": str(VAL_CSV),
        "split_sizes": {"train": len(train_df), "validation": len(val_df)},
        "validation_regime_counts": val_df["regime"].value_counts().to_dict() if "regime" in val_df else {},
        "environment": _environment_info(),
        "started_at": timestamp,
    }
    _save_json(output_root / "experiment_config.json", config)
    print(json.dumps(config, indent=2, default=str))

    original_coef = float(ppo_train.ENTROPY_COEF)
    per_seed: dict[int, dict[str, dict]] = {}
    try:
        for seed in SEEDS:
            per_seed[seed] = {}
            for cond, coef in CONDITIONS:
                print(f"\n=== seed={seed} | {cond} | ENTROPY_COEF={coef} ===", flush=True)
                ppo_train.ENTROPY_COEF = coef  # in-memory only
                run_dir = output_root / f"seed{seed}" / cond
                run_dir.mkdir(parents=True, exist_ok=False)

                net, history = ppo_train.train(
                    str(TRAIN_CSV), str(VAL_CSV), n_epochs=N_EPOCHS, batch_size=BATCH_SIZE,
                    lr=LEARNING_RATE, device=DEVICE, seed=seed,
                )
                history_df = pd.DataFrame(history)
                history_df.to_csv(run_dir / "training_history.csv", index=False)
                torch.save(net.state_dict(), run_dir / "ppo_checkpoint.pt")
                best = history_df.loc[history_df["val_mean_reward"].idxmax()]
                print(f"best val reward {best['val_mean_reward']:.6f} at epoch {int(best['epoch'])}")

                results = evaluate_all(str(VAL_CSV), net, device=DEVICE)
                results["_run"] = {"seed": seed, "entropy_coef": coef,
                                   "best_val_epoch": int(best["epoch"]),
                                   "best_val_mean_reward": float(best["val_mean_reward"])}
                _save_json(run_dir / "validation_metrics.json", results)
                per_seed[seed][cond] = results
                print(f"ppo val: reward={results['ppo']['mean_reward']:.6f} "
                      f"completion={results['ppo']['completion_rate']:.4f} "
                      f"unrouted={results['ppo']['total_unrouted']:.2f}", flush=True)
    finally:
        ppo_train.ENTROPY_COEF = original_coef

    summary = _aggregate(per_seed)
    _save_json(output_root / "multiseed_summary.json", summary)

    print("\n=== PPO VALIDATION, MEAN (SD) ACROSS SEEDS ===")
    for key in ("mean_reward", "completion_rate", "total_unrouted", "liquidity_utilization",
                "mean_largest_allocation", "mean_allocation_entropy"):
        r = summary["overall"][key]
        print(f"{key}: 0.0={r['entropy000']['mean']:.6f} ({r['entropy000']['sd']:.6f}) | "
              f"0.005={r['entropy005']['mean']:.6f} ({r['entropy005']['sd']:.6f}) | "
              f"delta={r['delta']['mean']:.6f} ({r['delta']['sd']:.6f})")
    print(f"\nOutputs: {output_root.resolve()}")


if __name__ == "__main__":
    main()
