# Failed-transaction diagnosis (Stage 1D)

Generated: 20261101_200101 | git HEAD `e043cec29c6250a66d88f78e37c5bc4f1229da17` (dirty: True) | device cuda
Stochastic counterfactuals: 200 samples per transaction, torch seed 20261101 re-set per transaction.
Deterministic PPO = normalized Dirichlet concentration. All counterfactuals executed via the same env.step() from an identical, asserted-unchanged environment state.

Test-split rows are a retrospective diagnosis of an already-examined split; do not use them for selection.

## Replay check

| Checkpoint | Split | PPO failures (replayed / saved) | Exact match |
|---|---|---|---|
| test_seed42_entropy000 | test | 14 / 14 | True |
| test_seed42_entropy005 | test | 6 / 6 | True |
| val_seed42_entropy000 | validation | 8 / 8 | True |
| val_seed42_entropy005 | validation | 8 / 8 | True |
| val_seed123_entropy000 | validation | 5 / 5 | True |
| val_seed123_entropy005 | validation | 4 / 4 | True |
| val_seed2026_entropy000 | validation | 2 / 2 | True |
| val_seed2026_entropy005 | validation | 4 / 4 | True |

## Failures by checkpoint and cause

| checkpoint | a_b_over_allocation_with_spare_elsewhere | d_reward_tradeoff |
|---|---|---|
| test_seed42_entropy000 | 8 | 6 |
| test_seed42_entropy005 | 6 | 0 |
| val_seed123_entropy000 | 4 | 1 |
| val_seed123_entropy005 | 3 | 1 |
| val_seed2026_entropy000 | 1 | 1 |
| val_seed2026_entropy005 | 3 | 1 |
| val_seed42_entropy000 | 5 | 3 |
| val_seed42_entropy005 | 5 | 3 |

## Failures by regime

| checkpoint | splitting_needed |
|---|---|
| test_seed42_entropy000 | 14 |
| test_seed42_entropy005 | 6 |
| val_seed123_entropy000 | 5 |
| val_seed123_entropy005 | 4 |
| val_seed2026_entropy000 | 2 |
| val_seed2026_entropy005 | 4 |
| val_seed42_entropy000 | 8 |
| val_seed42_entropy005 | 8 |

## Per-checkpoint aggregates

| checkpoint | n_failed | mean_unrouted_pct | over_alloc_cheapest | mean_amount_over_combined | max_amount_over_combined | mean_cheapest_det_share | mean_cheapest_liq_share | mean_sample_completion | frac_c_flag | mean_gap_wf_minus_ppo |
|---|---|---|---|---|---|---|---|---|---|---|
| test_seed42_entropy000 | 14 | 0.0658 | 0.9286 | 0.7628 | 0.9177 | 0.3386 | 0.2894 | 0.1936 | 1.0000 | 0.1231 |
| test_seed42_entropy005 | 6 | 0.0312 | 1.0000 | 0.8692 | 0.9177 | 0.2742 | 0.2446 | 0.1358 | 1.0000 | 0.0751 |
| val_seed123_entropy000 | 5 | 0.1239 | 0.0000 | 0.8660 | 0.9395 | 0.0942 | 0.2657 | 0.0300 | 0.8000 | 0.0403 |
| val_seed123_entropy005 | 4 | 0.0458 | 0.0000 | 0.8657 | 0.9395 | 0.1536 | 0.2697 | 0.0813 | 0.7500 | 0.0104 |
| val_seed2026_entropy000 | 2 | 0.0361 | 0.5000 | 0.8307 | 0.9395 | 0.2336 | 0.2384 | 0.2350 | 0.5000 | -0.0083 |
| val_seed2026_entropy005 | 4 | 0.0592 | 0.0000 | 0.8657 | 0.9395 | 0.1919 | 0.2697 | 0.1175 | 1.0000 | 0.0093 |
| val_seed42_entropy000 | 8 | 0.0619 | 1.0000 | 0.8059 | 0.9395 | 0.3289 | 0.2723 | 0.1319 | 1.0000 | 0.0141 |
| val_seed42_entropy005 | 8 | 0.0542 | 1.0000 | 0.8059 | 0.9395 | 0.3228 | 0.2723 | 0.1763 | 1.0000 | 0.0123 |

## The test-split failures under seed-42 entropy 0.005

| transaction_id | corridor | simulation_date | regime | amount | amount_over_cheapest_liquidity | amount_over_combined_liquidity | fee_rank0_det_share | fee_rank0_liquidity_share_of_amount | det_unrouted_pct | det_reward | waterfall_reward | sample_completion_rate | sample_reward_median | sample_reward_max | primary_cause |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 300005 | GBR->PHL | 2024-11-07 | splitting_needed | 495000.0000 | 4.0821 | 0.8515 | 0.2741 | 0.2450 | 0.0291 | 1.5443 | 1.5883 | 0.1900 | 1.5238 | 1.6236 | a_b_over_allocation_with_spare_elsewhere |
| 300042 | GBR->PHL | 2025-04-07 | splitting_needed | 495000.0000 | 4.4887 | 0.8470 | 0.2754 | 0.2228 | 0.0526 | 1.1521 | 1.2915 | 0.1350 | 1.1311 | 1.3054 | a_b_over_allocation_with_spare_elsewhere |
| 300051 | GBR->PHL | 2025-06-01 | splitting_needed | 495000.0000 | 3.9347 | 0.8976 | 0.2739 | 0.2542 | 0.0230 | 1.1928 | 1.2441 | 0.1450 | 1.1516 | 1.2673 | a_b_over_allocation_with_spare_elsewhere |
| 300071 | GBR->PHL | 2025-05-25 | splitting_needed | 495000.0000 | 4.2553 | 0.8333 | 0.2736 | 0.2350 | 0.0386 | 1.1828 | 1.3136 | 0.1250 | 1.1609 | 1.3180 | a_b_over_allocation_with_spare_elsewhere |
| 300084 | GBR->PHL | 2025-03-12 | splitting_needed | 495000.0000 | 4.1468 | 0.8678 | 0.2762 | 0.2412 | 0.0409 | 1.5860 | 1.6582 | 0.1300 | 1.5450 | 1.7236 | a_b_over_allocation_with_spare_elsewhere |
| 300099 | GBR->PHL | 2024-10-18 | splitting_needed | 495000.0000 | 3.7126 | 0.9177 | 0.2722 | 0.2694 | 0.0029 | 1.3195 | 1.3326 | 0.0900 | 1.2110 | 1.3650 | a_b_over_allocation_with_spare_elsewhere |

Test overlap: 6 transaction(s) fail under both seed-42 checkpoints; 0 fail only under 0.005; 8 only under 0.0.

## Validation cross-check: recurrence across the six checkpoints

8 distinct validation transactions fail under at least one checkpoint; 8 fail under 2+, 4 under 4+, 1 under all 6.

| transaction_id | n_checkpoints_failed |
|---|---|
| 200019 | 6 |
| 200045 | 5 |
| 200072 | 5 |
| 200061 | 5 |
| 200035 | 3 |
| 200018 | 3 |
| 200070 | 2 |
| 200073 | 2 |

## Cause rules

Primary cause (priority order): `e_exceeds_combined_liquidity` (amount > combined feasible liquidity); `d_reward_tradeoff` (deterministic PPO reward >= waterfall reward despite unrouted); `a_b_over_allocation_with_spare_elsewhere` (requested > liquidity on >=1 slot, clipped and not redistributed, while another slot had unused liquidity). Flag `c_distribution_contains_better_actions`: some stochastic samples complete and the best sample beats the deterministic reward.

Facts above are measured. Any explanation of *why* the policy mean lands where it does is a hypothesis.
