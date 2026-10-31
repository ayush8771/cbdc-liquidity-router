# CBDC Liquidity Router — Claude Code Project Instructions

## Project objective
Build and evaluate a reinforcement-learning-based liquidity routing prototype for cross-border CBDC transactions. The routing policy allocates each transaction across feasible bridge venues while accounting for available liquidity, congestion, cost, and risk. The current development milestone is Stage 1D.

## Mandatory working rules
- Treat the live repository as the source of truth. This file and `docs/PROJECT_HANDOVER.md` are handover context, not proof that every described file or setting is still present. Inspect the current implementation before changing it.
- Preserve Stage 1A, 1B, and 1C behaviour and regression tests. Do not refactor or alter their semantics as part of Stage 1D work unless explicitly requested and justified.
- Make the smallest change that addresses the task. No unsolicited scope expansion, architecture rewrites, data regeneration, reward redesign, or hyperparameter changes.
- Before edits: inspect `git status`, current branch, recent commits/tags, and the relevant files. Never overwrite uncommitted user work.
- Do not commit, push, reset, rebase, delete, or rewrite history without explicit approval.
- Do not overwrite prior experiment outputs or checkpoints. Use a new timestamped experiment directory for every run.
- Do not tune against the held-out test split. The current 100-row Stage 1D test set has already been examined in the entropy experiment; treat it as an experimental evaluation set, not a pristine final holdout. Prefer a newly generated or otherwise untouched final holdout for final claims.
- Keep data provenance explicit. Do not silently change real/synthetic data flags, labels, transaction regimes, regulatory caps, liquidity semantics, or baseline definitions.
- Never invent results. Report exact commands, test counts, metrics, seeds, and output paths. Distinguish measured outcomes from hypotheses.
- Do not put secrets, credentials, private keys, service-account JSON, `.env` files, or access tokens in source control or handover documents.

## Known environment and core commands
The developer previously used Windows PowerShell, Python 3.10.11, a project `venv`, and an NVIDIA GeForce RTX 3050 Laptop GPU with 6 GB VRAM. A CUDA-enabled PyTorch build was verified (`torch 2.13.0+cu130`, `torch.cuda.is_available() == True`). Re-check on the active machine before relying on this.

Activate the environment (if present):
```powershell
.\venv\Scripts\Activate.ps1
```

Run the Stage 1D tests:
```powershell
python tests/test_stage1d.py
```

Run the complete test suite:
```powershell
python -m pytest tests/
```

Previously recorded passing result: 91 tests passed (17 Stage 1A + 26 Stage 1B + 13 Stage 1C + 35 Stage 1D). Re-run to establish current status; do not assume this remains true after changes.

## Main Stage 1D data splits (verify files exist)
- `data/processed/stage1d_transactions_train.csv` — 500 rows
- `data/processed/stage1d_transactions_validation.csv` — 100 rows
- `data/processed/stage1d_transactions_test.csv` — 100 rows

Known Stage 1D test-regime counts in the recorded entropy experiment: 48 `splitting_needed`, 33 `near_boundary`, 19 `below_cheapest`; `exceeds_combined` was absent from this particular test split.

## Architecture landmarks (verify paths and APIs)
- `src/envs/cbdc_env.py` — core environment and execution/reward interaction.
- `src/envs/dynamic_bridge_state.py` — dynamic bridge liquidity/congestion state lookup.
- `src/envs/stage1d_raw_obs_wrapper.py` — Stage 1D raw-observation path.
- `src/models/ppo_actor_critic.py` — PPO actor-critic and masked Dirichlet allocation policy.
- `src/training/ppo_train.py` — PPO training and update loop; verify the entropy coefficient and loss wiring in the live file.
- `src/training/evaluate.py` — evaluation against baselines on the shared environment execution path.
- `src/training/baselines.py` — cheapest-feasible and liquidity-aware waterfall policies.
- `src/training/metrics.py` — completion, bridge-use, allocation and regime metrics.
- `src/training/risk_proxy.py` — risk proxy.
- `src/training/cost_baseline.py` — lagged real RPW cost baseline lookup, with a documented synthetic fallback for ARE→MEX.
- `src/training/transaction_generator.py` — regime-stratified transactions and ground-truth regime assignment.
- `src/preprocessing/synthetic_bridge_expansion.py` — synthetic venue expansion, if present.

## Required workflow for every coding task
1. Inspect the relevant code, tests, data schemas, and git state.
2. Explain the proposed change and its scope before editing when the task is non-trivial.
3. Make only the requested change.
4. Add/update targeted tests without removing existing tests.
5. Run targeted tests, then `python -m pytest tests/` when feasible.
6. Report files changed, exact commands and outcomes, warnings, limitations, and any unrun tests.
7. Save experiment artefacts in a new directory and preserve previous runs.

## Current research status
The first paired entropy experiment (seed 42; entropy coefficient 0.0 versus 0.005) showed promising improvements on the existing 100-row test split, especially `splitting_needed`, but it is a single-seed result. Do not promote 0.005 to the permanent default or claim robust superiority until paired multi-seed validation is complete. See `docs/PROJECT_HANDOVER.md` for the recorded measurements and next-step protocol.
