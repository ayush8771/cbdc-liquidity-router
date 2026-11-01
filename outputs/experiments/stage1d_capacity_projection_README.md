# Stage 1D capacity-projection experiment (validation only)

This experiment applies an inference-time capacity correction to existing PPO checkpoints. Nothing was trained or
tuned. The PPO model, environment, reward, baselines, data and checkpoints were not modified. The test split was never
loaded.

## Runs

| Folder | Status | Notes |
|---|---|---|
| `stage1d_capacity_projection_20261101_210614/` | **Authoritative** | Uses the projection with input guards: NaN in a feasible slot's cap or in the action raises an error, and caps are clipped to [0, 1], so infinite or huge liquidity is non-binding. The code hashes (SHA-256 and git blob) in `experiment_config.json` match the current `run_capacity_projection_experiment.py` and `src/training/capacity_projection.py`. Both files were untracked when the run was made. |
| `stage1d_capacity_projection_20261101_205239/` | **Superseded**, kept unchanged | Produced by the projection before the NaN/infinite guards were added. All completion flags, change flags and counts are identical to the authoritative run, and so are the original-PPO and waterfall values. The projected-PPO floating-point values differ by at most 1.8e-15, from the narrower starting range for the threshold search. |
| `stage1d_capacity_projection_20261101_205047/` | **Superseded**, kept unchanged | Its policy metrics and per-transaction rewards are identical to `205239`. However, `projection_changed` and the `projection_effect` changed-row statistics in `summary.json` are inflated: a 1e-9 threshold counted float32 renormalization noise (about 1e-8) as a change (about 92 of 100 rows per checkpoint). It was produced by an earlier version of the experiment script. |

## What is compared

For each of the six multi-seed checkpoints in `stage1d_entropy_multiseed_20261101_180551/` (seeds 42, 123 and 2026, each with
`ENTROPY_COEF` 0.0 and 0.005), on `data/processed/stage1d_transactions_validation.csv` (100 rows):

1. `ppo_original`: the deterministic PPO action, i.e. the normalized Dirichlet concentration.
2. `ppo_projected`: the same action, projected by `src/training/capacity_projection.project_capped_simplex`. This is a
   Euclidean projection onto `{0 <= x_i <= liquidity_i / amount on feasible slots, x_i = 0 elsewhere, sum x = 1}`.
   The liquidity comes from the same dynamic-state lookup that `env.step()` uses for execution. That liquidity is
   already part of PPO's observation, so the projection adds no new information. If combined liquidity is below the
   amount, the projection returns `x_i = cap_i`; this never happened here, since the minimum combined capacity is 1.064 × the amount.
3. `liquidity_waterfall`: the existing baseline.

All three policies are executed with the same `env.step()`, starting from the same per-transaction state. Before any result is
accepted, each checkpoint's replayed original PPO and waterfall metrics must match its saved `validation_metrics.json`.
All six matched, with a largest difference of 0.0.

## Files (authoritative run, `210614`)

- `experiment_config.json`: policies, the projection definition, validation CSV hash, checkpoint hashes, git HEAD
  (`f351469`) and dirty files, code SHA-256 and git blob hashes, and versions and device.
- `replay_check.json`: replayed versus saved metrics for each checkpoint.
- `metrics_<checkpoint>.json`: full `compute_metrics` output, overall and by regime, for each of the three policies.
- `per_transaction.csv`: 600 rows (6 checkpoints × 100). For each row it gives reward, unrouted value, completion, cost and latency per policy, plus
  the projection's L1 shift and the action sums.
- `summary.json`: mean and SD across the 6 checkpoints, a breakdown by entropy coefficient and by regime, paired
  projected-minus-original differences, and the projection's effect. That effect is measured on rows whose L1 shift is above 1e-6.

## Key results (validation; mean across 6 checkpoints)

| Metric | Original PPO | Projected PPO | Waterfall |
|---|---|---|---|
| Completion rate | 0.948 | 1.000 | 1.000 |
| Total unrouted | $168,325 | $0 | $0.26 |
| Mean reward | 0.89853 | 0.89893 | 0.88009 |
| Cost term | 2.3152 | 2.3217 | 2.3247 |
| Latency cost | 1.4132 | 1.4228 | 1.4446 |
| Liquidity utilization | 0.9951 | 1.0000 | 1.0000 |

- The projection changes only the 31 transactions that original PPO failed, all `splitting_needed`, and it completes every one.
  Reward on those 31 rose in 20 cases and fell in 11 (mean +0.0078). Routing the clipped excess gains cost term
  (+0.127) but adds latency cost (+0.186).
- **Per-checkpoint differences (projected minus original):** completion rose by 2–8 points. The reward change ranged from −0.0003 to +0.0014.
- On the 31 corrected transactions, projected PPO is slightly below the waterfall: mean −0.0076, with projected PPO ahead in 9 of 31.
- **Reproducibility:** `205047` and `205239` give identical metrics and per-transaction values, apart from the corrected
  `projection_changed` flag. `210614` matches `205239` to within 1.8e-15, with every discrete outcome identical.

## Tests

`tests/test_capacity_projection.py` (20 tests) covers:

- the exact optimality (KKT) conditions, on 500+ random cases;
- an independent brute-force grid search;
- caps that sum to exactly 1 or just above it;
- a single feasible slot, with sufficient and with insufficient capacity;
- zero and negative caps;
- mass on an infeasible slot, an unnormalized action, and float32 input;
- infinite and huge caps;
- NaN caps (an error on a feasible slot; ignored on an infeasible slot);
- NaN or infinite actions, which raise an error.

## Limitations

- **Optimistic validation scores:** the same validation split selected each checkpoint's best epoch, so absolute PPO
  scores are optimistic. The paired original-versus-projected comparison uses the same checkpoints.
- **Small sample:** one validation set of 100 rows, with 6 checkpoints from 3 seeds. No significance testing was done.
- **Not a learned policy:** the projection is a correction applied after the policy, at evaluation time. It does not make the PPO
  policy itself capacity-aware.
- **Placeholder reward weights:** the reward uses λ = 1.0 for every term, so the comparison with the waterfall depends on these uncalibrated weights.
- **Platform:** PPO actions were computed on CUDA (an RTX 3050). On other hardware, the last digits may differ.
- **Holdout needed:** a fresh holdout is needed before making any final claim.
