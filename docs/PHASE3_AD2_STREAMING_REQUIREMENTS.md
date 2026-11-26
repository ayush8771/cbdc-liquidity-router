# AD-2: Streaming Requirements

**Status:** **DRAFT v0.1 for review. Not approved.** 26 November 2026 (second working revision, still v0.1; not yet reviewed). Every new number is **provisional** (`[#?]`) until the project owner approves this document; none is a final budget (AD-8 sets those, D-12).
**Lead:** Dev B. **Reviewers:** Dev A, Dev D (D-23). **Approver:** project owner.
**Inputs:** F-4, F-5, F-6; D-17; AD-4 v0.2 and AD-6 v0.2 (approved for the D-24 slice only). **Feeds:** AD-3; milestone 3.4. **Coordinates with:** AD-5 (semantic deduplication), AD-8 (measurement, budgets), AD-11 (storage, retention).
**Scope source:** `docs/PHASE3_SCOPE.md` v1.4 §3 Workstream B, §6, §7.3; `docs/PHASE3_MILESTONE_3_1_PLAN.md` §3–§5.
**Labels:** requirement IDs here are **AD-2 R-n**. AD-8's draft uses R-1 to R-7 for recovery drills; cite with the document prefix.

This document states requirements only. It chooses no mechanism (AD-3 does; roadmap §4.B), changes no contract, Compose file, schema or code, and uses no provider data (D-17).

## 1. Owner directions applied (relayed)

Relayed to Dev B by the project owner, 26 November 2026; **no approval document exists in the repository**, so they are relayed, not quoted. They approve directions, not this document.

1. D-24 is accepted; stale D-24 records are corrected separately.
2. Event identity (`event_id`) is separate from semantic deduplication, which is AD-5's.
3. **Durable delivery and consumer replay are the direction for the broader pilot.** All numbers stay provisional.
4. Persistence is **backend-mediated** (supported by Dev D, relayed): ingestion gets no database access without a separate approval (AD-1 §3.6; AD-11).

## 2. Unapproved drafts read (not authoritative)

Read with read-only Git references on 26 November 2026. None is merged or approved; they inform this draft and are **not** sources of decisions.

| PR | Head | Content used |
|---|---|---|
| #30 | `5f78500` | AD-5 §5, §8 (identity, five-part idempotency key, late events); AD-8 §2.2, §3.2, §6.2, §6.3, §8.1 (measurement points, envelope, limits, recovery) |
| #31 | `d96aabe` | AD-3 v0.2 §3.1, §5.1 (H-1 to H-7), §10 (X-1 to X-5); AD-12 v0.2 §3.3 |
| #29 | `d47e582` (latest; owner review `CHANGES_REQUESTED` on `5e98d5a`, relayed in its header) | AD-9 §1 (assigns replay and durability to AD-2) |

## 3. D-24: accepted slice evidence, not requirements

The D-24 slice (AD-1 v0.5 §3, §3.1, §3.4, §3.5; `docs/PHASE3_D24_ACCEPTANCE.md`) is the **measured baseline**. Its parameters are not adopted as permanent requirements, and nothing here changes them for the slice.

| Slice fact | Value | Status here |
|---|---|---|
| Rate | 2 events/s: 4 pairs, each every 2 s (AD-1 §3) | Baseline; AD-2 R-1 sets the design ceiling |
| Transport | Express polls `GET /v1/latest` every 500 ms (AD-1 §3.1) | Baseline; AD-3 decides the milestone mechanism |
| **`/v1/latest` limits (preserved)** | Returns at most **one** validated envelope per pair, the latest; no cursor, no history, no acknowledgement; quarantined events never served (AD-1 §3.1) | Intermediate events between two polls are **not recoverable** through it. It cannot satisfy AD-2 R-7 without a contract change, which this document does not propose |
| Durability, replay | None; "a restart may lose state" (AD-1 §3) | Superseded for milestones by R-6 to R-9 |
| Stream caps | 3 per user, 20 total (`services/backend/src/observations/constants.ts:61-62`) | Kept for the slice; R-11 is the design load (conflict X-1, §10) |
| Ordering and conflicts | AD-1 §3.4; C-1 (§3.4.1) | **Preserved**; generalized in R-4, R-5, R-8 |
| Targets | F-5 provisional; slice display measured from `emitted_at` on one host | **Preserved as provisional**; R-13 |

## 4. Terms

- **Subject:** what a current value is "of". For `fx_rate`, (`source_id`, base, quote, `rate_type`); other types per AD-5 `[DEP: AD-5]` (draft AD-5 §6.3 gives announcements no subject).
- **Acceptance point:** the component that validates an event and commits it durably, then acknowledges it. Under direction 4 it is **the backend side** of the handoff; AD-3 names the component.
- **Accepted:** validated **and** durably committed at the acceptance point (transaction committed and flushed per the store's durability settings, AD-11).
- **Transport redelivery:** the same event (same `event_id`) delivered again between components.
- **Semantic duplicate:** a different `event_id` describing the same observation (AD-5's).
- **Correction:** a validated event that names an earlier event in `supersedes` (AD-4 §2).

## 5. Requirements matrix (for AD-3)

Rates are **design ceilings for synthetic load**, not provider measurements (no provider documentation is in the repository; D-17). A Gate 3 record replaces the ceiling for its provider.

| ID | Requirement | Number `[#?]` | Rationale | Acceptance criterion |
|---|---|---|---|---|
| **R-1** | Sustained throughput at the acceptance point | **20 events/s** (≤ 20 FX subjects at 1/s) | Ten times the slice's measured rate; AD-8 draft §6.2 proposes the same | 30 min at 20/s: accepted count = produced count minus counted R-7 losses (expected 0 with no faults); R-13 holds |
| **R-2** | Other categories (roadmap §4.A) | Economic ≤ 500/day; announcements ≤ 2,000/day; holidays ≤ 5,000 per batch, ≤ daily | Low frequency; the holiday batch is the only burst | 5,000-event batch accepted ≤ 60 s while R-1 runs; FX keeps R-13 |
| **R-3** | Peak | **200 events/s for 60 s = 12,000 events** | Adapter reconnect or backfill. **Conflicts with AD-8 draft §6.2** (100/s for 10 s): X-1 | Burst test: no unaccounted loss; FX delivery back within R-13 ≤ 30 s after the burst |
| **R-4** | Ordering | **Per subject.** Current value = greatest `source_timestamp` (AD-4 §5); ties: first kept, counted (AD-1 §3.4). No global order. **Replay order** per subject uses a storage sequence assigned at persistence (AD-3 v0.2 H-3, AD-11) | AD-4 §5; replay needs a stable order that `source_timestamp` ties cannot give | Out-of-order and tie fixtures: current value correct; replay returns each subject's events in storage-sequence order |
| **R-5** | Late, corrected and withheld events | See §6 | Separates five cases the previous text conflated | §6 table |
| **R-6** | Durability after acceptance | Under the **fault model in §7**, an accepted event is not lost and is not duplicated in the store | Replaces the slice's "a restart may lose state". Not an unconditional claim: §7 lists what it does **not** cover | §7 fault tests F-1 to F-4 |
| **R-7** | Handoff before acceptance | The producer keeps a **bounded, ordered buffer** of validated envelopes with an opaque position, discards only acknowledged entries or on exhaustion, and redelivers with the same `event_id` and timestamps (AD-4 §2, §5; AD-3 v0.2 H-1). Three independent limits, the first reached applies: **event count 12,000**, **bytes 32 MiB**, **entry age 10 min** (all `[#?]`). Loss before acceptance is **possible and must be accounted** (§7) | Defines the durable boundary. Coverage without acknowledgements: 12,000 events = 10 min at R-1, or **60 s at R-3**; a 10-min mixed workload with one R-3 minute needs **22,800** (§9), so the count limit, not the age limit, binds first under peak. The byte limit guards against large envelopes: at 900 B, 12,000 events ≈ 10.8 MB, but at the 65,536-byte payload ceiling (C-2) 12,000 events could exceed 780 MB | Acceptance point down 5 min at R-1: zero buffer losses; down 15 min: losses counted exactly, source status degraded |
| **R-8** | Idempotent persistence | At the acceptance point: same `event_id`, identical content → no second record; same `event_id`, different content → conflict, rejected, counted (AD-1 §3.4). Enforced by a **store uniqueness rule**, not by AD-5's in-memory `dedup_window` (AD-3 v0.2 H-2). Semantic deduplication is separate (§8) | At-least-once handoff makes redelivery normal | Redeliver 10% of events 1–3 times: stored count = distinct `event_id`s; conflict fixture counted |
| **R-9** | Consumer replay | A **server-side consumer** resumes from its last committed position within **24 h** and receives every accepted event since, per R-4. Outside the window it is told so and resyncs from current state. Positions are stored durably (AD-11) | Consumer restarts and slow consumers | Consumer stopped 1 h: no gap; stopped 25 h: explicit "outside window", then resync |
| **R-10** | Browser recovery | Browsers **never replay**. Every (re)connection gets one **snapshot** of current values, then updates (AD-1 §3.3.1, kept). Original timestamps are kept, so no value looks fresher than it is (AD-4 §5) | Bounded browser recovery; replay is for consumers only | One snapshot per resumption; ages consistent with `source_timestamp` |
| **R-11** | Fan-out | ≤ **3** server-side consumers; ≤ **60** browser streams (20 users × 3). **Conflicts with AD-8 draft §6.3** (20 total): X-1 | Named pilot users (D-1) | 60 streams at R-1: R-13 holds on every stream |
| **R-12** | Overload | **Accepted events are not dropped by overload.** Browser delivery may **coalesce per subject, newest wins**, and a stream that cannot drain within a bound is closed and resyncs by snapshot (AD-1 §3.5 generalized). Coalescing is **not** loss of an accepted event and is counted separately (AD-3 v0.2 §5.2). Before acceptance, R-7 applies | Bounds memory without losing stored history | 2 × R-3 for 60 s: store complete for everything acknowledged; coalesce and close counters non-zero; AD-6 T-1 identical |
| **R-13** | Latency | F-5 unchanged and **provisional**: event-to-display p95 ≤ 1 s, reconnect p95 ≤ 5 s. Measurement points are **AD-8's**; its draft §2.2 proposes T1 (`retrieved_at`) to T6 (render) and segment T3→T4 ≤ 300 ms. This document **does not** set a segment number (my earlier 250 ms is withdrawn in favour of AD-8) | AD4-Q1 and the F-5 start point are AD-8's | Measured as approved AD-8 defines; until then reported as slice-style measurements, labelled |
| **R-14** | Synthetic and observed separation | Distinguishable at every hop and store; observed-only subscription and query possible (AD-4 §3.2) | AD-4 §3.2; scope §6 | Observed-only consumer and query return zero synthetic events |
| **R-15** | Isolation | AD-6 B-3 to B-5 stay provable; ingestion gets no database handle or credential (direction 4; AD-1 §3.6) | AD-6; AD-3 v0.2 §5.1 | AD-6 T-1, T-2, T-5 (ingestion side), T-6 pass on the chosen mechanism |
| **R-16** | Operational burden | Single host (F-6); no new always-on service unless R-1 to R-15 need one; recovery without manual steps after a restart | Scope §3.B | AD-3 reports measured memory and restart behaviour on a stated host |
| **R-17** | Observability | Counters: accepted; rejected by reason; quarantined; late by bucket (§6); corrections; redelivered; conflicts; buffer occupancy, expiries and exhaustion losses; coalesced; stream closes; consumer lag. No payloads in logs (AD-1 §3.4) | Makes R-5 to R-12 measurable; names align with AD-8 draft §7.1 when approved | Each AD-12 fault case moves its expected counter |

## 6. AD-2 R-5: late, corrected and withheld events

| Case | Definition | Stored? | Becomes current? | Constraint |
|---|---|---|---|---|
| **Ordinary late arrival** | Valid; `source_timestamp` older than the subject's current value; arrives within the late-tracking horizon (24 h `[#?]`) | **Yes** | Never | Counted by lateness bucket: ≤ 1 min, ≤ 1 h, ≤ 24 h |
| **Eligible late history** | Valid; older than the horizon, delivered by a provider backfill or replay | **Only if** the source's Gate 3 terms permit storing history for that period (`retention_policy_ref`, AD-5 draft §2.2) and the event falls inside AD-11's retention for its category | Never | Otherwise **not stored**, counted as `late_outside_retention`. This is a retention or permission refusal, not a validation rejection |
| **Validated correction** | Valid; `supersedes` names an earlier event of the same source and type (AD-4 §2; draft AD-4 Part 2 V-4) | **Yes**; the superseded event is kept unchanged | The correction replaces the superseded event **only if** it is that subject's newest by R-4; a superseded event is never current again (AD-4 §8.1) | Correction history is AD-11's |
| **Quarantined** | Valid envelope withheld: `FUTURE_SOURCE_TIMESTAMP`, `VALUE_OUT_OF_RANGE`, `VALUE_JUMP`, `REVIEW_REQUIRED` (AD-4 §6) | **Yes**, in quarantine only (AD-11), never as an observation | Never, unless a review approves it as a **new** event (AD-4 §6; AD-12) | Reviewer identity per AD-10/AD-11 |
| **Rejected** | Cannot form a valid envelope, or fails validation | Only a rejection record without payload (draft AD-4 Part 2 §5.4) | — | Lateness alone **never** causes rejection |

## 7. Durability fault model (R-6, R-7)

**Covered** (R-6 applies):

| # | Fault | Required outcome |
|---|---|---|
| F-1 | Backend or consumer process restart | No accepted event lost; redelivery absorbed by R-8 |
| F-2 | Database connection loss during a write | The write is not acknowledged; the producer keeps the entry (R-7) and redelivers |
| F-3 | Container restart of the store, with its volume intact | Committed events survive |
| F-4 | Acknowledgement lost after commit | Redelivery is a no-op (R-8) |

**Not covered** (loss is possible and must be **counted and reported**, never hidden):

| # | Fault | Accounting |
|---|---|---|
| L-1 | **Producer buffer exhaustion** (R-7 bound reached) | Count per source; source status `degraded`; oldest-or-newest discard rule stated by AD-3 |
| L-2 | **Buffer expiry** (entry older than 10 min unacknowledged) | Count per source as expired |
| L-3 | **Ingestion crash or restart** with an in-memory buffer | Every unacknowledged entry is lost (AD-3 v0.2 H-1). Counted on restart as "buffer lost, size unknown" unless the buffer is durable, which would need an approved change to ingestion's no-volume isolation (AD-1 §3.6) |
| L-4 | Provider-side loss, or loss before ingestion receives an item | Indicated only (AD-3 §6 gap counters); unrecoverable without a Gate 3-permitted backfill |
| L-5 | Disk or volume loss | Bounded by backup and recovery objectives (AD-11; AD-8 draft §8) |
| L-6 | Observation-storage failure while PostgreSQL serves Phase 2 | Backend stops acknowledging; then L-1/L-2; routing unaffected (AD-3 v0.2 H-7; AD6-Q2) |

**Measured versus unquantifiable loss.** L-1 (exhaustion, by event, byte or age limit) and L-2 (expiry) are **measured**: each discarded entry is counted while the process runs. L-3 (crash with an in-memory buffer) and L-4 (provider-side loss) are **not quantifiable**: the count dies with the process, or the event never reached ingestion. They are recorded as **gap indications** (a restart marker with the last acknowledged position; AD-3 §6 timestamp-gap counters), never as a number of lost events.

**Failure accounting invariant (proposed), for the measured part only:** for each source within one ingestion process lifetime, `emitted = accepted + rejected + quarantined + duplicates + buffer_exhausted + buffer_expired + still_buffered`. A test that cannot balance it fails. Across a crash or restart the invariant is reset and the boundary is recorded as a gap; no claim of zero loss is made across it.

**Synthetic identity collisions (PR #31 AD-12 v0.2 §3.1, C-1 residual):** two overlapping synthetic runs with the same seed and timestamps but a different `case_id` or `generator_version` produce the same `event_id`. Under R-8 the second arrival is a **conflict** (rejected and counted), not a duplicate. Until AD-5/AD-12 resolve it, load and fault runs must not overlap with a shared seed. A run that does is **invalid as a performance result** and may be excluded from throughput and latency figures, but its conflicts are **still detected, rejected, counted and recorded** (R-8; AD-11 P-3) exactly as in any other run: exclusion applies to the result, never to conflict detection.

## 8. Identity and semantic deduplication

| | Event identity | Semantic deduplication |
|---|---|---|
| Key | `event_id` (AD-4 §2) | Defined by **AD-5** (draft §8.1 proposes `source_id`, `event_type`, subject, `source_timestamp`, `payload_sha256`) |
| Purpose | Absorb transport redelivery (R-8); detect conflicts | Recognize one observation under different `event_id`s |
| Preserved | AD-4 §2; AD-1 §3.4; C-1 derivation for the synthetic generator (AD-1 §3.4.1) | — |

**Deferred to AD-5, not decided here:** the semantic key; deduplication and ordering when `source_timestamp` is null (draft AD-5 §8.1 marks such sources `dedup: within_run`); and the C-1 residual (overlapping synthetic runs, AD-1 §3.4.1). AD-2 requires only that concurrent synthetic runs do not share an identity space, and that persistence-level idempotency (R-8) does not depend on an in-memory window. **Conflict X-3** (AD-3 v0.2 §10): the draft AD-5 key contains `payload_sha256` but defines a conflict as the same key with a different hash, which cannot occur; AD-5 must resolve it.

## 9. Capacity and retention rationale

**Size basis (measured from fixtures, not production):** the valid synthetic `fx_rate` envelope fixtures under `contracts/events/fixtures/envelope/` serialize to **838–891 bytes** of compact JSON (measured 26 November 2026 with Python's `json.dumps(..., separators=(",", ":"))`). This draft uses **900 B** for `fx_rate` and **2,048 B** as a conservative assumption for text-bearing types (announcements), which have no fixture yet.

| Quantity | Arithmetic | Result |
|---|---|---|
| Events per day at R-1 | 20/s × 86,400 s | **1,728,000** |
| Burst at R-3 | 200/s × 60 s | **12,000** |
| R-7 buffer at R-1 | 20/s × 600 s | 12,000 (= one R-3 burst) |
| 10 min mixed: 9 min at R-1 + 1 min at R-3 | 20 × 540 + 200 × 60 | **22,800** (exceeds the 12,000 count limit) |
| Envelope bytes per day, 900 B | 1,728,000 × 900 | **1.56 GB/day** (≈ 1.45 GiB) |
| Same at 2,048 B | 1,728,000 × 2,048 | 3.54 GB/day |
| 24 h replay window, 900 B | — | ≈ 1.56 GB |
| 30 days, 900 B | 30 × 1.56 GB | ≈ 46.7 GB |
| One R-3 burst, 900 B | 12,000 × 900 | ≈ 10.8 MB |
| R-7 buffer, 900 B | 12,000 × 900 | ≈ 10.8 MB of ingestion memory |

**Excluded and unmeasured:** row and tuple overhead, indexes (the R-8 uniqueness index, storage sequence), PostgreSQL WAL, TOAST, the storage sequence and positions, backups, and quarantine, rejection and context records. Real usage will be **higher** than these figures by an unmeasured factor; the spike AD-3 runs must measure it. Retention periods per category are **AD-11's**, bounded by each provider's Gate 3 terms.

## 10. Alignment and conflicts

| ID | With | Conflict or gap | Resolution path |
|---|---|---|---|
| X-1 | AD-8 draft §6.2, §6.3 | Peak 200/s × 60 s vs 100/s × 10 s; 60 streams vs 20 | Owner decides AD2-D3 with AD-8; AD-3 load test uses both until then |
| X-2 | AD-8 draft §8.1 | "No recovery-point objective in v1" vs R-6 durability direction | AD-8 to adopt R-6/§7 once the direction (§1 item 3) is approved |
| X-3 | AD-5 draft §8.1, §8.2 | Key contains the hash; conflict definition cannot trigger; null timestamps | AD-5 |
| X-4 | AD-5 draft §8.3 | "Older: ignored, counted as late" vs R-5 "stored, never current" | AD-5 to state ignored means **not current**, not **not stored** |
| X-5 | AD-8 draft §3.5 | `dedup_window` 300 s vs 24 h replay | R-8: persistence idempotency does not use the window (agrees with AD-3 v0.2 H-2) |
| X-6 | AD-3 v0.2 §6 | Gap counters are indicative only | Compatible; they satisfy part of R-17 and do not replace R-6/R-7 |

**AD-3 options** (AD-3 v0.2 §5): this document approves no technology. Fit: A (poll + SSE, as built) **fails R-7** (`/v1/latest` has no history or acknowledgement); B (backend-mediated PostgreSQL) can meet R-6 to R-9 with H-1 to H-7 and keeps R-15, subject to the L-3 limit; C (a broker) needs a new service against R-16 and a new credential design.

## 11. Decisions

| # | Decision | Alternatives | Recommendation | Depends on | Approver | Evidence |
|---|---|---|---|---|---|---|
| AD2-D1 | Durability level | Best effort; at-least-once handoff + idempotent persistence; exactly-once | **At-least-once + idempotent** (R-6 to R-8), with the §7 fault model | AD-3, AD-11 | Owner, after Dev A and Dev D review | F-1 to F-4; accounting invariant |
| AD2-D2 | Replay | None; consumers 24 h; browsers too | **Consumers only** (R-9); browser snapshots (R-10) | AD-3, AD-7, AD-11 | Owner | R-9, R-10 tests |
| AD2-D3 | Design ceilings | Slice; this draft; AD-8 draft | **Provisional**; resolve X-1 jointly with AD-8 | AD-8, Gate 3 | Owner | AD-3 load test |
| AD2-D4 | Late, correction and history rule | §6 | **§6** | AD-5, AD-11, Gate 3 | Owner, Dev A | §6 fixtures |
| AD2-D5 | Producer buffer limits and discard rule | Count only; count + age; count + bytes + age; larger count (for example 22,800 to cover a mixed peak window) | **12,000 events, 32 MiB, 10 min**, first reached; whether to size for 22,800 is open; discard rule from AD-3 | AD-3, AD-5 | Owner, Dev A, Dev D | R-7 test; invariant |
| AD2-D6 | Semantic key, null timestamps, C-1 residual | — | **AD-5** | AD-5 | Owner, Dev A | AD-5 |
| AD2-D7 | Measurement points and segment budgets | — | **AD-8** | AD-8 | Owner | AD-8 |

## 12. Limitations

1. No rate, size or latency here is a production measurement; envelope size comes from fixtures.
2. The acceptance point is a role until AD-3 names a component.
3. R-6 does not cover L-1 to L-6.
4. Event types other than `fx_rate` need AD-5 subjects before R-4 applies.

## 13. Approval checklist

- [ ] Dev A: R-5 (§6), R-7, R-8, §8 hand-off; X-3, X-4
- [ ] Dev D: §5 matrix as AD-3 input; §7; §10
- [ ] Project owner: AD2-D1 to AD2-D7
