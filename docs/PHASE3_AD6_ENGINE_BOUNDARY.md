# AD-6: Live-Data-to-Engine Boundary

**Status:** **DRAFT v0.2**, 24 November 2026. **Not approved by the project owner.** Dev B and C approved it in the D-24 review; this is recorded as reviewer feedback only (AD-1 §8). v0.2 applies the owner decisions in §9.1; they settle those points, but do not approve the document.
**Lead:** Dev A. **Reviewers:** Dev B, Dev C. **Approver:** project owner. Dev A is also the approver, so the second-reviewer rule (D-20) applies.
**Scope source:** `docs/PHASE3_SCOPE.md` v1.2 §1.3, §4.2, §7.3; D-1, D-9, D-15; A-3 to A-8.
**Feeds:** AD-9; milestone 3.5.

This document records D-9, D-15 and the owner decisions AD6-Q1 to Q4 (§9.1), and **proposes** how to enforce them. It changes no engine code, no Phase 1 file and nothing in API contract v0.4.

## 1. The rule

> **No observation may influence an engine request or an engine result.**

- **Approved** (D-9, D-15): observations are display and context only. The initial capability is "real-time monitoring with simulation-based routing".
- **Observation** means any AD-4 event and anything computed from one, whatever its class. Synthetic events follow the same rule, so tests exercise the real boundary.
- **Influence** covers the value, the choice and the timing:
  - supplying, defaulting or pre-filling a request field;
  - choosing the corridor, amount, date, scenario, policy or state mode;
  - triggering, repeating, delaying or blocking a routing request;
  - changing, re-ranking or annotating the fields of a result.

**Decided** (AD6-Q1): live events never trigger routing. **Proposed:** the same for synthetic events, and the remaining choice and timing rules above.

## 2. What the engine may read

| Input | Source | Open to observations? |
|---|---|---|
| Corridor, amount | The user's request | No |
| State mode | `historical_replay`, `scenario` or `explicit` (contract §2.4), unchanged | No |
| Dates | The user's request, limited to 2011-01-01 to 2025-09-30 minus the gap buffers | No |
| Liquidity, congestion, 30-day history | Phase 1 simulation, a Stage 1F scenario, or the user's explicit values | No |
| Venues, fees, tags | `bridge_network.csv` | No |
| Corridor risk | Phase 1 proxy at the reference month | No |
| Cost baseline | Lagged RPW at the reference date | No |
| Feasibility | `StaticMemoryProvider` only (A-4) | No |
| Policy | `waterfall` (default), `cheapest_feasible`; `ppo_projected` only after Gate 1 (D-10) | No |
| Reward weights, normalization statistics, checkpoint | Frozen artefacts | No |

Every row is "No". Bridge liquidity and congestion stay simulated or user-supplied.

## 3. Why

- **The engine has no valid place for them.** It accepts no date after 2025-09-30, and cost baseline and risk cannot be overridden (A-6). A current FX rate has no defined mapping to either.
- **A forced mapping would be false.** FX and news do not measure bridge liquidity or congestion (roadmap §4.A).
- **There is no evidence.** No independent out-of-time data exists, so routing quality under current conditions is unmeasured (scope §4.2).
- **PPO is not a safe consumer.** It barely responds to liquidity on its own (`docs/STAGE1F_RESULTS.md`).
- **Feasibility is deterministic.** Knowledge is never a PPO input, and dated facts cannot affect feasibility without an approved environment change (A-4).

## 4. Allowed and forbidden flows

```text
 Sources --> Ingestion --> Distribution --> Observation store
                                                 |
                                                 v
                                         Express update channel --> Browser: observation panel

 ============ no observation crosses this line ==================================

 User input --> Browser: form --> Express /api/v1 --> FastAPI /v1 --> engine pool
                Browser: result <------ (contract v0.4, unchanged) <------+
```

The two paths share the browser, Express and possibly the PostgreSQL server. AD-1 decides the components; the separation holds wherever they run.

**Allowed:**

- showing observations beside routing results, each with its own label and timestamps;
- filtering or sorting the observation panel itself;
- pushing the status of a routing request the user made;
- recording which observations were displayed, under §6.1;
- operational health shared by the host, such as rejecting work under overload, provided the content of an observation plays no part.

**Forbidden, including the indirect routes:**

| Forbidden | Why it needs saying |
|---|---|
| Converting a typed amount into `amountUsd` with an observed FX rate | It looks like a UI helper, but it sets an engine input |
| Pre-filling explicit liquidity or congestion, or a "use live value" control | It makes an observation look like bridge state |
| Choosing a scenario because of an event ("market stress detected") | Control influence; the scenarios are uncalibrated multipliers |
| Automatic routing or re-routing when an event arrives (AD6-Q1) | It makes routing live in effect |
| Converting a routing result with live FX (AD6-Q4), or adjusting a fee, reward, completion or ranking with an observed rate | It mixes simulated and observed values in one number |
| Blocking or warning on a corridor because of a holiday or announcement | It acts on unverified text as if it were a compliance decision (roadmap §4.C) |
| Using `clientReference` to carry observation data | It is persisted and echoed with the decision |
| Writing events into `data/`, `outputs/`, the knowledge base or any engine artefact | It changes engine inputs and fingerprints |
| Training, tuning or selecting a policy with observations | Outside D-9; scope §6 and §9.2 |

**Manual re-typing.** A user can read an observation and type a number into an explicit state. That cannot be prevented. The result is the user's own hypothetical: it stays `user_supplied_synthetic`, with its Phase 2 label, and is never described as observed. The UI offers no shortcut for it.

## 5. Enforcement

Several independent controls, because convention alone is not enough. Except where marked, they do not exist yet and are implemented by their own milestones.

| # | Control | Owner |
|---|---|---|
| B-1 | **Type:** `usage` is `display_only` in every envelope; no bridge-state event type exists (AD-4) | Dev A |
| B-2 | **Request schema (exists):** contract v0.4 requests are strict, so an undeclared field returns `422 VALIDATION_ERROR`. It stops new fields, **not** an observed value placed in a valid field. | Dev A, Dev B |
| B-3 | **Code:** the inference service and `src/` do not import the ingestion component, and the reverse. In Express, the routing, mapper and inference-client modules do not import observation modules, and the reverse. Checked in CI. | Dev A, Dev B |
| B-4 | **Network:** ingestion has no route to the inference service, and inference has none to distribution, the observation store or the internet. `infra/compose.yaml` defines no separate networks today, so AD-1 and AD-10 must specify this. | Dev D, Dev B |
| B-5 | **Credentials:** the inference service holds none for the database or distribution mechanism. The ingestion role cannot write Phase 2 tables. | Dev B, Dev D |
| B-6 | **Filesystem:** the ingestion component mounts no Phase 1 path with write access | Dev D |
| B-7 | **Persistence:** observation records are separate from transactions, decisions and comparisons. A routing record never lists an observation as an input. Displayed context follows §6.1. | Dev B (AD-11) |
| B-8 | **Frontend:** observation state is separate from form and request state, with no copy path. Checked by lint and component tests. | Dev C |

`engineResponse` stays verbatim, and `decision_id`, `id_scheme` and `engine_version` are untouched: no observation enters the canonical document (contract §2.11).

## 6. Presentation and failure

- The observation panel and the routing result are visually distinct, and each value has its label (AD-4 §8).
- A routing result always shows its simulation date and state label. Beside it, the observation panel states: "Observations are shown for context. They do not affect routing."
- "Live routing", "routing on live data", "real-time optimal route" and equivalents are not used (D-15).
- **Failure independence** (AD6-Q2). An observation outage never blocks simulation-based routing. A stale, missing or failed observation changes only the observation panel; routing continues, with the same results. Conversely, an inference failure does not hide observations.
- **Consequence for AD-9.** Scope §3.D proposes, as a last fallback, to "refuse to route rather than route on unlabelled data". Under D-9 and AD6-Q2, an observation outage cannot cause a refusal; scope v1.2 notes this. Refusals come only from the existing engine and contract conditions, or from a routing value without its own label. AD-9 specifies the display fallback.

### 6.1 Displayed observation context

**Decided** (AD6-Q3): displayed observation context is recorded separately from engine inputs and decision IDs. **Proposed** detail:

- A context record holds the `event_id`s displayed when a user submitted a routing request, each with its display label, freshness state and evaluation time, and the time of capture. An observation shown as Unavailable without an event is recorded by its subject and label.
- It is a separate record that points to the transaction or comparison. Routing records, `engineResponse` and engine requests hold no reference to it.
- It never enters an engine request, the `decision_id` document, `clientReference`, a cache key or an engine input log.
- It is described as "displayed context", never as an input, cause or reason for the decision.
- **It cannot affect routing.** A missing or failed context record neither blocks nor rolls back a routing record or its Phase 2 audit row, whose atomic write (contract §6.2) is unchanged. A gap is recorded as a gap, not filled in later.
- **The v0.4 transaction and comparison requests are strict and stay unchanged,** so they cannot carry it. How it is captured belongs to AD-7. Its storage, retention and trust level belong to AD-11: what a browser reports as displayed is a claim, not proof.

## 7. Going further

Feeding an observation to the engine is **not** planned or authorized. This draft proposes that it would need all of:

1. a written proposal for one field: its source, meaning, units, mapping and failure behaviour;
2. independent out-of-time data and an approved evaluation (scope §4.2);
3. an approved Phase 1 research change, because execution, reward or feasibility inputs would change;
4. for knowledge: Gate 2 and a decision on P5;
5. Gate 3 for the provider, with terms covering this use;
6. a new `engine_version`, and `id_scheme` 2 if the canonical document gains an input;
7. a new API contract version; v0.4 is not edited in place;
8. a new AD-4 major version, because `usage` changes;
9. revised labels and claims, and an owner decision replacing D-9 and D-15.

A value from a legitimate bridge telemetry source, should one ever exist, follows the same list.

## 8. Acceptance tests (input to AD-13)

| # | Test |
|---|---|
| T-1 | **Non-interference:** the same request with observations absent, normal, extreme, stale, malformed and in outage gives the same `decision_id` and the same engine response, on one platform and device |
| T-2 | **No trigger:** a burst of events with no user request causes zero calls to `/v1/route`, `/v1/compare` and `/v1/explain` |
| T-3 | **No pre-fill:** events never change any form field, default or selection |
| T-4 | Import rules (B-3), including a deliberate violation that must fail |
| T-5 | Network and credentials (B-4, B-5), from inside each container |
| T-6 | Phase 1 artefacts and knowledge hashes are identical before and after an event soak |
| T-7 | Contract fixtures, `decision_id` vectors and the Phase 1 and 2 suites pass unmodified |
| T-8 | Text check on the UI and status documents for the forbidden phrases |
| T-9 | Context (§6.1): with it recorded, absent or failing to write, engine requests, engine responses and `decision_id` are identical |
| T-10 | No routing result is displayed in a currency converted with an observed rate |

T-1 uses synthetic events only, until Gate 3.

## 9. Questions

### 9.1 Decided by the project owner (24 November 2026)

| # | Decision | Section |
|---|---|---|
| AD6-Q1 | Live events must never trigger routing. | §1, §4 |
| AD6-Q2 | Observation outages must not block simulation-based routing. | §6 |
| AD6-Q3 | Displayed observation context is recorded separately from engine inputs and decision IDs. | §6.1 |
| AD6-Q4 | Routing results are not converted using live FX. | §4 |

Milestone 3.5's real-time path therefore means pushed observations, and pushed status for routing requests the user made.

### 9.2 Open

| # | Question | Draft position | Decides |
|---|---|---|---|
| AD6-Q5 | How are networks and database roles separated? | B-4 and B-5 state the requirement only | AD-1, AD-10, AD-11 |
| AD6-Q6 | How is displayed context captured, stored and retained? | §6.1 states the separation only | AD-7 (capture), AD-11 |

## 10. Approval checklist

- [ ] Dev B: backend, persistence and credential controls. **Flagged:** the inference side of B-4 is not enforced today (AD-1 component view §5)
- [ ] Dev C: UI rules and wording
- [ ] Project owner: approval, recorded in `docs/PHASE3_SCOPE.md` §2

Dev D is not a listed AD-6 reviewer. B-4 to B-6 need Dev D's work, so consulting Dev D is recommended; the approved reviewer list is unchanged.
