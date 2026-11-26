# AD-3: Streaming Mechanism Decision Record

**Status:** **DRAFT v0.3 for review. Not approved.** 26 November 2026. v0.3 answers Dev B's technical review of PR #31 at `d96aabe` (approve with conditions): event identity versus semantic deduplication (§5.1 H-2), the extended alternatives comparison (§5), the corrected spike citation, and a table separating drafts from approved documents (§1.1). v0.2 records Dev B's provisional AD-2 and AD-11 proposals (relayed), the backend-mediated PostgreSQL candidate, durable-handoff requirements, and the conflicts found in review of PR #30 (§10). **Lead:** Dev D. **Reviewer:** Dev B (the PostgreSQL option). **Approver:** project owner.
**Inputs:** AD-2 (unwritten), F-6. **Feeds:** AD-11; milestone 3.4. **Scope source:** `docs/PHASE3_SCOPE.md` §3 Workstream B, §6, §7.3; `docs/PHASE3_MILESTONE_3_1_PLAN.md` §3.

This record **chooses no final streaming mechanism.** It fixes a provisional position and the criteria that will decide the rest once AD-2 exists. The plan's 3.1 exit condition, "AD-3 is recorded as the roadmap §6 streaming decision", is **not met** by this draft.

## 1. Owner authorization (recorded)

Ayush (project owner and Dev A) approved the directions below on 26 November 2026. The approval reached Dev D as a relayed instruction; **no separate approval document exists in the repository**, so it is relayed, not quoted. It approves these *directions*. It does not approve this document.

1. AD-2, AD-5 and AD-11 dependent decisions stay provisional.
2. D-24 HTTP polling is retained as the **local synthetic pilot baseline**, not the final streaming mechanism.
3. Timestamp-based gap detection is proposed as **indicative, not guaranteed, loss detection**, with **no event contract change** (§6).
4. Reviewer references, persistence and retention stay pending coordination with Anvesh's AD-11.
5. D-24 implementation, approvals and documented limitations are preserved.

### 1.1 Status of the documents this record refers to

| Document | Status | Repository location |
|---|---|---|
| AD-1 component view v0.5, AD-4 v0.2, AD-6 v0.2 | **Approved for the D-24 slice only** (25 November 2026) | `docs/PHASE3_AD1_COMPONENT_VIEW.md`, `PHASE3_AD4_EVENT_ENVELOPE.md`, `PHASE3_AD6_ENGINE_BOUNDARY.md` |
| AD-5 adapter contract, AD-8 budgets, AD-1, AD-4 and AD-6 Part 2 companions | **DRAFT v0.1, unreviewed, unapproved**, in PR #30 (read at `5f78500`). **Not part of the repository baseline** until merged | Branch `docs/phase3-architecture-ad1-ad4-ad5-ad6-ad8`, not on `feature/phase3-platform` |
| AD-2 requirements | **Unwritten.** Dev B's provisional proposals were relayed | None |
| AD-10 threat model, AD-11 persistence and audit | **Unwritten.** Dev B's provisional AD-11 proposals were relayed | None |
| AD-7, AD-9 | Unwritten | None |

Every `[DEP: AD-n]` below depends on the row above. Citations of PR #30 documents are to unmerged text and may change.

## 2. Provisional position

| Question | Position | Status |
|---|---|---|
| Final mechanism for streaming beyond the D-24 slice | **Not chosen** | `[OPEN]` `[DEP: AD-2]` |
| Mechanism for the local synthetic pilot | The D-24 design: ingestion `GET /v1/latest`, polled by Express every 500 ms, pushed to browsers over SSE | Retained as baseline. It approves no milestone 3.2–3.7 and no gate |
| Whether a broker is justified | Not shown. Scope Workstream B says a broker "should be justified by the requirements" | `[DEP: AD-2]` |
| First candidate to evaluate for distribution | **PostgreSQL, with persistence mediated by the backend** (§5.1). An evaluation order, not a choice | Provisional `[DEP: AD-2, AD-11]` |
| Gap detection | Indicative counters from existing timestamps (§6) | Proposed only |

## 3. Requirements this decision depends on `[DEP: AD-2, provisional]`

The scope requires throughput, ordering, replay, durability and operational requirements before a mechanism is chosen (Workstream B; §6 excepts the D-24 slice). None is approved. For comparison only, the slice's own numbers are:

| Requirement | D-24 slice value (AD-1 §3, slice-only) | Final value |
|---|---|---|
| Rate | 2 events/s: 4 pairs, each every 2 s, staggered 500 ms | `[DEP: AD-2]` |
| Ordering | By `source_timestamp` only; `source_sequence` is opaque | `[DEP: AD-2, AD-5]` |
| Replay, durability | None; a restart may lose state | `[DEP: AD-2, AD-11]` |
| Display latency | p95 ≤ 1 s from `emitted_at`, both clocks on one host | `[DEP: AD-8]` |
| Reconnect | p95 ≤ 5 s from the backend being reachable through Nginx | `[DEP: AD-8, AD-9]` |
| Deployment | Local Docker first; single-host containerized pilot; no exposure before Gate 4 (F-6) | decided |

### 3.1 Provisional proposals from Dev B (relayed, not approved)

Anvesh (Dev B) gave provisional AD-2 and AD-11 proposals. They reached Dev D as relayed messages; **no document of them is in the repository**, and AD-2 and AD-11 are unwritten and unapproved. They are inputs, not requirements. The AD-8 column is the unmerged, unreviewed draft in PR #30 (commit `5f78500`), read at that commit.

| Item | Dev B provisional | AD-8 draft (PR #30) | State |
|---|---|---|---|
| Sustained rate | 20 events/s | 20 events/s (§6.2) | Agree |
| Peak | 200 events/s for 60 s | 100 events/s for up to 10 s (§6.2) | **Conflict** `[OPEN: AD-2]` (X-1) |
| Browser streams | 60 | 20 in total, 3 per user (§6.3; the slice's AD-1 §3.5 values) | **Conflict** `[OPEN: AD-2, AD-8]` (X-1) |
| Delivery | At-least-once, durable | No recovery-point objective in v1 (§8.1); "never dropped" (§3.1) | **Conflict** `[OPEN]` (X-2) |
| Persistence | Idempotent | Five-part semantic key, 300 s dedup window, null-timestamp case undefined (AD-5 §5, §8) | **Open** (X-3). Event-identity idempotency is §5.1 H-2(a); the semantic key stays with AD-5 |
| Replay | 24-hour consumer replay | None | Absent from every draft (X-4) |
| Browser reconnect | Snapshot-based | Snapshot replaces state, no `Last-Event-ID` (AD-1 §3.3; AD-8 §3.4) | Agree |
| Ordering | Per source and subject | By `source_timestamp` (AD-5 §8.3) | Compatible; replay order needs a storage sequence (§5.1 H-3) |

## 4. The retained baseline: what D-24 is and is not

**What it is** (AD-1 §3, `PHASE3_D24_ACCEPTANCE.md`): ingestion serves the latest validated event per pair; Express polls with one request in flight, a 400 ms deadline and a 64 KiB body cap; source status becomes `outage` after 3 consecutive failed polls or 2 s without a success; Express pushes `snapshot`, `update` and 15 s `heartbeat` messages over SSE, with 3 streams per user and 20 in total. Observation events never reach the routing engine (AD-6).

**What it is not:** a durable queue, a replayable log or a broker. A polled value is labelled as polled (AD-4 §8.1), never "streamed". SSE sends no `id:` and ignores `Last-Event-ID`.

**Evidence kept, unchanged:** the D-24 acceptance results and limitations (`PHASE3_D24_ACCEPTANCE.md` §1, §2, §5, §7). Measured in one CI run (PR #24, commit `bd085e6`): `acceptance-stack` 13.1 min, `acceptance-browser` 11.2 min. These replace the earlier local estimate of about 40 and 30 min. They are job durations, not mechanism throughput. Not shown by that evidence: any live source, any durable or replayed delivery, throughput beyond 2 events/s, or a live `503 SHUTTING_DOWN` on a real stack.

## 5. Alternatives (to be compared once AD-2 exists)

| | A. HTTP poll + SSE (D-24 baseline) | B. PostgreSQL queue with LISTEN/NOTIFY | C. Dedicated broker |
|---|---|---|---|
| New operational dependency | None | None; PostgreSQL already runs for the backend | Yes `[OPEN: which]` |
| Acknowledgement | None. The consumer polls `GET /v1/latest` and nothing tells ingestion what was received | A position the backend requests and then acknowledges (§5.1 H-1), which needs a new ingestion interface version; or table-based acknowledgement | Broker-native, by product `[OPEN]` |
| Producer retention | The latest event per pair, in memory; intermediate events are overwritten | A bounded buffer in ingestion; an in-memory buffer loses unacknowledged entries on a crash and counts overflow (§5.1 H-1) | Retention in the broker, by product and configuration `[OPEN]` |
| Durable acceptance | None. Nothing is stored; a restart may lose state (AD-1 §3) | Row committed before acknowledgement (§5.1 H-5), so acceptance is durable from the backend onward only | By product; durability settings `[OPEN]` |
| Replay | None. No event id is sent and `Last-Event-ID` is ignored (AD-1 §3.2) | Replay from stored rows within a window (24 h proposed, Dev B). Notifications alone are not durable (documented PostgreSQL behaviour, not measured here), so rows are the source | By product `[OPEN]` |
| Overload and backpressure | The poller never waits for a stream; a slow browser keeps the newest update per subject (AD-1 §3.5) | Bounded buffer with counted overflow; write rate against shared PostgreSQL; browser coalescing as in A | Broker queue limits; consumer lag `[OPEN]` |
| Capacity | Designed and soaked at 2 events/s over four pairs; nothing higher is measured | Unmeasured. Targets conflict (AD-3 §10 X-1) | Unmeasured |
| Failure recovery | Restart loses state; values age out; a new snapshot resyncs the browser (AD-1 §3.3, §3.4) | Storage failure and full outage differ (§5.1 H-7); recovery by handoff position and replay `[OPEN]` | Broker restart and client resume `[OPEN]` |
| Ordering | `source_timestamp` rules (AD-1 §3.4) | `[DEP: AD-2]` | `[DEP: AD-2]` |
| Fit with F-6 | Yes | Yes | Adds a service to the single host |
| Isolation (AD-1 §3.6 and §6 item 5: ingestion has no volume, secret or route to PostgreSQL) | Preserved | **Depends on the producer boundary**, not on a fixed answer: if the queue is written by the backend (which already uses PostgreSQL) after it validates what it receives from ingestion, ingestion's isolation is unchanged; if ingestion itself wrote to PostgreSQL, AD-1 §3.6 and the AD-6 boundaries would change and need approval. Which side produces is `[OPEN]` `[DEP: AD-2, AD-11]` | New network and credential design |
| Evidence available | D-24, measured | None; a disposable spike is needed | None; a spike is needed |

Qualitative only. Nothing here is a measurement. **As built, D-24 polling cannot meet the broader durability and replay requirements** (acknowledgement, producer retention, durable acceptance, replay). That is a **limitation for a future architecture, not a defect in accepted D-24**, whose approved slice states no durability, replay or broker (AD-1 §3). The final mechanism and every numerical target stay provisional. Spikes are disposable, run outside the project's Compose stack, and are not merged as the mechanism before AD-3 is approved (`docs/PHASE3_MILESTONE_3_1_PLAN.md` §5; scope §6). Option B's compatibility with ingestion's isolation turns on which component produces into the queue (AD-1 §3.6). Per Dev B, **backend-mediated persistence is the first evaluation candidate** (§5.1). The owner and Dev B still decide the producer with AD-11.

### 5.1 First candidate: PostgreSQL, backend-mediated `[PROVISIONAL]` `[DEP: AD-2, AD-11]`

Why it is first to evaluate: the backend already uses PostgreSQL, and ingestion holds no database handle, credential or route to PostgreSQL (AD-1 §3.6, §6 item 5), so the backend is the only component that can write without changing ingestion's isolation. It is not chosen: no spike has run and AD-2 is unwritten.

Requirements any durable handoff must meet, all proposed:

| # | Requirement |
|---|---|
| H-1 | **Handoff position.** Ingestion keeps a bounded, ordered buffer of validated envelopes with an opaque position; the backend requests "after position" and the next request acknowledges the previous one. Ingestion discards only acknowledged entries or on overflow. Overflow is **counted loss**, never silent. Buffer bound `[OPEN]`. **A bounded buffer alone cannot guarantee durable delivery.** If it is in memory, an ingestion crash or restart loses every unacknowledged entry, and an overflow loses the oldest or newest by rule. Both are loss windows, bounded only by the acknowledgement lag and the buffer size. Closing them would need a durable spool inside ingestion, which conflicts with its no-volume, read-only posture (AD-1 §3.6) and so changes that isolation, or an upstream source that can backfill (a Gate 3 question). Until one is chosen, H-1 gives **at-least-once delivery between acknowledged points only**, not durability from the source. `[OPEN: spool or accepted loss window]` `[PROVISIONAL]` The D-24 `GET /v1/latest` returns only the latest event per pair and cannot carry this, so it needs a new ingestion interface version. **That is a change needing its own approval; this document makes none, and the D-24 contract and the AD-4 envelope are untouched** |
| H-2 | **Idempotent persistence, by event identity.** Two different things must stay apart. **(a) Event-identity idempotency**, owned here: a uniqueness rule on `event_id` makes redelivery of the **same event** a no-op. The same `event_id` arriving with **different immutable content** is a **conflict**: it is rejected and counted, the first is kept, and it is never overwritten (AD-1 §3.4; AD-4 §2, events are immutable). Which fields the comparison covers, such as the whole envelope or the payload hash, `[OPEN: AD-5, AD-11]`. **(b) Semantic deduplication**, owned by AD-5: whether two events with different IDs are the same observation of the same subject. That key is subject-aware and its form (the AD-5 draft proposes a five-part key) is **not finalized here** and stays `[DEP: AD-5]`. H-2 neither adopts nor replaces it. Persistence must **not** depend on the in-memory `dedup_window` (300 s in the AD-8 draft), which is shorter than a 24 h replay window. Sources with a null `source_timestamp` cannot be idempotent across restarts (X-3) |
| H-3 | **Storage sequence.** Replay order per source and subject needs a monotonic sequence assigned **at persistence**. It is a storage attribute, not an envelope field. `source_timestamp` still decides the current value (AD-4 §5) |
| H-4 | **Replay.** Consumers replay stored rows from a position within a window; Dev B proposes 24 hours. Retention by category `[PENDING: AD-11]` |
| H-5 | **Persist before acknowledging.** At-least-once means a consumer may see duplicates and must be idempotent |
| H-6 | **Separation.** Observation rows are logically separate from Phase 2 records, with no foreign key, join or view to them, and with separate database privileges `[PENDING: AD-11]` (AD-6 Part 2 T-14). Routing never waits on observation persistence (AD6-Q2). T-1, T-2 and T-6 still hold |
| H-7 | **Failure modes are distinct.** (a) **Observation-storage failure**: the observation tables, their role or their writes fail while PostgreSQL still serves Phase 2. The backend must stop acknowledging, so ingestion keeps entries until its buffer overflows (H-1), the observation path is labelled degraded, and routing and Phase 2 records are unaffected. (b) **Complete PostgreSQL outage**: Phase 2 is also affected, and that is outside the observation boundary. Whether routing and sign-in continue is a Phase 2 matter and is not claimed here; observation persistence stops with it. In both cases routing never waits on observation persistence (AD6-Q2), and neither failure is tested yet. Backlog and recovery behaviour `[OPEN]` |

### 5.2 Durable delivery is not browser coalescing

| Layer | Guarantee | May drop an intermediate event? |
|---|---|---|
| Source to ingestion | Whatever the provider gives; no replay without a provider backfill (Gate 3). Loss is only indicated (§6) | Yes, undetectably in part |
| Ingestion to backend | At-least-once through H-1 (proposed), **between acknowledged points only**: not across an ingestion crash or buffer overflow | Yes on counted overflow, and on a crash of an in-memory buffer |
| Backend persistence | Durable and idempotent (H-2) | No: every accepted event is stored |
| Backend to browser | State-based: a snapshot, then the newest update per subject (AD-1 §3.5). A reconnect starts a new snapshot | **Yes, by design.** Coalescing under backpressure is not a delivery loss, because the panel shows current values only |

Consequence: a delivery-success measure must name its layer. At the persistence or consumer layer it can be a real target; at the browser it cannot, and coalesced updates must be counted separately. AD-8 §3.1, §6.1, §6.3 and §8.1 do not do this today (X-2) `[DEP: AD-8]`.

## 6. Gap detection: proposal (indicative only) `[PROPOSED]`

**Purpose.** Give operators a hint that events may have been missed, without claiming to know.

**Rule.** For each pair, compare consecutive **accepted** events' `source_timestamp` values. If the difference exceeds the source profile's `expected_interval_ms` (2000 in the slice) times a factor, count one *possible gap* for that pair. The factor is `[OPEN: AD-2, AD-8]`; the existing `stale_after_ms` = 3 × interval (AD-4 §7, provisional F-5) is context, not a chosen value.

**Constraints.**
- **No event contract change.** It uses `source_timestamp` and `expected_interval_ms`, which exist. No envelope field, ingestion schema or SSE message changes (AD-4 and AD-1 §3.1–3.2 untouched).
- **Diagnostic only.** Counters and rate-limited logs, in the style of AD-1 §3.4's rejection counters. It does not affect freshness, labels, source status or routing, and it is never displayed as a fact.
- **`source_sequence` is not used.** It is opaque (AD-4 §2; AD-1 §3.4). Real providers' sequences are an AD-5 question `[DEP: AD-5]`.
- Distinct from the client's `stream_seq` check (AD-1 §3.3), which detects a gap on one SSE connection, not missed source events.

**Why it is not guaranteed detection.**

| Case | Effect |
|---|---|
| Events lost at the tail (nothing later arrives) | Not seen until a later event arrives; then ages out as stale or unavailable |
| Loss shorter than the threshold | Not flagged (false negative) |
| Ingestion restart | Sequence resets and the stagger re-bases (AD-1 §3.4.1), so timestamps can jump or tie: possible false positive or hidden gap |
| Clock moved backwards | Later events are "late" and ignored, so no delta is formed |
| Irregular real providers (daily or event-driven) | Interval assumption fails: false positives, or the check is disabled by a null `expected_interval_ms` |
| Rejected or quarantined events | Deltas are measured between accepted events only; counted separately |
| Poll outage longer than the event interval | Intermediate events are unrecoverable (no replay) and the next accepted event shows a jump: the intended case |

A flagged gap means "possibly missed"; an unflagged stream means "no evidence of a gap", never "no loss". Evidence for this proposal today: none measured. It would need fault-injection cases (AD-12 §4) before approval.

## 7. Decision criteria `[DEP: AD-2]`

The smallest mechanism that meets the approved requirements; operational cost on a single host; replay and durability needs; preserved isolation of ingestion; observed and simulated state kept distinct; AD-6 non-interference (T-1, T-2, T-6) still provable; a measured, not assumed, latency against AD-8.

## 8. Consequences of staying on the baseline

- Milestone 3.4 cannot claim replay, durability or a final mechanism.
- Status wording follows scope §6: "streaming pipeline exercised with synthetic events only; no live source integrated".
- The AD-3 exit condition stays open until AD-2 is approved and a mechanism is chosen or this record is explicitly deferred with a reason (plan exit rule).

## 9. Risks

1. Baseline limits are mistaken for the final design: mitigated by §4's wording.
2. Spike results from one host and one runner may not transfer: record the host and sample size with any spike.
3. Gap counters read as loss guarantees: mitigated by §6.
4. A longer job chain outgrows the acceptance gate's 125 min wait (D-24 §6); a mechanism change must update the gate budget.

## 10. Open items and dependencies

| Item | Status |
|---|---|
| AD-2 requirements | `[DEP: Dev B]` unwritten |
| Persistence, retention, audit shape | `[DEP: AD-11, Anvesh]` |
| Semantic deduplication key (scope Workstream B proposes `source_id`, `source_timestamp`, `payload_hash`; the AD-5 draft proposes a five-part key) and ordering beyond the slice | `[DEP: AD-5]`, not finalized here. Event-identity idempotency and same-ID conflicts: §5.1 H-2 |
| Gap-detection factor and counters' home | `[OPEN]` |
| Queue producer boundary (§5) | Backend-mediated first candidate, provisional `[DEP: AD-2, AD-11]` |
| Handoff position, buffer bound, replay window, backlog (§5.1) | `[OPEN]` |
| Dev B review; owner approval | `[PENDING]` |

### Recorded conflicts

Between Dev B's relayed proposals, the PR #30 drafts (unmerged and unreviewed, read at `5f78500`) and approved text. None is resolved here. Identifiers use `X-` to avoid the existing C-1, B-1, F-1 and R-1 labels.

| ID | Conflict | Where | Resolved by |
|---|---|---|---|
| X-1 | Capacity: peak 200 events/s for 60 s against 100 for 10 s; 60 browser streams against 20 total (3 per user) | §3.1; AD-8 §6.2, §6.3; AD-1 §3.5 (slice) | `[OPEN: AD-2, AD-8]` |
| X-2 | Delivery: "never dropped", a 99.9% delivery target and "no recovery-point objective" sit beside newest-per-subject coalescing | AD-8 §3.1, §6.1, §6.3, §8.1; §5.2 | `[OPEN: AD-8, AD-3]` |
| X-3 | Idempotency: the key includes `payload_sha256`, yet a conflict is defined as the same key with a different hash; `event_id` for null `source_timestamp` is undefined; the in-memory window is not a persistence rule | AD-5 §5, §8.1, §8.2; AD-4 Part 2 §3.2 | `[OPEN: AD-5, AD-11]` |
| X-4 | Replay: 24 h proposed, no mechanism in any draft, dedup window 300 s | §3.1; AD-8 §3.5 | `[OPEN: AD-2, AD-3]` |
| X-5 | **B-4:** AD-1 Part 2 §7.3 says `infra/compose.yaml` is unchanged by Phase 3 (overlays only), but inference sits on the default network with internet access, so closing B-4 on the inference side needs a network change in `compose.yaml` or an overlay that removes inference from the default network (unverified that Compose permits it). `infra/compose.yaml` is **not** T-7 protected (`PROTECTED` in `e2e/p3_safeguards.py` does not list `infra/`), but it is in the `phase3-observations.yml` trigger paths, so an edit needs the full acceptance run and the Compose static tests. D-25 is unchanged; **B-4 stays open** until an authorized implementation, runtime evidence and formal owner closure (AD-10; AD-13 §3.3). **No change is made or proposed here** | AD-1 Part 2 §7.3; AD-6 Part 2 §3; D-25 | `[OPEN: AD-10]` |
