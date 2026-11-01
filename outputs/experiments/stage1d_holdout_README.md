# Stage 1D holdout evaluations

These runs evaluate the six multi-seed checkpoints (`stage1d_entropy_multiseed_20261101_180551/`) with original PPO,
capacity-projected PPO and the liquidity waterfall, on synthetic holdouts. The holdouts come from the existing, unchanged generator
(`generate_split`, "test" date window) with new seeds.

Nothing was trained or tuned, and the model, environment, reward and checkpoints were not modified. No model or parameter selection was performed on any
holdout. See `docs/STAGE1D_RESULTS.md` for the consolidated findings.

## Runs

| Folder | Status | Holdout | Script |
|---|---|---|---|
| `stage1d_holdout_eval_20261101_225445/` | **Authoritative** | `stage1d_transactions_holdout_seed20261102.csv` (500 rows) | `run_holdout_evaluation.py` |
| `stage1d_holdout_eval_20261101_224109/` | Superseded | same | earlier version of the same script. Its duplicate-row provenance lists the holdout ID twice, and a fixed $1e-6 tolerance counted float32 noise as unrouted-amount differences. Metrics are identical to `225445` apart from amount-based unrouted, which differs by ≤ $0.048 on rows where executed exceeded the amount by float32 rounding. |
| `stage1d_holdout_eval_20261101_223302/` | Superseded (incomplete) | same | crashed while writing `summary.json`. Its `per_transaction.csv` is identical to `224109`'s. |
| `stage1d_holdout_sensitivity_20261101_230534/` | **Authoritative** | the seed-20261102 holdout, re-aggregated from `225445` (no re-evaluation): full, without corridor-dates shared with the test split, and without any date shared with the test split | `run_holdout_overlap_analysis.py` (option 1) |
| `stage1d_holdout_datedisjoint_eval_20261101_230534/` | **Authoritative** | `stage1d_transactions_holdout_datedisjoint_seed20261103.csv` (500 rows; test-split dates excluded, **but not** the seed-20261102 holdout's dates) | `run_holdout_overlap_analysis.py` (option 2) |
| `stage1d_holdout_datedisjoint_v2_eval_20261101_233252/` | **Authoritative** | `stage1d_transactions_holdout_datedisjoint_v2_seed20261104.csv` (500 rows; dates of the test split **and** the seed-20261102 holdout excluded) | `run_holdout_disjoint_v2.py` |

## Files

- `provenance.json`: holdout seed, hash, regime counts and overlap checks; hashes of the existing datasets (unchanged); checkpoint
  hashes; code SHA-256 and git blob hashes; git HEAD and dirty files; device.
- `per_transaction.csv`: one row per checkpoint × policy × transaction. It records reward, cost, latency, risk, executed,
  `env_unrouted` (requested − executed), `amount_unrouted` (max(amount − executed, 0)), both completion flags, and the action
  sum.
- `metrics_*.csv`: per-checkpoint and per-regime results, plus the mean and SD across the 6 checkpoints.
- `summary.json`: aggregate and per-regime results, paired differences, consistency checks and history overlap.
- `holdout_overlap_per_row.csv`: (overlap runs only) each row's shared dates and 30-day history overlap with the reference set(s).

## Notes

- `env_unrouted` does not count an amount that is never requested. For `exceeds_combined` rows, the waterfall and projected PPO request
  less than 100% of the amount, so environment-reported completion overstates them. Use the amount-based columns instead.
- In the overlap runs' `summary.json`, overlap fields named `*_with_test` refer to the reference set named in the parent key, not always the test
  split.
- **Remaining overlap:** all holdouts share the 2024-02-01..2025-08-30 period with the examined test split, because the data ends at 2025-09-30. Most
  rows' 30-day history windows overlap those of examined dates (see `docs/STAGE1D_RESULTS.md` §7).
