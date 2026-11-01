# CBDC Liquidity Router

A research prototype for an AI/RL-based routing system for cross-border CBDC-style transfers, built on a real-data-anchored simulation environment.

---

## Overview

Cross-border payment networks are fragmented: multiple bridges/liquidity venues can quote different exchange rates, fees, and available depth for the same transfer at the same moment. A naive router simply picks the cheapest quoted rate. This project explores something more deliberate: an agent that considers **transaction cost, latency/congestion, liquidity depth, and risk together**, and can **split a transaction across multiple bridges** when doing so produces a better overall outcome — rather than routing 100% of a transfer through a single venue and risking slippage or exhausting that venue's available liquidity.

The mechanism is a **Proximal Policy Optimization (PPO)** reinforcement-learning agent (implemented and evaluated in Stage 1D; see [Current Project Status](#current-project-status)). It operates over a simulated multi-bridge network and uses a **1D convolutional neural network** to extract temporal patterns from liquidity/congestion time series.

## Research Objective

The research objective is to determine whether an RL agent can learn **liquidity-aware, predictive, multi-bridge routing behavior** under simulated but real-data-anchored dynamic conditions — routing decisions that account for how liquidity and congestion evolve over time, not just their current snapshot.

**This system is a simulation environment, not a claim about real CBDC infrastructure.** No production CBDC bridge network of this kind currently exists, so no real bridge liquidity/congestion telemetry is available anywhere. The simulator is partially **anchored** to real historical financial data (see [Data Provenance](#data-provenance)), but the liquidity and congestion dynamics themselves are synthetic. Any future results should be read as *"the agent demonstrates a routing advantage across sensitivity-tested simulation conditions,"* not as evidence about real-world CBDC bridge behavior.

## Current Project Status

| Stage | Description | Status |
|---|---|---|
| 1A | Environment & Network Foundation | ✅ Complete |
| 1B | Data Preprocessing & Simulation | ✅ Complete |
| 1C | 1D CNN Feature Extraction | ✅ Complete |
| 1D | Dynamic State & PPO Policy Optimization | ✅ Implemented and experimentally evaluated (see [Stage 1D](#stage-1d--dynamic-state--ppo-policy-optimization)) |
| 1E | Cognee / Semantic Memory | ✅ Complete as an infrastructure milestone; real knowledge population deferred (see [Stage 1E](#stage-1e--cognee--semantic-memory)) |
| 1F | Comprehensive Backtesting / Evaluation | ✅ Complete (see [Stage 1F](#stage-1f--comprehensive-backtesting--evaluation)) |

**193/193 tests passing** across Stages 1A–1F and the capacity projection (see [Validation Status](#validation-status)).

## Architecture

The project is organized into three **Major Phases**, distinct from the internal **Stage 1A–1F** numbering below — these are two separate schemes and should not be conflated:

- **Major Phase 1 — Offline AI/RL Foundation**: Stages 1A–1F make up the offline AI/RL foundation. Stages 1A–1D and 1F are implemented and validated; Stage 1E is complete as an infrastructure milestone, with its knowledge population deferred.
- **Major Phase 2 — Full-Stack Web Orchestration**: a future FastAPI/React application layer. Not started.
- **Major Phase 3 — Real-Time Streaming & Production**: future live data feeds and production inference. Not started.

Internal stages of Major Phase 1:

```
Stage 1A → Stage 1B → Stage 1C → Stage 1D → Stage 1E → Stage 1F
 (env)     (data)    (CNN)      (PPO)     (Cognee)   (backtest)

```

## Current Implemented Architecture

The validated pipeline as of this checkpoint (Stages 1A–1D):

```
Raw data (WDI, CPI, RPW, FRED)
        │
        ▼
Preprocessing (Stage 1B)
        │
        ▼
Derived real-anchored signals (friction, cost baseline, macro-risk)
        │
        ▼
Synthetic daily liquidity/congestion state (real-conditioned simulation)
        │
        ▼
30-day temporal windows, train-only normalized
        │
        ▼
Strict 1D CNN (shared weights, per bridge)          31 raw features (amount + per-slot
        │                                           liquidity, fee, congestion, risk, mask)
        ▼                                                   │
64-dim embedding per populated bridge slot                  │
        └──────────────┬────────────────────────────────────┘
                       ▼
        415-dim combined observation (Stage 1C/1D)
                       │
                       ▼
PPO actor-critic (Stage 1D): masked Dirichlet allocation over feasible slots + value head
                       │
                       ▼
Optional inference-time capped-simplex projection (Stage 1D evaluation only)
                       │
                       ▼
CBDCLiquidityEnv.step(): executed_i = min(requested_i, liquidity_i), no redistribution;
reward = cost − λL·latency − λR·risk − λU·unrouted (λ placeholders = 1.0)
```

## Stage 1A — Environment & Network Foundation

A [Gymnasium](https://gymnasium.farama.org/) environment (`CBDCLiquidityEnv`) implementing the routing problem's mechanics:

- **`BridgeNetwork`**: loads bridge topology (capacity, fee) from structured data; supports multiple bridges per corridor.
- **Feasibility masking**: a bridge slot is only usable if it exists for the transaction's corridor *and* the transaction passes a regulatory hard-filter check (max transfer amount, restricted corridors).
- **Requested allocation**: the action is a fractional allocation vector (`requested_i = alloc_i × amount`) — not a single choose-one decision.
- **Capacity clipping**: `executed_i = min(requested_i, liquidity_i)`. Overflow is **never redistributed** to other bridges.
- **Unrouted amount**: `unrouted = requested_total - executed_total`, tracked explicitly and factored into the reward.
- **Reward skeleton**: a cost/latency/risk/unrouted-penalty formula. The relative term weights are currently placeholder values, not calibrated.
- **`MAX_BRIDGES = 6`**: an architectural simulation *capacity*, not a claim about real bridge count.

The Stage 1A checkpoint had **three populated bridge entities**, one per corridor (USA→IND, GBR→PHL, ARE→MEX). **Stage 1D expanded this to three venues per corridor (nine in total).** The six added venues are tagged `synthetic_bridge_expansion` in `data/structured/bridge_network.csv`; the original three keep the `real_static_bridge` tag. Each corridor therefore has three populated slots and three padding slots.

## Stage 1B — Data Preprocessing & Simulation

Real datasets used:

| Source | What it provides | Role |
|---|---|---|
| **WDI** (World Bank) | Annual official exchange rate | Macro-risk conditioning input |
| **CPI** (not-seasonally-adjusted, self-computed matched-month YoY) | Monthly inflation signal | Macro-risk conditioning input |
| **RPW** (World Bank Remittance Prices Worldwide) | Quarterly corridor-level fee %, FX margin, transfer speed | Conditions the synthetic bridge simulation's baseline liquidity and congestion |
| **FRED** | Daily FX rates | Real daily FX volatility component of macro-risk, where available |

Key pipeline properties:

- **Real vs. derived vs. synthetic** are tracked explicitly throughout (see [Data Provenance](#data-provenance)).
- **Train-only normalization**: all z-score statistics used to condition the synthetic generator are fit exclusively on the training period and frozen before being applied to validation/test.
- **Leakage protection**: raw macro-risk components are built with no cross-period normalization before any train-only fitting occurs; a 30-day gap buffer separates every split boundary; real-data conditioning always uses the *previous* period's value, never the current or future one.
- **Synthetic liquidity/congestion generation**: an Ornstein-Uhlenbeck + jump-diffusion process, conditioned by real RPW/WDI/CPI/FRED-derived signals where a defensible link exists, fully synthetic (unconditioned) elsewhere.
- **Train/validation/test split**: 2011–2021 / 2022–2023 / 2024–2025-09-30, with a 30-day gap buffer at each boundary.
- **ARE→MEX fallback**: RPW has zero real observations for this corridor. USA→MEX (the only real corridor sharing MEX as an exact destination) is used as a substitute, explicitly tagged `synthetic_no_real_anchor` and never written into the real RPW output as if it were ARE→MEX data.

**Validated output counts** (local run):

| Output | Rows |
|---|---:|
| WDI FX features | 9,838 |
| CPI features | 44,673 |
| RPW corridor-quarterly | 17,202 |
| Macro-risk proxy | 1,062 |
| Synthetic daily bridge state | 16,161 |

Date range: **2011-01-01 → 2025-09-30**.

## FRED Data

| Currency | Series | Status |
|---|---|---|
| INR | `DEXINUS` | Real, supplied |
| GBP | `DEXUSUK` | Real, supplied |
| MXN | `DEXMXUS` | Real, supplied |

These are real daily FX datasets obtained from FRED. **Their locally supplied coverage begins around 2021-08, not at the start of the 2011–2025 simulation range.** For dates before that, the macro-risk signal for these currencies falls back to the WDI/CPI-derived component, or to an explicit `unconditioned_default` flag where no real signal exists at all. PHP and AED have no FRED series (no verified daily official source for PHP; AED has been pegged to USD since 1997, so a real series would carry no volatility signal regardless).

## Stage 1C — 1D CNN Feature Extraction

- **Input**: 30-day trailing window, 2 channels — `liquidity_level`, `congestion_level`.
- **Normalization**: train-only statistics, applied identically across train/validation/test.
- **Architecture**: a single, **strictly 1D CNN** (`FeatureExtractor1DCNN`), shared weights, applied independently once per populated bridge slot. No attention, Transformer, or BiLSTM components — this is a fixed project constraint.
- **Output**: 64-dimensional embedding per populated bridge; padded slots receive an exact all-zero 64-dim vector and are never passed through the CNN.
- **Combined observation size**: **415** — `1` (amount) + `30` (raw per-slot Stage 1A features, 6 slots × 5) + `384` (CNN block, 6 slots × 64).
- **`simulation_date`**: each transaction is anchored to an explicit synthetic simulation date used to select the correct trailing window from the daily data. These are simulation anchors for building/testing the pipeline, not real historical transaction timestamps.

The Stage 1C wrapper is a **validated feature/observation construction path**. It has been tested for windowing correctness, normalization leakage, padding behavior, and observation dimensionality. In Stage 1C itself the CNN is untrained. Stage 1D trains the same CNN end to end inside the PPO policy, with gradients flowing through it.

## Stage 1D — Dynamic State & PPO Policy Optimization

**Components:**
- dynamic per-date bridge liquidity/congestion state, wired into both the observation and execution (`src/envs/dynamic_bridge_state.py`);
- a lagged-quarter real RPW cost baseline (`src/training/cost_baseline.py`);
- a corridor risk proxy;
- a regime-stratified transaction generator with ground-truth regime labels (`src/training/transaction_generator.py`);
- a PPO actor-critic with a masked Dirichlet allocation head (`src/models/ppo_actor_critic.py`, `src/training/ppo_train.py`);
- cheapest-feasible and liquidity-aware waterfall baselines;
- evaluation of all policies through the same `env.step()` path, with regime-level metrics;
- an inference-time capped-simplex capacity projection (`src/training/capacity_projection.py`).

**Latest results** (full details, folders and caveats: [`docs/STAGE1D_RESULTS.md`](docs/STAGE1D_RESULTS.md)):

- **Entropy regularisation:** `ENTROPY_COEF = 0.005` showed no consistent benefit across seeds 42, 123 and 2026 on validation. The mean reward difference was −0.0007 ± 0.0014. The default is **0.0**.
- **Failure diagnosis:** every PPO failure examined was a `splitting_needed` transaction in GBR→PHL. In each one, a single bridge was over-allocated beyond its liquidity and the excess was clipped, not redistributed. The median clipped share was 5.13% of the amount.
- **Capacity projection:** projecting PPO's action onto per-bridge liquidity at inference time raised PPO completion to the waterfall's level. That held on every checkpoint, on validation and on all holdouts. On the five holdout views, completion rose by 3.6–6.8 points, with no retraining.
- **PPO vs waterfall on reward is inconclusive.** Across five holdout views, projected PPO minus the waterfall ranged from −0.0033 to +0.0051. Projected PPO beat the waterfall on between 2 and 6 of the 6 checkpoints, depending on which holdout was drawn.
- **No independent out-of-time holdout was possible.** All data ends at 2025-09-30, the same date as the end of the test window. The holdouts share that period, and most rows' 30-day history windows overlap the history of already-examined dates.

## Stage 1E — Cognee / Semantic Memory

Status: **complete as an infrastructure milestone.** Populating the knowledge base with real regulatory knowledge is **deferred**. Full details are in [`docs/STAGE1E_MEMORY.md`](docs/STAGE1E_MEMORY.md).

- **Deterministic knowledge base** (`data/knowledge/regulatory_facts.json`): versioned facts, each with provenance, a `verified` flag and a source; the file's SHA-256 is recorded. It is read by `StaticMemoryProvider`, the **only authority for feasibility**. The environment's memory wrapper behaves exactly as the pre-1E stub did, which is verified on more than 2,000 dataset rows.
- **Cognee adapter (optional; explanations only):** lazily imported and never used by the environment, training, evaluation or the model. It ingests facts, retrieves them as chunks, and grounds every result to a known fact ID. Cognee output can't change a decision.
- **Read-only audit** (`run_stage1e_explanation_audit.py`): template-based explanations of Stage 1D results, with fact provenance and knowledge hashes. The audit verifies its input files are unchanged.
- **Verified live** with local Ollama (`llama3.1:8b`, `nomic-embed-text`): the smoke test passed 7 of 7 checks. The audit covered 1,522 transactions: 3 of 3 corridors grounded, and 1,500 of 1,500 decisions consistent with the recorded Stage 1D outcomes.
- **Current content:** the knowledge base contains only the assumed $500K cap, so the live results validate the workflow, not retrieval quality.

## Stage 1F — Comprehensive Backtesting & Evaluation

Evaluation only: no training or tuning, and PPO, the CNN, the environment and the reward are unchanged. The run is in `outputs/backtests/stage1f_backtest_20261102_023545/`; full results are in [`docs/STAGE1F_RESULTS.md`](docs/STAGE1F_RESULTS.md).

- **What was evaluated:** 1,460 holdout transactions × 6 multi-seed checkpoints × 4 policies (original PPO, projected PPO, liquidity waterfall, cheapest-feasible) × 6 stress scenarios (baseline, −30% and −50% liquidity, cheapest-venue outage, congestion ×2, combined).
- **How:** paired statistics with a two-level cluster bootstrap (checkpoints × dates) and Holm correction; a pre-registered analysis plan; four data-leakage guards (all passed); and evaluation-time reward-weight sensitivity.

**Findings**
- **The projection is what makes PPO capacity-aware.** It raises PPO's completion to the waterfall's level in every scenario: +4.6 points at baseline [+2.5, +6.9], and up to +81 points under a cheapest-venue outage. All gains are significant (Holm p < 0.001, 6 of 6 checkpoints).
- **The trained PPO policy barely responds to liquidity.** In a diagnostic on one checkpoint and 100 transactions, its share to the fee-cheapest venue stayed at 0.32–0.35 while that venue's liquidity fell tenfold (mean change 0.006). The share exceeded the venue's capacity in 94% of outage transactions, against 13% at baseline. Without the projection, PPO completes on average only **15.6%** of transactions in the outage (range 6.1–41.2% across the 6 checkpoints), against 96.5% with it.
- **PPO is not shown to be better than the waterfall on reward.** Projected PPO minus the waterfall is +0.0017 [−0.013, +0.016] at baseline, inconclusive, and inconclusive in five of six scenarios. The one significant gain, under the outage, is +0.0046 [+0.0005, +0.0092] (Holm p 0.042). It's small and disappears when latency is weighted at 0.5. Original PPO is significantly *worse* than the waterfall at −50% liquidity (−0.024) and under the outage (−0.236).
- **The environment's reward accounting is flawed under liquidity shortage.** It doesn't count never-requested amounts as unrouted, which inflates the waterfall's and projected PPO's reward by up to 0.036 at −50% liquidity. That's larger than most of the policy differences. Stage 1F uses amount-based reward for stress comparisons.
- **Rankings depend on the placeholder reward weights.** At λ_latency = 2, even cheapest-feasible scores highest under congestion stress.

**Limitations:** No genuinely independent out-of-time data exists: all data ends 2025-09-30. The holdouts share the test period, with overlapping 30-day history windows. Data, liquidity and congestion are synthetic. Stress scenarios are uniform multipliers, not calibrated shocks. Reward weights are placeholders. The equivalence margins were chosen after Stage 1D results were seen (disclosed). The insensitivity diagnostic covers one checkpoint.

## Data Provenance

| Category | Examples |
|---|---|
| **REAL** | WDI exchange rate, CPI index levels, RPW fee/margin/speed observations, FRED daily FX rates |
| **DERIVED** | Macro-risk proxy, corridor friction, real cost baseline, YoY/volatility calculations |
| **SYNTHETIC** | Daily liquidity/congestion simulation output, ARE→MEX fallback values, `simulation_date` anchors, the six `synthetic_bridge_expansion` venues, and all Stage 1D transactions (train/validation/test splits and holdouts) |
| **ASSUMPTIONS** | Synthetic generator parameters (jump rates, baseline volatility, conditioning coefficients) — explicitly configurable, not empirically calibrated |

## Repository Structure

```
cbdc-liquidity-router/
├── requirements.txt
├── test_run.py
├── run_entropy_experiment.py          # Stage 1D: seed-42 paired entropy experiment
├── run_entropy_multiseed.py           # Stage 1D: paired entropy, seeds 42/123/2026 (validation)
├── diagnose_failed_splitting.py       # Stage 1D: read-only failure diagnosis
├── run_capacity_projection_experiment.py  # Stage 1D: projection vs PPO vs waterfall (validation)
├── run_holdout_evaluation.py          # Stage 1D: fresh synthetic holdout evaluation
├── run_holdout_overlap_analysis.py    # Stage 1D: overlap sensitivity + date-disjoint holdout
├── run_holdout_disjoint_v2.py         # Stage 1D: holdout excluding test + earlier holdout dates
├── run_cognee_smoke_test.py          # Stage 1E: manual live Cognee smoke test (--yes)
├── run_stage1e_explanation_audit.py  # Stage 1E: read-only explanation & audit of Stage 1D results
├── run_stage1f_backtest.py           # Stage 1F: multi-seed, multi-scenario backtest (evaluation only)
├── analyze_training_boundaries.py, policy_gradient_capacity_diagnostic.py,
│   splitting_reward_analysis.py       # earlier Stage 1D analysis scripts
├── docs/                    # PROJECT_HANDOVER.md, FUTURE_PHASES_ROADMAP.md, STAGE1D_RESULTS.md,
│                            # FAILED_SPLITTING_INVESTIGATION_PLAN.md, STAGE1E_MEMORY.md,
│                            # STAGE1F_RESULTS.md
├── data/
│   ├── structured/          # bridge_network.csv (9 venues), transaction_requests.csv, countries.csv
│   ├── raw/                 # WDI, CPI, RPW, FRED source files (see Dataset Requirements)
│   └── processed/           # Stage 1B outputs; Stage 1D transaction splits and holdouts
├── outputs/
│   ├── experiments/         # timestamped Stage 1D runs (checkpoints, metrics, provenance)
│   └── diagnostics/         # failure-diagnosis runs
├── src/
│   ├── backtest.py
│   ├── backtesting/         # Stage 1F: scenarios.py, evaluation.py, statistics.py, analysis.py,
│   │                        # leakage.py
│   ├── generate_mock_data.py
│   ├── envs/                # cbdc_env.py, bridge_network.py, reward.py, dynamic_bridge_state.py,
│   │                        # stage1c_obs_wrapper.py, stage1d_raw_obs_wrapper.py
│   ├── models/              # feature_extractor.py (1D CNN), stage1c_windowing.py,
│   │                        # ppo_actor_critic.py (Stage 1D PPO), rl_agent.py (legacy placeholder)
│   ├── training/            # Stage 1D: ppo_train.py, evaluate.py, baselines.py, metrics.py,
│   │                        # transaction_generator.py, cost_baseline.py, risk_proxy.py,
│   │                        # capacity_projection.py
│   ├── memory/              # Stage 1E: knowledge.py, provider.py (StaticMemoryProvider),
│   │                        # cognee_layer.py (environment wrapper), cognee_adapter.py,
│   │                        # explanation_audit.py
│   └── preprocessing/       # Stage 1B: wdi.py, cpi.py, rpw.py, macro_risk.py, normalization.py,
│                            # synthetic_generator.py, synthetic_bridge_expansion.py,
│                            # are_mex_fallback.py, country_reference.py, fx_daily.py, split.py,
│                            # run_stage1b.py
└── tests/
    ├── test_stage1a.py
    ├── test_stage1b.py
    ├── test_stage1c.py
    ├── test_stage1d.py
    ├── test_capacity_projection.py
    ├── test_stage1e.py
    ├── test_stage1e_cognee.py
    ├── test_stage1e_audit.py
    └── test_stage1f.py
```

## Dataset Requirements

Two raw datasets are large enough that they are **not committed to standard Git storage** and must be supplied locally:

- `WDIData.csv` → place in `data/raw/`
- `rpw_dataset_2011_2025_q3.xlsx` → place in `data/raw/`

The CPI Excel files and the FRED CSVs (`DEXINUS.csv`, `DEXUSUK.csv`, `DEXMXUS.csv`) are expected under `data/raw/` and `data/raw/fred/` respectively — see the [FRED Data](#fred-data) section for coverage caveats.

## Installation

```bash
python3 -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt

```

## Running the Current Pipeline

```bash
# Generate Stage 1B processed outputs
python -m src.preprocessing.run_stage1b

# Run the full test suite
python -m pytest tests/

# Stage 1D experiments (each writes a new timestamped folder under outputs/)
python run_entropy_multiseed.py                # trains 6 PPO runs; compares on validation
python run_capacity_projection_experiment.py   # evaluation only, validation split
python run_holdout_evaluation.py               # evaluation only, synthetic holdout

# Stage 1E memory (provider settings: docs/STAGE1E_MEMORY.md)
python run_stage1e_explanation_audit.py --static-only   # no LLM/provider needed
python run_stage1e_explanation_audit.py --yes           # with Cognee retrieval
python run_cognee_smoke_test.py --yes                   # live Cognee smoke test

# Stage 1F backtest (evaluation only; about 1 hour on an RTX 3050)
python run_stage1f_backtest.py
```

The holdout and projection scripts load existing checkpoints and do not train.

## Validation Status

| Suite | Result |
|---|---:|
| Stage 1A | 17/17 passed |
| Stage 1B | 26/26 passed |
| Stage 1C | 13/13 passed |
| Stage 1D | 35/35 passed |
| Capacity projection | 20/20 passed |
| Stage 1E memory | 18/18 passed |
| Stage 1E Cognee adapter (mocked) | 33/33 passed |
| Stage 1E audit (mocked) | 15/15 passed |
| Stage 1F backtesting | 16/16 passed |
| **Total** | **193/193 passed** |

The command is `python -m pytest tests/`. The 9 known warnings are pandas `pct_change` FutureWarnings from `macro_risk.py`.

These tests validate **implementation mechanics and regression safety** — correct data loading, no temporal leakage, correct tensor shapes, reproducibility under a fixed seed. They are **not** evidence of real-world CBDC routing behavior, since no such system exists to validate against.

## Current Limitations

- No real CBDC bridge telemetry exists anywhere; all liquidity/congestion dynamics are synthetic, and six of the nine venues are synthetic expansions.
- **Reward weights are uncalibrated placeholders** (λ = 1.0 for every term). All reward comparisons depend on them.
- **PPO's reward advantage over the liquidity waterfall is inconclusive.** It changes sign depending on which holdout is drawn (see `docs/STAGE1D_RESULTS.md`).
- **No genuinely independent out-of-time holdout exists.** All data ends at 2025-09-30, which is also the end of the test window. Holdouts share the test period, and most of their 30-day history windows overlap already-examined dates.
- **Capacity-aware completion depends on a projection:** PPO reaches full completion only with the inference-time capacity projection. That projection is a correction applied after the policy, not learned behaviour.
- **Unrouted-amount accounting:** the environment counts unrouted as requested − executed, so an action that requests less than the full amount is not penalised for the part it never requested. Evaluation scripts report amount-based unrouted alongside it.
- **Too few `exceeds_combined` examples:** they are rare (0–3 per 500-row holdout) because of the $500K regulatory cap.
- The macro-risk proxy is a coarse, assumption-laden signal, not a validated volatility forecast.
- **Small scale:** 3 corridors and 6 checkpoints from 3 seeds; observed PPO failures concentrate in one corridor (GBR→PHL).
- **Stage 1F:** the trained PPO policy barely responds to liquidity, and its capacity awareness comes from the inference-time projection. PPO's reward advantage over the waterfall is inconclusive. The environment's unrouted accounting inflates the reward of policies that request less than the full amount when liquidity is short. See `docs/STAGE1F_RESULTS.md`.
- **The Stage 1E knowledge base has no real content yet.** It holds only the assumed $500K cap (`project_assumption`, unverified), so Cognee retrieval quality is unmeasured. Populating it with real, cited regulatory knowledge is deferred (see `docs/STAGE1E_MEMORY.md`).

## Future Roadmap

- **Stage 1E — deferred knowledge work**: populate the knowledge base with real, cited regulatory and operational facts (transfer caps, restricted corridors, payment-system holidays, operational events), measure retrieval quality, and decide through an approved environment change whether dated or corridor-scoped facts may affect feasibility.
- **Open research items after Stage 1F** (none started; several need approval):
  - **independent out-of-time data:** extend the data past 2025-09-30 (needs new or regenerated data and approval);
  - **reward accounting:** the environment counts unrouted as requested − executed, which hides never-requested amounts. Fixing this changes the reward and needs an approved change;
  - **reward weights:** calibrate them (all λ are still 1.0 placeholders);
  - **learned capacity awareness:** make PPO itself respond to liquidity, through training changes (needs approval), or formally adopt the projection as part of the policy;
  - **realistic stress:** calibrated, historically grounded stress scenarios;
  - **Stage 1E knowledge content:** populate it with real, cited facts.
- **Major Phase 2 — Full-Stack Web Orchestration**: FastAPI backend, React dashboard.
- **Major Phase 3 — Real-Time Streaming & Production**: live data feeds, production inference.

Major Phases 2–3 are not implemented yet, and Stage 1E's knowledge population is deferred. See `docs/FUTURE_PHASES_ROADMAP.md`.

## Reproducibility

All stochastic components (the synthetic liquidity/congestion generator) use a fixed master seed (**`SEED = 42`**) with deterministic, hash-derived sub-seeds per bridge/date — verified to produce bit-identical outputs across independent runs. Normalization statistics are fit once on the training period and frozen; leakage tests confirm training-period outputs are unaffected by validation/test-period values.

Every Stage 1D run writes to a new timestamped folder with a `provenance.json` or `experiment_config.json`. These record the git HEAD and any uncommitted files, code hashes, checkpoint and data hashes, seeds and the device used. Checkpoint replays and evaluations reproduce exactly on the recorded hardware. **Re-training does not reproduce bit-for-bit:** a seed-42 retrain gave a best validation reward of 0.895447, against 0.896450 originally.

## Research Disclaimer

- Synthetic bridge liquidity/congestion observations are **not real measurements** of any CBDC system — none currently exists to measure.
- Any results produced by this project should be interpreted as **simulation-based findings under stated assumptions**, not as claims about real-world CBDC infrastructure.
- A planned sensitivity analysis across simulation parameters is a **robustness check**, not proof of real-world generalization — parameter ranges are themselves assumptions, not empirically derived bounds.