# AD-7: Real-Time Channel Contract

**Status:** **DRAFT v0.4 for review. Not approved.** 26 November 2026. **Review state:** on PR #34, v0.3 (`97e4c9b`) was **APPROVED as draft documentation by Nisarga (Dev D)** and received **CHANGES_REQUESTED from Varshini (Dev C) on F1-a only** (F2 resolved). v0.4 applies F1-a and the non-blocking follow-ups of both reviews; **neither reviewer has re-reviewed v0.4**, and no owner approval exists. AD7-D7 must still be resolved before final architecture approval.

**Three different approvals, kept apart (Varshini, non-blocking 8):** (1) **draft-document approval** — a reviewer approving this file for merging as DRAFT documentation; it decides nothing and authorizes nothing; (2) **final architecture approval** — the project owner approving AD7-D1 to AD7-D8, which needs AD7-D7 resolved first; (3) **implementation authorization** — a milestone (3.2 for sessions, 3.5 for §5 and §8) authorized by the owner under D-22. Neither (1) nor (2) implies (3), and none passes a gate. New numbers are **provisional** (`[#?]`). Nothing here is implemented beyond what §2 marks as existing; no milestone or gate is authorized, and **no contract change is made or authorized**.
**Lead:** Dev B. **Reviewers:** Dev C, Dev D. **Approver:** project owner.
**Inputs:** F-3; AD-4 v0.2 (approved for the D-24 slice only); AD-10 (**draft v0.2**, PR #33, **merged into `feature/phase3-platform` at `1f6ea8f`**; merged is not approved). **Feeds:** milestone 3.5.

**Revision v0.2, 26 November 2026 — still DRAFT.** Documentation only. Applied:

| From | Finding | Where applied |
|---|---|---|
| Varshini **B1** (blocking) | `route_status` lifecycle and module boundary: `accepted` cited a record ID before it exists; correlation, producer and consumer modules, AD-1 import rules, AD-6 B-3, B-8 and T-17, feature flags, dashboard-only stream registration | **§5**, **§5.1**, **§5.2**, AD7-D3, **AD7-D8** |
| Varshini **B2** (blocking) | Context-claims endpoint: owning module, ownership checks, CSRF and Origin, rate limits | **§8**, **§8.1** |
| Varshini **B3** (blocking) | Stream-opener authentication: the "only the credential changes" claim is inaccurate; frontend changes; contract and OpenAPI path; bearer-only v0.4 unchanged until the approved milestone | **§4** |
| Varshini, non-blocking 1–7 | 401 versus role change; per-send checks versus AD-10's model; `stream_seq` at write; overflow when all pending are terminal; recovery through v0.4 `GET`; milestone reference; AD-8 capacity and T6 limits | §4, §5, §7, §9 |
| Nisarga (before final approval) | AD7-D7 and the four-pair contract; context-claims protection aligned with AD-10; stream capacity reconciled through AD-2 and AD-8 | AD7-D7 (kept open), §8.1, AD7-D6, §9 |

**Revision v0.3, 26 November 2026 — still DRAFT.** Documentation only. Applied from the re-reviews of v0.2 (`60b6faa`; the PR head `d685fad` has the same AD-7 text):

| From | Finding | Where applied |
|---|---|---|
| Varshini **F1** (blocking) | Producer mechanism unspecified: a `finish` hook cannot see the body; handler-set values would touch T-7-protected routes | **§5.2** producer row and **§5.3** |
| Varshini **F2** (blocking) | `request_id` is ambiguous: contract v0.4's `requestId` is the echoed `X-Request-Id`, not the persisted record ID | §7, **§8**, **§8.1** (`record_id`; `X-Request-Id` never used for ownership; `createdById` check) |
| Nisarga; Varshini 1 | AD-8 reference in §9 from v0.4 to v0.5; pin dependency commits | §9 |
| Varshini 2 | AD-7 evidence in AD-13 §2.9's map | **§11** (proposed rows; AD-13 is not edited here) |
| Varshini 3 | User-visible benefit of option (a), or reconsider (c) | §5.1 |
| Varshini 4 | Database uniqueness for one claim per record | §8; AD-11 P-6 (PR #35) |
| Varshini 5 | `createdById` is the column, `createdBy` the relation | §8.1 |
| Varshini 6 | Comparison failures persist nothing, so emit no `failed` | §5.1 |
| Varshini 7 | Migration table wording; the `client.ts:225` 401 path | §4 |
| Varshini 8 | Draft approval, final architecture approval and implementation authorization | Status |
| Varshini 9 | "Session" before milestone 3.2 | §4 |

**Revision v0.4, 26 November 2026 — still DRAFT.** Documentation only. Applied from the re-reviews of v0.3 at `97e4c9b`:

| From | Finding | Where applied |
|---|---|---|
| Varshini **F1-a** (blocking) | Capture order: a second, failing `res.json` call could overwrite the captured body and status, publishing `failed` for a response the client never received. Snapshot the status at call time; record only after the original returns; first successful response only; a failed later write cannot overwrite; double-write and serialization-error evidence | **§5.3** steps 1, 2 and 5 |
| Varshini, non-blocking | Placement after authentication, user read safely in `finish`; primitive fields only at capture; `this` binding and return value preserved; bounded port queue; client-abort and `res.destroy()` evidence; D-24 suite with the switch off; pin Express 5.3.0 | §5.3 |
| Nisarga; Varshini | AD-10 reference updated to its merged state | Inputs line; §9 |
| Nisarga; Varshini | P-6 uniqueness and `record_id` naming aligned with AD-11; state that AD-11 P-6 must adopt the constraint; pin the AD-11 revision | §8 "Bounds" | **Coordinates with:** AD-2 (replay vs snapshot), AD-8 (budgets), AD-9 (degradation), AD-11 (context records).
**Scope source:** `docs/PHASE3_SCOPE.md` v1.4 §3 Workstream D, §7.3 (AD-7 row), §9.2; `docs/PHASE3_AD6_ENGINE_BOUNDARY.md` §1, §4, §6.1, §9.1.

The channel is an extension **alongside** API contract v0.4, which it does not modify (scope §7.3). AD-1 v0.5 §3.2 to §3.6 is the approved D-24 slice contract; this document **cites** it and does not restate it.

## 1. Directions applied (relayed)

Relayed 26 November 2026; no approval document exists in the repository. The owner approved proceeding with AD-7 work; Dev C (Varshini) supports SSE, session isolation and separate untrusted context records. These are directions, not approval of this document.

## 2. Implemented (D-24) versus required (milestone 3.5)

| Topic | Implemented and accepted for D-24 | Required here for 3.5 |
|---|---|---|
| Transport | Fetch-based SSE, `GET /api/rt/v1/observations/stream` (AD-1 §3.2; `services/backend/src/observations/route.ts`) | **Retained** (§3) |
| Framing | `event:` + one `data:` JSON line; payload ≤ 65,536 UTF-8 bytes, client buffer ≤ 131,072 bytes (AD-1 §3.3.3, C-2) | **Preserved unchanged** |
| Messages | `snapshot`, `update`, `heartbeat` (AD-1 §3.2) | Preserved; `route_status` and `session_ended` added (§5, §6) |
| Freshness | Express-owned; stale at age **> 6 s**, unavailable at **> 30 s**; exactly 6.000 s fresh, exactly 30.000 s stale; browser advances by monotonic time (AD-1 §3.3, §3.3.3) | **Preserved**; per-source profiles from AD-8 when approved |
| Reconnect | Backoff 1 s then 2 s, jitter 0.5–1; one connection, one snapshot per resumption; hidden tab aborts at once (AD-1 §3.3, §3.3.1) | **Preserved** |
| Authentication failure | 401 → permanent stop, no auto-reconnect, sign-in handling runs; superseded-session 401 dropped (AD-1 §3.3.2, §3.3.4) | **Preserved in behaviour**; the credential and the mechanism behind the 401 handling change only if the cookie proposal is approved (§4) |
| Limits | 3 per user, 20 total; 429 `STREAM_LIMIT` `Retry-After: 5`; 503 `SHUTTING_DOWN` `Retry-After: 1` (AD-1 §3.2, §3.5) | Kept until AD-8. AD-2's 60 streams **exceed** AD-8 v0.5 §6.3, which under AD-8 §6.2.1 means AD-8 revised, re-approved and re-measured before milestone 3.4 (AD-2 §5.1) |
| Backpressure | One pending `update` per pair and one heartbeat, newest wins; no drain in 10 s destroys the stream (AD-1 §3.5) | Generalized per subject (§7) |
| Replay | None; no `id:`, `Last-Event-ID` ignored | **Still none for browsers** (AD-2 R-10) |
| Context recording | None (AD-1 §3.7: "Not recorded") | §8 |

## 3. Transport decision

**AD7-D1 (proposed): keep fetch-based SSE.**

| | SSE over fetch (retained) | WebSocket |
|---|---|---|
| Direction needed | Server to browser only; browser actions use the v0.4 API and §8's endpoint | Two-way, unused |
| Evidence | D-24 acceptance: Nginx streaming through the published port, real-SSE stack tests, browser suite (`docs/PHASE3_D24_ACCEPTANCE.md` §1, §2) | None in this repository |
| Authentication | Ordinary HTTP request: cookie, `Origin` and CSRF rules apply as to any GET (AD-10 §5.1) | Handshake needs its own origin check; no CSRF protection by default |
| Proxy | Works through the existing Nginx `/api/` block | Needs `Upgrade` handling not present in `services/web/nginx.conf.template` |

**Reconsider WebSocket only if a measured need arises**, recorded as an AD-7 revision:

1. a requirement for frequent browser-to-server messages on the same connection (more than about one per second per client `[#?]`);
2. measured HTTP/1.1 connection exhaustion with the per-user cap in place (AD-1 §5 item 4) that HTTP/2 at the edge cannot fix;
3. a proxy or network on the pilot path, chosen under AD-10, that buffers or breaks SSE in a way the AD-1 §3.6 checks detect;
4. AD-8 latency budgets missed because of SSE framing, measured.

## 4. Authentication on the channel (with AD-10)

- **Today, and unchanged until an approved migration (Varshini B3):** the approved API contract **v0.4 §3.0 is bearer-only** and states the frontend never uses cookies; AD-1 v0.5 §3.3.4 applies that to the stream. **This document does not change either.** The bearer-only v0.4 contract and the D-24 stream contract remain in force until the contract revision of AD-10 §4.5 is approved and milestone 3.2 implements it.
- **What the stream opener does today** (verified at `4424b45`, `services/web/src/auth/AuthProvider.tsx:153-180`): sends `Authorization: Bearer` when a token exists; `credentials: "omit"`; `redirect: "error"`; `cache: "no-store"`; drops the answer unread when the session epoch moved (the superseded-session rule); and calls `expire()` on a 401 **only if a token was present** (`if (response.status === 401 && token)`).
- **The API client has the same token-gated path** (`services/web/src/api/client.ts:225`): `if (response.status === 401 && token) options.onUnauthorized?.();`. Both 401 paths, the stream opener's and the API client's, therefore depend on a token being present, and **both** must be re-based in milestone 3.2 (non-blocking 7).
- **Correction.** v0.1 said `openObservationStream` "keeps its signature and its superseded-session rule; only its credential changes". **That was inaccurate.** Under cookie sessions there is no token, so the token-gated 401 rules would never end the session. The table compares today's behaviour with the proposal; the "today" column is the approved D-24 behaviour, and the right-hand column changes nothing until approved:

| Aspect | Today (approved) | Under the cookie proposal (milestone 3.2, if approved) |
|---|---|---|
| Credential | Bearer header from the in-memory token | No header; `credentials: "same-origin"` sends the `HttpOnly` session cookie |
| 401 handling | Stream: `expire()` only if a token was present (`AuthProvider.tsx`). API: `onUnauthorized` only if a token was present (`client.ts:225`) | **Both** re-based on the **session epoch**, so a cookie-session 401 still ends the session; on the stream it is still a permanent stop |
| Superseded session | Answer dropped when the epoch moved | Kept, keyed on the epoch; a late 401 from a superseded session still cannot sign out its replacement |
| Session expiry | The token ends only by sign-out or a 401 | Server-side idle and absolute timeouts, and revocation, close the stream; the reconnect gets 401 (AD-10 §4.3) |
| Unchanged | Signature; `redirect: "error"`; `cache: "no-store"`; no `Last-Event-ID`; hidden-tab abort; backoff | Same |

- **Frontend components affected** (all in milestone 3.2, with Dev C, and only after the contract revision): `services/web/src/auth/AuthProvider.tsx` (`openObservationStream`, sign-in, token store, `signOut`), `services/web/src/api/client.ts`, the MSW mock mode, and the observation controller's tests. AD-10 §4.5 lists them in full.
- **Contract and OpenAPI path:** AD-10 §4.5 (decision AD10-D16) — contract revision, `app.v1.yaml` updated in the same change (still DRAFT), AD-1 §3.3.4 and AD-9 §3.5 revised, then implementation. **Corrected milestone reference (non-blocking 6):** cookie sessions are a **milestone 3.2** dependency; this document's own features (§5, §8) are milestone 3.5 and depend on 3.2, not the reverse.
- **Origin:** AD-10 §5.1's safe-method rule, checked before a slot is taken.
- **"Session" before milestone 3.2 (non-blocking 9).** Until 3.2 there is **no server-side session**: "session" in this document means, on the client, the signed-in **session epoch** of `AuthProvider` (which the superseded-session rule keys on) and, on the server, the **authenticated development-token user** of the request. Development tokens are revoked only by a backend restart (AD-1 §3.5), so before 3.2 the per-send checks of §5 reduce to "the stream's user is the status's user", and AD-10's closure bounds do not yet apply. AD-10's server-side sessions exist only from milestone 3.2, if approved.
- **Session isolation:** a stream is bound to the session that opened it. It receives only its user's `route_status` messages (§5) and closes when that session ends (AD-10 §4.3).
- **Failure semantics are unchanged:** 401 is a permanent stop; 403 and other 4xx stop; 429 waits; 5xx and network errors reconnect (AD-1 §3.3 table, §3.3.2). **401 versus role change (non-blocking 1):** a 401 follows **revocation, expiry, logout or deactivation**. A **role change** closes the stream but leaves the session valid, so the reconnect **succeeds** with a new snapshot under the new role; it does not produce a 401 (AD-10 v0.2 §4.3 item 6).

## 5. Route-status messages

AD6-Q1 forbids routing triggered by events; AD-6 §4 allows "pushing the status of a routing request the user made".

| Rule | Requirement |
|---|---|
| Origin | Only a request the **same user** submitted through the v0.4 API (`POST /api/v1/transactions`, `POST /api/v1/comparisons`). Never created by an observation |
| Recipients | Only streams of the user who submitted it. Other users, including analysts, receive nothing |
| Content | `request_kind` (`transaction` or `comparison`), the **correlation key** of §5.1, `status` (§5.1), `at` (server time) and, when the record exists, its `id` as returned by v0.4 and, if failed, the v0.4 error `code`. **No** amounts, corridors, allocations, policies or engine fields; the client fetches the result through v0.4 |
| Not authoritative | The v0.4 response and record are authoritative. A missed `route_status` changes nothing; on reconnect the client does not replay it. **A dropped or missed status is recovered through the relevant v0.4 `GET`** — `GET /api/v1/transactions/:id` or `GET /api/v1/comparisons/:id` — **never through the observation snapshot**, which carries observations only and never contains a `route_status` (non-blocking 5) |
| Coalescing | Newest status per correlation key; a terminal status (`completed`, `failed`) is never replaced by a non-terminal one |
| `stream_seq` | **Assigned when the message is written to the socket**, not when it is queued, exactly as for `update` (AD-1 §3.5: ages and `stream_seq` are computed at write). A coalesced-away status consumes no sequence number, so the D-24 client's consecutive-sequence check holds (non-blocking 3) |
| Engine boundary | A `route_status` never enters an engine request, `decision_id`, `clientReference` or cache key (AD-6 §5) |
| Version | Intended as a **minor** version (`1.1`), but **not automatically compatible** with D-24 clients. Verified in `services/web/src/features/observations/validate.ts:147-200`: the D-24 client accepts any `1.x`, ignores an unknown `type` and still counts its `stream_seq`, **but only after** the common checks pass. Every message, including `route_status`, must therefore carry a valid `protocol_version`, `type`, consecutive `stream_seq`, AD-4 `server_time` and a well-formed `source`, or the D-24 client records a protocol fault (three faults stop it). Separately, a D-24 client **faults** on any `snapshot` that does not carry exactly the four slice pairs in order, so adding subjects to the snapshot is **not** a compatible change. Compatibility mechanism is open: AD7-D7 (§10) |
| Ongoing authorization | Checked **at every send**, not only when the stream opened, **against the stream's in-memory state**, aligned with AD-10 v0.2 §4.3 (non-blocking 2): (1) the stream's session has not been closed by an in-process revocation, logout, expiry or role-change event, and has passed its last heartbeat backstop re-validation (15 s `[#?]`); (2) the stream's user equals the user the status is addressed to, which the producer fixed from the submitting request (§5.1). **No database read per send.** The exposure bound is therefore AD-10's closure bound (≤ 5 s in-process, ≤ 15 s backstop), not zero. A message failing either check is dropped and counted; a failed session check also closes the stream |

### 5.1 Lifecycle and correlation (Varshini B1)

**What v0.1 got wrong.** It proposed an `accepted` status carrying "the record `id` as returned by v0.4". The v0.4 `POST`s are **synchronous**: the record `id` exists only once the record has been persisted, and the client learns it only from the `201` (or the error) that ends the request. A status that says "accepted, here is the record ID" **before** that response cannot exist, so the correlation and the lifecycle were not implementable.

**Options for correlation** (decision **AD7-D8**, open):

| Option | Correlation key | Statuses possible | Trade-off |
|---|---|---|---|
| (a) **Terminal only, by record `id`** | The v0.4 record `id` | `completed`, `failed` — emitted **after** the request's response is final | Implementable with no new identifier. Adds no information to the tab that made the request (it already has the response); its value is for the **user's other streams** (another tab or window). **User-visible benefit, stated plainly (non-blocking 3):** a dashboard open in a second tab or window shows that a transaction or comparison the same user just submitted elsewhere has completed or failed, without polling or a manual refresh. That is a **modest** benefit, and if the owner judges it insufficient, **(c) is the right outcome**; nothing else in this document depends on `route_status` |
| (b) **Pre-response, by `X-Request-Id`** | The `X-Request-Id` the client already may send (contract v0.4 §1: echoed in the response and in error bodies, and forwarded to inference) | `in_progress` then `completed` or `failed`, the terminal one also carrying the record `id` | Gives progress for a slow request. The key is client-chosen, so it is **untrusted**: it is unique only per user, is never used as a lookup outside that user's own streams, and needs a length and character bound `[#?]` |
| (c) No `route_status` | — | — | AD6-Q1 is satisfied trivially; AD-6 §4's permission is not used |

**Provisional preference: (a)**, because it needs no new identifier, cannot report a record before it exists, and keeps `route_status` strictly derivative of the v0.4 response. (b) is recorded because it is the only way to show progress; it would make `X-Request-Id` part of this channel's contract. **`accepted` is withdrawn in either case.** A request that persists no record has **no** record `id` and, under (a), produces **no** `route_status`; under (b) it produces `failed` with the v0.4 error `code` and no `id`.

**Meaning of each status (under (a)):** `completed` — the v0.4 request returned `201` and its record and audit row are persisted (contract §6.2, Q19 unchanged); this includes a regulatory rejection, which v0.4 records as `routed` with `feasibility.allowed = false`. `failed` — the request **persisted** a failed record and returned an error carrying its ID (contract §3.2: "inference failures are persisted … the `POST` returns the error with `transactionId` in `error.details`"); the status carries that ID and the error `code`. **An error that persists nothing** — `422`, `409 POLICY_DISABLED`, `401`, `403` — has no record and produces **no** `route_status`. **A failed comparison persists nothing** (contract §3.6: "a comparison is persisted **only** when `/v1/compare` returns 200 … on any error nothing is saved"), so under (a) **only a transaction can produce `failed`**; a comparison produces `completed` or nothing (non-blocking 6). Nothing else is a status.

### 5.2 Producer, consumer and the module boundary (Varshini B1)

**The constraints.** AD-1 v0.5 §2 forbids the observation module to "import, or be imported by, routing, mapper or inference-client code (`app.ts` and `server.ts` may compose both)" and to write to the database. AD-6 **B-3** makes that a CI-checked rule and draft AD-6 Part 2 **T-16** checks the transitive import graph. The backend `routes`, `mappers` and `inferenceClient` folders are **T-7-protected paths**, so editing a v0.4 route handler fails T-7. On the client, AD-6 **B-8** and draft AD-6 Part 2 **T-17** forbid any path from observation state into a form field, a request body, a result field or a routing selector.

**Proposal (provisional, AD7-D8):**

| Role | Module | Rule |
|---|---|---|
| **Producer** | A **response-observing middleware** registered in `app.ts` on `POST /api/v1/transactions` and `POST /api/v1/comparisons`, with the exact interception mechanism of **§5.3**. It publishes `{user, kind, record_id, status, code}` to a status port **only after the response is finalized** | It lives **outside** the T-7-protected `routes` folder, so no v0.4 handler changes, and it can never alter, delay or fail the response (§5.3). It imports neither the routing modules nor the observation module |
| **Port** | A small, neutral status-port module | Imports **neither** routing, mapper, inference-client nor observation code, so T-16's graph still contains no path between them. `app.ts` composes it, as AD-1 already allows |
| **Consumer** | The observation module's stream hub subscribes to the port and addresses each status to the submitting user's streams (§5 "Recipients") | It receives a plain value; it imports no routing code and writes nothing to the database |
| **Client** | A separate **routing-status store**, read only by a status indicator | **Never** the observation store, reducer or selector, and never a form, request body or result field (B-8, T-17). The D-24 panel's observation state is untouched |

The alternative — the v0.4 handlers calling the port directly — **would change T-7-protected code** and needs its own approved exception; it is not proposed.

**Feature flags and stream registration (Varshini B1).** `route_status` changes neither flag nor registration:

- The stream route exists only when the backend has `OBSERVATIONS_URL` (AD-1 §3.6 "Off by default"); without it there is no stream, so no `route_status`, and nothing else changes. The panel mounts and opens a stream only with live API mode, `VITE_OBSERVATIONS=on` and a signed-in session (AD-1 §3.3.4 [B5]).
- `route_status` is delivered **only on an already-open dashboard observation stream**. It **never** registers a stream, opens one, or causes a page without the panel to connect. A user with no open panel receives nothing, and loses nothing, because the v0.4 response is authoritative.
- A separate **server-side switch, off by default** `[#?]`, governs whether the producer publishes at all, so that turning the feature on is a deliberate, reversible act and the D-24 slice's behaviour is unchanged while it is off.

### 5.3 Producer interception mechanism (Varshini F1)

**The gap v0.2 left.** A `res.on("finish")` hook sees the status code but **not the body**, so it cannot learn the record `id` or the error's `transactionId`; and asking the v0.4 handlers to set those values for the middleware would change **T-7-protected** route code. The mechanism must therefore read the body without touching the handlers.

**Proposed mechanism (provisional, part of AD7-D8):**

1. **Capture, before the handler runs.** The middleware is mounted in `app.ts` ahead of the two `POST` routes and **after the authentication middleware**, so the authenticated user is already on `req` when it runs; it copies that user ID into its own closure at that point. It wraps **`res.json`** for that one response only. **Capture order (Varshini F1-a):**
   1. On each call, the wrapper first **snapshots `res.statusCode`** as it is at that moment.
   2. It then calls the original `res.json` with the **same arguments, unmodified**, with **`this` bound to `res`**, and keeps its **return value**.
   3. **Only if that call returns without throwing**, and **only if nothing has been captured yet**, it records the capture: the snapshotted status plus **primitive fields only** (§5.3 step 3) copied out of the argument — never a reference to the body object.
   4. It then returns the original's return value. If the original throws (for example a serialization error, or `ERR_HTTP_HEADERS_SENT` on a second write), the wrapper **rethrows the same error** and records nothing.

   So **only the first successful response is captured**, and a later write that fails can never overwrite it: in the review's example, a first `201` with `rec-D` followed by a failing `500` attempt publishes `completed` for `rec-D` and nothing for the second ID. Both handlers respond through `res.json` — `res.status(201).json(…)` for success (verified at `transactions.ts:305` and `comparisons.ts:112`), and the shared error envelope for errors, which `services/backend/src/middleware/errors.ts:58` sends with `res.status(…).json(…)` on the same response object — so no other send path needs wrapping; a response sent any other way is simply **not observed**, and produces no status.
2. **Publish only after the response is finalized.** Publication is scheduled from `res.on("finish")` — the response has been handed to the network — and **never** from inside the `res.json` wrapper. The `finish` handler reads **only** the capture and the user ID copied in step 1, never `req` or the body again; if there is no capture, it publishes nothing. A response that ends with `close` and no `finish` — a client abort, or `res.destroy()` — publishes nothing; the v0.4 record remains authoritative.
3. **Fields extracted, and nothing else:**

| Final status | Event | Fields read from the captured body | Plus |
|---|---|---|---|
| `201`, transaction or comparison | `completed` | `id` | `request_kind` from the route; the authenticated user from `req` |
| `≥ 400`, transaction, **with** `error.details.transactionId` | `failed` | `error.details.transactionId` as `record_id`; `error.code` | As above |
| Any other response | — | — | Nothing is published |

   No amount, corridor, allocation, policy, engine field, `clientReference` or `requestId` is read. **`requestId` (the echoed `X-Request-Id`) is never read or published**, so it cannot become a record identifier (§8.1).
4. **Isolation from the response.** The wrapper never modifies the body or headers and never throws: capture is wrapped so that any error in it is caught, counted and discarded, and the original `res.json` is still called exactly once. Publication runs **after** `finish`, asynchronously, inside its own `try`/`catch`, into a **bounded** port queue (at most 1,000 entries `[#?]`); a full queue drops the new entry, and a full queue, a missing subscriber or a subscriber's exception is **counted and dropped**. **No status-port or subscriber error can alter, delay or fail the HTTP response**, and none is logged with body content.
5. **Evidence:** with the port throwing, blocked or absent, the v0.4 responses, status codes, bodies, timings within noise, records, audit rows and `decision_id`s are **identical** to a run without the middleware (AD-6 T-1); T-7 shows no protected path changed; a `201` and a persisted-failure response each publish exactly one status, and a `422` or a failed comparison publishes none. **Also (F1-a and follow-ups):** a **double write** — a successful first `res.json` followed by a second call that fails with `ERR_HTTP_HEADERS_SENT` — publishes only the first response's status, whatever the second carried; a **serialization error** in `res.json` publishes nothing and the error propagates unchanged; a **client abort** and a **`res.destroy()`** each publish nothing; a full port queue drops and counts without affecting the response; and the **D-24 acceptance suite passes unchanged with the producer switch off** (§5.2).

Express response internals are an implementation detail. The mechanism is written against the backend's pinned **Express `5.3.0`** (`services/backend/package.json`); a change of Express version re-runs the step 5 evidence. If wrapping `res.json` proves unreliable on that version, the fallback is **(c)**, no `route_status` — **not** a change to the protected handlers.

`session_ended` (advisory, minor version): sent just before the server closes a stream for AD-10 §4.3 reasons, with a reason code. The client must still rely on the 401 that follows, not on this message.

## 6. Versioning

AD-1 §3.2's rule is kept: `protocol_version` `"1.x"`; a minor version adds optional fields or message types; a major version changes meaning and the path (`/api/rt/v2`); an unknown major version stops the client. Schemas live with the slice's in `contracts/events/` (AD-1 §3.7, P-8); a new message adds a schema and fixtures there in the implementing milestone, not here.

## 7. Backpressure (bounded)

- Per stream: at most one pending `update` per **subject**, one pending `route_status` per correlation key (the record `id` under §5.1 option (a)), one heartbeat; newest wins (AD-1 §3.5 generalized).
- A stream that has not drained for 10 s is destroyed (unchanged) and recovers by snapshot (AD-2 R-10).
- Per-stream pending state is bounded by the subject count of its snapshot plus at most 20 `[#?]` pending `route_status` entries. Beyond that: drop the **oldest non-terminal** entry; **if every pending entry is terminal**, drop the **oldest terminal** entry (non-blocking 4). Either drop is counted and is recoverable through the relevant v0.4 `GET` (§5). The bound never grows and never blocks the stream. Under §5.1 option (a) every entry is terminal, so the second rule is the normal one.
- Coalescing never touches the store; it is not loss of an accepted event (AD-2 R-12).

## 8. Browser-context claims

AD-6 §6.1 and AD6-Q3: displayed context is recorded separately; v0.4 requests are strict and cannot carry it; capture belongs to AD-7, storage to AD-11; a browser report is **a claim, not proof**.

**Capture (proposed):** after a v0.4 POST succeeds, the client sends one claim to a separate endpoint, `POST /api/rt/v1/context-claims` (name provisional), outside contract v0.4.

| Rule | Requirement |
|---|---|
| Closed schema | `request_kind` (`transaction` or `comparison`, which selects the P-1 table), `record_id` — the **persisted record `id`** returned by the v0.4 `201` — `captured_at` (client clock, informational only), and `items[]`: each `event_id` (or null), subject, display label, freshness state, displayed `age_ms`. Unknown fields → 422 |
| Bounds | ≤ 50 items; body ≤ 8 KiB `[#?]`; **one claim per record** (`request_kind`, `record_id`): a second is 409 and counted. Enforced by a **database uniqueness constraint** on (`request_kind`, `record_id`) in AD-11's P-6 family, not by an application check alone, so two concurrent claims cannot both be stored (non-blocking 4). **AD-11 P-6 must adopt this constraint**, and does: AD-11 v0.3 §3 P-6 (PR #35 at `eff34f5`, open, draft) states "at most one claim per record, enforced by a uniqueness constraint on (`request_kind`, `record_id`) — the persisted record `id`, never `X-Request-Id`", with the same field names as here |
| Allowlist | Only the fields above. **Never**: tokens, cookies, session IDs, form values, amounts, user text, URLs, rates or any payload |
| Authorization | The authenticated user must own the record named by `record_id` (§8.1); claim accepted only within 5 min `[#?]` of the record's `createdAt` |
| Trust | Stored as `trust_level: browser_claim`; the server adds `received_at` and user ID; it does not "correct" or enrich the claim from its own state |
| Never an engine input | Not read by any routing, mapper or inference-client module (AD-6 B-3); not in `decision_id`, `clientReference`, a cache key or engine logs |
| Failure | A failed or missing claim never blocks, delays or rolls back the routing record or its audit row (AD-6 §6.1); the UI shows nothing about it; a gap stays a gap |
| Rate | AD-10 **v0.2** §5.3's per-user limit for `/api/rt/v1` state-changing requests (30/min `[#?]`), plus the one-claim-per-request and 5-minute rules above. **Corrected:** v0.1 said AD-10 §5.3 already covered it; AD-10 v0.1 limited `/api/v1` only |
| Test | AD-6 **T-9**: with the claim recorded, absent or failing, engine requests, responses and `decision_id` are identical |

### 8.1 Owning module, ownership checks and protection (Varshini B2)

| Item | Proposal (provisional) |
|---|---|
| **Owning module** | A **separate context-claims module** in Express, mounted by `app.ts` under `/api/rt/v1/context-claims`. It is **neither** the observation module (which AD-1 forbids to write to the database and to import routing code) **nor** a v0.4 route (which is T-7-protected and outside this extension) |
| **Permitted dependencies** | The authentication and session middleware; a **read-only ownership lookup** on the P-1 record (`id`, `createdById`, `createdAt` only — `createdById` is the Prisma **column**; `createdBy` is the relation, and the v0.4 response field of the same name) through its own minimal query; the P-6 insert of AD-11 v0.2 (draft). It imports **no** routing, mapper, inference-client or observation module, so T-16's graph is unchanged |
| **Never** | Read by any routing, mapper or inference-client module (AD-6 B-3); written in the transaction of a P-1 record or its audit row (AD-6 §6.1; AD-11 §4) |
| **Check order** | (1) authentication — 401 before anything else, as contract v0.4 Q14 does for `/api/v1`; (2) **Origin** — AD-10 v0.2 §5.1's state-changing row: own origin only; absent or `null` refused; (3) **CSRF** — the required custom header of AD-10 v0.2 §5.1, which v0.2 extends to every state-changing request under `/api/`; (4) rate limit (§8 "Rate"); (5) body: closed schema, ≤ 8 KiB, ≤ 50 items, else 422; (6) **ownership**: `request_kind` selects `TransactionRequest` or `Comparison`; the row whose `id` = `record_id` is read; the **authenticated user's ID equals that row's `createdById`**, and the row is ≤ 5 min old `[#?]`; (7) one claim per record, else 409 (the P-6 uniqueness constraint) |
| **Identifier rule (Varshini F2)** | Ownership is decided **only** from the persisted record `id` and its `createdById`. **`X-Request-Id`, and contract v0.4's `requestId` that echoes it, are never used for ownership, lookup or deduplication:** they are client-supplied correlation strings, not record identifiers. v0.2's field name `request_id` invited exactly that confusion and is withdrawn |
| **Ownership versus visibility** | Contract v0.4 §3.1 lets **any** authenticated user read every record. Attaching a claim is stricter: **only the submitting user** may, because a claim asserts what *that user* saw. A non-owner gets **403**; an unknown `record_id` **404**. Codes and envelope follow v0.4's error shape; whether they are new codes is part of this endpoint's own contract, provisional `[#?]` |
| **Under bearer tokens** (until milestone 3.2) | Origin and the custom header still apply; `SameSite` does not, because no cookie exists. The endpoint is therefore **not** enabled before its protection set is complete — it depends on AD-10 v0.2 §5.1 and milestone 3.2 |
| **Evidence** | A cross-origin `POST` and a `POST` without the custom header are refused before the body is read; a non-owner's claim is 403 and writes nothing; a second claim is 409; the per-user limit returns 429; T-9 holds throughout |

## 9. Alignment

- **AD-2 (v0.2, PR #32, merged into `feature/phase3-platform` at `0af9156`; DRAFT, not an approved architecture):** consumer replay (R-9) is server-side only; browsers get snapshots (R-10). The channel never carries replayed history.
- **AD-9 (PR #29, merged into `feature/phase3-platform`, still draft):** the panel's degradation states (disconnected, paused, offline, stopped, too many streams) are AD-9 §3.3's; this document adds no state, and `route_status` loss is not a degradation state. AD-9 §3.5's authentication semantics change only as AD-10 v0.2 §4.5 states.
- **AD-10 (v0.2, PR #33, merged into `feature/phase3-platform` at `1f6ea8f`; DRAFT, not approved):** sessions, origin, CSRF, revocation, rate limits and the contract transition (§4, §8.1).
- **AD-8 (v0.5, PR #30, merged into `feature/phase3-platform`; DRAFT, not approved) — limits kept explicit:** (1) **T6 is not instrumented**. AD-8 §2.4 *proposes* using each `update`'s `server_time` as the correlated marker, but no such measurement exists and whether to build it is **AD8-Q9**; so no render-latency figure exists for this channel, and AD-8 N-1 and N-4(b) are blocked. (2) **Capacity:** AD-8 v0.5 §6.3 keeps 3 streams per user and 20 in total; AD-2's 60 exceeds it, and AD-8 §6.2.1 requires AD-8 to be revised, re-approved and its budgets re-measured before milestone 3.4 if 60 is adopted. `route_status` adds pending state per stream (§7) that AD-8's capacity test must include.

## 10. Decisions

| # | Decision | Alternatives | Recommendation | Depends on | Approver | Evidence |
|---|---|---|---|---|---|---|
| AD7-D1 | Transport | SSE (fetch); WebSocket; both | **SSE**, with §3 reconsideration criteria | — | Owner, Dev C, Dev D | D-24 evidence; §3 criteria recorded |
| AD7-D2 | Channel authentication | Bearer (today); session cookie | **Session cookie** from 3.2 | AD10-D3, AD10-D4 | Owner, Dev C | 401/403/origin tests on the stream |
| AD7-D3 | Route status | None; §5 | **§5**, minor 1.1, with §5.1's correlation and §5.2's module boundary | AD-10 sessions; **AD7-D8** | Owner, Dev C | Isolation test: user B receives nothing of user A; T-16 and T-17 pass with the producer and consumer in place |
| AD7-D4 | Context capture | In the v0.4 POST (forbidden); separate endpoint; none | **Separate endpoint** (§8) | AD-11 storage | Owner, Dev A, Dev C | T-9 |
| AD7-D5 | Backpressure bounds | §7 | **§7** | AD-8 | Owner | Slow-client test |
| AD7-D6 | Limits | Slice 3/20; AD-2 60 | **AD-8 decides**, reconciled through AD-2 §5.1: adopting 60 triggers AD-8's revision, re-approval and re-measurement before milestone 3.4 | AD-2 X-1, AD2-D3; AD-8 §6.2.1 | Owner | AD-8 capacity test including §7's pending state |
| AD7-D7 | Introducing protocol 1.1 (**must be resolved before final approval**: Nisarga) | (a) negotiation: the client states the versions it accepts (for example a request header) and the server sends 1.1 types only to clients that accept them; (b) a versioned endpoint (`/api/rt/v1/...` stays 1.0; new path for 1.1); (c) a coordinated upgrade: server and web bundle change in one release, with no mixed versions supported | **Open.** Adding `route_status` alone is tolerated by D-24 clients if it carries the common fields (§5); changing the snapshot's subject set is not, and needs (a), (b) or (c). (a) keeps one path but adds a header to the contract; (b) is simplest to test; (c) is cheapest but breaks a cached old bundle | Dev C client behaviour; Nginx caching; AD-4 Part 2 §6.2.1 / **AD4P2-Q7**. AD-8 v0.5 §6.2.1a confirms its 500-subject bound is a store bound and authorizes no fifth pair | Owner, Dev C, Dev D | A D-24 client against a 1.1 server shows no protocol fault, under the chosen option |
| **AD7-D8** | **`route_status` correlation and producer** (§5.1, §5.2) | (a) terminal only, by record `id`; (b) pre-response, by `X-Request-Id`; (c) no `route_status`. Producer: response-observing middleware; or v0.4 handlers (T-7-protected) | **(a) with the middleware, provisional** | AD-1 §2 module rules; AD-6 B-3, B-8; T-7, T-16, T-17 | Owner, Dev C, Dev D | No status before the response is final; T-7 shows no protected path changed; T-16, T-17 pass |

## 11. Approval checklist

**Proposed rows for AD-13 §2.9's cross-AD verification map (Varshini, non-blocking 2).** AD-13 is Dev D's and is not edited here; these are the obligations it would carry:

| Source | Obligation | Layer | Runs |
|---|---|---|---|
| AD-7 AD7-D3, §5 | Route-status isolation: user B receives nothing of user A's | Stack | 3.5 |
| AD-7 §5.3 | Producer non-interference: port failing, blocked or absent leaves v0.4 responses, records and `decision_id`s identical | Stack (extends AD-6 T-1) | 3.5 |
| AD-7 §5.1 | No status before the response is final; `422` and failed comparisons publish none | Contract and unit | 3.5 |
| AD-7 §5.2 | T-16 import graph and T-17 frontend state separation with the producer and consumer in place | Contract; browser | 3.5 |
| AD-7 §6, AD7-D7 | A D-24 client against a 1.1 server shows no protocol fault | Browser | 3.5, after AD7-D7 |
| AD-7 §8, §8.1 | Context claims: cross-origin, missing custom header, non-owner (403), duplicate (409), rate limit (429); `X-Request-Id` never accepted as an owner key; T-9 | Stack | 3.5, after 3.2 |

- [ ] Dev C: §3, §4 (including the opener changes), §5 to §5.3 client handling and the separate status store, §8 capture
- [ ] Dev D: §6 schema location, §7, §8.1, CI implications (T-7, T-16, T-17)
- [ ] Project owner: AD7-D1 to **AD7-D8**
