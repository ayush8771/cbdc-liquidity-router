# Major Phase 3 — Real-Time Streaming & Production: Scope

**Document type:** Phase 3 scope and decision record. Not an implementation specification.
**Status:** v1.1, 24 November 2026. **Accepted.** The project owner accepted v0.3 as the milestone 3.0 decision record on 24 November 2026. v1.1 adds D-22 (an approved AD-1 component view is required before any code milestone) and D-23 (the AD-2, AD-5 and AD-12 reviewers are confirmed). v1.0 added the decisions made with the acceptance: the first milestone 3.1 decisions F-1 to F-6 (§2.3), and the approved gate reviewers, second-reviewer rule and deliverable leads (D-19 to D-21).
**Milestone state:** 3.0 is **complete**. 3.1 (architecture documents) has **begun**: its first decisions are recorded, and none of AD-1 to AD-13 is written yet. 3.2–3.7 are **not started**.
**Authorization:** No application code is authorized yet. Under F-1, as tightened by D-22, a code milestone (3.2–3.7) may begin once the **AD-1 component view** and its own required 3.1 deliverables are approved, subject to its dependencies, and each gated capability also needs its gate. **No gate has passed.**
**Derived from:** `docs/FUTURE_PHASES_ROADMAP.md` §4 (Phase 3), §5 (technology status), §6 "Architecture decisions that remain open" and §7 (principles); `docs/PHASE2_ARCHITECTURE.md`; `docs/PHASE2_API_CONTRACT.md` v0.4; `docs/PHASE2_STATUS.md`.
**Phase 3 implementation status:** **not started.** No live feeds, no streaming, no production inference.
**Phase 2 status:** **integration sign-off recorded** (D-14, §2.2). This is not a production-readiness statement and not formal OpenAPI approval.
**Milestone 3.1 work plan:** `docs/PHASE3_MILESTONE_3_1_PLAN.md` (leads and first decisions approved).

> **How to read this document.** Every statement is tagged.
>
> - **[ROADMAP]** — an official requirement, constraint or open decision in `docs/FUTURE_PHASES_ROADMAP.md`. Restated, **not changed**. The section is cited.
> - **[APPROVED]** — a decision approved either in another project document (cited) or by the project owner on 24 November 2026 (decision numbers D-1 to D-23 in §2.2, and F-1 to F-6 in §2.3).
> - **[PROPOSED]** — not yet approved: an implementation option, or a detail left to a milestone 3.1 deliverable. Each is to be accepted, amended or rejected by the project owner.
>
> Where they conflict, **[ROADMAP] and [APPROVED] win.** This document does not override the live repository, root `CLAUDE.md`, `docs/PROJECT_HANDOVER.md`, `docs/PHASE2_ARCHITECTURE.md` or `docs/PHASE2_API_CONTRACT.md`.

### Revision history

- **v1.1 (24 November 2026).** Records two owner decisions. D-22 requires an approved AD-1 component view before any code milestone (3.2–3.7), which tightens F-1. D-23 confirms the reviewers of AD-2, AD-5 and AD-12. The start rules in §2.3, §6 and §7, and §2.4 and §12, are updated to match, and §2.2.1 reflects the updated Phase 2 status page. No gate has passed, and no exit criterion changed.
- **v1.0 (24 November 2026).** Records the project owner's acceptance of v0.3, which completes milestone 3.0. Records the first milestone 3.1 decisions F-1 to F-6 (§2.3) and the approval of:
  - the gate technical reviewers (D-19);
  - the second-reviewer rule (D-20);
  - the revised deliverable leads (D-21).

  The milestone 3.1 plan is updated to match. No scope, gate, milestone or exit criterion changed.
- **v0.3 (24 November 2026).** Records the owner's approval of D-1 to D-13, the gates, milestones 3.0–3.7 and exit criteria 7–12, and the five clarifications D-14 to D-18:
  - the Phase 2 integration sign-off, based on PR #14 and its post-merge checks;
  - "real-time monitoring with simulation-based routing" as the name of the initial capability;
  - the Gate 4 exposure list;
  - recorded provider samples needing Gate 3;
  - the project owner as accountable approver of all four gates.

  Statements covered by those decisions are re-tagged [APPROVED]. Proposes technical reviewers per gate (§5) and adds the milestone 3.1 work plan as a separate document.
- **v0.2 (24 November 2026).** Added the research-pilot framing, capability-specific gates, local synthetic streaming development, capability-specific Phase 1 restrictions, milestone dependencies and the 3.1 deliverables. Corrected v0.1's misquotation of roadmap §7.2, which concerns Phase 1 before Phase 2.
- **v0.1 (24 November 2026).** First scope draft.

---

## 1. Goal and framing

### 1.1 Official goal

**[ROADMAP]** (§4) Evolve the Phase 2 application to consume approved live external data, publish changing state and routing updates, and operate with production-oriented reliability and security controls.

**[ROADMAP]** (§7.2) Keep phases separate: complete and validate Phase 1 before building the Phase 2 application around it; add continuous live streaming in Phase 3.

**[ROADMAP]** (§1, §7.7) The project is a research prototype. Simulator results are evidence under stated assumptions, not proof of performance on a real production CBDC network.

### 1.2 A production-oriented research pilot

**[APPROVED]** (D-1) Phase 3 delivers a **production-oriented research pilot**: the Phase 2 application, fed by approved live data, run with production-grade engineering controls, for a small set of named users. It is **not** a real-money CBDC deployment.

| | In the pilot | Not in the pilot |
|---|---|---|
| **Money** | Routing recommendations for hypothetical transactions | Any movement of funds, settlement instruction, payment message or customer funds |
| **External systems** | Approved read-only data providers (FX, economic, announcements, holidays) | Any connection to a real CBDC ledger, bridge, vault, payment rail or bank system |
| **Bridge state** | Simulated, manually supplied or explicitly assumed, labelled as such | Any claim of observed bridge liquidity or congestion (roadmap §4.A, critical limitation) |
| **Output status** | Research output, shown with provenance, freshness and Phase 1 limitations | Execution instructions, compliance determinations, or claims of real-world effectiveness |
| **Users** | Named, invited users in the Phase 2 roles | Public sign-up or anonymous access |
| **"Production-oriented"** | Engineering controls: security, auditing, observability, reliability, deployment, recovery | Financial or operational reliance on the routing output |

### 1.3 Initial capability: real-time monitoring with simulation-based routing

**[APPROVED]** (D-15) The initial Phase 3 capability is described as **"real-time monitoring with simulation-based routing."**

- **Real-time monitoring:** approved live external observations, such as FX rates, economic updates, announcements and holidays, are ingested, distributed and displayed with provenance and freshness labels.
- **Simulation-based routing:** routing continues to use Phase 2's state modes (replay, scenario and explicit synthetic states) over the frozen Phase 1 engine. Bridge liquidity and congestion stay simulated.
- **Live observations are display-only** (D-9) until a separate engine change is approved. They are shown beside routing results, never fed into them. The engine accepts no reference date after 2025-09-30, and its cost baseline and risk cannot be overridden (A-6).

Status documents and the UI use this description. They do not describe Phase 3 routing as "live routing" or "routing on live data".

**[APPROVED]** (D-1) *Phase 3 changes where the data comes from and who may see the answer — it does not change what the routing engine computes.* Any Phase 3 work that would alter Phase 1 execution, reward or feasibility semantics is out of scope and needs a separate approved research change.

---

## 2. Decision register

### 2.1 Decisions approved in other project documents

| # | Decision | Source |
|---|---|---|
| A-1 | Phase 2 authentication is development-only. It must not be deployed beyond a developer's machine or a private Compose network. Real identity management is Phase 3 hardening. | `PHASE2_ARCHITECTURE.md` D10, §8 |
| A-2 | Phase 3 replaces dev authentication with a real identity provider (for example OIDC), removes dev mode, and uses httpOnly cookies and a strict CSP. | `PHASE2_ARCHITECTURE.md` §8.1, §8.3 accepted risk |
| A-3 | The served PPO variant is `ppo_projected`, labelled experimental, with `waterfall` as the default policy. Raw PPO is not a served policy. Enabling `ppo_projected` needs the owner's checkpoint approval. | API contract v0.4 §1 (`policy` enumeration); `PHASE2_ARCHITECTURE.md` §11.1 |
| A-4 | Feasibility comes only from the deterministic knowledge base through `StaticMemoryProvider`. Cognee is used for explanations and audit only, and knowledge is never a PPO input. | Root `CLAUDE.md`; `docs/STAGE1E_MEMORY.md` |
| A-5 | Cognee is optional, and `semantic_context` is always null in the v1 API. | `PHASE2_ARCHITECTURE.md` §11, resolved in v0.4 |
| A-6 | The engine accepts reference dates only up to 2025-09-30. Cost baseline, risk and regulatory feasibility cannot be overridden by the caller. Explicit states are labelled `user_supplied_synthetic`. | `PHASE2_ARCHITECTURE.md` §9.1, §9.2 |
| A-7 | The FastAPI/Express responsibility split. | `PHASE2_ARCHITECTURE.md` §2, v0.4 |
| A-8 | Engine worker pool, the 10 s execution limit and the 12 s request deadline. | `PHASE2_ARCHITECTURE.md` §6.2, §11 |

### 2.2 Phase 3 decisions approved by the project owner (24 November 2026)

| # | Decision | Section |
|---|---|---|
| D-1 | Phase 3 is a production-oriented research pilot, not a real-money deployment. | §1.2 |
| D-2 | The gates are capability-specific: each blocks only its capability, not Phase 3 as a whole. The project owner approves each gate (D-18). | §5 |
| D-3 | Gate 1 (PPO approval) blocks **PPO activation** only. The baselines may run on the real-time path before it passes. | §5 |
| D-4 | Gate 2 (Cognee readiness) blocks **knowledge-layer updates** only. | §5 |
| D-5 | Gate 3 (provider approval) blocks **that provider's ingestion** only, in every environment, including recorded samples (D-17). | §5 |
| D-6 | Gate 4 (production security) blocks **exposure beyond the private development environment**, including the cases listed in D-16. | §5 |
| D-7 | Local streaming development with synthetic test events may proceed before Gates 1–4 pass, under the rules in §6. | §6 |
| D-8 | Unresolved Phase 1 research items restrict specific capabilities and claims. They do not block Phase 3 as a whole. | §4.2 |
| D-9 | Live observations are display and context only. They are not engine inputs until a separate engine change is approved. | §1.3, §4.2 |
| D-10 | If Gate 1 passes, Phase 3 serves `ppo_projected` only, never raw PPO, and the waterfall stays the default. | §5 |
| D-11 | Milestones 3.0 and 3.1 (documents) were allowed to proceed before Phase 2 sign-off. Code milestones 3.2–3.7 begin after Phase 2 sign-off, which is now recorded (D-14). | §4.1, §7 |
| D-12 | The numeric latency budget and the freshness thresholds are set in milestone 3.1. | §7.3 AD-8 |
| D-13 | Milestone 3.0 is "Scope approval and gate register" (v0.1 called it "Gate clearance"). | §7 |
| D-14 | **Phase 2 integration sign-off is recorded**, on the evidence below. It satisfies D-11's Phase 2 sign-off condition. It is **not** a production-readiness statement and **not** formal OpenAPI approval. | §2.2.1 |
| D-15 | The initial Phase 3 capability is described as **"real-time monitoring with simulation-based routing."** Live external observations stay display-only until a separate engine change is approved. | §1.3 |
| D-16 | (Answers P9.) **Shared staging hosts, LAN access, tunnels and public demo URLs require Gate 4**, as does any other exposure beyond a developer's machine or a private Compose network. | §5 |
| D-17 | (Answers P10.) **Recorded provider samples require Gate 3 approval** for that provider. | §5, §6 |
| D-18 | **The project owner is the accountable approver for all four gates**, with technical reviews from the relevant team members. **None of the gates has passed.** | §5 |
| D-19 | The technical reviewers for each gate, as listed in §5. Gate 3's ingestion-component reviewer is Dev A, under F-2. | §5 |
| D-20 | **Second-reviewer rule:** when the accountable approver is also the lead of the work under review, at least one other team member reviews it before the decision. | §5 |
| D-21 | The milestone 3.1 deliverable leads: **Dev A** AD-4, AD-5, AD-6, AD-8; **Dev B** AD-2, AD-7, AD-10, AD-11; **Dev C** AD-9; **Dev D** AD-1, AD-3, AD-12, AD-13. | §7.3; `docs/PHASE3_MILESTONE_3_1_PLAN.md` |
| D-22 | **The AD-1 component view must be approved before any code milestone (3.2–3.7) begins**, in addition to that milestone's own required deliverables. The final AD-1 is not required for this; it is completed last, as planned. | §7; `docs/PHASE3_MILESTONE_3_1_PLAN.md` §3 |
| D-23 | The reviewers adjusted after a lead changed are **confirmed**: **AD-2** Dev A and Dev D; **AD-5** Dev B and Dev D; **AD-12** Dev A (Stage 1E rules) and Dev B (review-queue persistence). | `docs/PHASE3_MILESTONE_3_1_PLAN.md` §3 |

#### 2.2.1 Evidence for D-14

- PR #14, "Phase 2: Integrate CBDC Liquidity Router Platform", from `feature/phase2-platform` into `main`, was **merged on 24 November 2026 at 14:00:11 UTC** as merge commit `28da68f`.
- **11 of 11 check runs** on `28da68f` concluded `success`, as read from the GitHub check-runs API on 24 November 2026:
  - the compose configuration check;
  - the backend, inference and web image builds;
  - `pytest`;
  - contract conformance on `ubuntu-24.04` and on `windows-latest`;
  - backend PostgreSQL integration;
  - the full-stack run (compose, seed, API smoke tests and runtime security checks);
  - the changed-areas check;
  - the tracked-secret-files check.

**What D-14 does not cover:**

- **Not production readiness.** Phase 2 authentication remains development-only (A-1). Nothing in Phase 2 is approved for exposure beyond the private development environment.
- **Not formal OpenAPI approval.** The OpenAPI files in `contracts/openapi/` remain **DRAFT** pending formal approval by Dev A, B and C. `docs/PHASE2_API_CONTRACT.md` v0.4 remains the normative API definition.
- The other open items listed in `docs/PHASE2_STATUS.md` also remain open:
  - the response-size limit on inference responses;
  - Q20, the fixture-backed mock mode;
  - F1, the Phase 1 cost-baseline unit;
  - the provisional `AuditLog` `action`/`outcome` values;
  - the remaining fixture coverage.
- `docs/PHASE2_STATUS.md` records the merge, the sign-off and the CI evidence at `28da68f`. It keeps the items above open, and M4 is not marked done.

### 2.3 Milestone 3.1 first decisions (approved by the project owner, 24 November 2026)

| # | Decision | Feeds |
|---|---|---|
| F-1 | **Code-milestone start rule.** A code milestone may begin after its own required 3.1 deliverables (the "Depends on" column of §7.1) are approved, subject to its other dependencies and to the gates. It does not wait for all of 3.1. **Tightened by D-22:** the AD-1 component view must also be approved first. | §7 |
| F-2 | **A separate Python ingestion component, owned by Dev A.** It stays outside the inference service and outside Express request handling. Its directory and interfaces are set in AD-1 and AD-5. | AD-1, AD-5, AD-12 |
| F-3 | **Express terminates the authenticated browser update channel.** The choice between WebSocket and SSE is made in AD-7. | AD-7, AD-10 |
| F-4 | **FX rates are the first candidate live-data category.** No provider is approved; each still needs Gate 3. | AD-2, AD-5; Gate 3 |
| F-5 | **Provisional targets:** event-to-display p95 ≤ 1 s; reconnect p95 ≤ 5 s; a synthetic source's value is stale after three expected update intervals. Provider-specific freshness and the remaining budgets are finalized in AD-8. | AD-2, AD-8, AD-9 |
| F-6 | **Local Docker development first.** The design targets a controlled, single-host, containerized pilot, with no external exposure before Gate 4. | AD-3, AD-10; milestone 3.7 |

F-5's targets are provisional until AD-8 is approved, so they do not yet satisfy exit criterion 9. AD-8 also defines where each measurement starts and ends; for example, whether "event" means the source timestamp or the time of ingestion.

### 2.4 Still proposed

| Item | Where it is decided |
|---|---|
| Workstream implementation options marked [PROPOSED] in §3 | The 3.1 deliverable named next to each |
| Phase 3 non-goals in §11 not covered by D-1 or D-9 | Owner confirmation |
| §9.2: no retraining, and no in-place change to API contract v0.4 | Owner confirmation |

### 2.5 Open

The roadmap's §6 decisions, and the questions still open (P1, P2, P5, P6), are in §10.

---

## 3. The five official workstreams

Each workstream restates the roadmap, marks what the approved decisions settle, and lists the implementation options still [PROPOSED], with the 3.1 deliverable that decides each.

### Workstream A — Live data ingestion

**[ROADMAP]** (§4.A) Create provider-specific adapters for data sources that are actually available, licensed and appropriate. Candidate categories:

- FX rates, spreads and market data.
- Relevant economic and macroeconomic updates.
- Public central-bank, regulatory and operational announcements.
- Country banking holidays and other verified event calendars.

**[ROADMAP]** Live WebSocket feeds are part of the plan **only where a selected provider actually offers a suitable WebSocket/streaming API.** For sources without streaming support, use documented polling or scheduled ingestion instead. *Do not pretend a polled source is a WebSocket feed.*

**[ROADMAP]** ScrapeGraphAI is a **planned candidate** tool for extracting structured information from public central-bank announcements, regulatory notices, banking-holiday notices and operational news. It is an extraction aid — **not an authoritative source and not a compliance decision-maker.** Every extracted item must retain its source URL, timestamp, extraction status and confidence, and must be validated before it updates Cognee or affects routing. Its use remains subject to source reliability, terms of use and technical evaluation.

**[ROADMAP] Critical limitation.** Public real-time CBDC bridge/vault liquidity and congestion telemetry may not be available. Do **not** imply that external FX/news feeds provide actual bridge liquidity. Keep unavailable bridge-state fields simulated, manually supplied, or explicitly marked as assumptions until a legitimate data source exists.

**[APPROVED]** (milestone 3.3, D-7) A synthetic source adapter is built first, and one Gate 3-approved provider is then integrated end to end.

**[APPROVED]** (F-2, F-4)

- Ingestion runs in a separate Python component owned by Dev A, outside the inference service and outside Express request handling.
- FX rates are the first candidate live-data category. No provider is approved.

**[PROPOSED]** Implementation options:

- A uniform adapter contract. Each adapter emits a normalized envelope carrying `source_id`, `retrieved_at`, `source_timestamp`, `transport` (websocket | poll | scheduled | manual | synthetic), `provenance_class` (real | derived | synthetic | assumed) and `validation_status`. Decided in AD-4 and AD-5.
- `provenance_class` reuses Phase 1's real/derived/synthetic/assumed vocabulary rather than inventing a parallel one. Decided in AD-4.
- ScrapeGraphAI deferred until at least one non-scraped adapter works. Decided in AD-12 and milestone 3.6.

### Workstream B — Streaming and event distribution

**[ROADMAP]** (§4.B) Choose a streaming/event mechanism **only after** defining throughput, ordering, replay, durability and operational requirements. Candidate options may include a message broker or managed stream, but **no specific broker is mandated by the roadmap.**

**[ROADMAP]** Planned responsibilities:

- Ingest and validate incoming events.
- Normalize timestamps, currencies, symbols, units and source metadata.
- Handle duplicates, late events, outages and stale data.
- Publish state updates to downstream services.
- Maintain a clear distinction between observed data and simulated state.

**[APPROVED]** (milestone 3.1) The requirements (AD-2) and the mechanism decision (AD-3) are numbered deliverables. The mechanism is chosen from the approved requirements.

**[APPROVED]** (F-6) The mechanism must suit local Docker development first and a controlled, single-host, containerized pilot.

**[PROPOSED]** Implementation options:

- The smallest mechanism that meets the requirements. If the event rate is low, a PostgreSQL-backed queue with LISTEN/NOTIFY may suffice and avoids a new operational dependency. A dedicated broker should be justified by the requirements. Decided in AD-3.
- Idempotency keyed on (`source_id`, `source_timestamp`, `payload_hash`). Decided in AD-5.

### Workstream C — Knowledge and semantic context updates

**[ROADMAP]** (§4.C) Where Stage 1E establishes a reliable Cognee integration, Phase 3 may update the knowledge layer as verified regulatory announcements, holidays, institution notices or operational events arrive.

- Keep source references, timestamps, confidence and validation status for extracted claims.
- Do **not** let unverified scraped text directly impose financial or compliance decisions.
- Treat legal/compliance decisions as requiring authoritative sources and appropriate human oversight.
- Provide the routing engine with structured, controlled context rather than unrestricted text.

**[APPROVED]** (root `CLAUDE.md`, `docs/STAGE1E_MEMORY.md`) Feasibility comes only from the deterministic knowledge base. New facts need a real, cited source; `verified: true` is only for checked `real_*` sources. Letting dated or corridor-scoped facts affect feasibility requires an **approved environment change**. The generator's $500K cap must equal the knowledge-base cap, which a test enforces. The knowledge base currently holds one fact, the assumed $500K cap (`project_assumption`, `verified: false`).

**[APPROVED]** (milestone 3.6, D-4) Knowledge updates go through a quarantine store and a human review queue. Knowledge-layer writes need Gate 2. Populating Stage 1E with real cited facts remains Phase 1 work and is part of the evidence for Gate 2.

**[PROPOSED]** Implementation options:

- Nothing reaches the knowledge base without a named reviewer and a cited source. Decided in AD-12.
- Live knowledge updates stay limited to explanations and audit; see P5 (§10.2), which is still open.

### Workstream D — Real-time inference and dashboard updates

**[ROADMAP]** (§4.D)

- Serve the selected validated PPO checkpoint through a low-latency inference path.
- Cache model artifacts and reusable state safely where appropriate.
- Define stale-data behaviour and a safe fallback when the model or data service is unavailable.
- Push route status, data freshness and relevant state changes to the frontend through WebSockets or another suitable real-time channel.
- Display when a value is live, delayed, simulated, manually entered or unavailable.

**[APPROVED]** (`docs/STAGE1F_RESULTS.md`, `docs/PHASE2_STATUS.md`) Phase 1's findings stand. PPO is **not** shown to beat the liquidity-aware waterfall on reward, and the trained policy is **not** liquidity-aware on its own; the inference-time capacity projection is what makes it capacity-aware.

**[APPROVED]** (milestone 3.5, D-3, D-10, D-15, F-3, F-5)

- The real-time path runs on the Phase 2 engine pool.
- It runs the baselines (`waterfall`, `cheapest_feasible`) from the start. `ppo_projected` is added only when Gate 1 passes.
- Routing stays simulation-based.
- Express terminates the authenticated browser update channel. WebSocket or SSE is chosen in AD-7.
- Provisional targets: event-to-display p95 ≤ 1 s and reconnect p95 ≤ 5 s, finalized in AD-8.

**[PROPOSED]** Implementation options:

- Extend the existing Phase 2 provenance labelling to the live case rather than adding a parallel scheme. Decided in AD-4.
- Fallback order when the data service fails: the last known good value, labelled stale with its age shown; then a synthetic snapshot, labelled synthetic; then refuse to route rather than route on unlabelled data. Decided in AD-9.

### Workstream E — Production hardening

**[ROADMAP]** (§4.E) Plan and implement, as appropriate:

- Secure secrets and credential management.
- Authentication, authorization and API rate limits.
- Encryption in transit and at rest where applicable.
- Audit trails for input data, model version, routing request, allocation and response.
- Monitoring, logs, traces, health checks and alerts.
- Retries, timeouts, circuit breakers, idempotency and graceful degradation.
- Deployment configuration, container orchestration, backup and recovery.
- Performance and load testing.

**[APPROVED]** Deferred to Phase 3 by Phase 2:

| Source | Deferred item |
|---|---|
| `PHASE2_ARCHITECTURE.md` D10 | Phase 2 authentication must not be deployed beyond a developer's machine or a private Compose network. |
| `PHASE2_ARCHITECTURE.md` §8.1 | Phase 3 replaces dev authentication with a real identity provider (for example OIDC) and removes dev mode. |
| `PHASE2_ARCHITECTURE.md` §8.3 accepted risk | `sessionStorage` token exposure is accepted for local development only. Phase 3 must use an identity provider, httpOnly cookies and a strict CSP. |
| `PHASE2_STATUS.md` | Development authentication: bearer tokens from a git-ignored `dev-tokens.json` of SHA-256 hashes, for a container on host loopback. |

**[APPROVED]** (D-6, milestone 3.2) The authentication replacement is complete before anything is reachable outside the private development environment.

**[APPROVED]** (F-6) Development is local Docker first. The deployment design targets a controlled, single-host, containerized pilot, with no external exposure before Gate 4. No specific host has been chosen; deployment belongs to milestone 3.7.

**[PROPOSED]** An append-only audit trail keyed by request id, recording input provenance, model version, checkpoint hash, allocation and response, which extends the Phase 2 persistence model rather than adding a new store. Decided in AD-11. No migration is written until it is approved.

---

## 4. Prerequisites and Phase 1 restrictions

### 4.1 Prerequisites

1. **[ROADMAP]** (preamble, §6, §8) Each phase and major architectural decision is planned and approved before implementation. For each open decision, document the problem, alternatives, evidence, trade-offs, risks and approval.
2. **[ROADMAP]** (§4) Phase 3 evolves the Phase 2 application. **[APPROVED]** (D-11, D-14) Code milestones begin after Phase 2 sign-off; the integration sign-off is now recorded.
3. **[ROADMAP]** (§4.C) A reliable Stage 1E Cognee integration before Phase 3 updates the knowledge layer: Gate 2.
4. **[ROADMAP]** (§4.D) The selected validated PPO checkpoint before it is served. **[APPROVED]** (arch §11.1) The owner approves the checkpoint: Gate 1.
5. **[ROADMAP]** (§4.A) Sources that are available, licensed and appropriate: Gate 3.

### 4.2 Unresolved Phase 1 research items: capability-specific restrictions

**[ROADMAP]** (§2) Six Major Phase 1 research items remain open. The roadmap does not make them Phase 3 prerequisites.

**[APPROVED]** (D-8) None of them blocks Phase 3 as a whole. Each restricts the specific capabilities or claims it affects, and the restriction stays until the item is resolved through its own approved Phase 1 change.

| Open Phase 1 item | Restricted capability or claim | Permitted meanwhile | Lifted by |
|---|---|---|---|
| **Reward accounting** hides never-requested amounts, inflating reward by up to 0.036 under liquidity shortage | No live display, ranking or alert based on the environment's reward or unrouted figures. Any reward shown uses Stage 1F's amount-based accounting and is labelled as such. | Completion, executed and unrouted amounts, fees and latency per route | An approved reward-accounting change |
| **Reward weights** are λ = 1.0 placeholders; rankings change with them | No single-score "best route" or "optimal" language, and no policy ranking by composite score. Any composite score shown is labelled "placeholder weights". | Component metrics side by side, as in Phase 2's comparison view | Calibrated, approved weights |
| **No independent out-of-time data** (all data ends 2025-09-30) | No claim that routing quality holds under current or live conditions. Live observations are **not** engine inputs (D-9, D-15). Routing output is labelled as research output; no production reliance. | Ingesting, storing, streaming and displaying live observations as labelled context beside simulation-based routing results | Extended data, an approved out-of-time evaluation, and an approved engine change mapping live data to engine inputs |
| **Learned capacity awareness**: PPO barely responds to liquidity; raw PPO completed 15.6% under a cheapest-venue outage against 96.5% projected | Raw PPO is never served (D-10). `ppo_projected` is served only after Gate 1, labelled experimental, and never as the default. No claim that PPO is liquidity-aware or beats the waterfall. | Baselines on the real-time path; `waterfall` stays the default | The owner formally adopting the projection as part of the policy, or approved retraining with new evidence |
| **Realistic stress**: scenarios are uniform multipliers | No claim that routing is resilient to real market shocks; stress results are described as uniform multipliers. | Phase 2 scenarios, labelled as uniform multipliers. Engineering SLOs (latency, availability) are unaffected. | Calibrated, historically grounded scenarios |
| **Stage 1E knowledge content**: the base holds one assumed fact | Knowledge-layer updates (Gate 2). Explanations must not present the knowledge base as populated regulatory content. | Quarantine store and review queue built and tested with synthetic announcements; announcements from a Gate 3-approved provider held in quarantine | Gate 2 |

---

## 5. Decision gates

**[APPROVED]** (D-2 to D-6, D-16 to D-18) Four gates, each protecting **one capability**. A gate blocks its capability in every environment. It does not block other work, and it does not block Phase 3 as a whole. **The project owner is the accountable approver for all four**, after technical review by the relevant team members. **None has passed.**

| Gate | Blocks | Does **not** block | State |
|---|---|---|---|
| **1 — PPO approval** | Activating `ppo_projected` on any served path: enabling it, mounting a checkpoint for it, or showing its results on a live dashboard | The real-time path itself; the baselines; dashboard work; offline Phase 1 evaluation | **Not passed.** `approved_checkpoints.json` is empty, no checkpoint is mounted, `ppoProjected` reports `enabled: false` |
| **2 — Cognee readiness** | Writes to the knowledge layer (the deterministic knowledge base or the Cognee store) from any Phase 3 pipeline | Ingesting announcements into a quarantine store; building the review queue; explanations from existing content | **Not passed.** Infrastructure is complete; real cited content and retrieval-quality measurement are deferred |
| **3 — Provider approval** (per provider) | Ingesting that provider's data in any environment, **including recorded samples or fixtures taken from it** (D-17) | Other approved providers; synthetic events; adapter and pipeline development | **Not passed for any provider.** None has been evaluated |
| **4 — Production security** | Exposing any component beyond the private development environment, **including shared staging hosts, LAN access, tunnels and public demo URLs** (D-16) | Development, testing, load testing and recovery drills inside the private development environment | **Not passed.** Phase 2 authentication is development-only (A-1) |

**[APPROVED]** (A-1, D-16) The **private development environment** is a developer's machine, with services on host loopback or a private Compose network. Anything else needs Gate 4. That explicitly includes a shared staging host, access from a LAN, a tunnel, a public demo URL, and any cloud or remote host.

**[APPROVED]** (D-19) Technical reviewers for each gate. The roles are those of `PHASE2_ARCHITECTURE.md` §3; the project owner also holds the Dev A role.

| Gate | Technical reviewers | What they review |
|---|---|---|
| 1 | Dev A; Dev C | Checkpoint identity, hash and registry entry, and its Stage 1F results; UI wording and labels for `ppo_projected` |
| 2 | Dev A; Dev B | Stage 1E rules and retrieval-quality evidence; review-queue persistence and provenance fields |
| 3 | Dev A (owner of the ingestion component, F-2); Dev B | Interface type (streaming or polled), rate limits and outage behaviour; storage, retention and redistribution limits. The licence and terms decision is the project owner's. |
| 4 | Dev B; Dev C; Dev D | Identity provider, authorization, rate limits and audit trail; httpOnly cookies and CSP; secrets, deployment, backup and recovery |

**[APPROVED]** (D-20) When the accountable approver is also the lead of the work under review (for example Dev A for Gate 1), at least one other team member reviews it before the decision.

**[APPROVED]** Each gate decision is recorded in writing, with its evidence and any waiver (exit criterion 10). Evidence templates are produced in AD-13.

### Gate 1 — PPO approval

- **[APPROVED]** (arch §11.1) The owner approves which checkpoint, if any, `ppo_projected` uses. The candidates are the six Stage 1F multi-seed checkpoints.
- **Evidence:** the checkpoint identity and hash; its Stage 1F results; confirmation that the served artifact is `ppo_projected`, not raw PPO (D-10); the wording the UI may use about it (§4.2).
- **[ROADMAP] Material open item:** whether the projection is formally adopted as part of the policy is an open Phase 1 item. Gate 1 can pass with `ppo_projected` labelled experimental while that stays open.

### Gate 2 — Cognee readiness

- **[ROADMAP]** (§4.C) "Where Stage 1E establishes a reliable Cognee integration."
- **[APPROVED]** The A-4 rules, the cap-sync test, and no feasibility effect from dated or corridor-scoped facts without an approved environment change.
- **Evidence:** a knowledge base populated with real, cited facts (a Phase 1 item); a retrieval-quality measurement, since none exists; the review-queue design (AD-12); and a written decision on P5.

### Gate 3 — Provider approval (per provider)

- **[ROADMAP]** (§4.A, §6) Sources must be available, licensed and appropriate. Which providers qualify, and whether ScrapeGraphAI suits them, are open decisions.
- **Evidence, per provider:** a licence or terms permitting this use, including storage and display; whether it offers a genuine streaming interface or must be polled; rate limits and cost; reliability and outage history; retention and redistribution limits. Scraping permissibility is decided **per site**.
- **[APPROVED]** (D-17) Recorded samples and fixtures from a provider count as ingestion and need this gate.
- **[ROADMAP] Hard boundary:** no live FX or news source may be presented as bridge liquidity or congestion telemetry.

### Gate 4 — Production security

- **[ROADMAP]** (§4.E) and **[APPROVED]** (A-1, A-2, D-16).
- **Evidence:**
  - milestone 3.2 complete: identity provider integrated, dev mode removed, httpOnly cookies, strict CSP, and secrets management with nothing in source control;
  - authorization and rate limits tested;
  - encryption in transit;
  - the audit trail covering input data, model version, request, allocation and response;
  - monitoring and alerting working;
  - backup and recovery exercised.

  All of it is gathered inside the private development environment, then reviewed before first exposure.

---

## 6. Local streaming development before the gates pass

**[APPROVED]** (D-7) Phase 3 does not wait for Gates 1–4 to build the streaming path. It may be developed and tested **in the private development environment, with synthetic test events.** Two conditions remain:

- the AD-1 component view (D-22) and the code milestone's own required 3.1 deliverables (F-1) are approved;
- for streaming, the mechanism decision (AD-3) is recorded, because the roadmap forbids choosing a mechanism before its requirements exist (§4.B).

Milestone 3.0 (complete) and the Phase 2 integration sign-off (D-14) are already satisfied. Any measurement spike done to inform 3.1 is disposable and is not merged as the mechanism.

**Permitted before the gates:**

- The adapter contract and a **synthetic source adapter** with a deterministic, seeded event generator (AD-12).
- The event pipeline on the chosen mechanism: validation, normalization, duplicates, late events, outages, staleness, idempotency and replay, exercised by synthetic fault injection.
- The real-time push channel and dashboard updates, including the live / delayed / simulated / manually entered / unavailable labels.
- Simulation-based routing with the baselines (`waterfall`, `cheapest_feasible`) through the Phase 2 engine pool, in Phase 2's existing state modes.
- The knowledge quarantine store and review queue, using synthetic announcements.
- Monitoring, tracing, alerting, load tests and recovery drills.

**Not permitted until the named gate passes:**

| Capability | Gate |
|---|---|
| Ingesting any data from a real provider, **including recorded samples** (D-17) | Gate 3, for that provider |
| Enabling `ppo_projected` or mounting a checkpoint for it | Gate 1 |
| Writing to the knowledge layer from a Phase 3 pipeline | Gate 2 |
| Making any component reachable outside the private development environment, including shared staging, LAN, tunnels and public demo URLs (D-16) | Gate 4 |

**Labelling and reporting rules:**

- Synthetic events carry `provenance_class: synthetic` and `transport: synthetic`, are displayed as **simulated**, and are stored so that they can never be mistaken for observed data.
- Synthetic events are never used to train, tune or select a policy.
- Status documents describe this work as **"streaming pipeline exercised with synthetic events only; no live source integrated."** Words such as "live", "real-time data" or "integrated with <provider>" are not used until that provider has passed Gate 3 and its live exit (3.3-L) is met. Even then, routing is described as simulation-based (D-15).
- Completing a milestone with synthetic events does **not** satisfy official exit criterion 1 (§8).

---

## 7. Milestones

**[APPROVED]** Milestones 3.0–3.7, their dependencies and the synthetic/live exit split. The roadmap itself gives five workstreams (A–E) without sequencing. No milestone waits for all four gates, and a milestone can reach a **synthetic exit (S)** before its **live exit (L)**.

### 7.1 Milestone table

**[APPROVED]** (D-22) Every code milestone, 3.2 to 3.7, also depends on the approved **AD-1 component view**, in addition to its "Depends on" entry below.

| Milestone | Content | Depends on | Before its gate (private env, synthetic) | Gate-blocked capability | Exit |
|---|---|---|---|---|---|
| **3.0 — Scope approval and gate register** | Owner accepts the scope. Records the pilot framing, the gate definitions, the gate approver, the §4.2 restrictions and the private-environment boundary. | — | Documents only | — | **Complete.** v0.3 accepted on 24 November 2026 as the decision record. |
| **3.1 — Architecture and requirements** | The 3.1 architecture deliverables (§7.3). | 3.0 | Documents only | — | AD-1 to AD-13 approved or explicitly deferred; mechanism recorded as a roadmap §6 decision. **Begun:** F-1 to F-6 decided; no deliverable written yet. The AD-1 component view comes first for code (D-22). |
| **3.2 — Security baseline** | Identity provider, dev mode removed, httpOnly cookies, strict CSP, secrets management, authorization and rate limits. | 3.1 (AD-10), Phase 2 sign-off (D-14) | All of it | None: it **produces** Gate 4 evidence | 3.2 complete; Gate 4 evidence assembled with 3.7's private-env items |
| **3.3 — First live adapter** | Adapter contract implemented; synthetic adapter; then one approved provider end to end with the full envelope, outage and stale handling. Polling is labelled as polling. | 3.1 (AD-4, AD-5, AD-12), D-14 | Contract, synthetic adapter, outage and stale handling | That provider's ingestion — Gate 3 | **S:** synthetic adapter feeding the envelope, faults handled. **L:** one Gate 3-approved source live and labelled, outages handled, bridge state still simulated |
| **3.4 — Event distribution** | Workstream B on the approved mechanism: validation, normalization, duplicates, late events, idempotency, replay, downstream publication. | 3.1 (AD-2, AD-3), 3.3-S | All of it | None of its own. Real events flow only from a source that has passed 3.3-L. | **S:** replay and fault handling shown with synthetic events, observed and simulated state kept distinct. **L:** the same with 3.3-L traffic |
| **3.5 — Real-time inference and dashboard** | Real-time path on the Phase 2 engine pool, with routing kept simulation-based (D-15); stale-data behaviour; fallback; push updates; per-value provenance labels. | 3.4-S, 3.1 (AD-6 to AD-9) | Baselines, push channel, labels, fallback | `ppo_projected` activation — Gate 1. Exposure — Gate 4. | **S:** latency budget met and fallback exercised on synthetic events, with every displayed value labelled. **L:** the same on 3.4-L, plus `ppo_projected` if Gate 1 has passed |
| **3.6 — Knowledge updates** | Quarantine store, review queue, validated announcement and holiday updates. ScrapeGraphAI evaluated here, if approved. | 3.4-S, 3.1 (AD-12); Phase 1 knowledge population for Gate 2 | Quarantine, review queue, extraction validation on synthetic announcements | Each source's ingestion — Gate 3. Knowledge-layer writes — Gate 2. | **S:** the review flow works end to end on synthetic items, with no automatic write. **L:** reviewed, cited updates carrying source, timestamp, confidence and validation status; nothing unverified affects routing |
| **3.7 — Production operations** | The rest of Workstream E: monitoring, tracing, alerts, circuit breakers, graceful degradation, deployment, orchestration, backup, recovery, load testing. | 3.2; operates what 3.3–3.6 deliver | Everything inside the private env, including recovery drills and load tests | Any deployment beyond the private env — Gate 4 | Official exit criterion 5 met and documented for the exposed pilot |

### 7.2 Dependency graph

```text
Phase 2 integration sign-off — recorded (D-14)
                       │  (needed before code milestones 3.2–3.7,
                       │   with the approved AD-1 component view, D-22)
                       v
3.0 Scope & gate register ──> 3.1 Architecture ──┬──> 3.2 Security baseline ────────────┐
                                                 │                                      │
                                                 ├──> 3.3-S ──> 3.4-S ──┬──> 3.5-S      ├──> Gate 4 ──> exposure
                                                 │                      └──> 3.6-S      │    (pilot users)
                                                 └──> 3.7 private-env items ────────────┘

Gate 3 (provider X) ──> 3.3-L for X ──> 3.4-L ──> 3.5-L / 3.6-L      (live observations from X only)
Gate 1 ───────────────────────────────> ppo_projected in 3.5          (baselines need no gate)
Gate 2 ───────────────────────────────> knowledge-layer writes in 3.6
```

Rationale:

- **3.0 → 3.1 → everything:** nothing is built before the scope and architecture are approved (roadmap preamble, §8).
- **AD-1 component view → 3.2–3.7:** no code starts before the components and trust boundaries it belongs to are approved (D-22).
- **3.1 → 3.4:** the roadmap forbids choosing a mechanism before its requirements exist (§4.B).
- **3.3-S → 3.4:** the distribution layer needs a producer; the synthetic adapter is enough.
- **3.4 → 3.5, 3.6:** both consume distributed events.
- **3.2 and the 3.7 private-env items → Gate 4:** exposure order matters more than feature order.
- **3.6 is last to reach its live exit:** it needs both Gate 3 and Gate 2, and Gate 2 needs Phase 1 knowledge population.

**[APPROVED]** (F-1, D-22) A code milestone may start once the AD-1 component view and *its own* required 3.1 deliverables are approved, subject to its other dependencies and to the gates. It does not wait for all of 3.1 to exit.

### 7.3 Milestone 3.1 architecture deliverables

**[APPROVED]** (milestone 3.1) The deliverable list below. All are documents or schemas. No code, broker installation, Compose change or database migration is part of 3.1. **[APPROVED]** (D-21, F-1 to F-6) The leads and the first decisions; the sequencing is in `docs/PHASE3_MILESTONE_3_1_PLAN.md`.

| # | Deliverable | Content | Feeds |
|---|---|---|---|
| AD-1 | **Phase 3 architecture document** | A context and component view extending `PHASE2_ARCHITECTURE.md`: where the separate Python ingestion component (F-2), event distribution, the observation store and the Express-terminated update channel (F-3) sit; trust boundaries; what stays on the private network; how Phase 2 services are reused, not duplicated. The **component view** is approved first and is required before any code milestone (D-22); the final version follows the other ADs | All |
| AD-2 | **Streaming requirements** | Throughput, ordering, replay window, durability and operational burden, with estimated event rates per source category | 3.4 |
| AD-3 | **Streaming mechanism decision record** | Alternatives (for example a PostgreSQL queue with LISTEN/NOTIFY, or a dedicated broker), evidence, trade-offs, risks; the choice made **from** AD-2. Closes roadmap §6's broker decision. | 3.4 |
| AD-4 | **Event envelope and provenance schema** | Envelope fields; schema versioning; the Phase 1 provenance classes and how they map to display labels (live, delayed, simulated, manually entered, unavailable); synthetic-marking rules | 3.3–3.6 |
| AD-5 | **Source adapter contract** | Transports (websocket, poll, scheduled, manual, synthetic), lifecycle, backoff, outage and staleness semantics, idempotency key | 3.3 |
| AD-6 | **Live-data-to-engine boundary** | Records D-9 and D-15: every observed field is display or context only. Explains why (the engine's date limit, non-overridable cost and risk under A-6, simulated bridge state) and what approved engine change would be needed to go further. | 3.5 |
| AD-7 | **Real-time channel contract** | The channel Express terminates (F-3): WebSocket or SSE choice; message schemas; versioning; authentication on the channel; reconnect and resync. An extension alongside API contract v0.4, which it does not modify. | 3.5 |
| AD-8 | **Non-functional budgets** | Finalizes F-5's provisional targets (event-to-display p95 ≤ 1 s, reconnect p95 ≤ 5 s, synthetic stale after three expected intervals), defines their measurement points, and adds provider-specific freshness thresholds, the remaining latency budgets and an availability target for the single-host pilot (F-6) | 3.5, 3.7 |
| AD-9 | **Fallback and degradation spec** | The fallback order; when routing is refused; how stale, simulated or missing values are shown | 3.5 |
| AD-10 | **Threat model and exposure plan** | For local Docker development and the single-host pilot (F-6): trust boundaries, identity provider options, secrets management, channel authentication, rate limits, encryption in transit; the Gate 4 evidence checklist | 3.2, Gate 4 |
| AD-11 | **Audit trail and persistence proposal** | A data-model extension for an append-only audit trail and for observation storage. It is a proposal: no migration until approved. | 3.2, 3.7 |
| AD-12 | **Synthetic event harness and review-queue spec** | Seeded generator, fault injection (duplicates, late events, gaps, outages, malformed events), labelling, the rule that it uses no provider data before Gate 3; the quarantine and human-review flow for Workstream C | 3.3, 3.4, 3.6 |
| AD-13 | **Test strategy and gate evidence templates** | Contract, replay and fault-injection tests; how Phase 1 and Phase 2 suites stay untouched; one evidence template per gate | All gates |

---

## 8. Exit criteria

### 8.1 Official Phase 3 exit criteria

**[ROADMAP]** (§4), unchanged:

1. Approved live sources are integrated with documented limitations and provenance.
2. Data freshness, source outages, stale values and invalid events are handled explicitly.
3. Streaming updates reach the application and dashboard reliably.
4. Model inference is observable, versioned and has a documented fallback path.
5. Security, auditing, monitoring and deployment procedures are tested and documented.
6. The system makes no unsupported claim that simulated bridge state is real telemetry.

### 8.2 Additional exit criteria

**[APPROVED]** (24 November 2026)

7. Every value presented to a user carries a provenance and freshness label: live, delayed, simulated, manually entered or unavailable.
8. No user-facing claim exceeds the Phase 1 evidence or breaks a §4.2 restriction.
9. The latency budget (AD-8) is a recorded number, and load tests measure against it.
10. Each gate has a written decision record, including any waiver and its rationale.
11. Criterion 1 is met only by providers that have passed Gate 3 and reached 3.3-L. Synthetic exits (S) do not count, and status documents say which exit each milestone has reached.
12. The pilot boundary (§1.2) holds: no movement of funds, no settlement, and no connection to a real CBDC ledger, bridge or payment system.

---

## 9. Dependencies and boundaries

### 9.1 Inbound

**[ROADMAP] / [APPROVED]**

- **Phase 1 artifacts:** the validated checkpoints and their preprocessing and normalization assets; baseline tag `phase1-complete` (`bc9905e`), read-only for later phases.
- **Phase 2 platform:** merged to `main` in PR #14 (`28da68f`). It comprises the FastAPI inference service, Express application API, Prisma/PostgreSQL persistence, React/Vite dashboard, engine pool, and API contract v0.4 with its error codes.
- **Stage 1E:** `StaticMemoryProvider` and the deterministic knowledge base as the only feasibility authority; `src/memory/cognee_adapter.py` and `src/memory/explanation_audit.py` for explanations and audit only, never imported from `src/envs`, `src/training` or `src/models`.
- **External:** licensed data providers; an identity provider; the chosen streaming mechanism; a deployment target.

### 9.2 Outbound boundaries

**[ROADMAP]**

- Phase 3 must not alter Phase 1 model or reward semantics, nor present simulated values as observed measurements.
- Phase 3 must not make legal or compliance decisions from unverified extracted text; such decisions need authoritative sources and human oversight.
- Unavailable bridge-state fields stay simulated, manually supplied or explicitly flagged as assumptions.
- AMM-style slippage is an optional **Phase 1** simulator extension, not Phase 3 work.

**[PROPOSED]** Phase 3 does not retrain, re-tune or reselect policies, and it does not modify API contract v0.4 in place. New real-time interfaces are added alongside it (AD-7).

---

## 10. Unresolved decisions

### 10.1 Documented open decisions

**[ROADMAP]** (§6), future design decisions, not approved requirements:

| # | Decision | Workstream | Where it is handled |
|---|---|---|---|
| 1 | Which live FX/news/economic providers are usable, licensed, reliable and technically accessible | A | Gate 3, per provider. FX rates are the first candidate category (F-4); no provider is approved. |
| 2 | Whether ScrapeGraphAI is suitable for the chosen ingestion sources | A, C | Gate 3, per site; evaluated in 3.6 |
| 3 | Which message broker or streaming platform is appropriate | B | 3.1, AD-2 and AD-3 |
| 4 | Deployment target, cloud architecture, database operations and production service-level objectives | E | Target class decided (F-6): a controlled, single-host, containerized pilot. The host, database operations and SLOs are still open: AD-8, AD-10; milestone 3.7. |
| 5 | The exact Cognee graph schema, storage backend, retrieval strategy, and how semantic context is provided to PPO | C | Gate 2. A-4 still forbids knowledge as a PPO input. |
| 6 | Whether a Graph Attention Network or another graph-embedding approach is justified; it must be evaluated, not assumed | — | Not Phase 3 work |

**[ROADMAP]** (§6) For each: document the problem, alternatives, evidence, trade-offs, risks and approval before implementation. The FastAPI/Express split is already decided (A-7) and is not reopened.

### 10.2 Questions raised by this scope

| # | Question | Status |
|---|---|---|
| P1 | Which artifact is served? | **Partly answered (A-3):** `ppo_projected`. **Open:** which checkpoint (Gate 1), and whether the projection is formally adopted (Phase 1 item). |
| P2 | What is the numeric latency budget? | **Provisionally answered (F-5):** event-to-display p95 ≤ 1 s, reconnect p95 ≤ 5 s. Final budgets and provider-specific freshness are set in AD-8 (D-12). |
| P3 | Should the Phase 1 open items gate Phase 3? | **Answered (D-8):** no; they are capability-specific restrictions. |
| P4 | Pilot or production deployment? | **Answered (D-1):** a production-oriented research pilot. |
| P5 | Does any live knowledge update ever affect feasibility? | **Open.** Proposed default: no. Anything else needs a separately approved environment change. Required for Gate 2. |
| P6 | Is scraping permitted for each site? | **Open**, decided per site under Gate 3. |
| P7 | What may the dashboard claim? | **Answered (D-8, D-15, exit criterion 8).** |
| P8 | Do code milestones wait for Phase 2 sign-off? | **Answered (D-11, D-14):** yes. The integration sign-off is recorded. |
| P9 | Where does the private development environment end? | **Answered (D-16).** |
| P10 | Do recorded samples from a provider count as ingestion? | **Answered (D-17):** yes. |

---

## 11. Non-goals

**[ROADMAP]**

- Implementing any Phase 3 component before its decisions are approved.
- Treating the roadmap, or this scope, as authorization to build beyond the milestone and gate rules.
- AMM-style slippage, which belongs to Phase 1 as an optional simulator extension.
- Changing Stage 1A–1F semantics or Phase 1 reward and execution mechanics.
- Any claim of real-world effectiveness from simulator results.

**[APPROVED]** (D-1, D-9, D-15)

- Real-money operation: movement of funds, settlement, payment messages, or connection to real CBDC, bridge or payment systems.
- Compliance determinations made by the system.
- Feeding live observations into the engine without an approved engine change, or describing routing as "live routing".

**[PROPOSED]**

- Replacing the Phase 2 engine pool, API contract or persistence model, unless a measured requirement forces it.
- Building a second inference path alongside Phase 2's.

---

## 12. Approvals: recorded and remaining

**Recorded (project owner, 24 November 2026):**

- D-1 to D-23;
- F-1 to F-6;
- the four capability-specific gates;
- milestones 3.0–3.7;
- exit criteria 7–12;
- acceptance of v0.3 as the milestone 3.0 decision record.

**Remaining during milestone 3.1:**

1. Approve the AD-1 component view, which every code milestone waits for (D-22).
2. Approve AD-1 to AD-13 as they are delivered. These include the streaming mechanism (AD-3), the WebSocket or SSE choice (AD-7), and the final budgets and measurement points (AD-8).
3. Confirm or reject the items still [PROPOSED] (§2.4).

**Later, at each gate** (the project owner approves; none has passed):

- **Gate 1:** checkpoint approval for `ppo_projected` (arch §11.1).
- **Gate 2:** Phase 1 knowledge population, retrieval-quality evidence, and the decision on P5.
- **Gate 3:** each provider and each scraped site.
- **Gate 4:** the security evidence pack, before first exposure.
