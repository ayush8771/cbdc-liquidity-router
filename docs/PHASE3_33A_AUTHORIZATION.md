# Phase 3.3-A: Implementation Authorization Request (synthetic-only adapter foundation)

**Status: DRAFT v0.2, 26 November 2026. Every decision below is [PROPOSED]. Nothing here is approved, nothing is authorized, and no gate passes.** This document **requests** the approvals that the synthetic-only part of milestone 3.3 needs; it does not record them and must not be cited as if it did. Until §10's sign-offs are complete and recorded, **the work may not begin** (F-1, D-22), and the statement "3.3-A is authorized" is false.

**Revision v0.2, 26 November 2026 — still DRAFT.** Applies the three **CHANGES_REQUESTED** reviews of PR #37 — **Varshini (Dev C)** B1–B3, **Nisarga (Dev D)** items 1–7, and **Anvesh (Dev B)** items 1–3 — whose texts are on that pull request, not in the repository. Documentation only. It approves nothing, and it does **not** resolve the two findings that are genuinely the owner's: those are stated as blockers in §13 rather than answered. Changes: the milestone, placement and ownership are stated against AD-1 Part 2 §2.2's component register (§2.1, Varshini B1); the published-status claim is corrected, because ingestion publishes no status at all (§4.3, Varshini B2); the AD8-Q5 claim is withdrawn (§5.4, Varshini B3); C-b's predicate is widened in AD-5 v0.6 §8.2b and reflected here (§4.2, Anvesh 2); the `source_id` containment claim is corrected (§6.1, Anvesh 2); the seed-allocation record, the fixture-origin format, registry packaging and CI coverage are specified (§6.1, §6.2, §7.4, Nisarga 2, 5, 6); AD5-Q11 is answered for the two paths (§4.6, Nisarga 7); the acceptance criteria gain shutdown, plausibility-bound and collision cases and criterion 9 is split (§9, Nisarga 3, 4, Anvesh 3); and §10 sets out the two authorization routes without choosing between them (Nisarga 1, Anvesh 1).

**Leads:** **Dev A** for the adapter contract inside C-1, **Dev D** for the synthetic adapter and harness (C-3). **Approver:** project owner. **Required reviewers:** §10.
**Scope source:** `docs/PHASE3_SCOPE.md` v1.4 §2.2.2 (the D-24 F-1 exception, as precedent only), §2.3 **F-1**, §7.1 (milestone 3.3), §7.2, §12 remaining item 1; D-20, D-22, D-23.
**Depends on:** the AD-1 component view v0.5, AD-4 v0.2 and AD-6 v0.2 (each approved **for the D-24 slice only**), and the DRAFT documents AD-1 Part 2 v0.4, AD-4 Part 2 v0.2, AD-5 **v0.6**, AD-6 Part 2 v0.2, AD-8 v0.6, AD-12 v0.3.1.
**Changes no code, no contract, no schema, no OpenAPI file, no Compose file, no CI workflow and no capability gate.**

---

## 1. What this document is, and what it is not

**It is** a single place to decide the smallest set of open questions that the synthetic-only adapter foundation actually depends on, so that they are decided deliberately rather than defaulted by whatever the first implementation happens to do.

**It is not:**

- an approval of AD-1 Part 2, AD-5, AD-8 or AD-12 **as documents**;
- a determination that approving named requirements inside draft documents satisfies **F-1**. That question is the owner's and is stated as **blocker DB-1** (§13);
- an authorization of **3.3-L** (one Gate 3-approved provider end to end), or of 3.2, 3.4, 3.5, 3.6 or 3.7;
- Gate 1, Gate 2, Gate 3 or Gate 4 evidence. **All four gates remain closed;**
- a change to any text approved for the D-24 slice. Where this document and an approved text could be read as disagreeing, **the approved text wins** and the disagreement is a defect here.

### 1.1 "3.3-A" names a part of 3.3-S, not a new milestone

Scope §7.1 defines milestone 3.3 with two exits, **3.3-S** (synthetic) and **3.3-L** (live). **There is no milestone "3.3-A" in the scope, and this document does not create one.** "3.3-A" is a label for the **first, synthetic-only part of 3.3-S**: the adapter contract, one synthetic adapter, and the outage and stale handling that 3.3-S's "before its gate" column names. 3.3-S's exit — *"synthetic adapter feeding the envelope, faults handled"* — is **not** claimed by this scope, because fault injection against a controllable fake provider (**A-4**) needs a transport a synthetic source does not have (§9). Reaching the 3.3-S exit therefore needs this work **plus** A-4, which is why the label is useful and why it is not a renaming.

## 2. Prerequisite state, as the repository records it

| Document | State on `feature/phase3-platform` at `002cefe` |
|---|---|
| AD-1 component view **v0.5** | **APPROVED**, 25 November 2026, **for the D-24 slice only**; version-specific. §4's placement of later components is **not** confirmed, so **D-22 is unsatisfied for milestones 3.2–3.7** |
| AD-4 **v0.2** | **APPROVED, D-24 slice only.** F-1 names AD-4 among milestone 3.3's required deliverables, and the slice-only approval does **not** cover 3.3 (§13 **DB-1**) |
| AD-6 **v0.2** | **APPROVED, D-24 slice only**, subject to **D-25**; **B-4 unresolved**; T-5 covers the ingestion side only |
| AD-1 Part 2 **v0.4** | DRAFT. CHANGES_REQUESTED by Dev D and Dev C; applied; **no re-review**, no owner approval |
| AD-5 **v0.6** | DRAFT. CHANGES_REQUESTED by Dev D, Dev C, and Dev B on re-review; applied; **no re-review of v0.6**, no owner approval |
| AD-8 **v0.6** | DRAFT. Same history; **no re-review**, no owner approval. F-5's targets stay provisional; exit criterion 9 unmet |
| AD-12 **v0.3.1** | DRAFT. Dev B approve-with-conditions on v0.3; applied; **no re-review**, no owner approval |
| AD-2 v0.2, AD-3 v0.3, AD-7, AD-9, AD-10 v0.2, AD-11 v0.3, AD-13 v0.3 | DRAFT or unwritten; none approved |

**Consequence.** All three documents F-1 names for milestone 3.3 — AD-4, AD-5 and AD-12 — are either approved for the D-24 slice only or still drafts, and D-22 is unsatisfied. The work is therefore **blocked on authorization, not on design**: §7's scope is implementable the day §10 is complete.

### 2.1 Milestone, placement and ownership (Varshini B1)

Stated against AD-1 Part 2 §2.2's component register, which this document does not change:

| Component | Register entry | Owner | Milestone | Gate | This scope |
|---|---|---|---|---|---|
| **C-1** Ingestion service (`services/ingestion/`) | Hosts the adapters; assembles, hashes and validates envelopes; publishes to the sink | **Dev A** (F-2) | Exists (D-24, synthetic) | — | **In scope:** the adapter contract, `pipeline.py`, the sink, dedup and the internal status machine |
| **C-3** Synthetic adapter and harness | Seeded generator; fault injection; labelling | **Dev D** (AD-12) | **3.3-S** | — | **In scope:** the synthetic adapter, seed allocation and fixture provenance |
| **C-2** Provider adapters | One per Gate 3-approved provider; transport, normalization, provenance | Dev A | **3.3-L** | **Gate 3**, per provider | **Out of scope entirely** (§8 item 1) |
| **C-4** Event distribution | Carries events from C-1 to consumers | Dev B / Dev D | 3.4 | — | **Out of scope** (§8 item 5) |
| **C-6** Observation module (Express) | Current value per subject; freshness evaluation | Dev B | Exists (D-24) | — | **Unchanged** (§4.3, §7.3) |
| **C-8** Observation panel (React) | Values, labels, age, source | Dev C | Exists (D-24) | — | **Unchanged.** No frontend change is requested |

**Ownership is therefore split, and the document now says so.** The contract work is Dev A's under F-2; the synthetic adapter and harness are **Dev D's under AD-12**, as C-3 records. v0.1 named Dev A as sole lead, which was wrong for C-3. Nothing here moves a component between owners or milestones; where this table and AD-1 Part 2 §2.2 could be read as disagreeing, **§2.2 wins**.

## 3. AD-1: component placement (D-22)

Requested against `docs/PHASE3_AD1_ARCHITECTURE.md` v0.4, the material for scope §12 remaining item 1. The approved component view v0.5 is **not** edited.

### 3.1 AD1P2-Q1 — confirm the component inventory and placement **[PROPOSED]**

Confirm AD-1 Part 2 §2.2's inventory and placement as the confirmation of component-view §4, satisfying scope §12 item 1 and **D-22 for milestones 3.2–3.7**. It is v0.5 §4's five rows expanded; **no new capability is introduced**.

What this scope relies on: **C-1** and **C-3** as §2.1 states them. The C-2 row (*"inside ingestion, one per Gate 3-approved provider, with outbound access limited to that provider"*) is confirmed as **placement only** and is not exercised: no provider exists, so nothing acquires outbound access.

**Impact if approved:** the single unblock for any code here. **It authorizes no provider, no egress and no gate.**
**Impact if deferred:** the work cannot start at all, whatever else is decided.

**D-22's reviewers are retained in full** (Anvesh 1): the placement confirmation needs **Dev A, Dev B and Dev C** reviews, and this document does not narrow that list or substitute itself for any of them.

### 3.2 AD1P2-Q5 — the §7.3.1 split **[PROPOSED]**

Adopt AD-1 Part 2 §7.3.1: *"`infra/compose.yaml` is not changed"* is a **D-24 condition**, while *"no Phase 2 service gains a `depends_on` to a Phase 3 one"* and *"components are added, not substituted"* are **permanent architectural rules**.

**Impact if approved:** none directly here — this scope needs no Compose change (§7.4). Its effect is that a later **approved** AD-10 change may modify inference's networking to close B-4. Read as a permanent prohibition, the overlay rule makes **B-4 unclosable**, which no approved decision says.

**D-25 stays limited to the D-24 slice** (Anvesh 1). Nothing in this document extends it to any later milestone or component, and it is not Gate 4 evidence.

### 3.3 AD1P2-Q6 — confirm placement and gate mapping together **[PROPOSED]**

Confirm AD-1 Part 2 §8's deliverable-and-gate mapping **in the same act** as Q1, so that a placement cannot be misread as an authorization of the gated capability placed there. Wording only; no code impact.

**Not requested, and not needed here:** AD1P2-Q2, Q3, Q4, Q7. AD-1 Part 2 is not approvable as a **document** until they are also decided.

## 4. AD-5: the decisions that shape the adapter interface

Requested against `docs/PHASE3_AD5_ADAPTER_CONTRACT.md` **v0.6**. **No event identity changes:** C-1's approved derivation and AD-4 v0.2 are untouched by every item below.

### 4.1 AD5-Q1 — two keys **[PROPOSED]**

Adopt AD-5 §8.1's two keys in place of scope §3.B's single three-part key:

```text
observation_key  = (source_id, event_type, subject, source_timestamp)
idempotency_key  = (observation_key, payload_sha256)
```

`observation_key` detects a **conflict**; `idempotency_key` detects a **duplicate**. **Neither key is an event name.** One key cannot do both: `payload_sha256` is inside the idempotency key, so two events with different payloads have different idempotency keys **by construction**, and the case the single key was meant to catch — one subject, one instant, two values — is caught by `observation_key`, which excludes the hash.

**Implementation impact:** defines `dedup.py` entirely.

### 4.2 AD5-Q8 — three outcomes, their order, and C-b's predicate **[PROPOSED]**

Adopt AD-5 §8.2's three outcomes, both conflict classes alertable (AD-8 §7.3 Q-2), **in the evaluation order C-b, then D, then C-a**, with **C-b's predicate as AD-5 v0.6 §8.2b defines it**:

| # | Condition | Outcome | Behaviour |
|---|---|---|---|
| **C-b** | Same `event_id`, **differing event content** (§8.2b) | **Identity collision** | **Rejected**, counted; the first is kept |
| **D** | Same `idempotency_key` as an event already seen | **Duplicate** | **Discarded**, not rejected and not quarantined; counted |
| **C-a** | Same `observation_key`, different `payload_sha256`, no validated `supersedes` | **Value conflict** | The **first is kept**; the later event is counted and does not become current |

**"Differing event content" is a named field set** (§8.2b): `payload` / `payload_sha256`, the subject, `source_id`, `event_type`, and the identity-bearing provenance **`synthetic.case_id` and `synthetic.generator_version`**. It **excludes** `retrieved_at`, `emitted_at` and `instance_id`, which differ on every ordinary redelivery — including them would turn each redelivery into a rejected collision and break at-least-once delivery.

**Why the widening (Anvesh 2).** `payload_sha256` covers `{event_type, payload}` only, and the `idempotency_key` adds nothing beyond it. So two events from **different generator configurations** sharing a seed, pair, sequence and `source_timestamp` have an identical `event_id`, an identical payload hash and an identical subject, and under the earlier predicate they fell through to **D** and were **silently discarded as duplicates** — the exact C-1 defect. AD-1 §3.4's approved row is keyed on "different **content** or pair", so the wider predicate **aligns** AD-5 with the approved rule.

**Why the order must be explicit.** The earlier result was correct only because of two contingent facts: a collision differing in payload or subject has a different `idempotency_key`; and for the synthetic transport an equal `event_id` at an equal pair and timestamp forces an equal payload, because `event_id = f(seed, pair, sequence, source_timestamp)` while the payload is `f(seed, pair, sequence)`. **The second argument stops holding if AD4P2-Q1 changes the derivation**, and C-a would then merely keep the first where **AD-2 R-8 requires a rejection**.

**No behaviour changes, and nothing approved moves.** The D-24 slice continues to run on **AD-1 §3.4 as approved**, and it runs one generator configuration per process, so no two of its events can differ in `case_id` or `generator_version` while sharing an `event_id`. **§8.2b's field set needs Dev B's confirmation** as the owner of the P-4 acceptance rules.

### 4.3 AD5-Q9 — `down` stays internal, and in this scope it is **not published at all** **[PROPOSED]**

Adopt AD-5 §9.3's mapping — the internal state `down` maps to **`outage`**, and the approved three-value `source.status` enum (`starting`, `ok`, `outage`) is **unchanged**, because the deployed client validates `source` strictly and a fourth value would fault every open stream.

**Correction (Varshini B2). v0.1 of this document said the internal `down` "publishes as `outage`". That conflated two different machines, and it is wrong for this scope.**

- **Ingestion publishes no status.** `contracts/events/ingestion-latest.v1.schema.json` requires `protocol_version`, `instance_id`, `source_id`, `generated_at` and `events`, and has **no status field**. `additionalProperties` is false.
- **The published `source.status` is derived by Express's own poller** (AD-1 §3.2): `starting` until the first successful poll, `ok` after one, and `outage` after 3 consecutive poll failures or 2 s without a success. It is a statement about **Express's poll of ingestion**, not about an adapter.
- **So how does adapter failure reach a viewer here?** Only indirectly, and that is the correct behaviour: a failed adapter stops producing, `/v1/latest` keeps answering 200 with whatever it last held, Express's poller keeps reporting `ok`, and the **values age through `stale` to `unavailable`** on their own (AD-4 §7; AD-8 §5). No status needs to be delivered for the user-facing outcome to be right, which is exactly what AD-5 §3.7 means by "a value whose updates stop simply ages into `stale` and then `unavailable`".
- **AD-5 §9.3's mapping therefore binds nothing in this scope.** It governs the full-Phase-3 path where ingestion's status reaches a consumer. Creating such a path would change `ingestion-latest.v1.schema.json`, an approved contract, and is **excluded** (§8 item 11).

**What is requested is narrower than v0.1 asked for:** adopt the mapping as the **general** rule and as the internal machine's shape, and implement the internal machine **in process only**, with the internal state exposed solely as a metric label and a log field (AD-8 §7.1). Acceptance criterion 5 is corrected accordingly (§9).

`ingestion-latest.v1.schema.json` is added to the untouched-contract list (§7.3).

### 4.4 AD5-Q10 — `supersedes` only from the provider **[PROPOSED]**

Adopt AD-5 §8.2a rule 2: an adapter sets `supersedes` **only** from something the provider actually published, and **never infers a correction** from a value simply differing. Inferring one is what turns a C-a conflict into a silent overwrite. For a synthetic source the rule binds immediately: the generator publishes no corrections, so the synthetic adapter must never set `supersedes` at all.

### 4.5 AD5-Q7 (H-1) — **remains provisional** **[PROPOSED as provisional]**

Delivery semantics are **not** decided here. Record **at-least-once** as the provisional direction, with the decision deferred: **AD-2 states the requirement, AD-3 chooses the mechanism, and both are drafts.** H-2 to H-6 stay open with it.

**Why the work can proceed anyway.** AD-5 §3.7 states what holds under every answer: no observation crosses into routing; a replayed event keeps its original timestamps; loss is counted, never silent; and **no H-answer changes §3.2's adapter operations**. This scope therefore implements the sink's `observations` channel against the existing in-memory `LatestStore` and marks the synthetic source `dedup: within_run`.

**What it must not do:** claim restart-safe deduplication, implement an acknowledgement protocol or a replay window, or present the in-memory sink as the distribution mechanism. AD-1 §4 records that the distribution mechanism **replaces** the poll.

### 4.6 AD5-Q11 — which conflict rule governs which path (Nisarga 7) **[PROPOSED]**

Q11 itself — whether the general rule should be narrowed to the slice's or the slice's widened — **stays open**, as AD-5 §15 proposes. What this document asks the owner to settle is only **which rule applies where**, so the implementation is unambiguous:

| Path | Governing rule | Status |
|---|---|---|
| The existing D-24 generator path (the default, §7.2) | **AD-1 §3.4 exactly as approved**, keyed on `event_id` inequality | **Unchanged.** No reclassification, no new counter, no behaviour change |
| The new adapter path, when a registry record selects it | **AD-5 §8.2** with §8.2b's predicate and the C-b → D → C-a order | New code only |

The two differ in one cell, which AD-5 §8.2 records: two events with the same payload and different `event_id`s are AD-1's **conflict** in the slice and AD-5's **duplicate** in the general rule. That cell is reachable in the slice only through a generator restart that realigns a pair's timestamp at a different sequence — the case **AD-1 §3.4.1 records as "not a defect, for the record"**. The two paths are not run against one consumer in this scope: the adapter path is selected by a registry record, and no record selects it by default.

**Not requested:** AD5-Q2, Q3, Q4, Q5, Q6. No synthetic source exercises them.

## 5. AD-8: a deliberately partial approval

Requested against `docs/PHASE3_AD8_BUDGETS.md` **v0.6**. **Only the groups below are requested.** Approving AD-8 as a document would make F-5's targets final (D-12) and is **not** asked for; exit criterion 9 would still need §9's load tests.

### 5.1 Synthetic-transport timing (§3.5, synthetic column only) **[PROPOSED]**

| Setting | Value |
|---|---|
| Connect, read, backoff base and ceiling, `Retry-After` clamp, breaker, max body | **n/a** — a synthetic source has no network |
| Outage: consecutive failures | **3** |
| Outage: silence window | **3 × `expected_interval_ms`** |
| `dedup_window` | **300 s** (§5.3) |
| Shutdown budget, `stop()` | **2 000 ms** (§5.2) |

Not requested: the `websocket`, `poll` and `scheduled` columns. They belong to 3.3-L.

### 5.2 Cooperative adapter shutdown **[PROPOSED]**

`stop()` completes within **2 000 ms**, **idempotently**, and is safe to call from any state **including mid-`start`**. It is **cooperative**: a cancellation signal is delivered and the adapter returns. Nothing is killed and no thread is terminated from outside, which is why the budget is a deadline the adapter must meet rather than a timeout the service enforces by force. Acceptance is §9 criteria 13–15.

The service-level 10 s total shutdown budget (§8.2) is **not** requested: it concerns Express, the hub and the database, none of which this scope touches. The D-24 assertion `sigterm: the backend exits 0` keeps its current meaning.

### 5.3 The 300 s dedup window **[PROPOSED]**

`dedup_window = 300 s` for the synthetic transport: long enough to cover a redelivery, short enough to bound memory. A duplicate arriving after the window is handled by §8.3's ordering rule — it is older, so it does not become current, and it is counted as late.

**Not approved with it:** restart-safe deduplication (AD-5 §8.5), which depends on AD5-Q7 and stays provisional. Here the window is **in-process only**, and the source is marked `dedup: within_run`.

### 5.4 Synthetic freshness profile (§4.2 synthetic row, §4.3) **[PROPOSED]**

| Setting | Formula | At the slice's 2 000 ms interval |
|---|---|---|
| `expected_interval_ms` | As configured | 2 000 |
| `live_max_age_ms` | **null — never Live** | null |
| `stale_after_ms` | **3 × interval** | 6 000 |
| `unavailable_after_ms` | **15 × interval** | 30 000 |
| `clock_tolerance_ms` | **1 000** | 1 000 |

A synthetic value is labelled **Simulated** by AD-4 §8.1 rule 4, which precedes the Live rule, so `live_max_age_ms` is null to state that plainly rather than leave a dead setting in the registry.

**Scope of what this decides (Varshini B3).** Granting this row adopts `3 × interval` **for the synthetic category only**. It does **not** decide **AD8-Q5**, which asks whether `3 × expected_interval_ms` becomes the **general** stale rule across every provider category; that stays **open**, and the FX-streaming, FX-polled, economic-indicator, announcement, holiday and manual rows are **not** requested. v0.1 of this document claimed the synthetic grant "also decides AD8-Q5", which was wrong: a decision about one category cannot settle a rule about all of them, and the provider categories have no approved provider to validate them against.

**AD8-Q6** *is* decided by this grant — age from `source_timestamp`, falling back to `retrieved_at` — because the synthetic profile rests on it directly. (For the D-24 slice the fallback is unreachable: AD-1 §3.4 rejects a null `source_timestamp` outright, and that approved rule is unchanged.)

**D-24 behaviour is preserved, and the earlier wording error stays corrected.** The slice's approved profile is 2 000 / null / 6 000 / 30 000 / 1 000, which **equals** §4.2's synthetic row at every setting: **15 × 2 000 ms = 30 000 ms**. AD-8 **v0.6 §4.3** records this with a four-row table, in place of the claim that the slice satisfied only "the first three settings" and that 30 000 was "tighter". The slice's values stay exactly as approved, and the coincidence is **not** evidence that §4.2's multiples are validated: 30 000 ms is the only one of these figures that has ever run.

**Not requested:** AD8-Q1, Q2, Q3, Q4, **Q5**, Q7, Q8, Q9, Q10. **Q4 and Q8 must be settled before milestone 3.4.**

### 5.5 Plausibility bounds (§4.4), synthetic only **[PROPOSED]**

For the synthetic source the bounds are **the generator's declared range**, never a market range, so a generator defect is caught rather than displayed. `max_relative_jump` **20%** from the subject's current value within one `expected_interval_ms`. The D-24 generator's rates are deliberately unrealistic (AD-1 §3), which is why no market range may be attached to them. A breach is a **quarantine**, not a rejection and not a silent clamp. Acceptance is §9 criterion 16, boundaries included.

## 6. AD-12: collision safeguards, controlled seeds, fixture provenance

Requested against `docs/PHASE3_AD12_SYNTHETIC_HARNESS.md` **v0.3.1**. Part B (quarantine and review queue) is **not** requested: it is `[PENDING: AD-10, AD-11]` and feeds milestone 3.6.

### 6.1 The C-1 collision safeguards **[PROPOSED]**

**The approved C-1 derivation `UUIDv5(namespace, seed | pair | sequence | source_timestamp)` is unchanged, and this document proposes no change to it.**

**Correction (Anvesh 2).** v0.1 said that making a second generator configuration a second `source_id` means "a collision becomes two distinct observation streams rather than two names for one". That overstated it. `source_id` is **absent from the derivation**, as AD-4 Part 2 §3.4 item 3 itself says ("enters the derivation through nothing"), so two `source_id`s **do not prevent the `event_id` collision**. What they separate is the **lookup keys** — `source_id` is `observation_key`'s first component — so the two streams no longer overwrite each other's dedup state. The collision still occurs and is still detected. **The applicable preventive safeguards are coordinated seed allocation and the start-up overlap refusal**, not the `source_id` rule.

Adopt AD-12 §3.1's three mitigations as **requirements**, with the mechanism specified (Nisarga 5):

1. **Coordinated seed allocation.** Every synthetic source, load profile and run takes its seed from a **recorded allocation**: a version-controlled file, `services/ingestion/cbdc_ingestion/registry/seed_allocations.json`, listing each allocation's seed, `source_id`, subject set and intended period. **It is read-only at runtime and is never written by the process.** That is required by the container posture — read-only root filesystem, no volume, no published port (`infra/compose.observations.yaml`) — so a runtime-written ledger is impossible here, and a reviewed file in source control is the only form the record can take. Changing an allocation is a reviewed commit, which is the audit trail.
2. **Disjoint subjects.** Sources registered at the same time use disjoint pair sets, so `pair` never repeats across them. Enforced over the allocation file at start.
3. **A start-up refusal.** The service **refuses to start** a synthetic source whose `(seed, pair)` overlaps another allocation marked active for the same period, or whose record is absent from the allocation file. The check is **in-process and local**: it reads the allocation file and the records the service is starting, and it **cannot** detect a second container started independently against the same consumer — a limitation stated in §12 item 8, not papered over.

Adopt with them **AD-4 Part 2 §3.4 item 3** as a configuration rule: the registry permits **one active generator configuration per `source_id`**, and a second configuration is a **second `source_id`**, which enters the `idempotency_key` as its first component. Its benefit is dedup-state separation, per the correction above.

Adopt the operational rule of **AD-5 §8.2 / AD-2 R-8**: load and fault runs must not overlap with a shared seed; a run that does is **invalid as a performance result** and may be excluded from throughput and latency figures, but its collisions are still **detected, rejected, counted and recorded**. **Exclusion applies to the result, never to collision detection.**

**Not requested:** **AD4P2-Q1**, the derivation fix adding `generator_version` and `case_id`. It would change approved text and belongs to a new generator version. **The broader C-1 residual risk stays open** (AD-5 §14 item 5, AD-4 Part 2 §3.4, AD-12 §9).

### 6.2 Fixture provenance, with a format **[PROPOSED]**

AD-12 §3.4 leaves the format `[OPEN]`, which makes §9 criterion 8 untestable as written (Nisarga 2, Anvesh 3). The format requested here is the **minimum that makes the check mechanical**, and it is proposed **for this scope's own fixtures**; AD-12 keeps ownership of the general question.

**Scope of enforcement: fixtures this work adds**, under `services/ingestion/tests/fixtures/` and `contracts/events/registry/fixtures/`. **Existing fixtures are not touched, re-labelled or moved** — including everything under `contracts/events/fixtures/` and, absolutely, `contracts/test-vectors/event_payload_hash.v1.json`, which is **T-7 protected** and whose only authorized addition is already recorded in `AUTHORIZED_ADDITIONS`. The check **skips** paths it does not own, and §9 criterion 8 asserts that it skips them rather than passing them silently.

**Format.** A sibling `*.origin.json` for each fixture, or an `_origin.json` manifest per directory, with exactly:

```json
{
  "origin": "synthetic",
  "seed": 20261126,
  "generator_version": "1.0.0",
  "case_id": "normal",
  "created": "2026-11-26",
  "note": "optional, one line"
}
```

`origin` is **`synthetic`** (then `seed`, `generator_version` and `case_id` are required) or **`hand-written`** (then they must be absent). **No other value is accepted**, which is the point: a fixture recorded from a provider has no legal `origin`, so it cannot be added without declaring an illegal one. A fixture with no origin record, an unknown `origin`, or a field set that does not match its `origin` **fails CI**. This satisfies AD-5 §13 **A-10** and AD-8 §9 **N-12**, and it changes no envelope field: the envelope's `synthetic` block already carries seed and generator version (AD-4 §3.2) and is **not** touched.

### 6.3 Load modes — **not requested** **[remains open]**

AD-12 §3.3's Sustained, Peak A and Peak B modes stay unselected. **Peak A (100/s for 10 s) and Peak B (200/s for 60 s) conflict and neither is chosen** (AD-3 §10, X-1). This scope needs only the existing 2 events/s over four pairs, which is where the built generator tops out.

## 7. Implementation scope

Requested as the **complete and exclusive** scope. Everything is additive and inside `services/ingestion/`, which is **not** a T-7 protected path.

### 7.1 New files

| File | Contents |
|---|---|
| `services/ingestion/cbdc_ingestion/adapters/__init__.py` | Package marker |
| `…/adapters/base.py` | AD-5 §3.2's operations — `describe`, `start(context)`, `poll`/`subscribe`, `normalize(raw)`, `health`, `stop` — and §3.3's state machine, including `failed_permanent` with **no automatic restart** |
| `…/adapters/context.py` | `AdapterContext`: injected clock, sink, credential resolver, metrics recorder, cancellation signal. **Never** a database handle, an inference client or a filesystem writer (AD-5 §3.2, §11) |
| `…/adapters/registry.py` | The §2.2 registry record as version-controlled configuration, plus the **A-2** startup validation and §6.1's seed-overlap refusal |
| `…/adapters/faults.py` | AD-5 §7.1's taxonomy, recoverable versus permanent. Network members are defined but unexercised here |
| `…/adapters/synthetic_fx.py` | The first adapter: wraps the existing `FxGenerator`. **Values only** — no envelope, no hash, no I/O |
| `…/sink.py` | The abstract sink, three channels (`observations`, `quarantine`, `faults`). `LatestStore` becomes the in-memory `observations` implementation |
| `…/dedup.py` | AD5-Q1's two keys and AD5-Q8's outcomes in the order **C-b, D, C-a**, with §8.2b's predicate; window from §5.3; `within_run` scope |
| `…/status.py` | AD-5 §9.2's internal machine, **in process only** (§4.3): exposed as a metric label and a log field, never serialized to a wire body |
| `…/pipeline.py` | AD-5 §3.4's six service-side steps, factored out of `service.py` |
| `…/registry/sources.json`, `…/registry/seed_allocations.json` | The one synthetic record and the seed allocations, **inside the package** (§7.4) |
| `services/ingestion/tests/test_*.py` | The suites named in §9. **All under `services/ingestion/tests/`** — never the repository-root `tests/`, which is **T-7 protected** |
| `contracts/events/registry/source-record.v1.schema.json` | The registry-record schema, for review and for validation by the ingestion suite (§7.4). Not under `contracts/openapi/`, `contracts/fixtures/` or `contracts/test-vectors/`, all of which are T-7 protected |
| `infra/testing/fake_provider/` | A controllable fake provider, **test-only**. Outside the ingestion build context, so it cannot enter the image (§7.4). Created for **A-4**; **unexercised here**, which has no transport to fault |

### 7.2 Changed files

| File | Change |
|---|---|
| `cbdc_ingestion/service.py` | Drive an adapter through `pipeline.py`. **The existing generator path stays the default**, so D-24 behaviour is bit-identical until a registry record selects the adapter path. No record selects it by default |
| `cbdc_ingestion/settings.py` | Registry and allocation paths; §5.1 and §5.4's values, as defaults a record may tighten and never loosen |
| `services/ingestion/README.md` | The adapter contract as implemented, and its limits |

### 7.3 Untouched, by rule

`envelope.py`, `canonical.py`, `validation.py` and `generator.py` keep their semantics exactly. Unchanged contracts: **`contracts/events/ingestion-latest.v1.schema.json`** (§4.3), `contracts/events/event-envelope.v1.schema.json`, `contracts/events/stream-message.v1.schema.json`, `contracts/test-vectors/event_payload_hash.v1.json`, every file under `contracts/openapi/` and `contracts/fixtures/`. Unchanged besides: `infra/compose.yaml`, `infra/compose.observations.yaml`, `services/ingestion/Dockerfile`, every CI workflow, and all of `src/`, `tests/`, `services/inference/`, `services/backend/` and `services/web/`.

### 7.4 Packaging and CI coverage (Nisarga 6)

**How the registry reaches the runtime image — with no packaging change.** The ingestion build context is `services/ingestion/` and the Dockerfile's only copy is `COPY cbdc_ingestion/ /app/cbdc_ingestion/`. The records therefore live **inside the package**, at `cbdc_ingestion/registry/`, where the existing `COPY` already carries them. **No Dockerfile change, no `.dockerignore` change, no Compose change and no build-context change is requested.** They are read-only data, which suits the read-only root filesystem and the absence of any volume.

**Why the schema is not in the image.** `contracts/events/registry/source-record.v1.schema.json` is outside the build context by construction. It is a review and test artefact; the runtime validates records with the code in `adapters/registry.py`, not by loading a schema file.

**How CI actually validates it.** The `ingestion-unit` job runs `python -m pytest -q` in `services/ingestion/` and then `assert_junit_no_skips.py`, so every suite in §9 runs and a skipped or missing test **fails the job**. The schema-versus-record conformance check is therefore a **test in that suite**, not a new workflow step. `phase3-observations.yml` already has `services/ingestion/**` in its path filter, so the workflow triggers.

**What is deliberately *not* requested:** extending `infra/scripts/check_event_contracts.py` or `check_contracts.py` to cover `contracts/events/registry/`. Those scripts are **Dev D's (P-8)**, `check_contracts.py` does not cover `contracts/events/` at all today, and a CI change needs its own authorization. **If the owner or Dev D prefers the schema to be checked by the `contracts` job instead, that is a CI change this document does not authorize and would need adding to §10.**

**Fake-provider exclusion is verified, not assumed.** `infra/testing/fake_provider/` is outside `services/ingestion/`, so it is outside the build context — the same reason `infra/testing/fault_ingestion/` is absent from every runtime image. §9 criterion 11 asserts it mechanically.

## 8. Exclusions

This scope does **not** include, and must not be read as authorizing:

1. **Any real provider**, and no contact with one — not even for a recorded sample or fixture — before **Gate 3** (D-5, D-17). **C-2 is out of scope entirely.**
2. **Any outbound network access from ingestion.** The D-24 posture is unchanged and ingestion contacts nothing at all. Egress does not exist and its enforcement is unspecified (AD-5 §14 gap 2; AD-10; milestone 3.2).
3. **Any credential.** The registry has a `credential_ref` field; this scope populates it for **no** source and implements no resolution.
4. **Restart-safe deduplication, acknowledgement or replay** (§4.5).
5. **The distribution mechanism** (C-4). AD-2 and AD-3 are drafts; the in-memory sink is the slice's choice and not a template.
6. **Any capability activation.** `ppoProjected` stays disabled, the OpenAPI files stay DRAFT, and no observation reaches the routing engine: `usage` is `display_only` on every envelope (AD-4 §2; D-9, D-15), and AD-6's controls apply to synthetic adapters too (AD-6 §1).
7. **Any Phase 1 or Phase 2 behaviour change**, and no frontend change: **C-6 and C-8 are untouched** and no Dev C work is requested.
8. **Any change to approved text.** AD-1 component view v0.5, AD-4 v0.2 and AD-6 v0.2 are untouched, as are C-1's derivation, C-2's limits and AD-1 §3.4.
9. **Load modes beyond 2 events/s** (§6.3), and more than the four allowlisted pairs: a fifth pair is a **protocol change** (AD-8 §6.2.1a; AD4P2-Q7).
10. **Any CI, Docker, Compose or packaging change** (§7.4).
11. **Giving ingestion a published status field** (§4.3), which would change an approved contract.
12. **Milestone 3.3-L, 3.2, 3.4, 3.5, 3.6 and 3.7**, the 3.3-S exit itself (§1.1), and **all four gates**, which remain closed.

## 9. Acceptance criteria

The AD-5 §13 obligations are the source. **A-9** runs through the existing D-24 harnesses. Every suite named below lives under **`services/ingestion/tests/`** and runs in the `ingestion-unit` job (§7.4).

| # | Criterion | Suite |
|---|---|---|
| 1 | **Contract conformance (A-1).** Every adapter passes one shared suite driven by AD-5 §3.2's operations. `describe()` is checked against the registry record; a mismatch is a **startup failure**, not a warning | `test_adapter_contract.py` |
| 2 | **Registry validation (A-2).** A malformed, inconsistent or incomplete record fails at startup. Negative cases: a `synthetic.` prefix with a non-synthetic class; a transport mismatch; a `real` source with no active Gate 3 reference; a freshness profile breaking AD-4 §7's ordering invariant | `test_registry.py` |
| 3 | **Registry schema conformance.** Every shipped record validates against `source-record.v1.schema.json`, and a deliberately invalid record fails — so the schema is **exercised**, not merely present (§7.4) | `test_registry_schema.py` |
| 4 | **Determinism (A-3).** A fixed seed and injected clock reproduce identical payloads, `payload_sha256` values and `event_id`s **across process restarts** | `test_adapter_determinism.py`; the existing `test_restart_identity.py` still passes unchanged |
| 5 | **Classification (A-5, A-6).** The outcomes are produced in the order **C-b, D, C-a**; a collision is **rejected and counted**, a duplicate **discarded and counted**, a value conflict keeps the first. Cases **must include**: (a) a reused `event_id` with an **identical** payload hash and subject but a **changed `synthetic.case_id`**, and (b) the same with a changed `generator_version` — **both classified C-b, not D** (§4.2); (c) a redelivery differing only in `retrieved_at` and `emitted_at`, classified **D**; and the 300 s window **at, inside and outside** its boundary | `test_idempotency.py` |
| 6 | **Internal status machine (A-7), in process only.** Both outage criteria independently; recovery on one successful item; `failed_permanent` **never retries**; the internal `down` and `stopped` states map to `outage` per AD-5 §9.3. **And the internal state is never serialized:** `GET /v1/latest` responses still conform to `ingestion-latest.v1.schema.json` with `additionalProperties: false`, so no status field appears, and Express's poller-derived `source.status` is unaffected (§4.3) | `test_status_machine.py`; the existing `test_http_latest.py` and `test_schema_conformance.py` still pass unchanged |
| 7 | **Normalization (A-8).** Decimal strings survive with trailing zeros; **no float round-trip**; codes map only through the mapping table; a missing required field is a **rejection, not a default** | `test_normalization.py` |
| 8 | **Seed safeguards (§6.1).** The start-up check **refuses** an overlapping `(seed, pair)` and refuses a record absent from the allocation file; disjoint subject sets are enforced; one active generator configuration per `source_id` is enforced, and a second configuration is a second `source_id`. A positive control starts cleanly | `test_seed_allocation.py` |
| 9 | **Fixture provenance (§6.2).** Every fixture **this scope adds** carries a valid origin record; a missing record, an unknown `origin` and a field set inconsistent with its `origin` each **fail**. The check **skips paths it does not own** — including `contracts/events/fixtures/` and `contracts/test-vectors/` — and the test asserts that it skips them rather than passing them silently | `test_fixture_origin.py` |
| 10 | **Gate 3 enforcement, ingestion side (A-11).** With a source's Gate 3 decision reference **absent, inactive or withdrawn**, the adapter **does not start** and the service records the reason. This is a **negative registry and startup assertion** only | `test_gate3_enforcement.py` |
| 10a | **The Unavailable *display* for a withdrawn source's stored values (AD-4 §8.1 rule 2) is deferred**, not claimed: it needs the observation store (AD-11, C-5) and frontend behaviour (C-8), both excluded here (§8 item 7). It is recorded as an obligation of the milestone that builds them | Deferred — no suite |
| 11 | **Test-only code stays out of the image.** `infra/testing/fake_provider/` and `services/ingestion/tests/` are absent from the built ingestion image, asserted over the build context and the image's file list | `test_image_contents.py` |
| 12 | **Boundary (A-9, in part).** `usage: display_only` on every envelope; no adapter emits a bridge-state value, and no such event type exists; the adapter package imports nothing from `src/`, `services/inference/` or any database client | `test_boundary.py`, extended |
| 13 | **Cooperative shutdown within budget.** `stop()` returns and the worker has **exited** within **2 000 ms**, measured on the injected clock and asserted on thread liveness, not only on the call returning | `test_shutdown.py` |
| 14 | **Shutdown during startup and during active work.** Cancellation delivered mid-`start` leaves nothing acquired and the adapter `stopped`; cancellation while an item is being produced loses no accounting — the event is either published or counted, never both and never neither | `test_shutdown.py` |
| 15 | **Repeated and out-of-state `stop()`.** `stop()` is idempotent: calling it twice, calling it on a `created` adapter, and calling it after `failed_permanent` all succeed and change nothing | `test_shutdown.py` |
| 16 | **Plausibility bounds (§5.5).** A value outside the generator's declared range is **quarantined** with its reason, not rejected and not clamped; a relative jump **above** 20% within one interval is quarantined; **at exactly 20%** and at exactly the range endpoints it is **accepted** — the boundary is asserted on both sides | `test_plausibility.py` |
| 17 | **Non-interference (A-9).** AD-6 **T-1, T-2, T-6 and T-10** hold: identical `decision_id` and engine responses, **zero** inference `/v1/route`, `/v1/compare` and `/v1/explain` calls, unchanged tree hashes | The existing `acceptance-stack` and `acceptance-browser` jobs |
| 18 | **No regression.** Phase 1's suite and the existing D-24 ingestion suite pass unchanged; `guards`, `regression-gate`, the four acceptance jobs and the `phase3-acceptance` gate pass | CI on the implementation pull request |

**A-4 (fault injection) is not exercised**, and 3.3-S's exit is therefore not reached (§1.1). A synthetic adapter has no transport to fault; `infra/testing/fake_provider/` is created so A-4 has a home, and the exit record must state A-4 as **outstanding**.

## 10. Required sign-offs — none of these is given

**This document records no approval. Every box is unchecked.**

### 10.1 The authorization route is the owner's to choose (DB-1)

F-1 requires a code milestone's **own required 3.1 deliverables** — for milestone 3.3, **AD-4, AD-5 and AD-12** — to be **approved**, as tightened by D-22 for the AD-1 component view. Two routes exist, and **this document does not choose between them**:

- **Route A — the normal path.** Approve AD-5 and AD-12 **as documents**, and extend AD-4's approval beyond the D-24 slice to cover this work (today AD-4 v0.2 is approved for the slice only). F-1 is then satisfied as written, and the decisions requested in §§3–6 are subsumed by those approvals.
- **Route B — a bounded owner decision.** Record an exception in the form scope **§2.2.2** already uses for D-24, which "waives F-1's requirement for AD-2, AD-3, AD-5, AD-7 to AD-9 and AD-12" for that slice. Such a decision would have to **name which F-1 requirements it replaces**, name the decisions it grants in their place (§§3–6), and state its own boundary, as §2.2.2 does. **D-22 stays mandatory either way**, as it did for D-24.

Both routes keep all four gates closed. **Route B is not a shortcut around review:** the §10.2 reviews are required under it too.

### 10.2 Reviews

- [ ] **AD-1 Part 2 re-review and the D-22 placement confirmation** — **Dev A, Dev B and Dev C** (D-22's named reviewers, retained in full), with **Dev D** on §7.3.1
- [ ] **AD-5 v0.6 re-review** — **Dev B** (§3.6 sink; §3.7 pending semantics; §7 fault classes; **§8.1's keys, §8.2's outcomes and order, and §8.2b's field set, against the P-4 acceptance rules Dev B owns**; §8.4; §8.5; §9; §12) and **Dev D** (§2 registry as configuration; §12.1 posture and egress; §13 CI obligations, fixture origin, the test-only fake provider)
- [ ] **AD-8 v0.6 re-review** — **Dev B** (§8.2 shutdown against `lifecycle.ts`), **Dev C** (§4's monotonic age rule and the null-timestamp label), **Dev D** (§4.3's correction and §9's acceptance tests against the existing CI)
- [ ] **AD-12 review** — **Dev A** (Stage 1E rules, §6.3) and **Dev B** (review-queue persistence), per D-23
- [ ] **C-3 ownership** — **Dev D**, as AD-1 Part 2 §2.2 assigns the synthetic adapter and harness to Dev D under AD-12 (§2.1)
- [ ] **This document** — at least one of Dev B and Dev D, under the **second-reviewer rule (D-20)**
- [ ] **Project owner** — the route of §10.1, the decisions of §§3–6, and the scope, exclusions and acceptance criteria of §§7–9

**On completion**, the decisions are recorded in `docs/PHASE3_SCOPE.md` §2 (3.1 plan §5), the F-1 and D-22 position is recorded with them, and the work of §7 may begin. **No gate passes, no provider becomes approved, and 3.3-L stays blocked on Gate 3.**

## 11. What stays provisional, deliberately

| Item | Why it may stay open |
|---|---|
| **AD5-Q7 / H-1 to H-6** — delivery semantics | AD-2 and AD-3 are drafts. No H-answer changes AD-5 §3.2's operations (§4.5). **Revisit before 3.4** |
| **AD5-Q11** — the keying divergence itself | Only *which rule governs which path* is requested (§4.6); the narrowing question stays open |
| **AD5-Q2, Q3, Q4, Q5, Q6** | No synthetic source exercises them |
| **AD1P2-Q2, Q3, Q4, Q7** | Needed for AD-1 Part 2 as a document; they change no adapter code |
| **AD8-Q5** — the general stale rule | Explicitly **not** decided by the synthetic row (§5.4) |
| **AD8-Q1, Q2, Q3, Q4, Q7, Q8, Q9, Q10** | Latency, capacity and render instrumentation, none reachable at 2 events/s. **Q4 and Q8 before 3.4** |
| **AD-12 load modes, the general fixture-origin format, Part B** | §6.3; §6.2 proposes a format for this scope's fixtures only; Part B feeds 3.6 |
| **AD4P2-Q1** — the derivation fix | Changes approved text; belongs to a new generator version |
| **AD-10, egress, credentials, B-4, Gate 3** | A synthetic adapter acquires no outbound access, credential or volume. **All become hard blockers at 3.3-L and Gate 4** |
| **Whether the registry schema moves into the `contracts` job** | A CI change, Dev D's to own (§7.4); not authorized here |

## 12. Residual risks

1. **The C-1 residual risk is open.** Overlapping runs with the same seed and timestamps but a different `case_id` or `generator_version` produced **40** collisions. §6.1's safeguards are containment; AD-5 §8.2b improves **detection**. **Neither fixes the derivation.**
2. **§4.2's widened C-b is a draft proposal** and needs Dev B's confirmation of its field set. If the set is wrong in either direction, the cost is a redelivery misread as a collision, or a changed configuration misread as a duplicate.
3. **§4.2's formulas in AD-8 are unvalidated.** 30 000 ms is the only one of those figures that has ever run (§5.4).
4. **No load testing.** Exit criterion 9 stays unmet even after AD-8 is approved: it needs a recorded number **and** load tests against it.
5. **A-4 is not exercised**, so the 3.3-S exit is not reached (§1.1, §9).
6. **AD-6 B-4 is unresolved** on the inference side under **D-25, which stays limited to the D-24 slice**. Not Gate 4 evidence; no gate has passed.
7. **Every document this one depends on is a draft without a re-review.** A re-review may change a cited section, in which case the affected request here must be re-stated before it is granted.
8. **The seed-overlap refusal is local.** It reads a version-controlled file in one process and **cannot detect a second container started independently** against the same consumer. Under the read-only, no-volume posture no runtime-shared ledger is available, so this limit is inherent to the scope rather than an omission (§6.1).
9. **The deferred Unavailable display (criterion 10a)** means a withdrawn source's stored values have **no verified user-facing behaviour** until the store and the panel exist. Nothing here stores observations, so nothing is currently displayed from a withdrawn source — but the obligation must travel with the milestone that adds the store.

## 13. Genuine decision blockers — for the owner, not resolvable here

These are **not** answered in this document, and must not be read as answered.

| # | Blocker | Who decides | Why it is not resolved here |
|---|---|---|---|
| **DB-1** | **Does approving named requirements inside draft architecture documents satisfy F-1 and D-22, or must AD-4, AD-5 and AD-12 be approved as documents?** §10.1 sets out Route A and Route B, including that AD-4 v0.2's approval covers the **D-24 slice only** and so does not cover this work. | **Project owner**, with Dev B and Dev D (both raised it) | F-1 is approved text. Choosing a reading of it, or creating a §2.2.2-style exception, is an owner decision; a deliverable document cannot grant itself one. |
| **DB-2** | **Does the registry schema's CI coverage need to move into the `contracts` job**, which would authorize a change to Dev D's `check_event_contracts.py` and to `phase3-observations.yml`? §7.4 proposes the in-suite alternative, which needs no CI change. | **Project owner**, with **Dev D** (owner of P-8) | Any CI change needs its own authorization, and §8 item 10 excludes one. If the answer is yes, §10.2 gains a line and §8 item 10 is amended. |

Nothing else in the three PR #37 reviews was left unresolved: every other finding is applied above or in AD-5 v0.6 and AD-8 v0.6.
