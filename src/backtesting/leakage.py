"""Stage 1F - evaluation-set construction and data-leakage guards.

The Stage 1F evaluation set is the union of the three Stage 1D synthetic
holdouts. None of them was used for training, checkpoint selection or tuning.
Guards (all must pass, else the backtest stops):
  1. every evaluation date lies in the generator's out-of-time "test" window and
     outside the 30-day gap buffers -> no date in the train or validation windows;
  2. no evaluation transaction exactly duplicates a train or validation row;
  3. rows that exactly duplicate a row of the already-examined test split are
     EXCLUDED; exact duplicate rows (same corridor, date and amount) within or
     across holdouts are kept once, since they are identical inputs;
  4. every checkpoint was selected on validation only (its experiment config says so).
Remaining, unavoidable overlap (documented, not removable without new data): the
holdouts share the 2024-02..2025-08 period, and many dates, with the examined
test split, so their 30-day history windows overlap.
"""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from ..models.stage1c_windowing import InvalidSimulationDateError, validate_simulation_date

HOLDOUTS = [
    "data/processed/stage1d_transactions_holdout_seed20261102.csv",
    "data/processed/stage1d_transactions_holdout_datedisjoint_seed20261103.csv",
    "data/processed/stage1d_transactions_holdout_datedisjoint_v2_seed20261104.csv",
]
TRAIN = "data/processed/stage1d_transactions_train.csv"
VALIDATION = "data/processed/stage1d_transactions_validation.csv"
TEST = "data/processed/stage1d_transactions_test.csv"
KEY = ["sender_country", "receiver_country", "simulation_date", "amount_usd"]


class LeakageError(RuntimeError):
    pass


def _keys(df):
    return set(map(tuple, df[KEY].astype(str).values))


def build_evaluation_set(holdouts=HOLDOUTS, train=TRAIN, validation=VALIDATION, test=TEST, root=".") -> tuple:
    """Returns (eval_df, report). Raises LeakageError if a guard fails."""
    root = Path(root)
    frames = []
    for p in holdouts:
        df = pd.read_csv(root / p)
        frames.append(df.assign(source=Path(p).stem))
    raw = pd.concat(frames, ignore_index=True)

    bad_dates = []
    for d in sorted(raw["simulation_date"].unique()):
        try:
            if validate_simulation_date(d) != "test":
                bad_dates.append(d)
        except InvalidSimulationDateError:
            bad_dates.append(d)
    if bad_dates:
        raise LeakageError(f"evaluation dates outside the out-of-time test window or in a gap buffer: {bad_dates[:10]}")

    tr, va, te = (pd.read_csv(root / p) for p in (train, validation, test))
    raw_keys = list(map(tuple, raw[KEY].astype(str).values))
    train_keys, val_keys = _keys(tr), _keys(va)
    in_train = [k in train_keys for k in raw_keys]
    in_val = [k in val_keys for k in raw_keys]
    if any(in_train) or any(in_val):
        raise LeakageError(f"evaluation rows duplicate train ({sum(in_train)}) / validation ({sum(in_val)}) rows")
    test_keys = _keys(te)
    is_test_dup = pd.Series([k in test_keys for k in raw_keys], index=raw.index)
    after_test = raw[~is_test_dup]
    deduped = after_test.drop_duplicates(subset=KEY, keep="first").reset_index(drop=True)
    if deduped["transaction_id"].duplicated().any():
        raise LeakageError("transaction_id collision across holdouts")

    test_dates = set(te["simulation_date"])
    report = {
        "holdouts": list(holdouts), "rows_loaded": int(len(raw)),
        "rows_excluded_duplicate_of_examined_test_split": int(is_test_dup.sum()),
        "rows_removed_exact_duplicates_within_or_across_holdouts": int(len(after_test) - len(deduped)),
        "rows_evaluated": int(len(deduped)),
        "rows_by_source": deduped["source"].value_counts().to_dict(),
        "date_range": [deduped["simulation_date"].min(), deduped["simulation_date"].max()],
        "all_dates_in_out_of_time_test_window": True,
        "rows_duplicating_train": 0, "rows_duplicating_validation": 0,
        "remaining_overlap": {
            "rows_on_a_date_used_by_examined_test_split": int(deduped["simulation_date"].isin(test_dates).sum()),
            "note": "Holdouts share the test period with the examined test split; 30-day history windows overlap. "
                    "Not removable: all data ends 2025-09-30.",
        },
    }
    return deduped, report


def check_checkpoint_selection(experiment_config_path) -> dict:
    cfg = json.loads(Path(experiment_config_path).read_text(encoding="utf-8"))
    if cfg.get("comparison_split") != "validation" or cfg.get("test_split_used") is not False:
        raise LeakageError(f"{experiment_config_path}: checkpoints not selected on validation only")
    return {"config": str(experiment_config_path), "checkpoint_selection": cfg.get("checkpoint_selection"),
            "comparison_split": cfg["comparison_split"], "test_split_used": cfg["test_split_used"]}
