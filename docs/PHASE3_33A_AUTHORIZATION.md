# Phase 3.3-A: Implementation Authorization Request (synthetic-only adapter foundation)

**Status: DRAFT v0.8, 26 November 2026. Every decision below is [PROPOSED]. Nothing here is approved, nothing is authorized, and no gate passes.** This document **requests** the approvals that the synthetic-only part of milestone 3.3 needs; it does not record them and must not be cited as if it did. Until §10's sign-offs are complete and recorded, **the work may not begin** (F-1, D-22), and the statement "3.3-A is authorized" is false.

**Revision v0.8, 26 November 2026 — still DRAFT.** Records the **PR #38 reviews** and corrects the review record Dev B's review asks for. **Documentation only; it approves nothing, authorizes nothing, grants no decision of §§3–6 and passes no gate.** Changes:

- **§10.2 and §10.3 rows 3 and 5 — Dev B's AD-5 v0.7b technical sign-off at `bfecb46` is recorded**, covering **§8.2b**, **AD5-Q8** and the **scoped 3.3-A acceptance requirements**, on a document his review states is **unchanged since** that commit. Row 5 is **CLOSED**; his earlier CHANGES_REQUESTED on `7557a5a` is closed with it. **AD5-Q8 remains the owner's decision**, the matrix's fields stay `[PROPOSED]`, and **AD-5's own text and status line are left unedited** so the signed-off document is unchanged — the record lives here.
- **§10.2, §10.3 rows 2 and 8 — the AD-1 Part 2 verdicts are recorded:** Dev B **granted** the D-22 technical sign-off on v0.5; Dev D **approved** §7.3/§7.3.1; Dev C required the **§3.2 source-status** correction, now made in **AD-1 Part 2 v0.6**, with his sign-off awaited on it; **Dev A's review is outstanding**.
- **§10.2 and §10.3 row 7 — AD-8 v0.7:** Dev C **PASS** on the synthetic freshness profile and its arithmetic, Dev D **accepted**; **Dev B's re-review and the owner's partial §5 approval stay open**.
- **§10.2 and §10.3 row 4 — AD-12 is now v0.3.6:** Dev B reports the technical content satisfactory with **formal D-23 sign-off pending this correction**; **Dev A's D-23 review is outstanding**.
- **§10.3's preamble is corrected:** it said "Nothing in this table is done", which is no longer true of rows 1, 5, 6 and 8. A technical sign-off closes only the **technical half** of a row that also needs owner approval.
- **No new request, and nothing is relaxed.** All four capability gates stay **closed**, every unresolved decision stays **PENDING**, **D-22 is unsatisfied**, **F-1 is unmet for AD-5 and AD-12**, and **3.3-A is not authorized**. Every review text is **relayed, not quoted**.

**Revision v0.7, 26 November 2026 — still DRAFT.** Documentation only; **it approves nothing, authorizes nothing, grants no decision of §§3–6 and passes no gate.** It applies the owner's internal-consistency corrections of 26 November 2026 across AD-1 Part 2, AD-12 and AD-8, and reflects them here. **Every earlier reviewer correction and sign-off is preserved unchanged**, and the recorded **AD-4 approval extension** (§10.3 row 1) keeps exactly its own scope. Changes:

- **§6.1 — the seed start-up refusal is scoped to the registry-selected adapter path, and the D-24 generator's exemption is stated.** The D-24 generator is env-seeded with no registry or allocation record, so an unscoped refusal would have refused to start the **approved** slice. **Criterion 8** now asserts the exemption instead of assuming it.
- **§6.1 and criterion 2 — synthetic-only registry assertions added:** a synthetic record's **`endpoint` null**, **`credential_ref` null** and **`egress_allowlist` empty**, each asserted individually with a positive control.
- **References refreshed** to **AD-1 Part 2 v0.5**, **AD-8 v0.7** and **AD-12 v0.3.5** (§2, §6, §10.2, §10.3), with what each revision changed recorded.
- **Follow-up on review:** AD-12 became **v0.3.5**, completing the reference refresh — its six **AD-8 v0.6** citations now cite **v0.7** — and correcting §1.1's AD-8 review-status description. Version labels and status only; the sections cited are unchanged by AD-8 v0.6 and v0.7.
- **No new request.** No implementation, contract, schema, Compose, CI or capability-gate change is introduced, and **all four capability gates remain closed**. Route A is unchanged and **every sign-off in §10 is still outstanding** except those already recorded there.

**Revision v0.6, 26 November 2026 — still DRAFT.** Applies **Anvesh's (Dev B's) CHANGES_REQUESTED re-review of commit `7557a5a`** — all six findings. Documentation only; it approves nothing and authorizes nothing. **Nisarga's technical sign-off and approved items, and Varshini's approved Dev C corrections, are preserved unchanged.** Changes:

- **AD-5 → v0.7b: §8.2b is consolidated into one schema-aligned field matrix (§8.2b.1)** covering **nested** fields, each field's **comparison semantics**, the **schema dependency** that constrains any test of it, and its **D-24 slice value**.
- **`source.instance_id` does not exist** (Anvesh 1). `source` is `additionalProperties: false` over exactly `source_id`, `transport`, `source_url` and `gate3_decision_ref`, and the envelope has no top-level `instance_id`. It is a required top-level field of the **batch wrapper** `contracts/events/ingestion-latest.v1.schema.json`, diagnostic only. So `instance_id` is **outside C-b by construction**, and criterion 5's redelivery case now varies it **on the wrapper**, with a byte-identical envelope.
- **The nested `source` fields are classified** (Anvesh 2): `source.transport`, `source.source_url`, `source.gate3_decision_ref` identity-bearing `[PROPOSED]`.
- **`source_timestamp_basis`'s enum is corrected** to **`observed`, `published`, `none`** (Anvesh 3); v0.5 said `provider`, `derived`, `none`. Criterion 5's case uses `observed` against `published` with a **non-null** timestamp, per the schema's nullability rule.
- **`supersedes` is reclassified identity-bearing** (Anvesh 4): producer-declared correction evidence, not processing metadata. The invariant keeping it unreachable in 3.3-A is stated — AD5-Q10 forbids a synthetic adapter from setting it, and the D-24 generator sets `supersedes: None`.
- **`derived_from` is compared as an unordered set** (Anvesh 5), per Dev B's recommendation.
- **Criterion 5 is rebuilt on schema-valid mutations only** (Anvesh 6), with **classifier** tests separated from **envelope-validation** tests, the paired mutations the schema forces, and the `extraction`/`review` provider workflows deferred.
- **`raw_sha256` stays excluded**, which Dev B accepts; its integrity obligations are preserved.
- **Dev B's recommendations are recorded as recommendations**, not approvals. Every field stays `[PROPOSED]` pending **AD5-Q8**. All four capability gates closed; Route A unchanged.

**Revision v0.5, 26 November 2026 — still DRAFT.** Applies **Anvesh's (Dev B's) CHANGES_REQUESTED re-review of commit `a35932d`** — its one remaining blocker — and the two **non-blocking** observations in **Nisarga's (Dev D's) technical approval** of the same commit. Documentation only; it approves nothing and authorizes nothing. **Nisarga's approved items and Varshini's approved Dev C corrections are preserved unchanged.** Changes:

- **`source_sequence` joins AD-5 §8.2b's identity comparison, and v0.7's claim about it is withdrawn as false** (Anvesh). `source_sequence` is a **required** property of `contracts/events/event-envelope.v1.schema.json` under `additionalProperties: false`, `envelope.py` sets it from the same `sequence` that `event_id_for` hashes into the C-1 identity, and **nothing forces a differing sequence to change the payload or the timestamp**. A reused `event_id` differing only in `source_sequence` would have been classified **D** and silently discarded. **Every C-1 derivation input — seed, pair, sequence, `source_timestamp` — is now compared.**
- **AD-5 §8.2b now cross-checks all eighteen envelope properties** against the v1 schema and the C-1 inputs. Four further fields are `[PROPOSED]` as identity-bearing **for Dev B's decision** — `provenance_class`, `derived_from`, `derivation`, `timestamps.source_timestamp_basis` — and the excluded fields each carry their reason, with `raw_sha256` **flagged** as the one genuine judgement call.
- **Criterion 5 grows to eighteen cases**, including the thirteenth Anvesh asked for: a same-`event_id`, **sequence-only** difference, rejected as C-b.
- **The `event_id` index's retention horizon is specified** (Nisarga, non-blocking): the AD-8 `dedup_window`, in process only, comparison fields and not the payload — so **the window bounds detection, not only memory**. Added as residual risk 12.
- **AD-12 → v0.3.3** refreshes the stale **AD-5 v0.4** citations to **v0.7a** (Nisarga, non-blocking).
- **Nisarga's technical sign-off at `a35932d` is recorded** in §10.2 and §10.3 row 6, **scoped to Dev D's perspective**. It satisfies **D-20**. It authorizes no implementation and opens no gate.
- **Every remaining decision stays `[PROPOSED]` or `[PENDING]`.** Route A unchanged; all four capability gates closed.

**Revision v0.4, 26 November 2026 — still DRAFT.** Applies the **PR #37 re-reviews of commit `aeec98a`**: **Anvesh's (Dev B's)** one remaining blocker, **Nisarga's (Dev D's)** four remaining items, and the **non-blocking follow-up** in **Varshini's (Dev C's) approval**. Their texts are on that pull request, not in the repository. Documentation only; it approves nothing and authorizes nothing. **Varshini's approved Dev C corrections of v0.2 and v0.3 — §2.1's milestone and placement, §4.3's published-status correction and §5.4's withdrawal of the AD8-Q5 claim — are preserved unchanged.** Changes:

- **AD-5 §8.2b's identity comparison gains `source_timestamp` and `synthetic.seed`** (Anvesh). Both participate in the approved C-1 derivation: under an equal `event_id` a differing `source_timestamp` matched **neither** conflict nor duplicate, and a differing `synthetic.seed` would have been classified a **duplicate**. §4.2's two-column table and acceptance criterion 5 are extended to every identity-bearing field and every excluded redelivery field, `instance_id` included. The stale rationale that an identity collision necessarily changes the idempotency key is removed from AD-5 §8.2, and C-b is now required to be evaluated against an **`event_id`-keyed index**.
- **Criterion 13 no longer rests on the injected clock alone** (Nisarga 1). The 2 000 ms shutdown deadline is measured on a **real monotonic clock** with the worker's actual termination asserted.
- **Criterion 11 states its mechanism** (Nisarga 2): a **static build-context, `.dockerignore` and `COPY` check**, which is what the `ingestion-unit` job can run, and the claim is narrowed to packaging exclusion rather than an image file listing.
- **AD5-Q11 is split** (Nisarga 3): §4.6's per-path rules are recorded as the explicit resolution of **Q11(a)**, and the narrowing question is identified as **Q11(b), a remaining owner decision**. The D-24 path is unchanged.
- **Architecture consistency** (Nisarga 4): **AD-5 A-11 is split** into the ingestion-side assertion and the deferred display verification, matching criteria 10 and 10a, and **AD-12 §3.1 and §3.4** now carry the agreed seed-allocation and fixture-origin mechanisms. AD-5 becomes **v0.7** and AD-12 **v0.3.2**.
- **§4.3 distinguishes the two `/v1/latest` failure modes** (Varshini, non-blocking): a running generator with a stalled adapter answers **200** with the last-held value and ages, while a generator that is not running answers **503 `NOT_READY`**, which Express's poller counts as a poll failure and which therefore *does* drive the published status to `outage`.
- **Every decision remains `[PROPOSED]` or `[PENDING]`.** No sign-off is recorded, Route A is unchanged, and all four capability gates stay closed.

**Revision v0.3, 26 November 2026 — still DRAFT.** Records two **process directions from the project owner (Ayush)**, relayed in session and **not quoted; no separate approval document exists**. They decide *how* authorization is to be obtained; they approve **no deliverable, grant no decision of §§3–6 and authorize no implementation.**

- **DB-1 is closed: Route A.** The standard **F-1 and D-22 approval process** applies. **No §2.2.2-style exception is to be created**, and Route B is withdrawn (§10.1). Consequence: **AD-5 and AD-12 must be approved as documents**, and **AD-4's approval must be extended beyond the D-24 slice** before any code begins. §10.3 is the register of exactly what that takes.
- **DB-2 is closed: the existing `ingestion-unit` job validates the registry.** **No workflow change**, and `check_event_contracts.py` is not extended (§7.4). §8 item 10's exclusion of CI changes therefore stands unamended.
- **AD-5 v0.6 §8.2b is flagged for Anvesh (Dev B)**, specifically the collision field set against ordinary redelivery (§4.2, §10.2, §12 item 2).
- Every correction from the three PR #37 reviews is retained unchanged.

**Revision v0.2, 26 November 2026 — still DRAFT.** Applies the three **CHANGES_REQUESTED** reviews of PR #37 — **Varshini (Dev C)** B1–B3, **Nisarga (Dev D)** items 1–7, and **Anvesh (Dev B)** items 1–3 — whose texts are on that pull request, not in the repository. Documentation only. It approves nothing, and it does **not** resolve the two findings that are genuinely the owner's: those are stated as blockers in §13 rather than answered. Changes: the milestone, placement and ownership are stated against AD-1 Part 2 §2.2's component register (§2.1, Varshini B1); the published-status claim is corrected, because ingestion publishes no status at all (§4.3, Varshini B2); the AD8-Q5 claim is withdrawn (§5.4, Varshini B3); C-b's predicate is widened in AD-5 v0.6 §8.2b and reflected here (§4.2, Anvesh 2); the `source_id` containment claim is corrected (§6.1, Anvesh 2); the seed-allocation record, the fixture-origin format, registry packaging and CI coverage are specified (§6.1, §6.2, §7.4, Nisarga 2, 5, 6); AD5-Q11 is answered for the two paths (§4.6, Nisarga 7); the acceptance criteria gain shutdown, plausibility-bound and collision cases and criterion 9 is split (§9, Nisarga 3, 4, Anvesh 3); and §10 sets out the two authorization routes without choosing between them (Nisarga 1, Anvesh 1).

**Leads:** **Dev A** for the adapter contract inside C-1, **Dev D** for the synthetic adapter and harness (C-3). **Approver:** project owner. **Required reviewers:** §10.
**Scope source:** `docs/PHASE3_SCOPE.md` v1.4 §2.2.2 (the D-24 F-1 exception, as precedent only), §2.3 **F-1**, §7.1 (milestone 3.3), §7.2, §12 remaining item 1; D-20, D-22, D-23.
**Depends on:** the AD-1 component view v0.5, AD-4 v0.2 and AD-6 v0.2 (each approved **for the D-24 slice only**), and the DRAFT documents AD-1 Part 2 **v0.6**, AD-4 Part 2 v0.2, AD-5 **v0.7b**, AD-6 Part 2 v0.2, AD-8 **v0.7**, AD-12 **v0.3.6**.
**Changes no code, no contract, no schema, no OpenAPI file, no Compose file, no CI workflow and no capability gate.**

---

## 1. What this document is, and what it is not

**It is** a single place to decide the smallest set of open questions that the synthetic-only adapter foundation actually depends on, so that they are decided deliberately rather than defaulted by whatever the first implementation happens to do.

**It is not:**

- an approval of AD-1 Part 2, AD-5, AD-8 or AD-12 **as documents**;
- an exercise of any F-1 exception. The owner has directed **Route A**, the standard F-1 and D-22 process (§10.1), so this document's requests take effect **only** through the approval of the deliverables themselves;
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
| AD-1 Part 2 **v0.6** | DRAFT, **no owner approval**. CHANGES_REQUESTED on PR #30 by Dev D and Dev C; applied. **v0.5** corrected the C-1/C-11 quarantine placement, §8's C-3 prerequisites and attribution, and §7.3's D-24 Compose wording; **v0.6** corrects §3.2's source-status ownership on Dev C's PR #38 finding. On **PR #38**: **Dev B granted** the D-22 technical sign-off, **Dev D approved** §7.3/§7.3.1, **Dev C's sign-off awaits** confirmation of the §3.2 correction, **Dev A's review is outstanding**. Documentation only |
| AD-5 **v0.7b** | DRAFT, **no owner approval**. CHANGES_REQUESTED by Dev D, Dev C and Dev B across **four** review rounds; all findings applied, including Dev B's six §8.2b findings on `7557a5a`. **Dev B's technical sign-off stands at `bfecb46`**, covering §8.2b, AD5-Q8 and the scoped 3.3-A acceptance requirements, and **Dev D's** approval also stands (both PR #38, relayed). **AD-5's own status line predates those reviews and is left unedited**; §10.2 holds the record. **AD5-Q8 is still the owner's decision** |
| AD-8 **v0.7** | DRAFT. Same history; **no re-review**, no owner approval. F-5's targets stay provisional; exit criterion 9 unmet. **v0.7** clarifies §8.2's 10 s Docker shutdown margin and §5.1's Express ownership of the published `source.status` — documentation only, no threshold or ownership change |
| AD-12 **v0.3.6** | DRAFT. Dev B approve-with-conditions on v0.3; applied. v0.3.2 added §3.1's seed-allocation mechanism and §3.4's fixture-origin format; v0.3.3 refreshed the stale AD-5 citations; **v0.3.4** scopes the seed refusal to registry-selected adapters with the D-24 exemption, adds the synthetic-only registry assertions, refreshes the AD-5 and AD-8 references, acknowledges Dev B's `7557a5a` re-review as a recommendation, adds AD-6 **T-10**, and records the Stage 1E **$500,000** cap synchronization. **v0.3.5** completed that reference refresh to **AD-8 v0.7** and corrected §1.1's AD-8 review status; **v0.3.6** records Dev B's AD-5 v0.7b technical sign-off at `bfecb46` and the PR #38 state of AD-12's own D-23 reviews. **Nisarga has technically approved the harness items at `a35932d` from Dev D's perspective**; Dev A's and Dev B's D-23 reviews and owner approval are outstanding |
| AD-2 v0.2, AD-3 v0.3, AD-7, AD-9, AD-10 v0.2, AD-11 v0.3, AD-13 v0.3 | DRAFT or unwritten; none approved |

**Consequence.** Of the three documents F-1 names for milestone 3.3, **AD-4 v0.2's approval has been extended to 3.3 by the owner** (§10.3 row 1), while **AD-5 and AD-12 are still drafts with no owner approval**, and **D-22 is unsatisfied**. **F-1 is therefore still unmet.** The work is therefore **blocked on authorization, not on design**: §7's scope is implementable the day §10 is complete.

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

Requested against `docs/PHASE3_AD5_ADAPTER_CONTRACT.md` **v0.7b**. **No event identity changes:** C-1's approved derivation and AD-4 v0.2 are untouched by every item below.

### 4.1 AD5-Q1 — two keys **[PROPOSED]**

Adopt AD-5 §8.1's two keys in place of scope §3.B's single three-part key:

```text
observation_key  = (source_id, event_type, subject, source_timestamp)
idempotency_key  = (observation_key, payload_sha256)
```

`observation_key` detects a **conflict**; `idempotency_key` detects a **duplicate**. **Neither key is an event name.** One key cannot do both: `payload_sha256` is inside the idempotency key, so two events with different payloads have different idempotency keys **by construction**, and the case the single key was meant to catch — one subject, one instant, two values — is caught by `observation_key`, which excludes the hash.

**Implementation impact:** defines `dedup.py` entirely.

### 4.2 AD5-Q8 — three outcomes, their order, and C-b's predicate **[PROPOSED]**

Adopt AD-5 §8.2's three outcomes, both conflict classes alertable (AD-8 §7.3 Q-2), **in the evaluation order C-b, then D, then C-a**, with **C-b's predicate as AD-5 v0.7 §8.2b defines it**:

| # | Condition | Outcome | Behaviour |
|---|---|---|---|
| **C-b** | Same `event_id`, **differing event content** (§8.2b) | **Identity collision** | **Rejected**, counted; the first is kept |
| **D** | Same `idempotency_key` as an event already seen | **Duplicate** | **Discarded**, not rejected and not quarantined; counted |
| **C-a** | Same `observation_key`, different `payload_sha256`, no validated `supersedes` | **Value conflict** | The **first is kept**; the later event is counted and does not become current |

**"Differing event content" is now one schema-aligned field matrix**, **AD-5 v0.7b §8.2b.1**, which is authoritative and is not restated field by field here. Identity-bearing: `payload` / `payload_sha256`, the subject, `source.source_id`, `event_type`, `source_sequence`, `timestamps.source_timestamp`, `synthetic.seed`, `synthetic.case_id`, `synthetic.generator_version`, and — `[PROPOSED]`, **recommended by Dev B** — `source.transport`, `source.source_url`, `source.gate3_decision_ref`, `provenance_class`, `derived_from` (as an **unordered set**), `derivation`, `timestamps.source_timestamp_basis` and **`supersedes`**. Excluded: `raw_sha256` (Dev B **accepts** this; its integrity obligations are unchanged), `validation`, `extraction`, `review`, `retrieved_at`, `emitted_at`. It **excludes** `retrieved_at`, `emitted_at` and `instance_id`, which differ on every ordinary redelivery — including them would turn each redelivery into a rejected collision and break at-least-once delivery.

**The rule behind the set.** Identity-bearing means: **in the C-1 derivation** (`synthetic.seed`, the pair, **`source_sequence`**, `source_timestamp`) **or distinguishing the producer or the observed content** (`payload_sha256`, the subject, `source_id`, `event_type`, `synthetic.case_id`, `synthetic.generator_version`, and the four `[PROPOSED]` fields). It is **not** identity-bearing if it records when, by which process, or with what verdict **we** handled the event.

**`source_sequence` — v0.4's claim about it was false (Anvesh, re-review of `a35932d`).** v0.4 and AD-5 v0.7 said the sequence "is not an envelope field" and that a differing sequence "necessarily shows as a differing `payload_sha256` or `source_timestamp`". **Both are wrong, and checked against the repository:**

| Claim | Fact |
|---|---|
| "not an envelope field" | `source_sequence` is in `contracts/events/event-envelope.v1.schema.json`'s **`required`** list, under `additionalProperties: false` |
| "necessarily changes the payload or timestamp" | `envelope.py` sets `source_sequence` from the same `sequence` that `event_id_for` hashes, and **no rule couples the sequence to the payload**. For a general adapter the payload need not depend on it at all |
| Consequence | A reused `event_id` differing **only** in `source_sequence` shares **both** §8.1 keys, so it was classified **D** and **silently discarded** — the C-1 defect again |

**Every C-1 derivation input is now compared:** seed, pair, **sequence**, `source_timestamp`.

**Three further corrections, from Anvesh's re-review of `7557a5a`:**

| What v0.5 said | Fact, checked against the schema |
|---|---|
| `source.instance_id` is an excluded **envelope** field | **No such field.** `source` is `additionalProperties: false` over exactly `source_id`, `transport`, `source_url`, `gate3_decision_ref`, and the envelope has no top-level `instance_id`. It is a **required top-level field of the batch wrapper** `contracts/events/ingestion-latest.v1.schema.json`, "New at each ingestion start. Diagnostic only" — which is what AD-12 §3.2 means. `instance_id` is therefore **outside C-b by construction**, and a redelivery case varies it **on the wrapper** with a byte-identical envelope |
| `source_timestamp_basis` is `provider` / `derived` / `none` | The schema's enum is **`observed` / `published` / `none`**, bound to nullability: a non-null `source_timestamp` requires `observed` or `published`, a null one requires `none`. **So a basis-only case is valid only between `observed` and `published`** |
| `supersedes` is excluded as processing metadata | It is **producer-declared correction evidence** (§4.4, AD5-Q10). Excluding it would have **silently discarded a changed correction** under a reused `event_id`, so it is now **identity-bearing**. It stays unreachable in this scope by invariant, not by assumption: AD5-Q10 forbids a synthetic adapter from setting it and the D-24 generator sets `supersedes: None` |

**The nested `source` fields are classified, not ignored** (Anvesh 2): `source.transport`, `source.source_url` and `source.gate3_decision_ref` are identity-bearing `[PROPOSED]`, each with the `allOf` rule that makes a single-field mutation of it schema-invalid. **`derived_from` is compared as an unordered set** (Anvesh 5): `uniqueItems: true`, no ordering semantics anywhere, and AD-4 §6's v1 single-source rule (AD4-Q8) holds it to at most one element.

**AD-2 R-8 and D-24 are unaffected.** R-8 says a C-1-style collision's second arrival is a **conflict, rejected and counted — not a duplicate**; every identity-bearing row produces exactly that and none produces a discard, so the matrix **widens what R-8 catches** without changing what it says. Every matrix row's D-24 value is a constant of `envelope.py` or a C-1 input, and the slice runs one generator configuration per process, so **no two slice events differ in any identity-bearing field while sharing an `event_id`**.

A string-versus-integer sequence formatting difference yields a **false C-b** — a rejection, which is the safe direction.

**Why `source_timestamp` and `synthetic.seed` had to be added (Anvesh, re-review of `aeec98a`).** Both are in the approved derivation, and without them a collision escapes classification in two different ways:

| Under an equal `event_id` | Keys of §8.1 | Outcome without the field | Outcome with it |
|---|---|---|---|
| **Different `source_timestamp`** | `observation_key` **differs**, so `idempotency_key` differs | Matches **neither D nor C-a**: accepted as a new observation **while carrying an already-used identity** | **C-b**, rejected and counted |
| **Different `synthetic.seed`** | **Both keys equal** | **D**: silently discarded as a duplicate — the C-1 defect | **C-b**, rejected and counted |

**C-b therefore needs its own lookup.** It is evaluated against an index keyed on **`event_id` alone**, not on either key of §8.1, and it is evaluated **first**. AD-5 v0.7 states this, and it **removes v0.5's and v0.6's stale rationale** that an identity collision "necessarily" differs in payload or subject and so carries a different `idempotency_key` — the seed row above is a counter-example.

**Why the widening (Anvesh 2).** `payload_sha256` covers `{event_type, payload}` only, and the `idempotency_key` adds nothing beyond it. So two events from **different generator configurations** sharing a seed, pair, sequence and `source_timestamp` have an identical `event_id`, an identical payload hash and an identical subject, and under the earlier predicate they fell through to **D** and were **silently discarded as duplicates** — the exact C-1 defect. AD-1 §3.4's approved row is keyed on "different **content** or pair", so the wider predicate **aligns** AD-5 with the approved rule.

**Why the order must be explicit.** The earlier result was correct only because of two contingent facts: a collision differing in payload or subject has a different `idempotency_key`; and for the synthetic transport an equal `event_id` at an equal pair and timestamp forces an equal payload, because `event_id = f(seed, pair, sequence, source_timestamp)` while the payload is `f(seed, pair, sequence)`. **The second argument stops holding if AD4P2-Q1 changes the derivation**, and C-a would then merely keep the first where **AD-2 R-8 requires a rejection**.

**No behaviour changes, and nothing approved moves.** The D-24 slice continues to run on **AD-1 §3.4 as approved**, and it runs one generator configuration per process, so no two of its events can differ in `case_id` or `generator_version` while sharing an `event_id`.

**§8.2b is flagged for Anvesh (Dev B), and is the one open technical question inside this request.** Dev B owns the P-4 acceptance rules, and the field set has to be right in **both** directions:

| Must be C-b (a collision) | Must stay D (an ordinary redelivery) |
|---|---|
| Same `event_id`; same `payload_sha256`; same subject; **different `synthetic.case_id`** | Same `event_id`; same `payload_sha256`; same subject; **different `retrieved_at`** |
| Same `event_id`; same `payload_sha256`; same subject; **different `synthetic.generator_version`** | Same `event_id`; same `payload_sha256`; same subject; **different `emitted_at`** |
| Same `event_id`; same `payload_sha256`; same subject; **different `synthetic.seed`** | Same `event_id`; same everything but a **different `instance_id`** — a restarted producer resending, which AD-12 §3.2 keeps diagnostic |
| Same `event_id`; same `payload_sha256`; same subject; **different `source_timestamp`** | Same `event_id`; same everything but a **different `validation.status` with its matching `reasons`** — our verdict on re-handling, not a new observation. The pair must move together: `validated` requires empty `reasons`, `quarantined` at least one |
| Same `event_id`; same `payload_sha256`; same subject; **different `source_sequence`** | Same `event_id`; same everything, including all of the left column's fields — a plain redelivery |
| Same `event_id`; **different `payload_sha256`**, subject, `source_id` or `event_type` | |

**Getting it wrong is costly in either direction.** Too narrow and a changed generator configuration is silently discarded as a duplicate — the C-1 defect, which is why the predicate was widened. Too wide and **every** redelivery becomes a rejected collision, which breaks at-least-once delivery outright (§3.7 **H-1**) and would make the provisional AD5-Q7 direction unimplementable. The left column is also the **first** three rows of acceptance criterion 5, so Dev B's answer changes a test, not only a sentence. **Until Dev B confirms, §8.2b stays `[PROPOSED]` and AD5-Q8 is not decidable.**

### 4.3 AD5-Q9 — `down` stays internal, and in this scope it is **not published at all** **[PROPOSED]**

Adopt AD-5 §9.3's mapping — the internal state `down` maps to **`outage`**, and the approved three-value `source.status` enum (`starting`, `ok`, `outage`) is **unchanged**, because the deployed client validates `source` strictly and a fourth value would fault every open stream.

**Correction (Varshini B2). v0.1 of this document said the internal `down` "publishes as `outage`". That conflated two different machines, and it is wrong for this scope.**

- **Ingestion publishes no status.** `contracts/events/ingestion-latest.v1.schema.json` requires `protocol_version`, `instance_id`, `source_id`, `generated_at` and `events`, and has **no status field**. `additionalProperties` is false.
- **The published `source.status` is derived by Express's own poller** (AD-1 §3.2): `starting` until the first successful poll, `ok` after one, and `outage` after 3 consecutive poll failures or 2 s without a success. It is a statement about **Express's poll of ingestion**, not about an adapter.
- **So how does adapter failure reach a viewer here?** Only indirectly, and that is the correct behaviour: a failed adapter stops producing, `/v1/latest` keeps answering 200 with whatever it last held, Express's poller keeps reporting `ok`, and the **values age through `stale` to `unavailable`** on their own (AD-4 §7; AD-8 §5). No status needs to be delivered for the user-facing outcome to be right, which is exactly what AD-5 §3.7 means by "a value whose updates stop simply ages into `stale` and then `unavailable`".

- **The two `/v1/latest` failure modes are not the same, and `failed_permanent` must say which it is (Varshini, non-blocking follow-up on `aeec98a`).** The existing implementation does **not** always answer 200: `services/ingestion/cbdc_ingestion/http_api.py` returns **`503 NOT_READY`** — "the generator is not running" — whenever the service is not in its running state, and `service.py` records the same. The distinction is therefore:

  | What has failed | `/v1/latest` | Express's poller | Published `source.status` | What the viewer sees |
  |---|---|---|---|---|
  | **An adapter** reaches `failed_permanent` while the **service keeps running** | **200**, with the last-held value and its unchanged `source_timestamp` | Polls succeed | Stays **`ok`** | Values **age** through Simulated-`stale` to `unavailable` (AD-4 §7). This is the case §4.3 is about |
  | The **service or generator** is not running, or is stopping | **503 `NOT_READY`** | Counts a **poll failure** | Reaches **`outage`** after 3 consecutive failures or 2 s without a success (AD-1 §3.2) | An **outage**, as today |

  **Neither path is changed by this scope, and no new path is created.** The second row is existing, approved D-24 behaviour. What this scope adds is the first row, and the point stands: an adapter's `failed_permanent` **does not** by itself produce a 503 and **does not** drive the published status, because the service is still running and still serving. An implementation must therefore **not** make `failed_permanent` fail the HTTP endpoint — doing so would convert a single adapter's permanent fault into a whole-service outage and would change D-24 behaviour. **Acceptance criterion 6 asserts exactly this**, and the existing `test_http_latest.py` continues to pass unchanged.
- **AD-5 §9.3's mapping therefore binds nothing in this scope.** It governs the full-Phase-3 path where ingestion's status reaches a consumer. Creating such a path would change `ingestion-latest.v1.schema.json`, an approved contract, and is **excluded** (§8 item 11).

**What is requested is narrower than v0.1 asked for:** adopt the mapping as the **general** rule and as the internal machine's shape, and implement the internal machine **in process only**, with the internal state exposed solely as a metric label and a log field (AD-8 §7.1). Acceptance criterion 5 is corrected accordingly (§9).

`ingestion-latest.v1.schema.json` is added to the untouched-contract list (§7.3).

### 4.4 AD5-Q10 — `supersedes` only from the provider **[PROPOSED]**

Adopt AD-5 §8.2a rule 2: an adapter sets `supersedes` **only** from something the provider actually published, and **never infers a correction** from a value simply differing. Inferring one is what turns a C-a conflict into a silent overwrite. For a synthetic source the rule binds immediately: the generator publishes no corrections, so the synthetic adapter must never set `supersedes` at all.

### 4.5 AD5-Q7 (H-1) — **remains provisional** **[PROPOSED as provisional]**

Delivery semantics are **not** decided here. Record **at-least-once** as the provisional direction, with the decision deferred: **AD-2 states the requirement, AD-3 chooses the mechanism, and both are drafts.** H-2 to H-6 stay open with it.

**Why the work can proceed anyway.** AD-5 §3.7 states what holds under every answer: no observation crosses into routing; a replayed event keeps its original timestamps; loss is counted, never silent; and **no H-answer changes §3.2's adapter operations**. This scope therefore implements the sink's `observations` channel against the existing in-memory `LatestStore` and marks the synthetic source `dedup: within_run`.

**What it must not do:** claim restart-safe deduplication, implement an acknowledgement protocol or a replay window, or present the in-memory sink as the distribution mechanism. AD-1 §4 records that the distribution mechanism **replaces** the poll.

### 4.6 AD5-Q11 — which conflict rule governs which path **[PROPOSED]**

**Q11 is split in AD-5 v0.7 (Nisarga 3), and the two halves have different statuses.** §4.6's per-path table **is** the explicit requested resolution of **Q11(a)**; **Q11(b)** is named as a **remaining owner decision**:

| | Question | Status here |
|---|---|---|
| **Q11(a)** | Which conflict rule governs which path? | **[PROPOSED]** — requested now, as the table below. Recorded as Q11(a)'s resolution in AD-5 v0.7 §8.2 and §15 |
| **Q11(b)** | Should the general rule be narrowed to match the slice, or the slice's rule widened at its next revision? | **[PENDING — owner decision]**. Not requested, not answered, and not needed for §7's work. Decide it when AD-7 or a slice revision next opens AD-1 §3.4 |

**Q11(a), as requested — each path keeps its own rule, so the implementation is unambiguous:**

| Path | Governing rule | Status |
|---|---|---|
| The existing D-24 generator path (the default, §7.2) | **AD-1 §3.4 exactly as approved**, keyed on `event_id` inequality | **Unchanged.** No reclassification, no new counter, no behaviour change |
| The new adapter path, when a registry record selects it | **AD-5 §8.2** with §8.2b's predicate and the C-b → D → C-a order | New code only |

**D-24 is preserved exactly.** The existing path's rule, counters, outcomes and approval are untouched; nothing is reclassified and no behaviour changes, because no registry record selects the adapter path by default.

The two differ in one cell, which AD-5 §8.2 records: two events with the same payload and different `event_id`s are AD-1's **conflict** in the slice and AD-5's **duplicate** in the general rule. That cell is reachable in the slice only through a generator restart that realigns a pair's timestamp at a different sequence — the case **AD-1 §3.4.1 records as "not a defect, for the record"**. The two paths are not run against one consumer in this scope: the adapter path is selected by a registry record, and no record selects it by default.

**Not requested:** AD5-Q2, Q3, Q4, Q5, Q6, and **Q11(b)**. No synthetic source exercises them.

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

Requested against `docs/PHASE3_AD12_SYNTHETIC_HARNESS.md` **v0.3.5**. Part B (quarantine and review queue) is **not** requested: it is `[PENDING: AD-10, AD-11]` and feeds milestone 3.6.

### 6.1 The C-1 collision safeguards **[PROPOSED]**

**The approved C-1 derivation `UUIDv5(namespace, seed | pair | sequence | source_timestamp)` is unchanged, and this document proposes no change to it.**

**Correction (Anvesh 2).** v0.1 said that making a second generator configuration a second `source_id` means "a collision becomes two distinct observation streams rather than two names for one". That overstated it. `source_id` is **absent from the derivation**, as AD-4 Part 2 §3.4 item 3 itself says ("enters the derivation through nothing"), so two `source_id`s **do not prevent the `event_id` collision**. What they separate is the **lookup keys** — `source_id` is `observation_key`'s first component — so the two streams no longer overwrite each other's dedup state. The collision still occurs and is still detected. **The applicable preventive safeguards are coordinated seed allocation and the start-up overlap refusal**, not the `source_id` rule.

Adopt AD-12 §3.1's three mitigations as **requirements**. **The mechanism is now specified in AD-12 v0.3.2 §3.1 itself** (Nisarga 4, architecture consistency), so this document and AD-12 state the same thing rather than this document alone:

1. **Coordinated seed allocation.** Every synthetic source, load profile and run takes its seed from a **recorded allocation**: a version-controlled file, `services/ingestion/cbdc_ingestion/registry/seed_allocations.json`, listing each allocation's seed, `source_id`, subject set and intended period. **It is read-only at runtime and is never written by the process.** That is required by the container posture — read-only root filesystem, no volume, no published port (`infra/compose.observations.yaml`) — so a runtime-written ledger is impossible here, and a reviewed file in source control is the only form the record can take. Changing an allocation is a reviewed commit, which is the audit trail.
2. **Disjoint subjects.** Sources registered at the same time use disjoint pair sets, so `pair` never repeats across them. Enforced over the allocation file at start.
3. **A start-up refusal, on the registry-selected adapter path only.** The service **refuses to start** a synthetic source whose `(seed, pair)` overlaps another allocation marked active for the same period, or whose record is absent from the allocation file. The check is **in-process and local**: it reads the allocation file and the records the service is starting, and it **cannot** detect a second container started independently against the same consumer — a limitation stated in §12 item 8, not papered over.

**The D-24 generator path is exempt, and must be.** The refusal binds a source **a registry record selects** — the same scoping AD5-Q11(a) gives the adapter path (§4.6). The **existing D-24 generator is not registry-selected**: it takes its seed from `CBDC_INGESTION_SEED` (default `20261125`, `services/ingestion/cbdc_ingestion/settings.py`) and has **no registry record and no allocation entry**, so an unscoped refusal would **refuse to start the approved D-24 slice**. Requested accordingly, and carried in **AD-12 v0.3.5 §3.1** so both documents say the same thing:

- registry-selected source, **no allocation entry or an overlapping one → refusal**;
- the env-configured D-24 generator → **not subject to the check**, and it needs no allocation entry. Its behaviour is approved and **unchanged** (AD-1 v0.5 §3, D-24);
- the exemption is **that one path only** — a registry-selected *synthetic* source gets none.

Bringing the D-24 generator under the registry later would change approved slice behaviour and would need the owner's approval. **It is not requested here.**

**Synthetic-only registry assertions, requested with them `[PROPOSED]`.** A registry record for a synthetic source must carry no outbound reach, which is checkable from the record alone (AD-5 §2.1): **`endpoint` null**, **`credential_ref` null**, **`egress_allowlist` empty**. A synthetic record setting any of the three is a **start-up refusal**. This adds no registry field and changes no schema; it constrains the values a `synthetic.`-prefixed record may hold, beside the existing class and transport checks (**A-2**), and criterion 2 asserts it on both sides.

Adopt with them **AD-4 Part 2 §3.4 item 3** as a configuration rule: the registry permits **one active generator configuration per `source_id`**, and a second configuration is a **second `source_id`**, which enters the `idempotency_key` as its first component. Its benefit is dedup-state separation, per the correction above.

Adopt the operational rule of **AD-5 §8.2 / AD-2 R-8**: load and fault runs must not overlap with a shared seed; a run that does is **invalid as a performance result** and may be excluded from throughput and latency figures, but its collisions are still **detected, rejected, counted and recorded**. **Exclusion applies to the result, never to collision detection.**

**Not requested:** **AD4P2-Q1**, the derivation fix adding `generator_version` and `case_id`. It would change approved text and belongs to a new generator version. **The broader C-1 residual risk stays open** (AD-5 §14 item 5, AD-4 Part 2 §3.4, AD-12 §9).

### 6.2 Fixture provenance, with a format **[PROPOSED]**

**AD-12 v0.3.2 §3.4 now carries this format** (Nisarga 4, architecture consistency); v0.3.1 left it `[OPEN]`, which made §9 criterion 9 untestable as written (Nisarga 2, Anvesh 3). The format is the **minimum that makes the check mechanical**, and it is requested here **for this scope's own fixtures only**; AD-12 keeps ownership of the general question — whether it becomes the repository-wide rule, and whether the existing corpus is ever labelled, stay **open** owner decisions there.

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

**Settled by owner direction (DB-2, v0.3): the `ingestion-unit` job is the validation route, and no workflow changes.** `infra/scripts/check_event_contracts.py` and `check_contracts.py` are **not** extended to cover `contracts/events/registry/`. Those scripts are **Dev D's (P-8)**, and `check_contracts.py` does not cover `contracts/events/` at all today. The registry schema and record are therefore validated **only** by §9 criterion 3, a test in the ingestion suite, under the no-skip check.

**What this makes binding:** §8 item 10's exclusion of every CI, Docker, Compose and packaging change **stands unamended**, and `phase3-observations.yml` is untouched. An implementation that needed a workflow change would be **outside this scope** and would need a fresh authorization. **Dev D still reviews the arrangement** (§10.2), because the obligation lands in a suite Dev D's no-skip check polices.

**Fake-provider exclusion is verified, not assumed — and the evidence matches the claim (Nisarga 2).** `infra/testing/fake_provider/` is outside `services/ingestion/`, so it is outside the build context — the same reason `infra/testing/fault_ingestion/` is absent from every runtime image. **§9 criterion 11 asserts this statically**: it parses the Dockerfile's `COPY`/`ADD` sources against the declared build context and the `.dockerignore` and shows that no copied path can resolve to the excluded directories, with a negative control. **It requires no Docker build or daemon**, so it runs inside the `ingestion-unit` job with no workflow change, and the acceptance claim is **packaging exclusion**, not an inspection of a built image — which would need the `phase2-docker` job this scope does not touch.

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

The AD-5 §13 obligations are the source. **A-9** runs through the existing D-24 harnesses. **Criterion 5 tests the classifier on schema-valid envelopes; criterion 5a tests envelope validation on invalid ones. The two are not mixed** (AD-5 v0.7b §8.2b.2). Every suite named below lives under **`services/ingestion/tests/`** and runs in the `ingestion-unit` job (§7.4).

| # | Criterion | Suite |
|---|---|---|
| 1 | **Contract conformance (A-1).** Every adapter passes one shared suite driven by AD-5 §3.2's operations. `describe()` is checked against the registry record; a mismatch is a **startup failure**, not a warning | `test_adapter_contract.py` |
| 2 | **Registry validation (A-2).** A malformed, inconsistent or incomplete record fails at startup. Negative cases: a `synthetic.` prefix with a non-synthetic class; a transport mismatch; a `real` source with no active Gate 3 reference; a freshness profile breaking AD-4 §7's ordering invariant. **Synthetic-only assertions (§6.1):** a synthetic record with a **non-null `endpoint`**, a **non-null `credential_ref`** or a **non-empty `egress_allowlist`** each **fails at startup**, and the positive control — all three absent, i.e. null, null and empty — **starts cleanly**. The three are asserted **individually**, so one passing cannot mask another | `test_registry.py` |
| 3 | **Registry schema conformance.** Every shipped record validates against `source-record.v1.schema.json`, and a deliberately invalid record fails — so the schema is **exercised**, not merely present (§7.4) | `test_registry_schema.py` |
| 4 | **Determinism (A-3).** A fixed seed and injected clock reproduce identical payloads, `payload_sha256` values and `event_id`s **across process restarts** | `test_adapter_determinism.py`; the existing `test_restart_identity.py` still passes unchanged |
| 5 | **Classification (A-5, A-6), on schema-valid envelopes only.** The outcomes are produced in the order **C-b, D, C-a**, with **C-b evaluated against an `event_id`-keyed index** and not against either key of AD-5 §8.1; a collision is **rejected and counted**, a duplicate **discarded and counted**, a value conflict keeps the first. **Every case feeds the classifier two envelopes that both validate against `event-envelope.v1.schema.json`** — an infeasible single-field mutation is not a classifier case but an **envelope-validation** case, which criterion 5a covers (AD-5 v0.7b §8.2b.2). Under a reused `event_id`, **classified C-b**: (a) changed `synthetic.case_id`; (b) changed `synthetic.generator_version`; (c) changed **`synthetic.seed`** — shares **both** §8.1 keys, must not be discarded as **D**; (d) changed **`source_timestamp`**, with `source_timestamp_basis` left non-`none` — matches **neither** D nor C-a, must not be accepted; (e) changed **`source_sequence`** alone, payload hash, subject and `source_timestamp` all unchanged — shares both §8.1 keys, must be **rejected**, not **D**; (f) changed `payload_sha256`; (g) changed subject; (h) changed `source.source_id`; (i) changed `event_type` **with the matching `payload` shape**; and, **if the owner adopts the `[PROPOSED]` rows of §8.2b.1 that Dev B recommends**: (j) `provenance_class` **moved together with** `source.transport`, `source.source_id`, `source.source_url`, `source.gate3_decision_ref` and the `synthetic` block, as `allOf` rules 0–3 require; (k) `derived_from` **with** `derivation`, per `allOf` rule 3, **and a reordering-only variant that must be `D`**, since `derived_from` is compared as an **unordered set**; (l) `timestamps.source_timestamp_basis` **`observed` against `published`** with a **non-null** `source_timestamp` — the only schema-valid basis mutation; (m) **`supersedes`** changed with `review: null`, which is schema-valid, asserting that changed **correction evidence** is never silently discarded. Under a reused `event_id`, **classified D**: (n) differing only in `retrieved_at`; (o) only in `emitted_at`; (p) a **byte-identical envelope redelivered under a different wrapper `instance_id`** — varied on `ingestion-latest.v1.schema.json`, **never inside the envelope**, which has no such field; (q) `validation.status` changed **with its matching `reasons`** (`validated` ⇒ empty, `quarantined` ⇒ at least one); (r) only in `raw_sha256`, whose exclusion Dev B accepts; (s) identical in every field. **Deferred, with no case here:** `extraction` and `review`, both `null` for every synthetic source, whose provider extraction and human-review flows are outside 3.3-A (AD-13; milestone 3.6). Plus the 300 s window **at, inside and outside** its boundary | `test_idempotency.py` |
| 5a | **Envelope validation, distinct from classification.** A mutation the schema forbids is rejected at **validation, before** the classifier sees it, and the test asserts that — not a classification outcome. Cases: an `instance_id` inserted into `source` (`additionalProperties: false`); a `source.transport`-only change breaking `allOf` rule 0; a `validation.status` of `validated` carrying `reasons`; a `source_timestamp_basis` of `none` with a non-null `source_timestamp`; a non-null `review` without `supersedes`. **This keeps the classifier's own suite free of invalid inputs** (AD-5 v0.7b §8.2b.2) | `test_envelope_validation.py`; the existing `test_schema_conformance.py` still passes unchanged |
| 6 | **Internal status machine (A-7), in process only.** Both outage criteria independently; recovery on one successful item; `failed_permanent` **never retries**; the internal `down` and `stopped` states map to `outage` per AD-5 §9.3. **And the internal state is never serialized:** `GET /v1/latest` responses still conform to `ingestion-latest.v1.schema.json` with `additionalProperties: false`, so no status field appears, and Express's poller-derived `source.status` is unaffected (§4.3). **The two failure modes are asserted apart** (§4.3): an adapter in `failed_permanent` while the service runs leaves `/v1/latest` answering **200** with its last-held value, and the existing **`503 NOT_READY`** stays reachable only when the service or generator is not running — an adapter fault must never produce it | `test_status_machine.py`; the existing `test_http_latest.py` and `test_schema_conformance.py` still pass unchanged |
| 7 | **Normalization (A-8).** Decimal strings survive with trailing zeros; **no float round-trip**; codes map only through the mapping table; a missing required field is a **rejection, not a default** | `test_normalization.py` |
| 8 | **Seed safeguards (§6.1), on the registry-selected path, with the D-24 exemption asserted.** For a **registry-selected** source the start-up check **refuses** an overlapping `(seed, pair)` and refuses a record absent from the allocation file; disjoint subject sets are enforced; one active generator configuration per `source_id` is enforced, and a second configuration is a second `source_id`. A positive control starts cleanly. **And the exemption is a test, not an assumption:** the **env-configured D-24 generator starts with no registry record and no allocation entry**, exactly as it does today, which is the assertion that these safeguards cannot refuse the approved slice. The existing D-24 ingestion suite passing unchanged (criterion 18) is the second half of that evidence | `test_seed_allocation.py` |
| 9 | **Fixture provenance (§6.2).** Every fixture **this scope adds** carries a valid origin record; a missing record, an unknown `origin` and a field set inconsistent with its `origin` each **fail**. The check **skips paths it does not own** — including `contracts/events/fixtures/` and `contracts/test-vectors/` — and the test asserts that it skips them rather than passing them silently | `test_fixture_origin.py` |
| 10 | **Gate 3 enforcement, ingestion side (A-11).** With a source's Gate 3 decision reference **absent, inactive or withdrawn**, the adapter **does not start** and the service records the reason. This is a **negative registry and startup assertion** only | `test_gate3_enforcement.py` |
| 10a | **The Unavailable *display* for a withdrawn source's stored values (AD-4 §8.1 rule 2) is deferred**, not claimed: it needs the observation store (AD-11, C-5) and frontend behaviour (C-8), both excluded here (§8 item 7). It is recorded as an obligation of the milestone that builds them | Deferred — no suite |
| 11 | **Test-only code cannot enter the image — asserted statically** (Nisarga 2). The claim is **packaging exclusion**, and the evidence matches it: the test parses `services/ingestion/Dockerfile`, resolves every `COPY`/`ADD` source against the declared build context and the `.dockerignore`, and asserts that **no copied path can resolve to** `infra/testing/fake_provider/` or `services/ingestion/tests/` — the first because it lies outside the build context entirely, the second because no `COPY` names it. **No Docker build, daemon or image listing is required**, so it runs in the existing `ingestion-unit` job with no workflow change (§7.4). A negative control asserts the check **fails** when given a Dockerfile that copies the excluded path. **It does not claim to have inspected a built image:** that would need the `phase2-docker` job, which this scope does not change | `test_image_packaging.py` |
| 12 | **Boundary (A-9, in part).** `usage: display_only` on every envelope; no adapter emits a bridge-state value, and no such event type exists; the adapter package imports nothing from `src/`, `services/inference/` or any database client | `test_boundary.py`, extended |
| 13 | **Cooperative shutdown within budget — on a real monotonic deadline** (Nisarga 1). `stop()` returns **and the worker thread has actually terminated** within **2 000 ms**, measured with **`time.monotonic()`** and asserted with a bounded `Thread.join(timeout=…)` followed by `is_alive() is False`. **The injected clock is deliberately not used for this criterion:** an injected clock can prove only that the adapter observed its deadline, never that a real thread exited, so the budget is asserted against wall-clock-independent real elapsed time. The adapter's own internal timing stays on the injected clock, which criteria 4 and 14 cover. The worker does **no** unbounded blocking call, so the measurement is deterministic rather than load-dependent; a run that exceeds the deadline **fails**, and is not retried or marked flaky | `test_shutdown.py` |
| 14 | **Shutdown during startup and during active work.** Cancellation delivered mid-`start` leaves nothing acquired and the adapter `stopped`; cancellation while an item is being produced loses no accounting — the event is either published or counted, never both and never neither | `test_shutdown.py` |
| 15 | **Repeated and out-of-state `stop()`.** `stop()` is idempotent: calling it twice, calling it on a `created` adapter, and calling it after `failed_permanent` all succeed and change nothing | `test_shutdown.py` |
| 16 | **Plausibility bounds (§5.5).** A value outside the generator's declared range is **quarantined** with its reason, not rejected and not clamped; a relative jump **above** 20% within one interval is quarantined; **at exactly 20%** and at exactly the range endpoints it is **accepted** — the boundary is asserted on both sides | `test_plausibility.py` |
| 17 | **Non-interference (A-9).** AD-6 **T-1, T-2, T-6 and T-10** hold: identical `decision_id` and engine responses, **zero** inference `/v1/route`, `/v1/compare` and `/v1/explain` calls, unchanged tree hashes | The existing `acceptance-stack` and `acceptance-browser` jobs |
| 18 | **No regression.** Phase 1's suite and the existing D-24 ingestion suite pass unchanged; `guards`, `regression-gate`, the four acceptance jobs and the `phase3-acceptance` gate pass | CI on the implementation pull request |

**A-4 (fault injection) is not exercised**, and 3.3-S's exit is therefore not reached (§1.1). A synthetic adapter has no transport to fault; `infra/testing/fake_provider/` is created so A-4 has a home, and the exit record must state A-4 as **outstanding**.

## 10. Required sign-offs — none of these is given

**This document records no approval. Every box is unchecked.**

### 10.1 Route A, by owner direction (DB-1 closed)

F-1 requires a code milestone's **own required 3.1 deliverables** — for milestone 3.3, **AD-4, AD-5 and AD-12** — to be **approved**, as tightened by D-22 for the AD-1 component view.

**The project owner has directed Route A: the standard F-1 and D-22 approval process, with no special exception.** The direction was relayed in session and is **not quoted**; no separate approval document exists. It is a direction about **process only** and approves no deliverable.

**Route B is withdrawn.** No exception in the form of scope §2.2.2 — which waived F-1 for AD-2, AD-3, AD-5, AD-7 to AD-9 and AD-12 for the D-24 slice — is to be created for this work, and nothing in this document may be read as one.

**What Route A means in practice, and it is stricter than v0.2 contemplated:**

1. **AD-5 and AD-12 must be approved as documents**, not merely consulted for the named decisions of §§4 and §6. Every open question those documents carry must therefore be decided, **including the ones §11 lists as deliberately provisional** — AD5-Q7 may be decided *as* provisional, with its deferral recorded, but it cannot simply be left unanswered.
2. **AD-4's approval must be extended beyond the D-24 slice.** AD-4 v0.2 is approved **for the D-24 slice only**, and that approval is version-specific. F-1 names AD-4 among milestone 3.3's deliverables, so an extension is mandatory and is the item most easily overlooked (§10.3 item 1).
3. **D-22 is unaffected and stays mandatory**: the AD-1 component view's §4 placement must be confirmed, with Dev A, Dev B and Dev C reviewing (§3.1).
4. **The §§3–6 requests do not take effect on their own.** Under Route A they are **inputs to those approvals** — the specific readings this scope depends on — not a parallel grant. If an approval lands with a different reading, §§7–9 must be restated before implementation.

All four gates stay closed. **Route A is longer than Route B would have been, and it is the owner's decision.**

### 10.2 Reviews

- [ ] **AD-1 Part 2 re-review and the D-22 placement confirmation** — **Dev A, Dev B and Dev C** (D-22's named reviewers, retained in full), with **Dev D** on §7.3.1. **PR #38:** **Dev B granted** the D-22 technical sign-off on v0.5 (quarantine placement, C-3 prerequisites, Compose boundaries). **Dev D approved** §7.3/§7.3.1's D-24, D-25, B-4 and Compose-authorization boundaries. **Dev C** found the §3.2 source-status row inconsistent with AD-8 v0.7 §5.1 and offers the Dev C sign-off once corrected — **corrected in AD-1 Part 2 v0.6; his confirmation is awaited**. **Dev A's review is outstanding**, and **the owner's D-22 confirmation is not given**, so **no milestone 3.2–3.7 is authorized**
- [x] **AD-5 v0.7b re-review** — **Dev B: technical sign-off at `bfecb46`**, stated in the PR #38 review as remaining valid on a document **unchanged since** that commit, and covering **§8.2b**, **AD5-Q8** and the **scoped 3.3-A acceptance requirements** (§3.6 sink; §3.7 pending semantics; §7 fault classes; **§8.1's keys, §8.2's outcomes and order, and §8.2b's field set, against the P-4 acceptance rules Dev B owns**; §8.4; §8.5; §9; §12). **Dev D's** technical approval also stands (Nisarga, PR #38). Both are **relayed, not quoted**. **Technical sign-off only:** **AD5-Q8 is still the owner's decision**, AD-5 is **not approved as a document** (row 3), and **AD-5 v0.7b's own status line predates these reviews and is deliberately left unedited**, so the document signed off at `bfecb46` is unchanged and this is the record
- [ ] **AD-8 v0.7 re-review** — **Dev C: PASS** (PR #38) on the synthetic freshness profile — `expected_interval_ms` 2,000; `live_max_age_ms` null; `stale_after_ms` 6,000; `unavailable_after_ms` 30,000; `clock_tolerance_ms` 1,000; the 3× and 15× arithmetic; monotonic age, exact boundaries, null timestamps and the never-Live synthetic label — all compatible with the D-24 implementation. **Dev D: accepted** (PR #38) on published-status ownership, synthetic timing, shutdown and harness requirements. **Still open: Dev B** (§8.2 shutdown against `lifecycle.ts`), and the **owner's** partial approval of §5 (row 7)
- [ ] **AD-12 review (now v0.3.6)** — **Dev B** reports the technical content **satisfactory** at `2ecb742`, the D-24 seed exemption and its acceptance coverage closing his earlier blocker, with **formal D-23 sign-off pending the AD-5 review-record correction**, which v0.3.6 makes; his confirmation is awaited. **Dev A's D-23 review (Stage 1E rules, §6.3) is outstanding.** Dev D's approval of v0.3.5 is **not** a D-23 review
- [ ] **C-3 ownership** — **Dev D**, as AD-1 Part 2 §2.2 assigns the synthetic adapter and harness to Dev D under AD-12 (§2.1)
- [x] **AD-5 §8.2b specifically — CONFIRMED by Anvesh (Dev B) at `bfecb46`** (PR #38; relayed, not quoted). What was asked and what the matrix answers: the **v0.7** collision field set **against ordinary redelivery**, per §4.2's two-column table. Flagged by owner direction (v0.3); Dev B's re-review of `aeec98a` required `source_timestamp` and `synthetic.seed`, the re-review of `a35932d` required **`source_sequence`** and a full schema cross-check; and the re-review of `7557a5a` required the `instance_id` location, the nested `source.*` fields, the corrected `source_timestamp_basis` enum, **`supersedes`** as identity-bearing, `derived_from`'s set semantics and schema-valid acceptance scenarios. **v0.7b applies all six**, and Dev B's PR #38 review states the sign-off covers **§8.2b** and **AD5-Q8** on a document unchanged since `bfecb46`. The fields he recommended as identity-bearing — `provenance_class`, `derived_from`, `derivation`, `source_timestamp_basis` — and the accepted `raw_sha256` exclusion therefore now carry his technical confirmation. **They stay `[PROPOSED]` regardless: AD5-Q8 is the project owner's decision**, and criteria 5 and 5a still turn on it
- [x] **§7.4's validation arrangement** — **Dev D confirmed it at `a35932d`**: the registry arrangement, in-suite schema validation, fixture-origin requirements and harness acceptance criteria are technically acceptable from Dev D's perspective (DB-2 closed: in-suite, no workflow change)
- [x] **This document, under the second-reviewer rule (D-20)** — **Nisarga (Dev D) gave technical sign-off at `a35932d`** on 26 November 2026, **scoped to Dev D's perspective**. D-20 names Dev B or Dev D, so **D-20 is satisfied**. Her two non-blocking observations are applied in v0.5. **It is technical sign-off only:** it authorizes no implementation, opens no gate, and is not the owner approval of §§3–9. Nisarga **approved again at `e4cf979`** on PR #38. **Dev B's PR #38 blocker was the AD-5 review record, corrected in v0.8, and Dev C's was the AD-1 §3.2 row, corrected in AD-1 Part 2 v0.6; both confirmations are awaited.** The **owner's** approval of §§3–9 is not given
- [x] **Dev C frontend compatibility** — **Varshini approved `aeec98a`** on 26 November 2026, **limited to the Dev C frontend review**. It approves no other owner's decision, authorizes no implementation and opens no gate. Her corrections are preserved in §2.1, §4.3 and §5.4, and her non-blocking `/v1/latest` follow-up is applied in §4.3 and criterion 6
- [ ] **Project owner** — the decisions of §§3–6 and the scope, exclusions and acceptance criteria of §§7–9. **The §10.1 route is already directed; these are not.**

### 10.3 Register of what Route A still requires

**No row is complete as an approval, and rows 1, 5, 6 and 8 are the only ones closed.** Under Route A every row must complete before any code begins; a **technical sign-off closes only the technical half** of a row whose kind is "Technical sign-off, then owner approval". "Technical sign-off" is a named reviewer's approval; "owner approval" is the project owner's.

| # | Item | Kind | Who | Current state |
|---|---|---|---|---|
| 1 | ~~**Extend AD-4's approval beyond the D-24 slice** to cover milestone 3.3~~ | **Owner approval** | Owner | **GRANTED — 26 November 2026.** The owner extended **AD-4 v0.2**'s approval to **milestone 3.3**, with **no AD-4 text change**, **AD4P2-Q1 unapproved** and the **C-1 derivation unchanged**. Recorded in `PHASE3_AD4_EVENT_ENVELOPE.md`'s status block and `PHASE3_SCOPE.md` §12. **It grants no other deliverable and passes no gate.** This is the only row of this table that is closed by an owner approval |
| 2 | **Confirm the AD-1 component view §4 placement** (scope §12 remaining item 1), satisfying **D-22** for 3.2–3.7 | Technical sign-off, then owner approval | **Dev A, Dev B, Dev C**; then owner | **Partly signed off, not approved.** On PR #38: **Dev B granted** the D-22 technical sign-off on **v0.5**; **Dev D approved** §7.3/§7.3.1's boundaries; **Dev C** required the §3.2 source-status correction, made in **v0.6**, and his sign-off is awaited on it; **Dev A's review is outstanding**. Needs AD1P2-Q1, Q5, Q6 and also **Q2, Q3, Q4, Q7** decided, then the **owner's** confirmation. **No milestone 3.2–3.7 is authorized** |
| 3 | **Approve AD-5 as a document** | Technical sign-off, then owner approval | **Dev B** and **Dev D** (AD-5 §16); then owner | **Both technical sign-offs are now in; the owner's approval is not.** **Dev B's technical sign-off at `bfecb46` covers §8.2b, AD5-Q8 and the scoped 3.3-A acceptance requirements** and is stated on PR #38 as still valid for a document unchanged since that commit; **Dev D's** approval also stands. His earlier CHANGES_REQUESTED on `7557a5a` is therefore **closed** (row 5). **AD-5 v0.7b's own status line predates these reviews and is left unedited** — the record is here, not there. Still needs **AD5-Q1 to Q10, Q11(a) and Q11(b)** decided, Q7 permissibly *as provisional*, **Q11(b) still a PENDING owner decision**, then the **owner's approval** |
| 4 | **Approve AD-12 as a document** | Technical sign-off, then owner approval | **Dev A** (Stage 1E rules) and **Dev B** (review-queue persistence), per D-23; then owner | **v0.3.6**. On PR #38 **Dev B** reports the technical content **satisfactory** — the D-24 seed exemption and its acceptance coverage close his earlier blocker — with **formal D-23 sign-off pending the AD-5 review-record correction**, which v0.3.6 makes; his confirmation is awaited. Nisarga approved v0.3.5 from **Dev D's** perspective, which is **not** a D-23 review. **Dev A's D-23 review remains outstanding**, Part B stays `[PENDING: AD-10, AD-11]`, and the **owner's approval** is not given |
| 5 | **Confirm AD-5 §8.2b.1's field matrix** against ordinary redelivery, including the nested `source.*` rows, `supersedes`, `derived_from`'s set semantics and `raw_sha256`'s exclusion | Technical sign-off | **Dev B (Anvesh)** | **CLOSED by Dev B at `bfecb46`** (PR #38, relayed). Reopened four times before that: v0.6 added `case_id` and `generator_version`; v0.7 added `source_timestamp` and `synthetic.seed`; v0.7a added `source_sequence`; **v0.7b consolidated the matrix, fixed the `instance_id` location and the `source_timestamp_basis` enum, classified the nested `source.*` fields and reclassified `supersedes`**. Dev B's sign-off covers that matrix. **It does not decide AD5-Q8**, which is the owner's, so criteria 5 and 5a still turn on that decision |
| 6 | **Confirm §7.4's in-suite registry validation** | Technical sign-off | **Dev D** | **Done.** Nisarga confirmed it at `a35932d`, technically and from Dev D's perspective only. It authorizes no implementation |
| 7 | **Re-review AD-8 v0.7** and grant the partial approval of §5 | Technical sign-off, then owner approval | **Dev B**, **Dev C**, **Dev D**; then owner | **Dev C: PASS** and **Dev D: accepted** on PR #38; **Dev B's re-review and the owner's partial §5 approval are outstanding**. **Not** an F-1 deliverable for 3.3 — scope §7.1 names AD-4, AD-5 and AD-12 — but §5's values are needed for the adapter to be configurable at all (AD-5 §14 gap 3) |
| 8 | **Review this document** under **D-20** | Technical sign-off | At least one of **Dev B**, **Dev D** | **Done.** **Nisarga (Dev D) signed off at `a35932d`** and **approved again at `e4cf979`** on PR #38, which satisfies D-20. Varshini's earlier approval was Dev C frontend scope and would not have. **Dev B's remaining PR #38 blocker was the AD-5 review record, corrected in this revision; his confirmation and Dev C's confirmation of the §3.2 correction are awaited** |
| 11 | **Decide AD5-Q11(b)**, the keying divergence itself | **Owner approval** | Owner, with Dev B and Dev D | **PENDING.** Not requested here and not needed for §7's work; §4.6 requests only **Q11(a)**. Under Route A it must be decided — permissibly as a deferral — for AD-5 to be approvable as a document (row 3) |
| 9 | **Approve §§7–9**: the implementation scope, the twelve exclusions and the **nineteen** acceptance criteria (1–18 plus **5a**, and the deferred 10a) | **Owner approval** | Owner | Open |
| 10 | **Record the outcome** in `docs/PHASE3_SCOPE.md` §2 (3.1 plan §5), with the F-1 and D-22 position | **Owner approval** | Owner | Open. A separate documentation change, not this pull request |

**Rows 1 to 4 are the F-1 and D-22 core.** Row 5 is the open technical sign-off. Row 7 is not F-1 but is a practical precondition. **Row 1 is new in v0.3** and follows directly from Route A; **row 11 is new in v0.4**. **Eleven rows. Rows 6 and 8 are now done** — Nisarga's Dev D technical sign-off at `a35932d`, which satisfies D-20 and confirms §7.4. **The other nine are open**, including every owner approval and the whole F-1/D-22 core, so **nothing is authorized and §7's work may not begin.**

**On completion of every row**, the work of §7 may begin. **No gate passes, no provider becomes approved, and 3.3-L stays blocked on Gate 3.**

## 11. What stays provisional, deliberately

| Item | Why it may stay open |
|---|---|
| **AD5-Q7 / H-1 to H-6** — delivery semantics | AD-2 and AD-3 are drafts. No H-answer changes AD-5 §3.2's operations (§4.5). **Revisit before 3.4.** Under Route A, Q7 must be **decided as provisional** with its deferral recorded, not left blank (§10.1 item 1) |
| **AD5-Q11(b)** — the keying divergence itself | **[PENDING — owner decision].** Only **Q11(a)**, which rule governs which path, is requested (§4.6), and AD-5 v0.7 records it as Q11(a)'s resolution. The narrowing question is named, not answered, and §10.3 row 11 tracks it |
| **AD5-Q2, Q3, Q4, Q5, Q6** | No synthetic source exercises them |
| **AD1P2-Q2, Q3, Q4, Q7** | Needed for AD-1 Part 2 as a document; they change no adapter code |
| **AD8-Q5** — the general stale rule | Explicitly **not** decided by the synthetic row (§5.4) |
| **AD8-Q1, Q2, Q3, Q4, Q7, Q8, Q9, Q10** | Latency, capacity and render instrumentation, none reachable at 2 events/s. **Q4 and Q8 before 3.4** |
| **AD-12 load modes, the general fixture-origin format, Part B** | §6.3; §6.2 proposes a format for this scope's fixtures only; Part B feeds 3.6 |
| **AD4P2-Q1** — the derivation fix | Changes approved text; belongs to a new generator version |
| **AD-10, egress, credentials, B-4, Gate 3** | A synthetic adapter acquires no outbound access, credential or volume. **All become hard blockers at 3.3-L and Gate 4** |
| ~~Whether the registry schema moves into the `contracts` job~~ | **Closed by owner direction (DB-2):** it does not. Validation is in-suite and no workflow changes (§7.4) |

## 12. Residual risks

1. **The C-1 residual risk is open.** Overlapping runs with the same seed and timestamps but a different `case_id` or `generator_version` produced **40** collisions. §6.1's safeguards are containment; AD-5 §8.2b improves **detection**. **Neither fixes the derivation.**
2. **§4.2's C-b predicate is a draft proposal awaiting Dev B.** It has been corrected in **four** rounds on Dev B's findings — v0.6 added `synthetic.case_id` and `generator_version`; v0.7 added `source_timestamp` and `synthetic.seed`; v0.7a added `source_sequence`, after v0.7 wrongly asserted the sequence was not an envelope field; **v0.7b fixed the `instance_id` location, corrected the `source_timestamp_basis` enum, classified the nested `source.*` fields and reclassified `supersedes` as identity-bearing**. **That four rounds were needed is itself the risk.** v0.7b is read off `event-envelope.v1.schema.json` and covers nested paths, which is a stronger method than the prose-derived sets that preceded it — but it remains a hand audit of a draft document against a draft schema. If the set is too wide, **every redelivery becomes a rejected collision** and at-least-once delivery breaks; if too narrow, a collision is **silently discarded as a duplicate or accepted outright**, which is the C-1 defect. §4.2 and §8.2b.2 state both sides, and **nineteen cases of criterion 5 and five of criterion 5a** depend on the answer. **The structural fix is AD4P2-Q1**, which would put the distinguishing fields in the identity and make the predicate derivable instead of enumerated; it is not requested here.
3. **§4.2's formulas in AD-8 are unvalidated.** 30 000 ms is the only one of those figures that has ever run (§5.4).
4. **No load testing.** Exit criterion 9 stays unmet even after AD-8 is approved: it needs a recorded number **and** load tests against it.
5. **A-4 is not exercised**, so the 3.3-S exit is not reached (§1.1, §9).
6. **AD-6 B-4 is unresolved** on the inference side under **D-25, which stays limited to the D-24 slice**. Not Gate 4 evidence; no gate has passed.
7. **Every document this one depends on is a draft without a re-review.** A re-review may change a cited section, in which case the affected request here must be re-stated before it is granted.
8. **The seed-overlap refusal is local.** It reads a version-controlled file in one process and **cannot detect a second container started independently** against the same consumer. Under the read-only, no-volume posture no runtime-shared ledger is available, so this limit is inherent to the scope rather than an omission (§6.1).
9. **The deferred Unavailable display (criterion 10a)** means a withdrawn source's stored values have **no verified user-facing behaviour** until the store and the panel exist. Nothing here stores observations, so nothing is currently displayed from a withdrawn source — but the obligation must travel with the milestone that adds the store. **AD-5 v0.7 splits A-11 into (a) and (b) to make this impossible to lose**: a milestone implementing only (a) may not claim A-11.
10. **Criterion 11 proves packaging exclusion, not image contents.** A static Dockerfile, build-context and `.dockerignore` check cannot detect a path that enters an image by some other route — a changed build context, a new build stage, or a `COPY --from`. The check reads the Dockerfile it is given, so a future Dockerfile change could invalidate the conclusion without failing the test unless the test is maintained with it. Inspecting a built image needs the `phase2-docker` job, which this scope does not touch (§8 item 10).
11. **Criterion 13's real-clock deadline makes one test time-sensitive.** Asserting a 2 000 ms budget on `time.monotonic()` in CI introduces a run-dependent assertion where every other criterion is deterministic. It is accepted deliberately: an injected clock cannot establish that a thread exited (Nisarga 1). The budget is generous against a cooperative worker that performs no unbounded blocking call, and a breach **fails** rather than being retried — but a heavily contended runner is a plausible source of a flake, and if one occurs the correct response is to diagnose it, never to loosen the budget or mark the test flaky.
12. **The `event_id` index's window bounds detection, not only memory.** C-b is detected only between arrivals within one AD-8 `dedup_window` (300 s) of each other; a collision whose first arrival has aged out is **accepted as new and never counted**. AD-5 v0.7b §8.2 states this rather than implying unbounded detection. Extending the horizon, or making it survive a restart, depends on **AD5-Q7** and is not proposed, so **within-run, within-window detection is the whole of what §4.2 buys**.
13. **Eight of §8.2b.1's rows are `[PROPOSED]`.** `source.transport`, `source.source_url`, `source.gate3_decision_ref`, `provenance_class`, `derived_from`, `derivation`, `timestamps.source_timestamp_basis` and `supersedes` all await the owner's **AD5-Q8** decision; Dev B **recommends** four of them and **accepts** `raw_sha256`'s exclusion, which is a recommendation and not a decision. Until AD5-Q8 lands, **cases (j) to (m) of criterion 5 are conditional**, so the criterion cannot be written as a final test.
14. **Most `[PROPOSED]` rows are unreachable in this scope, which is a limit on the evidence.** `source.transport`, `source_url`, `gate3_decision_ref`, `provenance_class`, `derived_from`, `derivation` and `supersedes` are all **constants** in the synthetic path — a synthetic source cannot vary them — so their C-b cases are constructed envelopes, not observed behaviour. **The matrix is therefore validated by construction against the schema, not by any run.** The first real exercise is a provider adapter at 3.3-L, behind Gate 3.
15. **Four review rounds were needed on one predicate.** Each round found a real omission or a factual error about the schema: the field set was being written from prose rather than read off `event-envelope.v1.schema.json`. v0.7b reads it off the schema and includes nested fields, which is a stronger method, but it is still a hand audit of a draft document against a draft schema.

## 13. Decision blockers: both closed by owner direction

| # | Blocker | Direction (relayed, not quoted; v0.3) | Effect |
|---|---|---|---|
| **DB-1** | Does approving named requirements inside draft documents satisfy F-1 and D-22, or must AD-4, AD-5 and AD-12 be approved as documents? | **Route A: the standard F-1 and D-22 process. No special exception.** | **CLOSED.** Route B withdrawn. AD-5 and AD-12 must be approved as documents and **AD-4's approval must be extended beyond the D-24 slice** (§10.1, §10.3 row 1) |
| **DB-2** | Must the registry schema's CI coverage move into the `contracts` job, changing `check_event_contracts.py` and `phase3-observations.yml`? | **No. The existing `ingestion-unit` job validates it. No workflow changes.** | **CLOSED.** Validation is §9 criterion 3 only; §8 item 10 stands unamended; Dev D still reviews the arrangement (§10.3 row 6) |

**Both directions are about process and neither approves a deliverable.** What remains is not a decision blocker but **unfinished approval work**, enumerated in §10.3: ten rows, none done, of which rows 1 to 4 are the F-1 and D-22 core.

**The one technical question that was open inside this request — AD-5 v0.7b §8.2b.1's field matrix — is CLOSED:** Dev B gave the technical sign-off at `bfecb46`, stated on PR #38 (§4.2, §10.2, §10.3 row 5). **Its owner decision is not:** **AD5-Q8** is still the project owner's, with Dev B, so the matrix's `[PROPOSED]` fields stay proposed. **One further owner decision is PENDING and is not requested here:** AD5-Q11(b) (§4.6, §10.3 row 11).

**Status against the PR #37 re-reviews of `aeec98a`.** Every finding is applied in v0.4, AD-5 v0.7 or AD-12 v0.3.2:

| Reviewer | Finding | Where applied |
|---|---|---|
| **Anvesh (Dev B)** | §8.2b omits `source_timestamp` and `synthetic.seed` | AD-5 v0.7 §8.2b; §4.2 |
| **Anvesh** | Remove §8.2's stale idempotency-key rationale | AD-5 v0.7 §8.2 |
| **Anvesh** | Extend criterion 5 to all identity-bearing and excluded fields, `instance_id` included | §9 criterion 5, twelve cases |
| **Nisarga (Dev D)** 1 | Criterion 13 needs a real monotonic deadline and actual thread termination | §9 criterion 13 |
| **Nisarga** 2 | Criterion 11 needs an executable mechanism whose claim matches its evidence | §9 criterion 11; §7.4 |
| **Nisarga** 3 | Record §4.6 as Q11's resolution, or name Q11 an owner decision | Both: **Q11(a)** resolved, **Q11(b) PENDING** (§4.6, §10.3 row 11, §11) |
| **Nisarga** 4 | Align AD-5 A-11; update AD-12 §3.1 and §3.4 | AD-5 v0.7 A-11; AD-12 v0.3.2 §3.1, §3.4, §8 |
| **Varshini (Dev C)** | Non-blocking: distinguish `/v1/latest` 200 from `503 NOT_READY` under `failed_permanent` | §4.3; §9 criterion 6 |

**And the re-reviews of `a35932d`:**

| Reviewer | Finding | Where applied |
|---|---|---|
| **Anvesh (Dev B)** | §8.2b wrongly says the sequence is not an envelope field; include **`source_sequence`** | AD-5 v0.7a §8.2b; §4.2's fact table |
| **Anvesh** | Remove the claim that changing the sequence necessarily changes the payload hash or timestamp | Withdrawn in both documents, with the repository evidence cited |
| **Anvesh** | Add a same-ID, sequence-only rejection as the thirteenth acceptance case | §9 criterion 5, case (e); the criterion now has eighteen |
| **Anvesh** | Cross-check the whole comparison against the v1 schema and the C-1 inputs | AD-5 v0.7a §8.2b: all eighteen properties classified; four `[PROPOSED]` additions, `raw_sha256` flagged |
| **Nisarga (Dev D)** | Non-blocking: clarify the C-b `event_id` index retention horizon | AD-5 v0.7a §8.2; residual risk 12 |
| **Nisarga** | Non-blocking: refresh the stale AD-5 v0.4 reference in AD-12 §3.4 | AD-12 v0.3.3, §§3.1, 3.4, 4 and 9 |

**And the re-review of `7557a5a` — Anvesh's six findings:**

| # | Finding | Where applied |
|---|---|---|
| 1 | `source.instance_id` is not permitted by the v1 schema; name its real location and test redelivery there | AD-5 v0.7b §8.2b.1's `instance_id` paragraph; §4.2's fact table; criterion 5 case (p), varied on the **batch wrapper** |
| 2 | Classify `source.transport`, `source.source_url`, `source.gate3_decision_ref`; the complete-field claim must cover **nested** fields | §8.2b.1 is now one matrix over nested paths, each with its `allOf` dependency; §4.2 |
| 3 | `source_timestamp_basis` is `observed` / `published` / `none`, not `provider` / `derived` / `none`; respect timestamp nullability | §8.2b.1's row; §4.2's fact table; criterion 5 case (l) uses `observed` against `published` with a non-null timestamp |
| 4 | `supersedes` is producer-declared correction evidence; classify it or state an invariant, with coverage. Synthetic keeps `supersedes: null` | **Reclassified identity-bearing**; the AD5-Q10 and D-24 invariant is stated; criterion 5 case (m) |
| 5 | Define `derived_from`'s comparison semantics | **Unordered set**, per Dev B's recommendation; criterion 5 case (k) adds a reordering-only variant that must be **D** |
| 6 | Replace infeasible single-field scenarios with schema-valid ones; separate classifier from envelope-validation tests; defer provider runtime workflows | New §8.2b.2; criterion 5 rebuilt on schema-valid mutations with paired fields; **new criterion 5a** for validation cases; `extraction` and `review` deferred to AD-13 and 3.6 |

**Dev B's two recommendations are recorded, not acted on as approvals:** accepting `provenance_class`, `derived_from`, `derivation` and `source_timestamp_basis` as identity-bearing, and accepting `raw_sha256`'s exclusion. Both remain `[PROPOSED]` pending **AD5-Q8**.

**Nisarga's technical sign-off is recorded, and it is not an authorization.** It satisfies **D-20** (§10.3 row 8) and closes row 6, from **Dev D's perspective only**. It is not a D-23 review of AD-12, not an owner approval, and not implementation authorization. Applying a reviewer's finding is likewise not that reviewer's sign-off. **Nine of §10.3's eleven rows remain open**, including the entire F-1/D-22 core and every owner approval. Dev B must still confirm §8.2b.1's matrix; the owner must still decide §§3–6 and approve §§7–9. **No gate passes, and 3.3-A may not begin.**
