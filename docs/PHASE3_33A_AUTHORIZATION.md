# Phase 3.3-A: Implementation Authorization Request (synthetic-only adapter foundation)

**Status: DRAFT v0.1, 26 November 2026. Every decision below is [PROPOSED]. Nothing here is approved, nothing is authorized, and no gate passes.** This document **requests** the approvals that milestone 3.3-A needs; it does not record them and must not be cited as if it did. Until the sign-offs of §10 are complete and recorded, **milestone 3.3-A may not begin** (D-22), and the statement "3.3-A is authorized" is false.

**Lead:** Dev A. **Approver:** project owner. **Required reviewers:** §10.
**Scope source:** `docs/PHASE3_SCOPE.md` v1.4 §7.1 (milestone 3.3), §7.2, §12 remaining item 1; D-20, D-22, D-23.
**Depends on:** the AD-1 component view v0.5 (approved, D-24 slice only), AD-4 v0.2 (approved, D-24 slice only), AD-6 v0.2 (approved, D-24 slice only, subject to D-25), and the DRAFT documents AD-1 Part 2 v0.4, AD-4 Part 2 v0.2, AD-5 v0.5, AD-6 Part 2 v0.2, AD-8 v0.6, AD-12 v0.3.1.
**Changes no code, no contract, no schema, no OpenAPI file, no Compose file, no CI workflow and no capability gate.**

---

## 1. What this document is, and what it is not

**It is** a single place to decide the smallest set of open questions that milestone **3.3-A** — the local, synthetic-only adapter foundation — actually depends on, so that the decisions are made deliberately rather than defaulted by whatever the first implementation happens to do.

**It is not:**

- an approval of AD-1 Part 2, AD-5, AD-8 or AD-12 **as documents**. Each needs its own review and its own owner approval. This document asks for specific, named decisions inside them;
- an authorization of milestone 3.3-**L** (one Gate 3-approved provider end to end), of 3.2, 3.4, 3.5, 3.6 or 3.7;
- Gate 1, Gate 2, Gate 3 or Gate 4 evidence. **All four gates remain closed** and nothing here moves one;
- a change to any text approved for the D-24 slice. Where this document and an approved text could be read as disagreeing, **the approved text wins** and the disagreement is a defect here.

## 2. Prerequisite state, as the repository records it

| Document | State on `feature/phase3-platform` at `002cefe` |
|---|---|
| AD-1 component view **v0.5** | **APPROVED**, 25 November 2026, **for the D-24 slice only**; version-specific. §4's placement of later components is **not** confirmed, so **D-22 is unsatisfied for milestones 3.2–3.7** |
| AD-4 **v0.2** | **APPROVED**, D-24 slice only; corrections C-1 and C-2 recorded |
| AD-6 **v0.2** | **APPROVED**, D-24 slice only, **subject to D-25**; **B-4 unresolved**, T-5 covers the ingestion side only |
| AD-1 Part 2 **v0.4** | DRAFT. CHANGES_REQUESTED by Dev D and Dev C; findings applied; **no re-review**, no owner approval |
| AD-5 **v0.5** | DRAFT. CHANGES_REQUESTED by Dev D, Dev C and (re-review) Dev B; findings applied; **no re-review**, no owner approval |
| AD-8 **v0.6** | DRAFT. Same review history; **no re-review**, no owner approval. F-5's targets stay provisional and exit criterion 9 is unmet |
| AD-12 **v0.3.1** | DRAFT. Dev B approve-with-conditions on v0.3; conditions applied; **no re-review**, no owner approval |
| AD-2 v0.2, AD-3 v0.3, AD-7, AD-9, AD-10 v0.2, AD-11 v0.3, AD-13 v0.3 | DRAFT or unwritten; none approved |

**Consequence.** Three of the four documents milestone 3.3 depends on (AD-5, AD-12, and AD-8 for its values) are drafts, and D-22 is unsatisfied. 3.3-A is therefore **blocked on approvals, not on design**: the scope in §7 is implementable the day §10 is complete.

## 3. AD-1: component placement (D-22)

Requested against `docs/PHASE3_AD1_ARCHITECTURE.md` v0.4 (AD-1 Part 2), which is the material for scope §12 remaining item 1. The approved component view v0.5 is **not** edited.

### 3.1 AD1P2-Q1 — confirm the component inventory and placement **[PROPOSED]**

Confirm AD-1 Part 2 §2.2's component inventory and placement as the confirmation of component-view §4, satisfying scope §12 item 1 and **D-22 for milestones 3.2–3.7**. It is v0.5 §4's five rows expanded; **no new capability is introduced**.

What 3.3-A relies on from it: the row *"Live adapters — inside ingestion, one per Gate 3-approved provider, with outbound access limited to that provider."* 3.3-A occupies that placement with a **synthetic** adapter, which has no provider, no outbound access and no credential.

**Impact if approved:** this is the single unblock for any 3.3-A code. **It authorizes no provider, no egress and no gate.**
**Impact if deferred:** 3.3-A cannot start at all, whatever else is decided.

### 3.2 AD1P2-Q5 — the §7.3.1 split **[PROPOSED]**

Adopt AD-1 Part 2 §7.3.1: *"`infra/compose.yaml` is not changed"* is a **D-24 condition**, while *"no Phase 2 service gains a `depends_on` to a Phase 3 one"* and *"components are added, not substituted"* are **permanent architectural rules**.

**Impact if approved:** none directly on 3.3-A, which needs no Compose change. Its effect is that a later **approved** AD-10 change may modify inference's networking to close B-4. Read as a permanent prohibition, the overlay rule makes **B-4 unclosable**, which no approved decision says.
**Impact if deferred:** 3.3-A proceeds unaffected; B-4 stays blocked on a wording question. Decide it now while it is free.

### 3.3 AD1P2-Q6 — confirm placement and gate mapping together **[PROPOSED]**

Confirm AD-1 Part 2 §8's deliverable-and-gate mapping **in the same act** as Q1, not as a separate record, so that a placement cannot be misread as an authorization of the gated capability placed there.

**Impact if approved:** wording only; no code impact. It is what keeps Q1 safe to grant.

**Not requested here, and not needed by 3.3-A:** AD1P2-Q2 (six-zone trust model), Q3 (observation logic confined to ingestion and the observation module), Q4 (deployment architecture), Q7 (CODEOWNERS). AD-1 Part 2 is not approvable as a **document** until they are also decided; Q1, Q5 and Q6 can be decided on their own, as named decisions, which is what §10 asks for.

## 4. AD-5: the four decisions that shape the adapter interface

Requested against `docs/PHASE3_AD5_ADAPTER_CONTRACT.md` **v0.5**. **No event identity changes:** C-1's approved derivation and AD-4 v0.2 are untouched by every item below.

### 4.1 AD5-Q1 — two keys **[PROPOSED]**

Adopt AD-5 §8.1's two keys in place of scope §3.B's single three-part key:

```text
observation_key  = (source_id, event_type, subject, source_timestamp)
idempotency_key  = (observation_key, payload_sha256)
```

`observation_key` answers "which observation is this, of what, at what time?" and detects a **conflict**. `idempotency_key` answers "have I already seen exactly this event?" and detects a **duplicate**. **Neither key is an event name.**

**Why one key cannot do both:** `payload_sha256` is inside the idempotency key, so two events with different payloads have different idempotency keys **by construction**, and a rule of the form "the same key with a different payload hash" is unsatisfiable. The case it was meant to catch — one subject, one instant, two different values — is caught by `observation_key`, which deliberately excludes the hash.

**Implementation impact:** defines `dedup.py` entirely. Without this decision there is nothing implementable, because the v0.1 rule it replaces cannot be satisfied.

### 4.2 AD5-Q8 — three outcomes, **and their evaluation order** **[PROPOSED]**

Adopt AD-5 §8.2's three outcomes, with both conflict classes alertable (AD-8 §7.3 Q-2):

| # | Condition | Outcome | Behaviour |
|---|---|---|---|
| **C-b** | Same `event_id`, different payload or subject | **Identity collision** | **Rejected**, counted; the first is kept. The C-1 class of defect |
| **D** | Same `idempotency_key` as an event already seen | **Duplicate** | **Discarded**, not rejected and not quarantined; counted. Normal for a polled source |
| **C-a** | Same `observation_key`, different `payload_sha256`, no validated `supersedes` | **Value conflict** | The **first is kept**; the later event is counted and does not become current |

**And adopt the evaluation order `C-b`, then `D`, then `C-a`** — identity collision **before** duplicate classification. AD-5 v0.4 said only "the first match wins" over a table ordered D, C-a, C-b, which read as the opposite order.

**Why the order must be explicit.** The v0.4 result was correct, but only because of two contingent facts: a genuine collision differs in payload or subject and so has a different `idempotency_key`; and for the synthetic transport an equal `event_id` at an equal pair and timestamp forces an equal payload, because `event_id = f(seed, pair, sequence, source_timestamp)` while the payload is `f(seed, pair, sequence)`. **The second argument stops holding if AD4P2-Q1 changes the derivation** — `generator_version` and `case_id` are exactly the fields that would let one `event_id` carry two different payloads for one subject at one instant, and C-a would then merely keep the first where **AD-2 R-8 requires a rejection**. Stating the order makes the rejection a rule instead of a coincidence.

**This changes no behaviour.** On every case reachable under the current derivations the outcome is identical, and the D-24 slice continues to run on **AD-1 §3.4 as approved**. The correction is applied in AD-5 v0.5 §8.2 and is documentation only.

**Implementation impact:** fixes the classifier's branch order, the counter set, the fault-channel records and the A-5 test matrix.

### 4.3 AD5-Q9 — `down` stays internal **[PROPOSED]**

Adopt AD-5 §9.3's mapping: the internal state `down` publishes as **`outage`**; the approved three-value `source.status` enum (`starting`, `ok`, `outage`) is **unchanged**; the distinction is carried in metrics and the paged S-2 alert.

**Why:** the `stream-message.v1` schema enumerates `source.status` as exactly those three values and the deployed client validates `source` strictly, so publishing a fourth value would **fault every open stream**. A published `down` would need a protocol version change, a coordinated rollout, and AD-7 and AD-9 decisions. It is not proposed.

**Implementation impact:** required before `status.py` and `health()` are written. Gets the adapter's status machine right at the first attempt rather than after a client-side fault.

### 4.4 AD5-Q10 — `supersedes` only from the provider **[PROPOSED]**

Adopt AD-5 §8.2a rule 2: an adapter sets `supersedes` **only** from something the provider actually published, and **never infers a correction** from a value simply differing.

**Why:** inferring a correction is exactly what turns a §8.2 C-a conflict into a silent overwrite. For a synthetic source the rule binds immediately — the generator publishes no corrections, so the synthetic adapter must never set `supersedes` at all.

**Implementation impact:** constrains every future adapter. Cheap to adopt now; expensive to retrofit once an adapter has shipped the inference.

### 4.5 AD5-Q7 (H-1) — **remains provisional** **[PROPOSED as provisional]**

Delivery semantics are **not** decided here. Record **at-least-once** as the provisional direction, with the final decision deferred: **AD-2 states the requirement, AD-3 chooses the mechanism, and both are drafts.** H-2 to H-6 (handoff point, acknowledgement, replay window, slow-consumer behaviour, per-channel semantics) stay open with them.

**Why 3.3-A can proceed anyway.** AD-5 §3.7 states what holds under every answer: no observation crosses into routing; a replayed event keeps its original timestamps; loss is counted, never silent; and **no H-answer changes §3.2's adapter operations**. 3.3-A therefore implements the sink's `observations` channel against the existing in-memory `LatestStore`, and marks the synthetic source `dedup: within_run` — which is what a single in-memory sink gives today in any case.

**What 3.3-A must not do:** claim restart-safe deduplication, implement an acknowledgement protocol, implement a replay window, or present the in-memory sink as the distribution mechanism. AD-1 §4 records that the distribution mechanism **replaces** the poll; the D-24 poll is explicitly not a template.

**Not requested here:** AD5-Q2, Q3, Q4, Q5, Q6, Q11. No synthetic source exercises any of them; Q11's own draft position is "keep both as they are for now".

## 5. AD-8: a deliberately partial approval

Requested against `docs/PHASE3_AD8_BUDGETS.md` **v0.6**. **Only the four groups below are requested.** Approving AD-8 as a document would make F-5's targets final (D-12) and is **not** asked for; exit criterion 9 would still need §9's load tests.

### 5.1 Synthetic-transport timing (§3.5, synthetic column only) **[PROPOSED]**

| Setting | Value | Note |
|---|---|---|
| Connect, read, backoff base and ceiling, `Retry-After` clamp, breaker, max body | **n/a** | A synthetic source has no network |
| Outage: consecutive failures | **3** | |
| Outage: silence window | **3 × `expected_interval_ms`** | |
| `dedup_window` | **300 s** | §5.3 |
| Shutdown budget, `stop()` | **2 000 ms** | §5.2 |

Not requested: the `websocket`, `poll` and `scheduled` columns. They are needed by 3.3-**L**, not 3.3-A, and approving them now would attach values to transports no approved provider exists for.

### 5.2 Cooperative adapter shutdown **[PROPOSED]**

`stop()` completes within **2 000 ms**, idempotently, and is safe to call from any state including mid-`start`. It is **cooperative**: a cancellation signal is delivered and the adapter returns; nothing is killed, and no thread is terminated from outside.

The service-level 10 s total shutdown budget of §8.2 is **not** requested here — it concerns Express, the hub and the database, none of which 3.3-A touches. The D-24 harness assertion `sigterm: the backend exits 0` keeps its current meaning.

### 5.3 The 300 s dedup window **[PROPOSED]**

`dedup_window = 300 s` for the synthetic transport: long enough to cover a redelivery, short enough to bound memory. A duplicate arriving after the window is handled by §8.3's ordering rule — it is older, so it does not become current, and it is counted as late.

**Explicitly not approved with it:** restart-safe deduplication (AD-5 §8.5), which depends on AD5-Q7 and stays provisional (§4.5). For 3.3-A the window is **in-process only**, and the synthetic source is marked `dedup: within_run`.

### 5.4 Synthetic freshness profile (§4.2 synthetic row, §4.3) **[PROPOSED]**

| Setting | Formula | At the slice's 2 000 ms interval |
|---|---|---|
| `expected_interval_ms` | As configured | 2 000 |
| `live_max_age_ms` | **null — never Live** | null |
| `stale_after_ms` | **3 × interval** | 6 000 |
| `unavailable_after_ms` | **15 × interval** | 30 000 |
| `clock_tolerance_ms` | **1 000** | 1 000 |

A synthetic value is labelled **Simulated** by AD-4 §8.1 rule 4, which precedes the Live rule, so `live_max_age_ms` is null to state that plainly rather than leave a dead setting in the registry. `3 × interval` for stale is **F-5's own rule** generalized: two intervals would make normal jitter stale; three means two consecutive misses.

Granting this also decides **AD8-Q5** (adopt `3 × interval` as the general stale rule) and **AD8-Q6** (age from `source_timestamp`, falling back to `retrieved_at`), both of which the synthetic profile rests on.

**D-24 behaviour is preserved, and a wording error is corrected.** The slice's approved profile is 2 000 / null / 6 000 / 30 000 / 1 000. AD-8 up to v0.5 said this satisfied §4.2 "for the first three settings" and that 30 000 was "**tighter**" than 15 × interval. **15 × 2 000 ms = 30 000 ms**, so the fourth setting agrees as well and neither is tighter. AD-8 **v0.6 §4.3** corrects this with a four-row table. The slice's value stays exactly as approved — AD-1 v0.5 requires a mandatory positive `unavailable_after_ms`, a Dev C condition — and the coincidence is **not** evidence that §4.2's multiples are validated: 30 000 ms is the only one of these figures that has ever run.

**Not requested:** AD8-Q1 (T1–T6 latency), Q2 (announcements without `stale_after_ms`, which touches approved AD-4 §7 text), Q3 (availability targets), Q4 (event-rate envelope), Q7 (two delivery guarantees), Q8 (AD-2 reconciliation), Q9 (T6 instrumentation), Q10 (§2.3.1 distinction). None is reachable at 2 events/s with no provider. **Q4 and Q8 must be settled before milestone 3.4.**

### 5.5 Plausibility bounds (§4.4), synthetic only **[PROPOSED]**

For the synthetic source the bounds are **the generator's declared range**, never a market range, so a generator defect is caught rather than displayed. `max_relative_jump` 20% within one `expected_interval_ms`. The D-24 generator's rates are deliberately unrealistic (AD-1 §3), which is why no market range may be attached to them.

## 6. AD-12: collision safeguards, controlled seeds, fixture provenance

Requested against `docs/PHASE3_AD12_SYNTHETIC_HARNESS.md` **v0.3.1**. Part B (quarantine and review queue) is **not** requested: it is `[PENDING: AD-10, AD-11]` and feeds milestone 3.6.

### 6.1 The C-1 collision safeguards **[PROPOSED]**

The **approved C-1 derivation `UUIDv5(namespace, seed | pair | sequence | source_timestamp)` is unchanged**, and this document proposes no change to it. Adopt AD-12 §3.1's three harness-level mitigations as **requirements on 3.3-A**, not merely as recorded proposals:

1. **Coordinated seed allocation.** Every synthetic source, load profile and run takes its seed from a recorded allocation. No two that overlap in time or subjects share one.
2. **Disjoint subjects.** Sources registered at the same time use disjoint pair sets, so `pair` never repeats across them.
3. **A start-up check.** The harness **refuses to start** a synthetic source whose `(seed, pair)` overlaps one already running or recorded for the same period.

Adopt with them the containment of **AD-4 Part 2 §3.4 item 3**: the registry permits **one active generator configuration per `source_id`**, and a second configuration is a **second `source_id`** — which enters the `idempotency_key` as its first component (AD-5 §8.1), so a collision becomes two distinct observation streams rather than two names for one. This is a configuration rule and needs no derivation change.

Adopt the operational rule of **AD-5 §8.2 / AD-2 R-8**: load and fault runs must not overlap with a shared seed; a run that does is **invalid as a performance result** and may be excluded from throughput and latency figures, but its collisions are still **detected, rejected, counted and recorded** exactly as in any other run. **Exclusion applies to the result, never to collision detection.**

**Not requested:** AD4P2-Q1, the derivation fix adding `generator_version` and `case_id`. It would change approved text, belongs to a new generator version, and 3.3-A does not need it. **The broader C-1 residual risk stays open** and is recorded in AD-5 §14 item 5, AD-4 Part 2 §3.4 and AD-12 §9.

### 6.2 Fixture provenance **[PROPOSED]**

Adopt as a requirement on 3.3-A: **every fixture carries its origin** — `synthetic` with the seed and generator version, or `hand-written` — so CI can show that no fixture came from a provider (AD-5 §13 **A-10**; AD-8 §9 **N-12**; D-17). A fixture recorded from a provider is **ingestion** and needs Gate 3.

The **format** stays `[OPEN]` (AD-12 §3.4). The envelope's `synthetic` block already carries seed and generator version (AD-4 §3.2) and is **not changed**.

### 6.3 Load modes — **not requested** **[remains open]**

AD-12 §3.3's Sustained, Peak A and Peak B modes stay unselected. **Peak A (100/s for 10 s, AD-8 §6.2) and Peak B (200/s for 60 s, Dev B) conflict and neither is chosen** (AD-3 §10, X-1). 3.3-A needs only the existing slice mode of 2 events/s over four pairs, and the built generator tops out there.

## 7. Milestone 3.3-A: exact implementation scope

Requested as the **complete and exclusive** scope. Everything is additive, inside `services/ingestion/`, which is **not** a T-7 protected path.

### 7.1 New files

| File | Contents |
|---|---|
| `services/ingestion/cbdc_ingestion/adapters/__init__.py` | Package marker |
| `adapters/base.py` | The §3.2 operations — `describe`, `start(context)`, `poll`/`subscribe`, `normalize(raw)`, `health`, `stop` — and the §3.3 state machine, including `failed_permanent` with **no automatic restart** |
| `adapters/context.py` | `AdapterContext`: injected clock, sink, credential resolver, metrics recorder, cancellation signal. **Never** a database handle, an inference client or a filesystem writer (AD-5 §3.2, §11) |
| `adapters/registry.py` | The §2.2 registry record as version-controlled configuration, plus the **A-2** startup validation |
| `adapters/faults.py` | The §7.1 fault taxonomy, recoverable versus permanent. Network members are defined but unused by a synthetic source |
| `adapters/synthetic_fx.py` | The first adapter: wraps the existing `FxGenerator`. Produces **values only** — no envelope, no hash, no I/O |
| `sink.py` | The abstract sink with three channels (`observations`, `quarantine`, `faults`). `LatestStore` becomes the in-memory `observations` implementation |
| `dedup.py` | AD5-Q1's two keys and AD5-Q8's three outcomes in the order **C-b, D, C-a**; window from §5.3; `within_run` scope |
| `status.py` | AD-5 §9.2's internal machine and §9.3's mapping to the published three-value enum |
| `pipeline.py` | AD-5 §3.4's six service-side steps, factored out of `service.py` |

### 7.2 Changed files

| File | Change |
|---|---|
| `cbdc_ingestion/service.py` | Drive an adapter through `pipeline.py`. **The existing generator path stays the default**, so D-24 behaviour is bit-identical until a registry record selects the adapter path |
| `cbdc_ingestion/settings.py` | Registry path; the §5.1 and §5.4 values, as defaults a record may tighten |
| `services/ingestion/README.md` | The adapter contract as implemented, and its limits |
| `contracts/events/registry/` (new) | The registry-record schema and the one synthetic entry. **Not** under `contracts/openapi/`, `contracts/fixtures/` or `contracts/test-vectors/`, all of which are T-7 protected |
| `infra/testing/fake_provider/` (new) | A controllable fake provider, **test-only and absent from every runtime image**. Present for A-4; **unused by 3.3-A**, which has no transport to fault |

### 7.3 Untouched, by rule

`envelope.py`, `canonical.py`, `validation.py` and `generator.py` keep their semantics exactly. `contracts/events/event-envelope.v1.schema.json`, `stream-message.v1`, `contracts/test-vectors/event_payload_hash.v1.json`, every OpenAPI file, `infra/compose.yaml`, `infra/compose.observations.yaml`, every CI workflow, all of `src/`, `services/inference/`, `services/backend/` and `services/web/`: **unchanged**.

## 8. Exclusions

3.3-A does **not** include, and must not be read as authorizing:

1. **Any real provider.** No provider is approved, none may be contacted — not even for a recorded sample or a fixture — before it has passed **Gate 3** (D-5, D-17).
2. **Any outbound network access from ingestion.** The D-24 posture is unchanged: non-root, read-only root filesystem, `cap_drop: [ALL]`, `no-new-privileges`, no published port, no `env_file`, no volume, and **ingestion contacts nothing at all**. Egress does not exist and its enforcement is unspecified (AD-5 §14 gap 2; AD-10; milestone 3.2).
3. **Any credential.** The registry holds a `credential_ref` field; 3.3-A populates it for **no** source and implements no resolution. Resolution is AD-10's mechanism.
4. **Restart-safe deduplication, acknowledgement or replay.** AD5-Q7 stays provisional (§4.5).
5. **The distribution mechanism.** AD-2 and AD-3 are drafts. The in-memory sink is the D-24 slice's choice and explicitly not a template.
6. **Any capability activation.** `ppoProjected` stays disabled. The OpenAPI files stay DRAFT. No observation reaches the routing engine: `usage` is `display_only` on every envelope (AD-4 §2; D-9, D-15), and AD-6's controls apply to synthetic adapters too (AD-6 §1).
7. **Any Phase 1 or Phase 2 behaviour change.** No reward, environment, policy, checkpoint, data or baseline change; no Phase 2 route, mapper or client change.
8. **Any change to approved text.** AD-1 component view v0.5, AD-4 v0.2 and AD-6 v0.2 are untouched, as are C-1's derivation and C-2's limits.
9. **Load modes beyond the slice's 2 events/s** (§6.3), and more than the four allowlisted pairs: a fifth pair is a **protocol change** (AD-8 §6.2.1a; AD4P2-Q7), not a capacity decision.
10. **Milestone 3.3-L, 3.2, 3.4, 3.5, 3.6 and 3.7**, and **all four gates**, which remain closed.

## 9. Acceptance criteria

Requested as the exit condition for 3.3-A. The AD-5 §13 obligations are the source; **A-9** runs through the existing D-24 harnesses.

| # | Criterion | Evidence |
|---|---|---|
| 1 | **Contract conformance (A-1).** Every adapter, the synthetic one included, passes one shared suite driven by the §3.2 operations. `describe()` is checked against the registry record; a mismatch is a **startup failure**, not a warning | `tests/test_adapter_contract.py` |
| 2 | **Registry validation (A-2).** A malformed, inconsistent or incomplete record fails at startup. Negative cases: a `synthetic.` prefix with a non-synthetic class; a transport mismatch; a `real` source with no active Gate 3 reference; a freshness profile that breaks AD-4 §7's ordering invariant | `tests/test_registry.py` |
| 3 | **Determinism (A-3).** A fixed seed and an injected clock reproduce identical payloads, `payload_sha256` values and `event_id`s, **across process restarts** | `tests/test_adapter_determinism.py`; the existing `test_restart_identity.py` still passes unchanged |
| 4 | **Classification (A-5, A-6).** The three outcomes are produced in the order **C-b, D, C-a**; a collision is **rejected and counted**, a duplicate **discarded and counted**, a value conflict keeps the first and counts; the 300 s window is tested **at, inside and outside** its boundary | `tests/test_idempotency.py` |
| 5 | **Status machine (A-7).** Both outage criteria independently; recovery on one successful item; `failed_permanent` **never retries**; the internal `down` publishes as `outage` and the three-value enum is never exceeded | `tests/test_status_machine.py` |
| 6 | **Normalization (A-8).** Decimal strings survive with their trailing zeros; **no float round-trip**; codes are mapped only through the mapping table; a missing required field is a **rejection, not a default** | `tests/test_normalization.py` |
| 7 | **Seed safeguards (§6.1).** The start-up check refuses an overlapping `(seed, pair)`; one active generator configuration per `source_id` is enforced; a second configuration is a second `source_id` | `tests/test_seed_allocation.py` |
| 8 | **Fixture provenance (§6.2).** Every fixture carries its origin, and a fixture without one **fails CI** | `tests/test_fixture_origin.py` |
| 9 | **Gate 3 enforcement (A-11).** With a source's decision reference absent, inactive or withdrawn, the adapter **does not start**, and stored values of that source display **Unavailable** | `tests/test_gate3_enforcement.py` |
| 10 | **Non-interference (A-9).** AD-6 **T-1, T-2, T-6, T-10** hold throughout: identical `decision_id` and engine responses, **zero** inference `/v1/route`, `/v1/compare` and `/v1/explain` calls, unchanged tree hashes | The existing `acceptance-stack` and `acceptance-browser` jobs |
| 11 | **No regression.** Phase 1's suite and the existing D-24 ingestion suite pass unchanged; `guards` and `regression-gate` pass; the four acceptance jobs and the `phase3-acceptance` gate pass | CI on the implementation pull request |
| 12 | **`usage: display_only` on every envelope**, and no adapter emits a bridge-state value — no such event type exists | `tests/test_boundary.py`, extended |

**A-4 (fault injection) is deferred to 3.3-L with a note**, not silently dropped: a synthetic adapter has no transport to fault. `infra/testing/fake_provider/` is created so that A-4 has a home, and 3.3-A's exit explicitly records A-4 as **not exercised**.

## 10. Required sign-offs — none of these is given

**This document records no approval. Each box is unchecked.**

- [ ] **AD-1 Part 2 re-review** — Dev B, Dev C, Dev D. CHANGES_REQUESTED by Dev C and Dev D is applied in v0.4 but **not re-reviewed** (D-22 names Dev A, B and C for the placement confirmation)
- [ ] **AD-5 re-review** — **Dev B** (§3.6 sink, §3.7 pending semantics, §7 fault classes, **§8.1's keys and §8.2's outcomes and order against the P-4 acceptance rules Dev B owns**, §8.4, §8.5, §9, §12) and **Dev D** (§2 registry as configuration, §12.1 container posture and egress, §13 CI obligations, fixture origin, the test-only fake provider)
- [ ] **AD-8 re-review** — **Dev B** (§8.2 shutdown against `lifecycle.ts`), **Dev C** (§4's monotonic age rule and the null-timestamp label), **Dev D** (§9's acceptance tests against the existing CI)
- [ ] **AD-12 review** — **Dev A** (Stage 1E rules, §6.3) and **Dev B** (review-queue persistence), per D-23
- [ ] **AD-5 v0.5 §8.2 correction** — Dev B, as the owner of the P-4 acceptance rules the order affects
- [ ] **AD-8 v0.6 §4.3 correction** — Dev D, who owns the harness that asserts the slice's values
- [ ] **This document** — at least one of Dev B and Dev D, under the **second-reviewer rule (D-20)**, since Dev A is both lead and approver
- [ ] **Project owner** — the decisions of §3, §4, §5 and §6, and the scope, exclusions and acceptance criteria of §7, §8 and §9

**On completion**, the decisions are recorded in `docs/PHASE3_SCOPE.md` §2 (3.1 plan §5), **D-22 is satisfied for milestone 3.3-A**, and 3.3-A may begin within §7's scope. **No gate passes, no provider becomes approved, and milestone 3.3-L stays blocked on Gate 3.**

## 11. What stays provisional, deliberately

| Item | Why it may stay open |
|---|---|
| **AD5-Q7 / H-1 to H-6** — delivery semantics | AD-2 and AD-3 are drafts. No H-answer changes AD-5 §3.2's operations, so the adapter interface is stable under every outcome (§4.5). **Revisit before milestone 3.4** |
| **AD5-Q11** — the C-a payload-hash versus AD-1 §3.4 `event_id`-inequality divergence | Its own draft position is "keep both as they are"; the divergent cell is the benign post-restart case AD-1 §3.4.1 records |
| **AD5-Q2, Q3, Q4, Q5, Q6** | No synthetic source exercises them |
| **AD1P2-Q2, Q3, Q4, Q7** | Needed for AD-1 Part 2 as a document; they change no adapter code |
| **AD8-Q1, Q2, Q3, Q4, Q7, Q8, Q9, Q10** | Latency measurement, capacity envelope and render instrumentation, none reachable at 2 events/s. **Q4 and Q8 before 3.4** |
| **AD-12 load modes, fixture-origin format, Part B** | §6.3 and §6.2; Part B feeds 3.6 and is `[PENDING: AD-10, AD-11]` |
| **AD4P2-Q1** — the derivation fix | Changes approved text; belongs to a new generator version; 3.3-A does not need it |
| **AD-10, egress, credentials, B-4, Gate 3** | A synthetic adapter acquires no outbound access, no credential and no volume. **All become hard blockers at 3.3-L and at Gate 4** |

## 12. Residual risks

1. **The C-1 residual risk is open.** Overlapping runs with the same seed and timestamps but a different `case_id` or `generator_version` produced **40** collisions. §6.1's safeguards are harness-level containment and **do not** fix the derivation.
2. **The §4.2 formulas are unvalidated.** 30 000 ms is the only one of these figures that has ever run (§5.4). Every other multiple is a design target.
3. **No load testing.** Exit criterion 9 stays unmet even after AD-8 is approved: it needs a recorded number **and** load tests against it.
4. **A-4 is not exercised** in 3.3-A (§9).
5. **AD-6 B-4 is unresolved** on the inference side under D-25. Not Gate 4 evidence, and no gate has passed.
6. **Every document this one depends on is a draft without a re-review.** A re-review may change a cited section, in which case the affected decision here must be re-stated before it is granted.
7. **Approving named decisions inside unapproved documents is unusual.** It is what scope §7.2's approved rule permits — "a code milestone may start once the AD-1 component view and *its own* required 3.1 deliverables are approved" — but the decisions granted here are the named ones only, and **neither AD-1 Part 2, AD-5, AD-8 nor AD-12 becomes an approved document by this route.**
