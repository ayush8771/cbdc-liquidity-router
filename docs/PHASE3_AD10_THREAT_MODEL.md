# AD-10: Threat Model and Exposure Plan

**Status:** **DRAFT v0.1 for review. Not approved.** 26 November 2026 (second working revision, still v0.1; not yet reviewed). **AD-6 B-4 remains OPEN** (D-25): this draft records an approved *design direction* and the evidence that would close B-4; it closes nothing. Every new number is **provisional** (`[#?]`). Nothing here is implemented, and no gate has passed (D-18).
**Lead:** Dev B. **Reviewers:** Dev C, Dev D. **Approver:** project owner.
**Inputs:** F-3, F-6; the AD-1 component view v0.5 (approved for the D-24 slice only; §4 placement unconfirmed); A-1, A-2; D-6, D-16, D-25. **Feeds:** AD-7, AD-11; milestone 3.2; the Gate 4 checklist (with AD-13).
**Scope source:** `docs/PHASE3_SCOPE.md` v1.4 §2.2.3, §3 Workstream E, §5 Gate 4, §7.3; `docs/PHASE3_AD6_ENGINE_BOUNDARY.md` §5 (B-4, B-5), §9.2 (AD6-Q5); `docs/PHASE2_ARCHITECTURE.md` §1 (D9, D10), §8.

This document changes no code, Compose file, CI workflow, migration or contract. It does not repeat AD-1's trust boundaries (AD-1 §2) or slice controls (AD-1 §3.5, §3.6); it extends them.

## 1. Owner directions applied (relayed)

Relayed to Dev B by the project owner, 26 November 2026; **no separate approval document exists in the repository**, so they are relayed, not quoted. They approve directions, not this document.

1. The **isolated backend–inference network design** (§3) is approved as a direction. **B-4 stays open** until §3.6's closure evidence exists and the owner records closure.
2. Inference gets **no internet, Cognee or Ollama access** in Phase 3.
3. Security-event logging is **separate** from the business audit log, preserves **Q19**, and excludes secrets (§6).
4. AD-1 §4 placement (which includes any identity-provider component) needs cross-team and owner approval; this document does not confirm it.
5. D-24 is accepted; stale D-24 records are corrected separately.

**Dev C's recommendations (relayed, adopted as proposals here):** keep fetch-based SSE; secure HttpOnly sessions with session isolation; CSRF and origin controls; browser-reported context kept as separate, untrusted records; a restrictive production CSP. **Dev D (relayed)** supports backend-mediated persistence. The owner approved proceeding with AD-10 (relayed, 26 November 2026); that is not approval of this document.

**Unapproved drafts read (not authoritative):** PR #30 at `5f78500` (draft AD-1 companion `docs/PHASE3_AD1_ARCHITECTURE.md` §7.3; draft AD-6 Part 2 T-13), PR #31 at `d96aabe` (AD-3 v0.2 §10 X-5; AD-13 v0.2), PR #29 at `d47e582` (AD-9 §3.5; latest head, re-fetched 26 November 2026; still not approved, owner review `CHANGES_REQUESTED` on `5e98d5a`, relayed in its header). Where they conflict with this draft, §11 records it.

## 2. Existing versus proposed controls

| Area | Existing (verified at `4424b45`) | Proposed here |
|---|---|---|
| Authentication | Development bearer tokens, SHA-256 + `timingSafeEqual` (`services/backend/src/auth/devAuth.ts`); refuses `NODE_ENV=production` (`PHASE2_ARCHITECTURE.md` §8.1) | OIDC with server-side sessions (§4) |
| Exposure | Only `web` published, on `127.0.0.1` (`infra/compose.yaml:121-122`); checked by `e2e/stack-security.py` | Unchanged until Gate 4; TLS before any exposure (§5.4) |
| Ingestion isolation | Internal network, isolated gateway, non-root, read-only, `cap_drop: [ALL]` (`infra/compose.observations.yaml`); T-5 ingestion side (`infra/scripts/probe_ingestion_isolation.py`) | Unchanged |
| **Inference isolation** | **None**: `inference` on the default bridge with outbound access, no hardening (`infra/compose.yaml:80-93`) | §3 |
| Response headers | `server_tokens off`, `X-Content-Type-Options` only (`services/web/nginx.conf.template:8-9`) | CSP and others (§5.2) |
| Rate limits | None on `/api/v1`; observation streams capped 3/user, 20 total (`services/backend/src/observations/constants.ts:61-62`) | §5.3 |
| Database roles | One role, `cbdc`, for `migrate` and `backend` (`infra/env/*.example`); no GRANT/REVOKE in migrations | §5.6 |
| Audit | `AuditLog` only with a persisted record, same transaction (contract §6.2, Q19); action and outcome values provisional (`services/backend/prisma/schema.prisma:213,222`) | Unchanged; separate security-event log (§6) |
| Secrets | External env files (`infra/compose.yaml` header); tracked-secret-files check in `phase2-docker.yml` | Compose secrets (§5.5) |

## 3. B-4: isolated backend–inference network

### 3.1 Design direction (approved as direction; not implemented)

- New network `engine`: `internal: true`, `com.docker.network.bridge.gateway_mode_ipv4: isolated`, `enable_ipv6: false`, the same pattern as `observations` (`infra/compose.observations.yaml`).
- `inference`: `networks: [engine]` only. It leaves `default`, which removes its route to the internet, PostgreSQL, web and ingestion.
- `backend`: `networks: [default, engine]` (it needs `default` for PostgreSQL and web).
- No other service joins `engine`.
- Inference needs no outbound access at runtime: no HTTP client in `services/inference/cbdc_inference`; `enable_cognee` defaults to false (`services/inference/cbdc_inference/settings.py:38`); the only outbound importer is `src/memory/cognee_adapter.py` (explanations only). Under direction 2, enabling Cognee or Ollama from inference is **out of scope** and would need its own approved exception and Gate 2.

### 3.2 Container hardening (Compose-level only)

Applied to `inference` in Compose, so `services/inference/` (a T-7 protected path) is untouched:

| Setting | Value | Note |
|---|---|---|
| User | Already non-root: `USER cbdc` (`services/inference/Dockerfile:57`) | Verified by probe, not changed |
| `cap_drop` | `[ALL]` | |
| `security_opt` | `no-new-privileges:true` | |
| `read_only` | `true`, with `tmpfs: /tmp` | **Assumption to test:** the engine worker pool and PyTorch run with a read-only root plus `/tmp`; `/dev/shm` is already tmpfs |
| `pids_limit`, `mem_limit` | 256 and 2 GiB `[#?]` | About 0.7 GiB at rest (`infra/README.md:17`); the pool forks workers |

**T-6 compatibility (assumption to test):** T-6 hashes trees by running `sh … sha256sum` inside inference (`e2e/p3_safeguards.py:145-147`). Read-only root and dropped capabilities must not break it.

### 3.3 Docker compatibility

- Isolated gateway mode is documented as needing **Docker Engine ≥ 28.0.0** (`infra/README.md:202`). **This prerequisite is provisional** until Dev D verifies it on the CI runners and on each developer engine (including Docker Desktop on Windows). If the network is in `compose.yaml` the **default stack** would require it; if it is in an overlay (§3.8), only that overlay would. On an older engine the network fails to create, which is the safe failure.
- Alternative: `internal: true` without isolated mode. **Not recommended**: the ingestion probe found the host gateway reachable through a plain internal network (`infra/compose.observations.yaml` comment on `driver_opts`).
- Decision AD10-D2 (§8) records which applies to every developer machine and CI runner.

### 3.4 Merged networks

The overlay sets `backend.networks: [default, observations]` (`infra/compose.observations.yaml`). If a merge replaced rather than combined the base list, the backend would lose `engine` and fail to reach inference. **Requirement:** the merged configuration of `compose.yaml` alone, and of `compose.yaml` + `compose.observations.yaml`, gives:

- `inference` ⊆ {`engine`}; `ingestion` ⊆ {`observations`};
- `backend` = {`default`, `engine`} or {`default`, `engine`, `observations`};
- no other service on `engine` or `observations`.

The existing merged-Compose invariant tests (`compose-invariants` job, `.github/workflows/phase3-observations.yml:203-234`) are the place to assert this.

### 3.5 Direct and indirect egress

| Path | Risk | Control |
|---|---|---|
| Direct route out | Internet access | Off the `default` network; `engine` internal |
| Host gateway | Reaching host services | Isolated gateway mode; probe |
| IPv6 | Bypass of IPv4 isolation | Disabled; probe fails on any non-loopback IPv6 |
| DNS via Docker's embedded resolver | Data leaving through name lookups | **Assumption to test:** external names do not resolve on an internal network; probe |
| `HTTP(S)_PROXY`, `ALL_PROXY` variables | Egress through a proxy | None set; probe asserts their absence |
| **Backend as a relay** | Inference reaches `backend:4000` on `engine` | The backend calls only fixed `INFERENCE_URL` and `OBSERVATIONS_URL`; **requirement:** no backend route ever fetches a URL taken from a request. Inference holds no token, so `/api/v1` answers 401. Health routes stay public (AD-1 §3.6 residual, same shape) |
| Backend as the bridge between three networks | Single point keeping networks apart (AD-1 §5 item 2) | Accepted residual (§9) |

### 3.6 Runtime acceptance probes and closure evidence

A new inference-side probe, modelled on `infra/scripts/probe_ingestion_isolation.py` (stdin script, `PASS`/`FAIL` lines, missing variable is a FAIL):

1. **Positive controls:** its own port 8000 answers; `localhost` resolves.
2. No external name resolves; no external IPv4 address connects, after the harness proves the same target is reachable through an ordinary network.
3. The host gateway is unreachable, after the harness proves the listener is reachable through an ordinary network's gateway.
4. Sentinels aliased `postgres`, `ingestion` and a stand-in distribution service, listening on other networks: none resolves or connects.
5. No IPv6 address besides loopback.
6. No proxy variables; no credential-like variable names.
7. Not root; root filesystem read-only.
8. **Backend positive control:** `backend` reaches `inference:8000/v1/health`, and AD-6 T-1's requests give identical `decision_id`s and engine responses.

**B-4 closes only when all of these hold** (owner direction 1):

| Stage | Meaning | Recorded by |
|---|---|---|
| 1. Design approved | This section approved in AD-10 | Owner, scope §2 |
| 2. Implemented | A pull request changes Compose and adds the probe; Dev D implements (AD-6 B-4 names Dev D and Dev B), Dev B reviews | Pull request |
| 3. Evidence | Probes 1–8, the §3.4 invariants, AD-6 T-1, T-2, T-6, T-7 and `e2e/stack-security.py` pass in CI on the merged commit | CI run, cited by URL |
| 4. Closed | Owner records B-4 closed and D-25 retired | Owner, scope §2 |

Until stage 4, AD-6 and status documents keep "B-4 unresolved".

### 3.7 T-7 implications (correction)

My earlier gap analysis said the change would touch a T-7-protected `infra/compose.yaml`. **That was wrong.** T-7's protected paths (`e2e/p3_safeguards.py:43-46`) are `src/`, `data/`, `outputs/`, `tests/`, `contracts/fixtures/`, `contracts/test-vectors/`, `contracts/openapi/`, `services/inference/`, the backend `routes`, `mappers` and `inferenceClient` folders, the requirements files and root `*.py`. No `infra/` path is protected. It follows that:

- a Compose-only change creates **no T-7 path failure**, but it is still **not authorized by T-7's silence**. It needs this document's approval, and the D-24 condition that `infra/compose.yaml` stays unchanged (scope §2.2.2, §2.2.3) was a slice condition that a milestone change must explicitly supersede;
- editing `infra/compose.yaml` triggers the full acceptance run (`.github/workflows/phase3-observations.yml:58`), so T-7's regression evidence is produced anyway and remains mandatory;
- any change under `services/inference/` (Dockerfile or code) **would** fail T-7, which is why §3.2 is Compose-only.

### 3.8 Where the network change lives (open)

The draft AD-1 companion in PR #30 (`docs/PHASE3_AD1_ARCHITECTURE.md` §7.3, unapproved) proposes "overlays, never edits to `compose.yaml`", and Dev D's AD-3 v0.2 §10 X-5 records the resulting tension. Two placements satisfy §3.1:

| | A. Edit `infra/compose.yaml` | B. New overlay (for example `compose.isolation.yaml`) |
|---|---|---|
| Default `--profile full` stack isolated | **Yes** | **No**: B-4 holds only when the overlay is passed |
| Fits the overlay-only proposal | No | Yes |
| Compose mechanics | Straightforward | `inference` lists no networks in `compose.yaml`, so an overlay's explicit list replaces the implicit `default` (Compose behaviour, **unverified here**); the backend list must merge with `compose.observations.yaml` (§3.4) |
| B-4 closure scope | Every stack | Only stacks started with the overlay; Gate 4 would have to require it |

**Recommendation:** A, because B-4 is a property the pilot must always have, not an option. If the owner keeps the overlay-only rule, B is acceptable only with a Gate 4 condition that the pilot stack must include the overlay, and a test that fails when it is absent. Decision AD10-D1a (§8).

## 4. Identity and sessions

### 4.1 Provider (choice stays provisional)

| Option | For | Against |
|---|---|---|
| A. Self-hosted OIDC provider in Compose | Single host; works offline in development; no third party holds user data | A new component needing AD-1 §4 placement, hardening, backup; its own Gate 4 evidence |
| B. Hosted OIDC provider | Least operation; strong MFA | Backend needs egress to the provider; third-party data processing; development needs internet |
| C. Development tokens behind a proxy login | Small | Fails A-2. **Rejected** |

**Provisional recommendation:** A for development and the pilot, keeping B open; decided in AD10-D3 after AD-1 §4 placement is confirmed (direction 4).

### 4.2 Backend-for-frontend flow

- Express is a **confidential OIDC client** using the authorization-code flow with **PKCE (S256)**, a random **`state`** (CSRF on the callback) and a random **`nonce`** (checked in the ID token). Each value is single-use, bound to the login attempt, and expires within 10 min `[#?]`.
- The browser never holds an OIDC token. It holds only a session cookie.
- **Callback compatibility:** the callback path lies under `/api/` (for example `/api/v1/auth/callback`), which Nginx already proxies unchanged (`services/web/nginx.conf.template`, `proxy_pass` without a URI). The redirect URI is registered exactly; no wildcard.
- **Cookies and SameSite (provisional):** the IdP returns the user by a **cross-site top-level redirect**, which does **not** carry `SameSite=Strict` cookies. So the login-transaction cookie (holding `state`, `nonce` and a reference to the PKCE verifier, never the verifier itself) is `SameSite=Lax`, `HttpOnly`, `Secure`, path-limited to the callback, and deleted on use. The **session cookie** is `__Host-` prefixed, `HttpOnly`, `Secure`, `Path=/`, `SameSite=Strict`, and is set by the callback response. A browser landing from the callback redirect then makes a same-site request, so the Strict cookie is sent from the next navigation on.
- **`__Host-` constraints:** the browser accepts a `__Host-` cookie only if it has `Secure`, `Path=/` and **no `Domain` attribute**, and was set from a secure origin. It is therefore bound to one exact host, cannot be set or overwritten by a sibling subdomain, and cannot be path-scoped (which is why the transaction cookie, which is path-scoped, is **not** `__Host-`). Consequences: the pilot must be served from one exact host name; a change of host name ends every session.
- **Local development:** before TLS exists, browsers treat `http://localhost` as a secure context and accept `Secure` and `__Host-` cookies there; `127.0.0.1` and other loopback names behave differently between browsers. **Unverified here**; Dev C tests it in AD10-D3. A development fallback cookie name without the prefix is **not** proposed, so that development cannot diverge silently from the pilot.
- **Provisional:** the IdP, the exact cookie names and the timeouts are proposals until AD10-D3 and AD10-D4 are approved.

### 4.3 Session lifecycle

| Event | Behaviour |
|---|---|
| Login | New session ID (no fixation); stored server-side; the cookie holds only an opaque random ID |
| Idle / absolute timeout | 30 min / 8 h `[#?]` |
| Logout | Server-side deletion; cookie cleared; IdP logout where supported |
| Expiry or revocation | Open streams for that session close (see below). This fixes the D-24 limitation that development tokens are revoked only on restart (AD-1 §3.5) |
| Role change | Takes effect at the next request; open streams are closed as for revocation, so a stream never outlives the authorization it was opened under |

**Propagation to existing streams (requirements):**

1. Every stream records the **session ID** (in memory, never logged in clear) it was authorized for. The stream hub can find all streams of a session and of a user.
2. **Logout, revocation, role change, user deactivation:** the backend closes that session's streams **at once** when it handles the event in-process. Target: closure **≤ 5 s** `[#?]` after the event in the single-instance pilot. If the in-process signal is missed, the item 5 backstop applies (≤ 15 s `[#?]`); see item 10.
3. **Absolute timeout:** the stream closes when the session's absolute lifetime ends, by a per-stream timer, not at the next heartbeat.
4. **Idle timeout:** an open stream does **not** count as user activity and does not extend the session. Idle expiry closes the stream like a revocation. (Otherwise a background stream would keep a session alive for ever.)
5. **Backstop:** at each heartbeat (15 s, AD-1 §3.2) the hub re-validates the session from the store; a session found invalid closes the stream. This bounds the gap if an in-process event is missed, and covers multiple backend processes should they ever exist.
6. **How the browser sees it:** the server ends the stream normally; the client's reconnect is answered **401**, which is a permanent stop with the sign-in handling (AD-1 §3.3.2, unchanged). No new message type is needed; AD-7 may add an advisory `session_ended` message.
7. **Evidence:** for each trigger, the stream ends within the bound, its slot is released, the reconnect gets 401, and no further `update` is written after the trigger.
8. **More than one backend instance.** The pilot runs one backend (F-6), so item 2's in-process close is complete today. If more instances ever run, an instance cannot see another's in-process events: revocation must then be published (for example through the session store or the AD-3 mechanism) to every instance, and until that exists the **bound is the backstop interval** (item 5, 15 s), not 5 s. Adding instances therefore needs an AD-10 revision.
9. **Session-store failure.** If the store cannot be read: **new** requests and new streams fail closed (503, no session is assumed valid); an **open** stream is closed at its next backstop check that cannot confirm the session, so the maximum time an unconfirmable stream stays open is one backstop interval (15 s `[#?]`). Routing requests fail as any database-dependent request does today (Phase 2 readiness rules), not because of the stream.
10. **Bounded closure, summarized (all bounds provisional `[#?]`, final values from AD-8):**

| Situation | Bound |
|---|---|
| Single instance, event handled in-process (normal case) | At once; target ≤ 5 s |
| Single instance, in-process signal missed | ≤ 15 s (backstop) |
| Absolute timeout | At once (per-stream timer) |
| Session store unreadable | ≤ 15 s (backstop) |
| Multiple instances, revocation published to all | ≤ 5 s (requires an AD-10 revision, item 8) |
| Multiple instances, no publication | ≤ 15 s (backstop) |

Session storage is a **mutable** table (rows are created, refreshed and deleted). Its schema is AD-11's; its privileges are separate from business records (§5.6).

### 4.4 Effect on the SSE channel (input to AD-7)

- **Fetch-based SSE is retained** (Dev C; AD-1 §3.3.4). With cookie sessions, the stream request sends the cookie (`credentials: "same-origin"`) instead of a bearer header. `openObservationStream` changes in AD-7 and milestone 3.2, with Dev C.
- The stream GET is authenticated by cookie, so it gets the **origin check** of §5.1.
- A 401 on the stream keeps AD-1 §3.3.2's permanent-stop rule.

## 5. Controls

### 5.1 CSRF and origin

- `SameSite=Strict` session cookie (§4.2).
- **Origin handling.** Browsers send `Origin` on state-changing requests, but commonly **omit it on a same-origin `GET`**, which is how the fetch-based stream is opened. So the rules differ by method:

| Request | `Origin` equals own origin | `Origin` absent | `Origin: null` | Other `Origin` |
|---|---|---|---|---|
| State-changing (`POST`, …) | Allow | **Refuse** (403) | **Refuse** | Refuse |
| Safe (`GET`, `HEAD`), including the stream | Allow | Allow **only if** `Sec-Fetch-Site` is `same-origin` or absent; refuse on `same-site`, `cross-site` | **Refuse** | Refuse |

  `Origin: null` is sent from sandboxed frames, `file:` pages and some redirects. It is **untrusted**, never treated as same-origin. An absent `Sec-Fetch-Site` with an absent `Origin` (old browsers, non-browser clients) is allowed on safe methods only, because the `SameSite=Strict` cookie is not sent cross-site anyway. The stream's origin check runs **before** a slot is taken (AD-1 §3.5 order: authentication, then limits).
- **Fetch Metadata is supplementary, not primary.** `Sec-Fetch-Site`, `Sec-Fetch-Mode` and `Sec-Fetch-Dest` are used as an extra filter (a resource-isolation policy: refuse `cross-site` requests to `/api/` except top-level navigations to the OIDC callback). They are not relied on alone, because older browsers and non-browser clients omit them; the `SameSite=Strict` cookie, the `Origin` rules above and the custom header remain the controls.
- A required custom header (`X-Requested-With`) on `/api/v1` mutations, which a cross-site form cannot set.
- No synchronizer token while the app stays same-origin and CORS stays off (`services/backend/src/app.ts:158`).
- **Evidence:** a cross-origin POST is refused; a stream request with a foreign `Origin` is refused before a slot is taken; a same-origin request passes.

### 5.2 Content Security Policy

Set at Nginx, in **report-only mode first**, then enforced before Gate 4:

```text
default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self';
img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none';
frame-ancestors 'none'; form-action 'self' <IdP origin>
```

Also `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`, and HSTS once TLS exists. **Assumption to test:** the Vite build emits no inline script, and React's `style` props (one `.tsx` under `services/web/src` uses `style=`) are applied through the DOM, which `style-src` does not block. **Evidence:** the browser suites run with zero CSP reports, then pass with enforcement.

### 5.3 Rate limits

| Layer | Limit `[#?]` | Reason |
|---|---|---|
| Nginx, per IP | `/api/` 20 req/s, burst 40; login and callback 10/min | Edge flood protection |
| Express, per user | Routing and comparison POSTs: 10/min and **2 in flight** | The engine pool has 2 workers and a queue of 32 with a 12 s deadline (`infra/env/inference.env.example`); one user must not fill the queue |
| Streams | 3/user, 20 total (unchanged until AD-8) | AD-1 §3.5 |

Responses: `429` with `Retry-After`, in the contract v0.4 error envelope. A new error code would need a contract change, so the code is chosen in AD-7 or milestone 3.2 `[OPEN]`. **Evidence:** one user receives 429 while a second user still succeeds; ENGINE_BUSY rates fall under load.

### 5.4 TLS

Nginx terminates **TLS 1.2 or later** for any exposure, with HSTS. Internal bridges stay plain HTTP on one host, as an accepted residual (§9). PostgreSQL TLS is not required on a single host `[#?]`. **Evidence:** a TLS scan of the published port; no plain-HTTP listener is exposed except a redirect.

### 5.5 Secrets

Move the database passwords, the OIDC client secret and the session-signing key from `env_file` to **Compose `secrets:`** files outside the checkout; no secret in an image, a build argument or a `VITE_*` variable (`PHASE2_ARCHITECTURE.md` §8.3); a documented rotation procedure. **Evidence:** `e2e/stack-security.py` extended so that no secret value appears in `docker inspect` environment or image history; the tracked-secret-files check stays required.

### 5.6 Database roles

Verified: runtime code never updates or deletes Phase 2 records; only the seeder upserts `User` (`services/backend/src/db/seedDevUsers.ts:34`).

| Role | Privileges | Used by |
|---|---|---|
| `cbdc_owner` | DDL; owns the schema | `migrate` only |
| `cbdc_app` | **SELECT, INSERT** on business and audit tables (`TransactionRequest`, `RoutingDecision`, `Allocation`, `Comparison`, `Explanation`, `AuditLog`); **no UPDATE or DELETE**, which enforces contract §6.1's append-only rule; SELECT, INSERT, UPDATE and DELETE **only** on the session table | `backend` |
| `cbdc_security_log` | INSERT on the security-event table only | `backend` (separate connection or `SET ROLE`) |
| `cbdc_retention` | DELETE on rows past retention in the session and security-event tables, and in the Phase 3 families AD-11 §9 lists; never on Phase 2 business records | A scheduled job (milestone 3.7) |
| `cbdc_seed` | INSERT, UPDATE on `User` | Development seeding only |
| Inference | **None** (AD-6 B-5 holds today: `infra/env/inference.env.example` has no `DATABASE_URL`) | — |

Business append-only (no UPDATE or DELETE) is kept apart from the **mutable** session privileges and the **retention** privilege. Observation-store roles are AD-11's. The test database needs the same split (backend integration tests run against it). **Evidence:** UPDATE or DELETE as `cbdc_app` on a business table fails; the Phase 2 suites pass as `cbdc_app`.

## 6. Security-event logging

**Q19 is preserved:** an `AuditLog` row exists only with a persisted record, in the same transaction; a rejected request writes none (contract §6.2). Security events go to a **separate** log.

| Item | Rule |
|---|---|
| Events | Login success and failure; logout; session expiry and revocation; 401; 403 (`FORBIDDEN_POLICY` and others); CSRF or origin refusals; rate-limit hits; stream refusals (429 `STREAM_LIMIT`) |
| Fields | Time; event type; subject ID if known; session ID **hash**; request ID; client IP truncated to /24 (IPv4) `[#?]`; route; outcome |
| **Never logged** | Tokens, cookies, session IDs in clear, OIDC codes, `state`, `nonce`, PKCE verifiers, passwords, `Authorization` headers, request or response bodies |
| Transaction | **Default: outside** every other transaction: a security-log failure never fails, blocks or rolls back a request, a routing record or an `AuditLog` write. **One exception**, the database-backed privileged mutations under "Fail-closed decisions" below. Routing records and `AuditLog` are never in a transaction with a security event, so Q19 is unchanged |
| Bounds | An in-memory queue of at most 10,000 entries `[#?]`; when full, new entries are dropped and a counter rises; repeated identical events are aggregated per minute |
| Failure handling | On a database write failure, emit the same redacted entry to the structured stdout log and count it; never retry inside the request |
| **Durable vs fallback** | Only the database table is the **durable** security log. Stdout is a **fallback, not durable**: container logs rotate and are lost with the container, and nothing guarantees they are retained or complete. Fallback entries are never counted as Gate 4 audit evidence |
| **Degraded mode** | Entered when a durable write fails or the queue drops an entry; left after 60 s `[#?]` of successful writes. While degraded: a `security_log_degraded` gauge is set, an alert fires (AD-8 draft §7), every fallback entry carries `durable: false`, and the drop count is reported when the mode ends |
| **Fail-closed decisions** | Ordinary requests, sign-in and sign-out **fail open** (never blocked by logging), so a logging fault cannot lock users out or affect routing (AD6-Q2). **Fail closed** only for privileged, security-relevant changes whose trace must be durable, and the rule differs by where the change lives:<br>(a) **Database-backed privileged mutations** made by the backend (an application role grant, an administrator's session revocation, a review approval or refusal, a reviewer-identity row in AD-11 P-10): the security event is written **in the same database transaction** as the mutation, so both exist or neither does. These are security and review records, not routing records; no `AuditLog` row is involved, so Q19 is unchanged. If the durable log is unavailable the mutation is refused with 503, the refusal goes to the stdout fallback (not durable), and nothing partial remains.<br>(b) **External privileged actions** the backend does not perform in its own database (a role or account change made in the IdP, an IdP-side session revocation): no shared transaction is possible. The backend **enforces** what it learns (it denies on the next check, AD-10 §4.3) whatever the log state, and writes the security event when it learns of the change; if the durable log is unavailable then, the event goes to the fallback, is marked `durable: false`, and the gap is reported. Enforcement never waits on logging.<br>The stdout fallback is **never** sufficient evidence for (a). Decision AD10-D12 |
| Storage | A PostgreSQL table, insert-only for the application (§5.6), plus structured logs; retention 90 days `[#?]`; schema in **AD-11** |
| Context records | Browser-reported displayed context (AD-6 §6.1) is a **separate, untrusted** record (Dev C), not a security event and not an audit row; AD-7 captures it, AD-11 stores it |

**Evidence:** a 401 writes one security event and **no** `AuditLog` row; with the security table unavailable, requests still succeed and the fallback log has the entry; a log scan finds no token, cookie or `state` value.

## 7. Gate 4 prerequisites (aligned with AD-13)

Dev D's AD-13 draft (`3929156`, §3.2 Gate 4 row) lists scope §5's evidence. AD-10 adds the items below. The record uses AD-13's common template (§3.1 there).

1. **B-4 closed** (§3.6 stage 4) and D-25 retired.
2. Milestone 3.2 complete: OIDC sessions (§4), dev mode impossible in the pilot build, CSP enforced (§5.2), CSRF and origin tests passing (§5.1).
3. Rate limits tested (§5.3).
4. TLS on the published port (§5.4).
5. Secrets in Compose secrets (§5.5).
6. Database roles split, with append-only enforced (§5.6).
7. Audit trail (AD-11) and security-event log (§6) working.
8. Hardening and isolation probes passing for inference and ingestion.
9. Monitoring, alerting, backup and a restore drill (milestone 3.7).
10. AD-1 §4 placement confirmed (D-22).
11. **Branch protection on `main` is owner-controlled.** The `phase3-acceptance` gate targets `feature/phase3-platform`; adding `main` is the owner's decision when Phase 3 merges there (`docs/PHASE3_D24_ACCEPTANCE.md` §6). This document requests nothing on it.

## 8. Decisions

| # | Decision | Alternatives | Recommendation | Depends on | Approver | Acceptance evidence |
|---|---|---|---|---|---|---|
| AD10-D1 | B-4 network design | Internal `engine` network; host firewall or egress proxy; hardening only; extend D-25 | **Internal `engine` network** plus Compose hardening (direction approved; §3) | Dev D implementation | Owner, after Dev C and Dev D review | §3.6 stages 3 and 4 |
| AD10-D1a | Where the network change lives (§3.8) | Edit `compose.yaml`; new overlay | **Edit `compose.yaml`**; overlay only with a Gate 4 condition and a presence test | AD-1 companion §7.3 (unapproved) | Owner, Dev D | Merged-config invariants for the stack actually run |
| AD10-D2 | Docker Engine ≥ 28 (provisional) | Require it; plain `internal` without isolated mode | **Require it, after Dev D verifies** runners and developer engines | Dev D verification | Owner and Dev D | Network creation in CI and on each developer engine; failure on older engines documented |
| AD10-D3 | Identity provider | Self-hosted; hosted; dev tokens behind proxy | **Self-hosted, provisional** | AD-1 §4 | Owner, Dev C, Dev D | Login, logout, expiry and callback tests (§4) |
| AD10-D4 | Session model | Server-side sessions with cookie; browser-held tokens | **Server-side sessions** (§4.2, §4.3) | AD-11 (table) | Owner, Dev C | Fixation, timeout and stream-closure tests |
| AD10-D5 | CSRF and origin | §5.1; synchronizer tokens | **§5.1** | AD-7 (stream) | Owner, Dev C | §5.1 tests |
| AD10-D6 | CSP | §5.2; permissive | **§5.2, report-only first** | Dev C build check | Owner, Dev C | Zero reports, then enforced |
| AD10-D7 | Rate limits | Edge only; edge plus per user | **Both** (§5.3) | AD-8 for final numbers; AD-7 for the error code | Owner | §5.3 load test |
| AD10-D8 | TLS scope | Edge only; also internal | **Edge only** on one host | — | Owner | TLS scan |
| AD10-D9 | Secrets | env files; Compose secrets; external vault | **Compose secrets** | — | Owner, Dev D | §5.5 checks |
| AD10-D10 | Database roles | One role; §5.6 split | **§5.6 split** | AD-11 | Owner, Dev A, Dev D | §5.6 tests |
| AD10-D11 | Security-event log | Inside `AuditLog` (breaks Q19); separate table; logs only; both | **Separate table (durable) plus stdout fallback (not durable)** (§6) | AD-11 (schema) | Owner, Dev A, Dev D | §6 tests |
| AD10-D12 | Behaviour when the durable security log is unavailable | Fail open everywhere; fail closed everywhere; fail closed for privileged changes only | **Fail closed for privileged changes only** (§6) | AD-11 review records | Owner, Dev C | Durable table down: sign-in works and is logged to fallback; a role change is refused with 503 |
| AD10-D13 | Stream revocation propagation (§4.3) | Next heartbeat only; immediate in-process plus heartbeat backstop | **Immediate plus backstop** | AD-7 | Owner, Dev C | §4.3 item 7 |

## 9. Residual risks

1. The backend is the single bridge between `default`, `engine` and `observations`.
2. Ingestion and inference can each open `backend:4000`; protected routes return 401, and health routes stay public.
3. Internal traffic is plain HTTP on one host.
4. Docker Engine ≥ 28 becomes mandatory for every developer and CI runner.
5. The read-only inference assumptions (§3.2) and DNS behaviour on internal networks (§3.5) are untested.
6. A self-hosted IdP is a new critical component with its own attack surface and backup needs.
7. A pull request can edit the gate workflow file that runs for it, and an administrator can edit the protection rule (`docs/PHASE3_D24_ACCEPTANCE.md` §6, residual risks 1–2).
8. All rate-limit, timeout and retention numbers are unmeasured.
9. Browser-reported context is a claim, not proof (AD-6 §6.1).

## 10. Dependencies and approval

| Needs | From |
|---|---|
| AD-1 §4 placement (IdP, observation store) | Owner, cross-team |
| Session and security-event schemas; observation roles | AD-11 (Dev B) |
| Channel authentication text; rate-limit error code | AD-7 (Dev B, with Dev C) |
| Final latency and limit budgets | AD-8 (Dev A) |
| Gate 4 template | AD-13 (Dev D) |
| B-4 implementation and probe | Dev D |

- [ ] Dev C: §4, §5.1, §5.2, §6 context records
- [ ] Dev D: §3, §5.5, §7 alignment with AD-13
- [ ] Project owner: AD10-D1 to AD10-D13. **Approval of this document approves a design, not B-4 closure.**

## 11. Conflicts with other drafts

| ID | With | Conflict | Path |
|---|---|---|---|
| C10-1 | Draft AD-1 companion §7.3 (PR #30) | "`compose.yaml` unchanged by Phase 3" vs §3.8 option A | AD10-D1a; owner |
| C10-2 | AD-3 v0.2 §10 X-5 (PR #31) | Same tension, recorded by Dev D; consistent with §3.7's T-7 correction | Same |
| C10-3 | Draft AD-6 Part 2 T-13 (PR #30) | Defines the inference-egress test; §3.6 probes 1–8 are a superset | Align IDs when both are approved; T-13 not run, not claimed |
| C10-4 | AD-13 v0.2 Gate 4 row (PR #31, `d96aabe`) | **Corrected:** it already requires B-4 on both sides (T-5 inference side, T-13), T-11 egress allowlists and AD-8 drills. It still lacks the security-event log (§6), database roles (§5.6), session revocation (§4.3) and the owner-controlled `main` protection item (§7 item 11) | AD-13 to reference §7 items 6, 7, 11 |
| C10-5 | AD-8 draft §6.3 | Stream totals 20; AD-2 proposes 60 | AD-2 X-1 |
