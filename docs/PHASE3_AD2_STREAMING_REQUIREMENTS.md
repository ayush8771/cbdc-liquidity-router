# AD-2: Streaming Requirements

**Status:** **DRAFT v0.2 for review. Not approved.** 26 November 2026. **Review state:** reviewed on PR #32 at `be3f6ae` — **APPROVED as draft documentation by Nisarga (Dev D), with four conditions before final architecture approval**, and **CHANGES_REQUESTED by the project owner (Ayush)**. Both rounds are applied in v0.2; **neither reviewer has re-reviewed**, and no owner approval exists. Every new number is **provisional** (`[#?]`) until the project owner approves this document; none is a final budget (AD-8 sets those, D-12).

**Revision v0.2, 26 November 2026 — still DRAFT.** Documentation only: no number, requirement, contract, schema or code changes except where a review asked for it. Applied:

| From | Finding | Where applied |
|---|---|---|
| Owner (Ayush) 1 | Capacity above AD-8's envelope must trigger AD-8 revision, re-approval and budget **remeasurement** before milestone 3.4 | **§5.1**, R-3, R-11, X-1, AD2-D3 |
| Owner (Ayush) 2 | Event-to-display p95 is **unmeasurable** today: T6 is not instrumented. Record the gap and its effect on dependent acceptance criteria | **§5.2**, R-1 to R-3, R-11, R-13, §12 |
| Owner (Ayush) 3 | Correct the T3→T4 reference to AD-8 **§3.2** | R-13 |
| Owner (Ayush) 4 | Clarify B-4's remaining verification gap | R-15, §12 |
| Owner (Ayush) 5 | Coordinate replay retention with AD-11 | R-9, §9, AD2-D2 |
| Nisarga 1 | Gap-safe replay ordering: a PostgreSQL sequence does not guarantee commit-visibility order | **§5.3**, R-4, R-9, X-7, **AD2-D8** |
| Nisarga 2 | Update references to the revised AD-5 keys and to AD-8's capacity reconciliation | §2, §8, X-1, X-3, X-5 |
| Nisarga 3 | Coordinate the versioned ingestion handoff and acknowledgement interface with AD-3 | R-7, X-8 |
| Nisarga 4 | Define injectable-clock replay tests; reconcile buffer sizing with acceptance-test budgets | **§5.4**, R-7, R-9, AD2-D5 |
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

| PR | Head | State on 26 November 2026 | Content used |
|---|---|---|---|
| #30 | **`730f75a`** (AD-5 **v0.4**, AD-8 **v0.5**; it answers Dev B's re-review of `e457bcf`, and **no reviewer has re-reviewed it**. `e457bcf` and `5f78500` are superseded; the AD-1, AD-4 and AD-6 companions are unchanged between `e457bcf` and `730f75a`) | **Open**, not merged, not approved | AD-5 **v0.4** §5, §8.1 to §8.5, **§8.2a** (identity; the **two keys**; validated corrections; late events; null timestamps; restart-safe deduplication); AD-8 **v0.5** §2.2, §2.3.1, §2.4, §3.1, §3.2, **§6.1a**, §6.2, **§6.2.1**, **§6.2.1a**, §6.3, §7.1, §7.3, §8.1, §9, §12 |
| #31 | **`15fd739`** (`d96aabe` was v0.2 and is superseded) | **Merged into `feature/phase3-platform`** on 26 November 2026. Merging is **not approval**: AD-3, AD-12 and AD-13 are each still **DRAFT v0.3, not approved** | AD-3 **v0.3** §3.1, §5.1 (H-1 to H-7), §5.2, §10; AD-12 **v0.3** §3.1, §3.3, §6.2; AD-13 **v0.3** §3.3 (G4-1 to G4-5) |
| #29 | `d47e582` | **Merged into `feature/phase3-platform`** on 26 November 2026, still **DRAFT v0.1, not approved** (owner review `CHANGES_REQUESTED` on `5e98d5a`, relayed in its header) | AD-9 §1 (assigns replay and durability to AD-2); §3.5 (the channel's authentication failure semantics, which AD-10 and AD-7 must keep or state each change) |

**Version references in this document.** Where an earlier revision cited a PR head or a draft version that has since moved, the citation is updated to the revision named above. No decision, threshold or ownership moves with a citation, and nothing in those drafts becomes authoritative by being merged into `feature/phase3-platform`.

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
| **R-1** | Sustained throughput at the acceptance point | **20 events/s** (≤ 20 FX subjects at 1/s) | Ten times the slice's measured rate; AD-8 v0.5 §6.2 proposes the same | 30 min at 20/s: accepted count = produced count minus counted R-7 losses (expected 0 with no faults); R-13 holds **only as far as it is measurable today** (§5.2) |
| **R-2** | Other categories (roadmap §4.A) | Economic ≤ 500/day; announcements ≤ 2,000/day; holidays ≤ 5,000 per batch, ≤ daily | Low frequency; the holiday batch is the only burst | 5,000-event batch accepted ≤ 60 s while R-1 runs; FX keeps R-13, subject to §5.2 |
| **R-3** | Peak | **200 events/s for 60 s = 12,000 events** | Adapter reconnect or backfill. **Exceeds AD-8 v0.5 §6.2's envelope** (100/s for 10 s) on both rate and duration, so **AD-8 §6.2.1's escalation applies** (X-1; §5.1): AD-8 is revised, **re-approved, and its §3 latency budgets re-measured, before milestone 3.4 begins**, and this document's own approval records the dependency | Burst test: no unaccounted loss; FX delivery back within R-13 ≤ 30 s after the burst, measured as §5.2 allows. **This criterion cannot be accepted against AD-8's budgets until §5.1's escalation has completed** |
| **R-4** | Ordering | **Per subject.** Current value = greatest `source_timestamp` (AD-4 §5); ties: first kept, counted (AD-1 §3.4). No global order. **Replay order** per subject uses a storage sequence assigned at persistence (AD-3 v0.3 H-3; AD-11 §4). **The sequence alone is not sufficient:** a monotonic sequence is allocated **before** commit, so it does not order commit *visibility*, and replay must therefore be **gap-safe** (§5.3). The gap-safe mechanism is **open** (AD2-D8) and is AD-3's and AD-11's to specify | AD-4 §5; replay needs a stable order that `source_timestamp` ties cannot give, **and one that no reader can read past while a lower sequence is still uncommitted** | Out-of-order and tie fixtures: current value correct; replay returns each subject's events in storage-sequence order **with no sequence value skipped** under §5.3's concurrent-writer fixture, on an injectable clock (§5.4) |
| **R-5** | Late, corrected and withheld events | See §6 | Separates five cases the previous text conflated | §6 table |
| **R-6** | Durability after acceptance | Under the **fault model in §7**, an accepted event is not lost and is not duplicated in the store | Replaces the slice's "a restart may lose state". Not an unconditional claim: §7 lists what it does **not** cover | §7 fault tests F-1 to F-4 |
| **R-7** | Handoff before acceptance | The producer keeps a **bounded, ordered buffer** of validated envelopes with an opaque position, discards only acknowledged entries or on exhaustion, and redelivers with the same `event_id` and timestamps (AD-4 §2, §5; AD-3 v0.3 H-1). **The interface that would carry the position and the acknowledgement does not exist:** AD-3 v0.3 H-1 records that the D-24 `GET /v1/latest` returns only the latest event per pair and cannot carry it, so a **new, versioned ingestion interface** is required, and that change needs its own approval. This document requires the capability and **proposes no interface, no version and no contract change**; the interface, its version and its acknowledgement semantics are coordinated with AD-3 (X-8). Three independent limits, the first reached applies: **event count 12,000**, **bytes 32 MiB**, **entry age 10 min** (all `[#?]`). Loss before acceptance is **possible and must be accounted** (§7) | Defines the durable boundary. Coverage without acknowledgements: 12,000 events = 10 min at R-1, or **60 s at R-3**; a 10-min mixed workload with one R-3 minute needs **22,800** (§9), so the count limit, not the age limit, binds first under peak. The byte limit guards against large envelopes: at 900 B, 12,000 events ≈ 10.8 MB, but at the 65,536-byte payload ceiling (C-2) 12,000 events could exceed 780 MB | Acceptance point down 5 min at R-1: zero buffer losses; down 15 min: losses counted exactly, source status degraded. Every age and expiry bound is exercised on an **injectable clock**, not by waiting (§5.4) |
| **R-8** | Idempotent persistence | At the acceptance point: same `event_id`, identical content → no second record; same `event_id`, different content → conflict, rejected, counted (AD-1 §3.4). Enforced by a **store uniqueness rule**, not by AD-5's in-memory `dedup_window` (AD-3 v0.3 H-2). Semantic deduplication is separate (§8) | At-least-once handoff makes redelivery normal | Redeliver 10% of events 1–3 times: stored count = distinct `event_id`s; conflict fixture counted |
| **R-9** | Consumer replay | A **server-side consumer** resumes from its last committed position within **24 h** and receives every accepted event since, per R-4 and **gap-safely** (§5.3). Outside the window it is told so and resyncs from current state. Positions are stored durably (AD-11 §3 P-9). **The 24 h window is a floor on P-2 retention, not a retention decision:** AD-11 §8 sets retention per family — observed P-2 ≥ the replay window and **bounded by each provider's Gate 3 terms**, synthetic P-2 30 days — and AD-11 §4 reports a position older than P-2's retention as "outside window". If an approved Gate 3 term, or AD11-D6, sets an observed retention **shorter** than 24 h, that retention is the window for that source and **R-9 is reduced accordingly for it**: provider terms win | Consumer restarts and slow consumers | Consumer stopped 1 h: no gap **and no sequence value skipped**; stopped 25 h: explicit "outside window", then resync. Both on an injectable clock (§5.4), never by waiting 25 h. A source whose retention is below the window is tested against **its** retention |
| **R-10** | Browser recovery | Browsers **never replay**. Every (re)connection gets one **snapshot** of current values, then updates (AD-1 §3.3.1, kept). Original timestamps are kept, so no value looks fresher than it is (AD-4 §5) | Bounded browser recovery; replay is for consumers only | One snapshot per resumption; ages consistent with `source_timestamp` |
| **R-11** | Fan-out | ≤ **3** server-side consumers; ≤ **60** browser streams (20 users × 3). **Exceeds AD-8 v0.5 §6.3's limit** (20 total), so **AD-8 §6.2.1's escalation applies on the concurrency dimension** (X-1; §5.1) | Named pilot users (D-1) | 60 streams at R-1: R-13 holds on every stream, measured as §5.2 allows, and **not acceptable against AD-8's budgets until §5.1's escalation has completed** |
| **R-12** | Overload | **Accepted events are not dropped by overload.** Browser delivery may **coalesce per subject, newest wins**, and a stream that cannot drain within a bound is closed and resyncs by snapshot (AD-1 §3.5 generalized). Coalescing is **not** loss of an accepted event and is counted separately (AD-3 v0.3 §5.2). Before acceptance, R-7 applies | Bounds memory without losing stored history | 2 × R-3 for 60 s: store complete for everything acknowledged; coalesce and close counters non-zero; AD-6 T-1 identical |
| **R-13** | Latency | F-5 unchanged and **provisional**: event-to-display p95 ≤ 1 s, reconnect p95 ≤ 5 s. Measurement points are **AD-8's**: its **§2.2** names T1 (`retrieved_at`) to T6 (render), and its **§3.2** sets the segment budgets, T3→T4 ≤ 300 ms among them. This document **does not** set a segment number (my earlier 250 ms is withdrawn in favour of AD-8). **Event-to-display p95 is not measurable today:** T6 is not instrumented anywhere, so no measurement of the T1-to-T6 interval exists (§5.2) | AD4-Q1 and the F-5 start point are AD-8's | **Until T6 instrumentation exists this requirement has no corresponding measurement.** What is measurable is the narrower `emitted_at`-to-arrival interval of AD-8 §2.3.1, against the slice's own approved target, and it is **not evidence** for event-to-display p95. Every criterion in this matrix reading "R-13 holds" is therefore satisfied only in that narrower sense and is **labelled as such** (§5.2) |
| **R-14** | Synthetic and observed separation | Distinguishable at every hop and store; observed-only subscription and query possible (AD-4 §3.2) | AD-4 §3.2; scope §6 | Observed-only consumer and query return zero synthetic events |
| **R-15** | Isolation | AD-6 B-3 to B-5 stay provable; ingestion gets no database handle or credential (direction 4; AD-1 §3.6). **B-4 is not satisfied, and nothing here closes it:** AD-6 v0.2 records B-4 as **unresolved**, D-25 waives the **inference side** for the D-24 slice only, T-5 is run and claimed for the **ingestion side only**, and the inference-side test (draft AD-6 Part 2 **T-13**, PR #30) is **not run and not claimed**. Closure is AD-10's, through its §3.6 stages 1 to 4, and needs an owner record | AD-6; AD-3 v0.3 §5.1 | AD-6 T-1, T-2, T-5 (ingestion side), T-6 pass on the chosen mechanism. **The remaining verification gap is the inference side of B-4** — T-13 and AD-10 §3.6 probes 1 to 8 — which no mechanism choice here can close |
| **R-16** | Operational burden | Single host (F-6); no new always-on service unless R-1 to R-15 need one; recovery without manual steps after a restart | Scope §3.B | AD-3 reports measured memory and restart behaviour on a stated host |
| **R-17** | Observability | Counters: accepted; rejected by reason; quarantined; late by bucket (§6); corrections; redelivered; conflicts; buffer occupancy, expiries and exhaustion losses; coalesced; stream closes; consumer lag. No payloads in logs (AD-1 §3.4) | Makes R-5 to R-12 measurable; names align with AD-8 v0.5 §7.1 when approved | Each AD-12 fault case moves its expected counter |

### 5.1 Capacity above AD-8's envelope: the escalation this requires

**Owner direction applied (Ayush, review of PR #32).** Where a requirement here exceeds AD-8's current envelope, that is **not** a conflict to be left standing in a table: it triggers AD-8's own **§6.2.1 reconciliation rule**. In AD-8 **v0.5** (PR #30, `730f75a`) that rule applies **per dimension**, and its "above" row reads "**AD-8 is revised and re-approved, and its affected budgets re-measured, before milestone 3.4 begins.** A latency budget measured under one envelope is not evidence under a larger one", naming **burst rate and duration** and **stream concurrency**. For a dimension AD-8 leaves **silent**, AD-8 instead "**adopts** AD-2's figure … No AD-8 re-measurement is needed for a bound it never claimed". This section is AD-2's record of that dependency; AD-8 v0.5 §6.2.1 now carries the same comparison from its side.

| Dimension | AD-2 requirement | AD-8 v0.5 envelope | Above? | Consequence |
|---|---|---|---|---|
| Sustained rate | **20 events/s** (R-1) | 20 events/s (§6.2) | **At** the envelope | Nothing changes; R-1 cites the envelope as headroom |
| Peak | **200 events/s for 60 s** (R-3) | 100 events/s for up to 10 s (§6.2) | **Above**, on rate **and** duration | AD-8 §6.2 revised and **re-approved**; §3 budgets **re-measured** at the new peak |
| Browser streams | **60** (R-11) | 20 in total (§6.3) | **Above** | AD-8 §6.3 amended on the concurrency dimension; §3 budgets **re-measured** at 60 streams |
| Server-side consumers | ≤ **3** (R-11) | **Silent** (AD-8 v0.5 §6.2.1) | Silent dimension | AD-8 **adopts** AD-2's approved figure; no re-measurement |
| Producer retention before acceptance | **12,000 events / 32 MiB / 10 min** (R-7) | **Silent** | Silent dimension | AD-8 adopts it and states the resulting recovery objective in its §8.1 |
| Consumer replay window | **24 h** (R-9) | **Silent** | Silent dimension | As above |
| Distinct subjects | ≤ 20 FX subjects (R-1) | ≤ 500 (§6.2) — a **store and pipeline** bound, **not** a browser contract (AD-8 v0.5 §6.2.1a) | Below | Nothing changes. Growing the **browser** subject set beyond the four approved pairs is a protocol change (AD-7 AD7-D7; AD4P2-Q7), not a capacity one |
| Largest event payload | 65,536 B of event `data`, excluding SSE framing (C-2) | Same (§6.2) | Equal | Nothing changes |

**Sequence required before milestone 3.4 begins** (no step may be skipped, and none is complete):

1. The owner decides **AD2-D3**, which fixes whether the ceilings above are the requirement.
2. **AD-8 is revised** on the dimensions marked "above" and **re-approved** by the owner; on the "silent" dimensions it adopts AD-2's approved figures without re-measurement (AD-8 v0.5 §6.2.1).
3. AD-8's **affected latency budgets are re-measured** under the revised envelope — re-measured, **not** re-asserted — with §5.2's measurability limit disclosed in the result.
4. AD-8 §9's load tests run at the revised figures.

**Until step 4 is complete, no latency or capacity claim in this document is evidence**, and AD-3's load test runs **both** sets of figures (X-1). This document asserts no budget and amends no AD-8 section: AD-8 is Dev A's, and only the owner can re-approve it.

### 5.2 R-13 is not measurable today: the T6 gap

**Owner direction applied (Ayush, review of PR #32).** F-5's event-to-display p95 ≤ 1 s is **unmeasurable** as written, and this document must say so rather than carry it as a testable criterion.

| Item | State |
|---|---|
| Interval F-5 is applied to | **T1 (`retrieved_at`) to T6 (render)**, per AD-8 §2.2 and §2.3 |
| Is T6 instrumented? | **No.** Nothing in `services/web/src` or the browser spec measures render latency (AD-8 §2.4, recorded as AD-8 gap **1a**). The client's existing `performance.now()` use advances a value's **age** and is a different measurement |
| Whether it will be | **Open: AD8-Q9** asks the owner, with Dev C and Dev D, whether T6 instrumentation is wanted and in which form. A harness-only hook is AD-8's recommendation. **No production browser telemetry** (AD-8 §2.4, §7.2) |
| What *is* measured | AD-8 **§2.3.1**'s arrival latency: `emitted_at` (T2) to frame arrival at a programmatic SSE client, clock-skew-corrected, against AD-1 §3's approved slice target |
| Why that is not a substitute | The proposed interval is **wider at both ends**. AD-8 §2.3.1 and **AD8-Q10** state that the slice's passing figure is necessary but **not sufficient**, and is **not evidence** for T1 to T6. The shared 1,000 ms figure is a coincidence of F-5's target, not a derivation |

**Effect on the acceptance criteria in §5** — every criterion that depends on R-13:

| Criterion | Effect |
|---|---|
| R-1 "R-13 holds" after 30 min at 20/s | Evaluable **only** on §2.3.1 arrival latency. Reported with the interval named, and **not** reported as event-to-display p95 |
| R-2 "FX keeps R-13" during the holiday batch | As R-1 |
| R-3 "back within R-13 ≤ 30 s after the burst" | As R-1, **and** blocked on §5.1's escalation |
| R-11 "R-13 holds on every stream" at 60 streams | As R-1, **and** blocked on §5.1's escalation |
| R-12, R-16 | Unaffected: neither depends on a render endpoint |

**Consequences recorded, not worked around:**

- The segment budgets of AD-8 §3.2 are measurable on one host's clock **except T5 to T6**, which is unmeasured in the steady-state and the reconnect path alike (AD-8 §3.2, §3.4.1).
- AD-8's acceptance criteria **N-1** (end-to-end percentiles) and **N-4(b)** (reconnect to render) are **blocked on AD8-Q9** and cannot be claimed. AD-2 claims neither.
- Reconnect p95 ≤ 5 s has the same gap at the render end, and AD-8 gap **1b** records separately that the **real client's** reconnect behaviour is unmeasured, because the probe is not the product client.
- **No AD-2 requirement is weakened or re-scoped by this gap.** R-13 stands as a requirement; it simply has no measurement until T6 exists, and until then every report labels which interval it measured.

### 5.3 Gap-safe replay ordering (R-4, R-9)

**Nisarga's review of PR #32, finding 1, applied.** The earlier text treated the storage sequence of AD-3 H-3 as sufficient for replay order. **It is not**, and the reason is not PostgreSQL-specific:

- A sequence value is **allocated before** the inserting transaction commits, and sequence allocation is **non-transactional** (it does not roll back). Two concurrent writers can therefore take sequences *n* and *n+1* and commit in the **opposite** order.
- A reader that replays "everything up to the highest sequence it can see" can therefore read *n+1*, miss *n* because it is still uncommitted, and **never return to it** once its position has advanced past it. The row is permanently skipped, with no gap counter firing, because the row does exist.
- A rolled-back or failed insert leaves a **permanent hole** in the sequence, so "no holes" cannot itself be the completeness test.
- `BIGSERIAL`, `IDENTITY` and an explicit `nextval` all behave this way. Ordering **by commit time** has the symmetric problem: `clock_timestamp()` is not monotonic across sessions, and `now()` is the transaction's start time.

**Requirement (R-4, R-9): replay is gap-safe.** A consumer that replays from its committed position must receive **every** accepted event with a sequence above it, exactly once, in per-subject sequence order, with **no row skipped because it committed late**. How that is achieved is **open** and belongs to AD-3 (mechanism) and AD-11 (storage), not to this document. Candidate mechanisms, listed so the decision is informed and **not** decided here:

| Candidate | Idea | Cost or caveat |
|---|---|---|
| Watermark / lag bound | Replay only up to `max(sequence) − k` or up to a sequence older than the longest possible write transaction, then catch up | Adds replay latency; needs a proven bound on write duration |
| In-flight snapshot | Read the set of transactions still in flight and stop at the lowest one (for example PostgreSQL's `pg_snapshot_xmin` / `txid_snapshot` family) | Mechanism-specific; needs the sequence to be paired with the transaction id |
| Commit-ordered assignment | Assign the replay sequence **at commit**, in one serialized step, so the order is the commit order | Serializes writes; contends with R-1 and R-3 throughput |
| Position as a set, not a scalar | The consumer position records what has been consumed, so a late-committing lower row is still delivered | Position state grows; needs pruning rules |

**Acceptance (the test, not the mechanism):** a concurrent-writer fixture in which transaction A takes a lower sequence than B and commits **after** B, with a consumer replaying throughout, must deliver **both** rows exactly once; a consumer that skips A fails. Run on an injectable clock (§5.4). Decision **AD2-D8**.

### 5.4 Replay and buffer tests use an injectable clock

**Nisarga's review of PR #32, finding 4, applied.** Several requirements here carry durations far beyond any acceptance run — a 24 h replay window (R-9), a 25 h "outside window" case, a 24 h late-tracking horizon (§6), a 10 min buffer entry age (R-7), a 30 min soak (R-1).

- **Requirement:** every time-dependent criterion in this document is exercised through an **injected clock** at the acceptance point and in the consumer, never by waiting for wall-clock time. Only R-1's 30 min soak and R-3's 60 s burst are measured against real time, because they measure throughput and latency rather than a time boundary.
- The injected clock covers: the replay window boundary and the "outside window" answer (R-9); buffer entry age and expiry, L-2 (R-7); the lateness buckets and the late-tracking horizon (§6); the retention boundary that bounds the window (R-9, AD-11 §8).
- **Consistency requirement:** the injected clock must not be the source of any **envelope** timestamp. `source_timestamp`, `retrieved_at` and `emitted_at` stay as AD-4 §5 defines them, and the generator's own injected clock is AD-12's (v0.3 §3; C-1's derivation depends on it). A replay test must therefore not change what an `event_id` derives from.
- **Ownership:** the harness is AD-12's and AD-13's; this document states the obligation and does not design the harness.

**Buffer sizing versus the acceptance-test budget (unresolved, carried into AD2-D5).** The two numbers in play do not reconcile themselves:

| Sizing | Events | Bytes at 900 B | Covers | Acceptance-run cost |
|---|---|---|---|---|
| **12,000** (proposed) | 12,000 | ≈ 10.8 MB | 10 min at R-1, **or** 60 s at R-3 | A full-occupancy test needs 10 min at R-1, or 60 s at R-3 |
| **22,800** (the mixed window of §9) | 22,800 | ≈ 20.5 MB | 9 min at R-1 plus one R-3 minute | A full-occupancy test needs the full 10 min mixed window |
| 32 MiB byte limit | ≈ 37,300 at 900 B; **512** at the 65,536 B ceiling | 32 MiB | — | The byte limit binds first only for large envelopes |

Filling the buffer **to exhaustion** (L-1) cannot be shortened by an injected clock, because it is a count and byte bound, not a time bound: it needs real events. The options — reduce the bound under a test configuration, generate at a rate above R-3 in the test only, or accept a 10 min test — are a **trade between fidelity and run time** and are **left to the owner with Dev A and Dev D in AD2-D5**. This document records the arithmetic and resolves nothing.

## 6. AD-2 R-5: late, corrected and withheld events

| Case | Definition | Stored? | Becomes current? | Constraint |
|---|---|---|---|---|
| **Ordinary late arrival** | Valid; `source_timestamp` older than the subject's current value; arrives within the late-tracking horizon (24 h `[#?]`) | **Yes** | Never | Counted by lateness bucket: ≤ 1 min, ≤ 1 h, ≤ 24 h |
| **Eligible late history** | Valid; older than the horizon, delivered by a provider backfill or replay | **Only if** the source's Gate 3 terms permit storing history for that period (`retention_policy_ref`, AD-5 v0.4 §2.2) and the event falls inside AD-11's retention for its category | Never | Otherwise **not stored**, counted as `late_outside_retention`. This is a retention or permission refusal, not a validation rejection |
| **Validated correction** | Valid; `supersedes` names an earlier event of the same source and type (AD-4 §2; draft AD-4 Part 2 V-4) | **Yes**; the superseded event is kept unchanged | The correction replaces the superseded event **only if** it is that subject's newest by R-4; a superseded event is never current again (AD-4 §8.1) | Correction history is AD-11's. AD-5 v0.4 **§8.2a** aligns with this row: every event type may be corrected, `supersedes` is set only from something the provider published and never inferred from a differing value (**AD5-Q10**, open), and V-4 rejects a cross-source or cross-type reference |
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
| L-3 | **Ingestion crash or restart** with an in-memory buffer | Every unacknowledged entry is lost (AD-3 v0.3 H-1). Counted on restart as "buffer lost, size unknown" unless the buffer is durable, which would need an approved change to ingestion's no-volume isolation (AD-1 §3.6) |
| L-4 | Provider-side loss, or loss before ingestion receives an item | Indicated only (AD-3 §6 gap counters); unrecoverable without a Gate 3-permitted backfill |
| L-5 | Disk or volume loss | Bounded by backup and recovery objectives (AD-11; AD-8 v0.5 §8) |
| L-6 | Observation-storage failure while PostgreSQL serves Phase 2 | Backend stops acknowledging; then L-1/L-2; routing unaffected (AD-3 v0.3 H-7; AD6-Q2) |

**Measured versus unquantifiable loss.** L-1 (exhaustion, by event, byte or age limit) and L-2 (expiry) are **measured**: each discarded entry is counted while the process runs. L-3 (crash with an in-memory buffer) and L-4 (provider-side loss) are **not quantifiable**: the count dies with the process, or the event never reached ingestion. They are recorded as **gap indications** (a restart marker with the last acknowledged position; AD-3 §6 timestamp-gap counters), never as a number of lost events.

**Failure accounting invariant (proposed), for the measured part only:** for each source within one ingestion process lifetime, `emitted = accepted + rejected + quarantined + duplicates + buffer_exhausted + buffer_expired + still_buffered`. A test that cannot balance it fails. Across a crash or restart the invariant is reset and the boundary is recorded as a gap; no claim of zero loss is made across it.

**Synthetic identity collisions (AD-12 v0.3 §3.1, PR #31, C-1 residual):** two overlapping synthetic runs with the same seed and timestamps but a different `case_id` or `generator_version` produce the same `event_id`. Under R-8 the second arrival is a **conflict** (rejected and counted), not a duplicate. Until AD-5/AD-12 resolve it, load and fault runs must not overlap with a shared seed. A run that does is **invalid as a performance result** and may be excluded from throughput and latency figures, but its conflicts are **still detected, rejected, counted and recorded** (R-8; AD-11 P-3) exactly as in any other run: exclusion applies to the result, never to conflict detection.

## 8. Identity and semantic deduplication

| | Event identity | Semantic deduplication |
|---|---|---|
| Key | `event_id` (AD-4 §2) | **Two keys**, defined by **AD-5 v0.4 §8.1**: `observation_key` = (`source_id`, `event_type`, subject, `source_timestamp`), which deliberately **excludes** the payload hash, and `idempotency_key` = (`observation_key`, `payload_sha256`) |
| Purpose | Absorb transport redelivery (R-8); detect conflicts | `idempotency_key` recognizes **the same event** seen again (a duplicate: discarded and counted); `observation_key` recognizes **one subject at one instant carrying two different values** (a value conflict: first kept, counted, alertable — AD-5 §8.2 outcome C-a, which since AD-5 v0.4 applies only when the later event carries **no validated `supersedes`**; a validated correction is §8.2a's, not a conflict) |
| Preserved | AD-4 §2; AD-1 §3.4; C-1 derivation for the synthetic generator (AD-1 §3.4.1) | — |

**Deferred to AD-5, not decided here:** both keys and their outcomes; deduplication and ordering when `source_timestamp` is null (AD-5 v0.4 §8.4 marks such sources `dedup: within_run` and has both keys fall back to `retrieved_at`, so they are run-local); restart-safe deduplication (AD-5 §8.5), which holds for transports whose keys derive from observation properties and **fails** for a null-timestamp source; and the C-1 residual (overlapping synthetic runs, AD-1 §3.4.1). AD-2 requires only that concurrent synthetic runs do not share an identity space, and that persistence-level idempotency (R-8) does not depend on an in-memory window.

**X-3 is resolved in the AD-5 draft** (reference updated per Nisarga's review of PR #32). AD-5 v0.1 proposed a single five-part key and then defined a conflict as "the same key with a different `payload_sha256`", which cannot occur because the hash is inside the key. AD-5 **v0.3 §8.1** replaces it with the two keys above, and §8.2 with three outcomes — duplicate, value conflict (first kept), identity collision (rejected). **Nothing in AD-2 changes as a result**: R-8's persistence identity stays `event_id`, the approved `event_id` derivations are untouched (AD-5 §8.1: C-1's `UUIDv5(seed, pair, sequence, source_timestamp)` for the D-24 generator), and a semantic constraint is applied only once AD-5 is approved (AD-11 §4). X-3 closes on AD-5's approval, not on this document's.

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

**Excluded and unmeasured:** row and tuple overhead, indexes (the R-8 uniqueness index, storage sequence), PostgreSQL WAL, TOAST, the storage sequence and positions, backups, and quarantine, rejection and context records. Real usage will be **higher** than these figures by an unmeasured factor; the spike AD-3 runs must measure it.

**Replay retention, coordinated with AD-11 (owner review of PR #32, item 5).** Retention periods per family are **AD-11's** (its §8, decision **AD11-D6**), bounded by each provider's Gate 3 terms, and this document sets none. The coordination AD-2 does require:

| Item | AD-2 (R-9) | AD-11 §8 (proposed) | Coordination |
|---|---|---|---|
| Observed P-2 | Needs ≥ the replay window (24 h `[#?]`) | "≥ AD-2 replay window (24 h); longer only if Gate 3 terms allow. **Provider terms win**" | Consistent. R-9's window is a **floor** on retention and is itself **capped** by Gate 3: a provider term shorter than 24 h shortens the window for that source (R-9) |
| Synthetic P-2 | Same replay semantics | 30 days | Consistent, and the only family where a 24 h window is not the binding constraint |
| Storage implied | ≈ 1.56 GB/day of envelope bytes at R-1, 900 B, **overhead excluded** | §8 cites this figure | A 24 h window is ≈ 1.56 GB; **30 days of synthetic at R-1 would be ≈ 46.7 GB** before overhead, which AD-11's retention decision has to weigh. AD-2 states the arithmetic only |
| Position state | P-9 positions stored durably; a position older than P-2's retention answers "outside window" | P-9 mutable, advance-only; the "outside window" rule is AD-11 §4 | Consistent |
| Eligible late history | Stored only if Gate 3 terms and AD-11 retention both allow, else counted `late_outside_retention` (§6) | §7 "Provider permission" row | Consistent |

**Unresolved and left to the owner:** the retention **values** themselves (AD11-D6), and whether any observed source may retain **less** than 24 h, which would reduce R-9 for that source. AD-2 recommends nothing on either.

## 10. Alignment and conflicts

| ID | With | Conflict or gap | Resolution path |
|---|---|---|---|
| X-1 | AD-8 v0.5 §6.2, §6.3, §6.2.1 | Peak 200/s × 60 s vs 100/s × 10 s; 60 streams vs 20. **AD-8 v0.5 records the same two differences** in its per-dimension table, unresolved on both sides | **Not a standoff: AD-8 §6.2.1's "above" row governs.** Owner decides AD2-D3; **AD-8 is then revised, re-approved and its §3 budgets re-measured before milestone 3.4 begins** (§5.1). AD-3's load test uses both sets until then |
| X-2 | AD-8 v0.5 §8.1, §6.1a | "No recovery-point objective in v1" vs R-6 durability direction | **Path now agreed in both drafts, still open.** AD-8 v0.5 §8.1 states that, once AD-2 and AD-3 are approved, AD-8 **adopts** R-7's buffer and R-9's replay window as the source of its recovery objective; AD-8 v0.5 §6.1a adopts **§7's accounting identity** and the L-1 to L-3 split (measured loss counted; crash loss a gap marker, never a number), and **N-13** asserts it. Closes only on both approvals |
| X-3 | AD-5 **v0.4** §8.1, §8.2 | **Resolved in the draft, pending its approval.** AD-5 v0.1's single key made the conflict rule unsatisfiable. AD-5 v0.4 §8.1 now defines **two** keys over the same fields — `observation_key` (no hash) for **conflicts** and `idempotency_key` (= `observation_key` + `payload_sha256`) for **duplicates** — and §8.2 gives three outcomes: duplicate, value conflict (first kept) and identity collision (rejected) | Closed once AD-5 is approved; §8 here is updated to the two keys. **No `event_id` derivation changes** (AD-5 §8.1). AD-5 v0.4 §8.2 also **adopts R-8's collision rule** (§7: an overlapping-run collision is a conflict, not a duplicate; exclusion applies to the result, never to detection) |
| X-4 | AD-5 §8.3 (v0.3 text; changed in v0.4) | "Older: ignored, counted as late" vs R-5 "stored, never current" | **Resolved in the draft, pending AD-5's approval:** AD-5 v0.4 §8.3 now reads "**Not current** … 'Not current' is **not** 'not stored'", maps all five R-5 cases (§6) onto its own sections, adopts this document's vocabulary, and leaves the 24 h late-tracking horizon to AD-2 |
| X-5 | AD-8 **v0.5** §3.5 | `dedup_window` 300 s vs 24 h replay | R-8: persistence idempotency does not use the window, which **AD-3 v0.3 H-2 now states explicitly** ("persistence must not depend on the in-memory `dedup_window` … which is shorter than a 24 h replay window"). Compatible; no change needed on either side |
| X-6 | AD-3 v0.3 §6 | Gap counters are indicative only | Compatible; they satisfy part of R-17 and do not replace R-6/R-7 |
| **X-7** | AD-3 v0.3 H-3; AD-11 §4 | **Gap-safe replay.** Both assign a monotonic storage sequence at persistence and treat it as the replay order. Sequence allocation does not order commit visibility, so neither document yet guarantees that a late-committing lower row is delivered (§5.3) | **AD2-D8.** AD-3 chooses the mechanism, AD-11 the storage rule; AD-2 states the gap-safety requirement and the §5.3 concurrent-writer test. Nisarga raised the same finding on AD-11 §4 |
| **X-8** | AD-3 v0.3 H-1; AD-1 §3.1 | **Versioned ingestion handoff.** R-7 needs a bounded buffer with an opaque position and an acknowledgement; `GET /v1/latest` has neither history nor acknowledgement, so a **new, versioned ingestion interface** is required, which is a change needing its own approval. AD-3 H-1 also records that a bounded in-memory buffer gives at-least-once **between acknowledged points only**, not durability from the source, and that closing that window would need a durable spool inside ingestion — which conflicts with its no-volume, read-only posture (AD-1 §3.6) | Coordinated with **AD-3** (mechanism, interface version, acknowledgement semantics) and **AD-5** (transport semantics H-1). Neither this document nor AD-3 proposes the interface; it needs its own owner approval, and the D-24 contract and the AD-4 envelope stay untouched. L-3 remains the accounted residual (§7) |

**AD-3 options** (AD-3 v0.3 §5): this document approves no technology. Fit: A (poll + SSE, as built) **fails R-7** (`/v1/latest` has no history or acknowledgement); B (backend-mediated PostgreSQL) can meet R-6 to R-9 with H-1 to H-7 and keeps R-15, subject to the L-3 limit; C (a broker) needs a new service against R-16 and a new credential design.

## 11. Decisions

| # | Decision | Alternatives | Recommendation | Depends on | Approver | Evidence |
|---|---|---|---|---|---|---|
| AD2-D1 | Durability level | Best effort; at-least-once handoff + idempotent persistence; exactly-once | **At-least-once + idempotent** (R-6 to R-8), with the §7 fault model | AD-3, AD-11 | Owner, after Dev A and Dev D review | F-1 to F-4; accounting invariant |
| AD2-D2 | Replay | None; consumers 24 h; browsers too | **Consumers only** (R-9); browser snapshots (R-10). The 24 h window is a floor on AD-11's P-2 retention and is **bounded above by each provider's Gate 3 terms**, so a shorter approved retention shortens the window for that source | AD-3, AD-7, **AD-11 §8 / AD11-D6**, Gate 3 | Owner | R-9, R-10 tests, on an injectable clock (§5.4) |
| AD2-D3 | Design ceilings | Slice; this draft; AD-8 envelope | **Provisional.** If the owner adopts R-3 or R-11 as written, **AD-8 §6.2/§6.3 are revised and re-approved, and AD-8's §3 budgets re-measured, before milestone 3.4 begins** (§5.1, AD-8 §6.2.1). Approving this document records that dependency | AD-8 (revision and re-approval), Gate 3 | Owner | AD-3 load test at the figures finally approved; AD-8 §9 load tests re-run |
| AD2-D4 | Late, correction and history rule | §6 | **§6** | AD-5, AD-11, Gate 3 | Owner, Dev A | §6 fixtures |
| AD2-D5 | Producer buffer limits and discard rule | Count only; count + age; count + bytes + age; larger count (for example 22,800 to cover a mixed peak window) | **12,000 events, 32 MiB, 10 min**, first reached; whether to size for 22,800 is **open**; discard rule from AD-3. **Also open, and not resolved here:** how the chosen size is tested to exhaustion within an acceptance-run budget, since L-1 is a count and byte bound that an injected clock cannot shorten (§5.4) | AD-3, AD-5, AD-13 (harness budget) | Owner, Dev A, Dev D | R-7 test; the §7 invariant; the §5.4 run-time trade |
| AD2-D6 | Semantic key, null timestamps, C-1 residual | — | **AD-5** | AD-5 | Owner, Dev A | AD-5 |
| AD2-D7 | Measurement points and segment budgets | — | **AD-8** (§2.2 points, §3.2 segments). **R-13 has no measurement until T6 exists**, which is **AD8-Q9**, not an AD-2 decision (§5.2) | AD-8, **AD8-Q9**, AD8-Q10 | Owner, with Dev C (client) and Dev D (harness) | AD-8 N-1 and N-4, both currently blocked |
| **AD2-D8** | **Gap-safe replay mechanism** (§5.3) | Watermark or lag bound; in-flight transaction snapshot; sequence assigned at commit; position as a set | **Open — no recommendation.** AD-2 requires only that replay be gap-safe and that §5.3's concurrent-writer test pass; the mechanism is AD-3's (handoff and distribution) and AD-11's (storage), and it trades replay latency against write throughput (R-1, R-3) | **AD-3, AD-11** | Owner, Dev B, Dev D | §5.3's concurrent-writer fixture: both rows delivered exactly once, neither skipped |

## 12. Limitations

1. No rate, size or latency here is a production measurement; envelope size comes from fixtures.
2. The acceptance point is a role until AD-3 names a component.
3. R-6 does not cover L-1 to L-6.
4. Event types other than `fx_rate` need AD-5 subjects before R-4 applies.
5. **R-13 has no measurement.** T6 is not instrumented, so event-to-display p95 and reconnect-to-render p95 are unmeasurable, and the narrower `emitted_at`-to-arrival figure is not evidence for them (§5.2; AD-8 gaps 1a and 1b, AD8-Q9).
6. **AD-6 B-4 is open and is not closed here.** T-5 covers the ingestion side only; the inference-side test (draft AD-6 Part 2 T-13) is not run and not claimed; D-25 waives the inference side for the D-24 slice only; closure is AD-10 §3.6's (R-15).
7. **R-3 and R-11 exceed AD-8's proposed (unapproved) envelope**, so no capacity or latency figure here is acceptable as evidence until §5.1's escalation completes.
8. **Replay is not yet gap-safe in any draft** (§5.3, X-7, AD2-D8), and R-7's position-and-acknowledgement interface does not exist (X-8).

## 13. Approval checklist

- [ ] Dev A: R-5 (§6), R-7, R-8, §8 hand-off (the two AD-5 keys); X-3, X-4
- [ ] Dev D: §5 matrix as AD-3 input; §5.3 gap-safe replay and §5.4 harness obligations; §7; §10 (X-7, X-8)
- [ ] Dev C *(for information, not a listed reviewer)*: §5.2's effect on what the client can be measured against
- [ ] Project owner: AD2-D1 to **AD2-D8**, and the **§5.1 escalation dependency** that approving R-3 or R-11 creates for AD-8
