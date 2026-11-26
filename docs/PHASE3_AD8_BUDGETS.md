# AD-8: Non-Functional Budgets — Latency, Freshness, Monitoring and Recovery

**Status:** **DRAFT v0.1**, 26 November 2026. **Not reviewed and not approved.** Until the project owner approves this document, **F-5's targets stay provisional and official exit criterion 9 is unmet** (scope §2.3, §8.2 item 9).
**Lead:** Dev A. **Reviewers:** Dev B, Dev C, Dev D (3.1 plan §3). **Approver:** project owner. Dev A is also the approver, so the second-reviewer rule (D-20) applies: at least one of Dev B, Dev C and Dev D reviews before the decision.
**Scope source:** `docs/PHASE3_SCOPE.md` v1.4 §2.3 (F-5, F-6), §7.3 (AD-8 row), §8.2 item 9, §10.2 (P2); **D-12** — "the numeric latency budget and the freshness thresholds are set in milestone 3.1".
**Needs first:** F-5, F-6. **Feeds:** AD-9; milestones 3.5 and 3.7; exit criterion 9. It supplies every number that **AD-5** names and leaves unset, and the profile values that **AD-4 §7** places in the AD-5 registry.
**Relies on:** AD-4 **v0.2** (approved for the D-24 slice only) for the freshness model; AD-1 component view **v0.5** for the D-24 slice's own figures, which it does not change.

Every statement cites the decision it rests on. Everything else is **[PROPOSED]**. This document changes no code, no schema, no Compose file, no CI workflow and nothing in API contract v0.4. It sets **no** Phase 1 or Phase 2 budget: the engine pool's 10 s execution limit and 12 s request deadline are unchanged (**A-8**), and no routing figure here replaces one of theirs.

**What this document does not do.** It does not approve a milestone, pass a gate, or authorize any exposure beyond the private development environment (D-6, D-16, D-18). It sets targets for a **single-host, containerized research pilot** (F-6), which are engineering objectives, not a claim about performance on a real CBDC network (roadmap §1, §7.7).

---

## 1. What is being budgeted, and what is not

| Budgeted here | Not budgeted here |
|---|---|
| Observation delivery latency, end to end and per segment (§3) | Routing request latency, which keeps its Phase 2 budgets (A-8) |
| Observation freshness, staleness and withdrawal (§4, §5) | What is *shown* at each state — **AD-9** |
| Reconnect and resync time for the browser channel (§3.4) | The channel's protocol and messages — **AD-7** |
| Availability, capacity and the event-rate envelope (§6) | Throughput requirements and the mechanism — **AD-2**, **AD-3** |
| Monitoring metrics, SLIs and alert thresholds (§7) | The exposure plan, identity and rate limits — **AD-10** |
| Recovery objectives and drills (§8) | Storage, retention and the audit trail — **AD-11** |
| Clock discipline and tolerance (§10) | The engine's reference-date limits, which are unchanged (A-6) |

**Routing is unaffected by every number in this document.** An observation that misses its budget, goes stale, is withdrawn or disappears entirely changes only the observation panel: **AD6-Q2** (owner-decided) requires that an observation outage never block simulation-based routing, and AD-6 §6 requires the converse too — an inference failure does not hide observations.

---

## 2. The measurement model

### 2.1 Why this section comes first

F-5 gives "event-to-display p95 ≤ 1 s" without saying where the measurement starts, and the 3.1 plan §6 records this as a risk: *"event-to-display can be measured from the source timestamp or from ingestion. Until AD-8 fixes this, the 1 s figure cannot be tested."* A budget without a defined start point is not testable, so the points are named before any number is given.

### 2.2 Named measurement points

**[PROPOSED]** One timeline per observation. Every point is recorded in milliseconds on the clock named, and the clock matters: only differences measured on **one** clock are valid latencies.

| Point | Meaning | Clock | Recorded by |
|---|---|---|---|
| **T0** | `source_timestamp`: when the provider observed or published the value | **Provider's** | The provider; copied into the envelope (AD-4 §5) |
| **T1** | `retrieved_at`: the raw value is received by ingestion | Ingestion host | Ingestion (AD-4 §5) |
| **T2** | `emitted_at`: the envelope is assembled, validated and hashed | Ingestion host | Ingestion (AD-4 §5) |
| **T3** | The event is accepted by distribution | Distribution host | Distribution (AD-3's mechanism) |
| **T4** | Express accepts the event as the subject's current value | Express host | Express |
| **T5** | The bytes of the corresponding `update` message are written to the client socket | Express host | Express |
| **T6** | The browser has rendered the new value | Browser | The web client, by `performance.now()` |

In the single-host pilot (F-6), T1 to T5 are on **one** host and one clock, which is what makes the segment budgets in §3 measurable without clock synchronization. T0 is on a third party's clock and T6 is on the user's; §2.4 and §10 handle both.

### 2.3 The definitions that F-5 left open

**[PROPOSED]** Two different quantities, both needed, deliberately given different names:

| Name | Interval | What it answers | Budgeted in |
|---|---|---|---|
| **Delivery latency** | **T1 to T6** | "How fast is *our* pipeline?" — the part the project controls | §3.1, and it is what **F-5's 1 s** is applied to |
| **Observation age** | **T0 to the evaluation time** | "How old is this *value*?" — what the user must be told | §4, and it is what freshness and the labels use |

**[PROPOSED] F-5's "event-to-display" means delivery latency, T1 to T6.** The alternative, starting at T0, would make the budget depend on a provider's publication delay and on a third party's clock, so a provider's 3 s delay would show as a failure of our pipeline. The provider's contribution is not ignored: it is **T0 to T1**, measured and reported separately as **source delay** (§3.3), and it is what freshness and the display label already carry to the user.

**[PROPOSED] AD4-Q1 is decided here, as AD-4 §11.2 directs.** Freshness **age** is measured from `source_timestamp`, with `retrieved_at` as the fallback where the source timestamp is null — which is AD-4 §7's draft position, adopted unchanged. The two decisions are consistent: age starts at T0 because it describes the value; delivery latency starts at T1 because it describes the system.

### 2.4 How each is measured

**[PROPOSED]**

- **T1 to T5** are differences on one host's monotonic clock, so they are exact and need no tolerance.
- **T6** is a browser clock, so **T1 to T6 cannot be computed by subtraction across machines.** It is measured instead by a **correlated marker**: Express stamps each `update` with its own `server_time` (AD-1 §3.2 already carries this field), the client records `performance.now()` at render and reports the paired values, and the end-to-end figure is derived in the acceptance harness from a session whose clock offset was measured by a round trip at connection. In the single-host pilot the browser and the server are the same machine, as AD-1 §3 already assumes for the slice's target — "with both clocks on one host".
- **T0 to T1** is a difference across clocks and is therefore an estimate, bounded by `clock_tolerance_ms` (§10). It is reported as a distribution, never as a precise per-event number, and it is **never** used to judge the pipeline.
- **Percentiles** are computed over a stated window and a stated sample, both reported with the figure. A p95 over 20 events is not a p95.

---

## 3. Latency budgets

### 3.1 End-to-end delivery latency (T1 to T6)

**[PROPOSED]** Finalizing F-5's provisional target.

| Measure | Target | Rationale |
|---|---|---|
| p50 | ≤ 250 ms | — |
| **p95** | **≤ 1000 ms** | **F-5's figure, adopted unchanged.** It is already met with margin by the D-24 slice's architecture, so it is a real target rather than an aspiration |
| p99 | ≤ 2000 ms | One slow GC or one backpressure event must not count as a breach |
| Hard ceiling | 5000 ms | Beyond this the event is **late**, counted as a breach, and still delivered — never dropped. A dropped event would make the panel silently wrong, which is worse than a slow one |

Conditions: the §6.2 event-rate envelope, the §6.3 concurrency limits, one host, a warm process. Measured over a window of at least 300 s with at least 500 delivered events, which is the soak the D-24 acceptance harness already runs (`docs/PHASE3_D24_ACCEPTANCE.md` §1, a 300-second soak).

### 3.2 Segment budgets

**[PROPOSED]** They sum to less than the p95 ceiling, leaving headroom; a breach is attributed to a segment rather than to the pipeline as a whole.

| Segment | Interval | p95 | Owner |
|---|---|---|---|
| Ingestion processing | T1 to T2 | ≤ 50 ms | Dev A |
| Ingestion to distribution | T2 to T3 | ≤ 100 ms | Dev A, Dev D |
| Distribution to Express | T3 to T4 | ≤ 300 ms | Dev B |
| Express to the wire | T4 to T5 | ≤ 100 ms | Dev B |
| Wire to render | T5 to T6 | ≤ 250 ms | Dev C |
| **Total** | **T1 to T6** | **≤ 800 ms**, against the 1000 ms budget | — |

**The D-24 slice's own figures are unchanged.** Its poll adds up to one poll interval of its own (500 ms, AD-1 §3), because a poll is not a push; AD-1 §3 states its target as "display p95 ≤ 1 s from `emitted_at`, with both clocks on one host", and calls its numbers "for the slice, not final budgets". When AD-3's mechanism replaces the poll (AD-1 §4), the T2-to-T4 path becomes push-driven and §3.2 applies.

### 3.3 Source delay (T0 to T1)

**[PROPOSED]** Measured and reported, **not** budgeted by this project: it is the provider's. Per source, the p50 and p95 of T0-to-T1 are recorded, and a p95 that exceeds the source's `expected_interval_ms` is a **data-quality finding for Gate 3 review**, not a pipeline breach. For a synthetic source it is the generator's own offset and is near zero by construction.

### 3.4 Reconnect and resync

**[PROPOSED]** Finalizing F-5's second figure.

| Measure | Target | Definition |
|---|---|---|
| Reconnect **p95** | **≤ 5000 ms** | **F-5's figure, adopted unchanged.** From the moment the backend is reachable **through the edge proxy** to the moment a valid `snapshot` has been rendered — AD-1 §3's definition for the slice, generalized |
| First snapshot after connect | p95 ≤ 500 ms | A connection that opens without a snapshot is not a working stream |
| Resync completeness | 100% | A snapshot replaces all client state, so no subject may be left stale from before the gap (AD-1 §3.3) |

**Excluded from the reconnect target**, as AD-1 §3.3 already excludes them for the slice: permanent stopped states; a 429; a server-requested wait (`Retry-After`); and the hidden-tab and resumption states of AD-1 §3.3.1. Each is a deliberate wait, so counting it as latency would punish correct behaviour.

**Backoff must fit the target.** AD-1 §3.3 lowered the slice's maximum backoff from 4 s to 2 s for exactly this reason — "4 s after a hung 2 s attempt would exceed the 5 s target". The general rule: **the attempt timeout plus the maximum backoff must be under the reconnect p95 target.**

### 3.5 Adapter-side timing values (the numbers AD-5 defers)

**[PROPOSED]** Per transport, as registry defaults; a source's record may tighten them, never loosen them beyond the ceiling.

| Setting | `websocket` | `poll` | `scheduled` | `synthetic` |
|---|---|---|---|---|
| Request or connect timeout | 10 000 ms | 2 000 ms | 30 000 ms | n/a |
| Read timeout, per item or chunk | 35 000 ms | 2 000 ms | 30 000 ms | n/a |
| Backoff `base` (§7.2 of AD-5) | 1 000 ms | 1 000 ms | 60 000 ms | n/a |
| Backoff `ceiling` | 30 000 ms | 30 000 ms | 900 000 ms | n/a |
| `Retry-After` clamp | 1 to 300 s | 1 to 300 s | 1 to 3600 s | n/a |
| Breaker: failures / window | 5 in 60 s | 5 in 60 s | 3 in 3600 s | n/a |
| Breaker cooldown | 60 s | 60 s | 600 s | n/a |
| Outage: consecutive failures | 3 | 3 | 1 | 3 |
| Outage: silence window | 3 × `expected_interval_ms` | 3 × `expected_interval_ms` | 1.5 × the scheduled period | 3 × `expected_interval_ms` |
| Max response body | 1 MiB | 1 MiB | 8 MiB | n/a |
| `dedup_window` | 300 s | 300 s | 7 days | 300 s |
| Shutdown budget (`stop()`) | 2 000 ms | 2 000 ms | 2 000 ms | 2 000 ms |

The 35 000 ms websocket read timeout is deliberately above the 15 s heartbeat interval the slice uses (AD-1 §3.2) and matches the slice's own 35 s no-bytes rule (AD-1 §3.3), so one missed heartbeat is not a fault and two are.

**The D-24 slice keeps its own values** — a 400 ms poll deadline, a 500 ms interval, a 1 to 30 s `Retry-After` clamp, 3 failures or 2 s to outage, a 64 KiB body limit (AD-1 §3.1) — because they are approved for that slice and tuned to a 2 s generator interval. §3.5 governs new adapters.

---

## 4. Freshness

### 4.1 The model is AD-4's

**[APPROVED]** (AD-4 §7) Freshness is a function of the event, its source profile and the evaluation time; **age** is the evaluation time minus `source_timestamp`, or minus `retrieved_at` when the source timestamp is null; a negative age within the clock tolerance counts as 0; the ordering `live_max_age_ms` ≤ `stale_after_ms` ≤ `unavailable_after_ms` holds where set; a source without `stale_after_ms` cannot be displayed unless its transport is `manual`; **a source outage does not refresh or reset age**; the server evaluates with its own clock and sends the evaluation time, and the browser advances age by **elapsed monotonic time, not by its wall clock**.

AD-8 supplies the values. It changes none of the rules above.

### 4.2 Profile values per source category

**[PROPOSED]** `expected_interval_ms` is the cadence actually documented or configured for the source; the three thresholds are multiples of it, so one rule explains every row.

| Category | `expected_interval_ms` | `live_max_age_ms` | `stale_after_ms` | `unavailable_after_ms` | `clock_tolerance_ms` |
|---|---|---|---|---|---|
| Synthetic FX (AD-12 generator) | As configured (2 000 in the slice) | **null** — never Live | **3 × interval** | 15 × interval | 1 000 |
| FX, genuine streaming | Provider's, typically 1 000 to 5 000 | 2 × interval | 3 × interval | 15 × interval | 2 000 |
| FX, polled | The poll interval | 2 × interval | 3 × interval | 15 × interval | 2 000 |
| FX, daily reference rate (`scheduled`) | 86 400 000 | **null** — never Live | 129 600 000 (1.5 days) | 604 800 000 (7 days) | 60 000 |
| Economic indicator | Release schedule, or null | **null** | 1.5 × the release period, or 30 days if irregular | 90 days | 60 000 |
| Announcement | null (irregular) | **null** | **null** — an announcement does not go stale; it is dated | null | 60 000 |
| Bank holiday calendar | 86 400 000 | **null** | 7 days | 30 days | 60 000 |
| Manual entry | null | **null** | **null** — shows its age and no freshness state (AD-4 §7) | null | 0 |

**Why synthetic is never Live.** A synthetic value is labelled **Simulated** by AD-4 §8.1 rule 4, which precedes the Live rule, so a `live_max_age_ms` would have no effect. Setting it to null states that plainly instead of leaving a dead setting in the registry. AD-1 §3.2 fixes exactly this for the slice: `live_max_age_ms: null`.

**Why `3 × interval` for stale.** It is **F-5's rule** — "a synthetic source's value is stale after three expected update intervals" — generalized to every interval-driven source. Two intervals would make a single missed update stale, which is normal jitter; three means two consecutive misses, which is a real gap.

**Why announcements and manual entries never go stale.** They are not samples of a continuing quantity, so there is no interval against which lateness means anything. An announcement from last month is not stale, it is dated, and AD-4 §8.1 already requires every value to show its timestamp. AD-4 §7 permits this for `manual`; for `announcement` it needs the **AD8-Q2** decision (§11), because AD-4 §7 says a source without `stale_after_ms` cannot be displayed unless its transport is `manual`.

### 4.3 The slice's profile is unchanged

The D-24 slice's profile — `expected_interval_ms` 2000, `live_max_age_ms` null, `stale_after_ms` 6000, `unavailable_after_ms` 30000, `clock_tolerance_ms` 1000 (AD-1 §3.2) — satisfies §4.2's synthetic row at the 2 s interval for the first three settings. Its `unavailable_after_ms` of 30 000 is **tighter** than §4.2's 15 × interval, and it stays as approved: AD-1 v0.5 requires a mandatory positive `unavailable_after_ms` for the slice, a Dev C condition, and §4.2 does not loosen it.

### 4.4 Plausibility bounds (the numbers AD-5 §10 defers)

**[PROPOSED]** Wide by design: they exist to catch a decimal-point error or a test value in a production feed, not to smooth real volatility (AD-5 §10).

| Setting | FX | Economic indicator | Bank holiday |
|---|---|---|---|
| `value_min`, `value_max` | Per pair, from the registry: a factor of 10 either side of a documented reference level, recorded with its date and source | Per indicator, from the publisher's documented range | n/a (a date, validated as a real calendar date by AD-4 §6) |
| `max_relative_jump` | 20% from the subject's current value within one `expected_interval_ms` | 100% between consecutive releases | n/a |

For the synthetic source the bounds are the generator's declared range, so a generator defect is caught rather than displayed. The D-24 generator's rates are **deliberately unrealistic** (AD-1 §3), so its bounds are the generator's, never a market range.

---

## 5. Stale, unavailable and outage

### 5.1 The states, and who decides each

**[PROPOSED]** Four independent questions, each with one owner, so that no two components can disagree:

| Question | State | Decided by | From |
|---|---|---|---|
| Is the value old? | `fresh` / `stale` | **Express**, on the server clock, at evaluation | Age against `stale_after_ms` (AD-4 §7) |
| Is the value too old to show? | `unavailable` | **Express**, and the browser as age advances | Age against `unavailable_after_ms` |
| Is the source connected? | `starting` / `ok` / `outage` / `down` | **Ingestion** (AD-5 §9) | §3.5's outage criteria |
| What does the user see? | The label | **AD-4 §8.1**, first match wins | The above, plus class, transport and Gate 3 status |

**Freshness and source status are separate** (AD-5 §9.1), and the display shows both: AD-1 §3.3 requires source `outage` to be shown separately from a disconnected stream.

### 5.2 Boundary semantics

**[PROPOSED]** Exact-threshold behaviour is specified, because an unspecified boundary is a defect each implementation resolves differently. Following AD-1 §3.3's rule for the slice — "exactly 6.000 s is fresh; exactly 30.000 s is stale":

- `stale` when **age > `stale_after_ms`**; exactly at the threshold is `fresh`.
- `unavailable` when **age > `unavailable_after_ms`**; exactly at the threshold is `stale`.
- `Live` requires **age ≤ `live_max_age_ms`** (AD-4 §8.1 rule 6); exactly at the threshold is Live.

Monotonicity holds: age only increases between events, so a value never returns from `unavailable` to `stale` without a new event.

### 5.3 What happens at each state

**[PROPOSED]** Display is **AD-9's** to specify; these are the invariants AD-8 places on it, all from approved text:

| State | Invariant |
|---|---|
| `stale` | The number is still shown, with "stale" as a **qualifier beside the label, not a sixth label** (**AD4-Q3**, owner-decided), and the age is shown. A stale value is never Live (AD-4 §8.1) |
| `unavailable` | **No number is shown.** The last value may appear only as history, with its timestamp (AD-4 §8.1). The current event stays as the ordering watermark, but its number is not sent (AD-1 §3.4) |
| Source `outage` | Values keep their own ages and states; the outage is shown separately. **No value is refreshed by a reconnection** (AD-4 §7) |
| Stream disconnected | Values stay and their ages keep advancing through the same states; a new snapshot replaces all state (AD-1 §3.3) |
| Any of the above | **Routing continues unchanged** (**AD6-Q2**). An observation outage cannot cause a routing refusal; AD-6 §6 records this against scope §3.D's fallback proposal |

---

## 6. Availability, capacity and the event-rate envelope

### 6.1 Availability targets for the single-host pilot

**[PROPOSED]** Targets for a **controlled, single-host, containerized pilot** (F-6), measured inside the private development environment. They are objectives for a research pilot with named users (D-1), not a service-level agreement, and nothing here authorizes exposure (D-6, D-16).

| Service level indicator | Target | Window | Notes |
|---|---|---|---|
| Observation channel availability | 99.0% | Calendar month | A single host with no redundancy; planned restarts are excluded and announced |
| Routing path availability | **Unchanged from Phase 2** | — | Not set here; A-8's limits stand |
| Observation delivery success (events accepted and delivered / events emitted) | ≥ 99.9% | Rolling 24 h | A dropped event is a defect; §3.1 delivers late rather than dropping |
| Freshness attainment (share of evaluations where a displayed value is `fresh`) | ≥ 95% per source | Rolling 24 h | Depends on the provider, so it is reported per source and is a Gate 3 data-quality input, not only an engineering one |
| Planned maintenance | ≤ 1 window per week | — | Announced to the named pilot users |

**Explicitly not targeted:** redundancy, failover, multi-host operation and a recovery-point objective for observations. A single host cannot provide them, and claiming otherwise would breach exit criterion 8.

### 6.2 Event-rate envelope

**[PROPOSED]** The envelope the budgets hold under. AD-2 owns the throughput **requirements**; this is the capacity AD-8 commits to and tests against.

| Measure | Value |
|---|---|
| Sustained, all sources | **20 events/s** |
| Burst, for up to 10 s | **100 events/s** |
| Distinct subjects in current state | ≤ 500 |
| Largest single envelope | 65 536 UTF-8 bytes of payload JSON (AD-1 §3.3.5, clarification **C-2**) |
| Sustained, per source | 10 events/s |

The D-24 slice runs at **2 events/s** across four pairs (AD-1 §3), so the envelope is an order of magnitude above the only measured workload. It is a **design envelope**, not a measurement, until §9's load test runs.

### 6.3 Concurrency limits

**[PROPOSED]** Generalizing AD-1 §3.5, whose numbers are approved for the slice:

| Limit | Value | Reason |
|---|---|---|
| Streams per user | **3** | AD-1 §3.5. Browsers allow about 6 HTTP/1.1 connections per origin, so several tabs would otherwise starve ordinary requests (AD-1 §5 item 4) |
| Streams in total | **20** | AD-1 §3.5. Sized for the named-user pilot |
| Behaviour at the limit | `429` with `Retry-After: 5`; **a new stream never evicts an old one** | AD-1 §3.2, §3.5 |
| Backpressure | At most one pending `update` per subject and one pending heartbeat, newest wins; no drain within 10 s destroys the stream | AD-1 §3.5 |
| Heartbeat interval | 15 s, and at once on a source-status change | AD-1 §3.2 |

**Backpressure is a latency decision, not only a memory one.** Keeping the newest update per subject means a slow client receives current values late rather than a correct history very late — the right trade for a panel that displays only the current value, and the reason ages and `stream_seq` are computed **at write**, not at enqueue (AD-1 §3.5).

---

## 7. Monitoring

### 7.1 Metric catalogue

**[PROPOSED]** Names are stable; labels are bounded, because an unbounded label is an outage of its own. Every latency metric is a histogram, so percentiles are computed rather than averaged.

| Metric | Type | Labels | Budget it serves |
|---|---|---|---|
| `observation_delivery_latency_ms` | Histogram | `source_id`, `event_type` | §3.1 |
| `observation_segment_latency_ms` | Histogram | `segment` (T1-T2 … T5-T6), `source_id` | §3.2 |
| `observation_source_delay_ms` | Histogram | `source_id` | §3.3 |
| `observation_events_total` | Counter | `source_id`, `outcome` (`validated`, `quarantined`, `rejected`, `duplicate`, `late`, `conflict`) | §6.1 |
| `observation_quarantine_total` | Counter | `source_id`, `reason` (the AD-4 §6 codes) | §4.4 |
| `observation_source_status` | Gauge | `source_id`, `status` | §5.1 |
| `observation_adapter_faults_total` | Counter | `source_id`, `class` (the AD-5 §7.1 classes) | §7.3 |
| `observation_breaker_state` | Gauge | `source_id` | AD-5 §7.4 |
| `observation_value_age_ms` | Gauge | `source_id`, `subject` | §4 |
| `observation_freshness_state` | Gauge | `source_id`, `freshness` | §5 |
| `stream_connections` | Gauge | — | §6.3 |
| `stream_connect_duration_ms` | Histogram | `outcome` | §3.4 |
| `stream_reconnects_total` | Counter | `reason` | §3.4 |
| `stream_rejections_total` | Counter | `code` (`STREAM_LIMIT`, `UNAUTHENTICATED`, …) | §6.3 |
| `stream_backpressure_events_total` | Counter | — | §6.3 |
| `stream_destroyed_no_drain_total` | Counter | — | §6.3 |

**Cardinality:** `subject` is labelled only where the subject allowlist is bounded (AD-5 §6.3) and at most 500 subjects exist (§6.2). `reason` and `class` are closed enumerations. **No label ever carries a payload value, a user identity, a token or a URL.**

### 7.2 What is never recorded

**[PROPOSED]** A metric or a log line never carries: a payload value; a credential or token; a user's identifier beyond the opaque internal reference AD-4 §2 already requires for `review`; a provider URL with a query; or the text of an `announcement`. AD-1 §3.4's rule stands: counters by reason, and rate-limited logs with the reason and, where well formed, the `event_id`.

### 7.3 Alerts

**[PROPOSED]** Each alert names its condition, its window and what the responder does. Debounced, because a flapping source must not drown the signal (AD-5 §9.2).

| # | Alert | Condition | Severity |
|---|---|---|---|
| L-1 | Delivery latency breach | p95 of `observation_delivery_latency_ms` > 1000 ms for 5 min | Warning |
| L-2 | Severe latency breach | p99 > 5000 ms for 5 min, or any event past the hard ceiling | Error |
| S-1 | Source outage | `observation_source_status` = `outage` for > 3 × `expected_interval_ms`, and at least 60 s | Warning |
| S-2 | Source down | status = `down`, that is a permanent fault: authentication, authorization or contract violation | **Error, paged.** It never self-heals (AD-5 §3.3) |
| S-3 | Retry storm | `observation_adapter_faults_total` with class `rate_limited` rising for 10 min | Error |
| Q-1 | Quarantine rate | > 5% of a source's events quarantined over 15 min | Warning |
| Q-2 | Conflict loop | any `conflict` outcome for the same subject twice in 5 min | **Error.** The C-1 defect presented exactly this way, and it failed silently in a counter (AD-1 §3.4.1) |
| F-1 | Freshness attainment | a source below 95% fresh over 24 h | Warning |
| C-1 | Stream capacity | `stream_connections` ≥ 90% of 20, or `stream_rejections_total{code="STREAM_LIMIT"}` rising | Warning |
| C-2 | Backpressure | `stream_destroyed_no_drain_total` rising | Warning |
| B-1 | **Boundary violation** | any AD-6 control failing at runtime: an unexpected egress attempt, an import-boundary failure, or a credential present where §12 of AD-5 forbids it | **Error, paged.** It is a safety property, not a performance one |

**No alert is wired to a routing action.** An alert changes operator attention and the observation panel, never an engine request, a policy, a scenario or a result (AD-6 §1, §4).

### 7.4 Logs and traces

**[PROPOSED]** Structured JSON lines, with the `event_id` as the correlation key through ingestion, distribution and Express, and the request id for the routing path, which stays separate. One trace per observation across T1 to T5 where the mechanism supports propagation (AD-3). **Observation traces and routing traces are never joined**, because a joined trace would record an observation as context for a decision, which AD-6 §6.1 confines to a separate record described as "displayed context", never as an input.

---

## 8. Recovery

### 8.1 Objectives

**[PROPOSED]** Per component, in a single-host pilot with no redundancy. "Recovery" means a correctly labelled display again, not necessarily a complete history.

| Component restarts | Objective | What is lost |
|---|---|---|
| **Ingestion** | Serving again within 10 s; the first event within one `expected_interval_ms` | In-memory current state. For the D-24 slice a restart may lose state and needs no reset: a clock moved backwards yields late events, and values age out safely (AD-1 §3, §3.4) |
| **Distribution** | Accepting again within 30 s | Durability and replay are **AD-3's** to decide; until then, events in flight |
| **Express** | Listening within 15 s; clients reconnected and resynced within the §3.4 p95 | Current state, rebuilt from the next events. Polling starts after the server listens, and **readiness and routing never depend on it** (AD-1 §3.5) |
| **Browser** | One fresh `snapshot`, exactly one per resumption (AD-1 §3.3.1) | Nothing beyond the gap; a snapshot replaces all state |
| **Provider outage ends** | `ok` within one successful item; the breaker admits a probe after its cooldown | The events of the outage, unless the provider offers a backfill, which is a Gate 3 question |

**Observations have no recovery-point objective in v1**, because no durability is decided (AD-3) and the slice stores nothing. That is stated as a limitation rather than left to be inferred.

### 8.2 Graceful shutdown

**[PROPOSED]** Generalizing AD-1 §3.5, which is approved for the slice: refuse new streams with `503` and `Retry-After: 1`; stop polling and abort the request in flight; end all streams, destroying any left after 1 s; then close the server and disconnect the database. **The process exits 0** — AD-1 §6 item 4 makes "a shutdown with open streams exits 0" an acceptance item, and the D-24 harness asserts `sigterm: the backend exits 0` (`docs/PHASE3_D24_ACCEPTANCE.md` §1). Total shutdown budget: **10 s**, below the Compose and orchestrator default kill timeout.

### 8.3 Drills

**[PROPOSED]** Inside the private development environment, which needs no gate (scope §5, Gate 4 row). Each is a milestone 3.7 deliverable and an exit-criterion-5 input.

| # | Drill | Passes when |
|---|---|---|
| R-1 | Kill and restart ingestion under load | §8.1's objective is met; no conflict, no duplicate storm, no stalled subject — the C-1 failure mode is specifically checked |
| R-2 | Kill and restart Express with open streams | Every client resyncs within the §3.4 p95; no slot, timer or listener leaks (AD-1 §6 item 4) |
| R-3 | Provider outage and recovery, by the fake provider | Values go stale, then Unavailable, at the §5.2 boundaries; recovery is one successful item; **no value is refreshed by the reconnection** |
| R-4 | Clock moved backwards on the ingestion host | Late events, values age out safely, no negative age shown (AD-1 §3.4) |
| R-5 | Disk or database loss, then restore from backup | Phase 2 records restore; observation loss is bounded as §8.1 states and is **reported, not hidden** |
| R-6 | Graceful shutdown under full load | §8.2 holds; exit code 0 |
| R-7 | **Routing non-interference during every drill above** | AD-6 T-1's `decision_id` and engine responses are identical throughout. This is the drill that matters most: it proves the observation path can fail in every way without touching routing |

---

## 9. Acceptance criteria

**[PROPOSED]** Exit criterion 9 requires that "the latency budget is a recorded number, and load tests measure against it" (scope §8.2). AD-8 is where the numbers are recorded; these are the tests.

| # | Criterion | Method |
|---|---|---|
| N-1 | §3.1's p50, p95, p99 and the hard ceiling are met at the §6.2 sustained rate | A ≥ 300 s soak with ≥ 500 events, reporting the window and the sample size with every percentile (§2.4) |
| N-2 | §3.2's segment budgets are met, and a breach is attributed to a segment | Per-segment histograms from one host's clock |
| N-3 | §3.1 is met during a §6.2 burst, and recovers within 10 s of its end | Burst injection by the AD-12 harness |
| N-4 | §3.4's reconnect p95 is met from each recoverable cause, and the excluded states are **not** counted | The AD-1 §3.7 client fault catalogue |
| N-5 | §4.2's thresholds behave exactly at their boundaries | Fake clocks, as AD-1 §3.7 requires for threshold tests |
| N-6 | §5.3's invariants hold in the browser at every state | The browser acceptance suite, as in the D-24 slice's own §6 item 8 |
| N-7 | §6.3's limits hold, with no eviction of an existing stream and no leak | Connection-storm and slow-client tests |
| N-8 | §7.1's metrics all exist, with bounded cardinality, and §7.2's prohibitions hold | A metrics-surface test, plus a scan for forbidden fields |
| N-9 | §7.3's alerts fire on their conditions and do **not** fire on the excluded states | Synthetic fault injection per alert |
| N-10 | §8.3's drills R-1 to R-7 pass | Recorded drill runs |
| N-11 | **Routing non-interference holds throughout every test above** | AD-6 T-1, T-2 and T-6, run before and after each (`docs/PHASE3_D24_ACCEPTANCE.md` §2 is the precedent) |
| N-12 | **No provider data is used in any of it** | Every load and fault fixture is synthetic or hand-written (D-17; AD-5 §13 obligation A-10) |

**Reporting rules.** Every figure is reported with its window, sample size, event rate, host and commit. A figure from the synthetic path is described as **"streaming pipeline exercised with synthetic events only; no live source integrated"** (scope §6), and no engineering figure is presented as evidence about routing quality (scope §4.2).

---

## 10. Clock discipline

**[PROPOSED]**

| Rule | Reason |
|---|---|
| Latency is measured only between points on **one** clock (§2.4) | A cross-machine subtraction measures skew, not latency |
| The ingestion host runs NTP; its offset is monitored and alertable | Every age and every `retrieved_at` depends on it |
| A provider's timestamp is **never** rewritten, even when it is implausible | It is quarantined as `FUTURE_SOURCE_TIMESTAMP` (AD-4 §6). Rewriting would destroy the evidence that the clocks disagree (AD-5 §3.5) |
| The browser advances age by **elapsed monotonic time**, never its wall clock, and applies the received `profile` | AD-4 §7, AD-1 §3.3. A user's clock may be wrong by hours |
| `clock_tolerance_ms` is per source (§4.2) | A streaming FX source and a daily calendar need different tolerances |
| A negative age within tolerance counts as 0 | AD-4 §7. Never a negative age on screen |

---

## 11. Questions for the project owner

| # | Question | Draft position | Decides |
|---|---|---|---|
| AD8-Q1 | Is **delivery latency T1 to T6** adopted as the meaning of F-5's "event-to-display", with source delay T0 to T1 reported separately? | Yes (§2.3). Starting at T0 would make a provider's publication delay a failure of our pipeline | Owner, on this document. It closes the 3.1 plan §6 risk and **P2** |
| AD8-Q2 | May an `announcement` source be displayed with **no** `stale_after_ms`? AD-4 §7 permits that only for `manual` | Yes: an announcement is dated, not stale (§4.2). It needs either this decision or an AD-4 revision | Owner; it touches AD-4 §7, approved text |
| AD8-Q3 | Are §6.1's availability targets accepted as **research-pilot objectives** for a single host, with no redundancy and no observation recovery-point objective? | Yes, stated as limitations rather than implied | Owner |
| AD8-Q4 | Is the §6.2 envelope (20 events/s sustained, 100 burst) accepted as the design envelope before **AD-2** states requirements? | Yes, as a ceiling AD-2 may lower or justify raising | Owner; revisited in AD-2 |
| AD8-Q5 | Is `3 × expected_interval_ms` adopted as the **general** stale rule, not only the synthetic one F-5 names? | Yes (§4.2). Two intervals would make normal jitter stale | Owner |
| AD8-Q6 | Does **AD4-Q1** stand as decided in §2.3 — age from `source_timestamp`, falling back to `retrieved_at`? | Yes, AD-4 §7's draft position unchanged | Owner. AD-4 §11.2 names AD-8 as the decider |

---

## 12. Known gaps

| # | Gap | Closed by |
|---|---|---|
| 1 | **Every figure here is a design target, not a measurement**, except where it restates an approved slice figure or a measured D-24 runtime. Nothing in §3, §4 or §6 has been load-tested | §9's tests, in milestones 3.5 and 3.7 |
| 2 | **No durability or replay is decided**, so §8.1 has no recovery-point objective for observations | **AD-2**, **AD-3** |
| 3 | **Provider-specific freshness values cannot be finalized**, because no provider is approved and no documentation has been read for one. §4.2 gives category defaults only | **Gate 3**, per provider; then a registry record under AD-5 §2.2 |
| 4 | **The metric and alert mechanism is unchosen.** §7 specifies names, labels and conditions, not a stack | Milestone 3.7; AD-10 for anything exposed |
| 5 | **AD-6 B-4 is unresolved on the inference side.** D-25 waives it for the D-24 slice only; it is not Gate 4 evidence and no gate has passed | **AD-10** (scope §2.2.3, D-25) |
| 6 | **§3.4's reconnect figure assumes an edge proxy whose behaviour is reasoned, not tested.** AD-1 §3.6 states this for Nginx: "reasoned from the configuration, not tested" | AD-1 §3.6's verification list, through the published port |
| 7 | **AD-9 is not written**, so what is displayed at each §5 state is specified only as an invariant here | **AD-9** (lead Dev C), which needs AD-4, AD-6 and this document |
| 8 | **Load testing has not run**, so exit criterion 9 is unmet even after this document is approved: it requires a recorded number **and** load tests against it | §9 N-1 to N-3; milestone 3.7 |

---

## 13. Approval checklist

**None of these is given. This document is DRAFT v0.1 and has not been reviewed.**

- [ ] **Dev B** — review: §3.2's Express segments; §6.3's limits and backpressure against AD-1 §3.5; §7's metrics and labels on the Express side; §8.2's shutdown budget against `lifecycle.ts`
- [ ] **Dev C** — review: §3.2's wire-to-render segment; §3.4's reconnect definition and exclusions; §5.3's display invariants; §4's browser-side monotonic age rule
- [ ] **Dev D** — review: §2.4's measurement method and harness implications; §9's acceptance tests against the existing CI; §7.4's logs and traces; §8.3's drills
- [ ] **Second-reviewer rule (D-20)** — satisfied by any review above, since Dev A is both lead and approver
- [ ] **Project owner** — approval, with §11's questions decided

On approval: **F-5's targets become final** (D-12), the 3.1 plan §6 measurement-point risk closes, **P2** is answered, and **AD-9** and milestone 3.5 gain a required input. Exit criterion 9 still needs the load tests of §9. **No gate passes by this document.**
