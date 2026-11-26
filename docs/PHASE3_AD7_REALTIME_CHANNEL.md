# AD-7: Real-Time Channel Contract

**Status:** **DRAFT v0.1 for review. Not approved.** 26 November 2026. New numbers are **provisional** (`[#?]`). Nothing here is implemented beyond what §2 marks as existing; no milestone or gate is authorized.
**Lead:** Dev B. **Reviewers:** Dev C, Dev D. **Approver:** project owner.
**Inputs:** F-3; AD-4 v0.2 (approved for the D-24 slice only); AD-10 (draft). **Feeds:** milestone 3.5. **Coordinates with:** AD-2 (replay vs snapshot), AD-8 (budgets), AD-9 (degradation), AD-11 (context records).
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
| Authentication failure | 401 → permanent stop, no auto-reconnect, sign-in handling runs; superseded-session 401 dropped (AD-1 §3.3.2, §3.3.4) | **Preserved**; session source changes to cookies (§4) |
| Limits | 3 per user, 20 total; 429 `STREAM_LIMIT` `Retry-After: 5`; 503 `SHUTTING_DOWN` `Retry-After: 1` (AD-1 §3.2, §3.5) | Kept until AD-8; AD-2 X-1 open |
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

- **Today:** development bearer token in `Authorization`, sent only by `openObservationStream` (AD-1 §3.3.4).
- **Milestone 3.2 onward (proposed, depends on AD-10 approval):** the server-side session cookie of AD-10 §4.2 is sent with `credentials: "same-origin"`; no token reaches browser code. `openObservationStream` keeps its signature and its superseded-session rule; only its credential changes (Dev C).
- **Origin:** AD-10 §5.1's safe-method rule, checked before a slot is taken.
- **Session isolation:** a stream is bound to the session that opened it. It receives only its user's `route_status` messages (§5) and closes when that session ends (AD-10 §4.3).
- **Failure semantics are unchanged:** 401 is a permanent stop; 403 and other 4xx stop; 429 waits; 5xx and network errors reconnect (AD-1 §3.3 table, §3.3.2).

## 5. Route-status messages

AD6-Q1 forbids routing triggered by events; AD-6 §4 allows "pushing the status of a routing request the user made".

| Rule | Requirement |
|---|---|
| Origin | Only a request the **same user** submitted through the v0.4 API (`POST /api/v1/transactions`, `POST /api/v1/comparisons`). Never created by an observation |
| Recipients | Only streams of the user who submitted it. Other users, including analysts, receive nothing |
| Content | `request_kind` (`transaction` or `comparison`), the record `id` as returned by v0.4, `status` (`accepted`, `completed`, `failed`), `at` (server time) and, if failed, the v0.4 error `code`. **No** amounts, corridors, allocations, policies or engine fields; the client fetches the result through v0.4 |
| Not authoritative | The v0.4 response and record are authoritative. A missed `route_status` changes nothing; on reconnect the client does not replay it and reads status through v0.4 if needed |
| Coalescing | Newest status per request id; a terminal status (`completed`, `failed`) is never replaced by a non-terminal one |
| Engine boundary | A `route_status` never enters an engine request, `decision_id`, `clientReference` or cache key (AD-6 §5) |
| Version | Intended as a **minor** version (`1.1`), but **not automatically compatible** with D-24 clients. Verified in `services/web/src/features/observations/validate.ts:147-200`: the D-24 client accepts any `1.x`, ignores an unknown `type` and still counts its `stream_seq`, **but only after** the common checks pass. Every message, including `route_status`, must therefore carry a valid `protocol_version`, `type`, consecutive `stream_seq`, AD-4 `server_time` and a well-formed `source`, or the D-24 client records a protocol fault (three faults stop it). Separately, a D-24 client **faults** on any `snapshot` that does not carry exactly the four slice pairs in order, so adding subjects to the snapshot is **not** a compatible change. Compatibility mechanism is open: AD7-D7 (§10) |
| Ongoing authorization | Checked **at every send**, not only when the stream opened: the stream's session is still valid (AD-10 §4.3) and its user still owns the request id. A message failing either check is dropped and counted; a failed session check also closes the stream |

`session_ended` (advisory, minor version): sent just before the server closes a stream for AD-10 §4.3 reasons, with a reason code. The client must still rely on the 401 that follows, not on this message.

## 6. Versioning

AD-1 §3.2's rule is kept: `protocol_version` `"1.x"`; a minor version adds optional fields or message types; a major version changes meaning and the path (`/api/rt/v2`); an unknown major version stops the client. Schemas live with the slice's in `contracts/events/` (AD-1 §3.7, P-8); a new message adds a schema and fixtures there in the implementing milestone, not here.

## 7. Backpressure (bounded)

- Per stream: at most one pending `update` per **subject**, one pending `route_status` per request id, one heartbeat; newest wins (AD-1 §3.5 generalized).
- A stream that has not drained for 10 s is destroyed (unchanged) and recovers by snapshot (AD-2 R-10).
- Per-stream pending state is bounded by the subject count of its snapshot plus at most 20 `[#?]` request ids; beyond that, the oldest non-terminal `route_status` is dropped and counted.
- Coalescing never touches the store; it is not loss of an accepted event (AD-2 R-12).

## 8. Browser-context claims

AD-6 §6.1 and AD6-Q3: displayed context is recorded separately; v0.4 requests are strict and cannot carry it; capture belongs to AD-7, storage to AD-11; a browser report is **a claim, not proof**.

**Capture (proposed):** after a v0.4 POST succeeds, the panel sends one claim to a separate endpoint, `POST /api/rt/v1/context-claims` (name provisional), outside contract v0.4.

| Rule | Requirement |
|---|---|
| Closed schema | `request_kind`, `request_id` (from the v0.4 response), `captured_at` (client clock, informational only), and `items[]`: each `event_id` (or null), subject, display label, freshness state, displayed `age_ms`. Unknown fields → 422 |
| Bounds | ≤ 50 items; body ≤ 8 KiB `[#?]`; one claim per request id (a second is 409 and counted) |
| Allowlist | Only the fields above. **Never**: tokens, cookies, session IDs, form values, amounts, user text, URLs, rates or any payload |
| Authorization | Session user must own `request_id`; claim accepted only within 5 min `[#?]` of the request's creation |
| Trust | Stored as `trust_level: browser_claim`; the server adds `received_at` and user ID; it does not "correct" or enrich the claim from its own state |
| Never an engine input | Not read by any routing, mapper or inference-client module (AD-6 B-3); not in `decision_id`, `clientReference`, a cache key or engine logs |
| Failure | A failed or missing claim never blocks, delays or rolls back the routing record or its audit row (AD-6 §6.1); the UI shows nothing about it; a gap stays a gap |
| Rate | Covered by AD-10 §5.3 per-user limits |
| Test | AD-6 **T-9**: with the claim recorded, absent or failing, engine requests, responses and `decision_id` are identical |

## 9. Alignment

- **AD-2:** consumer replay (R-9) is server-side only; browsers get snapshots (R-10). The channel never carries replayed history.
- **AD-9 (PR #29, draft):** the panel's degradation states (disconnected, paused, offline, stopped, too many streams) are AD-9 §3.3's; this document adds no state, and `route_status` loss is not a degradation state.
- **AD-10:** sessions, origin and revocation (§4).
- **AD-8 (PR #30, draft):** T5/T6 measurement uses each `update`'s `server_time` as the correlated marker (AD-8 draft §2.4); no new field is required.

## 10. Decisions

| # | Decision | Alternatives | Recommendation | Depends on | Approver | Evidence |
|---|---|---|---|---|---|---|
| AD7-D1 | Transport | SSE (fetch); WebSocket; both | **SSE**, with §3 reconsideration criteria | — | Owner, Dev C, Dev D | D-24 evidence; §3 criteria recorded |
| AD7-D2 | Channel authentication | Bearer (today); session cookie | **Session cookie** from 3.2 | AD10-D3, AD10-D4 | Owner, Dev C | 401/403/origin tests on the stream |
| AD7-D3 | Route status | None; §5 | **§5**, minor 1.1 | AD-10 sessions | Owner, Dev C | Isolation test: user B receives nothing of user A |
| AD7-D4 | Context capture | In the v0.4 POST (forbidden); separate endpoint; none | **Separate endpoint** (§8) | AD-11 storage | Owner, Dev A, Dev C | T-9 |
| AD7-D5 | Backpressure bounds | §7 | **§7** | AD-8 | Owner | Slow-client test |
| AD7-D6 | Limits | Slice 3/20; AD-2 60 | **AD-8 decides** | AD-2 X-1 | Owner | — |
| AD7-D7 | Introducing protocol 1.1 | (a) negotiation: the client states the versions it accepts (for example a request header) and the server sends 1.1 types only to clients that accept them; (b) a versioned endpoint (`/api/rt/v1/...` stays 1.0; new path for 1.1); (c) a coordinated upgrade: server and web bundle change in one release, with no mixed versions supported | **Open.** Adding `route_status` alone is tolerated by D-24 clients if it carries the common fields (§5); changing the snapshot's subject set is not, and needs (a), (b) or (c). (a) keeps one path but adds a header to the contract; (b) is simplest to test; (c) is cheapest but breaks a cached old bundle | Dev C client behaviour; Nginx caching | Owner, Dev C, Dev D | A D-24 client against a 1.1 server shows no protocol fault, under the chosen option |

## 11. Approval checklist

- [ ] Dev C: §3, §4, §5 client handling, §8 capture
- [ ] Dev D: §6 schema location, §7, CI implications
- [ ] Project owner: AD7-D1 to AD7-D7
