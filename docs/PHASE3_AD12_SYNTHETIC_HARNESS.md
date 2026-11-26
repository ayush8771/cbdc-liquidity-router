# AD-12: Synthetic Event Harness and Review-Queue Specification

**Status:** **APPROVED v0.4**, 26 November 2026, by the project owner — **Part A approved; Part B explicitly DEFERRED; the §3.3 load modes explicitly DEFERRED and unselected.** **v0.3.7's text is unchanged by this approval**; v0.4 records it. The approval is **version-specific to v0.4**, and it makes AD-12 one of the four deliverables milestone 3.3 requires (F-1, scope §7.1). **It authorizes no implementation and passes no gate: all four capability gates remain closed** (D-18). **Gate 2 still governs every knowledge-layer write and Gate 3 every provider**; neither moves.
**D-23 technical sign-offs, both in, relayed from PR #38 and not quoted:** **Dev A — APPROVED for the D-23 Stage 1E requirements** on v0.3.7, "including the verified three-way cap-synchronization rule" (§6.3); **Dev B (Anvesh) — D-23 sign-off GRANTED** on v0.3.7, the revised Stage 1E cap-test evidence and approval records recorded satisfactory. **Dev D (Nisarga)** approved the harness items from **Dev D's perspective** on v0.3.5, which is **not** a D-23 review and is recorded as the extra sign-off it is.
**What is approved:** **Part A** — §3.1's generator facts as the D-24 slice built them, the seed-collision mitigations with the **registry-selected scoping and the D-24 generator's exemption**, the synthetic-only registry assertions, §3.2's determinism and replay rules, §3.4's fixture-origin format for the fixtures a milestone declares, §4's fault-injection catalogue, §5's reused D-24 evidence, §6.1's AD-4-fixed outcomes, §6.3's Stage 1E rules including the **$500,000** cap synchronization, §6.4's what-may-be-built-before-gates, and §7's test hooks. **The §8 limitations are approved as part of it, not despite it.**
**What is DEFERRED, by the owner's decision of 26 November 2026:** **Part B (§6, quarantine and human-review flow)** stays `[PENDING: AD-10, AD-11]` in full — no reviewer-reference format, review-queue persistence, retention, storage separation, refusal record, reviewer authorization or separation-of-duties rule is fixed, and the **quarantined-FX release workflow stays `[OPEN]`**. **The §3.3 load modes** stay **unselected**: Sustained, Peak A and Peak B are not chosen, **Peak A and Peak B conflict** (AD-3 §10 X-1), and the built generator tops out at **2 events/s**. The **§9 open items** stay open, the **C-1 residual risk stays open**, and **AD4P2-Q1 is not approved**. **These deferrals are recorded decisions, not omissions.**
**v0.3.7 and earlier (documentation only) answers the review of commit `9cd7ae2` on two Stage 1E points. §6.3 now names the test that actually enforces the cap rule — `tests/test_stage1e.py::test_generator_cap_matches_knowledge_base_cap` — and describes its **three-way** equality between the generator's `MAX_REGULATORY_TRANSFER_USD`, the single global undated `max_single_transfer_usd` knowledge-base fact and `CogneeMemoryLayer().constraints["max_single_transfer_usd"]`; v0.3.4's citation of `tests/test_stage1e.py`'s value assertion and `tests/test_stage1d.py`'s amount assertion was two independent literals that enforced no equality, and it is withdrawn as evidence. §1.1 now states that AD-5 v0.7b's status line predates the sign-offs §9 records, which removes the apparent contradiction between the two sections. **No requirement, decision, contract, C-1 text, derivation, load mode, Part B item, cap figure, D-24 behaviour or approval of AD-12 changed; nothing here is approved and no gate moves.** **v0.3.6 (documentation only) corrects the review record Dev B's PR #38 review asks for: §9 no longer says AD-5 v0.7b is un-re-reviewed, and records **Dev B's technical sign-off at commit `bfecb46`** covering §8.2b, AD5-Q8 and the scoped 3.3-A acceptance requirements, together with Dev D's standing approval and the PR #38 state of AD-12's own D-23 reviews. **AD5-Q8 stays the owner's decision, AD-5 is not approved as a document, and AD-5's own text and status line are left unedited so the document signed off at `bfecb46` is unchanged.** No requirement, decision, contract, C-1 text, derivation, load mode, Part B item, D-24 behaviour or approval of AD-12 changed; nothing here is approved and no gate moves.** **v0.3.5 (documentation only) completes v0.3.4's reference refresh, on review: the six **AD-8 v0.6** citations (§1.1, §3.3, §3.4, §4) now cite **AD-8 v0.7**, and §1.1's AD-8 row states that document's actual review status — the same two CHANGES_REQUESTED reviews, NOT APPROVED, no re-review, no owner approval, F-5 provisional and exit criterion 9 unmet — with its v0.5, v0.6 and v0.7 revisions named, instead of describing the v0.5 note alone. The cited sections (§3.5, §4.2, §4.3, §6.2, §6.2.1) are unchanged by AD-8 v0.6 and v0.7, so this is a version label and status correction and no claim of AD-12 moves. No requirement, decision, contract, C-1 text, derivation, load mode, Part B item, D-24 behaviour or approval of AD-12 changed.** **v0.3.4 (documentation only) scopes the §3.1 start-up refusal to the registry-selected adapter path and states the D-24 generator's exemption, because the D-24 generator takes its seed from the environment and has no registry or allocation record, so an unscoped refusal would have refused to start the approved slice; adds the synthetic-only registry assertions (`endpoint` null, `credential_ref` null, `egress_allowlist` empty); refreshes the §1.1 references to **AD-5 v0.7b** and **AD-8 v0.7**; acknowledges Dev B's `7557a5a` re-review behind AD-5 §8.2b.1 as a recommendation, not an approval (§9); adds **AD-6 T-10** to §7's non-interference hooks with its text-check limitation; and records the Stage 1E **$500,000** cap synchronization as a constraint on the review flow (§6.3). Two limitations are added in §8. No requirement, decision, contract, C-1 text, derivation, load mode, Part B item, D-24 behaviour or approval of AD-12 changed, and nothing here is approved.** **v0.3.3 (documentation only) applies the second non-blocking observation in Nisarga's technical approval of commit `a35932d`: the stale **AD-5 v0.4** citations in §3.1, §3.4, §4 and §9 now cite **AD-5 v0.7b** (v0.7a at the time of that observation; refreshed again with AD-5's next revision), and §9's AD-5 row records its current review state. The v0.3.1 reference note below is left as the historical record of what that revision did. No requirement, decision, contract, C-1 text, load mode, Part B item or approval of AD-12 changed.** **v0.3.2 (documentation only) applies the architecture-consistency item of Nisarga's PR #37 re-review of commit `aeec98a`: §3.1's seed-allocation mitigations now name their mechanism — a version-controlled, runtime-read-only allocation file and a start-up refusal, with the locality limit stated — and §3.4's fixture-origin format is specified in place of `[OPEN]`, scoped to the fixtures a milestone declares, with existing and T-7-protected fixtures untouched. Two limitations are added in §8. No requirement, decision, contract, C-1 text, load mode, Part B item or approval of AD-12 changed, and nothing here is approved.** **v0.3.1 (documentation only) refreshes references and review status after the merge of PRs #30 to #35, and applies the owner's review of PR #36; see the reference-update note below.** v0.3 answers Dev B's technical review of PR #31 at `d96aabe` (approve with conditions): the synthetic identity collision risk and its provisional mitigations (§3.1), reviewer authorization and separation of duties (§6.2), the open release workflow for quarantined FX observations (§6.2), and the status of referenced documents (§1.1). v0.2 adds synthetic load modes (§3.3), persistence and replay fault cases (§4), Dev B's provisional AD-11 proposals (§6.2), and fixture-origin and fake-provider obligations from the PR #30 drafts. **Lead:** Dev D. **Reviewers:** Dev A (Stage 1E rules), Dev B (review-queue persistence), per D-23. **Approver:** project owner.
**Reference update, v0.3.1 (documentation only, after the merge of PR #30 and the owner's review of PR #36):** references now cite the merged **AD-5 v0.4**, **AD-8 v0.5**, **AD-4 Part 2 v0.2** and **AD-6 Part 2 v0.2** (all DRAFT, not approved), and §1.1 states the status of AD-2, AD-10 and AD-11. The shared-seed collision rule is attributed to AD-5 v0.4 §8.2 (§3.1). The outage reference in §4 is corrected to AD-8 §3.5. No requirement, decision, contract, C-1 text or approval of AD-12 changed.
**Inputs:** AD-4 (v0.2, approved for the D-24 slice only), AD-5 (DRAFT **v0.7b**, in `docs/`, not approved; see §1.1). **Feeds:** milestones 3.3, 3.4, 3.6. **Scope source:** `docs/PHASE3_SCOPE.md` §3 Workstreams A and C, §6, §7.3.

AD-1 §3 stands in for AD-12 **for the D-24 slice only and approves nothing**. This document describes what that slice built, generalizes it only where facts allow, and leaves dependency-bound parts open.

## 1. Owner authorization (recorded)

Ayush (project owner and Dev A) approved the directions below on 26 November 2026, relayed to Dev D, **not quoted; no separate approval document exists**. The approval covers the directions, not this document.

1. AD-2, AD-5 and AD-11 dependent decisions stay provisional.
2. D-24 HTTP polling stays the local synthetic pilot baseline (see AD-3).
3. Timestamp-based gap detection is indicative only, with no event contract change (AD-3 §6).
4. Reviewer references, persistence and retention stay pending coordination with Anvesh's AD-11.
5. D-24 implementation, approvals and documented limitations are preserved.

### 1.1 Status of the documents this specification refers to

| Document | Status |
|---|---|
| AD-1 component view v0.5, AD-4 v0.2, AD-6 v0.2 | Approved for the D-24 slice only (25 November 2026); in `docs/` |
| AD-5 adapter contract **v0.7b**, AD-8 budgets **v0.7**, AD-4 Part 2 v0.2, AD-6 Part 2 v0.2 | **DRAFT, merged into `docs/` from PR #30; no final approval.** Review status as each document states it. **AD-5 v0.7b and AD-4 Part 2 v0.2 (status lines):** "CHANGES_REQUESTED by Nisarga (26 Nov, on v0.1) and by Varshini, Dev C (26 Nov)", "NOT APPROVED", findings applied, "neither reviewer has re-reviewed", no owner approval. **For AD-5 v0.7b, that status line predates the technical sign-offs recorded in §9 and is superseded by them on the review question only (v0.3.7):** Dev B's technical sign-off stands at commit `bfecb46` and Dev D's approval also stands, both relayed from PR #38, so "neither reviewer has re-reviewed" is **no longer current**. The line is **deliberately left unedited in AD-5**, so the document Dev B signed off at `bfecb46` is unchanged; §9 is the record. **"NOT APPROVED" is still exactly right:** there is **no owner approval**, AD-5 is **not approved as a document**, and **AD5-Q8 remains the owner's decision**. **AD-8 v0.7 (status line and revision notes):** the same two reviews, **"NOT APPROVED"**, findings applied, **"neither reviewer has re-reviewed"**, no owner approval; and until the owner approves it, **F-5's targets stay provisional and official exit criterion 9 is unmet** (scope §2.3, §8.2 item 9). Its revision history since: **v0.5** applied Dev B's (Anvesh's) CHANGES_REQUESTED re-review of PR #30 on commit `e457bcf`, whose text is on the pull request and not in the repository; **v0.6** made one arithmetic and wording correction in §4.3 from the owner's review of PR #36; **v0.7** clarified §8.2's 10 s Docker shutdown margin and §5.1's **Express** ownership of the published `source.status`. **Each is documentation only, none is re-reviewed, and none changes a threshold, enum, schema or ownership.** The sections AD-12 cites — §3.5, §4.2, §4.3, §6.2 and §6.2.1 — are **unchanged by v0.6 and v0.7** except §4.3's own correction. No document records a re-review of its applied version or an owner approval. Citations are to those versions and may still change |
| AD-2 v0.2 | **DRAFT, merged; no final approval.** On PR #32 at `be3f6ae`: approved as draft documentation by Dev D with four conditions before final architecture approval, and CHANGES_REQUESTED by the project owner; both rounds applied in v0.2. Its status line records no re-review. Every number is provisional |
| AD-10 v0.2 | **DRAFT, merged; no final approval.** CHANGES_REQUESTED by Dev D and Dev C on PR #33 at `ddac407`, applied in v0.2; no re-review recorded. The isolated backend-inference network is an approved *direction* only. **B-4 stays open** (D-25); nothing is implemented |
| AD-11 v0.3 | **DRAFT, merged; no final approval.** v0.2 on PR #35 was approved as draft architecture documentation by the project owner, with two non-blocking corrections, and CHANGES_REQUESTED by Dev D; v0.3 applies both and has no re-review recorded. Draft approval authorizes no migration, privilege change or implementation. Reviewer references, persistence and retention stay provisional |

Draft-documentation approval (a document may be merged and cited as a draft) is not final architecture approval, and neither is implementation approval. Only the project owner's recorded approval of a document makes it a basis for a code milestone (scope §7, D-22).

## 2. Scope and rules

- **In:** a seeded synthetic source and fault injection; labelling; the quarantine and human-review flow for Workstream C, as a specification.
- **Out:** any implementation, any real-provider data, any knowledge-layer write, any change to AD-4's envelope or to the ingestion and SSE contracts.
- **No provider data before Gate 3.** Recorded samples and fixtures from a provider count as ingestion (D-17).
- **Synthetic events never train, tune or select a policy** (scope §6; AD-4 §3.2) and never affect routing (AD-6).
- Synthetic and observed events are stored so that a query for observed events cannot return synthetic ones; the storage design is `[DEP: AD-11]`.

## 3. Part A: the synthetic harness

### 3.1 Generator (D-24 slice, as approved)

| Item | Fact | Source |
|---|---|---|
| Pairs | AED/MXN, EUR/USD, GBP/PHP, USD/INR; `rate_type` `mid` | AD-1 §3.4 |
| Rate | Each pair every 2 s, staggered by 500 ms (2 events/s). Deliberately unrealistic | AD-1 §3 |
| Determinism | Seed and sequence fix payloads and hashes. Timestamps come from an injected clock | AD-1 §3 |
| `event_id` | UUIDv5 of `seed`, `pair`, `sequence`, `source_timestamp` (correction C-1) | AD-1 §3.4.1 |
| Hashes | `payload_sha256` is the SHA-256 of the RFC 8785 form of `{event_type, payload}`. 11 shared vectors in `contracts/test-vectors/event_payload_hash.v1.json` matched across Python and TypeScript (Dev B's C-1 review, relayed) | AD-4 §2; AD-1 §3.4.1 |
| Markers | Class `synthetic`, transport `synthetic`, `source_id` beginning `synthetic.`, non-null `synthetic` block (generator version, seed, case). No URL, no Gate 3 reference | AD-4 §3.2 |
| Display | Label rule 4: Simulated, with source, age and transport shown | AD-4 §8.1 |

**Known residual (from C-1, still open):** overlapping runs with the same seed and timestamps but a different `case_id` or `generator_version` produced 40 `event_id` conflicts, because the derivation includes neither (AD-1 §3.4.1, Dev B's review, relayed). A general harness must decide whether the identity includes them. `[OPEN]` `[DEP: AD-5 idempotency key]`. This document changes nothing about C-1.

**Second gap: the derivation has no source identity.** The approved C-1 derivation is `UUIDv5(EVENT_ID_NAMESPACE, "seed|pair|sequence|source_timestamp")`; checked in `services/ingestion/cbdc_ingestion/envelope.py`, it uses one fixed namespace and never `source_id`. Two synthetic sources, or a slice run and a load run, that use the same seed, pair, sequence and `source_timestamp` would therefore produce the same `event_id`. Under AD-1 §3.4 an event whose `event_id` matches a current event with different content or pair is a conflict, rejected and counted with the first kept, so the second source's values could be rejected for a whole run, as in C-1's own defect.

**Provisional mitigations, harness rules only, the derivation unchanged** `[PROPOSED]`. **The mechanism of each is specified in v0.3.2**, because without one the start-up check is not testable:

1. **Coordinated seed allocation, as a version-controlled record.** Each synthetic source, load profile and run takes its seed from a recorded allocation, and no two that overlap in time or subjects share one. The record is a file in source control — `services/ingestion/cbdc_ingestion/registry/seed_allocations.json` — listing for each allocation its `seed`, `source_id`, subject set and intended period. **It is read-only at runtime and never written by the process.** That is forced by the container posture of `infra/compose.observations.yaml`: a read-only root filesystem, no volume and no published port, so no runtime-written ledger is possible. Changing an allocation is therefore a reviewed commit, and the commit history is the audit trail.
2. **Disjoint subjects.** Sources registered at the same time use disjoint pair sets, so `pair` never repeats across them. Enforced over the allocation record at start-up.
3. **A start-up refusal, on the registry-selected adapter path only.** The harness **refuses to start** a synthetic source whose `(seed, pair)` overlaps another allocation marked active for the same period, **or whose record is absent from the allocation file**. Refusal, not a warning.

**Scope of mitigation 3: registry-selected adapters, with the D-24 generator path exempt (v0.3.4).** The refusal applies **only where a registry record selects the source**, which is the path AD-5 **§8.2** and **AD5-Q11(a)** already scope the same way. The **existing D-24 generator is exempt**, and must be: it takes its seed from the environment — `CBDC_INGESTION_SEED`, default `20261125`, in `services/ingestion/cbdc_ingestion/settings.py` — and has **no registry record and no allocation entry**, so a refusal that covered it would **refuse to start the approved D-24 slice**. The slice's behaviour is **approved and unchanged** (AD-1 v0.5 §3, D-24), and nothing here alters it. Concretely:

- A source **selected by a registry record** must have an allocation entry, and an absent or overlapping entry is a **start-up refusal**.
- The **env-configured D-24 generator** is **not** subject to the refusal and needs no allocation entry. If a future change ever brings it under the registry, that is a change to approved slice behaviour and **needs the owner's approval**; it is not proposed here.
- The exemption is **scoped to that one path**, not to synthetic sources in general: a registry-selected synthetic source gets no exemption.

**Synthetic-only registry assertions (v0.3.4) `[PROPOSED]` `[DEP: AD-5]`.** Where a registry record selects a synthetic source, the record must carry no outbound reach at all, which is assertable from the record alone (AD-5 §2.1 fields):

- **`endpoint` is `null`** — a synthetic source has nothing to fetch;
- **`credential_ref` is `null`** — it authenticates to nothing, and no secret is involved (AD-5 §12; scope §4.E);
- **`egress_allowlist` is empty** — it contacts no host, so the allowlist has no member to permit.

A synthetic record setting any of the three is a **start-up refusal**, not a warning, and the negative cases are asserted. This adds no field and changes no schema: it constrains the values a `synthetic.`-prefixed record may hold, alongside the existing class and transport checks (AD-5 A-2).

**The limit of mitigation 3, stated rather than papered over.** The check is **in-process and local**: it reads the allocation file and the records the process is starting. It **cannot** detect a second container started independently against the same consumer, because under the read-only, no-volume posture there is no shared runtime ledger to consult. That limit is inherent to the posture, and it is recorded in §8.

None of these replaces a derivation fix. Whether a future generator version adds `source_id`, `generator_version` or `case_id` is the owner's decision in §3.4 and AD4P2-Q1 of `PHASE3_AD4_ENVELOPE_PART2.md` (now in `docs/`, a draft), because C-1 is approved text. AD-4 Part 2 §3.4 item 3 records a further containment that changes no derivation: **one active generator configuration per `source_id`**, a second configuration being a second `source_id`, which enters the idempotency key (AD-5 §8.1). It is proposed, not approved. **Shared-seed collision rule (AD-5 **v0.7b** §8.2, adopting AD-2 R-8; also AD-5's revision note):** a second arrival of a C-1-style collision is a **conflict, not a duplicate**. Load and fault runs must not overlap with a shared seed until AD-5 and AD-12 resolve the residual risk, and a run that does is invalid as a performance result and may be excluded from throughput and latency figures. Exclusion applies to the result only: the collisions are still **detected, rejected, counted and recorded** exactly as in any other run. Provisional; AD-5 is a draft. **The broader C-1 residual risk stays open.**

### 3.2 Determinism and replay rules

The ID and payload depend only on the seed, pair, sequence and injected clock, so a run can be replayed byte for byte. Putting the start moment or `instance_id` in an identity would break replay (AD-1 §3.4.1). `instance_id` stays diagnostic.

### 3.3 Synthetic load modes `[PROPOSED]` `[DEP: AD-2, AD-5, AD-8]`

The D-24 generator produces 2 events/s over four pairs. The rates now proposed are an order of magnitude or two higher, so the harness needs load modes. **Nothing here is built or run.**

| Mode | Profile | Source of the number |
|---|---|---|
| D-24 slice | 2 events/s, 4 pairs | AD-1 §3, approved for the slice |
| Sustained | 20 events/s | Dev B (relayed) and AD-8 v0.7 §6.2 agree |
| Peak A | 100 events/s for up to 10 s | AD-8 v0.7 §6.2 |
| Peak B | 200 events/s for 60 s (12,000 events) | Dev B (relayed) |

Peak A and Peak B conflict and neither is chosen (AD-3 §10, X-1).

Rules:
- **Deterministic.** Seed, injected clock and sequence fix every event, with the C-1 identity (`UUIDv5(seed, pair, sequence, source_timestamp)`) unchanged. Timestamps within a pair stay distinct at the highest rate.
- **Own seed range.** A load source takes a seed and subject set disjoint from the slice's and from every other running source (§3.1 mitigations).
- **More subjects need a separate registered synthetic source.** The slice's four-pair allowlist (AD-1 §3.4) stays as approved. A load source with up to 500 subjects (AD-8 v0.7 §6.2) is an AD-5 registry question `[DEP: AD-5]`, and its `source_id` must begin `synthetic.`. The 500 is a store and pipeline figure, not a browser contract: the approved channel carries exactly four pairs, and a fifth is a protocol change (AD-8 v0.7 §6.2.1a; AD-4 Part 2 AD4P2-Q7).
- **Redelivery ratio.** A mode sets a share of duplicate and redelivered events, to test idempotent persistence and handoff acknowledgement (AD-3 §5.1 H-1, H-2).
- **Test-only.** Load generation lives with the fault tooling, outside every runtime image, and uses no provider data (D-17).
- **Reporting.** Each result states its rate, duration, event count, host, commit and seed. A figure from a synthetic path is described as "streaming pipeline exercised with synthetic events only; no live source integrated" (scope §6).

### 3.4 Fixture origin

Every generated or hand-written fixture carries an origin: `synthetic`, the seed and generator version, or `hand-written`. CI can then show that no fixture came from a provider (AD-5 **v0.7b** §13 A-10; AD-8 **v0.6** §9 N-12; D-17). The envelope's `synthetic` block already carries seed and generator version (AD-4 §3.2) and is **not** changed.

**Format (specified in v0.3.2, `[PROPOSED]`).** A sibling `*.origin.json` for each fixture, or an `_origin.json` manifest per directory, with exactly:

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

`origin` is **`synthetic`** — then `seed`, `generator_version` and `case_id` are **required** — or **`hand-written`**, then all three must be **absent**. **No other value is accepted**, and that is the point: a fixture recorded from a provider has no legal `origin`, so it cannot be added without declaring an illegal one. A fixture with no origin record, an unknown `origin`, or a field set inconsistent with its `origin` **fails CI**.

**Scope of enforcement.** The check applies to **fixtures added under the enforcement roots a milestone declares**, and it **skips paths it does not own**, asserting that it skips them rather than passing them silently. **Existing fixtures are not touched, re-labelled or moved** — including everything under `contracts/events/fixtures/` and, absolutely, `contracts/test-vectors/event_payload_hash.v1.json`, which is **T-7 protected** and whose only authorized addition is already recorded in `AUTHORIZED_ADDITIONS`. Retro-labelling the existing corpus is **not** proposed here and would need its own authorization.

**What stays `[OPEN]`.** Whether this format becomes the repository-wide rule, and whether the existing corpus is ever labelled, are owner decisions. Milestone 3.3-A requests the format **for its own fixtures only** (`docs/PHASE3_33A_AUTHORIZATION.md` §6.2).

## 4. Fault-injection catalogue

Reused from AD-1 §3.7; implemented in D-24 by `infra/testing/fault_ingestion/` (test-only, absent from production images, `PHASE3_D24_ACCEPTANCE.md` §5.4).

| Group | Faults |
|---|---|
| Events | duplicate, late, tie, `event_id` conflict, future (at and beyond 1 s), malformed, wrong hash, quarantined, non-synthetic, extra pair |
| Responses | duplicate pair, oversized, empty, slow, 401, 429 with and without `Retry-After`, 5xx, redirect |
| Source | outage, recovery, restart, clock moved back |
| Streams | slow and abandoned clients, caps, sign-out, shutdown |
| Client | hide, unmount, sign-out aborts; `pageshow` restore; `offline` and `online`; manual retry; every `Retry-After` row; framing and size limits; profile faults; sequence gap and repeat; unknown type or major version; non-synthetic or quarantined value; a superseded 401 |

**Additions proposed for the gap proposal (AD-3 §6),** each a harness case, none a contract change: a poll outage longer than one event interval; a restart at a 500, 1000 and 1500 ms offset; a tail loss with no later event; a loss shorter than the threshold; a clock moved back. Their purpose is to measure how often the indicator is wrong, not to certify it. `[OPEN: not run]`

**Additions for durable handoff, persistence and replay (AD-3 §5.1), proposed, none run** `[DEP: AD-2, AD-3, AD-11]`: acknowledgement lost, so an event is redelivered; backend restart mid-handoff; ingestion buffer overflow, which must be counted; ingestion crash with unacknowledged entries, whose loss must be measured and reported; observation-storage failure with Phase 2 still served; a complete PostgreSQL outage, then restored (AD-3 §5.1 H-7); the same event delivered twice after the dedup window; a replay request past the replay window; a replay gap followed by a browser snapshot resync; a burst at each peak profile (§3.3).

**Fake-provider cases (AD-5 **v0.7b** §13 A-4)** `[DEP: AD-5]`, against a controllable fake provider that is test-only and absent from runtime images: each fault class of the AD-5 taxonomy; `Retry-After` present, absent and invalid; the circuit breaker opening, cooling down and probing; a redirect; an oversized body; a wrong content type; a truncated stream; an immediate close on connect.

**Timing expectations are kept separate.** The D-24 slice keeps its approved values (3 failures or 2 s to outage; stale after 6 s; unavailable after 30 s; AD-1 §3.1, §3.2; AD-8 v0.7 §4.3). The synthetic-transport defaults are provisional: outage at 3 failures or 3 times the interval, and `dedup_window` 300 s (AD-8 v0.7 §3.5); freshness thresholds (AD-8 v0.7 §4.2). These defaults apply only to a newly registered synthetic source. A test states which of the two it exercises and never applies one set to the other. `[DEP: AD-8]`

**Not in D-24, so unspecified here:** gaps and outages longer than the slice's, replay faults (`[DEP: AD-2, AD-3]`), and provider-shaped faults (`[DEP: AD-5]`, Gate 3).

## 5. Harness evidence reused from D-24

| Evidence | Where |
|---|---|
| Harnesses | `e2e/p3_browser_acceptance.py`, `p3_noninterference.py`, `p3_safeguards.py`, `p3_stream_probe.py`; `infra/scripts/p3_stack.py` |
| Log rules | `infra/scripts/assert_harness_log.py` fails on any FAIL or SKIP, non-zero failed or skipped counts, and any missing named check |
| Event contract check | `infra/scripts/check_event_contracts.py`, separate from the unchanged `check_contracts.py`; `contracts/events/` holds three schemas and fixtures |
| Results | `PHASE3_D24_ACCEPTANCE.md` §1, §2, §7 |

**Limits carried forward:** synthetic events only; fault ingestion is test-only; one disposable runner per result; the T-6 hash scope is the trees D-24 §2 names.

## 6. Part B: quarantine and human-review flow (Workstream C) `[specification, mostly pending]`

**Slice position:** no review queue (AD-1 §3). Scope: nothing reaches the knowledge base without a named reviewer and a cited source; knowledge-layer writes need Gate 2 (D-4); there is no automatic path from quarantine to the knowledge layer (AD-1 §4).

### 6.1 Fixed by AD-4 (approved for the slice)

| Topic | Rule |
|---|---|
| Outcomes | `validated`; `quarantined` (never shown as a value); rejected (not an envelope status) |
| Quarantine reasons | `FUTURE_SOURCE_TIMESTAMP`, `VALUE_OUT_OF_RANGE`, `VALUE_JUMP`, `REVIEW_REQUIRED` (every unreviewed `announcement` or extracted item) |
| Immutability | An approval is a **new** event with `supersedes` set, copying the reviewed timestamps except `emitted_at` |
| Reviewer field | `review` holds an opaque internal ID, not a name or email, and a time (format open) |
| Meaning of validated | Permits display only; it is not knowledge (AD-4 §6) |
| Announcement text | Untrusted plain text, never rendered as HTML, never an instruction to a model (AD-4 §4) |

### 6.2 Pending

| Topic | Status |
|---|---|
| **Reviewer reference format** | Dev B proposes a stable, authenticated reference (below). `[PENDING: AD-11 approval]` (AD4-Q7 open) |
| **Review-queue persistence** | Dev B proposes durable review records. `[PENDING: AD-11 approval]` |
| **Retention** of quarantined and reviewed items | Dev B proposes category-specific retention. Categories and periods `[PENDING: AD-11]` |
| Storage separation of synthetic and observed events | Dev B proposes logical storage and privilege separation. `[PENDING: AD-11]` |
| How a **refusal** is recorded | Dev B proposes append-only refusal records (below). `[OPEN]` until AD-11 is approved: AD-4 §2 assigns the design to AD-12 |
| **Reviewer authorization and separation of duties** | `[PENDING: AD-10, AD-11]`. Open questions: who may review (a role, an allowlist), whether a reviewer may review an item **they submitted or caused to be submitted**, whether a second reviewer is required for some categories, and how an authenticated identity maps to the stable reviewer reference. The exact reviewer-versus-submitter restrictions are for architecture approval; **none is fixed here** |
| **Release and review of quarantined FX observations** | `[OPEN]`. AD-4 §6 quarantines an FX value for `FUTURE_SOURCE_TIMESTAMP`, `VALUE_OUT_OF_RANGE` or `VALUE_JUMP`, and `REVIEW_REQUIRED` applies only to announcements and extracted items. No approved text says who reviews a quarantined FX observation, whether it can ever be released, or what record a release leaves. A release must not write to the knowledge layer without Gate 2 |
| Plausibility bounds and clock tolerance | `[DEP: AD-5, AD-8]` (AD4-Q6) |

**Dev B's provisional AD-11 proposals (relayed, not approved; no document in the repository).** Recorded so AD-12 does not diverge, adopted by AD-12 only if AD-11 is approved:

| Proposal | Consistency with approved text |
|---|---|
| Stable, authenticated reviewer references | AD-4 §2 allows only an opaque internal ID, not a name or email. Compatible if the reference maps to an authenticated identity held elsewhere `[DEP: AD-10]` |
| Durable review records | AD-4 §2: events are immutable and an approval is a new event with `supersedes` |
| Logical storage and privilege separation | Matches the separation AD-6 Part 2 v0.2 (draft) requires (T-14); privilege tests are not yet in any test list |
| Category-specific retention | Open; a Gate 3 input for provider data |
| Append-only refusal records | Fits AD-4 §2's immutability: a refusal is a new record, never an edit. Candidate answer to AD-12's open refusal question |

This document **adopts none of them**: no persistence design, retention period, reviewer format or refusal state machine is fixed here, by direction 4. They wait for AD-11's approval.

### 6.3 Stage 1E rules the flow must respect `[DEP: Dev A review]`

Feasibility comes only from the deterministic knowledge base through `StaticMemoryProvider`; Cognee serves explanations and audit only; new facts need a real, cited source; `verified: true` only for checked `real_*` sources; the knowledge base holds one assumed fact today; dated or corridor-scoped facts affecting feasibility need an approved environment change (`docs/STAGE1E_MEMORY.md`, scope Workstream C). Whether a live knowledge update may ever affect feasibility is P5, open (proposed default: no).

**Cap synchronization, recorded in v0.3.4, evidence corrected in v0.3.7 `[DEP: Dev A review]`.** Stage 1E carries one rule this flow can break silently: the **transaction generator's $500,000 regulatory cap must equal the knowledge base's cap** (`docs/STAGE1E_MEMORY.md`; root `CLAUDE.md`).

**The enforcing test, named: `tests/test_stage1e.py::test_generator_cap_matches_knowledge_base_cap`.** It asserts a **three-way equality**, not a pair, and it is the only test that enforces the equality itself:

1. **the generator's cap** — `MAX_REGULATORY_TRANSFER_USD` in `src/training/transaction_generator.py`, imported by the test;
2. **the knowledge base's cap** — the value of the single `max_single_transfer_usd` fact that is **global and undated**, read through `load_knowledge()`, asserted as `kb_caps == [MAX_REGULATORY_TRANSFER_USD]`, which also fails if a **second** such fact is ever added;
3. **the frozen pre-1E constraint** — `CogneeMemoryLayer().constraints["max_single_transfer_usd"]`, asserted equal to the same figure.

**v0.3.4 cited the wrong evidence, and the correction matters for this review.** It named `tests/test_stage1e.py` on the fact's value and `tests/test_stage1d.py` on generated amounts staying under the cap. Those are **two independent literals**: the first checks the knowledge base against `500000.0`, the second checks sampled amounts against `500000.0`, and **neither ties the generator's cap constant to the knowledge base's**. They are useful, and they are not the guarantee. The guarantee is the three-way test above, and the **third** synchronized location — the `CogneeMemoryLayer` constraint — went unmentioned.

So a reviewed item that changed a cap must change **three** places or none, and a release that updated fewer would **fail `test_generator_cap_matches_knowledge_base_cap`** rather than quietly diverge. Two consequences for this specification:

- A quarantine release or review decision **never writes a cap**, or anything else, to the knowledge layer without **Gate 2** (D-4) — the cap is not an exception to that.
- Should a cap ever change by an approved route, the **generator, the knowledge base and the `CogneeMemoryLayer` constraint are updated in the same change**, and `test_generator_cap_matches_knowledge_base_cap` is the check that they were. **AD-12 proposes no cap change**, and the figure is **$500,000** as Stage 1E records it — one fact, `global_max_single_transfer_usd`, `verified: false`, recorded as a project assumption and not a real regulation.

This is a constraint the flow must respect, not a new capability, and it is part of what **Dev A** reviews under D-23.

### 6.4 What may be built before gates

Per scope §6: the quarantine store and review queue **with synthetic announcements**. Announcements from a real provider need Gate 3, and writes to the knowledge layer need Gate 2. Gate 2 evidence AD-12 contributes: the review-queue design. The rest (real cited knowledge, a retrieval-quality measurement, the P5 decision) is not AD-12's and does not exist yet.

ScrapeGraphAI stays deferred until at least one non-scraped adapter works (scope Workstream A). Whether it suits a source is decided per site under Gate 3, evaluated in 3.6.

## 7. Test hooks for AD-13

Seed reproducibility; hash vectors; the same verdict per event fixture in both languages; each fault in §4 with its expected counter; non-interference (AD-6 **T-1, T-2, T-6 and T-10**) while faults run.

**T-10 added in v0.3.4.** **T-10 — "no routing result is displayed in a currency converted with an observed rate"** (AD-6 §8) is the one boundary test a synthetic *harness* can breach without touching the engine at all: a plausible-looking synthetic rate is exactly what a convenience conversion would reach for. It belongs with T-1, T-2 and T-6 for the same reason AD-1 v0.5 §6 item 5, `PHASE3_D24_ACCEPTANCE.md` §1 and the 3.3-A §9 criterion 17 all list it. **Its limit is carried with it:** T-10 is a **text check on the result region**, not a proof over every screen (`PHASE3_D24_ACCEPTANCE.md` §8 item 8; AD-13 §9), and recording it here adds no test and changes no suite.

## 8. Limitations

1. The harness is synthetic; it says nothing about any provider's behaviour.
2. The generator's rates are deliberately unrealistic.
3. The C-1 residual (§3.1) is open.
4. The review flow is a specification with its key parts pending; nothing in it is implemented or tested.
5. Gap-detection, handoff, persistence and replay fault cases (§4) are proposed, not run.
6. Load modes (§3.3) are specified only. The built generator tops out at 2 events/s, and the peak profiles conflict (AD-3 §10, X-1).
7. **The §3.1 start-up refusal is local.** It reads a version-controlled allocation file in one process and cannot detect a second container started independently against the same consumer. Under the read-only, no-volume posture no shared runtime ledger exists, so this is inherent to the posture rather than an omission.
8. **The §3.4 fixture-origin format is enforced only on the fixtures a milestone declares.** The existing fixture corpus is unlabelled and is not re-labelled; whether it ever is remains an owner decision.
9. **The §3.1 start-up refusal does not cover the D-24 generator path at all.** That path is env-configured and exempt, so the seed safeguards protect **registry-selected** sources only. The slice's own protection against a seed collision remains what C-1 gave it, and the broader C-1 residual stays open.
10. **The §3.1 synthetic-only registry assertions are `[PROPOSED]` and `[DEP: AD-5]`.** They are assertions over a registry record whose schema AD-5 has not had approved, and nothing enforces them today.

## 9. Open items and dependencies

| Item | Status |
|---|---|
| AD-5 adapter contract, idempotency key, bounds | `[DEP: Dev A]`; **AD-5 v0.7b** is a DRAFT in `docs/`; changes requested across four review rounds and applied; **no owner approval** (§1.1). **Dev B's technical sign-off of v0.7b is recorded (v0.3.6), at commit `bfecb46`:** in the PR #38 review Anvesh (Dev B) states that the earlier technical sign-off **remains valid**, that the document is **unchanged since `bfecb46`**, and that it covers **§8.2b**, **AD5-Q8** and the **scoped 3.3-A acceptance requirements** — so §8.2b.1's field matrix, which v0.3.4 could record only as a *recommendation*, now has Dev B's confirmation. The review text is on PR #38, **relayed here, not quoted**. **Dev D's** technical approval of v0.7b also stands, per Nisarga's PR #38 approval. **What this is not:** **AD5-Q8 remains the project owner's decision** (with Dev B), the `[PROPOSED]`/`[DevB]` fields stay `[PROPOSED]` until it is decided, **AD-5 is not approved as a document** and **AD-5 v0.7b's own status line predates these reviews** — it is deliberately left unedited so the document Dev B signed off at `bfecb46` is unchanged. **AD-12's D-23 reviews: Dev B reports its technical content satisfactory, with formal sign-off pending this record correction (applied here, confirmation awaited); Dev A's is still outstanding** |
| Synthetic identity: source identity absent from the approved derivation | Provisional mitigations in §3.1; derivation unchanged; broader C-1 residual open |
| Reviewer authorization, separation of duties; quarantined FX release workflow | `[PENDING: AD-10, AD-11]`; `[OPEN]` |
| AD-11 reviewer reference, persistence, retention, storage separation | `[DEP: Anvesh]`; provisional proposals recorded in §6.2, none approved |
| Load profile (peak) and subject count | `[OPEN: AD-2, AD-5, AD-8]` (AD-3 §10, X-1) |
| Idempotency, replay and B-4 conflicts | Recorded in AD-3 §10 (X-3, X-4, X-5); not resolved here |
| AD-2, AD-3 replay faults | `[DEP]` |
| Refusal recording | `[OPEN]` |
| Dev A, Dev B review; owner approval | **ALL THREE GIVEN.** **Dev A — APPROVED for the D-23 Stage 1E requirements** and **Dev B — D-23 sign-off GRANTED**, both on v0.3.7 (PR #38, relayed); **project owner — APPROVED v0.4**, 26 November 2026, with **Part B and the §3.3 load modes deferred**. Neither reviewer has reviewed v0.4, whose only change is this record. Earlier state, for the record: `[PENDING]`. **PR #38, recorded in v0.3.6:** **Dev B** reports v0.3.4's technical content **satisfactory** — the D-24 seed exemption and its acceptance coverage close the earlier blocker — with **formal D-23 sign-off pending the AD-5 review-record correction**, which this revision makes; his confirmation on the corrected text is awaited. **Dev D (Nisarga) approved v0.3.5**, technically and **from Dev D's perspective only**, which is **not** a D-23 review. **Dev A's D-23 review (Stage 1E rules, §6.3) and the owner's approval remain outstanding**, and Part B stays `[PENDING: AD-10, AD-11]` |
