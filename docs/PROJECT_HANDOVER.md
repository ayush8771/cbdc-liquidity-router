# CBDC Liquidity Router — Complete Project Handover

**Handover prepared:** 31 October 2026  
**Repository folder previously used:** `cbdc-liquidity-router`  
**Current milestone:** Stage 1D finalized (1 November 2026); Stages 1E–1F planned, not started\
**Primary handover target:** Claude (web) + Claude Code working directly in the repository

> **Status update (1 November 2026): Stage 1D finalized.** Sections 1–8 below are the original handover and are kept as a historical record. The finalized Stage 1D results are in [section 8A](#8a-stage-1d-finalized-results-1-november-2026) and in `docs/STAGE1D_RESULTS.md`, which is authoritative for all numbers. Sections 6, 9 and 14 have been updated to the current state.

> **Important source-of-truth rule:** This document summarizes the project state established in prior development conversations and the latest experiment output supplied by the developer. It is not a substitute for inspecting the live repository. The receiving agent must first inspect the actual branch, files, git history, data, scripts, and tests. Where this document says “known”, confirm the implementation still matches before making a change.

---

## 1. What this project is

The CBDC Liquidity Router is a research/prototype system for routing cross-border CBDC transactions through a network of bridge venues. Each transaction has an amount, sender, receiver, and simulation date. The system evaluates feasible bridge venues and allocates the transaction across them.

The project is not merely a shortest-path or cheapest-bridge selector. The core Stage 1D research objective is to build a learned routing policy that can respond to changing bridge conditions, including:

- available liquidity at each bridge;
- congestion/latency conditions;
- transaction amount and corridor;
- feasibility and capacity constraints;
- transaction cost and risk signals.

A transaction may be completed through one bridge when its capacity is sufficient, or split across multiple feasible bridges when required. If requested allocation exceeds a bridge's available capacity, execution is clipped by the environment and any unexecuted amount remains unrouted. Confirm this exact behaviour in the live environment before changing it.

### Main research question
Can a PPO policy learn capacity-aware, cost-conscious and congestion-aware allocation decisions that are competitive with a deterministic liquidity-aware waterfall baseline, especially for transactions whose amount exceeds the liquidity of the cheapest bridge?

---

## 2. Policy and algorithm overview

The project compares three policies through the same environment execution/reward path:

1. **Cheapest-feasible baseline** — selects the cheapest feasible bridge. It is intentionally simple and demonstrates why selecting only the cheapest bridge fails when that bridge lacks enough liquidity.
2. **Liquidity-aware waterfall baseline** — allocates using bridge liquidity/capacity, continuing to other bridges when necessary. It is currently the strongest hand-crafted benchmark.
3. **PPO policy** — a Proximal Policy Optimization actor-critic model. It receives Stage 1D raw observations and historical windows and produces allocation shares over feasible bridge slots.

### PPO model shape and action semantics (known from prior inspection; verify)
- Shared CNN/window encoder inherited from the preceding model design.
- Combined representation: 31 raw features plus a 384-dimensional CNN representation (415-dimensional combined representation).
- Actor emits positive Dirichlet concentration parameters (softplus plus a small minimum concentration).
- Critic predicts value.
- A feasible-subset Dirichlet distribution is used so infeasible bridge slots receive zero allocation.
- Actions are allocation shares over feasible slots; the allocation should respect the model's simplex semantics.
- Deterministic evaluation uses the normalized Dirichlet concentration values; stochastic action sampling uses a Dirichlet sample.
- Check the current `src/models/ppo_actor_critic.py` before relying on exact dimensions or method signatures.

### Training structure (known)
- Each transaction is treated as a one-step episode.
- `GAMMA = 0.0` is consistent with the one-step setup.
- Training split is used for gradient updates.
- Validation split is used for model selection/checkpoint selection, not gradient updates.
- The previously used experiment settings were 20 epochs, batch size 32, learning rate `3e-4`, seed 42, with four PPO optimization epochs per update.
- Re-check all settings in the current source and experiment script.

---

## 3. Stage-by-stage development history

### Stage 1A — foundational pipeline
- Previously validated with **17 tests**.
- Preserve its original semantics and regression coverage.

### Stage 1B — macro/risk-related preprocessing and data validation
- Previously validated with **26 tests**.
- A known warning remains in `src/preprocessing/macro_risk.py` around `Series.pct_change()` default `fill_method='pad'` deprecation. It was a FutureWarning, not a failure.
- Avoid changing historical preprocessing semantics simply to silence this warning. Any change must be assessed explicitly and tested.

### Stage 1C — historical windows/model foundation
- Previously validated with **13 tests**.
- The Stage 1D CNN/window encoder is intended to preserve the preceding Stage 1C windowing design.

### Stage 1D — dynamic, capacity-aware RL extension
Known implementation elements added or modified during Stage 1D:

- Dynamic bridge liquidity and congestion state lookup connected to observation and environment execution.
- Risk proxy for source/destination corridor risk.
- Lagged real RPW corridor cost baseline used when available, with a synthetic fallback for ARE→MEX.
- Regime-stratified transaction generator and train/validation/test splits.
- Six synthetic bridge venues added to expand a three-corridor topology from one to three venues per corridor (nine bridge venues in total). Original venue records were intended to remain unchanged and synthetic additions tagged with `synthetic_bridge_expansion` provenance.
- PPO actor-critic with a masked Dirichlet allocation head.
- Raw observation wrapper and normalization.
- Cheapest-feasible and liquidity-aware waterfall baselines.
- Evaluation metrics including completion, bridge counts, largest allocation, allocation entropy, and regime-grouped metrics.
- Regression tests preserving earlier stages.

Prior test counts after metric-test additions: Stage 1D **33 tests**, then two entropy tests brought it to **35 tests**.

---

## 4. Data, topology and transaction regimes

### Known Stage 1D data splits
| File | Rows | Purpose |
|---|---:|---|
| `data/processed/stage1d_transactions_train.csv` | 500 | PPO gradient updates |
| `data/processed/stage1d_transactions_validation.csv` | 100 | validation/model selection |
| `data/processed/stage1d_transactions_test.csv` | 100 | held-out evaluation used in recorded experiment |

The receiving agent must verify these exact files, hashes, schemas, generation commands, and whether they are tracked in Git/LFS or stored outside the repository.

### Known test split regime counts
| Regime | Count |
|---|---:|
| `splitting_needed` | 48 |
| `near_boundary` | 33 |
| `below_cheapest` | 19 |
| `exceeds_combined` | 0 in this test split |

`exceeds_combined` may be absent in the test split due to the transaction generator and frozen regulatory transaction cap. Previous analysis found it near-unreachable under the frozen $500,000 cap; it was not meant to be force-labelled. Verify the generator and cap in the live code before changing these semantics.

### Previously recorded training regime counts
- `splitting_needed`: 233
- `near_boundary`: 138
- `below_cheapest`: 126
- `exceeds_combined`: 3

These counts are historical observations, not guaranteed current counts. Regenerate only if explicitly asked and preserve seed/provenance.

### Capacity boundary coverage (historical analysis)
Prior analysis of 500 training rows found meaningful transaction coverage around the cheapest-bridge-liquidity boundary, including roughly 145 examples with amount/cheapest-liquidity ratios in the 0.8–1.2 range. This suggested that the initial splitting issue was not obviously caused by a total absence of boundary examples. Recompute from the live CSVs before making dataset-adequacy claims.

---

## 5. Environment, reward and important semantics

### Dynamic state and execution
The intended design connects date-specific bridge liquidity/congestion to the transaction observation and execution. The environment execution logic previously inspected used a capacity clip conceptually equivalent to:

`executed_i = min(requested_i, available_capacity_i)`

There was no redistribution of clipped shares after execution. This is important: if PPO proposes too much allocation to one bridge, the excess may remain unrouted rather than automatically moving to another bridge. This is a core reason capacity-aware allocation matters. Verify the current exact implementation in `src/envs/cbdc_env.py`.

### Reward composition (prior code inspection)
The reward was described as combining:
- cost benefit relative to a baseline cost;
- congestion/latency penalty;
- risk penalty;
- unrouted-amount penalty.

The previously inspected conceptual structure was:

- `cost_term = (baseline_cost_pct * executed_amount - sum(executed_i * fee_i)) / transaction_amount`
- `latency_term = sum((executed_i / transaction_amount) * congestion_i)`
- `risk_term = sum((executed_i / transaction_amount) * risk_i)`
- `unrouted_term = unrouted_amount / transaction_amount`
- `reward = cost_term - lambda_latency * latency_term - lambda_risk * risk_term - lambda_unrouted * unrouted_term`

Earlier defaults/lambdas were placeholders; do not assume their values remain unchanged. Inspect `reward.py` and its call sites.

### Lagged real RPW baseline
Previous inspection found that the environment calls `lagged_real_cost_baseline_pct(sender, receiver, simulation_date)` when an explicit baseline is not supplied. The cost baseline module builds a lagged quarterly mapping from RPW corridor data; ARE→MEX uses an existing synthetic fallback. The new agent must verify no look-ahead leakage and preserve the lag convention.

---

## 6. Test status and known warning

**Current (1 November 2026):** `python -m pytest tests/` → **111 passed, 9 warnings**. The breakdown is Stage 1A 17, Stage 1B 26, Stage 1C 13, Stage 1D 35, and capacity projection 20 (`tests/test_capacity_projection.py`). In the Stage 1D file, the entropy test now asserts `ENTROPY_COEF == 0.0` and `EXPERIMENTAL_ENTROPY_COEF == 0.005`, and the file still has 35 tests. The 9 warnings are unchanged (pandas `pct_change`).

Historical record — full-suite result after adding the two entropy tests:

```text
91 passed, 9 warnings
Stage 1A: 17
Stage 1B: 26
Stage 1C: 13
Stage 1D: 35
```

Command:

```powershell
python -m pytest tests/
```

The 9 warnings were repeated Pandas FutureWarnings from `macro_risk.py` using `daily["rate"].pct_change()` without an explicit `fill_method`. They did not fail the suite.

A direct Stage 1D run previously returned:

```powershell
python tests/test_stage1d.py
# 35 passed, 0 failed out of 35
```

**The receiving agent must rerun tests from the current checkout.** These results are evidence of the previous state, not a guarantee after handover or future changes.

Two entropy-related tests were added to the existing 33-test Stage 1D suite; do not replace that file with an older 27-test version found in a prior generated ZIP. Preserve the current 35-test file and its eight evaluation-metric tests.

---

## 7. Entropy regularization: motivation and implementation

### Why it was tried
The original PPO deterministic policy sometimes concentrated too heavily on the first/cheapest bridge even when capacity was insufficient. In prior diagnostics of failed `splitting_needed` transactions:

- The deterministic action was often extremely concentrated on bridge 0.
- Stochastic sampling from the same policy sometimes produced significantly better capacity-aware allocations.
- In several sampled counterfactuals, reducing bridge 0 allocation and increasing bridge 1/2 allocation improved reward and reduced unrouted amount.
- These findings motivated the hypothesis that stronger exploration during training might improve the learned policy.

This was a hypothesis, not a proven diagnosis.

### Entropy loss
The intended active loss is:

```python
entropy_bonus = entropy.mean()
loss = policy_loss + 0.5 * value_loss - ENTROPY_COEF * entropy_bonus
```

The baseline uses `ENTROPY_COEF = 0.0`; the experimental condition uses `ENTROPY_COEF = 0.005`.

Two tests were added:
1. Verify the coefficient is explicitly non-zero at the configured experimental value.
2. Run otherwise identical PPO updates with coefficient zero and 0.005 and verify that the resulting parameters differ, demonstrating that entropy affects optimization.

Verify current `ppo_train.py` and tests before relying on this wiring. During the experiment, the coefficient was switched at runtime by the paired experiment script; do not assume the permanent default has been changed.

### Important distinction between entropy metrics
- **Policy entropy** is the entropy returned by the Dirichlet distribution and used in the training loss.
- **Allocation entropy** in test metrics is calculated from the final action/allocation shares.

They are related but are not the same quantity. Maximizing policy entropy does not guarantee that deterministic allocations become more evenly distributed.

---

## 8. Completed paired entropy experiment (seed 42)

### Configuration
Experiment output folder recorded by the developer:

`outputs/experiments/stage1d_entropy_pair_seed42_20261031_153140/`

Saved outputs:

```text
baseline_entropy000/
  ppo_checkpoint.pt
  training_history.csv
  evaluation_metrics.json
entropy005/
  ppo_checkpoint.pt
  training_history.csv
  evaluation_metrics.json
experiment_config.json
paired_comparison.json
```

Both conditions used:
- train 500 rows;
- validation 100 rows;
- test 100 rows;
- 20 epochs;
- batch size 32;
- learning rate 0.0003;
- random seed 42;
- same PPO architecture;
- evaluation on the same test split;
- GPU device `cuda` (RTX 3050 Laptop GPU 6 GB).

### Overall PPO test comparison
| Metric | Entropy 0.0 | Entropy 0.005 | Difference |
|---|---:|---:|---:|
| Mean reward | 0.888615 | 0.899642 | +0.011027 |
| Completion rate | 0.86 | 0.94 | +0.08 |
| Total unrouted | $451,728.92 | $92,600.98 | -$359,127.94 |
| Liquidity utilization | 0.985247 | 0.996976 | +0.011729 |
| Mean bridges used | 3.0 | 3.0 | 0 |
| Multi-bridge rate | 1.0 | 1.0 | 0 |
| Mean largest allocation | 0.504441 | 0.588156 | +0.083716 |
| Mean allocation entropy | 1.430959 | 1.356152 | -0.074807 |
| Mean latency cost | 1.053457 | 1.063486 | +0.010030 |
| Mean risk cost | 0.0 | 0.0 | 0 |
| Mean cost term | 1.951286 | 1.964999 | +0.013713 |

Interpretation:
- Overall mean reward rose by around 0.0110.
- Completion rose from 86% to 94% (+8 percentage points, 8 extra completed transactions out of 100).
- Total unrouted value fell by approximately 79.5%.
- Liquidity utilization improved.
- Mean number of bridges and multi-bridge rate were unchanged at 3 and 100% respectively.
- The final deterministic allocations became more concentrated by the reported largest-share and allocation-entropy metrics. Do not claim that final allocations became more evenly spread.

### Regime-specific PPO comparison
| Regime | Metric | Entropy 0.0 | Entropy 0.005 |
|---|---|---:|---:|
| `below_cheapest` (n=19) | Mean reward | 0.810147 | 0.808444 |
| | Completion | 100% | 100% |
| `near_boundary` (n=33) | Mean reward | 1.109233 | 1.102190 |
| | Completion | 100% | 100% |
| `splitting_needed` (n=48) | Mean reward | 0.768000 | 0.796490 |
| | Completion | 70.83% (34/48) | 87.5% (42/48) |
| | Failed transactions | 14 | 6 |

Main finding: the largest improvement occurred in the target `splitting_needed` regime: +0.02849 mean reward, +16.67 percentage points completion, eight more completed transactions. `below_cheapest` and `near_boundary` mean rewards decreased slightly, while completion remained unchanged at 100% for PPO in both conditions.

### Comparison to waterfall baseline
Waterfall overall:
- mean reward: 0.919709;
- completion rate: 100%;
- total unrouted: approximately $0.17;
- liquidity utilization: approximately 1.0.

Waterfall in `splitting_needed`:
- mean reward: 0.814821;
- completion: 100%;
- mean bridges used: 2.0417;
- multi-bridge rate: 100%.

Thus entropy-regularized PPO improved but still did not match waterfall on completion, total unrouted, or mean reward. The baseline remains the strongest current benchmark.

### Validation observation
- Entropy 0.0 best validation reward: 0.896450 at epoch 4.
- Entropy 0.005 best validation reward: 0.895414 at epoch 17.
- Entropy 0.005's best validation reward was slightly lower (about 0.00104).

This makes the test improvement promising but not conclusive. It is a single-seed result and the dataset is small.

### Experimental conclusion
Classify `ENTROPY_COEF=0.005` as a **promising candidate requiring multi-seed robustness validation**, not as an established improvement or permanent Stage 1D default. Do not commit it as the new accepted setting solely on the basis of seed 42.

*(Superseded by section 8A: the multi-seed validation found no consistent benefit, and the default is 0.0.)*

---

## 8A. Stage 1D finalized results (1 November 2026)

All numbers come from `docs/STAGE1D_RESULTS.md`, which also cites the output folders. If they disagree, that document and its folders are authoritative.

### Entropy coefficient — resolved
- **Experiment:** paired multi-seed, seeds 42, 123 and 2026 × {0.0, 0.005}, compared on **validation**. Folder: `outputs/experiments/stage1d_entropy_multiseed_20261101_180551/`.
- **Mean reward:** 0.8989 ± 0.0037 (0.0) versus 0.8982 ± 0.0027 (0.005), a difference of −0.0007 ± 0.0014.
- **Completion:** 0.950 versus 0.947.
- **Conclusion:** no consistent benefit. The default is `ENTROPY_COEF = 0.0`; `EXPERIMENTAL_ENTROPY_COEF = 0.005` is kept for comparison only.
- **Reproducibility:** retraining seed 42 did not reproduce the original run bit-for-bit (best validation reward 0.895447 versus 0.896450).

### Failure diagnosis — completed
- **Folder:** `outputs/diagnostics/failed_splitting_20261101_202140/` (authoritative).
- **Scope:** 51 failed rows across 8 checkpoints. All of them are `splitting_needed` transactions in **GBR→PHL**.
- **Mechanism:** every failure is an over-allocation. At least one bridge was asked for more than its liquidity, and the excess was clipped and not redistributed. None exceeded combined liquidity. The clipped excess had a median of 5.13% of the amount.
- **Unrouted-amount accounting:** the environment counts unrouted as *requested − executed*. An all-zero action therefore scores 0.0. PPO's actions sum to 1, so PPO cannot exploit this.

### Capacity projection — completed
- **What it is:** `src/training/capacity_projection.py`, an inference-time Euclidean projection onto per-bridge liquidity caps. It involves no retraining and no change to the model, environment or reward.
- **Validation result:** completion rises from 0.948 to 1.000, and reward from 0.89853 to 0.89893. The waterfall scores 0.88009 on reward. These validation figures are optimistic, because validation also selected each checkpoint.
- **Holdout result:** completion matches the waterfall on all holdouts, an increase of 3.6 to 6.8 points.

### Holdout evaluations — completed, with limitations
- **Holdouts:** three new synthetic holdouts (seeds 20261102, 20261103 and 20261104), plus overlap-sensitivity subsets. See `outputs/experiments/stage1d_holdout_README.md`.
- **Reward against the waterfall is inconclusive.** Projected PPO minus waterfall ranges from −0.0033 to +0.0051 across the five holdout views, and projected PPO wins on 2 to 6 of the 6 checkpoints.
- **No independent out-of-time holdout was possible.** The data ends at 2025-09-30, which is also the end of the test window. The holdouts share that period, and most rows' 30-day history windows overlap already-examined dates.
- **`exceeds_combined`** has only 0 to 3 rows per holdout, which is too few to evaluate.

---

## 9. Next work: recommended order

> **Status (1 November 2026):** Priorities 0–3 and 5 below are **done** (see section 8A).
> - Priority 0: the audit is complete.
> - Priority 1: the artifacts are preserved and committed.
> - Priority 2: the multi-seed experiment is done.
> - Priority 3: the failures are diagnosed.
> - Priority 5: holdouts were evaluated, but a genuinely independent out-of-time holdout was **not** possible.
>
> Priority 4, a sweep of the entropy coefficient, was not pursued, because multi-seed validation found no benefit from 0.005.
>
> Remaining work moves to **Stage 1F**:
> - an independent out-of-time holdout, which requires extending the data past 2025-09-30;
> - calibration of the reward weights (all λ are 1.0 placeholders), and sensitivity analysis;
> - confidence intervals for the PPO-vs-waterfall comparison;
> - better coverage of `exceeds_combined`;
> - deciding whether capacity awareness should be learned rather than projected.
>
> Stage 1E (Cognee) is planned. None of this has been started without approval. The priorities below are kept as the historical plan.

### Priority 0 — Establish the actual repo state (first task for Claude Code)
Before modifying anything:
1. Run `pwd` / inspect repository root.
2. Run `git status --short --branch`.
3. Inspect recent commits and tags.
4. Confirm whether the entropy implementation and two entropy tests are currently committed, staged, or uncommitted.
5. Confirm whether the experiment output directory and checkpoints exist and are ignored/tracked appropriately.
6. Inspect `run_entropy_experiment.py`, `src/training/ppo_train.py`, `src/training/evaluate.py`, `src/training/metrics.py`, `src/models/ppo_actor_critic.py`, and `tests/test_stage1d.py`.
7. Run the full test suite and record exact output.
8. Confirm all training/validation/test CSVs, source data and normalization artifacts are present and reproducible.

Do not “fix” or refactor anything during this audit unless the developer explicitly authorizes it.

### Priority 1 — Preserve experiment artifacts and baseline
- Confirm both checkpoints and JSON/CSV artifacts exist.
- Make a copy or retain the experiment folder unmodified.
- Preserve entropy=0 baseline checkpoint and entropy=0.005 checkpoint.
- Record the git commit hash corresponding to the code used for the experiment; if not captured, state that this needs reconstruction and do not invent it.

### Priority 2 — Multi-seed paired experiment
Run paired baseline/entropy conditions for additional seeds, recommended seeds `123` and `2026` (seed 42 already exists). Use identical train/validation/test splits, architecture, hyperparameters, evaluation, and checkpoint-selection rules within each pair. For each seed:
- entropy coefficient 0.0;
- entropy coefficient 0.005.

Store every run in a distinct timestamped directory. Do not overwrite the seed 42 output.

Report mean and standard deviation across seeds for:
- mean reward;
- completion rate;
- total unrouted;
- liquidity utilization;
- `splitting_needed` reward and completion;
- `near_boundary` and `below_cheapest` results;
- mean largest allocation and allocation entropy.

With only three total seeds, this is still modest evidence, not definitive statistical proof. Consider paired per-transaction outcome comparisons and confidence intervals, but avoid overclaiming given small sample sizes.

### Priority 3 — Diagnose failed splitting-needed cases
For the six remaining failed `splitting_needed` transactions in entropy=0.005:
- identify transaction IDs and corridor;
- inspect amount, per-bridge available liquidity, congestion, fee and mask;
- record deterministic PPO action, executed amount per bridge and unrouted value;
- compare with waterfall action and reward components;
- identify whether failure is due to allocation concentration, infeasible slots, distribution mismatch, reward trade-off, or environment capacity semantics.

Do not make changes until diagnosis is supported by per-transaction evidence.

### Priority 4 — Evaluate whether entropy coefficient should be tuned
Only after multi-seed comparison, consider a small, predeclared coefficient sweep (for example 0.001, 0.0025, 0.005, 0.01) using validation data for selection. Avoid selecting a coefficient based repeatedly on the already examined test split. Keep training budget and all other settings fixed.

### Priority 5 — Final untouched evaluation
The current Stage 1D test set has already been inspected in the entropy experiment. Before making final performance claims, prepare a new untouched holdout or an appropriately designed out-of-time test set with documented generation and leakage controls. Evaluate the selected candidate only after the selection process is frozen.

### Priority 6 — Later research improvements (not immediate scope)
Potential future directions, only after the current experiment is validated:
- calibration and explicit constraints for capacity-aware allocation;
- better transaction coverage and stress testing for aggregate insufficient-liquidity cases;
- additional corridors and temporal regimes;
- sensitivity analysis for reward weights;
- policy robustness under liquidity/congestion perturbations;
- stronger baseline comparisons and confidence intervals.

These are research ideas, not commitments. Do not implement them without discussing scope first.

---

## 10. Exact handover checklist: what the developer should provide

### A. Preferred: Git repository access (best for Claude Code)
The best route is to give Claude Code access to the full local repository, not paste selected source files into a chat.

1. Push the current project state to a private GitHub repository (or confirm it is already pushed).
2. Ensure all intended code changes are committed on a clearly named handover branch, e.g. `handover/stage1d-entropy-experiment`.
3. Do not commit secrets or local credentials.
4. If the new account uses a different GitHub identity and the repo is private, grant that GitHub identity collaborator access, or clone the repo locally using an account that already has access.
5. Keep large/raw datasets outside Git if repository policy requires it; document exact download/materialization instructions and checksums. Use Git LFS only if that is already the project's chosen approach and appropriate for the data volume.
6. Keep the two experiment checkpoints and result files somewhere accessible. If too large for Git, package them separately or retain them in an approved private artifact store, and provide exact paths/checksums.

Do not paste a GitHub personal access token, AWS key, cloud credential, or service-account JSON into Claude or this handover.

### B. Files that should be available to the receiving agent
At minimum:
- Entire Git repository, including `src/`, `tests/`, project configuration, README and scripts.
- `CLAUDE.md` (this package contains a starter version).
- `docs/PROJECT_HANDOVER.md` (this file).
- `run_entropy_experiment.py`.
- `outputs/experiments/stage1d_entropy_pair_seed42_20261031_153140/` including both checkpoints and all JSON/CSV results.
- Stage 1D train/validation/test transaction files, or reproducible instructions to regenerate them exactly.
- Structured/raw input data required by the environment and historical-window preprocessing.
- Normalization artifacts such as `normalization_stats.json` if the pipeline uses them.
- Data provenance notes and any license/source descriptions.
- Current `git log`, branch and tag information.

### C. Files that should NOT be shared or committed
- `.env` containing secrets;
- AWS access keys or S3 credentials;
- Firebase service account JSON;
- private tokens, SSH private keys, GitHub PATs;
- passwords or personal account data;
- unneeded virtual environment folder `venv/`;
- Python cache folders `__pycache__/`, `.pytest_cache/`;
- huge generated temporary files unless specifically required and documented.

Create or review `.gitignore` before pushing. Check `git status` and inspect staged files before commit.

### D. Environment/setup information
Document:
- Windows version and shell (PowerShell in prior work);
- Python version (previously 3.10.11);
- virtual-environment creation/activation steps;
- dependency installation command (`requirements.txt`, `pyproject.toml`, lockfile, or actual project mechanism — inspect before deciding);
- PyTorch version and CUDA status (previously `2.13.0+cu130`, CUDA available, RTX 3050 Laptop GPU 6 GB);
- data prerequisites and expected paths;
- test and experiment commands.

Do not assume the CUDA wheel will install on every machine. Keep CPU fallback supported if the code is intended to run without an NVIDIA GPU.

---

## 11. Claude account and Claude Code handover steps

1. Sign in to the new Claude Pro account.
2. Install/update Claude Code on the development machine.
3. Authenticate Claude Code using that new account (use `/logout` and `/login` if the terminal is tied to the old account).
4. Confirm that the intended `ANTHROPIC_API_KEY` environment variable is not set if the goal is to use the included subscription allowance rather than API billing. Check carefully before deleting or changing any environment variable.
5. Open a terminal in the repository root and run `claude`.
6. Claude Code can inspect the local repository directly; the full source code need not be copied into a normal Claude chat attachment. The first-session prompt is in `CLAUDE_CODE_FIRST_PROMPT.md`.
7. Ask Claude to perform the read-only audit first. Only after receiving and reviewing its audit should it implement the next task.

Pro/Max plan usage for Claude chat and Claude Code is subject to the plan's shared usage limits; check the current official Claude Help Center for current allowance and authentication details.

Official references:
- Claude Code setup: https://docs.anthropic.com/en/docs/claude-code/getting-started
- Pro/Max and Claude Code subscription access: https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan
- Project context using `CLAUDE.md`: https://support.claude.com/en/articles/14553240-give-claude-context-claude-md-and-better-prompts

---

## 12. Questions Claude must answer after the initial audit

The first audit should provide evidence-backed answers to:

1. What is the current branch, HEAD commit, and working-tree status?
2. Are Stage 1A/1B/1C tags and commits still present? What commits introduced Stage 1D and entropy?
3. Does the current `ppo_train.py` use entropy in the actual loss? What is the module default coefficient?
4. Does `run_entropy_experiment.py` switch coefficients safely and restore the original value? Does it write distinct checkpoints/artifacts for each condition?
5. Were the exact seed-42 experiment artifacts generated from the current checked-out code? Can the commit hash be confirmed?
6. Do the current train/validation/test CSVs match the recorded row counts and regime counts?
7. Are all required raw/structured datasets and normalization artifacts present? Are paths portable on another machine?
8. Do the tests still pass? Are there any skipped tests, warnings, or data-dependent assumptions?
9. Does `evaluate.py` select the best validation checkpoint and evaluate the chosen checkpoint on test exactly once per condition?
10. Is there any data leakage or accidental tuning on the test split?
11. Which six `splitting_needed` transactions still fail under entropy=0.005, and what evidence explains each failure?
12. What is the minimum safe next task to run the paired multi-seed experiment without changing model semantics?

---

## 13. Guardrails for the next coding agent

- Do not assume “more bridges used” or “higher allocation entropy” automatically means better routing.
- Do not alter the waterfall baseline to make PPO appear better.
- Do not change reward weights, transaction labels, the $500K cap, capacity execution, dynamic data, normalization, or Stage 1A–1C code during an entropy-only experiment.
- Do not use the held-out test split for coefficient selection.
- Do not describe one random-seed improvement as statistically robust.
- Do not replace `tests/test_stage1d.py` with stale files from old ZIPs or reduce the 35-test Stage 1D coverage.
- Do not overwrite the seed-42 experiment artifacts.
- Always state whether results are from deterministic PPO evaluation or stochastic policy sampling.
- Separate measured metrics from speculation and clearly document any divergence from this handover.

---

## 14. Current status in one paragraph

**Current (1 November 2026):** Stage 1D is finalized.

- **Components:** dynamic bridge state, a masked Dirichlet PPO policy, two baselines, regime-based evaluation, and an inference-time capacity projection. The test suite passes 111 tests (17/26/13/35/20).
- **Entropy:** the paired multi-seed validation (seeds 42, 123 and 2026) found no consistent benefit from 0.005, so the default is `ENTROPY_COEF = 0.0`.
- **Failures:** every diagnosed PPO failure is a small over-allocation on one liquidity-limited bridge, with no redistribution, in GBR→PHL `splitting_needed` transactions.
- **Capacity projection:** inference-time projection brings PPO's completion up to the waterfall's on validation and on every holdout. PPO's reward advantage over the waterfall is **inconclusive**: it ranges from −0.0033 to +0.0051 depending on the holdout.
- **Holdout limitation:** no independent out-of-time holdout was possible, because the data ends at 2025-09-30 and the holdouts share the test period.
- **Next:** Stage 1F (comprehensive evaluation, including the items in section 9) and Stage 1E (Cognee). Neither has been started.

*Historical (31 October 2026):* Stage 1D had a previously passing 91-test repository suite (17/26/13/35 across Stages 1A–1D), dynamic bridge state and reward wiring, a masked Dirichlet PPO policy, two hand-crafted baselines, and regime-based evaluation. The first paired entropy experiment on seed 42 compared coefficients 0.0 and 0.005 on a 500/100/100 train/validation/test split. Entropy 0.005 raised test completion from 86% to 94%, lowered total unrouted value from about $451.7K to $92.6K, and raised `splitting_needed` completion from 70.83% to 87.5%. It still trailed the waterfall policy, had a slightly lower best validation reward, and was only one seed.
