# Phase 2 v0.4: team review resolution

**Branch:** `docs/phase2-v0.4`. Revision of commit `21104c2`, reviewed by Ayush (project owner, Dev A), Anvesh (Dev B) and Varshini (Dev C). Prepared by Dev D on 4 November 2026.

**Rule applied:** where Ayush's explicit decision conflicts with a developer's recommendation, Ayush's decision is followed. Other review findings are incorporated when they are compatible, or classified below. Nothing here changes service implementation code.

**Revision 2 (owner's final decisions)** is in §7.

**Source note.** This revision was prepared from a written summary of the three reviews, not from the full review texts. B4 and B5 come from Ayush's earlier project-owner review: **B4 = Anvesh's backend integration gaps**, and **B5 = Ayush's inference implementation gaps** (attribution confirmed by Ayush in his final review; see R2, §8 and §9). Revision 3 wrongly read them as items 4 and 5 of Anvesh's findings list.

---

## 1. Ayush's decisions implemented

| Decision | Where |
|---|---|
| `decision_id`: RFC 8785, `id_scheme: 1`, `engine_version` and every output-affecting artefact included, checkpoint hash for `ppo_projected` only, `api_version` and `git_commit` excluded | Contract §2.11, §2.2 |
| `engine_version` = semantic version of the inference logic that can change routing outputs | Contract §2.2 |
| Expiry while queued → `ENGINE_BUSY` | Contract §4, §5; arch §6.2 |
| Request deadline configurable, default 12 s; worker execution timeout independently 10 s; a running request past its deadline → `ENGINE_TIMEOUT`, without killing the worker and without shortening the execution timeout | Contract §5, §8; arch §6.2; inference OpenAPI |
| `CBDC_ENGINE_STARTUP_TIMEOUT_S`, default 180 s | Contract §8; arch §6.2 (unchanged) |
| Strict inference request schemas and closed inference response schemas in CI | Contract §1; inference OpenAPI (PENDING labels removed) |
| `client_reference` at most 200 Unicode code points | Contract §2.8; inference OpenAPI |
| `ready_workers` in health (required) | Contract §2.1; inference OpenAPI; health fixtures |
| Engine 4xx messages expose no internal paths, exception representations or configuration values; sanitised caller values may be echoed | Contract §4; inference OpenAPI |
| Wrong-length history → `VALIDATION_ERROR` | Contract §2.4, §3.2, §4; both OpenAPI files (`minItems`/`maxItems` 30); new fixture `inference/errors/422_validation_error_history_length.json` |
| `include_semantic_context` removed from v1 | Contract §2.10; inference OpenAPI; explain fixture |
| Form-level errors omit `field` | Contract §4; both OpenAPI files |
| Mapped engine field paths forwarded through an explicit table | Contract §4 |
| Optional `details.cause = NOT_READY` on startup-related 503s | Contract §3.2, §4; app OpenAPI; `app/errors/503_inference_not_ready.json` |
| `completionRate` = completed allowed ÷ all allowed routed; null on a zero denominator; the change is documented, not silent | Contract §3.8; app OpenAPI; dashboard fixture; checker |
| Database-down readiness → 503, `status: "unavailable"`, component identified; liveness separate | Contract §3.9; app OpenAPI; `app/meta/503_health_database_unavailable.json`, `app/meta/200_health_live.json`; checker |
| Risk fallback `0.0` preserved; `RISK_FALLBACK_USED` emitted; fixtures corrected | Contract §2.5, §2.8; arch §9.2; all route, compare and state fixtures; checker |
| No `STATE_OUTSIDE_TRAINING_RANGE` from `/v1/state`; route and compare emit it from policy-consumed values | Contract §2.4, §2.5; arch §9.1; inference OpenAPI; checker |
| App response schemas closed in CI, tolerant at run time | Contract §1; app OpenAPI. The v0.4 draft had opened the `Decision` subtree; that is **reverted** |

**Risk-fallback check.** In `data/processed/macro_risk_proxy.parquet`, the June 2024 proxy is NaN for PHL, USA and ARE. So every fixture dated 2024-06-14 falls back to risk 0.0 (`src/envs/cbdc_env.py` → `DEFAULT_RISK_PLACEHOLDER = 0.0`).
- The fixtures now have `risk: 0.0`, `risk_term: 0.0`, the rewards adjusted by the removed risk term, and `RISK_FALLBACK_USED`.
- Regulatory rejections carry no risk-based allocation, so they don't get the warning. **Dev A to confirm.**
- The PPO fixture keeps its illustrative shares. Dev A's engine-generated fixtures will replace it.

## 2. Anvesh's findings

| # | Finding | Status |
|---|---|---|
| 1 | `POLICY_DISABLED: 409` in the app enum, status table and pass-through list; POST response and fixture | Done in the first v0.4 draft; kept |
| 2 | Failed records with `corridor: null` | Done; checker enforces it |
| 3 | Failed `policyStatus` null | Done |
| 4 | Dashboard `window.from`/`to` nullable | **Done** |
| 5 | Close top-level `CreateTransactionRequest`/`CreateComparisonRequest` | Done in the first v0.4 draft; kept |
| 6 | `NOT_READY` → 503 `INFERENCE_UNAVAILABLE` | Done, plus `details.cause` and `Retry-After` per the owner decision |
| 7 | Messages in derived fixtures are free text | **Done:** the checker compares only code and status. The v0.4 rule that a passthrough forwards the engine message is removed from the checker |
| 8 | Audit wording | **Reworded** (contract §6.2) to audit with persisted writes. Whether rejected requests are audited is **open (Q19)**: the backend branch has no audit code yet |
| 9 | `METHOD_NOT_ALLOWED: 405` with `Allow` | Done in the first v0.4 draft; kept |
| 10 | `TRANSACTION_FAILED` with fixture | Done in the first v0.4 draft; kept |
| 11 | Comparison saved only on a `/v1/compare` 200, including when policies are skipped | **Confirmed;** the Pending marker is removed (contract §3.6) |
| 12 | Pass through the agreed engine codes; don't expose engine messages or unmapped details | Unmapped details: **done** (contract §4). Engine messages: conflicts with the v0.4 forwarding rule, so **open (Q16)** |
| 13 | History-length code matches the backend | **Done:** `VALIDATION_ERROR` in both, per Ayush. The backend already returns it |
| 14 | `Retry-After`, mock health, request-ID and client-reference limits, policy-null | Aligned |

Anvesh's open points, kept explicit:
- `meanFeeCostPct` source and formula: Q11, blocking.
- Database failure behaviour beyond readiness, for example a write failing after inference succeeded: **not defined by the contract.** Added to the Dev B follow-ups.
- Explaining a stored PPO decision after its checkpoint is disabled: **resolved by the owner** (§7).
- The mock fixture selection rule: Q20.
- Dev A and Dev B implementation issues: §6.

## 3. Varshini's findings

| # | Finding | Status / class |
|---|---|---|
| 1 | Failed records could violate their schema (country codes, positive amount, nullable summary fields) | **Selected solution: tighten app request validation.** Country codes must be `^[A-Z]{3}$` and `amountUsd > 0` at the backend, so a stored failed record always matches. The failed-record schema was *not* relaxed. The summary fields were already nullable. Contract §3.2. **Anvesh to acknowledge** (backend validation change) |
| 2 | `/state` `scenarioId` rules and mode mismatch; unknown scenario alignment | **Done:** required with `scenario`, rejected with replay; any string accepted and `UNKNOWN_SCENARIO` passed through, the same as on POST (contract §2.5, §3.7; both OpenAPI files) |
| 3 | Validated request in `TransactionRecord` (retry with the same inputs) | **Not added, non-blocking.** Persistence already supports it (`stateSpec`, `requestedPolicy`, `clientReference`); it's an additive field for owner review |
| 4 | Sender/receiver and failure code in history summaries | **Not added, non-blocking.** Persisted, so it's additive |
| 5 | List query behaviour | **Documented** from the backend implementation: `from` inclusive, `to` exclusive, sort enum, the `completed` and `corridor` filters never match failed rows, no `status` filter, unknown query params ignored (contract §3.3; app OpenAPI). A non-UUID `:id` is open (Q11a) |
| 6 | `bridgeUids` on warnings | **Not added, non-blocking:** a contract expansion for owner review |
| 7 | `meanFeeCostPct` | **Blocking, Q11** |
| 8 | `state`/`policies` on comparison records, result order, analyst default | **Open, non-blocking (Q18)** |
| 9 | Unknown enum values | **Done:** run-time rule in contract §1 |
| 10 | PPO fixtures inconsistent with meta | **Done:** fixture-only `inference/meta/200_version_ppo_enabled.json` and `app/meta/200_meta_ppo_enabled.json` |
| 11 | Dashboard fixture derived from the transaction fixtures | **Done;** the checker verifies the totals and `completionRate` |
| 12 | Missing fixture coverage | Partly done. Still missing (non-blocking, Dev D): a `STATE_OUTSIDE_TRAINING_RANGE` route fixture; an all-skipped comparison; an empty list and an empty dashboard; health with inference `degraded`; an app passthrough of an engine `VALIDATION_ERROR` with mapped paths; a domain 422 with a mapped `details.field` |

## 4. Conflicts resolved by the owner's decision

| Q | Conflict | Resolution |
|---|---|---|
| Q3 | Database down: **B** 200 `degraded`; **C** 503 only if the body stays the Health object | **503, `status: "unavailable"`, body is the Health object** with the failing component named; liveness separate. This meets C's condition |
| Q4 | Form-level errors: **B** `field: ""`; **C** omit | **Omit `field`.** One representation, no empty string |
| Q5 | History length: **C, D** `INVALID_STATE_VALUE`; **B** `VALIDATION_ERROR` | **`VALIDATION_ERROR`** |
| Q6 | **B:** forward only mapped `details.field`; **C:** app-facing `details.errors[]`, no engine paths | **Mapped paths forwarded through an explicit table**, keeping each existing app shape: `VALIDATION_ERROR` → `details.errors[]` with mapped fields; a domain 422 → `details.field`, mapped. Unmappable paths are dropped, so a raw engine path never reaches the app. No new envelope was invented. If C needs domain 422s as `errors[]` items too, that is a follow-up change |
| Q7 | **B, C:** open response schemas plus strict fixtures | **Closed in CI, tolerant at run time.** The v0.4 opening of `Decision` is reverted |
| Q11 | Dashboard semantics | **`completionRate` per owner.** The B/C-compatible populations for `count` and the means are written as **proposed, awaiting owner approval**. `meanFeeCostPct` and window defaults are **open** |
| Q15 | **C:** a range warning on `/v1/state` | **Not emitted by `/v1/state`.** UI implication: the bridge monitor can't flag out-of-range values before a transaction is routed |

## 5. Remaining questions (contract §10)

**Blocking:**
- **Q16:** does the app forward the sanitised engine 4xx message (capped at 500) or use a fixed message? *Anvesh and Varshini.*
- **Q19:** audit rows for rejected requests. *Anvesh.*
- **Q11-dep:** the `feeCostUsd` Prisma migration that `meanFeeCostPct` needs (see §7). *Anvesh.*

**Non-blocking:**
- Q11: the dashboard window defaults. *Ayush, with Anvesh.*
- Q21: adopt the minimum start budget, and its default. *Ayush.*
- Q11a: what a non-UUID id returns. *Anvesh.*
- Q12: the remaining health check values. *Ayush.*
- Q14: whether 405 is checked before or after auth. *Anvesh.*
- Q18: comparison defaults and ordering. *Anvesh and Varshini.*
- Q20: the mock fixture selection rule. *Nisarga, Anvesh and Varshini.*
- The additive frontend suggestions C3, C4 and C6 (§3), for owner review.
- Confirm the canonicalisation details in contract §2.11 (parsed model, venue sort, `history: null`). *Ayush/Dev A, at implementation.*

## 6. Implementation follow-ups (not contract changes)

**Dev A (inference):**
- Return a real `decision_id`. Today it is `null`, so the backend rejects every live route (the earlier blocker). Implement it to contract §2.11, and fix the exact artefact list, including the risk-proxy and cost-baseline tables.
- `/v1/version` exposes no fingerprints for the risk-proxy and cost-baseline tables yet. Adding them needs a schema change. Non-blocking.
- Request deadline and queued expiry; a running task not killed at the deadline; the 10 s execution timeout recycling only its worker.
- `ready_workers`; strict request bodies; `VALIDATION_ERROR` for history length; remove `include_semantic_context`; sanitised 4xx messages; `RISK_FALLBACK_USED` with 0.0.
- Range warning from route and compare only; confirm it doesn't apply to regulatory rejections.
- The golden-hash test on Windows and Linux.
- Engine-generated fixtures to replace the illustrative ones.

**Dev B (backend):**
- Tighten request validation (country pattern, `amountUsd > 0`, 30-item history).
- `failureCode` migration; `details.cause`; `Retry-After` forwarding; the explicit field-path mapping table.
- Database-down readiness 503 with the Health body; a liveness endpoint; mock health `ok`.
- The `scenarioId` rules on `/state`; a 405 middleware.
- Comparison persistence only on 200.
- Define the behaviour when a database write fails after inference succeeds. The contract doesn't define it.
- **B4: Anvesh's backend integration gaps** (from Ayush's project-owner review). These are the Dev B follow-ups listed above, and they stay **follow-up implementation blockers** for the backend.

- **B5: Ayush's inference implementation gaps** (from Ayush's project-owner review). These are the Dev A follow-ups above and the requirements in contract §9.1 (A-1 to A-9). They stay **follow-up implementation blockers** for the inference service.

**Dev C (web):**
- Handle `failure`, the null fields, `details.cause`, the 503 Health body, and unknown enum values as in contract §1.
- Expect no range warning on the bridge monitor.
- Fixture-set switching for the PPO-enabled meta (depends on Q20).

**Dev D (contracts and infra):**
- The missing fixture coverage in §3, item 12.
- A Compose healthcheck using `GET /api/v1/health/live` (approved).
- Lock generation once `service.in` is final.

## 7. Owner's final decisions (revision 2)

| Decision | How it is implemented | Where |
|---|---|---|
| Q11: rename `byCorridor.count` → `routed`; add `allowedRouted`; `completionRate` = completed allowed ÷ allowed routed; means over allowed routed; null on a zero denominator | Schema renamed and extended (`allowedRouted` in `byPolicy` and `byCorridor`). Fixture rebuilt from the stored transactions. The checker recomputes `allowedRouted`, `routed`, `completionRate` and every mean | Contract §3.8; app OpenAPI `DashboardSummary`; `app/dashboard/200_summary.json`; checker `check_dashboard` + 3 tests |
| `meanFeeCostPct` = 100 × AVG(`feeCostUsd`/`executedUsd`), allowed routed with `executedUsd > 0` | Formula documented and checked; the fixture now has real values (waterfall 1.563333) | Same as above + 1 test |
| `feeCostUsd` Prisma migration by Anvesh | **Documented as a dependency, not done.** The backend schema (`origin/feature/phase2-backend`) has no `feeCostUsd` column, and this change touches no backend file | Contract §3.8, §10 Q11-dep |
| Q17: stored explanation returned; else checkpoint disabled → `POLICY_DISABLED`; else changed → `DECISION_MISMATCH`; never recompute with another checkpoint | Ordered rule, checked from the cached `/v1/version` checkpoint before inference is called | Contract §3.5; app OpenAPI `ExplanationConflict` |
| Rejection fixtures omit `RISK_FALLBACK_USED` | Already true in both rejection fixtures. A checker rule and test now enforce it | Checker `check_route`; test |
| Three-letter country codes; `amount > 0`; `INVALID_AMOUNT` preserved | Country codes stay a schema rule (`VALIDATION_ERROR`). `amountUsd` ≤ 0 is checked by the backend and returns `INVALID_AMOUNT`, so the app schema no longer has `exclusiveMinimum` (which would have made it a `VALIDATION_ERROR`). New fixture | Contract §3.2, §4; app OpenAPI; `app/errors/422_invalid_amount.json`; test |
| `CBDC_ENGINE_REQUEST_DEADLINE_S`, default 12 s | The "proposed name" labels removed | Contract §5, §8; arch §6.2 |
| `GET /api/v1/health/live` approved, public | Approved and public. The body `{"status":"ok"}` is for Anvesh to confirm when implementing | Contract §3.1, §3.9; app OpenAPI; `app/meta/200_health_live.json` |
| R1–R6 | Not addressed in revision 2: their definitions arrived later, with the owner's final review. **Resolved in revision 3** (§8) | — |

**Additional checks requested:**
- **Reward weights and scenario definitions in `decision_id`.** Both are now **hashed explicitly**: the λ values, and in scenario mode the scenario's id and every multiplier. Relying on `engine_version` would mean remembering to bump it when weights are recalibrated, and nothing enforces that.
  - The testable rule: changing any hashed input changes the ID, and changing an excluded input doesn't (contract §2.11).
  - It is a Dev A test, because the fixtures can't compute real hashes.
  - **Ayush to confirm**, since it adds inputs to his approved hash list.
- **Minimum worker-start budget.** Proposed `CBDC_ENGINE_MIN_START_BUDGET_S`, default 1 s as a placeholder until measured (contract §5, Q21).
  - A queued task with less than that left is not dispatched; it gets `ENGINE_BUSY` without running.
  - It doesn't conflict with the approved timeouts: it never kills a worker and never shortens the 10 s execution timeout, and a budget of 0 gives exactly the approved behaviour.
  - Not yet approved.

**Other prior decisions:** unchanged.

## 8. Owner's and Dev A's final review (revision 3)

| Item | Resolution | Where |
|---|---|---|
| **R1** | Every outdated GBR→PHL example is corrected. In June 2024 the risk lookup falls back (the proxy is NaN for PHL), so the examples now show: `risk` 0.0 on every venue, `risk_term` 0.0, rewards −0.3078 → **−0.2208** (the 0.087 risk term removed), and the `RISK_FALLBACK_USED` warning. That covers the §2.5 state example (`corridor_risk` 0.0), the §2.8 route example, the §3.2 app example and the §3.3 list example. The §3.8 dashboard example now shows the fixture's derived values, with `routed` and `allowedRouted`. The fixtures were already corrected in revision 1 | Contract §2.5, §2.8, §3.2, §3.3, §3.8 |
| **R2** | Superseded by revision 4 (§9): B4 = Anvesh's backend integration gaps, B5 = Ayush's inference implementation gaps, both from Ayush's project-owner review | §6, source note |
| **R3** | Exact canonical document: a table of members, `null` handling, numeric normalisation, exclusions, `checkpoint_sha256` (the hash for `ppo_projected`, `null` otherwise), and the `id_scheme` and `engine_version` rules. Seven test vectors with exact RFC 8785 strings and IDs. The checker rebuilds and verifies them, and 19 tests check that each hashed input changes the ID and each excluded input doesn't | Contract §2.11; `contracts/test-vectors/decision_id.v1.json`; checker `decision_document`, `check_vectors`; tests |
| **R4** | `macro_risk_proxy_sha256` and `rpw_corridor_quarterly_sha256` added to `/v1/version` `data`, the app `meta`, the cache-invalidation keys (which now cover every `decision_id` input that `/v1/version` reports) and the hashed `artefacts`. The fixture values are the SHA-256 of the committed binary blobs | Contract §2.2, §2.11, §5; both OpenAPI files; version and meta fixtures; test |
| **R5** | Q12 closed: `structured_data`, `daily_state` and `knowledge_base` are exactly `ok` or `error` | Contract §2.1, §10; inference OpenAPI |
| **R6** | `byCorridor.routed` and `allowedRouted` kept as approved; nothing changed | — |
| A1 | Reward weights and scenario fields hashed: `scenario_id` and its three multipliers, with the description excluded | Contract §2.11 |
| A2 / Q21 | `CBDC_ENGINE_MIN_START_BUDGET_S`, provisional 1 s; under budget → `ENGINE_BUSY`; the 10 s execution timeout stays independent | Contract §5, §8; arch §6.2 |
| A3 | An omitted dashboard bound is unbounded and echoed as `null` | Contract §3.8; app OpenAPI |
| Q13 | `RISK_FALLBACK_USED` is required exactly where the lookup falls back. The checker knows that from a recorded (corridor, month) table read from the data, **not** from a risk value of 0.0. Rejections are exempt | Checker `RISK_FALLBACK_MONTHS`; 3 tests; contract §2.8 |

**Dev A requirements** are in contract §9.1 (A-1 to A-9). They are *specified* there, with the test that will show each one done. **No inference service work is part of this change**, and none of A-1 to A-9 is implemented yet.

**Compatibility checks:**
- The checker and the vectors gave the same results with every `contracts/` JSON and YAML file converted to CRLF (test `test_fixture_line_endings_do_not_matter`, run on Windows).
- `.gitattributes` stores `contracts/**` and `infra/**` with LF line endings.
- The vector hashes are computed from parsed JSON, never from file bytes, so line endings can't change them.
- **Not run on Linux:** no Linux environment was available here. The CI workflow `phase2-integration.yml` runs the checker on Ubuntu.

**Still open:**
- Q16 (Anvesh and Varshini) and Q19 (Anvesh).
- The `feeCostUsd` Prisma migration (Anvesh; not done, outside this change).
- The non-blocking items in contract §10.

## 9. Ayush's final corrections (revision 4)

| Correction | Resolution | Where |
|---|---|---|
| **R2 attribution** | **B4 = Anvesh's backend integration gaps; B5 = Ayush's inference implementation gaps.** Both originated in Ayush's earlier project-owner review. Revision 3's reading (items 4 and 5 of Anvesh's findings) is withdrawn. Specific gap lists are not repeated here: they are the Dev B and Dev A follow-ups in §6 and contract §9.1 | Source note; §6 |
| **Cache invalidation** | The keys now include `reward_weights` and the new `data.scenarios_sha256` (the RFC 8785 hash of the `/v1/scenarios` list). The checker checks the fixture value against the scenario list | Contract §2.2, §5; both OpenAPI files; version and meta fixtures; checker `check_version_fingerprints`; test |
| **Knowledge hashing** | The Phase 2 service `knowledge_sha256` (LF-normalised) is distinguished from Phase 1's raw-byte `KnowledgeBase.sha256`, and only the service value is reported or hashed. `engine_version` must be bumped when an imported Phase 1 constant that affects outputs changes | Contract §2.2, §9.1 A-1, A-2 |
| **Startup validation** | The service refuses to start unless `0 <= CBDC_ENGINE_MIN_START_BUDGET_S < CBDC_ENGINE_REQUEST_DEADLINE_S` | Contract §8, §9.1 A-3; arch §6.2 |
| **Hash edge cases** | Tests added for: −0.0 vs 0.0, input key order, exact floats (`0.1+0.2` ≠ `0.3`), UTF-8 without escaping, a scenario definition that doesn't match the state, and PPO without a checkpoint | Checker tests |
| **Fallback coverage** | Tests added: a compare result missing a required `RISK_FALLBACK_USED`, and a state view whose warning contradicts a non-zero risk | Checker tests |

Dev A's requirements A-1 to A-9 are documented only; Dev A implements them separately in `services/inference/` once v0.4 is final.

**PR and CI status (checked with the public GitHub API on 4 November 2026):**
- **There is no PR for `docs/phase2-v0.4`.** The only open PR is #2 (`feature/phase2-platform` → `main`).
- `phase2-integration.yml` runs only on `pull_request` and on pushes to `main`, so **it has never run on this branch.**
- The last Ubuntu run of the contract checks was PR #2 at `9fd9353`, which passed.
- Ubuntu CI for v0.4 will run once a PR from `docs/phase2-v0.4` into `feature/phase2-platform` is opened.
