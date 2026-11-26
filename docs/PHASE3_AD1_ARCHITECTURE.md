# AD-1 Part 2: Full Phase 3 Component and Deployment Architecture

**Status:** **DRAFT v0.2**, 26 November 2026. **Not reviewed and not approved.**
**Relationship to the approved component view:** this is an **additive companion** to `docs/PHASE3_AD1_COMPONENT_VIEW.md`, which stays **exactly as approved at v0.5**, with corrections **C-1** and clarification **C-2** as recorded there. The v0.5 approval is **for the D-24 slice only** and is **version-specific**: "any later revision needs fresh review and approval". Revising that file would therefore **suspend the authorization of the D-24 work now in progress**, so the full-Phase-3 architecture is written beside it. **Nothing in v0.5 is edited, superseded or weakened here.** Where the two could be read as disagreeing, **v0.5 wins**.
**What this document is for.** Scope §12 "Remaining during milestone 3.1" item 1 reads: *"Confirm the AD-1 component view §4 placement of later components, which every code milestone 3.2–3.7 waits for (D-22). The D-24-slice approval does not cover it."* This document is the material for that confirmation, in full rather than as the five-row table of v0.5 §4.
**It is not the final AD-1.** The final AD-1 is a wave-4 deliverable that needs every other AD approved or deferred (3.1 plan §4). AD-2, AD-3, AD-7, AD-9 to AD-13 are unwritten, so §13 lists what the final version must still absorb.
**Revision v0.2, 26 November 2026 — still DRAFT and unreviewed.** Applies Nisarga's review of PR #30. The verdicts and findings are **relayed by the project owner, not quoted**: the repository holds no text of the review. Nothing in it approves this document, and no approved decision, contract, threshold, ownership or gate moves. Changes:

- **Blocker 2 fixed:** **new §7.3.1** separates the **D-24 conditions** — `infra/compose.yaml` unchanged, `--profile full` unchanged, nothing published, the inference side of B-4 unenforced under **D-25** — from the **architectural rules** that are permanent. v0.1's "overlays, never edits to `compose.yaml`" read as a permanent prohibition would make **B-4 unclosable**, since inference is a Phase 2 service defined in that file. It states what an **approved** AD-10 change may do, and the three conditions that hold regardless: not under D-24, no Phase 1 or Phase 2 behaviour change, and **Gate 4 evidence rather than a gate pass**.
- §6 item 1 and §7.4 cross-reference §7.3.1; §6 item 5 now records the pending delivery semantics and the provisional capacity envelope.
- **AD1P2-Q5** is restated as the §7.3.1 split rather than a blanket overlay rule.

**Lead:** Dev D (D-21). **Reviewers:** Dev A, Dev B, Dev C (D-22). **Approver:** project owner.
**Scope source:** `docs/PHASE3_SCOPE.md` v1.4 §1.2, §1.3, §3, §5, §6, §7, §9, §11; D-1 to D-25; F-1 to F-6.
**Extends:** `docs/PHASE2_ARCHITECTURE.md` §2, §3, §5. **Relies on:** AD-4 v0.2, AD-6 v0.2 (both approved for D-24 only), and the drafts `PHASE3_AD4_ENVELOPE_PART2.md`, `PHASE3_AD5_ADAPTER_CONTRACT.md`, `PHASE3_AD6_ISOLATION_PART2.md`, `PHASE3_AD8_BUDGETS.md`.

Every statement cites the decision it rests on. Everything else is **[PROPOSED]**. **No gate has passed** (D-18). **No milestone 3.2–3.7 is authorized**, and this document does not authorize one: approval of it satisfies **D-22's component-view condition**, after which each milestone still needs its own deliverables (F-1) and its gates. Nothing here is reachable outside the private development environment (D-16).

---

## 1. Context view

### 1.1 Who and what the system touches

```text
   Named pilot users                  Project owner / operators
   (Phase 2 roles, invited)           (gate decisions, drills, reviews)
            |                                    |
            v                                    v
  +---------------------------------------------------------------+
  |            CBDC Liquidity Router, Phase 3 pilot                |
  |  (one host, containerized, private development environment)    |
  +---------------------------------------------------------------+
       |                     |                          |
       | read-only           | read-only                | NO CONNECTION
       v                     v                          v
  Approved data        Phase 1 artefacts          Real CBDC ledgers,
  providers            (frozen, read-only)        bridges, vaults,
  (Gate 3, each)                                  payment rails, banks
                                                  ===== never =====
```

**[APPROVED]** (D-1, scope §1.2; exit criterion 12) The last column is a **pilot boundary**, not a deferral: no movement of funds, no settlement instruction, no payment message, and no connection to a real CBDC ledger, bridge, vault, payment rail or bank system.

### 1.2 What Phase 3 changes, and what it does not

**[APPROVED]** (D-1) *Phase 3 changes where the data comes from and who may see the answer — it does not change what the routing engine computes.*

| | Phase 2 | Phase 3 adds |
|---|---|---|
| Data | Phase 1 artefacts, scenarios, explicit states | Approved live external **observations**, display-only (D-9) |
| Push | None | An authenticated browser update channel, terminated by Express (F-3) |
| Routing | Simulation-based over the frozen engine | **Unchanged.** Still simulation-based (D-15) |
| Security | Development-only authentication (A-1) | A real identity provider, dev mode removed (A-2), before any exposure (D-6) |
| Operations | Local Compose | Monitoring, tracing, alerting, drills, deployment (scope §3.E) |
| Knowledge | One assumed fact, `StaticMemoryProvider` as the only feasibility authority (A-4) | A quarantine store and a human review queue; **writes need Gate 2** (D-4) |

**[APPROVED]** (D-15) The capability is **"real-time monitoring with simulation-based routing."** Status documents and the UI use that description.

---

## 2. Component inventory

### 2.1 Reused unchanged from Phase 2

**[APPROVED]** (scope §9.1, §11; A-7, A-8) Phase 2 services are **reused, not duplicated**, and scope §11 lists as a non-goal "building a second inference path alongside Phase 2's".

| Component | Role | Changed by Phase 3 |
|---|---|---|
| Inference service (FastAPI) + engine worker pool | All routing logic; stateless and deterministic for a platform and device | **No.** A-8's pool, 10 s execution limit and 12 s deadline stand |
| Phase 1 artefacts | `data/structured`, `processed`, `knowledge`; the approved checkpoint | **No.** Read-only; `phase1-complete` (`bc9905e`) |
| Express application API | Persistence, history, users, audit; the camelCase mapping | **Extended**, never redefined. New routes are additive |
| PostgreSQL via Prisma | Requests, decisions, allocations, audit | **Extended** by AD-11's proposal; no migration until approved |
| React/Vite dashboard | Routing form, results, comparison | **Extended** with an observation panel and pushed status |
| API contract v0.4 | The normative API definition | **No.** Not modified in place; real-time interfaces are added **alongside** it (AD-7) |
| `infra/compose.yaml` | The Phase 2 stack | **No.** Phase 3 adds overlays (§8.3) |

### 2.2 Added by Phase 3

**[PROPOSED]** Placement generalizes v0.5 §4's five rows. Milestones and gates are from scope §7.1 and §5.

| # | Component | Responsibility | Owner | Milestone | Gate | Must not |
|---|---|---|---|---|---|---|
| C-1 | **Ingestion service** (`services/ingestion/`) | Hosts the adapters; assembles, hashes and validates envelopes; publishes to the sink | Dev A (F-2) | Exists (D-24, synthetic) | — | Reach inference, the engine, PostgreSQL or the knowledge base; hold an engine or database credential |
| C-2 | **Provider adapters** (inside C-1) | One per Gate 3-approved provider; transport, normalization, provenance | Dev A | 3.3-L | **Gate 3**, per provider | Contact any host outside its egress allowlist |
| C-3 | **Synthetic adapter and harness** | Seeded generator; fault injection; labelling | Dev D (AD-12) | 3.3-S | — | Be used to train, tune or select a policy |
| C-4 | **Event distribution** | Carries events from C-1 to consumers; validation, ordering, duplicates, late events, idempotency, replay | Dev B / Dev D | 3.4 | — | Interpret an envelope's meaning; reach inference |
| C-5 | **Observation store** | Durable observations, separate from Phase 2 records | Dev B (AD-11) | 3.5, 3.7 | — | Be joinable to transactions, decisions, allocations or comparisons |
| C-6 | **Observation module** (in Express) | Current value per subject; freshness evaluation; terminates the channel | Dev B | Exists (D-24) | — | Import, or be imported by, routing, mapper or inference-client code; write Phase 2 tables |
| C-7 | **Real-time channel** | The authenticated browser channel (F-3); WebSocket or SSE | Dev B (AD-7) | 3.5 | Gate 4 for exposure | Carry an engine input; modify contract v0.4 |
| C-8 | **Observation panel** (React) | Values, labels, age, source; visually distinct from results | Dev C | Exists (D-24) | — | Share state with any form or routing request |
| C-9 | **Routing status push** | Status of a routing request **the user made** | Dev B, Dev C | 3.5 | Gate 1 for `ppo_projected` | Be triggered by an observation (**AD6-Q1**) |
| C-10 | **Displayed-context recorder** | What was displayed when a request was submitted (AD-6 §6.1) | Dev B | 3.5 | — | Enter an engine request, the `decision_id` document, `clientReference`, a cache key or an engine input log |
| C-11 | **Quarantine store** | Valid envelopes withheld pending review or plausibility | Dev D (AD-12) | 3.6 | — | Have an automatic path to the knowledge layer |
| C-12 | **Human review queue** | A named reviewer and a cited source for every item | Dev D, Dev B | 3.6 | **Gate 2** for any write | Write to the knowledge layer without Gate 2 |
| C-13 | **Extraction component** | ScrapeGraphAI or equivalent, if approved | Dev D | 3.6 | **Gate 3**, per site | Be an authoritative source or a compliance decision-maker |
| C-14 | **Identity provider integration** | Replaces development auth; httpOnly cookies, strict CSP | Dev B (AD-10) | 3.2 | Produces Gate 4 evidence | Leave dev mode available |
| C-15 | **Audit trail** | Append-only: input provenance, model version, request, allocation, response | Dev B (AD-11) | 3.2, 3.7 | — | Name an observation as a routing input |
| C-16 | **Observability stack** | Metrics, logs, traces, alerts, health (AD-8 §7) | Dev D, Dev B | 3.7 | Gate 4 for exposure | Join an observation trace to a routing trace |
| C-17 | **Deployment and recovery** | Compose topology, backup, restore, drills | Dev D | 3.7 | **Gate 4** for any exposure | Publish a port beyond loopback before Gate 4 |

### 2.3 The component view, full Phase 3

**[PROPOSED]** The private development environment, one host. Zones are §7's.

```text
  Z0 BROWSER (named pilot user)
   +-- routing form / results -------+      +-- observation panel (C-8) ------+
   |   routing status push (C-9)     |      |   labels, age, source           |
   +---------------------------------+      +---------------------------------+
            |         ^                              ^
            |         | (contract v0.4, unchanged)   | real-time channel (C-7)
            v         |                              |
  ===================== Z1 EDGE: nginx, loopback only before Gate 4 ==============
            |                                        |
            v                                        v
  Z2 APPLICATION: Express
   +----------------------------+        +------------------------------------+
   | routing, mapper,           |  ##no##| observation module (C-6)           |
   | inference client           |  ##IMPORT##  freshness, current value       |
   | identity (C-14), audit     |  ##path##    channel termination            |
   +----------------------------+        +------------------------------------+
        |              |                            ^            |
        | Prisma       | HTTP/JSON                  | consume    | context (C-10)
        v              v                            |            v
  Z3 DATA           Z4 ENGINE                   Z5 OBSERVATION PATH
   +-----------+   +------------------+     +--------------------------------+
   | Phase 2   |   | FastAPI + engine |     | distribution (C-4)             |
   | records   |   | worker pool      |     |      ^                         |
   | audit(C15)|   |      |           |     |      | sink                    |
   | obs store |   |      v read-only |     | ingestion (C-1)                |
   | (C-5)     |   | Phase 1 artefacts|     |  adapters (C-2) | synthetic(C-3)|
   | quarantine|   | (frozen)         |     |  quarantine (C-11)             |
   | (C-11)    |   +------------------+     +--------------------------------+
   +-----------+                                     |  egress allowlist only
                                                     v
                                            approved providers (Gate 3)

  ########## NO OBSERVATION CROSSES FROM Z5 INTO Z4 (AD-6) ##########
  Z6 OPERATIONS: observability (C-16), deployment and recovery (C-17)
```

**Two things this picture is meant to make obvious.** First, **Z4 has no inbound arrow from Z5**: that is AD-6's rule as a shape, not a convention. Second, **Express spans the divide**, holding modules in both paths, which is why it is "the single point that keeps them apart" (v0.5 §5 item 2) and why B-3's import checks are load-bearing rather than stylistic.

---

## 3. Service responsibilities

### 3.1 The responsibility rule, extended

**[APPROVED]** (Phase 2 arch §2) One rule: **routing logic lives only in the inference service, and application state lives only in the backend.**

**[PROPOSED]** Phase 3 adds a second, orthogonal one: **observation logic lives only in the ingestion service and the observation module, and never in a routing module.** The two rules together give four quadrants, and every component in §2.2 sits in exactly one.

| | Routing path | Observation path |
|---|---|---|
| **Compute** | Inference service + engine pool (unchanged) | Ingestion service (C-1 to C-3) |
| **State and delivery** | Express routing, mapper, Prisma (extended) | Express observation module (C-6), distribution (C-4), store (C-5) |

### 3.2 Per-service responsibility split

**[PROPOSED]** Extending Phase 2 arch §2's table with an observation column. **Every cell in the inference column is "No"**, which is AD-6 §2's table restated as responsibilities.

| Concern | Inference | Express | Ingestion | Web |
|---|---|---|---|---|
| Feasibility, allocation, execution, metrics | **Yes** | No | **No** | No |
| Bridge state for a date, scenario or explicit spec | **Yes** | Passes through | **No.** It has no bridge-state event type | Displays with its Phase 2 label |
| Policy selection and defaulting | **Yes** | Passes through after the role check | **No** | Chooses, within the role |
| Persistence, history, analytics | No | **Yes** | **No** | No |
| Users, auth, audit | No | **Yes** (C-14, C-15) | **No.** Holds no credential | Holds a session, never a provider credential |
| Adapter lifecycle, transport, backoff, breaker | No | No | **Yes** (AD-5 §3) | No |
| Envelope assembly, hashing, provenance | No | **Re-validates, never assembles** | **Yes** | **Re-validates, never assembles** |
| Freshness evaluation and thresholds | No | **Yes**, on the server clock (v0.5 §3.3) | Supplies the profile | Advances age by **monotonic** time only |
| Source status | No | Relays as **content** | **Decides** (AD-5 §9) | Displays, separately from "disconnected" |
| Display labels | No | Supplies the inputs | No | **Applies AD-4 §8.1**, first match wins |
| Channel termination and authentication | No | **Yes** (F-3) | **No** | Client |
| Observation storage and retention | No | **Yes** (C-5, AD-11) | **No** | No |
| Knowledge-layer writes | No | No | **No** | No |

**The last row is "No" four times, deliberately.** Knowledge writes need **Gate 2** (D-4), and feasibility comes only from `StaticMemoryProvider` (A-4). No Phase 3 component may write to the knowledge layer until Gate 2 passes, so there is no component to assign it to yet.

### 3.3 Why ingestion is a separate service

**[APPROVED]** (F-2) A separate Python ingestion component, owned by Dev A, outside the inference service and outside Express request handling.

**[PROPOSED]** The reasons, so the decision survives a future refactor proposal:

1. **It is the only component that touches untrusted external input.** Keeping it separate means a provider's malformed or hostile response is contained in a process that holds no credential, no database handle and no engine artefact.
2. **It is the component that will acquire outbound network access.** A process boundary is where an egress allowlist can be enforced (AD-5 §12.1; AD-10).
3. **Its lifecycle is not a request lifecycle.** Adapters are long-lived, with backoff, breakers and schedules; Express request handling is not the place for them (F-2).
4. **It must be killable without affecting routing.** AD6-Q2 requires that an observation outage never block routing; a separate process makes that structural rather than careful.
5. **It must not be able to import engine code.** A separate service with its own dependency set makes B-3 enforceable at the package level, not only by lint.

---

## 4. Interactions

### 4.1 Steady state: an observation reaches a user

**[PROPOSED]** The T-points are AD-8 §2.2's.

```text
 provider/generator -> adapter (C-2/C-3)         [T0 source_timestamp]
   -> ingestion: assemble, hash, validate        [T1 retrieved_at, T2 emitted_at]
   -> sink: observations channel
   -> distribution (C-4)                         [T3]
   -> Express observation module (C-6):
        RE-VALIDATE independently (AD-4 Part 2 §5.1 V-1..V-5)
        order by source_timestamp; dedup; current value per subject  [T4]
        evaluate freshness on the server clock
   -> real-time channel (C-7): snapshot | update | heartbeat          [T5]
   -> observation panel (C-8): label, age, source                    [T6]
```

**Invariants:** `usage: display_only` throughout (B-1); the envelope travels **unmodified** inside the channel message (v0.5 §3.2); **nothing in this chain touches Z4**; and the whole chain can fail at any point with no effect on routing (**AD6-Q2**).

### 4.2 A user requests a route

**[PROPOSED]** Unchanged from Phase 2, which is the point.

```text
 form (Z0) -> Express /api/v1 -> FastAPI /v1 -> engine pool -> response
   -> Express: persist, audit (C-15) -> result view
   -> in parallel, never as an input: C-10 records what was displayed
   -> C-9 pushes the status OF THIS REQUEST
```

- **No observation enters the request.** Contract v0.4 requests are strict, so an undeclared field returns `422 VALIDATION_ERROR` (B-2) — and B-2 stops new fields, **not** an observed value placed in a valid field, which is why B-3 and B-8 exist.
- **C-10 points to the transaction, never the reverse.** A missing or failed context record neither blocks nor rolls back the routing record or its audit row, whose atomic write is unchanged (AD-6 §6.1).
- **C-9 pushes status for a request the user made**, never a routing run triggered by an event (**AD6-Q1**).
- `engineResponse` stays verbatim; `decision_id`, `id_scheme` and `engine_version` are untouched (AD-6 §5).

### 4.3 Provider onboarding

**[PROPOSED]** AD-5 §2.3's O-1 to O-6. The architectural point is the **order**: C-2 is written and tested against C-3's harness long before a provider is contacted, and **O-5 and O-6 are blocked on Gate 3** — including for a recorded sample or fixture (D-17).

### 4.4 An announcement reaches the knowledge layer — or does not

**[PROPOSED]**

```text
 announcement -> C-1 validate -> REVIEW_REQUIRED -> QUARANTINE (C-11)
   -> review queue (C-12): a named reviewer, a cited source
        |                                  |
        v refuse                            v approve
   recorded, no write              ===== GATE 2 =====
                                           |
                                   knowledge layer write
                                   (verified: true only for checked real_* sources)
```

**[APPROVED]** Nothing reaches the knowledge base without a named reviewer and a cited source; **writes need Gate 2** (D-4); the knowledge base currently holds **one** fact, the assumed $500K cap, `verified: false`; letting dated or corridor-scoped facts affect feasibility needs an **approved environment change** (A-4); and the generator's $500K cap must equal the knowledge-base cap, which a test enforces.

**Before Gate 2, the whole left half runs on synthetic announcements** and the Gate 2 arrow does not exist (scope §6). The 3.6-S exit is "the review flow works end to end on synthetic items, with no automatic write".

### 4.5 Degradation

**[PROPOSED]** Every path degrades independently; AD-9 specifies what is shown.

| Failure | Observation panel | Routing |
|---|---|---|
| Provider outage | Values age: stale, then Unavailable with no number. Source `outage` shown | **Unaffected** |
| Ingestion down | As above, plus the source status | **Unaffected** |
| Distribution down | As above | **Unaffected** |
| Express down | Client reconnects within the AD-8 §3.4 target | Down, by Phase 2's own behaviour |
| Channel lost | Values stay, ages advance; "disconnected" shown separately from source outage | **Unaffected** |
| **Inference down** | **Unaffected** — "an inference failure does not hide observations" (AD-6 §6) | Phase 2 error semantics |

**An observation outage never causes a routing refusal.** Scope §3.D's last-resort "refuse to route rather than route on unlabelled data" **does not apply** to observation outages (**AD6-Q2**); refusals come only from the existing engine and contract conditions, or from a routing value without its own label (AD-6 §6).

---

## 5. Trust boundaries

**[PROPOSED]** Six zones. Rows generalize v0.5 §2's three.

| # | Zone | Holds | Trusts |
|---|---|---|---|
| **Z0** | Browser | Session, rendered values | Nothing. A browser's report of what it displayed is **a claim, not proof** (AD-6 §6.1) |
| **Z1** | Edge (nginx) | TLS termination, proxying | Z0 as untrusted |
| **Z2** | Application (Express) | Sessions, authorization, persistence, channel | Z1 as untrusted; **Z5 as untrusted** |
| **Z3** | Data (PostgreSQL) | Phase 2 records, audit, observations, quarantine | Z2 only, by role |
| **Z4** | Engine (FastAPI + pool + Phase 1 artefacts) | All routing logic | Z2 only. **No inbound path from Z5** |
| **Z5** | Observation path (ingestion, adapters, distribution) | Provider credentials only | Providers as untrusted; holds no engine or database credential |
| **Z6** | Operations (observability, deployment) | Metrics, logs, traces, backups | Z2 to Z5 as data sources; **never a control input to routing** |

### 5.1 Boundary controls

| Boundary | Control | Status |
|---|---|---|
| Z0 to Z1 | **Gate 4**: identity provider, httpOnly cookies, strict CSP, authorization, rate limits, encryption in transit (A-2, D-6) | **Not passed.** Development-only auth today (A-1) |
| Z1 to Z2 | Existing bearer token in the `Authorization` header, **never in a URL**; loopback only (v0.5 §2) | Enforced for the slice |
| Z2 to Z3 | Prisma, least-privilege roles. **The ingestion role cannot write Phase 2 tables** (B-5) | Specified only; AD-11 |
| Z2 to Z4 | Contract v0.4, strict requests (B-2); internal network only | Enforced (Phase 2) |
| **Z5 to Z2** | **Untrusted input**, strictly validated and bounded; independent re-validation (AD-4 Part 2 §5.1); unauthenticated, isolated by network | Enforced for the slice (v0.5 §2, §3.1, §3.4) |
| **Z5 to Z4** | **No path.** Network, import checks, non-interference tests (B-3, B-4, T-1 to T-4) | **Ingestion side enforced; inference side NOT** (§6) |
| Z5 to providers | Egress allowlist per adapter; TLS verified; no redirects (AD-5 §12) | **Specified only.** AD-10 |
| Z6 to all | Read-only collection; **no alert wired to a routing action** (AD-8 §7.3) | Specified only |

---

## 6. Known gaps

**[APPROVED]** (scope D-25; v0.5 §5 item 1; AD-6 status line)

1. **Inference outbound-network isolation: exception granted, requirement UNRESOLVED.** AD-6 **B-4** also says inference has no route to the internet. The Phase 2 stack does not enforce that, and the D-24 slice delivers only the **ingestion** side. The owner granted an exception **for the D-24 slice only**, recorded as **D-25**.
   - It does **not** satisfy B-4, which stays **unresolved** and is closed by **AD-10**, whose exposure plan must state how inference egress is controlled. The D-24 overlay does not isolate inference, and `--profile full` is unchanged.
   - It does **not** extend past the slice: no later milestone or component gets it.
   - It is **not Gate 4 evidence, and no gate has passed** (D-6, D-18).
   - **T-5 is limited to the ingestion side**; the inference side is **not run and not claimed**, so **AD-6 must not be described as fully enforced**.
   - **A live adapter makes B-4 harder**, because ingestion then acquires outbound access that it does not have today (`PHASE3_AD6_ISOLATION_PART2.md` §3).
   - **Closing it needs a change the D-24 overlay cannot express**, because inference is a Phase 2 service defined in `infra/compose.yaml`. **§7.3.1** separates the D-24 condition that forbids that change from the architectural rules that do not, so that B-4 is closable once AD-10 is approved.

**[PROPOSED]** The rest, carried forward or added:

2. **Express spans Z2 and Z5**, so it is the single point keeping them apart (v0.5 §5 item 2). B-3's import checks and T-16 are the controls.
3. **The web API client cannot carry a stream**; `createApiClient` and `ApiClient` are **unchanged**, and the additive `openObservationStream` on `AuthContextValue` is the only new path that sends the token (v0.5 §5 item 3). C-7 must keep that property.
4. **About 6 HTTP/1.1 connections per origin**, so tabs compete with ordinary requests; the cap of 3 per user limits it (v0.5 §5 item 4; AD-8 §6.3).
5. **No durability or replay is decided**, so C-4 is a poll today and observations have no recovery-point objective (AD-2, AD-3; AD-8 §8.1). The **delivery semantics** are pending — at-least-once versus at-most-once, the handoff point, acknowledgement, the replay window and slow-consumer behaviour (AD-5 §3.7 **H-1 to H-6**) — and **AD-8 §6.2's capacity envelope is provisional**, with AD-2's requirement unwritten and a reconciliation rule in AD-8 §6.2.1.
6. **No provider is approved**, so C-2 and C-13 cannot be exercised end to end. **Gate 3**, per provider and per site.
7. **Phase 2 open items remain open** (scope §2.2.1): the OpenAPI files are **DRAFT** with contract v0.4 normative; the inference response-size limit; Q20 the fixture-backed mock mode; F1 the Phase 1 cost-baseline unit; the provisional `AuditLog` values; the remaining fixture coverage.
8. **No CODEOWNERS file exists**, so ownership is a team agreement and is **not enforced** (3.1 plan §5).
9. **Every Phase 1 §4.2 restriction still binds the UI**: no composite "best route" score without a placeholder-weights label; no reward or unrouted figure from the environment's accounting; no claim that routing quality holds under current conditions; raw PPO never served; stress described as uniform multipliers.
10. **The final AD-1 is not written** (§13).

---

## 7. Deployment architecture

### 7.1 Target class

**[APPROVED]** (F-6) Local Docker development first; the design targets a **controlled, single-host, containerized pilot**, with **no external exposure before Gate 4**. No specific host has been chosen; deployment belongs to milestone 3.7 (scope §10.1 item 4).

**[PROPOSED]** The consequences, stated so they are not discovered later:

- **No redundancy, no failover, no multi-host operation.** AD-8 §6.1's targets reflect that, and claiming otherwise would breach exit criterion 8.
- **One PostgreSQL server**, holding Phase 2 records, the audit trail, observations and quarantine — **logically separated**, not physically (B-7, AD-11).
- **Vertical scaling only.** The engine pool's sizing is Phase 2's (A-8) and is not revisited.
- **Backup and restore are host-level**, exercised as drill R-5 (AD-8 §8.3).

### 7.2 Environments

**[PROPOSED]**

| Environment | What it is | Gate 4 | Live providers |
|---|---|---|---|
| **Developer machine** | Loopback or a private Compose network. **This is the private development environment** (A-1, D-16) | Not needed | Only after that provider's Gate 3 |
| **Pilot host** | One controlled host, named pilot users | **Required** | Gate 3 per provider |
| ~~Shared staging~~, ~~LAN~~, ~~tunnel~~, ~~public demo URL~~ | **Each requires Gate 4** (D-16) | **Required** | — |

**[APPROVED]** (A-1, D-16) The private development environment is a developer's machine, with services on host loopback or a private Compose network. **Anything else needs Gate 4**, explicitly including a shared staging host, LAN access, a tunnel, a public demo URL, and any cloud or remote host.

### 7.3 Compose topology

**[PROPOSED]** Additive overlays, following the pattern `infra/compose.observations.yaml` establishes, whose header states that `compose.yaml` is **not** changed and that `--profile full` alone never needs ingestion. §7.3.1 states exactly how far that goes, because the restriction has two different sources and only one of them is permanent.

| File | Adds | Status |
|---|---|---|
| `infra/compose.yaml` | The Phase 2 stack | **Unchanged by Phase 3** |
| `infra/compose.observations.yaml` | Ingestion + the internal `observations` network; turns the feature on | **Exists** (D-24) |
| `infra/compose.observations-test.yaml` | The test-only fake ingestion | **Exists** |
| *(3.4)* distribution overlay | C-4 and its network | Proposed; needs AD-3 |
| *(3.2)* identity overlay | C-14 | Proposed; needs AD-10 |
| *(3.7)* operations overlay | C-16 | Proposed |

**Rules, generalizing v0.5 §3.6:** off by default, so nothing is read unless the file is passed; **separate image tags**, so building an overlay never replaces `cbdc-backend:local` or `cbdc-web:local`; **no published port**, no secret, no `env_file`, no volume added by an overlay; and **no `depends_on`** from a Phase 2 service to a Phase 3 one, so the Phase 2 stack starts and passes its checks with every overlay absent.

#### 7.3.1 Where "overlay only" is a D-24 condition and where it is an architectural rule

**This distinction matters because closing AD-6 B-4 will require changing inference's networking, and inference is defined in `compose.yaml`.** Read as a permanent prohibition, the overlay rule would make B-4 unclosable — which is not what any approved decision says.

| Restriction | Source | Permanent? |
|---|---|---|
| **`infra/compose.yaml` is not changed**, `--profile full` is unchanged, nothing is published, no secret, `env_file` or volume is added, the feature is off by default | **A D-24 condition.** Scope §2.2.2 requires the slice to change neither "Phase 1 and 2 behaviour, API contract v0.4, the existing Docker stack (`infra/compose.yaml`)" nor Gates 1–4 | **No.** It binds the **D-24 slice** |
| **The D-24 overlay does not isolate inference**, so B-4's inference side is unenforced | **D-25**, a waiver of enforcement for the D-24 slice only (§6 item 1) | **No**, and it is not a design choice: it is a recorded gap |
| **A Phase 2 service gains no `depends_on` to a Phase 3 one**; the Phase 2 stack starts and passes its checks with every Phase 3 overlay absent | **An architectural rule** proposed here, so that Phase 3 cannot make Phase 2 unrunnable | **Yes**, unless the owner replaces it |
| **Phase 3 components are added, not substituted:** no second inference path, no replacement engine pool, API contract or persistence model unless a measured requirement forces it | Scope §11 non-goals | **Yes** |
| **Nothing is reachable outside the private development environment** | **D-6, D-16, D-18.** A **gate**, not a file convention | **Yes, until Gate 4 passes** |

**What an authorized B-4 change may therefore do.** When **AD-10** is approved and milestone 3.2 is authorized, closing B-4 is expected to require changes the D-24 overlay cannot express, because the services to be constrained are Phase 2's:

1. **Give inference an explicit network** instead of the implicit `default`, so it has no route to distribution, the observation store or the internet. Naming any network removes the implicit `default`, so this is necessarily a change to the inference service's own definition.
2. **Remove or constrain inference's outbound path**, which today exists because nothing restricts it.
3. **Add least-privilege database roles** (B-5), which touches Phase 2's connection configuration.

Each of those is a change to `infra/compose.yaml` or to a Phase 2 service's configuration. **That is permitted once, and only once, the change is approved** — by AD-10's approval and the authorization of its milestone — because the restriction forbidding it is **D-24's**, and D-24 governs the slice, not Phase 3. Three conditions hold regardless:

- **It is not done under D-24.** D-25 "extends to no later milestone or component", and the slice's own conditions stay as approved while the slice runs.
- **It changes no Phase 1 or Phase 2 *behaviour*.** Constraining a network is not a behavioural change to routing; T-1, T-6 and T-7 must pass unchanged across it, and the existing Compose and stack-security checks must pass.
- **It passes no gate by itself.** It is **Gate 4 evidence**, assembled inside the private development environment and reviewed before any exposure (scope §5; §7.7).

**Until then, B-4 stays unresolved** (§6 item 1), and **AD-6 must not be described as fully enforced**.

### 7.4 Networks

**[PROPOSED]** Extending v0.5 §3.6, whose `observations` network is `internal: true` with **isolated gateway mode** (`com.docker.network.bridge.gateway_mode_ipv4: isolated`, Docker Engine 28.0.0+, IPv6 off) — because `internal: true` alone left the host gateway reachable and the T-5 probe found a host listener through it.

| Network | Members | Internal | Why |
|---|---|---|---|
| `default` | web, backend, inference, postgres | No | Phase 2, unchanged |
| `observations` | **backend, ingestion** only | **Yes**, isolated gateway | Ingestion has no path to inference or PostgreSQL (B-4, ingestion side) |
| *(3.4)* `distribution` | backend, ingestion, distribution | **Yes** | C-4 is reachable from neither inference nor the internet |
| *(3.3-L)* egress | ingestion only, allowlisted | No, but **allowlisted** | C-2 needs outbound access; **AD-10** |

- **The backend lists both networks**, because naming any network removes the implicit `default`; **Express forwards nothing between them** (v0.5 §3.6).
- **Residual, accepted:** ingestion can open the backend's port 4000 on the shared network. It holds no token, so protected routes return 401 (v0.5 §3.6, §5).
- **Inference joins no observation network, and needs no egress** (§6 item 1). Giving it an explicit network, so that B-4's inference side is actually enforced, is an **authorized AD-10 change to `compose.yaml`**, not an overlay (§7.3.1). It is not done under D-24.

### 7.5 Runtime posture

**[PROPOSED]** Every Phase 3 container keeps the posture the D-24 overlay applies to ingestion: non-root (`10001:10001`), `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges:true`, `pids_limit`, `mem_limit`, `cpus`, no published port, no `env_file`, no volume, `restart: "no"`.

A provider adapter changes exactly one thing — outbound access to allowlisted hosts — and that change belongs to **AD-10** (AD-5 §12.1).

### 7.6 Configuration and secrets

**[PROPOSED]** The environment only, with no `.env` loaded — the rule `services/ingestion/cbdc_ingestion/settings.py` already applies, where an unparsable value is a **startup failure, not a silent default**, because "a component that quietly ran on a different seed would make its own events irreproducible". The same discipline applies to the source registry (AD-5 §2.1).

**[APPROVED]** (root `CLAUDE.md`; scope §4.E) No secret, credential, private key, service-account JSON, `.env` file or access token in source control or a handover document. Development tokens live in a git-ignored `dev-tokens.json` of SHA-256 hashes and are **replaced** at milestone 3.2 (A-2).

### 7.7 Exposure sequencing

**[APPROVED]** (scope §7.2) Exposure order matters more than feature order: milestone **3.2** and the **3.7 private-environment items** produce the Gate 4 evidence, which the owner reviews **before first exposure** (scope §5, Gate 4).

```text
 3.2 security baseline ----+
                           +--> Gate 4 evidence pack --> owner review --> exposure to pilot users
 3.7 private-env items ----+
```

Until then, **everything runs on a developer's machine, on loopback or a private Compose network** (D-16).

---

## 8. Component to milestone, deliverable and gate

**[PROPOSED]** The traceability table a reviewer needs to check that nothing is assumed authorized. **Every row's milestone also requires the AD-1 component view** (D-22), and **no gate has passed**.

| Component | Milestone | Required 3.1 deliverables (scope §7.1) | Gate |
|---|---|---|---|
| C-1 ingestion | Exists (D-24); 3.3 | AD-4, AD-5, AD-12 | — |
| C-2 provider adapters | 3.3-L | AD-4, AD-5, AD-12 | **Gate 3**, per provider |
| C-3 synthetic harness | 3.3-S | AD-12 | — |
| C-4 distribution | 3.4 | AD-2, AD-3 | — |
| C-5 observation store | 3.5 | AD-6 to AD-9; AD-11 for the model | — |
| C-6 observation module | Exists (D-24); 3.5 | AD-6 to AD-9 | — |
| C-7 real-time channel | 3.5 | AD-7 (and AD-10, which AD-7 needs) | Gate 4 for exposure |
| C-8 observation panel | Exists (D-24); 3.5 | AD-9 | — |
| C-9 routing status push | 3.5 | AD-7 | **Gate 1** for `ppo_projected` |
| C-10 context recorder | 3.5 | AD-7 (capture), AD-11 (storage) | — |
| C-11 quarantine store | 3.6 | AD-12 | — |
| C-12 review queue | 3.6 | AD-12 | **Gate 2** for any write |
| C-13 extraction | 3.6 | AD-12 | **Gate 3**, per site |
| C-14 identity provider | 3.2 | **AD-10** | Produces Gate 4 evidence |
| C-15 audit trail | 3.2, 3.7 | AD-11 | — |
| C-16 observability | 3.7 | AD-8, AD-11 | Gate 4 for exposure |
| C-17 deployment, recovery | 3.7 | AD-8, AD-10 | **Gate 4** for exposure |

**Earliest starts, from the 3.1 plan §4 waves:** milestone **3.2** after wave 2 (AD-10), and **3.3** after wave 3 (AD-12) — in both cases only once this component view's placement is confirmed and those deliverables are approved.

---

## 9. What approving this document does and does not do

**[PROPOSED]**

**Does:** confirm the placement of later components, which is scope §12 item 1 and the condition **D-22** attaches to every code milestone 3.2–3.7; give AD-10 its required input (3.1 plan §3, where AD-10 needs the component view); and fix the zone model, the responsibility split and the deployment class for the ADs still to be written.

**Does not:**

- **authorize any milestone.** Each still needs its own F-1 deliverables and its gates (§8);
- **pass any gate.** **No gate has passed** (D-18), nothing is reachable outside the private development environment (D-16), and no exposure, staging host, LAN access, tunnel or demo URL is permitted (D-6);
- **resolve AD-6 B-4** (§6 item 1), which stays unresolved and is closed by **AD-10**;
- **change the D-24 slice**, which continues on the approved v0.5, AD-4 v0.2 and AD-6 v0.2 under D-25's limits;
- **approve any other deliverable.** AD-2, AD-3, AD-7, AD-9 to AD-13 remain unwritten; AD-5, AD-8 and the Part 2 companions are drafts;
- **change any exit criterion, milestone dependency or gate**;
- **exit milestone 3.1**, which needs every AD approved or explicitly deferred, AD-3 recorded as the roadmap §6 streaming decision, and the approvals recorded in scope §2 (3.1 plan §7);
- **approve a provider, a site, a checkpoint or a knowledge write.**

---

## 10. Questions for the project owner

| # | Question | Draft position | Decides |
|---|---|---|---|
| AD1P2-Q1 | Is the **§2.2 component inventory and its placement** confirmed, satisfying scope §12 item 1 and **D-22** for milestones 3.2–3.7? | Yes. It is v0.5 §4's five rows expanded, with no new capability | Owner, after Dev A, B and C review (D-22) |
| AD1P2-Q2 | Is the **§5 six-zone trust model** adopted, extending v0.5 §2's three boundaries? | Yes | Owner |
| AD1P2-Q3 | Is **§3.1's second responsibility rule** adopted — observation logic only in ingestion and the observation module? | Yes. It makes B-3 a rule rather than a lint | Owner, with Dev B |
| AD1P2-Q4 | Is **§7's deployment architecture** — one host, overlays only, no redundancy, one PostgreSQL server with logical separation — adopted as the target, with §7.1's limitations stated? | Yes (F-6) | Owner, with Dev D |
| AD1P2-Q5 | Is **§7.3.1's split** adopted — that "`compose.yaml` is not changed" is a **D-24 condition**, while "no Phase 2 service gains a `depends_on` to a Phase 3 one" and "components are added, not substituted" are **architectural rules** — so that an **approved** AD-10 change may modify inference's networking to close B-4? | Yes. Read as permanent, the overlay rule would make **B-4 unclosable**, which no approved decision says | Owner, with Dev D |
| AD1P2-Q6 | Does confirming §2.2 **also** confirm the §8 deliverable and gate mapping, or is that a separate record? | Confirm them together: a placement without its gates could be misread as an authorization | Owner |
| AD1P2-Q7 | Should **CODEOWNERS** be created, covering `docs/PHASE3_*.md`, `services/ingestion/` and `contracts/events/`? | Recommended by the 3.1 plan §5, and **not part of this document** | Owner, with Dev D |

---

## 11. Review reconciliation

**[PROPOSED]** The repository holds no text of any review, and this document has had none. The table records where each **required** topic is addressed, so reviewers can find their areas. "Addressed" means **drafted here, not accepted**.

| Topic | Addressed in |
|---|---|
| Full component inventory, responsibilities, owners | §2.2, §3.2 |
| Context view, actors, external systems | §1.1 |
| Trust boundaries and zones | §5 |
| Interactions, steady state and degradation | §4 |
| Deployment architecture, environments, networks, posture | §7 |
| Phase 2 reuse without duplication | §2.1, §3.1 |
| Milestone, deliverable and gate traceability | §8 |
| **B-4 and D-25** | §6 item 1; `PHASE3_AD6_ISOLATION_PART2.md` §3 |
| Knowledge path and Gate 2 | §4.4 |
| Provider onboarding and Gate 3 | §4.3; `PHASE3_AD5_ADAPTER_CONTRACT.md` §2 |
| Latency, freshness, monitoring, recovery | `PHASE3_AD8_BUDGETS.md` |
| Event identity, hashing, validation, compatibility | `PHASE3_AD4_ENVELOPE_PART2.md` |
| What approval does and does not do | §9 |

---

## 12. Approval checklist

**None of these is given. This document is DRAFT v0.1 and has not been reviewed.**

- [ ] **Dev A** — review: §2.2 C-1 to C-3; §3.3's reasons for a separate service; §7.4 and §7.5 for ingestion; §6 item 1
- [ ] **Dev B** — review: §2.2 C-4 to C-7, C-10, C-14, C-15; §3.1's second rule; §5.1's Z2 rows; §7.3's overlay rule
- [ ] **Dev C** — review: §2.2 C-8, C-9; §3.2's web column; §4.5's degradation display; §6 items 3 and 4
- [ ] **Project owner** — approval, with §10's questions decided. **D-22 requires review by Dev A, B and C before this approval**
- [ ] **Second-reviewer rule (D-20)** — the lead is Dev D, not the owner, so D-20 does not bind here; the three reviews above are required by D-22 regardless

On approval, the decision is recorded in `docs/PHASE3_SCOPE.md` §2 and the 3.1 plan is updated (3.1 plan §5). **No gate passes. No milestone starts without its own deliverables. B-4 stays unresolved. AD-6 is not fully enforced.**

---

## 13. What the final AD-1 must still absorb

**[PROPOSED]** The final AD-1 is wave 4 and needs every other AD approved or deferred (3.1 plan §4). It must absorb:

| From | What |
|---|---|
| **AD-2, AD-3** | The distribution mechanism, replacing C-4's placeholder and the slice's poll; durability, replay and the recovery-point objective |
| **AD-7** | The WebSocket or SSE choice, message schemas, channel authentication, reconnect and resync; C-10's capture |
| **AD-9** | What is displayed at every freshness, outage and fallback state |
| **AD-10** | The threat model, identity provider, secrets, egress enforcement, rate limits, the Gate 4 checklist — **and B-4** |
| **AD-11** | The observation store, the audit trail, retention, and the database-role half of **AD6-Q5** |
| **AD-12** | The harness, fault injection, the quarantine and review flow |
| **AD-13** | The test strategy and one evidence template per gate |
| **AD-5, AD-8, and the Part 2 companions** | Whatever the owner approves of them |
| **This document** | §2 to §8, as approved |

Until then, **this document is the component view for full Phase 3, and `docs/PHASE3_AD1_COMPONENT_VIEW.md` v0.5 remains the approved component view for the D-24 slice.**
