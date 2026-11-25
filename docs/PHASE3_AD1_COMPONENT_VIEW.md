# AD-1: Component View

**Status:** **DRAFT v0.2**, 25 November 2026. **Not approved.** v0.2 reconciles the D-24 review feedback from Dev B, C and D (§8). The reviewers have not confirmed this revision. No code may start before the owner approves it (D-22).
**Lead:** Dev D. **Reviewers:** Dev A, Dev B, Dev C. **Approver:** project owner.
**Scope source:** `docs/PHASE3_SCOPE.md` v1.3 §2.2.2, §7.3; D-22, D-24; F-2, F-3, F-6.
**Extends:** `PHASE2_ARCHITECTURE.md` §2. **Relies on:** AD-4 (envelope) and AD-6 (boundary), both drafts.

Approving this view satisfies D-22 **for the D-24 slice only**. §4 places the later components, but the owner must confirm that placement before any milestone 3.2–3.7 begins. Everything not citing a decision is **proposed**; **[P-n]** marks proposals that need a named confirmation (§7).

## 1. Components of the slice

```text
 default network (Phase 2, unchanged)             "observations" network (internal)

 Browser --> web (nginx) --> backend (Express) ---- polls ----> ingestion (Python, synthetic)
             127.0.0.1           |   |                           no published port
                                 |   +--> postgres
                                 +------> inference    (no path from ingestion)
```

| Component | Does | Must not | Owner |
|---|---|---|---|
| **Ingestion** (new, `services/ingestion/`) | Generates seeded synthetic `fx_rate` envelopes (AD-4); serves the latest one per pair over private HTTP | Contact any external host, inference or PostgreSQL; mount project files; hold a secret | Dev A |
| **Observation module** (new, in Express) | Polls, validates, keeps the current event per pair in memory, serves SSE | Import, or be imported by, routing, mapper or inference-client code (`app.ts` and `server.ts` may compose both); write to the database | Dev B |
| **Observation panel** (new, in React) | Shows values, labels, age and source on the desktop dashboard | Share state with any form or routing request | Dev C |
| **Compose overlay** (new, `infra/compose.observations.yaml`) | Adds ingestion and its network; enables the feature | Publish a port; change `compose.yaml` | Dev D |

Inference, Prisma, PostgreSQL, the engine, API contract v0.4 and the OpenAPI files are unchanged.

## 2. Trust boundaries

| Boundary | Control |
|---|---|
| Browser → Express | Existing development bearer token in the `Authorization` header, never in a URL. Loopback only (A-1, D-16). |
| Ingestion → Express | Untrusted input, strictly validated and bounded (§3.1, §3.4). Unauthenticated; isolation is the internal network, or host loopback outside Docker. |
| Observation → engine | No path (AD-6). Enforced by network, import checks and non-interference tests. |

## 3. Slice decisions

Under D-24, §3 stands in for AD-2, AD-3, AD-5, AD-7 to AD-10 and AD-12 **for this slice only**. It approves none of them.

| For | Where |
|---|---|
| AD-2, AD-3 | 2 events/s: 4 pairs, each every 2 s, staggered by 500 ms. Express polls every 500 ms. No broker, durability or replay; a restart may lose state. |
| AD-5 | §3.1, §3.4 |
| AD-7, AD-10 | §3.2, §3.5, §3.6 |
| AD-8, AD-9 | §3.3. Display p95 ≤ 1 s from `emitted_at`, with both clocks on one host; reconnect p95 ≤ 5 s from the moment the backend is reachable **through Nginx**. Numbers are for the slice, not final budgets. |
| AD-12 | Seed and sequence fix payloads and hashes. Timestamps come from an injected clock; `event_id` is a UUIDv5 of seed, sequence and timestamp. Rates are deliberately unrealistic. No review queue. Faults: §3.7. |

### 3.1 Ingestion contract: `GET /v1/latest` [P-1]

No query, body or authentication. It returns the latest **validated** envelope per pair; quarantined events are never served.

**200**, `application/json`, `Cache-Control: no-store`. Closed schema, all fields required:

| Field | Value |
|---|---|
| `protocol_version` | `"1.0"` |
| `instance_id` | UUID, new at each ingestion start |
| `source_id` | `"synthetic.fx"` |
| `generated_at` | AD-4 timestamp |
| `events` | 0–4 AD-4 envelopes, at most one per pair, sorted by base then quote |

**Empty state:** before the first event, `200` with `events: []`. Never `204` or `404`.

**Errors:** `{"error": {"code", "message"}}`, with no internal detail.

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_REQUEST` | Any query parameter or body |
| 404, 405 | `NOT_FOUND`, `METHOD_NOT_ALLOWED` | Unknown path; method other than GET (with `Allow: GET`) |
| 500 | `INTERNAL_ERROR` | Unexpected failure |
| 503 | `NOT_READY` | Generator not running or stopping |

`GET /healthz` returns 200 while the process is alive; it is the container health check.

**Express as client.** One poll in flight; 400 ms deadline; body ≤ 64 KiB, checked while reading; no redirects. The URL is fixed by configuration: `http`, with no credentials, query or fragment.

| Result | Express does |
|---|---|
| 200, valid | Applies each event (§3.4). `events: []` is a success and clears nothing. |
| 200, bad body, wrong content type, unknown version, duplicate pair or more than 4 events | Rejects the whole response; failed poll |
| 200, some events invalid | Rejects those events only; successful poll |
| 3xx, 401, 403, other 4xx | Failed poll (contract fault). Next poll after 5 s. No credential is ever sent. |
| 429 | Failed poll. Waits `Retry-After` in seconds, limited to 1–30 s; 5 s if absent or invalid. |
| 5xx, timeout, network error | Failed poll. Next poll at the normal interval. |

Source status is `starting` until the first successful poll and `ok` after one. From either state it becomes `outage` after 3 consecutive failures, or after 2 s without a success, whichever is first. No poll result refreshes a value's age, and no upstream status is passed to the browser as an HTTP status.

### 3.2 SSE contract: `GET /api/rt/v1/observations/stream`

Outside API contract v0.4; read with `fetch`. No query. `Last-Event-ID` is ignored and no SSE `id:` is sent, because there is no replay.

**200 headers:** `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-store, no-transform`, `X-Accel-Buffering: no`. Each message is `event: <type>` and one `data:` line of JSON (≤ 64 KiB). Field names are `snake_case`, as in AD-4. The producer's schemas are closed; clients ignore unknown message fields (AD-4 §9 governs the envelope).

**Every message:**

| Field | Value |
|---|---|
| `protocol_version` | `"1.0"` |
| `type` | `snapshot`, `update` or `heartbeat`; equals the SSE event name |
| `stream_seq` | Integer from 1, +1 per message written on this connection |
| `server_time` | Evaluation time, AD-4 timestamp |
| `source` | `{source_id, status}`; status as in §3.1 |

| Type | Sent | Extra fields |
|---|---|---|
| `snapshot` | First, exactly once per connection, even when no value exists | `profile`; `values`: exactly 4, in the §3.4 pair order |
| `update` | When Express accepts a newer event | `value` |
| `heartbeat` | Every 15 s, and at once when the source status changes | None |

- **`value`:** `{base_currency, quote_currency, event, age_ms, freshness}`. `event` is the unmodified envelope; `freshness` is `fresh`, `stale` or `unavailable`. If unavailable or never received, `event` and `age_ms` are null and `freshness` is `unavailable`.
- **`profile`:** `expected_interval_ms` 2000, `live_max_age_ms` null, `stale_after_ms` 6000, `unavailable_after_ms` 30000, `clock_tolerance_ms` 1000.

**Versioning:** a minor version adds optional fields or message types; a major version changes meaning and the path (`/api/rt/v2`). A client ignores an unknown type. On an unknown major version it shows Unavailable and stops.

**Errors before the stream starts** use the Phase 2 envelope (contract v0.4 §4):

| Status | Code | When |
|---|---|---|
| 401 | `UNAUTHENTICATED` | Checked first, also before 405 |
| 422 | `VALIDATION_ERROR` | Any query parameter |
| 405 | `METHOD_NOT_ALLOWED` | Anything but GET, HEAD included |
| 429 | `STREAM_LIMIT`, with `Retry-After: 5` | §3.5 limits |
| 503 | `SHUTTING_DOWN`, with `Retry-After: 1` | Shutdown has begun |

With the feature off the route is not registered, so it is 404. An ingestion outage is **not** an HTTP error: the stream opens and reports it.

### 3.3 Freshness, reconnect and display

- **Ownership.** Express owns acceptance, thresholds and the evaluated age (from `source_timestamp`, on the server clock; AD-4 §7). The browser advances `age_ms` by elapsed monotonic time and applies the received `profile`. It has no thresholds of its own and never uses its wall clock. AD-8 sets final values.
- **Thresholds:** stale at age **> 6 s**; unavailable at age **> 30 s**. Exactly 6.000 s is fresh; exactly 30.000 s is stale.
- **Labels:** "Simulated" (shown as SIMULATED), "Simulated · stale", then "Unavailable" with no number (AD-4 §8). Every available value shows its source, age and transport.
- **Lost stream:** a disconnected status; values stay and their ages keep advancing through the same states. A new snapshot replaces all state. Source `outage` is shown separately from "disconnected".
- **Resume:** when a hidden or suspended page becomes visible, the client reconnects before showing values, because monotonic clocks may pause during sleep.
- **Routing is unaffected throughout** (AD6-Q2).

| Client sees | Client does **[P-2]** |
|---|---|
| 401 | Stops, uses the existing sign-in handling, never reconnects by itself |
| 403, 404, other 4xx | Stops; shows "Observations unavailable" |
| 429 | Shows "too many streams"; waits the larger of `Retry-After` (5 s if absent) and the backoff, at most 30 s, then retries |
| 5xx, network error, normal stream end | Reconnects with the backoff below. `Retry-After` on 503 is honoured, at most 30 s. An Nginx 502 or 504 without an envelope is keyed by status. |
| No response headers within 2 s; no bytes for 35 s; a `stream_seq` gap; a malformed message; a first message that is not `snapshot` | Aborts and reconnects. Three malformed, gap or first-message faults without 60 s of valid streaming between them stop it with an error. |

**Backoff:** 1 s, then 2 s (the maximum), each multiplied by a random 0.5–1; reset after a valid snapshot. This lowers v0.1's 4 s maximum, because 4 s after a hung 2 s attempt would exceed the 5 s target. The target excludes stopped states, 429 and server-requested waits.

### 3.4 Pairs, ordering and event handling

**Pairs [P-3]:** a fixed allowlist, in this order: AED/MXN, EUR/USD, GBP/PHP, USD/INR; `rate_type` `mid`. Any other pair, rate type or source is rejected, so state is at most 4 events. Pairs imply no routing input (AD-6).

Express validates each event (AD-4 schema, synthetic markers, code membership, `payload_sha256`, real dates, `retrieved_at` ≤ `emitted_at`), then applies the first match **[P-4]**:

| Case | Result |
|---|---|
| Invalid, not from `synthetic.fx`, or outside the allowlist | Rejected; counted |
| Not `validated` | Withheld as quarantined; counted |
| `source_timestamp` null | Rejected; counted |
| Any timestamp more than 1 s after the Express receive time | Withheld as future; counted. It never becomes current, so it cannot block later valid events. Within 1 s, age counts as 0. |
| Same `event_id` as a current event, identical content | Duplicate (normal for polling): ignored, no update |
| Same `event_id` as a current event, different content or pair | Conflict: rejected, counted; first kept |
| Older than the pair's current event | Ignored; counted as late |
| Same `source_timestamp`, different `event_id` | Conflict: first kept; counted |
| Newer `source_timestamp` | Becomes current; one `update` |

- Order depends on `source_timestamp` only. `source_sequence` is opaque (AD-4) and `instance_id` is diagnostic. An ingestion restart needs no reset; a clock moved backwards yields late events, so values age out safely.
- The current event stays as the ordering watermark after it becomes unavailable, but its number is not sent.
- **Quarantine:** ingestion marks AD-4 §6 cases (for a future source timestamp, > `retrieved_at` + 1 s) `quarantined` and withholds them; Express independently withholds them. Both keep **only** counters by reason and rate-limited logs with the reason and, if well formed, the `event_id`. No payload is stored and there is no review queue.

### 3.5 Backend lifecycle, limits and backpressure [P-5]

- **Start:** polling starts after the server listens. Readiness and routing never depend on it.
- **Authentication:** existing `requireAuth`, any development role, before a slot is taken. Development tokens cannot be revoked individually: sign-out aborts the client's streams, and removing a token takes effect when the backend restarts.
- **Limits:** 3 streams per user, 20 in total; check and reservation are one synchronous step. The slot is released exactly once, on the first of close, error or shutdown. A new stream never evicts an old one.
- **Backpressure:** when a write reports a full buffer, the stream keeps at most one pending `update` per pair and one pending heartbeat (newest wins) and writes them on `drain`; ages and `stream_seq` are computed at write. No drain within 10 s destroys the stream. The poller never waits for a stream.
- **Cleanup:** closing removes listeners and timers and drops pending data. The request logger records only `finish`, so the module logs open and close itself, without tokens or payloads.
- **Shutdown:** refuse new streams (503); stop polling and abort the request in flight; end all streams, destroying any left after 1 s; then the existing `server.close` and database disconnect. `lifecycle.ts` needs one **additive** pre-close hook: without it, open streams hold `server.close` until the 10 s forced exit with code 1.

### 3.6 Networks, overlay and Nginx

- **Dual-network backend.** In the overlay the backend lists **both** `default` and `observations`, because naming any network removes the implicit default. Ingestion is on `observations` only (`internal: true`); no other service joins it. Express forwards nothing between them. Merged-config and runtime tests check every service's networks.
- **Isolated ingestion [P-6].** No published port, `env_file`, secret or volume; non-root, read-only root filesystem, `cap_drop: [ALL]`, `no-new-privileges`, process and memory limits. Without capabilities it cannot add a route through the dual-network backend. `internal: true` alone may leave the host gateway address reachable, so the runtime test probes it. If it is reachable, use isolated gateway mode where the Docker version supports it, or record the residual risk for the owner.
- **Residual:** ingestion can open the backend's port 4000 on the shared network. It holds no token, so protected routes return 401; health routes are public.
- **Optional overlay:** `-f compose.yaml -f compose.observations.yaml`, profile `observations`. `compose.yaml` and `--profile full` alone are unchanged and never need ingestion. The backend has no `depends_on` ingestion. Overlay images have separate tags.
- **Off by default.** Without `OBSERVATIONS_URL`, Express neither polls nor registers the route. Without the build flag `VITE_OBSERVATIONS=on`, the panel is absent and requests nothing. The overlay sets both.
- **Nginx [P-7].** No configuration change is planned: `/api/` already proxies the path, the response header disables buffering, `text/event-stream` is not in `gzip_types`, and 15 s heartbeats fit the default 60 s read timeout. This is **reasoned from the configuration, not tested**. Verify through the published port:
  - the snapshot arrives at once, and updates one by one, not batched;
  - a quiet stream stays open > 60 s;
  - a client abort reaches Express and frees the slot;
  - 401, 429 and headers arrive intact;
  - the client recovers from a backend restart and from Nginx 502 (Nginx caches the backend address for 10 s).

  If a check fails, the `nginx.conf.template` change returns to review.

### 3.7 Verification and CI

| Item | Specification |
|---|---|
| **Contract validation** | Machine schemas for §3.1 and §3.2 in `contracts/events/`, referring to the AD-4 schema, with valid and invalid fixtures for every message, error and empty state. Both languages must give the same verdict on each event fixture. `check_contracts.py` does not cover `contracts/events/` today; a separate check is added **[P-8]**. |
| **Cross-language hashes** | `contracts/test-vectors/event_payload_hash.v1.json`: input, exact RFC 8785 string and SHA-256, checked by Python (`rfc8785`) and TypeScript, including AD-4 §10's hash, reordered keys, trailing-zero rates, and altered payloads that must fail. The backend has no RFC 8785 or JSON Schema library. Proposed: a strict `fx_rate` validator and a canonicalizer limited to objects and ASCII strings, with no new dependency **[P-9]**. |
| **Fault injection** | A controllable fake ingestion server, test-only and absent from runtime images. Events: duplicate, late, tie, ID conflict, future (at and beyond 1 s), malformed, wrong hash, quarantined, non-synthetic, extra pair. Responses: duplicate pair, oversized, empty, slow, 401, 429 with and without `Retry-After`, 5xx, redirect. Source: outage, recovery, restart, clock moved back. Streams: slow and abandoned clients, caps, sign-out, shutdown. Threshold tests use fake clocks. |
| **Focused CI** | A separate `phase3-observations` workflow, path-filtered to `services/ingestion/`, the overlay, `contracts/events/`, `contracts/test-vectors/`, `services/backend/` and `services/web/`. Unit, schema and hash checks on both languages; the AD-6 import rules; merged-Compose invariants; then one disposable overlay stack for Nginx, isolation, fault and T-1 tests, plus the existing API smoke test. No repository secrets. `phase2-*` workflows and their checks are not modified **[P-10]**. |

**Not recorded:** which observations were displayed (AD-6 §6.1). This slice stores nothing; that work stays with AD-7 and AD-11.

## 4. Placement of later components (not authorized)

| Component | Placement |
|---|---|
| Live adapters | Inside ingestion, one per Gate 3-approved provider, with outbound access limited to that provider |
| Event distribution | Between ingestion and Express; mechanism open (AD-2, AD-3). It replaces the poll. |
| Observation store, audit trail | Separate from Phase 2 records (AD-11) |
| Quarantine and review queue | After ingestion; no automatic path to the knowledge layer (AD-12, Gate 2) |
| Identity provider | Replaces development auth on Express routes and the stream (AD-10, milestone 3.2) |

## 5. Known gaps

1. **UNRESOLVED: inference outbound-network isolation.** AD-6 B-4 also says inference has no route to the internet. The Phase 2 stack does not enforce that, and this slice delivers only the ingestion side of B-4. The gap has not been accepted, and v0.1's proposal to accept it no longer stands as the default. The owner decides, with Dev B and Dev D:
   - **(a)** a recorded B-4 exception for D-24 only, closed in AD-10. Recommended: ingestion has no path to inference either way, and the Phase 2 stack stays unchanged; or
   - **(b)** isolate inference on an internal network in the overlay. This leaves `--profile full` alone unfixed and first needs proof that inference works without egress.

   Until then T-5 cannot fully pass, and AD-6 must not be described as fully enforced.
2. Express is on both networks, so it is the single point that keeps them apart.
3. `fetch` streaming needs one addition to the web API client, whose current method buffers whole responses and accepts only `/api/v1` paths; the token rule must allow exactly one more path. The web Dockerfile needs one build argument, off by default.
4. Browsers allow about 6 HTTP/1.1 connections per origin, so several dashboard tabs compete with ordinary requests. The cap of 3 per user limits this.

## 6. Acceptance

1. The same seed, sequence and injected clock give identical events; payloads and hashes do not depend on the clock. Every event passes the AD-4 schema.
2. The panel updates with no user action; the §3 targets are met over 5 minutes; every available value shows label, source and age.
3. Every §3.7 fault gives the specified result, and states change exactly at the thresholds.
4. §3.5 limits, cleanup and shutdown hold; a shutdown with open streams exits 0. Repeated connects leave no slot, timer or listener behind.
5. AD-6 T-1 to T-4, T-6 to T-8 and T-10 pass; T-5 passes for ingestion (no route to inference, PostgreSQL or the internet; the host gateway per §3.6; no credentials). The inference side of T-5 waits on §5 item 1. T-9 does not apply, because no context is recorded.
6. With the feature off, the Phase 1 and 2 suites, the fixtures and the existing Compose and stack-security checks pass unmodified.
7. The §3.6 Nginx checks pass through the published port.

## 7. Confirmations and approval

All are open. A tick means that person confirmed **v0.2**; earlier feedback does not count.

- [ ] **Dev A:** P-1 (§3.1); P-3 pairs; P-4 ordering and quarantine; P-9 hash vectors; generator (§3, AD-12)
- [ ] **Dev B:** P-1 polling; §3.2 errors and authentication; P-4; P-5 lifecycle hook, limits and backpressure; P-9 no-dependency validator; §5 item 1
- [ ] **Dev C:** §3.2 messages; §3.3 freshness ownership and labels; P-2 client handling, backoff and resume; P-3 pairs; §5 items 3 and 4
- [ ] **Dev D (lead):** P-6 isolation; P-7 Nginx; P-8 schema location and check (also AD4-Q5); P-10 workflow; §5 item 1
- [ ] **Project owner:** the §5 item 1 choice; approval of AD-1, AD-4 and AD-6, recorded in `docs/PHASE3_SCOPE.md` §2

## 8. Review reconciliation

The repository holds no text of the individual reviews. This table follows the feedback topics relayed by the project owner and attributes none to a person. "Addressed" means drafted here, **not** accepted by a reviewer.

| Topic | Addressed in |
|---|---|
| `/v1/latest` response, errors, empty state | §3.1 |
| SSE schemas and protocol version | §3.2 |
| Freshness ownership, thresholds, reconnect, 401/429/5xx | §3.1, §3.3 |
| Pairs, ordering, duplicates, quarantine, future timestamps | §3.4 |
| Lifecycle, authentication, limits, backpressure | §3.2, §3.5 |
| Networks, isolation, overlay, Nginx | §3.6 |
| Contracts, hash fixtures, faults, CI | §3.7 |
| Inference outbound-network isolation | §5 item 1, unresolved |

**AD-4 and AD-6:** as relayed by the project owner, Dev B, C and D approved AD-4, and Dev B and C approved AD-6, in the D-24 review. These are kept as **reviewer feedback**. They are not owner approvals and do not satisfy D-24's preconditions. The AD-4 and AD-6 checkboxes stay open. They do not settle the AD-6 B-4 gap (§5 item 1).
