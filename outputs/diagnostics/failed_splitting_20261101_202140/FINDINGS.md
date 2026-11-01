# Failed-transaction diagnosis (Stage 1D)

Generated: 20261101_202140 | git HEAD `e043cec29c6250a66d88f78e37c5bc4f1229da17` (dirty: True) | device cuda
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

## Failure mechanism and flags by checkpoint

| checkpoint | over_allocation_clipped | ppo_reward_ge_waterfall | zero_action_reward_ge_waterfall | sample_completes_and_beats_det |
|---|---|---|---|---|
| test_seed42_entropy000 | 14 | 6 | 6 | 13 |
| test_seed42_entropy005 | 6 | 0 | 0 | 6 |
| val_seed123_entropy000 | 5 | 1 | 5 | 4 |
| val_seed123_entropy005 | 4 | 1 | 4 | 3 |
| val_seed2026_entropy000 | 2 | 1 | 2 | 0 |
| val_seed2026_entropy005 | 4 | 1 | 4 | 3 |
| val_seed42_entropy000 | 8 | 3 | 8 | 5 |
| val_seed42_entropy005 | 8 | 3 | 8 | 6 |

Mechanism is exclusive; flags are independent counts and overlap with each other and with the mechanism.

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

## Over-allocated bridge (fee rank: 0 = cheapest)

| checkpoint | [0, 2] | [0] | [1] | [2] |
|---|---|---|---|---|
| test_seed42_entropy000 | 6 | 7 | 0 | 1 |
| test_seed42_entropy005 | 2 | 4 | 0 | 0 |
| val_seed123_entropy000 | 0 | 0 | 5 | 0 |
| val_seed123_entropy005 | 0 | 0 | 4 | 0 |
| val_seed2026_entropy000 | 0 | 1 | 1 | 0 |
| val_seed2026_entropy005 | 0 | 0 | 4 | 0 |
| val_seed42_entropy000 | 1 | 7 | 0 | 0 |
| val_seed42_entropy005 | 1 | 7 | 0 | 0 |

## Per-checkpoint aggregates

| checkpoint | n_failed | mean_unrouted_pct | mean_clipped_pct | max_clip_pct_slot_liq | mean_spare_pct | max_amount_over_combined | mean_sample_completion | mean_frac_complete_beat_det | best_sample_completes | mean_gap_wf_minus_ppo |
|---|---|---|---|---|---|---|---|---|---|---|
| test_seed42_entropy000 | 14 | 0.0658 | 0.0658 | 0.4850 | 0.4066 | 0.9177 | 0.1936 | 0.1371 | 0.5714 | 0.1231 |
| test_seed42_entropy005 | 6 | 0.0312 | 0.0312 | 0.2361 | 0.1830 | 0.9177 | 0.1358 | 0.1358 | 1.0000 | 0.0751 |
| val_seed123_entropy000 | 5 | 0.1239 | 0.1239 | 0.3468 | 0.2808 | 0.9395 | 0.0300 | 0.0300 | 0.6000 | 0.0403 |
| val_seed123_entropy005 | 4 | 0.0458 | 0.0458 | 0.1930 | 0.2035 | 0.9395 | 0.0813 | 0.0638 | 0.7500 | 0.0104 |
| val_seed2026_entropy000 | 2 | 0.0361 | 0.0361 | 0.1006 | 0.2609 | 0.9395 | 0.2350 | 0.0000 | 0.0000 | -0.0083 |
| val_seed2026_entropy005 | 4 | 0.0592 | 0.0592 | 0.1651 | 0.2170 | 0.9395 | 0.1175 | 0.1150 | 0.7500 | 0.0093 |
| val_seed42_entropy000 | 8 | 0.0619 | 0.0619 | 0.5278 | 0.3164 | 0.9395 | 0.1319 | 0.0587 | 0.2500 | 0.0141 |
| val_seed42_entropy005 | 8 | 0.0542 | 0.0542 | 0.4104 | 0.3087 | 0.9395 | 0.1763 | 0.0862 | 0.3750 | 0.0123 |

## The test-split failures under seed-42 entropy 0.005

| transaction_id | corridor | simulation_date | amount | amount_over_combined_liquidity | fee_rank0_det_share | fee_rank0_liquidity_share_of_amount | det_unrouted_pct | det_reward | waterfall_reward | sample_completion_rate | sample_frac_complete_and_beat_det | best_completing_sample_reward | mechanism |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 300005 | GBR->PHL | 2024-11-07 | 495000.0000 | 0.8515 | 0.2741 | 0.2450 | 0.0291 | 1.5443 | 1.5883 | 0.1900 | 0.1900 | 1.6236 | over_allocation_clipped |
| 300042 | GBR->PHL | 2025-04-07 | 495000.0000 | 0.8470 | 0.2754 | 0.2228 | 0.0526 | 1.1521 | 1.2915 | 0.1350 | 0.1350 | 1.3054 | over_allocation_clipped |
| 300051 | GBR->PHL | 2025-06-01 | 495000.0000 | 0.8976 | 0.2739 | 0.2542 | 0.0230 | 1.1928 | 1.2441 | 0.1450 | 0.1450 | 1.2673 | over_allocation_clipped |
| 300071 | GBR->PHL | 2025-05-25 | 495000.0000 | 0.8333 | 0.2736 | 0.2350 | 0.0386 | 1.1828 | 1.3136 | 0.1250 | 0.1250 | 1.3180 | over_allocation_clipped |
| 300084 | GBR->PHL | 2025-03-12 | 495000.0000 | 0.8678 | 0.2762 | 0.2412 | 0.0409 | 1.5860 | 1.6582 | 0.1300 | 0.1300 | 1.7236 | over_allocation_clipped |
| 300099 | GBR->PHL | 2024-10-18 | 495000.0000 | 0.9177 | 0.2722 | 0.2694 | 0.0029 | 1.3195 | 1.3326 | 0.0900 | 0.0900 | 1.3650 | over_allocation_clipped |

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

## Interpretation

### Measured facts

- 51 failed (checkpoint, transaction) rows. Corridors: {'GBR->PHL': 51}. Regimes: {'splitting_needed': 51}.
- Mechanism: 51/51 over-allocation with clipping (excess not redistributed); 0/51 exceed combined liquidity. Max amount/combined liquidity = 0.9395.
- Clipped excess: median 5.13% of amount (range 0.18%-23.78%).
- Deterministic PPO reward >= waterfall reward in 16/51 rows. The waterfall is a fee-ordered heuristic, not reward-optimal, so this is not evidence that unrouted money is reward-optimal.
- All-zero action, executed via env.step: reward(s) [0.0], max |unrouted| reported 0.0000; zero-action reward >= waterfall reward in 37/51 rows.
- Stochastic samples: in 40/51 rows at least one single sample both completes and beats the deterministic reward; the highest-reward sample completes in 28/51 rows.
- Deterministic action sums: min 1.000000, max 1.000000. Waterfall action sums: min 1.000000, max 1.000000.

### Hypotheses (not established by this diagnosis)

- H1: the deterministic mean allocation does not track per-date liquidity closely enough at the capacity boundary, so small overshoots on one bridge are clipped and lost.
- H2: the env computes unrouted as requested minus executed, so an action that requests less than the full amount is not penalised for the unrequested part (see the all-zero action above). PPO's Dirichlet actions sum to 1, so PPO itself cannot under-request; this concerns reward/metric semantics for under-requesting policies, not the failures above.
- H3: the entropy coefficient does not address H1; failures recur on the same transactions under both coefficients.

None of these hypotheses has been tested by changing the model, reward or environment.

## Definitions

Mechanism (exclusive): `exceeds_combined_liquidity`; `over_allocation_clipped` (>=1 bridge requested more than its liquidity, excess clipped and not redistributed, while combined liquidity sufficed); `other`.
Flags (non-exclusive): `ppo_reward_ge_waterfall`; `zero_action_reward_ge_waterfall` (all-zero action run through env.step); `sample_completes_and_beats_det` (a single sample does both); `amount_within_1pct_of_combined`.
