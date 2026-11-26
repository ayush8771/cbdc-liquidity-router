# AD-12: Synthetic Event Harness and Review-Queue Specification

**Status:** **DRAFT v0.1 for review. Not approved.** 26 November 2026. **Lead:** Dev D. **Reviewers:** Dev A (Stage 1E rules), Dev B (review-queue persistence), per D-23. **Approver:** project owner.
**Inputs:** AD-4 (v0.2, approved for the D-24 slice only), AD-5 (unwritten). **Feeds:** milestones 3.3, 3.4, 3.6. **Scope source:** `docs/PHASE3_SCOPE.md` §3 Workstreams A and C, §6, §7.3.

AD-1 §3 stands in for AD-12 **for the D-24 slice only and approves nothing**. This document describes what that slice built, generalizes it only where facts allow, and leaves dependency-bound parts open.

## 1. Owner authorization (recorded)

Ayush (project owner and Dev A) approved the directions below on 26 November 2026, relayed to Dev D, **not quoted; no separate approval document exists**. The approval covers the directions, not this document.

1. AD-2, AD-5 and AD-11 dependent decisions stay provisional.
2. D-24 HTTP polling stays the local synthetic pilot baseline (see AD-3).
3. Timestamp-based gap detection is indicative only, with no event contract change (AD-3 §6).
4. Reviewer references, persistence and retention stay pending coordination with Anvesh's AD-11.
5. D-24 implementation, approvals and documented limitations are preserved.

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

### 3.2 Determinism and replay rules

The ID and payload depend only on the seed, pair, sequence and injected clock, so a run can be replayed byte for byte. Putting the start moment or `instance_id` in an identity would break replay (AD-1 §3.4.1). `instance_id` stays diagnostic.

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
| **Reviewer reference format** | `[PENDING: AD-11, Anvesh]` (AD4-Q7 open) |
| **Review-queue persistence** | `[PENDING: AD-11, Anvesh]` |
| **Retention** of quarantined and reviewed items | `[PENDING: AD-11, Anvesh]` |
| Storage separation of synthetic and observed events | `[PENDING: AD-11]` |
| How a **refusal** is recorded | `[OPEN]`: AD-4 §2 assigns it to AD-12. Candidates need AD-11's persistence model first, so no design is given |
| Reviewer authorization and identity source | `[OPEN]` `[DEP: AD-10]` |
| Plausibility bounds and clock tolerance | `[DEP: AD-5, AD-8]` (AD4-Q6) |

No persistence, retention period, reviewer format or refusal state machine is proposed in this draft, by direction 4.

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
5. Gap-detection fault cases (§4) are proposed, not run.

## 9. Open items and dependencies

| Item | Status |
|---|---|
| AD-5 adapter contract, idempotency key, bounds | `[DEP: Dev A]` unwritten |
| AD-11 reviewer reference, persistence, retention, storage separation | `[DEP: Anvesh]` |
| AD-2, AD-3 replay faults | `[DEP]` |
| Refusal recording | `[OPEN]` |
| Dev A, Dev B review; owner approval | `[PENDING]` |
