# AD-1: Component View

**Status:** **APPROVED v0.5** (component view), 25 November 2026. Approved by the project owner on 25 November 2026 **for the D-24 slice only** (D-22 for that slice; §2.2.2 and §2.2.3 of `docs/PHASE3_SCOPE.md` v1.4). The text of v0.5 is unchanged by this approval: v0.3 answered Dev C's blockers B1 to B5; v0.4 applied Dev C's and Dev B's follow-up on the same sections: immediate abort (B1), recoverable versus permanent states (B2), SSE wire parsing and `profile` validation (B3), the §5 wording for the additive session method (B4), Dev B's §7 reference correction, and a safeguard against a late 401 from a superseded session. **v0.5** applied Varshini's (Dev C) final feedback: a mandatory positive `unavailable_after_ms` for the slice (§3.2, §3.3.3) and a single-connection rule that stops `pageshow` and `visibilitychange` opening two streams (§3.3.1).
**Review state:** all reviews are now in **on v0.5**. **Dev B APPROVE**, **Dev C (Varshini) APPROVE** — confirming B1 to B4 closed, B5 already resolved — and **Dev D ADOPT + APPROVE**. **Dev A** gave **technical approval** of the §3.1 ingestion contract, the four FX pairs (§3.4), the ordering and quarantine rules (§3.4) and the shared cross-language hash fixtures (§3.7): P-1, P-3, P-4 and P-9, and the generator. The **project owner approved v0.5 on 25 November 2026 for the D-24 slice**. Approval is version-specific: it covers **v0.5 only**, and any later revision needs fresh review and approval. The owner has **not** confirmed §4's placement of later components, so **no milestone 3.2–3.7 is authorized** (D-22 for those milestones is not satisfied). **No gate has passed.**
**Lead:** Dev D. **Reviewers:** Dev A, Dev B, Dev C. **Approver:** project owner.
**Scope source:** `docs/PHASE3_SCOPE.md` v1.4 §2.2.2, §2.2.3, §7.3; D-22, D-24, D-25; F-2, F-3, F-6.
**Extends:** `PHASE2_ARCHITECTURE.md` §2. **Relies on:** AD-4 v0.2 (envelope) and AD-6 v0.2 (boundary), both approved for the D-24 slice only on 25 November 2026.

This approval satisfies D-22 **for the D-24 slice only**. §4 places the later components, but the owner must confirm that placement before any milestone 3.2–3.7 begins. Everything not citing a decision is **proposed**; **[P-n]** marks proposals that need a named confirmation (§7).

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
- **`profile`:** `expected_interval_ms` 2000, `live_max_age_ms` null, `stale_after_ms` 6000, `unavailable_after_ms` 30000, `clock_tolerance_ms` 1000. **In this slice `unavailable_after_ms` is always a positive integer and is never null**, so every value has a withdrawal threshold and no number can be displayed indefinitely. AD-4 §7 still permits null for sources that are never withdrawn (a daily reference rate, for example); that is an **AD-4-level allowance this slice does not use, and AD-4 is unchanged**. Express refuses to serve a stream whose profile would carry a null `unavailable_after_ms`.

**Versioning:** a minor version adds optional fields or message types; a major version changes meaning and the path (`/api/rt/v2`). A client ignores an unknown type. On an unknown major version it shows Unavailable and stops. The client checks every message against §3.3.3 before using it.

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
- **Hidden tabs and resumption:** §3.3.1. A hidden tab closes its stream, so a background tab holds no slot.
- **Routing is unaffected throughout** (AD6-Q2).

| Client sees | Client does **[P-2]** |
|---|---|
| 401 | **Stopped** (§3.3.2). The existing sign-in handling runs; the client never reconnects by itself |
| 403, 404, other 4xx | **Stopped** (§3.3.2); shows "Observations unavailable" |
| 429 | Shows "too many streams"; waits the larger of the §3.3.2 `Retry-After` and the backoff, then retries |
| 5xx, network error, normal stream end | Reconnects with the backoff below. `Retry-After` on 503 is honoured, at most 30 s. An Nginx 502 or 504 without an envelope is keyed by status. |
| No response headers within 2 s; no bytes for 35 s; a `stream_seq` gap; a malformed message; a first message that is not `snapshot` | Aborts and reconnects. Three malformed, gap or first-message faults without 60 s of valid streaming between them stop it with an error. |

**Backoff:** 1 s, then 2 s (the maximum), each multiplied by a random 0.5–1; reset after a valid snapshot. This lowers v0.1's 4 s maximum, because 4 s after a hung 2 s attempt would exceed the 5 s target. The target excludes stopped states, 429, server-requested waits and the §3.3.1 states.

#### 3.3.1 Hidden tabs and resumption [B1]

**The stream is aborted the moment the page stops being watched — no grace period** (v0.3's 30 s timer is withdrawn, per Dev C). A hidden, hiding or unmounted panel holds no connection and therefore no backend slot (§3.5), and no frozen timer is ever trusted. Returning to visible always starts a new connection, so every resumption begins with a fresh `snapshot`.

| Event | Client does |
|---|---|
| `visibilitychange` to `hidden` | Aborts the stream at once, releases the slot, cancels any pending reconnect and any `Retry-After` wait, and shows "paused" |
| Panel unmount, sign-out, or the flags turning the panel off (§3.3.4) | Aborts at once and removes every listener. Nothing reconnects. |
| `pagehide`, `freeze`, `beforeunload` | Aborts at once, as for `hidden` |
| `visibilitychange` to `visible` | Drops all displayed values, resets backoff and fault counters, and **requests** a connection — **unless** the state is permanent (§3.3.2). Values reappear only from the new `snapshot`. |
| `pageshow` with `persisted: true` (restored from the back/forward cache) | A fresh start: any stream handle from before the restore is discarded unread, displayed state is dropped, and it **requests** a connection if visible |
| `offline` | Aborts, cancels the pending reconnect, shows "offline"; nothing is attempted while offline |
| `online` | **Requests** a connection if visible and the state is recoverable (§3.3.2). It never restarts a permanent state. |

**One connection, one snapshot.** Every row above, and **Retry now**, *requests* a connection; none opens one directly. A restore fires `pageshow` and `visibilitychange` together, and `online` can arrive in the same tick, so without this rule a resumption would open two or three streams, take two or three of the three per-user slots (§3.5), and render two snapshots.

- A single connection request is **idempotent**: it is a no-op while a stream is open, while an attempt is in flight, or while a reconnect or `Retry-After` wait is pending. It neither opens a second stream nor cancels and restarts the first.
- The panel holds **at most one** stream handle and one abort controller, and it increments a generation counter on every abort. Any bytes, snapshot, error or 401 whose generation is not current is dropped unread (§3.3.4), so a superseded attempt can never render a value or change state.
- **Exactly one fresh `snapshot` per resumption.** Returning to visible, a `pageshow` restore, `online`, **Retry now**, and any combination of them arriving together, each produce one connection attempt and therefore one `snapshot`. Displayed values are dropped once, at the request, not once per event.
- Where a reconnect is already pending, a request leaves its timer alone, except **Retry now**, which cancels the wait and connects once (§3.3.2).
- Abort is idempotent too: a second abort on an already-aborted stream does nothing, and an abort while connecting discards whatever that attempt returns (§3.3.4).
- **While paused,** nothing is received, so displayed ages keep advancing and pass stale and then unavailable at the §3.3.3 boundaries. A paused tab can never show a frozen number as current, and the panel says it is paused.
- The client listens on `document` and `window` only, adds every listener when the panel mounts, and removes every one when it unmounts.

#### 3.3.2 Stopped state and `Retry-After` [B2]

Two kinds of "not streaming", and they behave differently. The panel always names which one it is in.

| | **Recoverable disconnect** | **Permanent stopped state** |
|---|---|---|
| Caused by | A network error, a dropped or normally ended stream, 5xx, 429, a single protocol fault, `offline`, or a `hidden`/unmount abort (§3.3.1) | 401 or any authentication failure; 403, 404 and any other 4xx that is not 429; an unknown major `protocol_version`; three protocol faults without 60 s of valid streaming between them (§3.3.3) |
| Auto-reconnect | Yes: the backoff below, or the `Retry-After` wait, whichever is longer | **Never, under any trigger.** No timer, no backoff, no `online`, no `visibilitychange` to visible |
| Left by | Its own timer, `visibilitychange` to visible, `online`, or **Retry now** | **Retry now** only — and a 401 additionally needs the sign-in handling to restore a session first |

- **An authentication or protocol failure never auto-reconnects.** A 401 means the session is gone and retrying would hammer the endpoint with a dead token; an unknown version or repeated protocol faults mean the client cannot read what the server sends, so retrying cannot help. Both wait for a person.
- A 401 also hands the session over: `openObservationStream` calls the same `expire` handler the API client uses (§3.3.4), subject to the superseded-session rule there.
- **Retry now** is shown in every state of both kinds. It resets the backoff, the fault counter and any `Retry-After` wait, then connects once. It is disabled while an attempt is in flight, and it does not exist in preview mode (§3.3.4). After a 401 it does not re-authenticate; the sign-in handling owns that.

**`Retry-After` is advisory and bounded.** It is read on 429 and 503 only, from the stream request's own response.

| Header value | Client uses |
|---|---|
| Absent, empty, or not parseable | 5 s |
| `0`, a negative number, or a date at or before now | 1 s (the floor) |
| A positive number of seconds | That value, clamped to 1–30 s |
| An HTTP-date (RFC 9110) | The date minus the response's `Date` header, or minus the local clock when `Date` is absent or unparseable, then clamped to 1–30 s |
| Above 30 s, or not finite | 30 s (the ceiling) |

The client waits the larger of this value and its own backoff, never more than 30 s, and the wait is cancelled by **Retry now**, `pagehide` and `offline`. The server sends only `Retry-After: 5` and `Retry-After: 1` (§3.2); the table covers what a proxy or a later server version may send.

#### 3.3.3 Client-side message validation [B3]

The client trusts nothing it is sent. A failure here is a **protocol fault**: the stream is aborted and reconnected, and three faults without 60 s of valid streaming between them become a permanent stopped state (§3.3.2).

**Wire parsing.** `fetch` delivers bytes, not events, so the client runs its own SSE parser over the body:

- **Across chunks.** A chunk boundary may fall anywhere, including inside a UTF-8 character, a field name or a JSON string. Bytes are decoded with a streaming UTF-8 decoder and appended to one buffer; a message is handled only when a blank line completes it. A partial event left in the buffer when the stream ends is discarded, never parsed.
- **Line endings.** `\r\n`, `\n` and a lone `\r` all end a line; a blank line in any of those forms ends the event. A trailing `\r` is never left on a field value.
- **Fields.** Only `event:` and `data:` are used. One optional space after the colon is stripped. Several `data:` lines in one event are joined with `\n` before parsing, and a field name the client does not use (`id:`, `retry:`, anything else) is ignored. No SSE `id:` is sent and `Last-Event-ID` is never set (§3.2), so no replay is implied.
- **Comments.** A line beginning `:` is a comment: ignored, not a fault, and it does not end or start an event. It never counts as a message, so it does not advance `stream_seq` checks. It does count as traffic for the no-bytes timeout, which is what lets a proxy keep-alive comment hold a quiet connection open.
- **64 KiB limits.** One event's accumulated `data` is capped at 64 KiB (§3.2) and the whole unterminated buffer at 64 KiB. Exceeding either is a protocol fault: the buffer is dropped and the stream aborted, so a server or proxy that never sends a blank line cannot grow memory without bound.

**`profile` validation.** The `snapshot`'s `profile` is checked before any value is displayed. Each of `expected_interval_ms`, `stale_after_ms`, `clock_tolerance_ms` **and `unavailable_after_ms`** must be a finite integer above 0. **A null `unavailable_after_ms` is a protocol fault in this slice** (§3.2): without it an age could pass every threshold and still be shown, so the client would have no point at which it must withdraw a number. `live_max_age_ms` may be null, and remains null throughout the slice, because no synthetic value is ever Live (§3.3). Where set, the values must satisfy AD-4 §7's ordering, `live_max_age_ms` ≤ `stale_after_ms` ≤ `unavailable_after_ms`. A missing, malformed, out-of-order or null-thresholded `profile` is a protocol fault, and the client **never** substitutes §3.2's numbers for one: displaying ages against guessed thresholds would mislabel freshness. This is a slice restriction applied in the client and the server, not a change to AD-4's schema or to AD-4 §7. A later connection's `profile` replaces the previous one wholesale.

**Protocol faults:** a response whose `Content-Type` does not start with `text/event-stream` (an HTML error page or a proxy notice, even with status 200); a `data:` line that is not one JSON object; a missing or wrongly typed `protocol_version`, `type`, `stream_seq`, `server_time` or `source`; a `type` that does not match the SSE event name; a `stream_seq` that is not an integer, not 1 on the first message, or not exactly one more than the last; a first message that is not `snapshot`; a second `snapshot` on one connection; `values` that is not exactly the four §3.4 pairs in order; an `update` whose pair is outside the allowlist.

**Not a fault:** an unknown `type` or an unknown extra field. The message is ignored, but its `stream_seq` still counts, so the sequence check keeps working.

**Stops the client, no reconnect:** a `protocol_version` whose major part is not `1` (AD-4 §9: an unknown major version shows Unavailable).

**Per-value checks.** A value is shown only if its envelope reads `usage: display_only`, `provenance_class: synthetic`, `transport: synthetic`, a `source_id` beginning `synthetic.`, `validation.status: validated`, and an `fx_rate` payload whose currencies are the value's own pair. Anything else — including an unknown value in those four fields — makes that one value **Unavailable** with no number, counted and logged, and leaves the rest of the message usable. This is AD-4 §8 rule 1 applied in the browser, and it is why a non-synthetic or quarantined event can never appear as a number in the slice. The client never re-derives a rate, and never computes or checks `payload_sha256`: Express owns that (§3.4).

**Provenance labels.** Every shown value is **Simulated**, from `provenance_class: synthetic`, with "· stale" appended when stale (AD-4 §8.1, AD4-Q3). **Live**, **Delayed** and **Manually entered** cannot occur in this slice, and the client has no code path that produces them; if the four fields ever say otherwise, the value is Unavailable rather than relabelled.

**Freshness boundaries.** The client uses the `profile` of the current connection's `snapshot` and recomputes from the advancing age: age ≤ `stale_after_ms` is fresh; above it, stale; above `unavailable_after_ms`, unavailable with no number. The boundary value itself takes the lower state, so exactly 6.000 s is fresh and exactly 30.000 s is stale (§3.3). A negative age counts as 0. Between messages a value may only degrade: fresh to stale to unavailable, never back, because only a new `update` or `snapshot` can improve it. A `freshness` field that disagrees with the recomputed state is a protocol fault, so Express and the browser cannot drift apart silently.

#### 3.3.4 Client integration: session and flags [B4, B5]

**Session access is additive [B4].** `createApiClient`, `ApiClient` and every existing call site stay **unchanged**: the client buffers whole responses and accepts only `/api/v1` paths, so it cannot carry a stream. Instead `AuthContextValue` gains one member, implemented in `AuthProvider` beside the existing client:

- `openObservationStream(signal: AbortSignal): Promise<Response>` — issues the §3.2 request with the session's bearer token in the `Authorization` header, and calls the same `expire` handler the API client uses when it answers 401.

The token stays inside the auth module: it is not returned, and no component or hook reads it, so the existing rule that the token never reaches a URL, a log or another origin is unchanged. Rejected alternative: exposing `getToken` on the context, which would widen the token's surface to every component for no gain. The observation panel calls `useAuth()` for this one function and never constructs a client, and `createApiClient` keeps its current signature and behaviour.

**A late response from a superseded session is discarded.** A stream request can answer long after it stopped mattering — after sign-out, after a 401 that already ended the session, or after a new sign-in. `AuthProvider` therefore stamps each attempt with the session identity it was issued for, and:

- a 401 whose attempt belongs to a superseded session is **dropped**: `expire` is not called, so a stale answer can never sign out the session that replaced it;
- any other late response for a superseded attempt is also dropped unread, and its body is not parsed;
- sign-out and sign-in abort every in-flight attempt, so the window stays small;
- only one attempt may be in flight per panel, and an abort (§3.3.1) discards whatever that attempt returns.

This keeps the behaviour the API client already relies on — a 401 ends only the session that made the request — without altering it.

**Both flags are required [B5].** The panel mounts, listeners are added and the stream is opened only when **all** of these hold:

1. `useDataMode() === "live"` — the existing `VITE_API_MODE` mode (`dataMode.ts`, unchanged, including its default of live);
2. the new build flag `VITE_OBSERVATIONS === "on"`, read once at start-up like the data mode, defaulting to off for any other value or none;
3. the session is signed in.

**Preview mode is unchanged.** In `VITE_API_MODE=preview` the panel is absent whatever `VITE_OBSERVATIONS` says, nothing is requested, no listener is added, and no "Retry now" exists. There is no preview or illustrative observation data: an observation is either received and labelled Simulated, or not shown. `dataModeFromEnv` and the preview screens are not touched.

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
- **Off by default.** Without `OBSERVATIONS_URL`, Express neither polls nor registers the route. The panel needs both `VITE_OBSERVATIONS=on` and live API mode (§3.3.4). The overlay sets both of its variables; `VITE_API_MODE` keeps its existing default.
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
| **Fault injection** | A controllable fake ingestion server, test-only and absent from runtime images. Events: duplicate, late, tie, ID conflict, future (at and beyond 1 s), malformed, wrong hash, quarantined, non-synthetic, extra pair. Responses: duplicate pair, oversized, empty, slow, 401, 429 with and without `Retry-After`, 5xx, redirect. Source: outage, recovery, restart, clock moved back. Streams: slow and abandoned clients, caps, sign-out, shutdown. Client: hide, unmount and sign-out aborts, `pageshow` restore, `offline` and `online`, manual retry from every recoverable and permanent state, each §3.3.2 trigger that must **not** auto-reconnect, every `Retry-After` row, a `text/html` 200 body, chunk splits mid-character, mid-JSON and mid-field, `\r\n`, `\n` and lone `\r`, comment lines, an event and a buffer past 64 KiB, a missing, malformed, out-of-order and null-`unavailable_after_ms` `profile`, a restore that fires `pageshow`, `visibilitychange` and `online` in one tick, a connection request during an open stream and during a pending wait, sequence gap and repeat, unknown type, unknown major version, a non-synthetic or quarantined value, a `freshness` that disagrees, and a 401 arriving for a superseded session. Threshold and timer tests use fake clocks. |
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

1. **Inference outbound-network isolation: exception granted, requirement UNRESOLVED.** AD-6 B-4 also says inference has no route to the internet. The Phase 2 stack does not enforce that, and this slice delivers only the ingestion side of B-4. The project owner granted option (a): **an exception for the D-24 slice only.** It is **recorded** as D-25 in `docs/PHASE3_SCOPE.md` §2.2 and §2.2.3 (v1.4, 25 November 2026).

   What the exception does **not** do:

   - It does not satisfy B-4, which stays **unresolved** and is closed by **AD-10**, whose exposure plan must state how inference egress is controlled. The overlay does not isolate inference, and `--profile full` is unchanged.
   - It does not extend past the slice: milestones 3.2 to 3.7 and any later component get no exception, and §4's placement is still unconfirmed.
   - It is **not Gate 4 evidence and no gate has passed** (D-6, D-18). Nothing here is reachable outside the private development environment (D-16).
   - **T-5 is limited to the ingestion side** for this slice: ingestion has no route to inference, PostgreSQL or the internet, and holds no credential. The inference side of T-5 is not run and not claimed, so AD-6 must not be described as fully enforced.
2. Express is on both networks, so it is the single point that keeps them apart.
3. The existing web API client cannot carry the stream: it buffers whole responses and accepts only `/api/v1` paths. **`createApiClient` and `ApiClient` are not changed.** The stream is opened by the additive `openObservationStream` member on `AuthContextValue` (§3.3.4), which is the only new path allowed to send the token and the only place the `/api/rt/v1` path appears. The web Dockerfile needs one build argument, off by default.
4. Browsers allow about 6 HTTP/1.1 connections per origin, so several dashboard tabs compete with ordinary requests. The cap of 3 per user limits this.

## 6. Acceptance

1. The same seed, sequence and injected clock give identical events; payloads and hashes do not depend on the clock. Every event passes the AD-4 schema.
2. The panel updates with no user action; the §3 targets are met over 5 minutes; every available value shows label, source and age.
3. Every §3.7 fault gives the specified result, and states change exactly at the thresholds.
4. §3.5 limits, cleanup and shutdown hold; a shutdown with open streams exits 0. Repeated connects leave no slot, timer or listener behind.
5. AD-6 T-1 to T-4, T-6 to T-8 and T-10 pass; T-5 passes for ingestion (no route to inference, PostgreSQL or the internet; the host gateway per §3.6; no credentials). The inference side of T-5 waits on §5 item 1. T-9 does not apply, because no context is recorded.
6. With the feature off, the Phase 1 and 2 suites, the fixtures and the existing Compose and stack-security checks pass unmodified.
7. The §3.6 Nginx checks pass through the published port.
8. §3.3.1 to §3.3.3 hold in the browser: hiding or unmounting the panel aborts the stream and releases its slot at once, with no grace period; returning to visible, a `pageshow` restore, `online` and **Retry now** each produce exactly one fresh `snapshot`, and so does any combination of them in one tick — a restore holds one slot, never two or three, and renders one snapshot; a connection request during an open stream, an in-flight attempt or a pending wait opens nothing; no trigger reconnects a permanent stopped state; the parser survives chunk splits mid-character and mid-JSON, all three line endings, comment lines and both 64 KiB caps; a malformed, out-of-order or null-`unavailable_after_ms` `profile` is a fault and no default is substituted, and a value's number is withdrawn once its age passes `unavailable_after_ms`; a late 401 from a superseded session does not sign the current one out; no value is ever labelled anything but Simulated, with or without "· stale".
9. §3.3.4: the panel is absent in preview mode and with the flag unset or any value but `on`, and in both cases no observation request is made; `createApiClient` and its tests are unmodified.

## 7. Confirmations and approval

All verdicts below were given on **v0.5**, 25 November 2026.

- [x] **Dev A — TECHNICAL APPROVAL, on v0.5:** the §3.1 ingestion contract (P-1), the four FX pairs AED/MXN, EUR/USD, GBP/PHP, USD/INR (P-3), the §3.4 ordering and quarantine rules (P-4), the shared cross-language hash fixtures `contracts/test-vectors/event_payload_hash.v1.json` with the no-dependency validator and canonicalizer (P-9), and the generator (§3, AD-12). This is technical review, not the owner approval.
- [x] **Dev B — APPROVE, on v0.5:** P-1 polling; §3.2 errors and authentication; P-4; P-5 lifecycle hook, limits and backpressure; P-9 no-dependency validator. Its conditions stand, and the approval now covers v0.4's and v0.5's changes, including §3.7's client faults. The §7 reference correction below was raised on v0.3 and applied in v0.4.
- [x] **Dev C (Varshini) — APPROVE, on v0.5:** **B1 to B4 are confirmed closed** by §3.3.1 (abort at once, no grace, fresh snapshot on visible), §3.3.2 (recoverable versus permanent; no auto-reconnect after an authentication or protocol failure), §3.3.3 (wire parsing across chunks, CRLF, comments, both 64 KiB caps, `profile` validation) and §3.3.4 with §5 item 3 (the additive session method; `createApiClient` untouched). **B5 stays resolved.** The two v0.4 items raised by this reviewer are applied in v0.5 — a mandatory positive `unavailable_after_ms` for the slice (§3.2, §3.3.3, AD-4 untouched) and the single-connection rule with exactly one snapshot per resumption (§3.3.1), with tests in §3.7 and §6 item 8. The earlier **REQUEST CHANGES** on v0.3 is **withdrawn**, and the conditional limitations on §3.2, §3.3 and §5 item 4 are **lifted**.
- [x] **Dev D (lead) — ADOPT + APPROVE, on v0.5:** P-6 isolation; P-7 Nginx; P-8 schema location and check (also AD4-Q5); P-10 workflow. Its conditions stand, and the approval now covers §3.7's client faults as extended in v0.4 and v0.5.
- [x] **Project owner — APPROVED v0.5 for the D-24 slice, 25 November 2026.** §5 item 1 is decided and recorded as D-25 (`docs/PHASE3_SCOPE.md` §2.2, §2.2.3). AD-4 v0.2 and AD-6 v0.2 are approved for D-24 on the same date. **Not approved:** §4's placement of later components, and therefore no milestone 3.2–3.7 start. **No gate has passed.**

**Dev B's §7 reference correction, as applied:** this section's Dev B entry said that "§5 item 1 was referred to the owner". The owner has since decided it (§5 item 1, now D-25), so the sentence was stale and was removed; §5 item 1 is no longer an open Dev B condition, and §6 item 5 remains the place where T-5's ingestion-only limit is stated. **If this is not the reference Dev B meant, the correction is unapplied and Dev B should restate it** — it was relayed, not quoted, and nothing else in this document was changed on account of it.

**Still open after this approval:** AD-6 **B-4** (inference outbound-network isolation), which D-25 does not satisfy and which **AD-10** closes; §4's placement; every gate.

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
| Inference outbound-network isolation | §5 item 1: exception granted for D-24 only, recorded as D-25; B-4 unresolved, for AD-10 |
| B1 hidden tabs and resumption | §3.3.1; v0.4: abort at once, no grace period |
| B2 stopped-state retry and `Retry-After` | §3.3.2; v0.4: recoverable versus permanent, no auto-reconnect on authentication or protocol failure |
| B3 message validation, labels, freshness, sequence, version, content type | §3.3.3; v0.4: wire parsing, comments, 64 KiB caps, `profile` validation |
| B4 additive `AuthContext` access | §3.3.4 and §5 item 3; v0.4: superseded-session 401 safeguard |
| B5 live mode and `VITE_OBSERVATIONS=on` | §3.3.4, §3.6 — **resolved**, untouched in v0.4 |
| Dev B's §7 reference correction | §7, with the caveat recorded there |
| Varshini: `unavailable_after_ms` positive, never null, for D-24 only | §3.2, §3.3.3; AD-4 unchanged |
| Varshini: no duplicate connection from `pageshow` and `visibilitychange` | §3.3.1 single-connection rule; §6 item 8, §3.7 |

**AD-4 and AD-6:** as relayed by the project owner, Dev B, C and D approved AD-4, and Dev B and C approved AD-6, in the D-24 review. The **project owner approved AD-4 v0.2 and AD-6 v0.2 for the D-24 slice on 25 November 2026**, so D-24's three document preconditions (this component view, AD-4, AD-6) are now met. Neither approval settles the AD-6 **B-4** gap (§5 item 1, D-25), which stays unresolved and belongs to AD-10.
