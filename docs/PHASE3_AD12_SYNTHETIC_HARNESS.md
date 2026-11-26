# AD-12: Synthetic Event Harness and Review-Queue Specification

**Status:** **DRAFT v0.3.2 for review. Not approved.** 26 November 2026. **v0.3.2 (documentation only) applies the architecture-consistency item of Nisarga's PR #37 re-review of commit `aeec98a`: §3.1's seed-allocation mitigations now name their mechanism — a version-controlled, runtime-read-only allocation file and a start-up refusal, with the locality limit stated — and §3.4's fixture-origin format is specified in place of `[OPEN]`, scoped to the fixtures a milestone declares, with existing and T-7-protected fixtures untouched. Two limitations are added in §8. No requirement, decision, contract, C-1 text, load mode, Part B item or approval of AD-12 changed, and nothing here is approved.** **v0.3.1 (documentation only) refreshes references and review status after the merge of PRs #30 to #35, and applies the owner's review of PR #36; see the reference-update note below.** v0.3 answers Dev B's technical review of PR #31 at `d96aabe` (approve with conditions): the synthetic identity collision risk and its provisional mitigations (§3.1), reviewer authorization and separation of duties (§6.2), the open release workflow for quarantined FX observations (§6.2), and the status of referenced documents (§1.1). v0.2 adds synthetic load modes (§3.3), persistence and replay fault cases (§4), Dev B's provisional AD-11 proposals (§6.2), and fixture-origin and fake-provider obligations from the PR #30 drafts. **Lead:** Dev D. **Reviewers:** Dev A (Stage 1E rules), Dev B (review-queue persistence), per D-23. **Approver:** project owner.
**Reference update, v0.3.1 (documentation only, after the merge of PR #30 and the owner's review of PR #36):** references now cite the merged **AD-5 v0.4**, **AD-8 v0.5**, **AD-4 Part 2 v0.2** and **AD-6 Part 2 v0.2** (all DRAFT, not approved), and §1.1 states the status of AD-2, AD-10 and AD-11. The shared-seed collision rule is attributed to AD-5 v0.4 §8.2 (§3.1). The outage reference in §4 is corrected to AD-8 §3.5. No requirement, decision, contract, C-1 text or approval of AD-12 changed.
**Inputs:** AD-4 (v0.2, approved for the D-24 slice only), AD-5 (DRAFT v0.4, in `docs/`, not approved; see §1.1). **Feeds:** milestones 3.3, 3.4, 3.6. **Scope source:** `docs/PHASE3_SCOPE.md` §3 Workstreams A and C, §6, §7.3.

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
| AD-5 adapter contract v0.4, AD-8 budgets v0.5, AD-4 Part 2 v0.2, AD-6 Part 2 v0.2 | **DRAFT, merged into `docs/` from PR #30; no final approval.** Review status as each document states it. **AD-5 v0.4 and AD-4 Part 2 v0.2 (status lines):** "CHANGES_REQUESTED by Nisarga (26 Nov, on v0.1) and by Varshini, Dev C (26 Nov)", "NOT APPROVED", findings applied, "neither reviewer has re-reviewed", no owner approval. **AD-8 v0.5 (status line and v0.5 revision note):** the same two reviews, and the note applies Dev B's (Anvesh's) CHANGES_REQUESTED re-review of PR #30 on commit `e457bcf`; its text is on the pull request, not in the repository. No document records a re-review of its applied version or an owner approval. Citations are to those versions and may still change |
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
3. **A start-up refusal.** The harness **refuses to start** a synthetic source whose `(seed, pair)` overlaps another allocation marked active for the same period, **or whose record is absent from the allocation file**. Refusal, not a warning.

**The limit of mitigation 3, stated rather than papered over.** The check is **in-process and local**: it reads the allocation file and the records the process is starting. It **cannot** detect a second container started independently against the same consumer, because under the read-only, no-volume posture there is no shared runtime ledger to consult. That limit is inherent to the posture, and it is recorded in §8.

None of these replaces a derivation fix. Whether a future generator version adds `source_id`, `generator_version` or `case_id` is the owner's decision in §3.4 and AD4P2-Q1 of `PHASE3_AD4_ENVELOPE_PART2.md` (now in `docs/`, a draft), because C-1 is approved text. AD-4 Part 2 §3.4 item 3 records a further containment that changes no derivation: **one active generator configuration per `source_id`**, a second configuration being a second `source_id`, which enters the idempotency key (AD-5 §8.1). It is proposed, not approved. **Shared-seed collision rule (AD-5 v0.4 §8.2, adopting AD-2 R-8; also AD-5's revision note):** a second arrival of a C-1-style collision is a **conflict, not a duplicate**. Load and fault runs must not overlap with a shared seed until AD-5 and AD-12 resolve the residual risk, and a run that does is invalid as a performance result and may be excluded from throughput and latency figures. Exclusion applies to the result only: the collisions are still **detected, rejected, counted and recorded** exactly as in any other run. Provisional; AD-5 is a draft. **The broader C-1 residual risk stays open.**

### 3.2 Determinism and replay rules

The ID and payload depend only on the seed, pair, sequence and injected clock, so a run can be replayed byte for byte. Putting the start moment or `instance_id` in an identity would break replay (AD-1 §3.4.1). `instance_id` stays diagnostic.

### 3.3 Synthetic load modes `[PROPOSED]` `[DEP: AD-2, AD-5, AD-8]`

The D-24 generator produces 2 events/s over four pairs. The rates now proposed are an order of magnitude or two higher, so the harness needs load modes. **Nothing here is built or run.**

| Mode | Profile | Source of the number |
|---|---|---|
| D-24 slice | 2 events/s, 4 pairs | AD-1 §3, approved for the slice |
| Sustained | 20 events/s | Dev B (relayed) and AD-8 v0.5 §6.2 agree |
| Peak A | 100 events/s for up to 10 s | AD-8 v0.5 §6.2 |
| Peak B | 200 events/s for 60 s (12,000 events) | Dev B (relayed) |

Peak A and Peak B conflict and neither is chosen (AD-3 §10, X-1).

Rules:
- **Deterministic.** Seed, injected clock and sequence fix every event, with the C-1 identity (`UUIDv5(seed, pair, sequence, source_timestamp)`) unchanged. Timestamps within a pair stay distinct at the highest rate.
- **Own seed range.** A load source takes a seed and subject set disjoint from the slice's and from every other running source (§3.1 mitigations).
- **More subjects need a separate registered synthetic source.** The slice's four-pair allowlist (AD-1 §3.4) stays as approved. A load source with up to 500 subjects (AD-8 v0.5 §6.2) is an AD-5 registry question `[DEP: AD-5]`, and its `source_id` must begin `synthetic.`. The 500 is a store and pipeline figure, not a browser contract: the approved channel carries exactly four pairs, and a fifth is a protocol change (AD-8 v0.5 §6.2.1a; AD-4 Part 2 AD4P2-Q7).
- **Redelivery ratio.** A mode sets a share of duplicate and redelivered events, to test idempotent persistence and handoff acknowledgement (AD-3 §5.1 H-1, H-2).
- **Test-only.** Load generation lives with the fault tooling, outside every runtime image, and uses no provider data (D-17).
- **Reporting.** Each result states its rate, duration, event count, host, commit and seed. A figure from a synthetic path is described as "streaming pipeline exercised with synthetic events only; no live source integrated" (scope §6).

### 3.4 Fixture origin

Every generated or hand-written fixture carries an origin: `synthetic`, the seed and generator version, or `hand-written`. CI can then show that no fixture came from a provider (AD-5 v0.4 §13 A-10; AD-8 v0.5 §9 N-12; D-17). The envelope's `synthetic` block already carries seed and generator version (AD-4 §3.2) and is **not** changed.

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

**Fake-provider cases (AD-5 v0.4 §13 A-4)** `[DEP: AD-5]`, against a controllable fake provider that is test-only and absent from runtime images: each fault class of the AD-5 taxonomy; `Retry-After` present, absent and invalid; the circuit breaker opening, cooling down and probing; a redirect; an oversized body; a wrong content type; a truncated stream; an immediate close on connect.

**Timing expectations are kept separate.** The D-24 slice keeps its approved values (3 failures or 2 s to outage; stale after 6 s; unavailable after 30 s; AD-1 §3.1, §3.2; AD-8 v0.5 §4.3). The synthetic-transport defaults are provisional: outage at 3 failures or 3 times the interval, and `dedup_window` 300 s (AD-8 v0.5 §3.5); freshness thresholds (AD-8 v0.5 §4.2). These defaults apply only to a newly registered synthetic source. A test states which of the two it exercises and never applies one set to the other. `[DEP: AD-8]`

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

### 6.4 What may be built before gates

Per scope §6: the quarantine store and review queue **with synthetic announcements**. Announcements from a real provider need Gate 3, and writes to the knowledge layer need Gate 2. Gate 2 evidence AD-12 contributes: the review-queue design. The rest (real cited knowledge, a retrieval-quality measurement, the P5 decision) is not AD-12's and does not exist yet.

ScrapeGraphAI stays deferred until at least one non-scraped adapter works (scope Workstream A). Whether it suits a source is decided per site under Gate 3, evaluated in 3.6.

## 7. Test hooks for AD-13

Seed reproducibility; hash vectors; the same verdict per event fixture in both languages; each fault in §4 with its expected counter; non-interference (AD-6 T-1, T-2, T-6) while faults run.

## 8. Limitations

1. The harness is synthetic; it says nothing about any provider's behaviour.
2. The generator's rates are deliberately unrealistic.
3. The C-1 residual (§3.1) is open.
4. The review flow is a specification with its key parts pending; nothing in it is implemented or tested.
5. Gap-detection, handoff, persistence and replay fault cases (§4) are proposed, not run.
6. Load modes (§3.3) are specified only. The built generator tops out at 2 events/s, and the peak profiles conflict (AD-3 §10, X-1).
7. **The §3.1 start-up refusal is local.** It reads a version-controlled allocation file in one process and cannot detect a second container started independently against the same consumer. Under the read-only, no-volume posture no shared runtime ledger exists, so this is inherent to the posture rather than an omission.
8. **The §3.4 fixture-origin format is enforced only on the fixtures a milestone declares.** The existing fixture corpus is unlabelled and is not re-labelled; whether it ever is remains an owner decision.

## 9. Open items and dependencies

| Item | Status |
|---|---|
| AD-5 adapter contract, idempotency key, bounds | `[DEP: Dev A]`; AD-5 v0.4 is merged as a DRAFT in `docs/`; changes requested earlier and applied; no owner approval (§1.1) |
| Synthetic identity: source identity absent from the approved derivation | Provisional mitigations in §3.1; derivation unchanged; broader C-1 residual open |
| Reviewer authorization, separation of duties; quarantined FX release workflow | `[PENDING: AD-10, AD-11]`; `[OPEN]` |
| AD-11 reviewer reference, persistence, retention, storage separation | `[DEP: Anvesh]`; provisional proposals recorded in §6.2, none approved |
| Load profile (peak) and subject count | `[OPEN: AD-2, AD-5, AD-8]` (AD-3 §10, X-1) |
| Idempotency, replay and B-4 conflicts | Recorded in AD-3 §10 (X-3, X-4, X-5); not resolved here |
| AD-2, AD-3 replay faults | `[DEP]` |
| Refusal recording | `[OPEN]` |
| Dev A, Dev B review; owner approval | `[PENDING]` |
