# AD-13: Test Strategy and Gate Evidence Templates

**Status:** **DRAFT v0.1 for review. Not approved.** 26 November 2026. **Lead:** Dev D. **Reviewers:** Dev A, Dev B, Dev C. **Approver:** project owner.
**Inputs:** gate templates need none (plan §3); the final strategy needs every other AD. **Feeds:** all gates; the 3.1 exit. **Scope source:** `docs/PHASE3_SCOPE.md` §5, §7.3, §8.2; `docs/PHASE3_AD6_ENGINE_BOUNDARY.md` §8.

Part A (strategy) is a **provisional** draft built on the D-24 slice. Part B (templates) has no dependency and can be reviewed now. Nothing here passes a gate; **no gate has passed**.

## 1. Owner authorization (recorded)

Ayush (project owner and Dev A) approved the directions below on 26 November 2026, relayed to Dev D, **not quoted; no separate approval document exists**. They approve directions, not this document.

1. AD-2, AD-5 and AD-11 dependent decisions stay provisional.
2. D-24 HTTP polling stays the local synthetic pilot baseline (AD-3).
3. Timestamp-based gap detection is indicative only, with no event contract change (AD-3 §6).
4. Reviewer references, persistence and retention stay pending coordination with Anvesh's AD-11.
5. D-24 implementation, approvals and documented limitations are preserved.

Branch protection for the D-24 slice was closed by Ayush on 26 November 2026 and is not revisited.

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
| Persistence, audit | none | `[DEP: AD-11, Anvesh]` |

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
| T-9 context | not applicable | AD-1 §6 item 5: "T-9 does not apply, because no context is recorded" (verified against AD-1); revisit with AD-7, AD-11 |
| T-10 no converted currency | `acceptance-browser` | Text check on the result region only |

### 2.3 Keeping Phase 1 and Phase 2 untouched

Protected paths fail on modification, deletion or rename, and on any addition outside `AUTHORIZED_ADDITIONS` (one file today: `contracts/test-vectors/event_payload_hash.v1.json`). The existing `tests`, `phase2-docker`, `phase2-integration` and `phase2-stack` workflows are waited on, not rerun; path-filtered ones that did not run are reported as not run, and nothing is claimed for them. New Phase 3 tests live outside the Phase 2 default test directories (`e2e/p3/`, `e2e/playwright.p3.config.ts`).

### 2.4 CI structure (preserved from D-24)

`phase3-observations.yml` (path-filtered; jobs `guards`, `regression-gate`, `acceptance-stack`, `acceptance-browser`) plus the unfiltered `phase3-acceptance-gate.yml`, which always reports one check, `phase3-acceptance`. Fail-closed rules, same-commit rule, trusted base script, 125 min wait budget (D-24 §6). No secrets; no pull-request text in commands; Docker is never pruned.

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
| Final strategy | Waits for every other AD (wave 4) |

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
| **2 Cognee readiness** | Writes to the knowledge layer from any Phase 3 pipeline | Dev A; Dev B | Real cited knowledge base (Phase 1 item; one assumed fact today); a retrieval-quality measurement (none exists); the review-queue design (AD-12); a written decision on P5; A-4 rules and the cap-sync test | `[DEP: AD-12; AD-11; Phase 1 knowledge work]` |
| **3 Provider approval, per provider** | That provider's data in any environment, recorded samples and fixtures included (D-17) | Dev A; Dev B (the licence and terms decision is the owner's) | Licence or terms permitting this use including storage and display; streaming or polled; rate limits and cost; reliability and outage history; retention and redistribution limits; scraping decided per site. Hard boundary: no live FX or news source is presented as bridge liquidity or congestion telemetry | `[DEP: AD-5; AD-11 retention]`; no provider evaluated |
| **4 Production security** | Exposure beyond the private development environment, including staging, LAN, tunnels, public demo URLs (D-16) | Dev B; Dev C; Dev D | Milestone 3.2 complete (identity provider, dev mode removed, httpOnly cookies, strict CSP, secrets management); authorization and rate limits tested; encryption in transit; audit trail of input data, model version, request, allocation and response; monitoring and alerting; backup and recovery exercised, all gathered inside the private environment | `[DEP: AD-10; AD-11; milestones 3.2, 3.7]` |

The Gate 3 and Gate 2 rows must not be filled with D-24 results: they concern providers and knowledge content, which D-24 does not touch.

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
| AD-8 (latency budget) | `[DEP]` |
| AD-10 (Gate 4, T-5 inference side) | `[DEP: Dev B]` |
| AD-11 (persistence, audit, retention, reviewer references) | `[DEP: Anvesh]` |
| Stale D-24 lines (§2.5) | `[OPEN]` |
| Dev A, B, C review; owner approval | `[PENDING]` |
