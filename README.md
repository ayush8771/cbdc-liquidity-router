# CBDC Liquidity Router

A research prototype for an AI/RL-based routing system for cross-border CBDC-style transfers, built on a real-data-anchored simulation environment.

---

## Overview

Cross-border payment networks are fragmented: multiple bridges/liquidity venues can quote different exchange rates, fees, and available depth for the same transfer at the same moment. A naive router simply picks the cheapest quoted rate. This project explores something more deliberate: an agent that considers **transaction cost, latency/congestion, liquidity depth, and risk together**, and can **split a transaction across multiple bridges** when doing so produces a better overall outcome — rather than routing 100% of a transfer through a single venue and risking slippage or exhausting that venue's available liquidity.

The intended mechanism is a **Proximal Policy Optimization (PPO)** reinforcement-learning agent (not yet implemented — see [Current Project Status](#current-project-status)) operating over a simulated multi-bridge network, using a **1D convolutional neural network** to extract temporal patterns from liquidity/congestion time series.

## Research Objective

The research objective is to determine whether an RL agent can learn **liquidity-aware, predictive, multi-bridge routing behavior** under simulated but real-data-anchored dynamic conditions — routing decisions that account for how liquidity and congestion evolve over time, not just their current snapshot.

**This system is a simulation environment, not a claim about real CBDC infrastructure.** No production CBDC bridge network of this kind currently exists, so no real bridge liquidity/congestion telemetry is available anywhere. The simulator is partially **anchored** to real historical financial data (see [Data Provenance](#data-provenance)), but the liquidity and congestion dynamics themselves are synthetic. Any future results should be read as *"the agent demonstrates a routing advantage across sensitivity-tested simulation conditions,"* not as evidence about real-world CBDC bridge behavior.

## Current Project Status

| Stage Description Status  |                                  |                                                   |
| ------------------------- | -------------------------------- | ------------------------------------------------- |
| 1A                        | Environment & Network Foundation | ✅ Complete                                        |
| 1B                        | Data Preprocessing & Simulation  | ✅ Complete                                        |
| 1C                        | 1D CNN Feature Extraction        | ✅ Complete                                        |
| 1D                        | PPO Training                     | 🚧 In progress (separate track, not yet complete) |
| 1E                        | Cognee / Semantic Memory         | ⏳ Planned                                         |
| 1F                        | Backtesting / Evaluation         | ⏳ Planned                                         |

**56/56 tests passing** across Stages 1A–1C (see [Validation Status](https://claude.ai/chat/af1cc04d-b69f-458c-9d0a-ca998a787ca7#validation-status)).

## Architecture

The project is organized into three **Major Phases**, distinct from the internal **Stage 1A–1F** numbering below — these are two separate schemes and should not be conflated:

- **Major Phase 1 — Offline AI/RL Foundation**: Stages 1A–1F comprise the planned offline AI/RL foundation; Stages 1A–1C are currently implemented and validated.
- **Major Phase 2 — Full-Stack Web Orchestration**: a future FastAPI/React application layer. Not started.
- **Major Phase 3 — Real-Time Streaming & Production**: future live data feeds and production inference. Not started.

Internal stages of Major Phase 1:

```
Stage 1A → Stage 1B → Stage 1C → Stage 1D → Stage 1E → Stage 1F
 (env)     (data)    (CNN)      (PPO)     (Cognee)   (backtest)

```

## Current Implemented Architecture

The validated pipeline as of this checkpoint (Stages 1A–1C):

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
Strict 1D CNN (shared weights, per bridge)
        │
        ▼
64-dim embedding per populated bridge slot
        │
        ▼
Stage 1C combined observation (415-dim)

```

PPO training on top of this observation is **Stage 1D and is not part of this checkpoint.**

## Stage 1A — Environment & Network Foundation

A [Gymnasium](https://gymnasium.farama.org/) environment (`CBDCLiquidityEnv`) implementing the routing problem's mechanics:

- **`BridgeNetwork`**: loads bridge topology (capacity, fee) from structured data; supports multiple bridges per corridor.
- **Feasibility masking**: a bridge slot is only usable if it exists for the transaction's corridor *and* the transaction passes a regulatory hard-filter check (max transfer amount, restricted corridors).
- **Requested allocation**: the action is a fractional allocation vector (`requested_i = alloc_i × amount`) — not a single choose-one decision.
- **Capacity clipping**: `executed_i = min(requested_i, liquidity_i)`. Overflow is **never redistributed** to other bridges.
- **Unrouted amount**: `unrouted = requested_total - executed_total`, tracked explicitly and factored into the reward.
- **Reward skeleton**: a cost/latency/risk/unrouted-penalty formula. The relative term weights are currently placeholder values, not calibrated.
- **`MAX_BRIDGES = 6`**: an architectural simulation *capacity*, not a claim about real bridge count.

**In this validated checkpoint**, the network has **three populated bridge entities** (one bridge per corridor: USA→IND, GBR→PHL, ARE→MEX) and **three padding slots**. A larger synthetic multi-bridge network is a possible future direction under discussion for Stage 1D, but is **not** part of this checkpoint.

## Stage 1B — Data Preprocessing & Simulation

Real datasets used:

| Source What it provides Role                                       |                                                           |                                                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **WDI** (World Bank)                                               | Annual official exchange rate                             | Macro-risk conditioning input                                                  |
| **CPI** (not-seasonally-adjusted, self-computed matched-month YoY) | Monthly inflation signal                                  | Macro-risk conditioning input                                                  |
| **RPW** (World Bank Remittance Prices Worldwide)                   | Quarterly corridor-level fee %, FX margin, transfer speed | Conditions the synthetic bridge simulation's baseline liquidity and congestion |
| **FRED**                                                           | Daily FX rates                                            | Real daily FX volatility component of macro-risk, where available              |

Key pipeline properties:

- **Real vs. derived vs. synthetic** are tracked explicitly throughout (see [Data Provenance](#data-provenance)).
- **Train-only normalization**: all z-score statistics used to condition the synthetic generator are fit exclusively on the training period and frozen before being applied to validation/test.
- **Leakage protection**: raw macro-risk components are built with no cross-period normalization before any train-only fitting occurs; a 30-day gap buffer separates every split boundary; real-data conditioning always uses the *previous* period's value, never the current or future one.
- **Synthetic liquidity/congestion generation**: an Ornstein-Uhlenbeck + jump-diffusion process, conditioned by real RPW/WDI/CPI/FRED-derived signals where a defensible link exists, fully synthetic (unconditioned) elsewhere.
- **Train/validation/test split**: 2011–2021 / 2022–2023 / 2024–2025-09-30, with a 30-day gap buffer at each boundary.
- **ARE→MEX fallback**: RPW has zero real observations for this corridor. USA→MEX (the only real corridor sharing MEX as an exact destination) is used as a substitute, explicitly tagged `synthetic_no_real_anchor` and never written into the real RPW output as if it were ARE→MEX data.

**Validated output counts** (local run):

| Output Rows                  |        |
| ---------------------------- | ------ |
| WDI FX features              | 9,838  |
| CPI features                 | 44,673 |
| RPW corridor-quarterly       | 17,202 |
| Macro-risk proxy             | 1,062  |
| Synthetic daily bridge state | 16,161 |

Date range: **2011-01-01 → 2025-09-30**.

## FRED Data

| Currency Series Status  |           |                |
| ----------------------- | --------- | -------------- |
| INR                     | `DEXINUS` | Real, supplied |
| GBP                     | `DEXUSUK` | Real, supplied |
| MXN                     | `DEXMXUS` | Real, supplied |

These are real daily FX datasets obtained from FRED. **Their locally supplied coverage begins around 2021-08, not at the start of the 2011–2025 simulation range.** For dates before that, the macro-risk signal for these currencies falls back to the WDI/CPI-derived component, or to an explicit `unconditioned_default` flag where no real signal exists at all. PHP and AED have no FRED series (no verified daily official source for PHP; AED has been pegged to USD since 1997, so a real series would carry no volatility signal regardless).

## Stage 1C — 1D CNN Feature Extraction

- **Input**: 30-day trailing window, 2 channels — `liquidity_level`, `congestion_level`.
- **Normalization**: train-only statistics, applied identically across train/validation/test.
- **Architecture**: a single, **strictly 1D CNN** (`FeatureExtractor1DCNN`), shared weights, applied independently once per populated bridge slot. No attention, Transformer, or BiLSTM components — this is a fixed project constraint.
- **Output**: 64-dimensional embedding per populated bridge; padded slots receive an exact all-zero 64-dim vector and are never passed through the CNN.
- **Combined observation size**: **415** — `1` (amount) + `30` (raw per-slot Stage 1A features, 6 slots × 5) + `384` (CNN block, 6 slots × 64).
- **`simulation_date`**: each transaction is anchored to an explicit synthetic simulation date used to select the correct trailing window from the daily data. These are simulation anchors for building/testing the pipeline, not real historical transaction timestamps.

The Stage 1C wrapper is a **validated feature/observation construction path**. It has been tested for windowing correctness, normalization leakage, padding behavior, and observation dimensionality — it does **not** include a trained CNN (the network is untrained/randomly initialized) or any PPO integration. End-to-end CNN+PPO training is Stage 1D.

## Data Provenance

| Category Examples  |                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **REAL**           | WDI exchange rate, CPI index levels, RPW fee/margin/speed observations, FRED daily FX rates                                                       |
| **DERIVED**        | Macro-risk proxy, corridor friction, real cost baseline, YoY/volatility calculations                                                              |
| **SYNTHETIC**      | Daily liquidity/congestion simulation output, ARE→MEX fallback values, `simulation_date` anchors                                                  |
| **ASSUMPTIONS**    | Synthetic generator parameters (jump rates, baseline volatility, conditioning coefficients) — explicitly configurable, not empirically calibrated |

## Repository Structure

```
cbdc/
├── requirements.txt
├── test_run.py
├── data/
│   ├── structured/          # bridge_network.csv, transaction_requests.csv, countries.csv
│   ├── raw/                 # WDI, CPI, RPW, FRED source files (see Dataset Requirements)
│   └── processed/           # Stage 1B generated outputs (parquet/json)
├── src/
│   ├── backtest.py
│   ├── generate_countries.py
│   ├── generate_mock_data.py
│   ├── envs/                # Stage 1A: cbdc_env.py, bridge_network.py, reward.py,
│   │                         # stage1c_obs_wrapper.py
│   ├── models/               # feature_extractor.py (1D CNN), rl_agent.py (placeholder,
│   │                         # not yet PPO), stage1c_windowing.py
│   ├── memory/               # cognee_layer.py (regulatory stub, not real Cognee)
│   └── preprocessing/        # Stage 1B: wdi.py, cpi.py, rpw.py, macro_risk.py,
│                             # normalization.py, synthetic_generator.py,
│                             # are_mex_fallback.py, split.py, run_stage1b.py
└── tests/
    ├── test_stage1a.py
    ├── test_stage1b.py
    └── test_stage1c.py

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

# Run test suites
python tests/test_stage1a.py
python tests/test_stage1b.py
python tests/test_stage1c.py

```

## Validation Status

| Suite Result  |                  |
| ------------- | ---------------- |
| Stage 1A      | 17/17 passed     |
| Stage 1B      | 26/26 passed     |
| Stage 1C      | 13/13 passed     |
| **Total**     | **56/56 passed** |

These tests validate **implementation mechanics and regression safety** — correct data loading, no temporal leakage, correct tensor shapes, reproducibility under a fixed seed. They are **not** evidence of real-world CBDC routing behavior, since no such system exists to validate against.

## Current Limitations

- No real CBDC bridge telemetry exists anywhere; all liquidity/congestion dynamics are synthetic.
- The network currently has one bridge per corridor — multi-bridge splitting has limited scope to demonstrate itself until the network is expanded (a Stage 1D-adjacent decision, not yet made).
- `simulation_date` currently uses one fixed date per transaction per split — insufficient on its own for full PPO training across varied conditions.
- The macro-risk proxy is a coarse, assumption-laden signal, not a validated volatility forecast.
- This checkpoint (Stages 1A–1C) is **not** a complete routing system — there is no trained model and no PPO agent yet.

## Future Roadmap

- **Stage 1D — PPO Training**: replace the current placeholder policy network with a real PPO implementation; resolve the `simulation_date` and network-diversity limitations noted above.
- **Stage 1E — Cognee / Semantic Memory**: integrate a real knowledge/memory layer (regulatory rules, corridor relationships) beyond the current hardcoded stub.
- **Stage 1F — Backtesting / Evaluation**: baseline comparisons (cheapest-bridge, fixed-bridge, greedy-waterfall) against the trained agent.
- **Major Phase 2 — Full-Stack Web Orchestration**: FastAPI backend, React dashboard.
- **Major Phase 3 — Real-Time Streaming & Production**: live data feeds, production inference.

None of the above is implemented in this repository yet.

## Reproducibility

All stochastic components (the synthetic liquidity/congestion generator) use a fixed master seed (**`SEED = 42`**) with deterministic, hash-derived sub-seeds per bridge/date — verified to produce bit-identical outputs across independent runs. Normalization statistics are fit once on the training period and frozen; leakage tests confirm training-period outputs are unaffected by validation/test-period values.

## Research Disclaimer

- Synthetic bridge liquidity/congestion observations are **not real measurements** of any CBDC system — none currently exists to measure.
- Any results produced by this project should be interpreted as **simulation-based findings under stated assumptions**, not as claims about real-world CBDC infrastructure.
- A planned sensitivity analysis across simulation parameters is a **robustness check**, not proof of real-world generalization — parameter ranges are themselves assumptions, not empirically derived bounds.