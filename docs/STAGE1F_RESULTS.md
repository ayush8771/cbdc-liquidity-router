# Stage 1F — Comprehensive Backtesting & Evaluation: Results

**Run:** `outputs/backtests/stage1f_backtest_20261102_023545/`. That folder is the source of truth; every number below is copied from its `REPORT.md`, `metrics_*.csv`, `statistics.json` or `reward_sensitivity.csv`.
**Scope:** evaluation only. Nothing was trained or tuned, and the PPO model, CNN, environment and reward are unchanged. These are simulation-based findings under stated assumptions.

---

## 1. Design

| Item | Choice |
|---|---|
| **Evaluation set** | Union of the three Stage 1D synthetic holdouts (seeds 20261102, 20261103 and 20261104), none of which was used for training, checkpoint selection or tuning. Loaded 1,500 rows, then removed 2 exact duplicates of examined test-split rows and 38 exact-duplicate rows (same corridor, date and amount) within or across holdouts. **1,460 transactions** remain, on 2024-02-01..2025-08-30. |
| **Checkpoints (multi-seed)** | The six Stage 1D multi-seed checkpoints (seeds 42/123/2026 × `ENTROPY_COEF` 0.0/0.005), each selected on validation. |
| **Policies** | `ppo_original` (deterministic PPO); `ppo_projected` (the same action with the inference-time capped-simplex projection); `liquidity_waterfall`; `cheapest_feasible`. Every action goes through the unchanged `env.step()`. |
| **Stress scenarios** | `baseline`; `liquidity_minus30` (all liquidity ×0.7); `liquidity_minus50` (×0.5); `cheapest_venue_outage` (the fee-cheapest venue per corridor at 10% liquidity); `congestion_x2`; `combined_stress` (liquidity ×0.7 and congestion ×1.5). |
| **Transaction scenarios** | Regimes are recomputed under each scenario from the stressed liquidity. Liquidity stress creates `exceeds_combined` cases: 111–174 per scenario, against 5 in the baseline. |
| **Metrics** | Amount-based completion and unrouted share; reward as computed by the environment (`reward_env`); **amount-based reward** (`reward_amount` = cost − latency − risk − (amount − executed)/amount); cost term; latency; utilization; bridges used; decision time. |
| **Statistics** | Paired per-transaction differences. Two-level cluster bootstrap over checkpoints × simulation-date clusters, which accounts for model variation and for transactions that share a date's bridge state: 95% percentile CI and two-sided p. Holm–Bonferroni within each family (primary H1–H4 on the baseline; each stress scenario its own family). Wilcoxon and sign tests are secondary. Bootstrap: 10,000 draws for the primary family, 2,000 for secondary, seed 1. |
| **Pre-registration** | `analysis_plan.json` (SHA-256 `17d41133e813…`) was written before any evaluation. The equivalence margins (±0.005 reward, ±0.01 completion) were chosen after the Stage 1D holdout results had been seen, which the plan discloses. |
| **Leakage guards** | All four pass (`leakage_report.json`): every date lies in the out-of-time test window, outside the gap buffers; no row duplicates train (0) or validation (0); examined test-split duplicates are excluded; checkpoints were selected on validation only. Input data hashes were verified unchanged after the run. |

The run produced 122,640 rows (6 scenarios × 1,460 transactions × (2 baselines + 6 checkpoints × 2 PPO variants)), in 593–762 s per scenario on CUDA (RTX 3050). Batched inference reproduces the Stage 1D per-transaction results to within ≤3.4×10⁻⁷ in reward, with identical completion (regression-tested).

## 2. Primary hypotheses (baseline scenario; Holm over H1–H4)

| Test | Estimate | 95% CI | Holm p | Checkpoints +/− | Verdict |
|---|---:|---|---:|---|---|
| H1 projected − waterfall, reward (env) | +0.00174 | [−0.01311, +0.01621] | 1.00 | 4 / 2 | **Inconclusive** |
| H2 projected − original, completion | +0.0457 | [+0.0251, +0.0691] | <0.001 | 6 / 0 | **Positive** |
| H3 original − waterfall, reward (env) | −0.00189 | [−0.01632, +0.01231] | 1.00 | 0 / 6 | **Inconclusive** |
| H4 projected − waterfall, completion | 0.0000 | [0, 0] | 1.00 | 0 / 0 | **Identical** (both 0.9966) |

In the H4 row, "Identical" means projected PPO and the waterfall completed exactly the same transactions. The automatic equivalence label for that row reads "practically_negligible" only because its CI collapses to [0, 0].

A p-value shown as <0.001 means no bootstrap draw crossed zero, with a resolution of 1/10,000.

Baseline means across checkpoints (the waterfall and cheapest-feasible are deterministic):

| Policy | Completion | Unrouted share | Reward (env) | Cost term | Latency | Bridges used |
|---|---:|---:|---:|---:|---:|---:|
| ppo_original | 0.9509 | 0.0056 | 0.9577 ± 0.0021 | 2.1465 | 1.1853 | 3.00 |
| ppo_projected | 0.9966 | 0.0002 | 0.9613 ± 0.0031 | 2.1518 | 1.1905 | 3.00 |
| liquidity_waterfall | 0.9966 | 0.0002 | 0.9595 | 2.1550 | 1.1955 | 1.63 |
| cheapest_feasible | 0.3829 | 0.3068 | 0.5891 | 1.7257 | 0.9264 | 1.00 |

## 3. Stress tests

All rewards in this section are amount-based (the plan's primary stress metric). Completion for projected PPO equals the waterfall's exactly in every scenario.

| Scenario | Completion: original / projected = waterfall / cheapest | Projected − waterfall reward [95% CI], Holm p | Original − waterfall reward [95% CI], Holm p |
|---|---|---|---|
| baseline | 0.951 / 0.997 / 0.383 | +0.0017 [−0.0132, +0.0160], 1.00 | −0.0017 [−0.0162, +0.0126], 1.00 |
| liquidity_minus30 | 0.877 / 0.924 / 0.173 | +0.0001 [−0.0121, +0.0116], 1.00 | −0.0085 [−0.0213, +0.0033], 0.56 |
| liquidity_minus50 | 0.776 / 0.881 / 0.123 | +0.0007 [−0.0084, +0.0096], 1.00 | **−0.0236 [−0.0396, −0.0112], <0.001** |
| cheapest_venue_outage | **0.156** (range 0.061–0.412) / 0.965 / 0.012 | **+0.0046 [+0.0005, +0.0092], 0.042** (6/0) | **−0.2358 [−0.3417, −0.1370], <0.001** |
| congestion_x2 | 0.944 / 0.997 / 0.383 | +0.0023 [−0.0296, +0.0331], 1.00 | +0.0072 [−0.0242, +0.0381], 1.00 |
| combined_stress | 0.876 / 0.924 / 0.173 | +0.0010 [−0.0178, +0.0183], 1.00 | +0.0056 [−0.0123, +0.0237], 1.00 |

Projected − original completion is positive in every scenario, from +4.6 to +81.0 points (Holm p < 0.001, 6 of 6 checkpoints each time).

**Diagnostic: PPO barely responds to liquidity.** For checkpoint seed 42 / entropy 0.0, on the first 100 evaluation transactions:

| Scenario | Deterministic share to the fee-cheapest venue | Cheapest venue's liquidity ÷ amount (median) | Share exceeds that venue's capacity |
|---|---|---|---|
| Baseline | 0.324–0.348 | 0.827 | 13% of transactions |
| Outage | 0.321–0.335 | 0.083 | 94% of transactions |

The mean change in that share was only 0.006. The learned policy behaves almost like a fixed allocation. The capacity awareness seen in Sections 2–3 comes from the projection, not from PPO. This diagnostic covers one checkpoint. In the outage, original PPO's completion is far below the projection's on every checkpoint: 6.1–41.2% (mean 15.6%) against 96.5%.

## 4. Regimes

These are completion figures; full tables are in `REPORT.md` and `metrics_by_regime.csv`.
- **`splitting_needed`:** original PPO fails where the others complete. Baseline completion is 0.898 for original PPO against 1.000 for projected PPO and the waterfall; under −50% liquidity it's 0.859 against 1.000; under the outage, 0.146 against 1.000.
- **`exceeds_combined`:** no policy can complete these transactions. Projected PPO and the waterfall fill every bridge to capacity and get identical rewards. Under `combined_stress`, original PPO gets the higher reward here (−0.928 against −0.958), because routing less avoids latency on transfers that will fail anyway.
- **`below_cheapest` and `near_boundary`:** every policy except cheapest-feasible completes about 100%, and rewards differ by ≤0.02.

## 5. Reward accounting and weight sensitivity

- **The environment overstates the reward of policies that under-request.** The environment counts unrouted as *requested − executed*, so the waterfall and projected PPO, which request less than the full amount when liquidity is short, aren't penalised for the remainder. Their environment-reported reward exceeds the amount-based reward by 0.0001 in the baseline, 0.0032 under the outage, 0.0100 under −30% liquidity or combined stress, and **0.0364** under −50% liquidity. That's larger than every policy difference in Section 3 apart from the outage. Original PPO's actions always sum to 1, so it's unaffected. Comparisons under liquidity stress must use the amount-based reward.
- **Weight sensitivity** (evaluation-time only; the policies were not retrained). Grid: λ_latency ∈ {0.5, 1, 2} × λ_unrouted ∈ {1, 5, 10}.
  - **Projected − waterfall:** inconclusive at every grid point in every scenario except the outage. There it's positive for λ_latency ≥ 1 (+0.0046 at 1, +0.0101 at 2) and practically negligible at 0.5. λ_unrouted has no effect on this comparison, because both policies leave identical unrouted amounts.
  - **Best-scoring policy depends on the weights:** with λ_latency = 0.5 the waterfall scores highest in 5 of 6 scenarios. With λ_latency = 2 and λ_unrouted = 1, **cheapest-feasible** scores highest under `congestion_x2` and `combined_stress`, because its large unrouted amounts are penalised less than routing them would cost in latency. A ranking that flips this way is not a robust property of the policies.

## 6. Performance

Median PPO decision time is 0.63–0.69 ms per transaction (batched inference on GPU), with projection adding about 0.3 ms. The waterfall takes 3.4–4.6 ms per decision, because each venue's liquidity is looked up separately.

One timing artefact: the *mean* PPO decision time under `liquidity_minus50` (18.7 ms) is inflated by GPU contention from a concurrent test run. The medians are unaffected.

## 7. Findings

1. **Projection is what makes PPO capacity-aware.** It raises completion to the waterfall's level in every scenario, with gains up to +81 points, all significant. Without it, PPO fails badly when the cheap venue's liquidity collapses: mean completion 15.6% (6.1–41.2% across checkpoints).
2. **PPO is not better than the waterfall on reward.**
   - Projected PPO minus the waterfall is inconclusive at baseline (+0.0017, CI ±0.015) and under five of six scenarios.
   - The one significant result is the cheapest-venue outage: +0.0046 [+0.0005, +0.0092], Holm p 0.042, 6 of 6 checkpoints. It's small, below the 0.005 margin as a point estimate, and it disappears when latency is weighted at 0.5.
3. **Original PPO is significantly worse than the waterfall under severe liquidity stress:** −0.024 at −50% liquidity and −0.236 under the outage.
4. **The learned policy barely responds to liquidity** in the diagnostic above. This matches the Stage 1D finding that failures come from small overshoots at the capacity boundary, and it suggests training did not learn capacity-aware allocation.
5. **The environment's reward accounting understates unrouted value under liquidity shortage.** That alone can be large enough to change the picture.
6. **Policy rankings depend on the placeholder reward weights,** so they are not robust.

## 8. Limitations

- **No genuinely independent out-of-time data.** All data ends on 2025-09-30. The holdouts share the test period with the already-examined test split: 76 of 1,460 evaluation transactions fall on a test-split date, and 30-day history windows overlap. Stress scenarios test robustness to shifted conditions; they are **not** a substitute for future data.
- **Synthetic conditions:** synthetic liquidity, congestion and transactions; 3 corridors; 6 checkpoints from 3 seeds.
- **Stress is simplistic:** scenarios are uniform multipliers over the whole series, not calibrated historical shocks, so the CNN sees out-of-distribution normalized inputs. That's intended as stress, but it isn't realistic dynamics.
- **Placeholder reward weights** (all λ = 1.0); the sensitivity analysis is evaluation-time only.
- **Margins chosen with hindsight:** the equivalence margins were chosen after Stage 1D results were seen, and are disclosed as such in the plan.
- **Optimistic secondary tests:** Wilcoxon and sign tests assume independent transactions. The cluster bootstrap is the primary inference.
- **Narrow diagnostic:** the policy-insensitivity check covers one checkpoint and 100 transactions.
- **Bootstrap resolution:** p-values shown as 0 mean below 1/n_boot.
- **Timing caveat:** decision times come from one machine and include a contention artefact (Section 6).

## 9. Reproduce

```powershell
python run_stage1f_backtest.py                       # all scenarios, about 1 hour on RTX 3050
python run_stage1f_backtest.py --scenarios baseline --limit 50 --out-root <scratch dir>   # smoke run
python -m pytest tests/test_stage1f.py               # 16 tests
```
