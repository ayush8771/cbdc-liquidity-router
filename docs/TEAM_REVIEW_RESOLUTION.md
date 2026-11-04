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
- Q16 and Q19: closed in revision 7 (§12).
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

## 10. Ayush's confirmed hashing specification (revision 5)

| Item | Resolution | Where |
|---|---|---|
| Numeric normalisation | Finite transaction and state numbers are converted to binary64 during validation. Execution and `decision_id` use the identical values. *Revision 5 rounded unsafe integers (2⁵³+1 → 2⁵³); revision 6 replaces that with rejection (§11).* | Contract §2.11; checker tests |
| Daily-state fingerprint | Exact scheme 1: the RFC 8785 descriptor; pandas 2.3.3 `hash_pandas_object(index=True, categorize=False, hash_key="0123456789123456")`; `<u8` row hashes; a domain separator plus 8-byte little-endian length-prefixed descriptor and row bytes; SHA-256. Golden vector `contracts/test-vectors/daily_state_fingerprint.v1.json`, verified by the checker. Six tests show that the index, column order, dtype, names, row count and values each change it | Contract §2.11, §9.1 A-2; arch §6.2, §7.4; checker `daily_state_fingerprint`; tests |
| Venue order | Ascending ordinal (code-point) `bridge_uid`, no natural or locale sort; a test shows `#1, #10, #2` | Contract §2.11; test |
| Scenario order | `scenarios_sha256` hashes the list sorted by `scenario_id`, and `/v1/scenarios` returns that order. The fixtures are re-sorted, `scenarios_sha256` is recomputed, and the checker rejects an unsorted list. A test shows the hash ignores insertion order | Contract §2.2, §2.7; scenario, version and meta fixtures; checker; tests |

The seven `decision_id` vectors are unchanged: their venues already sort the same way under ordinal order. The tooling now pins `pandas==2.3.3` and `numpy==2.2.6`, the same pins as Phase 1's `requirements.txt`, so CI can run the fingerprint vector.

## 11. Ayush's final corrections (revision 6)

| Correction | Resolution | Where |
|---|---|---|
| **Unsafe integers rejected, not rounded** | An integer-valued number in `transaction` or `state` with absolute value above 2⁵³ − 1 returns `422 VALIDATION_ERROR`, with the value's request path in `details.errors[].field`. The rule depends on the value, not the spelling (integer, decimal or scientific notation), so the backend, whose `JSON.parse` can't tell the spellings apart, and the engine agree. The revision 5 rounding test and the `1e21` equivalence case are replaced by rejection tests. A checker rule reports any fixture that accepts an unsafe integer, or rejects one without naming its field | Contract §2.4, §2.11, §4, §9.1 A-1; checker `binary64`, `check_safe_numbers`; tests |
| **Venue sort for hashing only** | The ordinal `bridge_uid` sort builds the `decision_id` document only. Execution, `allocations[].slot`, the PPO observation and the explanations keep Phase 1's `bridge_network` slot order, matching request venues by `bridge_uid`. The checker verifies each allocation's slot against `/v1/network` and, in explicit mode, its values against the request venue with that `bridge_uid`. A request that only reorders venues is now treated as the same request in the cross-fixture `decision_id` check. A test reorders an explicit fixture's venues: same `decision_id`, identical allocations by slot, no problems. Another relabels slots in request order, and is reported | Contract §2.4, §2.11; checker `check_slot_order`, `register_decision`; tests |
| **Unique scenario IDs** | `scenario_id` values in `/v1/scenarios` are unique. The checker reports a duplicate in the inference and app scenario fixtures; tests cover both | Contract §2.7; checker `check_version_fingerprints`; tests |

The seven `decision_id` vectors and the daily-state fingerprint golden vector are unchanged: none of their inputs is an unsafe integer, and their venues are already in slot order.

## 12. Approved contract corrections (revision 7)

| Item | Resolution | Where |
|---|---|---|
| **Q16** (closed) | Fixed backend messages for every app error, passed-through 4xx included; engine messages never forwarded; only the approved mapped fields kept. The 500-character wording is removed. The passthrough fixtures now carry fixed text, and the checker rejects one that copies the engine message | Contract §4, §9; app OpenAPI `Unprocessable`, `ErrorResponse.message`; `app/errors/409_policy_disabled_passthrough.json`, `app/errors/422_date_in_gap_buffer_passthrough.json`; also `app/errors/503_engine_busy.json` and `app/transactions/200_get_failed.json`, which copied the engine text for a 5xx; checker + test |
| **Q19** (closed) | An audit row only together with a persisted record, in the same DB transaction; a rejected request creates none. The outdated "every mutating call" wording is removed | Contract §6.2, §9 |
| **Validation precedence** | Every `VALIDATION_ERROR` problem is returned first, together; `INVALID_AMOUNT` only for an otherwise valid body. New fixture with a bad country and a zero amount → `VALIDATION_ERROR` on `senderCountry` only | Contract §3.2; `app/errors/422_validation_error_precedence.json`; test |
| **Liveness** | Fixture wording corrected: public `GET /api/v1/health/live`, HTTP 200, exactly `{"status":"ok"}`, no dependency check. The contract says the path and body are final | `app/meta/200_health_live.json`; contract §3.9 |
| **OpenAPI prefix** | `servers.url` is `/`; the paths keep their full `/api/v1/...` form, so a generated client no longer requests `/api/v1/api/v1/...` | `contracts/openapi/app.v1.yaml` |

**Then confirmed by Ayush:** see §13.

## 13. Fee cost and metrics semantics (confirmed by Ayush)

| Confirmation | Applied | Where |
|---|---|---|
| `metrics.fee_cost_usd` = Σ `amount_executed_usd × fee_pct`, executed amounts only, `fee_pct` as the bridge network defines it (a fraction) | Defined in the contract and the schema; the checker already recomputed it this way; a new test shows that requested × fee is rejected | Contract §2.8; inference OpenAPI `Metrics`; test |
| `metrics` always present, every field non-null, rejections included | Already true in both OpenAPI schemas (every field required, none nullable). Now stated, and a test rejects a null metric | Contract §2.8; inference OpenAPI; test |
| Rejection accounting. In `totals`: executed 0, completion ratio 0, amount-based unrouted = full amount, environment unrouted = 0. In `metrics`: fee cost 0, execution costs 0 | The checker enforces fee, cost, latency and risk terms 0, `completion_ratio` 0 and `unrouted_amount_based_usd` = `amount_usd`. The existing rejection fixture already satisfied all of it | Contract §2.8; checker; 5 tests |
| No `PARTIAL_COMPLETION` and no `RISK_FALLBACK_USED` on a rejection | Already enforced; now stated together | Contract §2.8 |
| `decision_id` is Dev A's job; the backend treats it as opaque and never recalculates it | Stated | Contract §2.11, §9.1 |

**Resolved by Ayush: unrouted accounting on a rejection.**
- `unrouted_amount_based_usd` = the full amount (executed is 0).
- `unrouted_env_usd` = 0, preserving the Phase 1 accounting, where `requested_usd = 0`.
- Both fields stay present and non-null.
- The checker enforces both, plus `unrouted_term_env = 0`, `reward_env = 0` and `unrouted_term_amount_based = 1` (contract §2.8; tests). The existing rejection fixtures already matched, so none changed.

**Backend follow-up (implementation only):** with metrics confirmed non-null, the `RoutingDecision` reward and term columns that are nullable today (`rewardEnv`, `rewardAmountBased`, `latencyTerm`, `riskTerm`, marked "PROVISIONAL: nullable") can be made non-null, in the same migration as `feeCostUsd`.

## 14. Ayush's decisions W1 and F1 (revision 8)

**W1: documentation correction.** The rejection rules in contract §2.8 now keep `totals` and `metrics` apart:
- in `totals`: `requested_usd = 0`, `executed_usd = 0`, `completion_ratio = 0`, `completed = false`;
- in `metrics`: `fee_cost_usd = 0`, and `cost_term`, `latency_term` and `risk_term` all 0.

Before, `executed_usd` and `completion_ratio` were listed under `metrics`, where those fields don't exist. The same fix is made in §9.1 (A-8) and in §13 above. The checker already enforced the right fields in the right objects, so no checker or fixture change was needed.

**F1: Phase 1 cost-baseline unit (outstanding technical finding).** This is separate from the Phase 2 contract. Nothing in Phase 1 was changed, no division by 100 is applied anywhere, and the reward calculation is untouched.

*What was traced:*
1. **Origin.** `real_cost_baseline` is the median of the raw RPW column `cc2 total cost %` per corridor-quarter (`src/preprocessing/rpw.py:112`). It is stored in `data/processed/rpw_corridor_quarterly.parquet`.
2. **Stored values are sized like percentage points.**
   - USA→IND 2023: 2.30, 2.74, 2.64, 2.745. GBR→PHL 2023: 2.00, 2.05, 1.57, 1.39. USA→MEX 2023: 3.08, 2.88, 2.605, 3.04.
   - Across all 17,202 rows: median 3.82, 97.4% of rows above 1, 40 negative values, maximum 51.73. As fractions these would mean a 5,173% cost and a negative cost of up to 2,967%, which is implausible; as percentage points they are ordinary.
3. **Consumers treat it as a fraction.**
   - `src/training/cost_baseline.py` says "as a fraction, e.g. 0.05 = 5%" and returns the value unchanged.
   - `src/envs/cbdc_env.py` passes it as `baseline_cost_pct`.
   - `src/envs/reward.py` computes `baseline_cost = baseline_cost_pct × executed` and subtracts fees that are fractions (`fee_pct` 0.015 means 1.5%). Its placeholder default is 0.05.
   - So a stored 2.05 enters the reward as 205%, not 2.05%: about 100 times too large relative to the fees.
4. **Supporting, not conclusive.** The recorded Phase 1 mean rewards are about +0.9 (`docs/STAGE1D_RESULTS.md`), which is consistent with a cost term near 2, not near 0. I did not recompute the reward components.

*What could not be confirmed.* The raw RPW workbook is not in this checkout (`data/raw/.cache/` is git-ignored and absent), so the unit of `cc2 total cost %` was **not verified at its source**. Someone with the raw workbook must confirm the column's documented unit. The stored values strongly indicate percentage points; that is the evidence above, not a confirmed fact.

*Related points for the review.*
- **Mixed units in Phase 1:** when the RPW lookup is unavailable the reward falls back to the placeholder 0.05, a fraction. The ARE→MEX fallback is a median of the same column, so it carries the same unit as the lookup.
- **Phase 2:** `metrics.baseline_cost_pct` reports exactly what Phase 1 returns (for example 2.05). The contract's illustrative fixtures use 0.0612 and small rewards, which do not match real engine magnitudes. Dev A's engine-generated fixtures will show the real values. How the UI labels this field is pending F1.
- **Any correction** would change every Phase 1 reward and the reported results, so it must be separately reviewed and versioned (an `engine_version` bump, which changes every `decision_id`). It is not proposed here.

**Next step (Ayush):** confirm the raw unit, then decide whether to open a versioned Phase 1 change. Until then, nothing changes.

## 15. Anvesh's PR #4 comments (revision 9)

| Comment | Resolution | Where |
|---|---|---|
| Validation precedence | Spelled out in order: (1) every schema problem first, together, including an `amountUsd` that is missing, not a number or not finite; (2) only for an otherwise valid body, a finite `amountUsd` ≤ 0 returns `INVALID_AMOUNT`. No caller value and no engine message is echoed. The `INVALID_AMOUNT` row in §4 and the OpenAPI `amountUsd` description (both request schemas) now agree | Contract §3.2, §4; app OpenAPI |
| Audit atomicity | Stated as the approved team decision: each record and its audit row in the same DB transaction; if the audit write fails the whole transaction rolls back. The rejected-request rules are unchanged (no record, no audit row). The caller-facing result of a database failure is **not** defined: it stays the open Dev B item (§6) | Contract §6.2 |
| Contract header | Status now reads "approved": merged by the project owner (ayush8771) through PR #3 on 4 November 2026, with the follow-up corrections in PR #4. The "proposed for a second team review" wording is removed from both the contract and the architecture headers | Contract and architecture headers |

**One point for Ayush: which source is normative.** The old header said the contract is normative until the OpenAPI files are approved and merged, and the OpenAPI files after that. PR #3 merged them, so that rule may now apply. I did not decide it. The header now says the two describe one contract, that a difference is a bug, and that this document is the reference until the owner confirms. These still say "DRAFT pending approval" and were not changed in this revision:
- `contracts/README.md` (status line);
- the `info.description` of both OpenAPI files.

They need a one-line update once the owner confirms.
