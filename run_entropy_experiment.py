"""Paired Stage 1D PPO experiment: entropy coefficient 0.0 vs 0.005.

Run from the repository root:
    python run_entropy_experiment.py

Both runs use the same data splits, initialisation seed, training schedule,
architecture, optimiser settings, and deterministic held-out test evaluation.
Only ENTROPY_COEF changes. Source files are not modified, and outputs are
written into a new timestamped directory so previous results are preserved.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd
import torch

from src.training import ppo_train
from src.training.evaluate import evaluate_all


TRAIN_CSV = Path("data/processed/stage1d_transactions_train.csv")
VAL_CSV = Path("data/processed/stage1d_transactions_validation.csv")
TEST_CSV = Path("data/processed/stage1d_transactions_test.csv")

N_EPOCHS = 20
BATCH_SIZE = 32
LEARNING_RATE = 3e-4
SEED = 42
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
if DEVICE == "cuda":
    print(f"Using GPU: {torch.cuda.get_device_name(0)}")
else:
    print("CUDA unavailable. Using CPU.")

# Paired comparison: the only changed training parameter is ENTROPY_COEF.
EXPERIMENTS = (
    ("baseline_entropy000", 0.0),
    ("entropy005", 0.005),
)

METRIC_KEYS = (
    "mean_reward",
    "completion_rate",
    "total_unrouted",
    "liquidity_utilization",
    "mean_bridges_used",
    "multi_bridge_rate",
    "mean_largest_allocation",
    "mean_allocation_entropy",
    "mean_latency_cost",
    "mean_risk_cost",
    "mean_cost_term",
)

REGIME_METRIC_KEYS = (
    "mean_reward",
    "completion_rate",
    "total_unrouted",
    "mean_bridges_used",
    "multi_bridge_rate",
    "mean_largest_allocation",
    "mean_allocation_entropy",
)


def _json_default(value: Any) -> Any:
    """Convert NumPy/PyTorch scalar values into JSON-safe Python values."""
    if hasattr(value, "item"):
        return value.item()
    if hasattr(value, "tolist"):
        return value.tolist()
    return str(value)


def _save_json(path: Path, payload: Any) -> None:
    path.write_text(
        json.dumps(payload, indent=2, default=_json_default),
        encoding="utf-8",
    )


def _print_policy_metrics(
    label: str,
    results: dict[str, dict[str, Any]],
) -> None:
    print(f"\n=== TEST METRICS: {label} ===")
    for policy_name, metrics in results.items():
        print(f"\n[{policy_name}]")
        print(f"n_transactions: {metrics.get('n_transactions')}")
        for key in METRIC_KEYS:
            if key in metrics:
                print(f"{key}: {metrics[key]}")

        for regime_name, regime_metrics in metrics.get("by_regime", {}).items():
            print(f"  [{regime_name}] n={regime_metrics.get('n_transactions')}")
            for key in REGIME_METRIC_KEYS:
                if key in regime_metrics:
                    print(f"    {key}: {regime_metrics[key]}")


def _build_comparison(
    baseline_results: dict[str, dict[str, Any]],
    entropy_results: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    comparison: dict[str, Any] = {}

    for policy_name in sorted(set(baseline_results) & set(entropy_results)):
        baseline = baseline_results[policy_name]
        entropy = entropy_results[policy_name]
        policy_delta: dict[str, Any] = {"overall": {}, "by_regime": {}}

        for key in METRIC_KEYS:
            if key in baseline and key in entropy:
                policy_delta["overall"][key] = {
                    "entropy_0.0": baseline[key],
                    "entropy_0.005": entropy[key],
                    "delta_entropy_minus_baseline": entropy[key] - baseline[key],
                }

        baseline_regimes = baseline.get("by_regime", {})
        entropy_regimes = entropy.get("by_regime", {})
        for regime_name in sorted(set(baseline_regimes) & set(entropy_regimes)):
            b_metrics = baseline_regimes[regime_name]
            e_metrics = entropy_regimes[regime_name]
            regime_delta: dict[str, Any] = {}
            for key in REGIME_METRIC_KEYS:
                if key in b_metrics and key in e_metrics:
                    regime_delta[key] = {
                        "entropy_0.0": b_metrics[key],
                        "entropy_0.005": e_metrics[key],
                        "delta_entropy_minus_baseline": (
                            e_metrics[key] - b_metrics[key]
                        ),
                    }
            policy_delta["by_regime"][regime_name] = regime_delta

        comparison[policy_name] = policy_delta

    return comparison


def _print_ppo_comparison(comparison: dict[str, Any]) -> None:
    ppo = comparison.get("ppo")
    if not ppo:
        print("\nNo 'ppo' entry found in evaluation results; see saved JSON.")
        return

    print("\n=== PAIRED PPO COMPARISON: ENTROPY 0.0 -> 0.005 ===")
    for key, values in ppo["overall"].items():
        print(
            f"{key}: baseline={values['entropy_0.0']} | "
            f"entropy005={values['entropy_0.005']} | "
            f"delta={values['delta_entropy_minus_baseline']}"
        )

    print("\n=== PPO BY-REGIME COMPARISON ===")
    for regime_name, regime_values in ppo["by_regime"].items():
        print(f"\n[{regime_name}]")
        for key, values in regime_values.items():
            print(
                f"{key}: baseline={values['entropy_0.0']} | "
                f"entropy005={values['entropy_0.005']} | "
                f"delta={values['delta_entropy_minus_baseline']}"
            )


def main() -> None:
    for csv_path in (TRAIN_CSV, VAL_CSV, TEST_CSV):
        if not csv_path.is_file():
            raise FileNotFoundError(
                f"Missing dataset: {csv_path}. Run this script from the project root."
            )

    train_df = pd.read_csv(TRAIN_CSV)
    val_df = pd.read_csv(VAL_CSV)
    test_df = pd.read_csv(TEST_CSV)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_root = Path("outputs/experiments") / f"stage1d_entropy_pair_seed42_{timestamp}"
    output_root.mkdir(parents=True, exist_ok=False)

    config = {
        "experiment": "stage1d_paired_entropy_regularization",
        "runs": [
            {"name": name, "entropy_coef": coef}
            for name, coef in EXPERIMENTS
        ],
        "epochs": N_EPOCHS,
        "batch_size": BATCH_SIZE,
        "learning_rate": LEARNING_RATE,
        "seed": SEED,
        "device": DEVICE,
        "train_csv": str(TRAIN_CSV),
        "validation_csv": str(VAL_CSV),
        "test_csv": str(TEST_CSV),
        "split_sizes": {
            "train": len(train_df),
            "validation": len(val_df),
            "test": len(test_df),
        },
        "test_regime_counts": (
            test_df["regime"].value_counts().to_dict()
            if "regime" in test_df.columns
            else {}
        ),
    }
    _save_json(output_root / "experiment_config.json", config)

    print("=== STAGE 1D: PAIRED ENTROPY EXPERIMENT ===")
    print(f"Training rows      : {len(train_df)}")
    print(f"Validation rows    : {len(val_df)}")
    print(f"Held-out test rows : {len(test_df)}")
    print(f"Epochs / batch     : {N_EPOCHS} / {BATCH_SIZE}")
    print(f"Learning rate      : {LEARNING_RATE}")
    print(f"Random seed        : {SEED}")
    print(f"Device             : {DEVICE}")
    if "regime" in test_df.columns:
        print("\nTest regime counts:")
        print(test_df["regime"].value_counts().to_string())

    original_coef = float(ppo_train.ENTROPY_COEF)
    all_results: dict[str, dict[str, dict[str, Any]]] = {}

    try:
        for run_name, entropy_coef in EXPERIMENTS:
            print("\n" + "=" * 72)
            print(f"STARTING RUN: {run_name} | ENTROPY_COEF={entropy_coef}")
            print("=" * 72)

            # Change only this in-memory coefficient. No source file is edited.
            ppo_train.ENTROPY_COEF = entropy_coef

            run_dir = output_root / run_name
            run_dir.mkdir(parents=True, exist_ok=False)

            net, history = ppo_train.train(
                str(TRAIN_CSV),
                str(VAL_CSV),
                n_epochs=N_EPOCHS,
                batch_size=BATCH_SIZE,
                lr=LEARNING_RATE,
                device=DEVICE,
                seed=SEED,
            )

            history_df = pd.DataFrame(history)
            history_df.to_csv(run_dir / "training_history.csv", index=False)
            torch.save(net.state_dict(), run_dir / "ppo_checkpoint.pt")

            if not history_df.empty and "val_mean_reward" in history_df.columns:
                best_index = int(history_df["val_mean_reward"].idxmax())
                best_row = history_df.loc[best_index].to_dict()
                print(
                    f"Best validation reward: {best_row.get('val_mean_reward')} "
                    f"(epoch {best_row.get('epoch')})"
                )
                print("Epoch history:")
                print(history_df.to_string(index=False))

            print("\nEvaluating all three policies on the same held-out test split...")
            results = evaluate_all(str(TEST_CSV), net, device=DEVICE)
            all_results[run_name] = results
            _save_json(run_dir / "evaluation_metrics.json", results)
            _print_policy_metrics(run_name, results)

    finally:
        # Restore the coefficient even if training or evaluation raises an error.
        ppo_train.ENTROPY_COEF = original_coef

    baseline_results = all_results["baseline_entropy000"]
    entropy_results = all_results["entropy005"]
    comparison = _build_comparison(baseline_results, entropy_results)
    _save_json(output_root / "paired_comparison.json", comparison)
    _print_ppo_comparison(comparison)

    print("\n=== ALL EXPERIMENT OUTPUTS SAVED ===")
    print(output_root.resolve())
    print("  baseline_entropy000/ppo_checkpoint.pt")
    print("  baseline_entropy000/training_history.csv")
    print("  baseline_entropy000/evaluation_metrics.json")
    print("  entropy005/ppo_checkpoint.pt")
    print("  entropy005/training_history.csv")
    print("  entropy005/evaluation_metrics.json")
    print("  experiment_config.json")
    print("  paired_comparison.json")


if __name__ == "__main__":
    main()
