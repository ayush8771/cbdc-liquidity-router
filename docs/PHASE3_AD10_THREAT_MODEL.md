# AD-10: Threat Model and Exposure Plan

**Status:** **DRAFT v0.2 for review. Not approved.** 26 November 2026. **Review state:** reviewed on PR #33 at `ddac407` — **CHANGES_REQUESTED by Nisarga (Dev D)** and **CHANGES_REQUESTED by Varshini (Dev C)**. Both rounds are applied in v0.2; **neither reviewer has re-reviewed**, and no owner approval exists. **AD-6 B-4 remains OPEN** (D-25): this draft records an approved *design direction* and the evidence that would close B-4; it closes nothing. B-4 closes only with an **authorized implementation, runtime verification and formal owner closure** (§3.6). Every new number is **provisional** (`[#?]`). Nothing here is implemented, and no gate has passed (D-18).

**Revision v0.2, 26 November 2026 — still DRAFT.** Documentation only: no code, Compose file, contract, OpenAPI file, schema or CI workflow changes, and **the cookie-session model remains a proposal, not an approved contract change**. Applied:

| From | Finding | Where applied |
|---|---|---|
| Varshini **B1** (blocking) | Threat actors and attack scenarios; authorization boundaries; control ownership, enforcement point, verification and residual risk; the AD-12 reviewer-authorization and separation-of-duties dependency | **§2.1**, **§5.7** |
| Varshini **B2** (blocking) | Cookie sessions conflict with the approved bearer-only contract; an explicit compatibility and transition section | **§4.5**, §4.4, AD10-D16, C10-6, C10-7 |
| Varshini **B3** (blocking) | Stale and unsupported references; distinguish existing decisions, proposed controls and unresolved dependencies | **§1.1**, §6, §7, §10, §11 |
| Nisarga 1 | §5.6 and §6(a): same-transaction security logging is incompatible with separate `cbdc_app` and `cbdc_security_log` privileges | **§6.1**, §5.6, **AD10-D14** (joint with AD-11 AD11-D10) |
| Nisarga 2 | §5.1: extend applicable CSRF protection to AD-7's context-claims `POST` | §5.1, §5.3 |
| Nisarga (before final approval) | IdP role-change propagation; passive-dashboard session expiry | §4.3, **AD10-D15**, **AD10-D17** |
| Nisarga | Update references against the latest AD-1 draft; keep B-4 open until authorized implementation, runtime verification and owner closure | §1.1, §3.8, C10-1; Status line |
| Varshini, non-blocking 1–8 | SameSite after the IdP redirect; role change versus 401; 503 semantics; per-IP limits behind NAT; secrets as files; INSERT-only role with Prisma and the tests; CSP `form-action`; §7 evidence separation | §4.2, §4.3, §5.2, §5.3, §5.5, §5.6, §7 |
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

### 1.1 Status of everything this document cites (Varshini B3)

v0.1 cited several drafts as if they were settled, and cited one document that did not yet exist. Each citation below is now marked by what it is. **Only the first group is authoritative.**

| Kind | Documents | How this document uses them |
|---|---|---|
| **Approved** | API contract **v0.4** (normative; its OpenAPI files remain DRAFT); `docs/PHASE2_ARCHITECTURE.md`; AD-1 component view **v0.5** and AD-6 **v0.2**, each **for the D-24 slice only**; AD-4 v0.2 (D-24 slice only); Q19 (contract §6.2) | **Existing decisions.** Nothing here changes them; where a proposal would, §4.5 and §11 say so |
| **Draft, merged into `feature/phase3-platform`, not approved** | AD-3, AD-12, AD-13 **v0.3** (PR #31, head `15fd739`); AD-9 **v0.1** (PR #29, head `d47e582`) | Inputs and alignment only. Merging is not approval |
| **Draft, open PR, not approved** | AD-1 Part 2 **v0.4**, AD-5 **v0.4**, AD-8 **v0.5**, AD-6 Part 2 (PR #30, head **`730f75a`**, which revises only AD-5 and AD-8 after Dev B's re-review of `e457bcf` and is **not yet re-reviewed**; v0.1 cited `5f78500`, which is superseded); AD-2 v0.2 (PR #32); AD-7 v0.2 (PR #34); **AD-11 v0.2 (PR #35)** | Inputs and alignment only. **v0.1 cited AD-11 sections and P-10 as if authoritative when AD-11 had not been published**; every AD-11 citation now names it as a draft proposal |
| **Proposed here** | Every control in §3 to §6 not marked "existing" in §2 | Needs owner approval (§8) |
| **Unresolved dependency** | Marked `[DEP: …]` or `[OPEN]` where it occurs; listed in §10 | Not decided by this document |

Where a draft conflicts with this document, §11 records it.

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

### 2.1 Threat actors, attack scenarios and control ownership (Varshini B1)

The pilot is single-host, private and has named users (F-6, D-1); nothing is exposed until Gate 4 (D-16). The analysis covers that pilot, not an internet-facing service.

**Actors.** **TA-1** a compromised internal service (inference, ingestion, or a dependency inside either); **TA-2** hostile content in a user's browser (XSS through a rendered value or a dependency, a malicious extension, a cross-site page); **TA-3** a compromised or misconfigured identity provider; **TA-4** a denial-of-service source, external after exposure or a runaway client before it; **TA-5** an authenticated user exceeding their authorization (a viewer acting as an analyst, a reviewer approving their own item).

| # | Scenario | Actor | Control (section) | Enforcement point | Owner | Verification | Residual risk |
|---|---|---|---|---|---|---|---|
| S-1 | Inference exfiltrates data or reaches PostgreSQL, ingestion or the internet | TA-1 | `engine` network, hardening (§3) | Docker networking | Dev D, Dev B | §3.6 probes 1–8 with positive controls; AD-6 Part 2 T-13 | **B-4 open** until §3.6 stage 4; backend remains the bridge (§9 item 1) |
| S-2 | Inference uses the backend as a relay | TA-1 | Fixed `INFERENCE_URL`/`OBSERVATIONS_URL`; no URL taken from a request (§3.5) | Backend code review; T-16 import graph | Dev B | Probe 8; code review | Health routes public (§9 item 2) |
| S-3 | Ingestion writes to Phase 2 or holds a database credential | TA-1 | No route, no credential (AD-1 §3.6; AD-6 B-5) | Docker networking; env files | Dev D | T-5 (ingestion side, existing) | Unchanged by this document |
| S-4 | Script injected into the page reads data or acts as the user | TA-2 | CSP (§5.2); HttpOnly session cookie (§4.2); no token in browser code | Nginx headers; browser | Dev C | Zero CSP reports, then enforced; cookie flags tested | A same-origin XSS can still **act** as the user while the page is open; HttpOnly stops theft of the cookie, not use of the session |
| S-5 | A cross-site page triggers a state-changing request | TA-2 | `SameSite=Strict`; Origin rules; required custom header on **every** `/api/` mutation, including `/api/rt/v1` (§5.1) | Express middleware | Dev B, Dev C | §5.1 evidence | Old browsers without Origin are allowed on safe methods only |
| S-6 | A forged or replayed login completes a session | TA-2, TA-3 | PKCE S256, `state`, `nonce`, exact redirect URI (§4.2) | Express OIDC client | Dev B | Callback tests with tampered `state`, `nonce`, code | Depends on the IdP's correctness |
| S-7 | IdP issues tokens for the wrong user, or role claims are wrong | TA-3 | Issuer and audience checks; roles mapped from claims by an allowlist (§5.7) | Express | Dev B | Tests with a wrong issuer, audience or claim | **A compromised IdP is fully trusted for identity.** Nothing in the pilot detects it; AD10-D3 weighs this |
| S-8 | A revoked or downgraded user keeps a live stream or session | TA-5, TA-3 | §4.3 closure bounds; per-send checks (AD-7 §5) | Stream hub; session store | Dev B | §4.3 item 7 evidence | IdP-side changes propagate only as fast as AD10-D17 allows |
| S-9 | Flooding the API or the engine queue | TA-4 | Edge and per-user limits (§5.3); stream caps | Nginx; Express | Dev B, Dev D | §5.3 load test | Per-IP limits may collapse to one address behind Docker NAT (§5.3) |
| S-10 | A viewer requests `ppoProjected` or reads what they should not | TA-5 | Role checks before server state (contract §3.0, §3.2) | Express | Dev B | Existing Phase 2 tests | **Every authenticated user reads every user's records** (contract §3.1); unchanged (§5.7) |
| S-11 | A reviewer approves their own submission | TA-5 | Per-action reviewer check; separation rule (§5.7; AD-11 §6, AD11-D9) | Express review module | Dev B, Dev D | AD11-D9 evidence | Open owner decision; a single-person pilot may need a recorded waiver |
| S-12 | Security events lost, hiding an attack | TA-1, TA-4 | Durable log, fallback, degraded mode (§6) | Backend; PostgreSQL | Dev B | §6 evidence | Fallback is not durable; a queue overflow drops entries (counted) |

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

**Updated against the latest AD-1 draft (Nisarga).** v0.1 cited the AD-1 companion at `5f78500`, whose §7.3 proposed "overlays, never edits to `compose.yaml`". The reviewed revision, **AD-1 Part 2 v0.4 at `e457bcf`** (PR #30, still unapproved, and **unchanged at the current head `730f75a`**), adds **§7.3.1**: "`infra/compose.yaml` is not changed" is a **D-24 condition**, not a permanent architectural rule, and "an **approved** AD-10 change may modify it to close B-4", subject to three conditions that hold regardless — not under D-24, no Phase 1 or Phase 2 behaviour change, and Gate 4 **evidence** rather than a gate pass. Read with that draft, option A below is **permitted once approved**, and the remaining choice is a preference, not a conflict. AD-3 **v0.3** §10 X-5 records the same tension. Two placements satisfy §3.1:

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
- **Cookies and SameSite (provisional):** the IdP returns the user by a **cross-site top-level redirect**, which does **not** carry `SameSite=Strict` cookies. So the login-transaction cookie (holding `state`, `nonce` and a reference to the PKCE verifier, never the verifier itself) is `SameSite=Lax`, `HttpOnly`, `Secure`, path-limited to the callback, and deleted on use. The **session cookie** is `__Host-` prefixed, `HttpOnly`, `Secure`, `Path=/`, `SameSite=Strict`, and is set by the callback response. A browser landing from the callback redirect then makes a same-site request, so the Strict cookie is sent from the next navigation on. **To verify, not assumed (Varshini, non-blocking 1):** the callback response is itself reached by a **cross-site** redirect chain, so the page it redirects to may be treated as cross-site for its first request in some browsers, and the Strict session cookie may be withheld on that one request. Dev C tests this on each supported browser; if it is withheld, the callback ends with a same-origin redirect or a small page that navigates on, rather than relaxing the session cookie to `Lax`.
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
| Role change | Takes effect at the next request; open streams are closed as for revocation, so a stream never outlives the authorization it was opened under. **The session stays valid**, so the client's reconnect **succeeds** under the new role — unlike revocation and expiry, which answer **401** (item 6). How fast an IdP-side change reaches the backend is item 11 |

**Propagation to existing streams (requirements):**

1. Every stream records the **session ID** (in memory, never logged in clear) it was authorized for. The stream hub can find all streams of a session and of a user.
2. **Logout, revocation, role change, user deactivation:** the backend closes that session's streams **at once** when it handles the event in-process. Target: closure **≤ 5 s** `[#?]` after the event in the single-instance pilot. If the in-process signal is missed, the item 5 backstop applies (≤ 15 s `[#?]`); see item 10.
3. **Absolute timeout:** the stream closes when the session's absolute lifetime ends, by a per-stream timer, not at the next heartbeat.
4. **Idle timeout:** an open stream does **not** count as user activity and does not extend the session. Idle expiry closes the stream like a revocation. (Otherwise a background stream would keep a session alive for ever.)
5. **Backstop:** at each heartbeat (15 s, AD-1 §3.2) the hub re-validates the session from the store; a session found invalid closes the stream. This bounds the gap if an in-process event is missed, and covers multiple backend processes should they ever exist.
6. **How the browser sees it (corrected, Varshini non-blocking 2):** the server ends the stream normally, and what the reconnect gets depends on the trigger. After **logout, revocation, expiry or user deactivation** the session no longer exists, so the reconnect is answered **401**, a permanent stop with the sign-in handling (AD-1 §3.3.2, unchanged). After a **role change** the session is still valid, so the reconnect is answered **200** with a new snapshot under the new role; the closure only guarantees that no stream outlives the authorization it was opened under. No new message type is needed; AD-7 proposes an advisory `session_ended` message.
7. **Evidence:** for each trigger, the stream ends within the bound, its slot is released, the reconnect gets 401, and no further `update` is written after the trigger.
8. **More than one backend instance.** The pilot runs one backend (F-6), so item 2's in-process close is complete today. If more instances ever run, an instance cannot see another's in-process events: revocation must then be published (for example through the session store or the AD-3 mechanism) to every instance, and until that exists the **bound is the backstop interval** (item 5, 15 s), not 5 s. Adding instances therefore needs an AD-10 revision.
9. **Session-store failure.** If the store cannot be read: **new** requests and new streams fail closed (503, no session is assumed valid); an **open** stream is closed at its next backstop check that cannot confirm the session, so the maximum time an unconfirmable stream stays open is one backstop interval (15 s `[#?]`). Routing requests fail as any database-dependent request does today (Phase 2 readiness rules), not because of the stream. **Semantics and D-24 compatibility (Varshini, non-blocking 3):** the 503 carries `Retry-After` `[#?]` and is **not** a 401, so it never triggers the sign-in handling. The D-24 client treats any 5xx as recoverable and reconnects with its 1 s then 2 s backoff (AD-1 §3.3 table), so it needs **no change** to survive a session-store outage, and it keeps retrying until the store returns, at which point the session is confirmed (200) or found gone (401). The **error code** is a contract matter: the slice's stream 503 uses `SHUTTING_DOWN`, and reusing it for a store failure would mislabel the cause, while a new code needs a contract revision (§4.5). `[OPEN]`, decided with AD10-D16.
10. **Bounded closure, summarized (all bounds provisional `[#?]`, final values from AD-8):**

| Situation | Bound |
|---|---|
| Single instance, event handled in-process (normal case) | At once; target ≤ 5 s |
| Single instance, in-process signal missed | ≤ 15 s (backstop) |
| Absolute timeout | At once (per-stream timer) |
| Session store unreadable | ≤ 15 s (backstop) |
| Multiple instances, revocation published to all | ≤ 5 s (requires an AD-10 revision, item 8) |
| Multiple instances, no publication | ≤ 15 s (backstop) |

11. **IdP role-change propagation (Nisarga, before final approval).** Item 2 covers changes the backend **performs or observes in-process**. A role or account change made **in the IdP** reaches the backend only when the backend next asks the IdP, which a server-side session does not do on every request. The bound is therefore the **re-validation interval** with the IdP: at the latest at the next login, and earlier if the backend refreshes the user's claims on a timer `[#?]` or the IdP supports back-channel logout or event notification. Which of these is available depends on the IdP (AD10-D3). Until the backend learns of the change **the old role applies**, and that window is a residual (S-8). Decision **AD10-D17** sets the interval; once learned, the change is enforced at once and logged as §6 case (b).
12. **Passive-dashboard session expiry (Nisarga, before final approval).** Item 4's rule has a visible consequence: a user who only **watches** the observation panel, with no other request, is idle-expired after the idle timeout (30 min `[#?]`) **while watching**. The stream closes, the reconnect gets 401, the client stops permanently and the sign-in handling runs (AD-9 §3.5), so the user is signed out mid-view. That is the intended security property — a background tab must not keep a session alive for ever — but it is a user-visible behaviour, and the alternatives change the property: (a) accept it; (b) a longer idle timeout for sessions that make no state-changing request; (c) count a **visible, focused** tab's explicit user interaction as activity, which needs a client signal. **Open: AD10-D15.** None is chosen here; until decided, (a) is the behaviour this document describes.

Session storage is a **mutable** table (rows are created, refreshed and deleted). Its schema is proposed in **AD-11 v0.2 (PR #35, draft, not approved)**; its privileges are separate from business records (§5.6).

### 4.4 Effect on the SSE channel (input to AD-7)

- **Fetch-based SSE is retained** (Dev C; AD-1 §3.3.4). With cookie sessions, the stream request would send the cookie (`credentials: "same-origin"`) instead of a bearer header. That is **more than a credential swap** — the token-gated 401 handling and the superseded-session rule change too — and is set out with every other affected component in §4.5. **Proposed only:** nothing changes before milestone 3.2 is approved.
- The stream GET is authenticated by cookie, so it gets the **origin check** of §5.1.
- A 401 on the stream keeps AD-1 §3.3.2's permanent-stop rule.

### 4.5 Compatibility and transition from the approved bearer-only contract (Varshini B2)

**The cookie model is a proposal, not an approved contract change.** The approved API contract **v0.4 §3.0** is bearer-only: every protected endpoint requires `Authorization: Bearer <token>`, `AUTH_MODE=dev` is the only supported mode, and the frontend keeps the token in memory mirrored to `sessionStorage` and "never uses `localStorage`, **cookies**, URLs, logs or `VITE_*` variables". AD-1 v0.5 §3.3.4 applies the same to the stream, and AD-9 §3.5 states the stream request "sends no cookies and follows no redirects" and requires that "whatever AD-10 selects for authentication, these failure semantics must be kept or AD-10 must state each change". Until an approved contract revision says otherwise, **v0.4 stands unchanged and every rule in §4.2 to §4.4 is proposed.**

**1. Contract and OpenAPI revision path** (none of it started; decision **AD10-D16**):

| Step | What | Owner, approver |
|---|---|---|
| a | A contract revision (v0.5, or an approved v0.4 amendment — the form is the owner's) replacing §3.0: the session model; the login, callback and logout endpoints; the CSRF header requirement on mutations; `403` for an origin or CSRF refusal; `503` for a session-store failure; the rate-limit and store-failure error codes (§4.3 item 9, §5.3) | Dev B drafts; reviewers per D-23; **owner approves** |
| b | `contracts/openapi/app.v1.yaml` updated in the **same** change: security scheme, new endpoints, new error codes. The OpenAPI files stay **DRAFT** and non-normative (contract status line) | Dev B, Dev C |
| c | The stream contract (AD-1 §3.2, §3.3.4) revised for the credential and the origin check; the path, framing and messages are unchanged | Dev B, Dev C; owner |
| d | AD-9 §3.5 revised to state each change below, as AD-9 itself requires | AD-9's author; owner |
| e | Only then, implementation in milestone 3.2 | Not authorized by this document |

**2. Frontend components that change** (verified at `4424b45`; changed only in milestone 3.2, with Dev C):

| Component | Today | Under the proposal |
|---|---|---|
| `services/web/src/api/client.ts` | Adds `Authorization: Bearer`, sends `credentials: "omit"` | No header; `credentials: "same-origin"`; adds the CSRF header on mutations |
| `services/web/src/auth/AuthProvider.tsx` — `openObservationStream` | Bearer header, `credentials: "omit"`, `redirect: "error"`; on 401 calls `expire()` **only if a token was present** (`if (response.status === 401 && token)`) | No token exists, so the 401 rule must be **re-based on the session epoch**, not on token presence, or a cookie-session 401 would never end the session |
| `AuthProvider.tsx` — sign-in, token store, `signOut` | A pasted development token in memory and `sessionStorage` | A redirect to the backend login; no token in browser code; sign-out calls the logout endpoint |
| `services/web/src/auth/AuthContext.ts`, `observationSession.ts` | Exposes `openObservationStream` | Signature kept (AD-7 §4) |
| Mock mode (MSW: `mock-viewer`, `mock-analyst`) | Token-based | Needs a cookie-equivalent mock, or stays dev-mode only |
| Superseded-session rule (AD-1 §3.3.4) | A late 401 from an earlier token is dropped | Kept, keyed on the session epoch |

**3. Compatibility during the transition:**

- **Development tokens are preserved unchanged until milestone 3.2 lands.** `AUTH_MODE` selects exactly one mode per process; there is **no dual-accept period** in which one backend honours both bearer tokens and cookies, because that would double the authentication surface the §5.1 rules have to cover. The existing refusal to start with `NODE_ENV=production` stays, and the pilot build can only run the session mode.
- **D-24 is not changed by this document.** The D-24 acceptance suite runs in dev mode and must keep passing there; the D-24 SSE contract keeps its path, framing, messages, freshness and reconnect rules, and only its credential and origin check change, once approved.
- **API contract v0.4 behaviour is preserved** for every endpoint in dev mode, including 401-before-405 (Q14) and Q19.

**4. AD-9 §3.5 semantics, each change stated:**

| AD-9 §3.5 rule | Under the proposal |
|---|---|
| A 401 on the stream is a permanent stop | **Kept** |
| The stream hands a 401 to the same session-expiry handling; a late 401 from a superseded session is dropped | **Kept**, but the trigger is re-based on the session epoch (table above) |
| The credential is never put in a URL, a log or another origin | **Kept**; the cookie is `HttpOnly` and never readable by script |
| The stream request sends **no cookies** and follows no redirects | **Changed:** it sends the session cookie, same-origin only. It still follows no redirects |
| An authentication failure on the stream never changes routing | **Kept** |
| *(new)* Origin or Fetch Metadata refusal | **403**, which the client already treats as a stop (AD-1 §3.3 table) |
| *(new)* Session-store failure | **503**, which the client already treats as recoverable (§4.3 item 9) |
| *(new)* Role change | The stream closes and the reconnect **succeeds** (§4.3 item 6) |

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
- A required custom header (`X-Requested-With`) on **every state-changing request under `/api/`** — the `/api/v1` mutations **and** the `/api/rt/v1` ones, which today means AD-7's proposed `POST /api/rt/v1/context-claims` (Nisarga 2). A cross-site form cannot set it. v0.1 named `/api/v1` only, which would have left the context-claims endpoint protected by `SameSite=Strict` and the Origin rule alone.
- **Applicability rule, so a later endpoint cannot fall through:** the state-changing row of the Origin table and the custom header apply by **method and prefix** (any non-safe method under `/api/`), not by a list of routes. The OIDC callback is the one exception, because it is a top-level `GET` navigation protected by `state` (§4.2).
- No synchronizer token while the app stays same-origin and CORS stays off (`services/backend/src/app.ts:158`).
- **Evidence:** a cross-origin POST is refused, **on `/api/v1` and on `/api/rt/v1/context-claims`**; a POST without the custom header is refused on both; a stream request with a foreign `Origin` is refused before a slot is taken; a same-origin request passes.

### 5.2 Content Security Policy

Set at Nginx, in **report-only mode first**, then enforced before Gate 4:

```text
default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self';
img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none';
frame-ancestors 'none'; form-action 'self' <IdP origin>
```

**`form-action` and the IdP origin (Varshini, non-blocking 7) — `[OPEN]`.** `<IdP origin>` is a placeholder and must not ship. Whether the IdP origin is needed at all depends on how login starts: if the browser **submits a form** whose response redirects to the IdP, some browsers apply `form-action` to the redirect target as well, so the IdP origin must be listed; if login starts by a plain **navigation** to the backend's login endpoint, `form-action 'self'` is enough. The choice follows the IdP (AD10-D3) and the login flow (§4.5); until then the directive is unresolved and tested in report-only mode.

Also `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`, and HSTS once TLS exists. **Assumption to test:** the Vite build emits no inline script, and React's `style` props (one `.tsx` under `services/web/src` uses `style=`) are applied through the DOM, which `style-src` does not block. **Evidence:** the browser suites run with zero CSP reports, then pass with enforcement.

### 5.3 Rate limits

| Layer | Limit `[#?]` | Reason |
|---|---|---|
| Nginx, per IP | `/api/` 20 req/s, burst 40; login and callback 10/min | Edge flood protection |
| Express, per user | Routing and comparison POSTs: 10/min and **2 in flight** | The engine pool has 2 workers and a queue of 32 with a 12 s deadline (`infra/env/inference.env.example`); one user must not fill the queue |
| Express, per user | **`/api/rt/v1` state-changing requests** (AD-7's context-claims `POST`): 30/min `[#?]` | v0.1 did not cover `/api/rt/v1` (Nisarga 2; Varshini's AD-7 review B2). The per-request rules of AD-7 §8 (one claim per request id, 5 min window) bound it further |
| Streams | 3/user, 20 total (unchanged until AD-8) | AD-1 §3.5 |

Responses: `429` with `Retry-After`, in the contract v0.4 error envelope. A new error code would need a contract change. **Corrected reference (Varshini B3):** v0.1 said the code would be chosen "in AD-7"; AD-7 does not choose it and is not the place to, because a new `/api/v1` error code is a contract revision. It is chosen in the §4.5 contract revision `[OPEN]`.

**Per-IP limits behind Docker NAT (Varshini, non-blocking 4) — assumption to test.** Nginx sees the address of whatever delivers the connection to the container. With Docker's published ports, especially Docker Desktop on Windows and macOS and the Linux userland proxy, that can be the **Docker gateway for every client**, which would turn a per-IP limit into one global limit and let one client exhaust it for all. Dev D verifies what address Nginx sees on each supported engine; if it is the gateway, the per-IP row is **ineffective** until a front proxy supplies a trusted client address, and only the per-user limits apply. In the single-host pilot with named users this is a weaker control, not a gap in the per-user one.

**Evidence:** one user receives 429 while a second user still succeeds; ENGINE_BUSY rates fall under load; the context-claims endpoint returns 429 past its limit.

### 5.4 TLS

Nginx terminates **TLS 1.2 or later** for any exposure, with HSTS. Internal bridges stay plain HTTP on one host, as an accepted residual (§9). PostgreSQL TLS is not required on a single host `[#?]`. **Evidence:** a TLS scan of the published port; no plain-HTTP listener is exposed except a redirect.

### 5.5 Secrets

Move the database passwords, the OIDC client secret and the session-signing key from `env_file` to **Compose `secrets:`** files outside the checkout; no secret in an image, a build argument or a `VITE_*` variable (`PHASE2_ARCHITECTURE.md` §8.3); a documented rotation procedure. **Backend code dependency (Varshini, non-blocking 5):** Compose secrets are mounted as **files** (`/run/secrets/…`), while the backend and Prisma read `DATABASE_URL` from the **environment** today. Moving the passwords to files therefore needs either backend configuration code that reads a `*_FILE` variable, or an entrypoint that builds the environment variable from the file before the process starts. Either is a backend change in milestone 3.2 and is **not authorized here**; neither touches a T-7-protected path, but both need review. **Evidence:** `e2e/stack-security.py` extended so that no secret value appears in `docker inspect` environment or image history; the tracked-secret-files check stays required.

### 5.6 Database roles

Verified: runtime code never updates or deletes Phase 2 records; only the seeder upserts `User` (`services/backend/src/db/seedDevUsers.ts:34`).

| Role | Privileges | Used by |
|---|---|---|
| `cbdc_owner` | DDL; owns the schema | `migrate` only |
| `cbdc_app` | **SELECT, INSERT** on business and audit tables (`TransactionRequest`, `RoutingDecision`, `Allocation`, `Comparison`, `Explanation`, `AuditLog`); **no UPDATE or DELETE**, which enforces contract §6.1's append-only rule; SELECT, INSERT, UPDATE and DELETE **only** on the session table | `backend` |
| `cbdc_security_log` | INSERT on the security-event table only | `backend`, for **ordinary** security events written outside any other transaction (§6 default). **Corrected (Nisarga 1):** v0.1 said "separate connection or `SET ROLE`"; a separate connection **cannot** share a transaction, so it cannot serve §6 case (a). How a privileged mutation and its security event commit together is **§6.1** |
| `cbdc_retention` | DELETE on rows past retention in the session and security-event tables, and in the Phase 3 families proposed in AD-11 v0.2 §9 (draft, PR #35); never on Phase 2 business records | A scheduled job (milestone 3.7) |
| `cbdc_seed` | INSERT, UPDATE on `User` | Development seeding only |
| Inference | **None** (AD-6 B-5 holds today: `infra/env/inference.env.example` has no `DATABASE_URL`) | — |

Business append-only (no UPDATE or DELETE) is kept apart from the **mutable** session privileges and the **retention** privilege. Observation-store roles are proposed in AD-11 v0.2 (§9, §9.1, draft). The test database needs the same split (backend integration tests run against it).

**INSERT-only `cbdc_app` with Prisma and the Phase 2 tests (Varshini, non-blocking 6) — partly verified, partly an assumption.** Verified at `4424b45`: runtime code issues no update or delete on Phase 2 records; the only `upsert` is the seeder's (`seedDevUsers.ts:34`), which is `cbdc_seed`'s. **Found incompatible:** the backend integration suite resets its tables with `TRUNCATE … CASCADE` through the same Prisma client (`services/backend/test/integration/transactions.test.ts:157-158`), which an INSERT-only role cannot do. Running "the Phase 2 suites as `cbdc_app`" therefore needs the test harness to clean up through a **separate, privileged fixture connection**, while the code under test keeps `cbdc_app`. That is a test-harness change for the implementing milestone, **not authorized here**. Prisma migrations already run as the schema owner (`migrate`), and Prisma Client's `create` needs only INSERT and, for returned rows, SELECT — an **assumption to test**, not verified.

**Evidence:** UPDATE or DELETE as `cbdc_app` on a business table fails; the Phase 2 suites pass with the code under test connected as `cbdc_app` and cleanup on a separate fixture connection.

### 5.7 Authorization model (Varshini B1)

**Existing, approved, and unchanged here** (contract v0.4 §3.0, §3.1, §3.2):

| Resource or action | Who may | Enforcement point | Source |
|---|---|---|---|
| Create a transaction or comparison | Any authenticated user | Express, after authentication | Contract §3.1 |
| Request `ppoProjected` | **`analyst` only**; anyone else gets `403 FORBIDDEN_POLICY`, checked before anything that depends on server state | Express | Contract §3.0, §3.2 |
| Read transactions, comparisons, explanations and the dashboard | **Any authenticated user reads every user's records.** "Per-user visibility is not a Phase 2 requirement" | Express | Contract §3.1 |
| Open the observation stream | Any authenticated user, 3 per user, 20 in total | Express | AD-1 v0.5 §3.2, §3.5 |

**This document does not change record visibility.** Introducing per-user visibility of transactions and comparisons would be a contract change and is **not proposed**; it is recorded as an open question for the owner (AD10-D18), not decided.

**Proposed for Phase 3** (each depends on the document named, none approved):

| Resource or action | Proposed rule | Enforcement point | Depends on |
|---|---|---|---|
| Receive a `route_status` | Only streams of the user who submitted the request; checked at every send | Express stream hub | AD-7 v0.2 §5 (draft) |
| Submit a context claim | Only the user who owns the referenced request, within its window | Express, the context-claims handler | AD-7 v0.2 §8 (draft) |
| Act as a **reviewer** (approve or refuse a quarantined item) | A user holding a **`reviewer`** role **at the time of the action**, checked per action, not per session | Express review module | AD-11 v0.2 §6 (draft); AD-12 v0.3 §6.2 |
| Revoke another user's session; grant an application role | An **administrator** capability | Express | **Unresolved**: no administrator role exists in v0.4, and whether one is held in the application or only in the IdP is AD10-D3's |

**Where roles come from.** Today `viewer` and `analyst` are read from the hashed development-token file (contract §3.0). Under the proposal they come from **IdP claims**, mapped by an explicit allowlist in the backend (an unknown claim value grants nothing). `reviewer` is a **new** role that v0.4 does not have; adding it to what `/api/v1/auth/me` returns is a contract matter for the §4.5 revision.

**Reviewer authorization and separation of duties — the AD-12 dependency.** AD-12 v0.3 §6.2 leaves "reviewer authorization and separation of duties" `[PENDING: AD-10, AD-11]` with four questions. Their status after this revision:

| AD-12 v0.3 question | Answer | Status |
|---|---|---|
| Who may review | A user holding `reviewer` at the time of the action (above) | **Proposed** here and in AD-11 §6 |
| May a reviewer review an item they submitted or caused to be submitted | No, comparing IdP (`iss`, `sub`) pairs, waivable only by a recorded owner waiver | **Proposed** in AD-11 §6; **owner decision AD11-D9**, not resolved here |
| Is a second reviewer required for some categories | — | **Open**, not answered by AD-10 or AD-11 |
| How an authenticated identity maps to the reviewer reference | AD-11 §6 P-10 mapping | **Proposed** in AD-11 (draft) |

AD-12's separate `[OPEN]` item — who may release a quarantined **FX** observation — is not an authorization rule this document can set and stays open.

## 6. Security-event logging

**Q19 is preserved:** an `AuditLog` row exists only with a persisted record, in the same transaction; a rejected request writes none (contract §6.2). Security events go to a **separate** log.

| Item | Rule |
|---|---|
| Events | Login success and failure; logout; session expiry and revocation; 401; 403 (`FORBIDDEN_POLICY` and others); CSRF or origin refusals; rate-limit hits; stream refusals (429 `STREAM_LIMIT`) |
| Fields | Time; event type; subject ID if known; session ID **hash**; request ID; client IP truncated to /24 (IPv4) `[#?]`; route; outcome |
| **Never logged** | Tokens, cookies, session IDs in clear, OIDC codes, `state`, `nonce`, PKCE verifiers, passwords, `Authorization` headers, request or response bodies |
| Transaction | **Default: outside** every other transaction: a security-log failure never fails, blocks or rolls back a request, a routing record or an `AuditLog` write. **One exception**, the database-backed privileged mutations under "Fail-closed decisions" below, whose **mechanism is §6.1** (unexecutable under v0.1's roles). Routing records and `AuditLog` are never in a transaction with a security event, so Q19 is unchanged |
| Bounds | An in-memory queue of at most 10,000 entries `[#?]`; when full, new entries are dropped and a counter rises; repeated identical events are aggregated per minute |
| Failure handling | On a database write failure, emit the same redacted entry to the structured stdout log and count it; never retry inside the request |
| **Durable vs fallback** | Only the database table is the **durable** security log. Stdout is a **fallback, not durable**: container logs rotate and are lost with the container, and nothing guarantees they are retained or complete. Fallback entries are never counted as Gate 4 audit evidence |
| **Degraded mode** | Entered when a durable write fails or the queue drops an entry; left after 60 s `[#?]` of successful writes. While degraded: a `security_log_degraded` gauge is set, an alert fires, every fallback entry carries `durable: false`, and the drop count is reported when the mode ends. **Corrected reference (Varshini B3):** v0.1 attributed this to "AD-8 draft §7"; **AD-8 v0.5 §7.1 and §7.3 contain neither the gauge nor the alert.** Both are **proposed here** and must be added to AD-8's metric catalogue and alert table by AD-8's owner if adopted; until then they exist in no document but this one |
| **Fail-closed decisions** | Ordinary requests, sign-in and sign-out **fail open** (never blocked by logging), so a logging fault cannot lock users out or affect routing (AD6-Q2). **Fail closed** only for privileged, security-relevant changes whose trace must be durable, and the rule differs by where the change lives:<br>(a) **Database-backed privileged mutations** made by the backend (an application role grant, an administrator's session revocation, a review approval or refusal, a reviewer-identity row in the P-10 family proposed by AD-11 v0.2): the security event is written **in the same database transaction** as the mutation, so both exist or neither does, by the mechanism of **§6.1**. These are security and review records, not routing records; no `AuditLog` row is involved, so Q19 is unchanged. If the durable log is unavailable the mutation is refused with 503, the refusal goes to the stdout fallback (not durable), and nothing partial remains.<br>(b) **External privileged actions** the backend does not perform in its own database (a role or account change made in the IdP, an IdP-side session revocation): no shared transaction is possible. The backend **enforces** what it learns (it denies on the next check, AD-10 §4.3) whatever the log state, and writes the security event when it learns of the change; if the durable log is unavailable then, the event goes to the fallback, is marked `durable: false`, and the gap is reported. Enforcement never waits on logging.<br>The stdout fallback is **never** sufficient evidence for (a). Decision AD10-D12 |
| Storage | A PostgreSQL table, insert-only for the application (§5.6), plus structured logs; retention 90 days `[#?]`; schema **proposed in AD-11 v0.2 (P-7; draft, PR #35)** |
| Context records | Browser-reported displayed context (AD-6 §6.1) is a **separate, untrusted** record (Dev C), not a security event and not an audit row; AD-7 (draft) proposes its capture, AD-11 (draft) its storage |

**Evidence:** a 401 writes one security event and **no** `AuditLog` row; with the security table unavailable, requests still succeed and the fallback log has the entry; a log scan finds no token, cookie or `state` value.

### 6.1 How a privileged mutation and its security event share one transaction (Nisarga 1)

**The problem v0.1 left.** Case (a) needs the mutation and its security event in **one** transaction. A transaction belongs to one database connection. v0.1's §5.6 gave `cbdc_app` no privilege on the security-event table and had `cbdc_security_log` used "on a separate connection or `SET ROLE`" — a separate connection cannot join the transaction, and `SET ROLE` needs a role membership v0.1 did not grant. The requirement was therefore not executable. AD-11 v0.1 §6 and §9 inherited the same gap, and the owner's review of AD-11 raised it too.

**Executable options**, written identically in AD-11 v0.2 §9.2 so the two documents cannot diverge:

| Option | In one transaction, on one connection | Separation kept | Cost or risk |
|---|---|---|---|
| (a) Role switch | `cbdc_app` is a `NOINHERIT` member of `cbdc_security_log`; the mutation, then `SET LOCAL ROLE cbdc_security_log`, the security-event INSERT, `RESET ROLE`, COMMIT | **Weakened**: `cbdc_app` can assume the logging role at any time and insert arbitrary events (it still cannot update or delete them) | Role state on pooled connections must be reset on every path, including errors; raw SQL inside Prisma's interactive `$transaction` |
| (b) Direct grant | `cbdc_app` gets INSERT on the security-event table | **Weakened most**; the separate role becomes nominal | Simplest |
| (c) Definer function | A `SECURITY DEFINER` function owned by a non-login role with INSERT on the table, with a pinned `search_path` and a fixed typed signature; `cbdc_app` holds only EXECUTE on it | **Kept**: `cbdc_app` holds no table privilege and can write an event only in the shape the function allows | DDL under `cbdc_owner` needing its own review and test; an escalation surface if `search_path` is not pinned |
| (d) Leave the mechanism unresolved | The requirement only | — | §6 case (a) and AD10-D12 **cannot be accepted** until it is resolved |

**Provisional preference: (c).** **Not decided:** **AD10-D14**, decided **jointly** with AD-11's **AD11-D10**. Nisarga's review allows either a feasible model or an explicitly unresolved mechanism; the owner's review of AD-11 asks for an executable one. Choosing between (c) and (d) is therefore the owner's, and this document does not choose. Ordinary security events are unaffected: they stay outside every other transaction and use `cbdc_security_log` directly.

## 7. Gate 4 prerequisites (aligned with AD-13)

**AD-10's review or approval cannot pass Gate 4 (Varshini, non-blocking 8).** Approval of this document approves a **design**. Gate 4 needs **runtime** and **deployment** evidence that does not exist, and no item below is met today.

**Corrected reference (Varshini B3).** v0.1 cited AD-13 at `3929156` and said it lacked the security-event log, database roles and `main` protection. **AD-13 v0.3** (PR #31, merged into `feature/phase3-platform`, still DRAFT) §3.3 already has **G4-1** (separate security-event logging preserving Q19), **G4-2** (database-role and privilege verification), **G4-3** (inference-isolation positive controls), **G4-4** (cookie sessions, origin validation and applicable CSRF) and **G4-5** (owner-controlled `main` protection). The record uses AD-13's common template (§3.1 there). The items below map to them and separate three kinds of evidence:

| # | Item | Design (this document) | Runtime test evidence | Deployment evidence | AD-13 v0.3 |
|---|---|---|---|---|---|
| 1 | **B-4 closed** and D-25 retired | §3 | §3.6 probes 1–8, §3.4 invariants, T-1, T-2, T-6, T-7 in CI on the merged commit | Owner records closure (§3.6 stage 4) | G4-3 |
| 2 | Milestone 3.2: OIDC sessions, dev mode impossible in the pilot build, CSP enforced, CSRF and origin | §4, §4.5, §5.1, §5.2 | §4.3 item 7; §5.1 evidence; zero CSP reports then enforced | Pilot build refuses dev mode; contract revision approved (§4.5) | G4-4 |
| 3 | Rate limits | §5.3 | §5.3 load test | Per-IP behaviour verified on the pilot host | — |
| 4 | TLS on the published port | §5.4 | — | TLS scan of the published port | — |
| 5 | Secrets in Compose secrets | §5.5 | `e2e/stack-security.py` extended | No secret in `docker inspect` or image history on the pilot host | — |
| 6 | Database roles split, append-only enforced | §5.6, §6.1; AD-11 §9 (draft) | UPDATE/DELETE refused per role | Roles present on the pilot database | **G4-2** |
| 7 | Audit trail and security-event log | §6; AD-11 (draft) | 401 → one security event, no `AuditLog` row | Durable table present; degraded-mode alert wired | **G4-1** |
| 8 | Hardening and isolation probes, inference and ingestion | §3.2, §3.6 | Probes pass with positive controls | — | G4-3 |
| 9 | Monitoring, alerting, backup and a restore drill | §6 degraded mode (proposed metric) | Restore drill | Milestone 3.7 | — |
| 10 | AD-1 §4 placement confirmed (D-22) | — | — | Owner record | — |
| 11 | **Branch protection on `main` is owner-controlled.** The `phase3-acceptance` gate targets `feature/phase3-platform`; adding `main` is the owner's decision when Phase 3 merges there (`docs/PHASE3_D24_ACCEPTANCE.md` §6). This document requests nothing on it | — | — | Owner action | **G4-5** |
| 12 | **Session revocation propagation** | §4.3 | §4.3 item 7 per trigger | — | Not in AD-13 v0.3 (C10-4) |

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
| AD10-D7 | Rate limits | Edge only; edge plus per user | **Both** (§5.3), covering `/api/rt/v1` mutations | AD-8 for final numbers; **the §4.5 contract revision** for the error code (corrected: not AD-7) | Owner | §5.3 load test |
| AD10-D8 | TLS scope | Edge only; also internal | **Edge only** on one host | — | Owner | TLS scan |
| AD10-D9 | Secrets | env files; Compose secrets; external vault | **Compose secrets** | — | Owner, Dev D | §5.5 checks |
| AD10-D10 | Database roles | One role; §5.6 split | **§5.6 split** | AD-11 | Owner, Dev A, Dev D | §5.6 tests |
| AD10-D11 | Security-event log | Inside `AuditLog` (breaks Q19); separate table; logs only; both | **Separate table (durable) plus stdout fallback (not durable)** (§6) | AD-11 (schema) | Owner, Dev A, Dev D | §6 tests |
| AD10-D12 | Behaviour when the durable security log is unavailable | Fail open everywhere; fail closed everywhere; fail closed for privileged changes only | **Fail closed for privileged changes only** (§6) | AD-11 review records | Owner, Dev C | Durable table down: sign-in works and is logged to fallback; a role change is refused with 503 |
| AD10-D13 | Stream revocation propagation (§4.3) | Next heartbeat only; immediate in-process plus heartbeat backstop | **Immediate plus backstop** | AD-7 (draft) | Owner, Dev C | §4.3 item 7 |
| **AD10-D14** | **Atomic privileged mutation and security event** (§6.1) | (a) role switch; (b) direct grant; (c) definer function; (d) unresolved | **(c), provisional**; decided **jointly with AD11-D10** | AD-11 v0.2 §9.2 | Owner, Dev A, Dev D | Mutation refused with nothing partial when the table is unavailable; `cbdc_app` holds no table privilege under (c) |
| **AD10-D15** | **Passive-dashboard idle expiry** (§4.3 item 12) | Accept; longer idle for read-only sessions; count visible-tab interaction | **Open — no recommendation** | AD-9 §3.5; Dev C | Owner, Dev C | Chosen behaviour tested on a watched, otherwise idle tab |
| **AD10-D16** | **Authentication transition path** (§4.5) | Contract revision then 3.2; no change | **Contract revision first**, then milestone 3.2; one `AUTH_MODE` per process; dev tokens unchanged until 3.2 | Contract owner; AD-9 revision; Dev C | **Owner** | Approved contract revision; D-24 suite passing in dev mode; AD-9 §3.5 revised |
| **AD10-D17** | **IdP role-change propagation interval** (§4.3 item 11) | Next login only; claim refresh on a timer; back-channel notification | **Open**, depends on the IdP | AD10-D3 | Owner, Dev B | A role removed in the IdP is enforced within the chosen bound |
| **AD10-D18** | **Record visibility and new roles** (§5.7) | Keep v0.4 (all users read all records); per-user visibility; `reviewer` and administrator roles | **Keep v0.4 visibility**; add `reviewer` only with AD-11; administrator **open** | Contract; AD-11; AD10-D3 | Owner | Role tests; v0.4 visibility unchanged |

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
| Session and security-event schemas; observation roles; the atomic-write mechanism (jointly) | **AD-11 v0.2 (PR #35, draft, not approved)** (Dev B) |
| Channel authentication text; `session_ended`; per-send ownership checks; context-claims endpoint | **AD-7 v0.2 (PR #34, draft, not approved)** (Dev B, with Dev C). **Corrected:** v0.1 also assigned AD-7 the rate-limit error code; AD-7 does not decide it (§5.3) |
| Contract and OpenAPI revision for cookie sessions | §4.5; contract owner; **owner approval** |
| AD-9 §3.5 revision | AD-9's author (§4.5 item 4) |
| Final latency and limit budgets; the proposed `security_log_degraded` metric and alert | AD-8 (Dev A) |
| Gate 4 template | AD-13 v0.3 (Dev D) |
| B-4 implementation and probe | Dev D |

- [ ] Dev C: §4, §5.1, §5.2, §6 context records
- [ ] Dev D: §3, §5.5, §7 alignment with AD-13
- [ ] Project owner: AD10-D1 to **AD10-D18**. **Approval of this document approves a design, not B-4 closure, and not a contract change.**

## 11. Conflicts with other drafts

| ID | With | Conflict | Path |
|---|---|---|---|
| C10-1 | AD-1 Part 2 **v0.4** §7.3, **§7.3.1** (PR #30; identical at `e457bcf` and `730f75a`) | **Narrowed.** v0.1 (`5f78500`) read as "`compose.yaml` unchanged by Phase 3"; v0.4 §7.3.1 makes that a **D-24 condition** and states an **approved** AD-10 change may modify `compose.yaml` to close B-4. Option A is compatible with that draft; the A-or-B choice remains a preference | AD10-D1a; owner |
| C10-2 | AD-3 **v0.3** §10 X-5 (PR #31, merged into `feature/phase3-platform`, DRAFT) | Same tension, recorded by Dev D; consistent with §3.7's T-7 correction | Same |
| C10-3 | Draft AD-6 Part 2 T-13 (PR #30) | Defines the inference-egress test; §3.6 probes 1–8 are a superset | Align IDs when both are approved; T-13 not run, not claimed |
| C10-4 | AD-13 **v0.3** §3.2, §3.3 (PR #31, head `15fd739`) | **Corrected again (Varshini B3).** v0.1's claim was stale: AD-13 v0.3 already has **G4-1** (security-event log), **G4-2** (database roles), **G4-4** (cookie sessions, origin, CSRF) and **G4-5** (`main` protection), besides B-4 on both sides, T-11 and AD-8 drills. **Only session-revocation propagation (§4.3) has no AD-13 item** | AD-13 to add a revocation item, or cite §7 item 12 |
| C10-5 | AD-8 **v0.5** §6.3 | Stream totals 20; AD-2 proposes 60 | AD-2 X-1 and AD-2 §5.1: AD-8 revised and re-approved before milestone 3.4 if adopted |
| **C10-6** | **API contract v0.4 §3.0 (approved)** | Bearer-only, no cookies, `AUTH_MODE=dev` only, vs §4's cookie sessions | **The contract wins** until the §4.5 revision is approved (AD10-D16). Nothing here amends it |
| **C10-7** | AD-9 §3.5 (draft, merged) | "The stream request sends no cookies" and "AD-10 must state each change" | §4.5 item 4 states each change; AD-9 to be revised |
| **C10-8** | AD-8 **v0.5** §7.1, §7.3 | No `security_log_degraded` gauge or alert, though v0.1 cited AD-8 for it | Proposed here; AD-8 to add if adopted |
| **C10-9** | AD-11 **v0.1** §6, §9 | The atomic P-5/P-7 write was unexecutable under both documents' roles | §6.1; joint AD10-D14 / AD11-D10; AD-11 v0.2 §9.2 matches |
