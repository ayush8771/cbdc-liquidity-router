# AD-13: Test Strategy and Gate Evidence Templates

**Status:** **DRAFT v0.3 for review. Not approved.** 26 November 2026. v0.3 answers Dev B's technical review of PR #31 at `d96aabe` (approve with conditions): the Gate 4 dependencies on AD-10 and AD-11 (§3.3), the scoped and relayed branch-protection record (§1), and the status of referenced documents (§1.1). v0.2 adds the cross-AD verification map (§2.9), durable-handoff, replay, load and separation layers, provisional gate-timing language, and Gate 2 and Gate 4 evidence aligned with the AD-10, AD-11 and PR #30 drafts. **Lead:** Dev D. **Reviewers:** Dev A, Dev B, Dev C. **Approver:** project owner.
**Inputs:** gate templates need none (plan §3); the final strategy needs every other AD. **Feeds:** all gates; the 3.1 exit. **Scope source:** `docs/PHASE3_SCOPE.md` §5, §7.3, §8.2; `docs/PHASE3_AD6_ENGINE_BOUNDARY.md` §8.

Part A (strategy) is a **provisional** draft built on the D-24 slice. Part B (templates) has no dependency and can be reviewed now. Nothing here passes a gate; **no gate has passed**.

## 1. Owner authorization (recorded)

Ayush (project owner and Dev A) approved the directions below on 26 November 2026, relayed to Dev D, **not quoted; no separate approval document exists**. They approve directions, not this document.

1. AD-2, AD-5 and AD-11 dependent decisions stay provisional.
2. D-24 HTTP polling stays the local synthetic pilot baseline (AD-3).
3. Timestamp-based gap detection is indicative only, with no event contract change (AD-3 §6).
4. Reviewer references, persistence and retention stay pending coordination with Anvesh's AD-11.
5. D-24 implementation, approvals and documented limitations are preserved.

**Branch protection (relayed).** The D-24 branch-protection item was reported closed by Ayush, with authenticated screenshots confirming the four required checks and mandatory approval enforcement. **That approval is relayed to Dev D, not quoted, and the screenshots are not in the repository**, so the repository holds the intended settings (`docs/PHASE3_D24_ACCEPTANCE.md` §6) but no evidence that the rule is applied. It is **scoped to `feature/phase3-platform`**. Protection of `main` is a **future, owner-controlled action**: D-24 §6 says to add `main` to the gate workflow and apply the same rule when Phase 3 merges there, and nothing about `main` changes now. This document does not revisit the D-24 item.

### 1.1 Status of the documents this strategy refers to

| Document | Status |
|---|---|
| AD-1 component view v0.5, AD-4 v0.2, AD-6 v0.2 | Approved for the D-24 slice only (25 November 2026); in `docs/` |
| AD-5 adapter contract, AD-8 budgets, AD-6 Part 2 (T-11 to T-18) and the other Part 2 companions | **DRAFT v0.1, unreviewed**, in PR #30 (read at `5f78500`), not in the repository baseline; every cited identifier may change |
| AD-2 | Unwritten; Dev B's provisional proposals relayed |
| AD-10, AD-11 | Unwritten; Dev B's provisional proposals relayed |
| AD-3, AD-12 | This branch's drafts (v0.3), unapproved |

## 2. Part A: test strategy `[provisional]`

### 2.1 Layers

| Layer | Evidence today | Dependency |
|---|---|---|
| Contract, schema, hash (Python and TypeScript) | `contracts` job; `contracts/events/` (three schemas, fixtures); `infra/scripts/check_event_contracts.py`; `contracts/test-vectors/event_payload_hash.v1.json` | `[DEP: AD-5]` for adapter contracts |
| Unit and component | backend; `services/web/test/observations/` | |
| Fault injection | `infra/testing/fault_ingestion/` (test-only) | `[DEP: AD-12]` |
| Replay | none | `[DEP: AD-2, AD-3]` |
| Stack acceptance | `acceptance-stack`: T-6, T-1, T-2, real SSE, fault recovery, limits, restart, SIGTERM | |
| Browser | `acceptance-browser`: panel on, off, preview (10 tests); `e2e/p3/observations.spec.ts` | |
| Gap-detection indicator | none; fault cases proposed in AD-12 §4 | `[DEP: AD-3 §6]` |
| Durable handoff (acknowledgement, redelivery, overflow) | none | `[DEP: AD-2, AD-3 §5.1]` |
| Idempotent persistence and replay (24 h window proposed) | none | `[DEP: AD-2, AD-11]` |
| Peak load (rates and streams not agreed) | the 300 s soak runs at the slice's 2 events/s only | `[OPEN]` AD-3 §10 X-1; AD-12 §3.3 |
| Persistence, audit, retention | none | `[DEP: AD-11, Anvesh]` |
| Storage and privilege separation | none for privileges; T-14 (no foreign key, join or view) is specified in the PR #30 drafts | `[DEP: AD-11]` |

### 2.2 AD-6 acceptance tests (D-24 coverage)

| Test | Where | Coverage |
|---|---|---|
| T-1 non-interference | `acceptance-stack` | Same request on plain and observations stacks in six states: identical `decision_id`, API decision and stored engine response |
| T-2 no trigger | `acceptance-stack`, browser | Zero rows and zero inference `/v1/route`, `/v1/compare`, `/v1/explain` calls during a burst, with positive controls |
| T-3 no pre-fill | `acceptance-browser` | Events change no form field, default or selection |
| T-4 import rules | `contracts` (unchanged) | With deliberate violations |
| T-5 network, credentials | `runtime` (unchanged) | **Ingestion side only** (D-25); inference side not run, B-4 unresolved for AD-10 |
| T-6 artefact hashes | `acceptance-stack` | 300 s soak; SHA-256 of `src`, `data`, `outputs`, `contracts/test-vectors`, `services/inference`, on host and in the container, before and after |
| T-7 regression | `guards`, `regression-gate` | Baseline `28da68f`; protected paths; waits on existing workflows rather than rerunning them |
| T-8 wording | `guards` | `python e2e/p3_safeguards.py text` over `services/web/src` and 10 named documents; **a human wording review is still required** |
| T-9 context | not applicable | AD-1 §6 item 5: "T-9 does not apply, because no context is recorded" (verified against AD-1). The exemption **ends at milestone 3.5**, when displayed context exists (scope §2.2.2, AD6-Q3) |
| T-10 no converted currency | `acceptance-browser` | Text check on the result region only |

### 2.3 Keeping Phase 1 and Phase 2 untouched

Protected paths fail on modification, deletion or rename, and on any addition outside `AUTHORIZED_ADDITIONS` (one file today: `contracts/test-vectors/event_payload_hash.v1.json`). The existing `tests`, `phase2-docker`, `phase2-integration` and `phase2-stack` workflows are waited on, not rerun; path-filtered ones that did not run are reported as not run, and nothing is claimed for them. New Phase 3 tests live outside the Phase 2 default test directories (`e2e/p3/`, `e2e/playwright.p3.config.ts`).

### 2.4 CI structure (preserved from D-24)

`phase3-observations.yml` (path-filtered; jobs `guards`, `regression-gate`, `acceptance-stack`, `acceptance-browser`) plus the unfiltered `phase3-acceptance-gate.yml`, which always reports one check, `phase3-acceptance`. Fail-closed rules, same-commit rule, trusted base script, 125 min wait budget (D-24 §6). No secrets; no pull-request text in commands; Docker is never pruned.

**Gate timing and CI budgets: unchanged, with provisional notes.** This document changes no workflow, job timeout (20, 75 and 90 min) or the gate's 125 min wait. Any added test below (a peak soak, a replay window, the AD-8 drills) would lengthen a job or need its own job; where it runs (this gate, a separate required job or a scheduled run) is `[OPEN]` and `[PROVISIONAL]`. No new duration is estimated here, because none is measured. For scale only: a 60 s peak at 200 events/s is 12,000 events, against the 500 events the AD-8 draft's soak (N-1) requires over at least 300 s. If a longer chain is ever added, the gate's budget must be recomputed in the same change (D-24 §6, which a test enforces).

### 2.5 Runtimes: historical and measured

| Figure | Source | Status |
|---|---|---|
| About 40 and 30 min (two acceptance jobs) | Local estimate in the first D-24 commit `bd085e6`, with §5 item 10 "unmeasured in CI" | **Historical; superseded** |
| `guards` 0.9, `regression-gate` 3.3, `acceptance-stack` 13.1, `acceptance-browser` 11.2 min | Measured in the first CI run, PR #24, commit `bd085e6`, one GitHub-hosted run each; written into D-24 §1 by commit `972d373` | **Measured, one sample** |

`regression-gate`'s 3.3 min includes waiting for the Phase 2 full-stack job and then failing on it; it is not a pass time. Job timeouts stay 20, 75 and 90 min. D-24 §5 item 10 and its header line "Not committed or run in CI yet" still carry pre-CI wording and are stale; this document does not edit D-24. `[OPEN: D-24's owner to correct]`

### 2.6 Evidence-integrity rules

Every harness step writes a log checked by `assert_harness_log.py` (no FAIL, no SKIP, non-zero counts, named checks present). Cleanup removes only `cbdc-p3s-*` projects it created. Playwright output is deleted and never uploaded. Text logs and the last 400 container-log lines are kept for 7 days.

### 2.7 Limits carried forward from D-24

Synthetic events only, no live source; fake ingestion is test-only; no live `503 SHUTTING_DOWN` on a real stack; T-5 inference side not run; preview mode tested outside a production image; hidden-tab behaviour emulated; T-10 a text check; one runner per result; T-6 hashes exclude image digests, checkpoints outside `outputs/` and PostgreSQL contents; the browser reload test protects reloads only, a lost event occurred in about 2 of 90 reloads, and the 5 s slot-release bound is not derived (D-24 §5, §6, §7).

### 2.8 Strategy items still to be decided

| Item | Status |
|---|---|
| Replay and durability tests | `[DEP: AD-2, AD-3]` |
| Adapter contract tests for real providers | `[DEP: AD-5, Gate 3]` |
| Persistence, audit and retention tests | `[DEP: AD-11, Anvesh]` |
| Load-test targets against the latency budget (exit criterion 9) | `[DEP: AD-8]` |
| Gap-detection accuracy tests | `[DEP: AD-3 §6, AD-12 §4]` |
| Security tests for Gate 4 | `[DEP: AD-10]` |
| Capacity, idempotency, replay and B-4 conflicts | Recorded in AD-3 §10 (X-1 to X-5); tests cannot be fixed until they are resolved |
| Where peak, replay and drill tests run (gate timing) | `[OPEN]` `[PROVISIONAL]`, §2.4 |
| Final strategy | Waits for every other AD (wave 4) |

### 2.9 Cross-AD verification map `[PROVISIONAL]`

Sources: the AD-5, AD-6 Part 2 and AD-8 drafts in PR #30 (unmerged, unreviewed, read at commit `5f78500`), and this branch's AD-3 and AD-12. Identifiers are cited as they stand there; they are qualified by document because the drafts reuse labels (AD-8's alerts B-1, C-1, F-1 and R-1 collide with other uses). If PR #30 changes an identifier, this map changes with it.

| Source | Obligation | Layer here | Runs |
|---|---|---|---|
| AD-5 A-1 to A-3, A-5, A-8 | Adapter conformance, registry validation, determinism, item faults, normalization | Contract and unit | With milestone 3.3 |
| AD-5 A-4 | Fake-provider fault classes, test-only | Fault injection (AD-12 §4) | With 3.3 |
| AD-5 A-6 | Idempotency key stable across restarts; dedup window boundary | Idempotent persistence | `[DEP: X-3]` |
| AD-5 A-7 | Status machine, both outage criteria | Unit and stack | With 3.3 |
| AD-5 A-9 | AD-6 T-1 to T-8 and T-10 per adapter; T-5 per adapter | Stack acceptance | With 3.3-L |
| AD-5 A-10 | No provider data; fixtures carry origin | Guards; AD-12 §3.4 | Now, for synthetic fixtures |
| AD-5 A-11 | Gate 3 enforcement: no start, values Unavailable | Unit and stack | With 3.3-L |
| AD-6 Part 2 T-11 | Per-adapter egress allowlist | Stack | After AD-10; 3.3-L |
| AD-6 Part 2 T-12 | Distribution isolation | Stack | After AD-3; 3.4 |
| AD-6 Part 2 T-13 | **Inference egress (B-4 inference side): not run, not claimed** | Stack | After AD-10 |
| AD-6 Part 2 T-14, T-15 | Store separation; audit independence | Persistence | After AD-11 |
| AD-6 Part 2 T-16 | Express composition import graph (extends T-4) | Contract (`contracts` job) | Runnable now |
| AD-6 Part 2 T-17 | Frontend state separation | Browser | 3.5 |
| AD-6 Part 2 T-18 | Knowledge-path isolation | Stack | 3.6, with Gate 2 |
| AD-8 N-1 to N-3 | Latency percentiles, segments, burst recovery | Peak load | `[OPEN]` rates (X-1) |
| AD-8 N-4 to N-6 | Reconnect, thresholds at boundaries, browser invariants | Browser, fake clocks | With 3.5 |
| AD-8 N-7 to N-9 | Limits, metrics surface, alerts | Stack | With 3.5 and 3.7 |
| AD-8 N-10 | Drills R-1 to R-7 (document-qualified: AD-8 R-1 to R-7) | Recovery | 3.7 |
| AD-8 N-11 | T-1, T-2, T-6 before and after each test | Non-interference | Always |
| AD-3 §5.1 H-1 to H-7 | Handoff acknowledgement, idempotent persistence, storage sequence, replay, persist-before-ack, separation, PostgreSQL failure | Durable handoff, persistence | `[DEP: AD-2, AD-11]` |
| AD-3 §5.2 | Delivery measured at a named layer; coalescing counted separately | All delivery measures | With any delivery target |

Non-interference is a standing obligation: T-1, T-2 and T-6 run before and after each milestone that adds a component to the observation path (AD-6 Part 2 §6).

**Browser tests assert the current value, not every update.** The browser may coalesce under backpressure by design (AD-3 §5.2), so browser acceptance checks the displayed current value, labels and ages, and a clean snapshot after reconnect. Delivery completeness is tested at the persistence or consumer layer.

## 3. Part B: gate evidence templates

Scope §5: four gates, each blocking one capability; the owner is the accountable approver of all four after technical review (D-19); an approver who leads the work under review needs a second reviewer (D-20). Each decision is recorded in writing with evidence and any waiver (exit criterion 10). **None has passed.**

### 3.1 Common template (one record per gate decision)

| Field | Content |
|---|---|
| Gate, capability, environment | Gate number; the capability it unlocks; the environment named |
| Decision | `approved`, `approved with waiver`, `refused` or `deferred`; date |
| Commit and artefacts | Commit SHA; checkpoint, image or schema identity and hash where relevant |
| Evidence list | Each item: claim, command or CI run URL, job conclusion, result with sample size, seeds, output path |
| Not shown | What the evidence does not cover; the limitations that apply |
| Reviews | Technical reviewers and their findings; second-review record where D-20 applies |
| Wording review | Human review of UI strings and status documents against scope §1.3 and §6 (T-8 requires one) |
| Waivers | Each waiver, its rationale, owner, expiry or follow-up |
| Approver | Project owner; signature line and date |
| Records kept | Where the record lives; no secrets in it |

Evidence is **measured or recorded**, never inferred. A relayed approval is labelled relayed. D-24 results are slice evidence and are **not** gate evidence (D-25).

### 3.2 Per-gate content

| Gate | Blocks | Reviewers (D-19) | Evidence the record must hold (scope §5) | Dependencies |
|---|---|---|---|---|
| **1 PPO approval** | Activating `ppo_projected` on any served path | Dev A; Dev C | Checkpoint identity, hash and registry entry (`approved_checkpoints.json` is empty today); its Stage 1F results; confirmation that the served artifact is `ppo_projected`, not raw PPO (D-10); permitted UI wording (§4.2). Open Phase 1 item: whether the projection is formally adopted; Gate 1 may pass with `ppo_projected` labelled experimental | `[DEP: owner's checkpoint choice]` |
| **2 Cognee readiness** | Writes to the knowledge layer from any Phase 3 pipeline | Dev A; Dev B | Real cited knowledge base (Phase 1 item; one assumed fact today); a retrieval-quality measurement (none exists); the review-queue design (AD-12); a written decision on P5; A-4 rules and the cap-sync test. **Provisionally** (Dev B's AD-11 proposals, none approved): authenticated reviewer references, durable review records, logical storage and privilege separation, category-specific retention and append-only refusal records, each with a test once AD-11 is approved | `[DEP: AD-12; AD-11; Phase 1 knowledge work]` |
| **3 Provider approval, per provider** | That provider's data in any environment, recorded samples and fixtures included (D-17) | Dev A; Dev B (the licence and terms decision is the owner's) | Licence or terms permitting this use including storage and display; streaming or polled; rate limits and cost; reliability and outage history; retention and redistribution limits; scraping decided per site. Hard boundary: no live FX or news source is presented as bridge liquidity or congestion telemetry | `[DEP: AD-5; AD-11 retention]`; no provider evaluated |
| **4 Production security** | Exposure beyond the private development environment, including staging, LAN, tunnels, public demo URLs (D-16) | Dev B; Dev C; Dev D | Milestone 3.2 complete (identity provider, dev mode removed, httpOnly cookies, strict CSP, secrets management); authorization and rate limits tested; encryption in transit; audit trail of input data, model version, request, allocation and response; monitoring and alerting; backup and recovery exercised, all gathered inside the private environment. **Alignment with AD-10 `[DEP: AD-10, unwritten]`:** B-4 on both sides, with T-5 run on the inference side and T-13 (not run today; D-25 waives enforcement for the D-24 slice only and is not Gate 4 evidence); T-11 egress allowlists for any provider adapter; AD-8's recovery drills as the "recovery exercised" evidence; AD-8's boundary-violation alert as monitoring evidence. How inference egress is closed is open (AD-3 §10, X-5). **Further AD-10 and AD-11 dependencies, including B-4's open status, are in §3.3** | `[DEP: AD-10; AD-11; milestones 3.2, 3.7]` |

The Gate 3 and Gate 2 rows must not be filled with D-24 results: they concern providers and knowledge content, which D-24 does not touch.

### 3.3 Gate 4 dependencies on AD-10 and AD-11 `[PROVISIONAL]`

Evidence Gate 4 would need beyond the scope list, each blocked on a document that is **unwritten** (AD-10, AD-11). No test below exists, and none is run or claimed.

| # | Evidence | What a test must show | Depends on |
|---|---|---|---|
| G4-1 | **Separate security-event logging that preserves Q19** | The Phase 2 audit rule (Q19, closed) writes an audit row only together with a persisted record, in the same transaction, and a rejected request (401, 403, 405, 422) creates **none** (`docs/PHASE2_API_CONTRACT.md` §6.2; `docs/TEAM_REVIEW_RESOLUTION.md`). Security events such as failed sign-in, rejected streams and boundary violations therefore need their own log. A test: a rejected request leaves no audit row **and** leaves a security-event record, with no token or payload in it | `[DEP: AD-10, AD-11]` |
| G4-2 | **Database-role and privilege verification** | Connecting as each role: the observation role cannot read or write Phase 2 tables and the reverse; append-only tables refuse update and delete; the review and refusal records are append-only. Foreign-key, join and view separation is AD-6 Part 2 T-14, a different check | `[DEP: AD-11, AD-10]` |
| G4-3 | **Positive controls for inference isolation, and security regression probes** | T-13 (inference egress) is **not run**. When it runs, a probe that cannot reach a host proves nothing unless a positive control shows the probe can reach an allowed peer, the way T-2 uses positive controls first (D-24 §2). The existing ingestion probe (`infra/scripts/probe_ingestion_isolation.py`) is the model. Probes are repeated on each change as security regression tests | `[DEP: AD-10]` |
| G4-4 | **Cookie-session authentication, origin validation and applicable CSRF controls** | Today development tokens are used (A-1). When httpOnly cookie sessions exist, origin validation must hold on the stream route and on mutating routes, and CSRF protection must be shown for the state-changing routes it applies to. Whether it applies to the read-only stream is an AD-10 decision. Not implemented; nothing is claimed | `[DEP: AD-10; milestone 3.2]` |
| G4-5 | **Owner-controlled `main` branch protection** | Protection of `main` is an owner action, recorded as evidence when taken. It is separate from the relayed `feature/phase3-platform` item (§1) | Owner |

**B-4 stays open.** It is not closed by this document, by D-24 evidence or by any draft. It closes only with an authorized implementation, runtime evidence (T-5 on the inference side and T-13, with positive controls) and **formal owner closure**. D-25 waives enforcement for the D-24 slice only, and is not Gate 4 evidence (AD-3 §10, X-5).

## 4. Limitations of this document

1. Part A is provisional and cannot be finalized before the other ADs.
2. The common template's fields are a proposal; the scope fixes only that a written record with evidence and waivers exists.
3. Runtime figures are one CI sample.
4. No template has been used on a real decision.

## 5. Open items and dependencies

| Item | Status |
|---|---|
| AD-2, AD-3 (replay, mechanism) | `[DEP]` |
| AD-5 (adapters, Gate 3 evidence) | `[DEP: Dev A]` |
| AD-8 (latency budget, capacity envelope, delivery measure layer) | `[DEP]`; draft in PR #30, unreviewed; conflicts X-1, X-2 |
| AD-2 (Dev B provisional requirements, relayed) | `[DEP]` unwritten |
| AD-10 (Gate 4, T-5 inference side) | `[DEP: Dev B]` |
| AD-11 (persistence, audit, retention, reviewer references) | `[DEP: Anvesh]` |
| Stale D-24 lines (§2.5) | `[OPEN]` |
| Dev A, B, C review; owner approval | `[PENDING]` |
