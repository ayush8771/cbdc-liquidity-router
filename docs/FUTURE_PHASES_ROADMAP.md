# CBDC Liquidity Router — Three-Phase Product Roadmap

**Document type:** Long-term product and architecture roadmap  
**Status:** Planning reference; not an implementation specification  
**Current development focus:** Major Phase 1 — Offline AI/RL Foundation, especially internal Stage 1D validation

> **Source-of-truth and scope rule:** This document describes the intended destination of the project. It does not override the live repository, root `CLAUDE.md`, or `docs/PROJECT_HANDOVER.md`. For current implementation details, completed work, approved constraints, and immediate tasks, inspect those sources and the code. Do not implement future-phase components merely because they appear in this roadmap. Each phase and major architectural decision must be planned and approved before implementation.

---

## 1. Project purpose

The CBDC Liquidity Router is a research prototype for intelligent routing of cross-border CBDC-style transactions across multiple bridge or liquidity venues.

The router should consider transaction amount, corridor, available bridge liquidity, fees, congestion/latency, feasibility, and risk. It should be able to allocate a transaction across multiple feasible venues when a single venue cannot or should not handle the full amount.

The long-term product evolves in three major phases:

1. **Major Phase 1 — Offline AI/RL Foundation:** establish and validate the data, simulation, learning, memory, and evaluation foundation.
2. **Major Phase 2 — Full-Stack Web Orchestration:** expose the validated engine through services, persist application data, and provide a user-facing dashboard.
3. **Major Phase 3 — Real-Time Streaming & Production:** connect approved live data feeds, stream state changes and routing updates, and harden the system for production-like operation.

### Terminology — keep this distinction explicit

The project has **three major product phases**. Major Phase 1 contains internal milestones called **Stages 1A–1F**. These are different numbering systems.

- Say **Major Phase 2** or **Phase 2** for the web application.
- Say **Major Phase 3** or **Phase 3** for live streaming and production.
- Say **Stage 1E** for the planned Cognee/semantic-memory milestone inside Major Phase 1.
- Never use the unqualified phrase **“Stage 2”** to mean Major Phase 2. It creates ambiguity with the internal Stage 1A–1F sequence.

---

## 2. Major Phase 1 — Offline AI/RL Foundation

**Goal:** Build a reproducible routing engine that can be trained and evaluated offline before it is exposed through an application or connected to live feeds.

### Internal milestones

| Internal stage | Focus | Current understanding |
|---|---|---|
| **1A** | Environment and network foundation | Completed and regression-tested. Establishes the network, bridge representation, Gymnasium environment, and basic execution/reward path. |
| **1B** | Data preprocessing and simulation | Completed and regression-tested. Includes historical financial/macro data processing, validation, and simulated bridge-state inputs. |
| **1C** | 1D CNN temporal feature foundation | Completed and regression-tested. Provides the historical-window encoder used by the Stage 1D policy. |
| **1D** | Dynamic state and PPO policy optimization | Implemented and under experimental validation. Includes dynamic bridge liquidity/congestion, capacity-aware execution, risk/cost inputs, masked Dirichlet PPO, baselines, metrics, and regime-based evaluation. |
| **1E** | Cognee / semantic memory integration | Planned. Add a controlled knowledge layer for structured relationships, regulatory information, corridor context, holidays, and relevant operational events. Define precisely how verified knowledge can affect policy context, constraints, or explanations. |
| **1F** | Comprehensive backtesting and evaluation | Planned as the comprehensive evaluation milestone. Expand beyond implementation tests and initial Stage 1D comparisons to robust, reproducible evaluation across seeds, regimes, corridors, and simulation conditions. |

The exact completion status must be checked in the live repository. Basic evaluation code already exists in Stage 1D; Stage 1F means a more comprehensive evaluation and research-validation effort, not the first time metrics are introduced.

### Important Stage 1D research status

The first paired entropy experiment compared `ENTROPY_COEF=0.0` against `0.005` using seed 42. The experimental coefficient improved the recorded test metrics, including overall completion from 86% to 94% and `splitting_needed` completion from 70.83% to 87.5%. This is promising but is **not yet a robust or final conclusion**: it is one seed, the validation result was slightly lower for the entropy run, and the waterfall baseline remains stronger on the recorded test set.

Next work should follow the current handover plan: preserve the seed-42 artifacts, run additional paired seeds, diagnose remaining failures, avoid selecting hyperparameters on the already examined test split, and arrange a fresh final holdout before making final claims.

### Core Phase 1 architecture

- Historical/raw financial and macroeconomic data, with provenance recorded.
- Structured countries, corridors, bridges, and transaction definitions.
- Synthetic bridge liquidity and congestion simulation where real telemetry is unavailable.
- Custom Gymnasium environment and explicit execution/reward semantics.
- 1D CNN historical-window encoder.
- PPO actor-critic policy with feasible-venue masking and allocation shares.
- Cheapest-feasible and liquidity-aware waterfall baselines.
- Training, checkpointing, evaluation, and reproducibility tooling.
- Planned semantic memory milestone (Stage 1E).
- Comprehensive offline backtesting (Stage 1F).

### Optional advanced execution mechanics: AMM-style slippage

The original project vision also includes modelling **non-linear execution slippage** in automated market-maker (AMM) liquidity pools. This is a valid future research direction, but it is **not implemented in the current Stage 1D environment** and is not a reason to change the current hard-capacity-clipping semantics during the active entropy-validation work.

If approved, treat AMM slippage as a separately scoped **Phase 1 simulator extension**, after the current Stage 1D policy and baseline experiments have been validated and before the final Phase 1 model/checkpoint is frozen for Phase 2. It may be developed alongside the broader Stage 1F evaluation work, but the simulator mechanics and training implications must be specified first.

The intended concept is to model price impact as a function of trade size and pool reserves—for example, using a constant-product relationship such as `x * y = k`—rather than assuming every unit routed through a venue executes at a fixed price. This should complement, not silently replace, the existing hard vault-capacity constraint. A sound design must specify pool reserves, swap direction, exchange-rate units, fees, price-impact calculation, multi-venue aggregation, and the relationship between slippage and unrouted-capacity penalties. The policy must be trained and evaluated under the same execution mechanics it will use at inference.

Until that design is approved and tested, AMM slippage is a **planned optional extension**, not a current feature or a committed deliverable. Do not invent reserve data or imply that simulated AMM pools represent observed CBDC bridge pools.

### Phase 1 constraints and research honesty

- Preserve the approved **1D CNN** temporal architecture. Do not substitute Transformers, attention-based temporal encoders, or CNN-BiLSTM without an explicit architecture review and approval.
- Keep PPO as the intended policy method unless evidence identifies a fundamental limitation and a replacement is discussed first.
- Do not change earlier validated Stage 1A–1C semantics during unrelated Stage 1D work.
- Keep the distinction between real observed data, derived data, synthetic simulation data, and assumptions explicit.
- Synthetic bridge liquidity and congestion are not real CBDC bridge telemetry. Do not present simulated values as observed measurements.
- Do not claim real-world effectiveness from simulator results. Describe results as findings under the documented simulation assumptions and tested conditions.

### Phase 1 exit criteria

Before moving the validated engine into Phase 2, the project should have:

1. Reproducible training and inference artifacts with recorded configuration and code version.
2. Documented data provenance, simulator assumptions, and leakage controls.
3. Robustness evidence across multiple seeds and relevant regimes.
4. A clearly documented comparison against appropriate baselines.
5. A documented, stable inference interface for a single transaction request.
6. Explicit limitations and a final evaluation protocol that does not repeatedly tune against the same test set.

---

## 3. Major Phase 2 — Full-Stack Web Orchestration

**Goal:** Turn the validated offline engine into an application that users can operate through a web interface. Phase 2 is an application and integration phase; it is not the live-streaming/production phase.

### Planned application components

#### A. AI service — Python and FastAPI

Package the Phase 1 inference functionality behind a clear service boundary. Planned responsibilities:

- Load a selected, validated PPO checkpoint and its required preprocessing/normalization artifacts.
- Expose a transaction-routing endpoint with typed request and response schemas.
- Validate transaction inputs and return feasible bridge allocations and supporting metrics.
- Expose model/version and health information for the application backend.
- Keep the existing training/simulation code reusable; avoid an unnecessary rewrite of the validated engine.
- Provide deterministic inference for repeatable user-facing route recommendations unless a separate stochastic mode is explicitly designed.

#### B. Application backend — Node.js, Express, Prisma, and PostgreSQL

The originally proposed architecture uses a Node/Express backend as the main application API. Planned responsibilities:

- Accept and validate user-facing application requests.
- Call the FastAPI AI service and normalize its response for the frontend.
- Persist transaction requests, routing decisions, route details, evaluation summaries, and relevant state/history.
- Store bridge/corridor metadata and application-level records in PostgreSQL through Prisma.
- Provide route-history and analytics endpoints.
- Apply authentication, authorization, validation, and audit logging appropriate to the prototype.

The exact division between FastAPI and Express should be designed before implementation. Avoid duplicating business logic in both services.

#### C. Frontend — React, Vite, and Tailwind CSS

Planned user-facing features:

- **Dashboard:** routing activity and high-level cost, completion, latency, and risk summaries.
- **Global/corridor view:** display supported countries, corridors, and available bridge connections.
- **Route inspector:** show the allocation selected for a transaction, bridge-by-bridge amounts, and execution outcome.
- **Vault/bridge monitor:** show the liquidity and congestion values available to the current simulation or data snapshot.
- **Policy comparison:** compare PPO with the cheapest-feasible and liquidity-aware waterfall baselines where the evaluation data supports it.
- **Explainability panel:** present evidence-backed explanations from model inputs, execution metrics, and—after Stage 1E—retrieved semantic context. Do not fabricate causal explanations for opaque model behaviour.

#### D. Local integration and developer experience

- Use Docker Compose for repeatable local startup of the application services and database where appropriate.
- Define API contracts and error handling between React, Express, and FastAPI.
- Add service-level tests, API integration tests, and frontend tests.
- Document setup, migrations, model artifact placement, and local run commands.

### Phase 2 data boundary

Phase 2 should primarily use the validated Phase 1 model, stored data, simulation snapshots, and controlled/manual input sources. It may demonstrate the complete user workflow without claiming to consume production-grade live financial feeds. Continuous live feed ingestion and streaming updates belong to Major Phase 3.

### Phase 2 exit criteria

1. A user can submit a transaction through the web application.
2. The backend calls the AI service and receives a validated routing response.
3. The UI visualizes the recommendation and its supporting metrics.
4. Transactions and route histories are persisted and retrievable.
5. Service boundaries, error paths, and application tests are documented.
6. The web layer does not silently change the validated Phase 1 model or reward semantics.

---

## 4. Major Phase 3 — Real-Time Streaming & Production

**Goal:** Evolve the Phase 2 application to consume approved live external data, publish changing state and routing updates, and operate with production-oriented reliability and security controls.

### A. Live data ingestion

Create provider-specific adapters for data sources that are actually available, licensed, and appropriate. Candidate categories include:

- FX rates, spreads, and market data.
- Relevant economic and macroeconomic updates.
- Public central-bank, regulatory, and operational announcements.
- Country banking holidays and other verified event calendars.

**Live WebSocket feeds are part of the Phase 3 plan where a selected provider actually offers a suitable WebSocket/streaming API.** For sources without streaming support, use documented polling or scheduled ingestion instead; do not pretend a polled source is a WebSocket feed.

**ScrapeGraphAI is also a planned candidate tool for Phase 3**, specifically to extract structured information from relevant public central-bank announcements, regulatory notices, banking-holiday notices, and operational news. It is an extraction aid—not an authoritative source or a compliance decision-maker. Every extracted item must retain its source URL, timestamp, extraction status, and confidence, and should be validated before it updates Cognee or affects routing. The use of ScrapeGraphAI remains subject to source reliability, terms of use, and technical evaluation.

**Critical limitation:** Public real-time CBDC bridge/vault liquidity and congestion telemetry may not be available. Do not imply that external FX/news feeds provide actual bridge liquidity. Keep unavailable bridge-state fields simulated, manually supplied, or explicitly marked as assumptions until a legitimate data source exists.

### B. Streaming and event distribution

Choose a suitable streaming/event mechanism only after defining throughput, ordering, replay, durability, and operational requirements. Candidate options may include a message broker or managed stream, but no specific broker is mandated by this roadmap.

Planned responsibilities:

- Ingest and validate incoming events.
- Normalize timestamps, currencies, symbols, units, and source metadata.
- Handle duplicates, late events, outages, and stale data.
- Publish state updates to downstream services.
- Maintain a clear distinction between observed data and simulated state.

### C. Knowledge and semantic context updates

Where Stage 1E establishes a reliable Cognee integration, Phase 3 may update the knowledge layer as verified regulatory announcements, holidays, institution notices, or operational events arrive.

- Keep source references, timestamps, confidence, and validation status for extracted claims.
- Do not let unverified scraped text directly impose financial or compliance decisions.
- Treat legal/compliance decisions as requiring authoritative sources and appropriate human oversight.
- Provide the routing engine with structured, controlled context rather than unrestricted text.

### D. Real-time inference and dashboard updates

- Serve the selected validated PPO checkpoint through a low-latency inference path.
- Cache model artifacts and reusable state safely where appropriate.
- Define stale-data behaviour and a safe fallback when the model or data service is unavailable.
- Push route status, data freshness, and relevant state changes to the frontend through WebSockets or another suitable real-time channel.
- Display when a value is live, delayed, simulated, manually entered, or unavailable.

### E. Production hardening

Plan and implement, as appropriate:

- Secure secrets and credential management.
- Authentication, authorization, and API rate limits.
- Encryption in transit and at rest where applicable.
- Audit trails for input data, model version, routing request, allocation, and response.
- Monitoring, logs, traces, health checks, and alerts.
- Retries, timeouts, circuit breakers, idempotency, and graceful degradation.
- Deployment configuration, container orchestration, backup, and recovery.
- Performance and load testing.

### Phase 3 exit criteria

1. Approved live sources are integrated with documented limitations and provenance.
2. Data freshness, source outages, stale values, and invalid events are handled explicitly.
3. Streaming updates reach the application and dashboard reliably.
4. Model inference is observable, versioned, and has a documented fallback path.
5. Security, auditing, monitoring, and deployment procedures are tested and documented.
6. The system makes no unsupported claim that simulated bridge state is real telemetry.

---

## 5. Status of the three technologies asked about

| Technology / mechanic | Are we planning to use it? | Planned place | Important qualification |
|---|---|---|---|
| **AMM non-linear slippage** | Yes, as an optional future simulator extension | Major Phase 1, after current Stage 1D validation and before the final model is frozen for Phase 2; coordinate with Stage 1F evaluation | Not implemented now; requires an approved pool/reserve and execution model. It complements hard capacity limits rather than silently replacing them. |
| **Live WebSocket feeds** | Yes, where providers offer suitable live streaming interfaces | Major Phase 3 | Use polling/scheduled ingestion when a source does not offer WebSockets. Live FX/news does not equal live CBDC bridge-liquidity telemetry. |
| **ScrapeGraphAI** | Yes, as a candidate extraction tool | Major Phase 3 data-ingestion pipeline | Extract public news/announcements into structured, traceable records; validate before Cognee or routing decisions use them. |

These three items are not all Phase 2 features. Phase 2 is primarily the web application and service integration. The live-feed and scraping pipeline belongs to Phase 3, while AMM slippage is a simulator/execution-model enhancement that should be addressed in Phase 1 before the model is considered final.

---

## 6. End-to-end system concept

The long-term flow is:

```text
                    MAJOR PHASE 1
        Offline data, simulation, learning, evaluation
                              |
                     Validated PPO model
                     + preprocessing assets
                              |
                              v
                    MAJOR PHASE 2
       FastAPI AI service <-> Express application API
                              |
                       PostgreSQL / Prisma
                              |
                    React + Vite dashboard
                              |
                              v
                    MAJOR PHASE 3
       Approved live-data adapters and event streaming
                              |
             State updates / semantic context updates
                              |
                 Low-latency model inference
                              |
              WebSocket or equivalent live updates
                              |
                    Production operations
```

Cognee is planned as an **internal Stage 1E milestone within Major Phase 1** in the current project stage plan. Its knowledge capabilities may subsequently be used by the Phase 2 application and updated by Phase 3 data pipelines. This avoids confusing semantic-memory development with the separate Major Phase 2 web-application milestone.

---

## 6. Architecture decisions that remain open

The following are future design decisions, not approved implementation requirements:

- The exact Cognee graph schema, storage backend, retrieval strategy, and way semantic context is provided to PPO.
- Whether a Graph Attention Network (GAT) or another graph-embedding approach is justified. It must be evaluated rather than assumed.
- Whether AMM-style non-linear slippage curves should be added to the simulator. They must not be inserted into Stage 1D execution semantics without a separate approved research change.
- Which live FX/news/economic providers are usable, licensed, reliable, and technically accessible.
- Whether ScrapeGraphAI is suitable for the chosen ingestion sources.
- Which message broker or streaming platform is appropriate.
- The final division of responsibilities between FastAPI and Express.
- Deployment target, cloud architecture, database operations, and production service-level objectives.

For each decision, document the problem, alternatives, evidence, trade-offs, risks, and approval before implementation.

---

## 7. Non-negotiable project principles

1. **Preserve validated work:** do not casually refactor or change Stage 1A–1C semantics while advancing later work.
2. **Keep phases separate:** complete and validate Phase 1 before building the Phase 2 application around it; add continuous live streaming in Phase 3.
3. **Keep the source of truth clear:** the live repository and `docs/PROJECT_HANDOVER.md` define current implementation status; this file is only a future roadmap.
4. **Maintain data honesty:** label real, derived, synthetic, and assumed data explicitly.
5. **Avoid premature complexity:** Cognee, GAT, AMM slippage, ScrapeGraphAI, message brokers, and production infrastructure are not automatically required merely because they appear in future ideas.
6. **Use evidence-based changes:** define tests and evaluation criteria before changing core routing, reward, capacity, or policy semantics.
7. **Do not overclaim:** simulator results are evidence under stated assumptions, not proof of performance on a real production CBDC network.

---

## 8. How Claude Code should use this document

Read this document when asked to discuss the long-term roadmap, Phase 2, Phase 3, or architecture trade-offs.

Do not treat it as a command to implement future features. For an implementation task:

1. Read root `CLAUDE.md` and `docs/PROJECT_HANDOVER.md`.
2. Inspect the live code, Git status, current branch, and tests.
3. Identify which major phase and internal milestone the requested work belongs to.
4. Confirm the relevant design decisions and acceptance criteria with the developer.
5. Implement only the explicitly approved scope.

**Current intended focus remains Major Phase 1 / Stage 1D validation unless the developer explicitly changes the priority.**
