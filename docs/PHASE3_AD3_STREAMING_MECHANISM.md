# AD-3: Streaming Mechanism Decision Record

**Status:** **DRAFT v0.1 for review. Not approved.** 26 November 2026. **Lead:** Dev D. **Reviewer:** Dev B (the PostgreSQL option). **Approver:** project owner.
**Inputs:** AD-2 (unwritten), F-6. **Feeds:** AD-11; milestone 3.4. **Scope source:** `docs/PHASE3_SCOPE.md` §3 Workstream B, §6, §7.3; `docs/PHASE3_MILESTONE_3_1_PLAN.md` §3.

This record **chooses no final streaming mechanism.** It fixes a provisional position and the criteria that will decide the rest once AD-2 exists. The plan's 3.1 exit condition, "AD-3 is recorded as the roadmap §6 streaming decision", is **not met** by this draft.

## 1. Owner authorization (recorded)

Ayush (project owner and Dev A) approved the directions below on 26 November 2026. The approval reached Dev D as a relayed instruction; **no separate approval document exists in the repository**, so it is relayed, not quoted. It approves these *directions*. It does not approve this document.

1. AD-2, AD-5 and AD-11 dependent decisions stay provisional.
2. D-24 HTTP polling is retained as the **local synthetic pilot baseline**, not the final streaming mechanism.
3. Timestamp-based gap detection is proposed as **indicative, not guaranteed, loss detection**, with **no event contract change** (§6).
4. Reviewer references, persistence and retention stay pending coordination with Anvesh's AD-11.
5. D-24 implementation, approvals and documented limitations are preserved.

## 2. Provisional position

| Question | Position | Status |
|---|---|---|
| Final mechanism for streaming beyond the D-24 slice | **Not chosen** | `[OPEN]` `[DEP: AD-2]` |
| Mechanism for the local synthetic pilot | The D-24 design: ingestion `GET /v1/latest`, polled by Express every 500 ms, pushed to browsers over SSE | Retained as baseline. It approves no milestone 3.2–3.7 and no gate |
| Whether a broker is justified | Not shown. Scope Workstream B says a broker "should be justified by the requirements" | `[DEP: AD-2]` |
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

## 4. The retained baseline: what D-24 is and is not

**What it is** (AD-1 §3, `PHASE3_D24_ACCEPTANCE.md`): ingestion serves the latest validated event per pair; Express polls with one request in flight, a 400 ms deadline and a 64 KiB body cap; source status becomes `outage` after 3 consecutive failed polls or 2 s without a success; Express pushes `snapshot`, `update` and 15 s `heartbeat` messages over SSE, with 3 streams per user and 20 in total. Observation events never reach the routing engine (AD-6).

**What it is not:** a durable queue, a replayable log or a broker. A polled value is labelled as polled (AD-4 §8.1), never "streamed". SSE sends no `id:` and ignores `Last-Event-ID`.

**Evidence kept, unchanged:** the D-24 acceptance results and limitations (`PHASE3_D24_ACCEPTANCE.md` §1, §2, §5, §7). Measured in one CI run (PR #24, commit `bd085e6`): `acceptance-stack` 13.1 min, `acceptance-browser` 11.2 min. These replace the earlier local estimate of about 40 and 30 min. They are job durations, not mechanism throughput. Not shown by that evidence: any live source, any durable or replayed delivery, throughput beyond 2 events/s, or a live `503 SHUTTING_DOWN` on a real stack.

## 5. Alternatives (to be compared once AD-2 exists)

| | A. HTTP poll + SSE (D-24 baseline) | B. PostgreSQL queue with LISTEN/NOTIFY | C. Dedicated broker |
|---|---|---|---|
| New operational dependency | None | None; PostgreSQL already runs for the backend | Yes `[OPEN: which]` |
| Durability, replay | None by design | Needs table-backed events; notifications alone are not durable (documented PostgreSQL behaviour, not measured here) | Depends on the product |
| Ordering | `source_timestamp` rules (AD-1 §3.4) | `[DEP: AD-2]` | `[DEP: AD-2]` |
| Fit with F-6 | Yes | Yes | Adds a service to the single host |
| Isolation (AD-1 §3.6 and §6 item 5: ingestion has no volume, secret or route to PostgreSQL) | Preserved | **Depends on the producer boundary**, not on a fixed answer: if the queue is written by the backend (which already uses PostgreSQL) after it validates what it receives from ingestion, ingestion's isolation is unchanged; if ingestion itself wrote to PostgreSQL, AD-1 §3.6 and the AD-6 boundaries would change and need approval. Which side produces is `[OPEN]` `[DEP: AD-2, AD-11]` | New network and credential design |
| Evidence available | D-24, measured | None; a disposable spike is needed | None; a spike is needed |

Qualitative only. Nothing here is a measurement. Spikes are disposable, run outside the project's Compose stack, and are not merged as the mechanism before AD-3 is approved (plan §risks). Option B's compatibility with ingestion's isolation turns on which component produces into the queue (AD-1 §3.6); no producer is assumed here, and Dev B and the owner decide it with AD-11.

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
| Idempotency key (proposed `source_id`, `source_timestamp`, `payload_hash`, scope Workstream B) and ordering beyond the slice | `[DEP: AD-5]` |
| Gap-detection factor and counters' home | `[OPEN]` |
| Queue producer boundary (§5) | `[OPEN]` `[DEP: AD-2, AD-11]` |
| Dev B review; owner approval | `[PENDING]` |
