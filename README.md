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
| 1E | Cognee / Semantic Memory | ⏳ Planned |
| 1F | Comprehensive Backtesting / Evaluation | ⏳ Planned |

**111/111 tests passing** across Stages 1A–1D and the capacity projection (see [Validation Status](#validation-status)).

## Architecture

The project is organized into three **Major Phases**, distinct from the internal **Stage 1A–1F** numbering below — these are two separate schemes and should not be conflated:

- **Major Phase 1 — Offline AI/RL Foundation**: Stages 1A–1F make up the offline AI/RL foundation. Stages 1A–1D are implemented and validated; Stages 1E–1F are planned.
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
├── analyze_training_boundaries.py, policy_gradient_capacity_diagnostic.py,
│   splitting_reward_analysis.py       # earlier Stage 1D analysis scripts
├── docs/                    # PROJECT_HANDOVER.md, FUTURE_PHASES_ROADMAP.md, STAGE1D_RESULTS.md,
│                            # FAILED_SPLITTING_INVESTIGATION_PLAN.md
├── data/
│   ├── structured/          # bridge_network.csv (9 venues), transaction_requests.csv, countries.csv
│   ├── raw/                 # WDI, CPI, RPW, FRED source files (see Dataset Requirements)
│   └── processed/           # Stage 1B outputs; Stage 1D transaction splits and holdouts
├── outputs/
│   ├── experiments/         # timestamped Stage 1D runs (checkpoints, metrics, provenance)
│   └── diagnostics/         # failure-diagnosis runs
├── src/
│   ├── backtest.py
│   ├── generate_mock_data.py
│   ├── envs/                # cbdc_env.py, bridge_network.py, reward.py, dynamic_bridge_state.py,
│   │                        # stage1c_obs_wrapper.py, stage1d_raw_obs_wrapper.py
│   ├── models/              # feature_extractor.py (1D CNN), stage1c_windowing.py,
│   │                        # ppo_actor_critic.py (Stage 1D PPO), rl_agent.py (legacy placeholder)
│   ├── training/            # Stage 1D: ppo_train.py, evaluate.py, baselines.py, metrics.py,
│   │                        # transaction_generator.py, cost_baseline.py, risk_proxy.py,
│   │                        # capacity_projection.py
│   ├── memory/              # cognee_layer.py (regulatory stub, not real Cognee)
│   └── preprocessing/       # Stage 1B: wdi.py, cpi.py, rpw.py, macro_risk.py, normalization.py,
│                            # synthetic_generator.py, synthetic_bridge_expansion.py,
│                            # are_mex_fallback.py, country_reference.py, fx_daily.py, split.py,
│                            # run_stage1b.py
└── tests/
    ├── test_stage1a.py
    ├── test_stage1b.py
    ├── test_stage1c.py
    ├── test_stage1d.py
    └── test_capacity_projection.py
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
| **Total** | **111/111 passed** |

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

## Future Roadmap

- **Stage 1E — Cognee / Semantic Memory**: integrate a real knowledge/memory layer (regulatory rules, corridor relationships, holidays, operational events) beyond the current hardcoded stub, and define exactly how verified knowledge may affect policy context, constraints or explanations.
- **Stage 1F — Comprehensive Backtesting / Evaluation**: robust, reproducible evaluation across seeds, regimes, corridors and simulation conditions. Open items carried over from Stage 1D:
  - a genuinely independent out-of-time holdout, which requires extending the data past 2025-09-30;
  - calibration of the reward weights, and sensitivity analysis;
  - confidence intervals for the PPO-vs-waterfall comparison;
  - better coverage of `exceeds_combined`;
  - deciding whether capacity awareness should be learned rather than projected.
- **Major Phase 2 — Full-Stack Web Orchestration**: FastAPI backend, React dashboard.
- **Major Phase 3 — Real-Time Streaming & Production**: live data feeds, production inference.

None of Stages 1E–1F or Major Phases 2–3 is implemented yet. See `docs/FUTURE_PHASES_ROADMAP.md`.

## Reproducibility

All stochastic components (the synthetic liquidity/congestion generator) use a fixed master seed (**`SEED = 42`**) with deterministic, hash-derived sub-seeds per bridge/date — verified to produce bit-identical outputs across independent runs. Normalization statistics are fit once on the training period and frozen; leakage tests confirm training-period outputs are unaffected by validation/test-period values.

Every Stage 1D run writes to a new timestamped folder with a `provenance.json` or `experiment_config.json`. These record the git HEAD and any uncommitted files, code hashes, checkpoint and data hashes, seeds and the device used. Checkpoint replays and evaluations reproduce exactly on the recorded hardware. **Re-training does not reproduce bit-for-bit:** a seed-42 retrain gave a best validation reward of 0.895447, against 0.896450 originally.

## Research Disclaimer

- Synthetic bridge liquidity/congestion observations are **not real measurements** of any CBDC system — none currently exists to measure.
- Any results produced by this project should be interpreted as **simulation-based findings under stated assumptions**, not as claims about real-world CBDC infrastructure.
- A planned sensitivity analysis across simulation parameters is a **robustness check**, not proof of real-world generalization — parameter ranges are themselves assumptions, not empirically derived bounds.