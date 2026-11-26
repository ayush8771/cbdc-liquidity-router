# CBDC Liquidity Router

A research prototype for routing cross-border CBDC-style transactions across several liquidity venues ("bridges") with reinforcement learning. It is built on a simulation environment anchored to real historical financial data, and served through a full-stack web application.

[![tests](https://github.com/ayush8771/cbdc-liquidity-router/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/ayush8771/cbdc-liquidity-router/actions/workflows/tests.yml)
[![phase2-integration](https://github.com/ayush8771/cbdc-liquidity-router/actions/workflows/phase2-integration.yml/badge.svg?branch=main)](https://github.com/ayush8771/cbdc-liquidity-router/actions/workflows/phase2-integration.yml)
[![phase2-docker](https://github.com/ayush8771/cbdc-liquidity-router/actions/workflows/phase2-docker.yml/badge.svg?branch=main)](https://github.com/ayush8771/cbdc-liquidity-router/actions/workflows/phase2-docker.yml)
[![phase2-stack](https://github.com/ayush8771/cbdc-liquidity-router/actions/workflows/phase2-stack.yml/badge.svg?branch=main)](https://github.com/ayush8771/cbdc-liquidity-router/actions/workflows/phase2-stack.yml)

> **A research prototype, not a payment system.**
>
> - It processes no real CBDC transactions, moves no funds, and connects to no real CBDC ledger, bridge or payment system.
> - Bridge liquidity and congestion are **synthetic**, because no real CBDC bridge telemetry exists.
> - All results are simulation findings under stated assumptions.
> - The web application uses **development-only authentication** and is **not production-ready**.

## Contents

- [Project status](#project-status)
- [Overview](#overview)
- [Architecture](#architecture)
- [Major Phase 1: offline AI/RL foundation](#major-phase-1-offline-airl-foundation)
- [Major Phase 2: full-stack web orchestration](#major-phase-2-full-stack-web-orchestration)
- [Major Phase 3: real-time streaming and production pilot](#major-phase-3-real-time-streaming-and-production-pilot)
- [Repository structure](#repository-structure)
- [Getting started](#getting-started)
- [Testing and CI](#testing-and-ci)
- [API documentation](#api-documentation)
- [Known limitations](#known-limitations)
- [Roadmap](#roadmap)
- [Documentation](#documentation)
- [Reproducibility](#reproducibility)
- [Research disclaimer](#research-disclaimer)
- [Licence](#licence)

## Project status

Status as of 24 November 2026.

| Major phase | What it covers | Status |
|---|---|---|
| **Phase 1 — Offline AI/RL foundation** | Data pipeline, simulation, Gymnasium environment, 1D CNN, PPO, baselines, semantic memory and backtesting (Stages 1A–1F) | **Complete** as the Phase 2 baseline (tag `phase1-complete`, commit `bc9905e`). Six research items remain open. |
| **Phase 2 — Full-stack web orchestration** | FastAPI inference service, Express backend, PostgreSQL, React frontend, Docker Compose, CI | **Integrated and merged into `main`** ([PR #14](https://github.com/ayush8771/cbdc-liquidity-router/pull/14), merge commit `28da68f`). Integration sign-off is recorded, and all 11 CI checks passed on the merge commit. Not production-ready. The OpenAPI files are still DRAFT, and `ppoProjected` is disabled. |
| **Phase 3 — Real-time streaming and production pilot** | Approved live data, event streaming, live dashboard updates and production hardening | **Planning only.** The scope is accepted, milestone 3.0 is complete and milestone 3.1 (architecture) has begun. **No Phase 3 code exists.** No gate has passed and no data provider is approved. |

**Terminology.** The project has three **Major Phases**. Major Phase 1 contains internal milestones called **Stages 1A–1F**; Phase 3 has **milestones 3.0–3.7**. These are separate numbering schemes. "Phase 2" always means the web application, never a stage.

## Overview

### Problem statement

Cross-border payment networks are fragmented. Several bridges or liquidity venues can serve the same corridor, each with its own fees, available liquidity and congestion. A router that always picks the cheapest venue can exhaust that venue's liquidity and leave part of a transfer unrouted.

This project studies routing that weighs **cost, latency and congestion, available liquidity and risk together**. It can **split one transaction across several venues** when a single venue cannot, or should not, carry the whole amount.

### Objectives

1. **Research question:** can a reinforcement-learning agent learn liquidity-aware, multi-venue routing under simulated but real-data-anchored conditions? Its decisions should account for how liquidity and congestion evolve over time, not just their current snapshot.
2. **Honest evaluation:** compare the agent with transparent baselines (cheapest-feasible and a liquidity-aware waterfall) using multi-seed, multi-scenario paired statistics.
3. **Application:** serve the validated engine through a web application without changing its semantics (Phase 2, done).
4. **Pilot:** extend it into a production-oriented research pilot that uses approved live data (Phase 3, planned).

### Research scope

- **In scope:**
  - three corridors (USA→IND, GBR→PHL, ARE→MEX), with three venues each;
  - a simulated daily bridge state from 2011-01-01 to 2025-09-30;
  - routing decisions for single transactions, each treated as an independent one-step episode;
  - offline training and evaluation, and a web application over the frozen engine.
- **Out of scope:**
  - real CBDC infrastructure, and processing or settling real money;
  - compliance decisions;
  - real bridge telemetry;
  - AMM-style slippage, a possible future Phase 1 extension that isn't implemented.

## Architecture

### Three major phases

```text
MAJOR PHASE 1  offline data, simulation, learning, evaluation      (complete)
      │   frozen engine + checkpoints, tag phase1-complete
      ▼
MAJOR PHASE 2  FastAPI inference ◄─ Express API ◄─ React web app   (integrated, merged)
      │          PostgreSQL persistence, Docker Compose, CI
      ▼
MAJOR PHASE 3  approved live data, event streaming, live updates,  (planning; no code)
               production hardening — "real-time monitoring with
               simulation-based routing"
```

### Phase 2 runtime architecture

```text
Browser
   │  http://127.0.0.1:8080   (published on loopback only)
   ▼
web        nginx serving the React single-page app; proxies /api
   │  /api/v1
   ▼
backend    Express 5 + TypeScript: Application API, dev auth, ──► PostgreSQL 18
           validation, persistence through Prisma 6                (append-only records
   │  /v1  (private Compose network)                               with audit rows)
   ▼
inference  FastAPI on Python 3.10: Inference API, isolated engine worker processes
   │
   ▼
Phase 1 engine (src/, data/), read-only
```

The `migrate` service applies the Prisma migrations once and exits. The optional `seed` service creates the development users. Only `web` has a host port. The backend (4000), inference (8000) and PostgreSQL (5432) are reachable only inside the Compose network.

### Phase 1 routing pipeline

```text
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
Optional inference-time capped-simplex projection (used by ppo_projected)
                       │
                       ▼
CBDCLiquidityEnv.step(): executed_i = min(requested_i, liquidity_i), no redistribution;
reward = cost − λL·latency − λR·risk − λU·unrouted (λ placeholders = 1.0)
```

## Major Phase 1: offline AI/RL foundation

Phase 1 is complete as the Phase 2 baseline (tag `phase1-complete`). Phase 2 wraps this code without changing it.

### Stages 1A–1F

| Stage | Focus | Status |
|---|---|---|
| 1A | Environment and network foundation | Complete, regression-tested |
| 1B | Data preprocessing and simulation | Complete, regression-tested |
| 1C | 1D CNN temporal feature extraction | Complete, regression-tested |
| 1D | Dynamic state and PPO policy optimization | Implemented and experimentally evaluated; finalized 1 November 2026 ([results](docs/STAGE1D_RESULTS.md)) |
| 1E | Cognee / semantic memory | Complete as an infrastructure milestone, 2 November 2026; real knowledge population deferred ([details](docs/STAGE1E_MEMORY.md)) |
| 1F | Comprehensive backtesting and evaluation | Complete, 2 November 2026 ([results](docs/STAGE1F_RESULTS.md)) |

### Implemented methods

- **Environment (Stage 1A).** `CBDCLiquidityEnv` is a [Gymnasium](https://gymnasium.farama.org/) environment with these mechanics:
  - **Feasibility masking.** A venue slot is usable only if it exists for the corridor and the transaction passes the regulatory hard filter.
  - **Allocation actions.** The action is a fractional allocation vector, `requested_i = alloc_i × amount`, not a single choice.
  - **Capacity clipping.** `executed_i = min(requested_i, liquidity_i)`, and overflow is **never redistributed**.
  - **Unrouted amount.** The unrouted amount is tracked and penalised in the reward.
  - **Slots.** `MAX_BRIDGES = 6` is the slot capacity, not a claim about real bridge counts.
- **Data and simulation (Stage 1B).**
  - Train-only normalization, a 30-day gap buffer at every split boundary, and conditioning on the *previous* period only.
  - Synthetic liquidity and congestion from an Ornstein–Uhlenbeck plus jump-diffusion process. It is conditioned on real-derived signals where a defensible link exists, and unconditioned elsewhere.
- **Temporal encoder (Stage 1C).**
  - A strictly **1D CNN** (`FeatureExtractor1DCNN`) with shared weights, applied to each populated slot's 30-day, two-channel window (liquidity, congestion). It produces a 64-dim embedding; padded slots get exact zeros.
  - The combined observation is 415-dim: 1 amount + 30 raw features + 384 from the CNN.
  - No attention, Transformer or BiLSTM components: a fixed project constraint.
- **Policy (Stage 1D).**
  - A PPO actor-critic with a **masked Dirichlet** allocation head, trained end to end with the CNN. The entropy coefficient defaults to 0.0.
  - A regime-stratified transaction generator with ground-truth labels (`splitting_needed`, `near_boundary`, `below_cheapest`, `exceeds_combined`).
  - A lagged-quarter real RPW cost baseline and a corridor risk proxy.
- **Baselines.**
  - **Cheapest-feasible** sends the whole amount to the lowest-fee feasible venue.
  - The **liquidity-aware waterfall** fills feasible venues in ascending fee order, up to each venue's current liquidity.
  - Both baselines run through the same `env.step()` path as PPO.
- **Capacity projection.** An inference-time capped-simplex projection (`src/training/capacity_projection.py`) projects PPO's allocation onto per-venue liquidity. It is applied after the policy, not learned.
- **Semantic memory (Stage 1E).**
  - A deterministic, provenance-tagged knowledge base read by `StaticMemoryProvider`, the **only authority for feasibility**.
  - An optional Cognee adapter used for explanations and audit only; knowledge is never a PPO input.
- **Backtesting (Stage 1F).** A paired, multi-seed, multi-scenario evaluation:
  - a two-level cluster bootstrap and Holm correction;
  - a pre-registered analysis plan;
  - four leakage guards;
  - reward-weight sensitivity at evaluation time.

### Network and venues

The network has three corridors with three venues each, nine in total, defined in [`data/structured/bridge_network.csv`](data/structured/bridge_network.csv):

| Corridor | Original venue (`#0`) and its tag | Added in Stage 1D (`#1`, `#2`) |
|---|---|---|
| USA→IND | `real_static_bridge` | `synthetic_bridge_expansion` |
| GBR→PHL | `real_static_bridge` | `synthetic_bridge_expansion` |
| ARE→MEX | `synthetic_no_real_anchor` (RPW has no ARE→MEX observations) | `synthetic_bridge_expansion` |

These are configured venues, not real CBDC bridges. Each corridor has three populated slots and three padding slots.

### Datasets and preprocessing

| Source | What it provides | Role |
|---|---|---|
| **WDI** (World Bank) | Annual official exchange rate | Macro-risk conditioning input |
| **CPI** (not seasonally adjusted; matched-month YoY computed in the project) | Monthly inflation signal | Macro-risk conditioning input |
| **RPW** (World Bank Remittance Prices Worldwide) | Quarterly corridor-level fee %, FX margin, transfer speed | Conditions the simulated baseline liquidity and congestion; lagged cost baseline |
| **FRED** | Daily FX rates (`DEXINUS`, `DEXUSUK`, `DEXMXUS`) | Daily FX volatility component of macro-risk, where available |

- **FRED coverage.** The committed FRED files run from 2021-08-09 to 2026-08-07, 1,305 rows each, and observations after 2025-09-30 are excluded. Earlier dates fall back to the WDI/CPI-derived component, or to an explicit `unconditioned_default` flag. PHP and AED have no FRED series: there is no verified daily official source for PHP, and AED has been pegged to USD since 1997.
- **ARE→MEX fallback.** RPW has no ARE→MEX observations, so USA→MEX is used as a substitute. It is tagged `synthetic_no_real_anchor` and is never written into the real RPW output.
- **Splits.** The data is split into train (2011-01-01 to 2021-12-31), validation (2022–2023) and test (2024-01-01 to 2025-09-30), with a 30-day gap buffer at each boundary (`data/processed/split_manifest.json`).
- **Stage 1D transactions.** 500 train, 100 validation and 100 test rows, plus three synthetic holdouts of 500 rows each (seeds 20261102, 20261103 and 20261104), in `data/processed/`. The test split and all three holdouts have already been examined, so none is a pristine holdout.

Row counts of the committed processed outputs, checked 24 November 2026:

| Output | Rows |
|---|---:|
| WDI FX features | 9,838 |
| CPI features | 44,673 |
| RPW corridor-quarterly | 17,202 |
| Macro-risk proxy | 1,062 |
| Synthetic daily bridge state | 48,483 |

The daily bridge state covers 9 venues × 5,387 days, from 2011-01-01 to 2025-09-30. Before the Stage 1D expansion it covered 3 venues, or 16,161 rows.

### Data provenance

| Category | Examples |
|---|---|
| **REAL** | WDI exchange rate, CPI index levels, RPW fee/margin/speed observations, FRED daily FX rates |
| **DERIVED** | Macro-risk proxy, corridor friction, real cost baseline, YoY and volatility calculations |
| **SYNTHETIC** | Daily liquidity/congestion simulation, ARE→MEX fallback values, `simulation_date` anchors, the six `synthetic_bridge_expansion` venues, all Stage 1D transactions (splits and holdouts) |
| **ASSUMPTIONS** | Generator parameters (jump rates, baseline volatility, conditioning coefficients): configurable, not empirically calibrated |

### Experimental findings

**Stage 1D** ([full results](docs/STAGE1D_RESULTS.md)):

- **Entropy regularisation.** `ENTROPY_COEF = 0.005` showed no consistent benefit across seeds 42, 123 and 2026 on validation. The mean reward difference was −0.0007 ± 0.0014, so the default is **0.0**.
- **Failure diagnosis.** Every PPO failure examined was a `splitting_needed` transaction in GBR→PHL, where one venue was over-allocated beyond its liquidity and the excess was clipped, not redistributed. The median clipped share was 5.13% of the amount.
- **Capacity projection.** Projection raised PPO completion to the waterfall's level on every checkpoint, on validation and on all holdouts. On the five holdout views, completion rose by 3.6–6.8 points, with no retraining.
- **PPO against the waterfall on reward is inconclusive.** Across the five holdout views, projected PPO minus the waterfall ranged from −0.0033 to +0.0051, and projected PPO won on between 2 and 6 of the 6 checkpoints.

**Stage 1E** ([details](docs/STAGE1E_MEMORY.md)):

- **Workflow verified.** The pipeline was verified live with local Ollama (`llama3.1:8b`, `nomic-embed-text`). The smoke test passed 7 of 7 checks, and the read-only audit covered 1,522 transactions: 3 of 3 corridors were grounded, and 1,500 of 1,500 decisions matched the recorded Stage 1D outcomes.
- **No real knowledge yet.** The knowledge base holds only the assumed $500K cap, so these runs validate the workflow, not retrieval quality.

**Stage 1F** ([full results](docs/STAGE1F_RESULTS.md); run in `outputs/backtests/stage1f_backtest_20261102_023545/`). The backtest covered 1,460 holdout transactions × 6 checkpoints × 4 policies × 6 stress scenarios: baseline, −30% and −50% liquidity, cheapest-venue outage, congestion ×2, and combined.

- **The projection is what makes PPO capacity-aware.** It raises completion to the waterfall's level in every scenario: +4.6 points at baseline [+2.5, +6.9], and up to +81 points under the outage. All gains are significant (Holm p < 0.001, 6 of 6 checkpoints).
- **The trained policy barely responds to liquidity.** On one checkpoint and 100 transactions, its share to the fee-cheapest venue stayed at about 0.32–0.35 while that venue's liquidity fell tenfold (mean change 0.006). Without the projection, PPO completes only **15.6%** of outage transactions on average (6.1–41.2% across checkpoints), against 96.5% with it.
- **PPO is not shown to beat the waterfall on reward.**
  - Projected PPO minus the waterfall is +0.0017 [−0.013, +0.016] at baseline, which is inconclusive. Five of the six scenarios are inconclusive.
  - The one significant gain, under the outage, is +0.0046 [+0.0005, +0.0092] (Holm p 0.042). It is small, and it disappears when latency is weighted at 0.5.
  - Original PPO is significantly *worse* than the waterfall at −50% liquidity (−0.024) and under the outage (−0.236).
- **The environment's reward accounting is flawed under liquidity shortage.** Never-requested amounts are not counted as unrouted. This inflates some rewards by up to 0.036, which is larger than most policy differences, so Stage 1F uses amount-based reward for stress comparisons.
- **Rankings depend on the placeholder reward weights.** At λ_latency = 2, even cheapest-feasible scores highest under congestion stress.

## Major Phase 2: full-stack web orchestration

Phase 2 serves the frozen Phase 1 engine through a web application. It changes no Phase 1 code, data or results.

The design is in [`docs/PHASE2_ARCHITECTURE.md`](docs/PHASE2_ARCHITECTURE.md), the normative API in [`docs/PHASE2_API_CONTRACT.md`](docs/PHASE2_API_CONTRACT.md) v0.4, and the progress and evidence in [`docs/PHASE2_STATUS.md`](docs/PHASE2_STATUS.md).

### Services

| Service | Technology | Responsibility | Details |
|---|---|---|---|
| `web` | React 19, Vite 7, Tailwind CSS 3.4, TypeScript; served by nginx | The user interface; proxies `/api` to the backend. The only published service. | [`services/web/README.md`](services/web/README.md) |
| `backend` | Node 20, Express 5, TypeScript, Prisma 6 | The public Application API (`/api/v1`, 15 endpoints): development authentication and roles, request validation, calls to inference, persistence and audit | [`services/backend/README.md`](services/backend/README.md) |
| `postgres` | PostgreSQL 18.6 | Stored transactions, decisions, comparisons, explanations and the audit log | [`infra/compose.yaml`](infra/compose.yaml) |
| `migrate`, `seed` | Backend image targets | One-shot Prisma migrations; optional seeding of the development users | [`infra/README.md`](infra/README.md) |
| `inference` | Python 3.10, FastAPI, PyTorch 2.13 (CPU build in Docker) | The internal Inference API (`/v1`, 9 endpoints), running the Phase 1 engine in isolated worker processes | [`services/inference/README.md`](services/inference/README.md) |

### Features

These are implemented and integrated:

- **Route a transaction.** Choose a corridor, amount, date and state, and a policy. The result shows per-venue allocations, executed and unrouted amounts, metrics and warnings, and it is persisted with an audit row.
- **Compare policies** on the same transaction and the same state. Each comparison is stored as its own record.
- **History and detail.** A paginated, filterable transaction history, and each stored decision with its allocations.
- **Explanations.** A structured explanation of a stored decision, produced by the engine's explain endpoint. Cognee is not used: `semantic_context` is always null in the v1 API.
- **Dashboard.** Aggregates over the stored decisions.
- **Network view.** Corridors and venues, with fees, baseline capacity and data-source tags.
- **Bridge monitor.** Each venue's liquidity and congestion on a replay or scenario date, labelled as simulated.
- **Mandatory labels.** The UI marks values as "Simulated", "User-supplied synthetic state", "Experimental", "Placeholder weights", "Default (waterfall)" or "Synthetic venue". It shows a permanent "Development authentication — not secure" banner, and states that replay transactions don't consume liquidity.

The data screens are designed for windows at least 1024 px wide. Below that width, the comparison and new-transaction screens show a placeholder.

### Routing policies

| Policy (Inference API / Application API) | Status | Enabled | What it does |
|---|---|---|---|
| `waterfall` / `waterfall` | default | Yes | Liquidity-aware waterfall baseline |
| `cheapest_feasible` / `cheapestFeasible` | baseline | Yes | Cheapest-feasible baseline |
| `ppo_projected` / `ppoProjected` | experimental | **No** | Trained PPO policy with the inference-time capacity projection |

- **`ppoProjected` is disabled.** It stays disabled until the project owner approves a checkpoint; `services/inference/config/approved_checkpoints.json` is empty. While it is disabled:
  - an analyst who requests it gets `409 POLICY_DISABLED`;
  - a viewer gets `403 FORBIDDEN_POLICY`;
  - in a comparison it is listed as `skipped`.
- **Raw PPO is not served** by either API.
- **Aliases.** Comparisons accept `baseline` (= `waterfall`) and `ruleBased` (= `cheapestFeasible`).

### State modes and scenarios

Every routing request names one state:

- **Historical replay:** the Phase 1 synthetic daily state on a date. This is simulated history, not observed bridge data.
- **Scenario:** one of the six Stage 1F stress scenarios applied to the daily series: `baseline`, `liquidity_minus30`, `liquidity_minus50`, `cheapest_venue_outage`, `congestion_x2` or `combined_stress`. They are uniform multipliers, not calibrated shocks.
- **Explicit:** liquidity and congestion supplied by the caller, labelled `user_supplied_synthetic`.

Valid reference dates run from 2011-01-01 to 2025-09-30, excluding the gap buffers around split boundaries. There are no future dates. A value outside the training range adds the warning `STATE_OUTSIDE_TRAINING_RANGE`.

### Authentication (development only)

- **Tokens and roles.** Every endpoint except the two health checks needs `Authorization: Bearer <token>`. The backend stores only SHA-256 hashes of locally generated tokens, in the git-ignored `services/backend/dev-tokens.json`. Each hash maps to a user with the role `viewer` or `analyst`.
- **No login service.** There is no login or logout endpoint. The frontend keeps the token in memory, mirrored to `sessionStorage`.
- **Startup checks.** The backend refuses to start with `NODE_ENV=production`, or unless `AUTH_MODE=dev`.
- **Local use only.** This scheme must not be exposed beyond a developer's machine or a private Compose network. Replacing it with a real identity provider is Phase 3 work.

### Integration sign-off and verified evidence

[PR #14](https://github.com/ayush8771/cbdc-liquidity-router/pull/14), "Phase 2: Integrate CBDC Liquidity Router Platform", merged `feature/phase2-platform` into `main` on 24 November 2026 as merge commit `28da68f`. The project owner recorded **Phase 2 integration sign-off** on that basis ([`docs/PHASE3_SCOPE.md`](docs/PHASE3_SCOPE.md) §2.2.1).

All **11 of 11** CI check runs on `28da68f` succeeded. The results below are taken from the logs of those runs:

| Check | Workflow | Result at `28da68f` |
|---|---|---|
| `pytest` (Phase 1 suite) | `tests` | 183 passed, 10 deselected (they need the git-ignored raw datasets) |
| `contract conformance` (ubuntu-24.04 and windows-latest) | `phase2-integration` | `86 fixtures, 2 OpenAPI documents: OK`; infrastructure tests 193 passed on each OS |
| `backend PostgreSQL integration` | `phase2-integration` | 1,838 tests, 1,838 passed, 0 failed |
| `backend images` (test target) | `phase2-docker` | 1,761 passed, 0 failed, 0 skipped |
| `web image` (test target) | `phase2-docker` | 43 test files, 1,341 tests passed |
| `inference image` (full suite) | `phase2-docker` | 426 passed, 1 warning |
| `compose configuration`, `changed areas`, `tracked secret files` | `phase2-docker` | Passed |
| `full stack (compose, seed, API smoke, runtime security)` | `phase2-stack` | `full` profile on Ubuntu 24.04, seeded twice; API smoke 21 passed, 0 failed; Playwright (Chromium) 7 passed; all runtime security checks passed |

Manual evidence recorded in [`docs/PHASE2_STATUS.md`](docs/PHASE2_STATUS.md) §8:

- **Acceptance run** (`76fe95e`): 155 automated tests, 151 passed and 4 failed. The 4 failures came from 3 low-severity defects; two are now fixed and one is documented as the float32 tolerance.
- **Redeploy smoke run** (`e5c4a25`, Windows 11 with Docker Desktop): 36 of 36 checks passed.

**What the sign-off does not mean:**

- It is not a production-readiness statement.
- It is not formal approval of the OpenAPI files, which remain DRAFT.
- These Phase 2 items remain open:
  - the inference response-size limit;
  - the fixture-backed mock mode (Q20);
  - the Phase 1 cost-baseline unit (F1);
  - the provisional `AuditLog` action and outcome values;
  - the remaining fixture coverage.

## Major Phase 3: real-time streaming and production pilot

> **Planned work. Nothing in this section is implemented.** No live data feeds, streaming, real-time updates or external-data integration exist in the repository.

Phase 3 is scoped as a **production-oriented research pilot, not a real-money CBDC deployment**. The pilot has these boundaries:

- It runs for a small set of named users.
- It reads only approved, read-only data providers.
- It moves no funds and connects to no real CBDC, bridge or payment system.

Its initial capability is **"real-time monitoring with simulation-based routing."**

- **Monitoring:** approved live observations, such as FX rates, are ingested and displayed with provenance and freshness labels.
- **Routing:** routing keeps using the simulation-based state modes above.
- **Live data stays display-only** until a separate engine change is approved. The engine accepts no date after 2025-09-30.

The scope and decision record is [`docs/PHASE3_SCOPE.md`](docs/PHASE3_SCOPE.md) (v1.1), and the architecture work plan is [`docs/PHASE3_MILESTONE_3_1_PLAN.md`](docs/PHASE3_MILESTONE_3_1_PLAN.md).

### Planning status

The scope was accepted on 24 November 2026, which completed milestone 3.0. Milestone 3.1 has begun, and its first decisions are recorded:

- ingestion runs in a separate Python component;
- Express terminates the authenticated browser update channel;
- FX rates are the first candidate data category, but no provider is approved;
- provisional targets are event-to-display p95 ≤ 1 s and reconnect p95 ≤ 5 s;
- development is local Docker first, aiming at a controlled single-host pilot.

None of the 13 architecture deliverables (AD-1 to AD-13) is written yet.

### Milestones

| Milestone | Purpose | Status |
|---|---|---|
| 3.0 — Scope approval and gate register | Approve scope, gates, restrictions and exposure boundary | **Complete** |
| 3.1 — Architecture and requirements | Thirteen architecture deliverables: streaming requirements and mechanism, event schema, adapter contract, real-time channel contract, budgets, threat model, audit trail, test strategy and others | **Begun** (decisions only) |
| 3.2 — Security baseline | Real identity provider, removal of dev mode, httpOnly cookies, strict CSP, secrets management | Not started |
| 3.3 — First live adapter | Synthetic adapter first, then one approved provider end to end | Not started |
| 3.4 — Event distribution | Validation, normalization, duplicates, late events, idempotency, replay | Not started |
| 3.5 — Real-time inference and dashboard | Live updates to the dashboard with provenance labels; routing stays simulation-based | Not started |
| 3.6 — Knowledge updates | Quarantine store and human review queue for announcements and holidays | Not started |
| 3.7 — Production operations | Monitoring, alerting, degradation, deployment, backup, recovery, load testing | Not started |

A code milestone may begin only after the AD-1 component view and the 3.1 deliverables it depends on are approved.

### Capability-specific gates

The project owner is the accountable approver for each gate, with technical review from the relevant team members. **None has passed.** Each gate blocks one capability, not Phase 3 as a whole.

| Gate | Blocks | State |
|---|---|---|
| 1 — PPO approval | Activating `ppo_projected` on any served path | Not passed |
| 2 — Cognee readiness | Writing to the knowledge layer from any Phase 3 pipeline | Not passed |
| 3 — Provider approval (per provider) | Ingesting that provider's data, including recorded samples | Not passed; no provider evaluated |
| 4 — Production security | Exposure beyond the private development environment, including shared staging, LAN access, tunnels and public demo URLs | Not passed |

Before the gates pass, streaming may be developed **locally with synthetic test events only**, and reported as such. Unresolved Phase 1 research items restrict specific claims and capabilities; for example, there is no "best route" claim while the reward weights are placeholders. They do not block Phase 3 as a whole.

## Repository structure

```text
cbdc-liquidity-router/
├── README.md, CLAUDE.md               # this file; working rules for AI-assisted development
├── requirements.txt                   # Phase 1 direct dependencies (pinned)
├── requirements-lock.txt              # Phase 1 full Windows lock (torch installed separately)
├── .nvmrc                             # Node 20.20.2 for Phase 2
├── run_*.py, diagnose_failed_splitting.py,
│   analyze_training_boundaries.py,
│   policy_gradient_capacity_diagnostic.py,
│   splitting_reward_analysis.py, test_run.py   # Phase 1 experiment and analysis scripts
├── src/                               # Phase 1 engine (read-only for later phases)
│   ├── envs/                          # cbdc_env.py, bridge_network.py, reward.py, dynamic_bridge_state.py,
│   │                                  # stage1c_obs_wrapper.py, stage1d_raw_obs_wrapper.py
│   ├── models/                        # feature_extractor.py (1D CNN), stage1c_windowing.py,
│   │                                  # ppo_actor_critic.py, rl_agent.py (legacy placeholder)
│   ├── training/                      # ppo_train.py, evaluate.py, baselines.py, metrics.py,
│   │                                  # transaction_generator.py, cost_baseline.py, risk_proxy.py,
│   │                                  # capacity_projection.py
│   ├── memory/                        # knowledge.py, provider.py (StaticMemoryProvider), cognee_layer.py,
│   │                                  # cognee_adapter.py, explanation_audit.py
│   ├── backtesting/                   # Stage 1F: scenarios.py, evaluation.py, statistics.py,
│   │                                  # analysis.py, leakage.py
│   ├── preprocessing/                 # Stage 1B: wdi.py, cpi.py, rpw.py, fx_daily.py, macro_risk.py,
│   │                                  # normalization.py, synthetic_generator.py, synthetic_bridge_expansion.py,
│   │                                  # are_mex_fallback.py, country_reference.py, split.py, run_stage1b.py
│   ├── backtest.py, generate_mock_data.py
├── data/
│   ├── raw/                           # CPI workbooks, WDICountry.csv, fred/ (WDIData.csv and the RPW workbook are git-ignored)
│   ├── structured/                    # bridge_network.csv (9 venues), countries.csv, transaction_requests.csv
│   ├── processed/                     # Stage 1B outputs, Stage 1D splits and holdouts, manifests
│   └── knowledge/                     # regulatory_facts.json (Stage 1E knowledge base)
├── outputs/
│   ├── experiments/                   # timestamped Stage 1D runs (checkpoints, metrics, provenance)
│   ├── diagnostics/                   # Stage 1D failure diagnosis
│   ├── memory_audit/                  # Stage 1E explanation audit
│   └── backtests/                     # Stage 1F backtest run
├── tests/                             # Phase 1 test suite (193 tests) and fixtures
├── services/
│   ├── inference/                     # FastAPI inference service (cbdc_inference/, tests/, requirements/, config/)
│   ├── backend/                       # Express + Prisma backend (src/, test/, prisma/, scripts/)
│   └── web/                           # React + Vite frontend (src/, test/, nginx.conf.template)
├── contracts/                         # OpenAPI drafts (openapi/), 86 fixtures, test vectors
├── infra/                             # compose.yaml, env/*.env.example, scripts/ (contract checker, lock compiler, tests)
├── e2e/                               # api-smoke.py, stack-security.py, Playwright browser tests
├── .github/workflows/                 # tests.yml, phase2-integration.yml, phase2-docker.yml, phase2-stack.yml
└── docs/                              # results, architecture, contract, status, roadmap, Phase 3 scope
```

## Getting started

### Phase 1 research environment

The validated environment is Python 3.10.11 on Windows 11. The development machine used the CUDA 13.0 build of PyTorch; CI uses the CPU build. From the repository root in PowerShell:

```powershell
py -3.10 -m venv venv
.\venv\Scripts\Activate.ps1
# Install torch first: requirements-lock.txt leaves it out because the wheel is accelerator-specific.
python -m pip install torch==2.13.0 --index-url https://download.pytorch.org/whl/cpu      # CPU only
# python -m pip install torch==2.13.0 --index-url https://download.pytorch.org/whl/cu130  # CUDA 13.0
python -m pip install -r requirements-lock.txt
```

`requirements-lock.txt` is a Windows freeze: it pins `pywin32`. This sequence is what the `tests` workflow runs. `requirements.txt` lists only the direct pins.

**Raw datasets.** Two raw files are too large for Git and must be placed in `data/raw/` by hand:

- `WDIData.csv`
- `rpw_dataset_2011_2025_q3.xlsx`

Without them, 10 Stage 1B/1D tests cannot run. The processed outputs they produce are already committed in `data/processed/`. The CPI workbooks and FRED CSVs are committed.

```powershell
python -m pytest tests/                               # Phase 1 test suite

# Stage 1D experiments (each writes a new timestamped folder under outputs/)
python run_entropy_multiseed.py                       # trains 6 PPO runs; compares on validation
python run_capacity_projection_experiment.py          # evaluation only, validation split
python run_holdout_evaluation.py                      # evaluation only, synthetic holdout

# Stage 1E memory (provider settings: docs/STAGE1E_MEMORY.md)
python run_stage1e_explanation_audit.py --static-only # no LLM or provider needed
python run_stage1e_explanation_audit.py --yes         # with Cognee retrieval (local Ollama)
python run_cognee_smoke_test.py --yes                 # live Cognee smoke test

# Stage 1F backtest (evaluation only; 593–762 s per scenario on an RTX 3050)
python run_stage1f_backtest.py
```

> **Caution:** `python -m src.preprocessing.run_stage1b` regenerates the Stage 1B outputs and **overwrites the committed, validated files in `data/processed/`**. It also needs the two raw datasets. The project rules treat data regeneration as a change that needs approval.

### Phase 2 stack with Docker Compose

The complete procedure is in [`infra/README.md`](infra/README.md): prerequisites, verification, test commands, troubleshooting and security notes. Read it before starting the stack.

**Requirements:**

- Docker with Compose v2.
- On Windows, Docker Desktop with the WSL 2 backend, and a checkout **outside OneDrive**.
- Node 20 on the host, only to generate token hashes.

The stack has been validated on Windows with Docker Desktop and on Ubuntu 24.04 in CI.

1. **External env files.** Copy `infra/env/postgres.env.example`, `backend.env.example` and `inference.env.example` into a directory **outside the checkout** (for example `~/cbdc-env`). Set one local password, the same in `postgres.env` and in `backend.env`'s `DATABASE_URL`. Then point `CBDC_ENV_DIR` at the directory.
2. **Development tokens.** Copy `services/backend/dev-tokens.example.json` to `services/backend/dev-tokens.json` (git-ignored). Fill it with SHA-256 hashes of tokens you generate (procedure in `infra/README.md`, "2. Development tokens"). Keep the plain tokens private.
3. **Start the stack**, from the repository root:

   ```powershell
   $env:CBDC_ENV_DIR = "$HOME\cbdc-env"
   docker compose -f infra/compose.yaml --profile full up --build -d
   docker compose -f infra/compose.yaml --profile full ps -a
   ```

4. **Seed the development users**, once, before creating transactions:

   ```powershell
   docker compose -f infra/compose.yaml --profile full --profile seed run --rm seed
   ```

5. **Open the app.** Go to `http://127.0.0.1:8080` and sign in with your token.
6. **Stop the stack** with `docker compose -f infra/compose.yaml --profile full down`. Do **not** add `-v`, which deletes the database volume.

On Windows, a Compose build can fail with "additional privileges requested". `infra/README.md` gives a session-only workaround and explains what it disables. The stack uses development-only authentication: do not expose it beyond your machine.

**Service-level development** (running a service outside Docker) is described in each service's README.

## Testing and CI

### Phase 1 test suite

`python -m pytest tests/` collects **193 tests**:

| Suite | Tests |
|---|---:|
| Stage 1A (`test_stage1a.py`) | 17 |
| Stage 1B (`test_stage1b.py`) | 26 |
| Stage 1C (`test_stage1c.py`) | 13 |
| Stage 1D (`test_stage1d.py`) | 35 |
| Capacity projection (`test_capacity_projection.py`) | 20 |
| Stage 1E memory (`test_stage1e.py`) | 18 |
| Stage 1E Cognee adapter, mocked (`test_stage1e_cognee.py`) | 33 |
| Stage 1E audit, mocked (`test_stage1e_audit.py`) | 15 |
| Stage 1F backtesting (`test_stage1f.py`) | 16 |
| **Total** | **193** |

- **Local result.** The last recorded full local run, in the validated environment, passed all 193, with 9 known pandas `pct_change` FutureWarnings from `macro_risk.py`.
- **CI.** CI runs 183 of the 193; it deselects the 10 tests that need the git-ignored raw datasets.
- **What the tests show.** They validate implementation mechanics and regression safety, such as data loading, leakage, tensor shapes and seeded reproducibility. They are not evidence of real-world CBDC behaviour.

### Phase 2 test suites

These are the commands from [`infra/README.md`](infra/README.md), "Run the test suites", run from the repository root:

| Suite | Command |
|---|---|
| Infrastructure and contract checker (in `infra/.venv` with `infra/scripts/requirements.txt`) | `python -m pytest infra/scripts/tests -q -p no:cacheprovider` and `python infra/scripts/check_contracts.py` |
| Backend (typecheck and tests, in Docker) | `docker build --target test --build-context contracts=contracts -t cbdc-backend-test:local services/backend` |
| Inference (in the built image) | `docker build -f services/inference/Dockerfile --build-arg "CBDC_GIT_COMMIT=$(git rev-parse HEAD)" -t cbdc-inference:local .` then `docker run --rm cbdc-inference:local python -m pytest -q -p no:cacheprovider` |
| Frontend (lint and tests, in Docker) | `docker build --no-cache --progress=plain --target test --build-context contracts=contracts --build-context docs=docs -t cbdc-web-test:local services/web` |
| End to end, against a running and seeded stack | `e2e/api-smoke.py`, `e2e/stack-security.py`, and the Playwright suite (`cd e2e; npm ci; npx playwright install chromium; npm test`); see [`e2e/README.md`](e2e/README.md) |

- **The backend's PostgreSQL suites** run only when `CBDC_TEST_DATABASE_URL` points at a disposable database whose name ends in `_test`. They **empty every table**, so never point them at the stack's database.
- **The infrastructure tests** fail while any real `infra/env/*.env` file exists in the checkout.

### CI workflows

| Workflow | Runs on | Check runs |
|---|---|---|
| [`tests`](.github/workflows/tests.yml) | Pushes to `main`, `feature/phase2-platform` and `feature/phase3-platform`; every pull request | `pytest`: the Phase 1 suite on Windows, Python 3.10, CPU torch and the locked dependencies |
| [`phase2-integration`](.github/workflows/phase2-integration.yml) | Pushes and pull requests that touch `contracts/`, `infra/`, `e2e/`, `services/backend/` or `.nvmrc` | `contract conformance` (ubuntu-24.04 and windows-latest); `backend PostgreSQL integration` |
| [`phase2-docker`](.github/workflows/phase2-docker.yml) | Every push to those branches and every pull request; manual | `changed areas`, `tracked secret files`, `compose configuration`, `backend images`, `web image`, `inference image` |
| [`phase2-stack`](.github/workflows/phase2-stack.yml) | Pushes and pull requests that touch the stack's paths; manual | `full stack (compose, seed, API smoke, runtime security)`, which includes the Playwright browser tests |

- **No GitHub secrets are used.** Passwords and tokens are generated per run.
- **Other branches.** Push triggers name only `main`, `feature/phase2-platform` and `feature/phase3-platform`, so other branches are checked through pull requests.

## API documentation

- **Normative source:** [`docs/PHASE2_API_CONTRACT.md`](docs/PHASE2_API_CONTRACT.md) **v0.4, approved**. It defines both APIs, the state specification, error format, persistence, checkpoint registry, configuration and contract tests.
- **OpenAPI files: DRAFT.** The OpenAPI files ([`contracts/openapi/app.v1.yaml`](contracts/openapi/app.v1.yaml), [`inference.v1.yaml`](contracts/openapi/inference.v1.yaml), version 0.4.0) are pending formal approval by Dev A, B and C.
  - They are machine-readable representations, not independently normative.
  - Any difference from the contract is a bug in the OpenAPI file.
  - `infra/scripts/check_contracts.py` validates the OpenAPI documents and the 86 fixtures in CI.

**Application API** (`/api/v1`, served by the backend through nginx):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/health` | Readiness: backend, database and inference (no auth) |
| `GET` | `/api/v1/health/live` | Liveness (no auth) |
| `GET` | `/api/v1/auth/me` | Caller identity and role |
| `GET` | `/api/v1/meta` | Versions, enabled policies, reward-weight status |
| `GET` | `/api/v1/network` | Corridors and venues |
| `GET` | `/api/v1/state` | Bridge monitor data |
| `GET` | `/api/v1/replay/calendar` | Valid dates |
| `GET` | `/api/v1/scenarios` | Scenario list |
| `POST` | `/api/v1/transactions` | Route a transaction and persist the decision |
| `GET` | `/api/v1/transactions` | Paginated history with filters |
| `GET` | `/api/v1/transactions/:id` | One transaction with its decision and allocations |
| `GET` | `/api/v1/transactions/:id/explanation` | Explanation (stored after the first request) |
| `POST` | `/api/v1/comparisons` | Compare policies on one transaction; persisted |
| `GET` | `/api/v1/comparisons/:id` | A stored comparison |
| `GET` | `/api/v1/dashboard/summary` | Aggregates over stored decisions |

**Inference API** (`/v1`, internal; only the backend calls it): `GET /v1/health`, `/v1/version`, `/v1/network`, `/v1/state`, `/v1/replay/calendar`, `/v1/scenarios`; `POST /v1/route`, `/v1/compare`, `/v1/explain`.

**Rules that apply to both APIs:**

- Errors use the envelope in contract §4.
- `decision_id` is a hash of the canonical request and the artefact fingerprints (contract §2.11).
- Policy actions are float32, so `completion_ratio` may slightly exceed 1 (contract §2.8).

## Known limitations

**Research constraints (Phase 1):**

- **Synthetic bridge state.** Liquidity and congestion are synthetic, and no real CBDC bridge telemetry exists. Six of the nine venues are synthetic expansions, and the original ARE→MEX venue has no real anchor.
- **Placeholder reward weights.** Every λ is 1.0, uncalibrated, and every reward comparison and ranking depends on them.
- **PPO is not shown to beat the waterfall** on reward; the difference is inconclusive and changes sign across holdouts.
- **PPO is not liquidity-aware on its own.** Its capacity awareness comes from the inference-time projection, a correction applied after the policy.
- **Reward accounting.** The environment counts unrouted as requested − executed, so amounts never requested go unpenalised. This inflates rewards under liquidity shortage.
- **No independent out-of-time data.** All data ends on 2025-09-30. The holdouts share the test period, with overlapping 30-day history windows, and the test split and holdouts have already been examined.
- **Stress scenarios** are uniform multipliers, not calibrated shocks.
- **Small scale.** There are 3 corridors and 6 checkpoints from 3 seeds; observed PPO failures concentrate in GBR→PHL, and `exceeds_combined` cases are rare (0–3 per 500-row holdout).
- **Coarse risk signal.** The macro-risk proxy is coarse. When it is missing for a month, the risk value falls back to `0.0`, which is common on recent dates.
- **Empty knowledge base.** The Stage 1E knowledge base holds one assumed fact (the $500K cap, `project_assumption`, unverified), so retrieval quality is unmeasured.
- **Retraining is not bit-for-bit reproducible.**

**Application constraints (Phase 2):**

- **`ppoProjected` is disabled**; no checkpoint is approved.
- **Development-only authentication**; not production-ready, and not to be exposed beyond a developer's machine or a private Compose network.
- **No liquidity carry-over.** Each transaction is routed independently against the same state, so dashboard totals are sums of independent what-if decisions, not a simulated ledger.
- **No future dates.** "Historical" replay means simulated history.
- **Open Phase 2 items:**
  - the OpenAPI files are still DRAFT;
  - `INFERENCE_MODE=mock` returns 503 on inference-backed routes until Q20 is decided;
  - the inference response-size limit, the F1 cost-baseline unit and the `AuditLog` values are open.
- **Desktop first.** The data screens are designed for windows at least 1024 px wide; below that, the comparison and new-transaction screens show a placeholder.

**Phase 3:** none of it is implemented. There are no live feeds, no streaming, no real-time updates and no external-data integration.

## Roadmap

The long-term plan is in [`docs/FUTURE_PHASES_ROADMAP.md`](docs/FUTURE_PHASES_ROADMAP.md). It is a planning reference, not authorization to build.

- **Phase 1 open research items** (none started; several need approval):
  - independent out-of-time data beyond 2025-09-30;
  - fixing the reward's unrouted accounting;
  - calibrated reward weights;
  - learned capacity awareness, or formal adoption of the projection as part of the policy;
  - calibrated, historically grounded stress scenarios;
  - real, cited Stage 1E knowledge content.

  AMM-style slippage is an optional future Phase 1 simulator extension; it is not implemented.
- **Phase 2:** formal OpenAPI approval and the open items listed above ([`docs/PHASE2_STATUS.md`](docs/PHASE2_STATUS.md)).
- **Phase 3:** milestones 3.1–3.7 and the four gates ([`docs/PHASE3_SCOPE.md`](docs/PHASE3_SCOPE.md), [`docs/PHASE3_MILESTONE_3_1_PLAN.md`](docs/PHASE3_MILESTONE_3_1_PLAN.md)).

## Documentation

| Document | Covers |
|---|---|
| [`docs/PROJECT_HANDOVER.md`](docs/PROJECT_HANDOVER.md) | Project handover and history (prepared during Phase 1) |
| [`docs/FUTURE_PHASES_ROADMAP.md`](docs/FUTURE_PHASES_ROADMAP.md) | The three-phase roadmap and open architecture decisions |
| [`docs/STAGE1D_RESULTS.md`](docs/STAGE1D_RESULTS.md) | Authoritative Stage 1D results, with output folders |
| [`docs/FAILED_SPLITTING_INVESTIGATION_PLAN.md`](docs/FAILED_SPLITTING_INVESTIGATION_PLAN.md) | The plan for the Stage 1D failure diagnosis; its results are in the Stage 1D results |
| [`docs/STAGE1E_MEMORY.md`](docs/STAGE1E_MEMORY.md) | Stage 1E knowledge base, Cognee adapter, live-run settings |
| [`docs/STAGE1F_RESULTS.md`](docs/STAGE1F_RESULTS.md) | Authoritative Stage 1F backtest results |
| [`docs/PHASE2_ARCHITECTURE.md`](docs/PHASE2_ARCHITECTURE.md) | Phase 2 architecture, team roles, fixed decisions |
| [`docs/PHASE2_API_CONTRACT.md`](docs/PHASE2_API_CONTRACT.md) | Normative API contract, v0.4 |
| [`docs/PHASE2_STATUS.md`](docs/PHASE2_STATUS.md) | Phase 2 implementation status and evidence |
| [`docs/TEAM_REVIEW_RESOLUTION.md`](docs/TEAM_REVIEW_RESOLUTION.md) | Phase 2 review decisions |
| [`docs/PHASE3_SCOPE.md`](docs/PHASE3_SCOPE.md) | Phase 3 scope and decision record (v1.1) |
| [`docs/PHASE3_MILESTONE_3_1_PLAN.md`](docs/PHASE3_MILESTONE_3_1_PLAN.md) | Phase 3 milestone 3.1 architecture work plan |
| [`infra/README.md`](infra/README.md) | Compose setup, verification, test commands, troubleshooting |
| [`contracts/README.md`](contracts/README.md) | OpenAPI drafts, fixtures, validation |
| [`e2e/README.md`](e2e/README.md) | API smoke, runtime security and browser tests |
| [`services/inference/README.md`](services/inference/README.md), [`services/backend/README.md`](services/backend/README.md), [`services/web/README.md`](services/web/README.md) | Service-level documentation |

Some documents predate the Phase 2 merge. The live repository is the source of truth, and [`docs/PHASE2_STATUS.md`](docs/PHASE2_STATUS.md) holds the latest Phase 2 evidence.

## Reproducibility

- **Seeded simulation.** The synthetic generator uses a fixed master seed (`SEED = 42`) with deterministic, hash-derived sub-seeds per bridge and date, and it produces bit-identical outputs across runs. Normalization statistics are fit once on the training period and frozen.
- **Recorded experiment runs.** Every Stage 1D run writes a new timestamped folder with a `provenance.json` or `experiment_config.json`. It records the git HEAD, uncommitted files, code, checkpoint and data hashes, seeds and device.
- **Replays reproduce exactly.** Checkpoint replays and evaluations reproduce exactly on the recorded hardware.
- **Retraining does not.** A seed-42 retrain gave a best validation reward of 0.895447, against 0.896450 originally.
- **Pinned Phase 2 toolchain.**
  - Node 20.20.2 (`.nvmrc`) and committed Node lockfiles;
  - a hashed Linux CPU lock for the inference service;
  - Python 3.10.11 and PostgreSQL 18.6 base images pinned by digest.

## Research disclaimer

- Synthetic bridge liquidity and congestion are **not real measurements** of any CBDC system; none exists to measure.
- Results are **simulation-based findings under stated assumptions**, not claims about real-world CBDC infrastructure or performance.
- Sensitivity and stress analyses are robustness checks within assumed parameter ranges, not proof of real-world generalization.
- Nothing in this repository is financial, legal or compliance advice, and the system makes no compliance decisions.

## Licence

The repository does not include a licence file. The raw datasets come from their original publishers and remain subject to those publishers' terms.

<!-- Temporary check of the phase3-acceptance gate. Do not merge. -->
