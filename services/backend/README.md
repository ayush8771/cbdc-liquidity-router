# CBDC Liquidity Router: Application Backend (Phase 2, Dev B)

The Express + TypeScript application backend for Major Phase 2. It serves the public Application API (`/api/v1/*`) to the web frontend, applies development-only authentication, calls the internal inference service, and persists requests, decisions, comparisons, explanations and audit rows in PostgreSQL through Prisma.

- **Architecture:** [`docs/PHASE2_ARCHITECTURE.md`](../../docs/PHASE2_ARCHITECTURE.md) ("arch §n" below).
- **API contract:** [`docs/PHASE2_API_CONTRACT.md`](../../docs/PHASE2_API_CONTRACT.md) ("§n" below). The approved v0.4 contract is normative. The OpenAPI files in [`contracts/openapi/`](../../contracts/openapi/) are DRAFT, machine-readable representations of it.
- **Project-level Phase 2 status:** [`docs/PHASE2_STATUS.md`](../../docs/PHASE2_STATUS.md).

This README describes the code on `feature/phase2-backend`. Where it summarises behaviour, the contract is the authority for what the API *should* do, and the source files named here are the authority for what it *does*.

## Contents

1. [Responsibilities and boundaries](#1-responsibilities-and-boundaries)
2. [Status](#2-status)
3. [Endpoint reference](#3-endpoint-reference)
4. [Inference integration](#4-inference-integration)
5. [Database and persistence](#5-database-and-persistence)
6. [Requirements, configuration and setup](#6-requirements-configuration-and-setup)
7. [Testing](#7-testing)
8. [Limitations and open items](#8-limitations-and-open-items)
9. [Layout](#9-layout)
10. [Notes and accepted advisory](#10-notes-and-accepted-advisory)

## 1. Responsibilities and boundaries

**The backend does:**
- **API surface:** the 15 method/path pairs of contract §3.1, with request IDs, the §4 error envelope and 405 handling.
- **Validation:** strict request bodies and query parameters (§1, §3.2–§3.8), *before* any inference call or database write.
- **Authentication and roles:** development bearer tokens (§3.0, arch §8). Only an `analyst` may request `ppoProjected`.
- **Inference orchestration:** calls to the nine documented `/v1/*` endpoints, mapping their snake_case bodies to camelCase (§3.2) and mapping their errors (§4).
- **Persistence:** append-only records with their audit rows (§6).
- **Dashboard:** aggregates over *stored* decision columns (§3.8).

**The backend does not:**
- **No routing or business logic.** It computes no allocation, feasibility, execution, reward, metric, regime, risk or `decision_id`. All of these belong to the inference service (Dev A), which wraps the Phase 1 engine. The mappers copy values and never compute a metric.
- **No domain validation the engine owns.** Corridor support, date range and gap buffers, scenario existence, venue/corridor matching, non-negative state values and history consistency are left to the engine, whose error codes the backend passes through (§2.4, §4).
- **No checkpoint decisions.** Whether `ppo_projected` is enabled is decided by the inference service's checkpoint registry (§7). `/api/v1/meta` passes `/v1/version`'s `checkpoint` through unchanged. The backend acts on it only for the explanation rule in §3.5.
- **No Phase 1 changes.** Nothing under `src/`, `tests/` or `data/` at the repository root is touched by this service.

**Request flow** (`POST /api/v1/transactions`, the longest path):

```text
web (Vite proxy) ──► requestId ─► requestLogger ─► route
                     ─► requireAuth (401) ─► jsonBody (400) ─► role check (403)
                     ─► validation (422) ─► seeded User row present? (500 if not)
                     ─► POST /v1/route (inference; never retried)
                     ─► map + validate the engine body (502 if invalid)
                     ─► one database transaction: record + audit row
                     ─► 201 (or the mapped inference error, with the failed record's id)
```

The server binds to `127.0.0.1:4000` by default (`src/server.ts`), because development auth must not be exposed beyond the developer's machine (arch §8.1). Only the container sets `BIND_HOST=0.0.0.0`, and Compose publishes its port on host loopback only (§6.2).

## 2. Status

| Area | State | Evidence |
|---|---|---|
| All 15 §3.1 method/path pairs | **Implemented** | `API_ROUTES` in [`src/app.ts`](src/app.ts); a unit test checks that each listed method is routed |
| Unit tests | **Passing.** Last verified 2026-11-16 at `5414275`: 1469 passed, 0 failed (Node 24.7.0) | `npm test` |
| TypeScript | **Clean.** Last verified 2026-11-16: `tsc --noEmit` and a full build both exit 0 | `npm run typecheck`, `npm run build` |
| PostgreSQL integration suites | **Previously reported as passing; not independently verified at the current commit.** A run on the pre-commit working tree reported 1543 passed (see §7.3). No run of the committed `5414275` is recorded in the repository | `test/integration/transactions.test.ts` |
| Live inference service | **Not integrated.** Every inference path is tested only against injected mock handlers | §8 |
| Fixture-backed mock mode | **Not implemented.** Its fixture selection rule (contract §10 Q20) is deferred; this does not block integration against a running inference service | §4.6 |
| Backend CI workflow (`phase2-backend.yml`, arch §5.4) | **Not created.** No CI job runs these tests | §8 |
| Docker image | **Not created** (no `Dockerfile`) | §8 |

"Implemented" means the code and its unit tests exist and pass. It does not mean the endpoint has been run against PostgreSQL at HEAD, against the real inference service, or end to end with the web app.

## 3. Endpoint reference

Every endpoint returns `X-Request-Id`: the caller's value, or a generated UUID (§1). Errors use the §4 envelope `{"error": {"code", "message", "details", "requestId"}}`, with the backend's own fixed messages. Engine messages are never forwarded, except `skipped[].message` in a comparison, which is part of a 201 and not an error (Q18). Request and response bodies are as specified in the contract sections linked below. This README does not restate them.

| Method | Path | Auth | Role rule | Inference call | Writes | Contract |
|---|---|---|---|---|---|---|
| GET | `/api/v1/health` | none | — | `/v1/health` | — | §3.9 |
| GET | `/api/v1/health/live` | none | — | — | — | §3.9 |
| GET | `/api/v1/auth/me` | bearer | any | — | — | §3.0 |
| GET | `/api/v1/meta` | bearer | any | `/v1/version` (cached) | — | §3.9 |
| GET | `/api/v1/network` | bearer | any | `/v1/network` (cached) | — | §2.3, §3.1 |
| GET | `/api/v1/scenarios` | bearer | any | `/v1/scenarios` (cached) | — | §2.7, §3.1 |
| GET | `/api/v1/replay/calendar` | bearer | any | `/v1/replay/calendar` (cached) | — | §2.6, §3.1 |
| GET | `/api/v1/state` | bearer | any | `/v1/state` (not cached) | — | §3.7 |
| POST | `/api/v1/transactions` | bearer | `ppoProjected`: analyst only | `/v1/route` | transaction (+ decision, allocations) + audit | §3.2 |
| GET | `/api/v1/transactions` | bearer | any | — | — | §3.3 |
| GET | `/api/v1/transactions/:id` | bearer | any | — | — | §3.4 |
| GET | `/api/v1/transactions/:id/explanation` | bearer | any | `/v1/version` (cached, PPO only), `/v1/explain` (first request only) | explanation + audit (first request only) | §3.5 |
| POST | `/api/v1/comparisons` | bearer | `ppoProjected`: analyst only | `/v1/compare` | comparison + audit | §3.6 |
| GET | `/api/v1/comparisons/:id` | bearer | any | — | — | §3.6 |
| GET | `/api/v1/dashboard/summary` | bearer | any | — | — | §3.8 |

History, comparisons, explanations and the dashboard show every user's records to any authenticated user (§3.1).

### 3.1 Cross-cutting behaviour

- **Authentication** ([`src/auth/devAuth.ts`](src/auth/devAuth.ts)):
  - **Header:** `Authorization: Bearer <64 hex>`, with the scheme matched in any letter case.
  - **Check:** the token is hashed with SHA-256 and compared with `crypto.timingSafeEqual` against every hash in the token file.
  - **Failure:** a missing, malformed or unknown token is `401 UNAUTHENTICATED`, with one message for all three.
  - **Never stored:** tokens and hashes are never logged, returned or persisted.
- **Role rule** ([`src/auth/policies.ts`](src/auth/policies.ts)): a non-analyst who asks for `ppoProjected` gets `403 FORBIDDEN_POLICY`.
  - It is checked on the raw body, before validation, inference and persistence.
  - Reading a stored record is not "requesting a policy", so a viewer may read a stored `ppoProjected` transaction, explanation or comparison.
- **405 METHOD_NOT_ALLOWED** ([`src/middleware/methodNotAllowed.ts`](src/middleware/methodNotAllowed.ts)):
  - Any unregistered method on a registered path, `OPTIONS` included, gets 405 with an `Allow` header.
  - `HEAD` is allowed wherever `GET` is, except on `/transactions/:id/explanation`, where it is 405 (after authentication), because that GET may call inference and write.
  - **Authentication comes first** (contract §3.0, owner decision Q14). On a protected path, an unsupported method without a valid token is `401 UNAUTHENTICATED`, with no `Allow` header; with a valid token it is 405 with `Allow`.
  - The fallback handler runs the same `requireAuth` middleware as the routes, and only for requests no route answered, so a token is checked once per request. Supported methods are unchanged.
  - The public paths `/api/v1/health` and `/api/v1/health/live` (`PUBLIC_PATHS` in [`src/app.ts`](src/app.ts)) skip authentication: an unsupported method there is 405 without a token.
- **Unknown paths:** `404 NOT_FOUND`, with or without a token.
- **JSON bodies** ([`src/middleware/jsonBody.ts`](src/middleware/jsonBody.ts)):
  - Accepted: `application/json`, UTF-8, at most 100 kB (`JSON_BODY_LIMIT`). The top level must be an object or array, and an empty body is rejected.
  - Compressed bodies are decoded by Express's JSON parser defaults; `gzip` is covered by a test. An unsupported `Content-Encoding` is rejected.
  - Every parse problem is `400 MALFORMED_REQUEST` with a backend-written message. That includes size, charset and encoding problems, because §4 has no 413 or 415 code.
- **Validation:** each problem is reported as a `422 VALIDATION_ERROR` item `{field, message}` in `details.errors[]`, all at once.
  - A form-level error omits `field` (§4). Messages never echo caller values.
  - Query parameters: a documented parameter given twice is rejected; unknown parameters are ignored (§3.3).
- **`:id` parameters** (`/transactions/:id`, `/transactions/:id/explanation`, `/comparisons/:id`):
  - Anything that isn't UUID syntax returns `404 NOT_FOUND`, like an unknown UUID, without touching the database.
  - This is the owner decision Q11a (contract §3.4).
- **Database errors** and missing configuration (no `DATABASE_URL` for a database route) return `500 INTERNAL_ERROR`. Prisma errors are logged with class name and code only, never their message.
  - How such failures should be reported to callers is not defined by the contract (§6.2; `docs/TEAM_REVIEW_RESOLUTION.md` §6).

### 3.2 Per-endpoint notes

- **`GET /api/v1/health`** (readiness; [`src/routes/health.ts`](src/routes/health.ts)). It returns `{status, database, inference, authMode, time}`:
  - **Database unavailable:** HTTP 503, `status: "unavailable"`.
  - **Database ok, inference `ok` or `mock`:** HTTP 200, `status: "ok"`.
  - **Database ok, inference `degraded` or `unavailable`:** HTTP 200, `status: "degraded"`.
  - The 503 body is the Health object, not the error envelope. The database probe is `SELECT 1` with a 3 s timeout, with at most one probe query in flight. The inference probe is described in §4.4.
- **`GET /api/v1/health/live`:** liveness. HTTP 200 with exactly `{"status": "ok"}`; it checks no dependency.
- **`GET /api/v1/auth/me`:** `{userId, email, role, authMode, permissions: {experimentalPolicies}}`.
- **`GET /api/v1/meta`:** the camelCase `/v1/version` body, plus `backendVersion` (the `version` in `package.json`) and `inferenceMode`.
  - The `/v1/version` body is validated before it is cached (`src/mappers/versionResponse.ts`).
  - An engine key that collides with either added field is a 502.
- **`GET /api/v1/network`, `/scenarios`, `/replay/calendar`:** the camelCase engine body, read through the shared cache.
  - Keys are mapped and values are unchanged. Unknown fields are kept (§1).
  - Two engine keys that map to the same camelCase name are a 502.
- **`GET /api/v1/state`** ([`src/routes/state.ts`](src/routes/state.ts)). Query parameters:
  - `corridor`: required.
  - `mode`: `historicalReplay` or `scenario`; `explicit` is refused.
  - `date`: a real `YYYY-MM-DD` date.
  - `scenarioId`: required with `scenario`, refused with `historicalReplay`. Any string passes, and an unknown one is passed to the engine's `UNKNOWN_SCENARIO` (§3.7).
  - `includeHistory`: `true` or `false`.
- **`POST /api/v1/transactions`** ([`src/routes/transactions.ts`](src/routes/transactions.ts)). The order of checks is shown in §1. Validation follows [`src/validation/transactionRequest.ts`](src/validation/transactionRequest.ts):
  - **Strict at every level:** unknown fields, top-level ones included, are rejected.
  - `senderCountry` and `receiverCountry` must be `^[A-Z]{3}$`.
  - `amountUsd` must be a finite number.
  - `policy` must be one of the three names; omitted means `waterfall`, and `null` is rejected.
  - `clientReference` is at most 200 Unicode code points, or omitted or null.
  - **Unsafe integers:** integer-valued numbers above 2⁵³ − 1 are rejected, never rounded (§2.11).
  - **History:** each array has exactly 30 values.
  - **Precedence:** every schema problem comes first as `VALIDATION_ERROR`. Only for an otherwise valid body, an `amountUsd` ≤ 0 gives `422 INVALID_AMOUNT` with `details.field` (§3.2).

  Outcomes:

  | Inference outcome | Response | Saved (one database transaction) |
  |---|---|---|
  | 200 that maps and validates, including a regulatory rejection (`allowed: false`) | 201 `{id, createdAt, createdBy, status: "routed", transaction, failure: null, decision}` | routed `TransactionRequest`, `RoutingDecision`, its `Allocation` rows, `AuditLog` `SUCCESS` |
  | Unreachable/timeout, `NOT_READY`, `ENGINE_BUSY`, `ENGINE_TIMEOUT`, other 5xx or an invalid body | the mapped 502/503/504, with `details.transactionId` | failed `TransactionRequest` with `failureCode`, `AuditLog` `FAILED` |
  | Engine 422 codes, or `409 POLICY_DISABLED` | passed through with the backend's text | nothing, no audit row |
- **`GET /api/v1/transactions`:** paginated history, newest first, with `id` DESC as the tie-break. Filters:
  - `page` (a positive whole number, default 1) and `pageSize` (1–100, default 20);
  - `corridor`, `policy` and `stateMode`;
  - `completed`, which never matches a failed row;
  - `from` (inclusive) and `to` (exclusive), as full UTC timestamps;
  - `sort`, which accepts only `createdAt:desc`.

  The page and `total` come from one REPEATABLE READ snapshot. A failed item's decision fields are null.
- **`GET /api/v1/transactions/:id`:** the same body as the 201.
  - **Routed:** rebuilt from the stored `engineResponse`.
  - **Failed:** `decision: null`, `transaction.corridor: null` and `failure: {code, message}`.
  - **Legacy failed rows:** a failed row saved before the `failureCode` migration has no code and returns `failure: null` (see §8).
- **`GET /api/v1/transactions/:id/explanation`** ([`src/routes/explanations.ts`](src/routes/explanations.ts)), in order:
  1. A failed transaction returns `409 TRANSACTION_FAILED`.
  2. A stored explanation is returned unchanged.
  3. For a `ppoProjected` decision only, the cached `/v1/version` is checked. With no enabled checkpoint it is `409 POLICY_DISABLED`; with a different checkpoint hash it is `409 DECISION_MISMATCH` (Q17).
  4. `POST /v1/explain` with the stored request. An engine `409 POLICY_DISABLED` passes through.
  5. A `decision_id` that differs from the stored one is `409 DECISION_MISMATCH`.
  6. The explanation is saved with its audit row and returned as `{transactionId, …}`. If two first requests race, one row and one audit row are kept, and both callers receive it.
- **`POST /api/v1/comparisons`** ([`src/routes/comparisons.ts`](src/routes/comparisons.ts), [`src/validation/comparisonRequest.ts`](src/validation/comparisonRequest.ts), [`src/mappers/compareResponse.ts`](src/mappers/compareResponse.ts)). The request is the §3.2 body with `policies` in place of `policy` (owner decision Q18):
  - **Aliases:** `baseline` → `waterfall` and `ruleBased` → `cheapestFeasible`, mapped in place, so the caller's order is kept. Only canonical names are sent, stored and returned.
  - **Invalid lists:** two entries naming the same policy (alias or not) are a `VALIDATION_ERROR`. So are `policies: null` and an empty list.
  - **Default for an omitted `policies`:** `waterfall`, `cheapestFeasible`, `ppoProjected` for an analyst, and `waterfall`, `cheapestFeasible` for a viewer. A viewer listing `ppoProjected` gets 403.
  - **What the backend sends:** always the resolved list to `/v1/compare`. It makes no checkpoint check of its own. A disabled policy comes back in `skipped`, and the comparison is still saved.
  - **Response checks:** a result for a policy that wasn't sent, or any inconsistency in corridor, state frame or `same_state`, is a `502 INFERENCE_ERROR`. So is a result whose provenance doesn't confirm the effective state (mode, state date, scenario), or an engine `409 POLICY_DISABLED`.
  - **Response body:** 201 with `{id, createdAt, createdBy, transaction, state, policies, results, skipped, sameState, note}`.
    - `results` and `skipped` follow `policies`' order.
    - `skipped[].message` is the engine's text, unchanged.
    - `transaction.corridor` is null only when every policy was skipped.
  - **Persistence:** only on a `/v1/compare` 200. No transaction record is created, and any error saves nothing and carries no `transactionId`.
- **`GET /api/v1/comparisons/:id`:** the same body, rebuilt from the stored row and `engineResponse` without calling inference.
- **`GET /api/v1/dashboard/summary`** ([`src/routes/dashboard.ts`](src/routes/dashboard.ts), [`src/db/dashboard.ts`](src/db/dashboard.ts)). Filters are `from`, `to`, `corridor` and `policy`.
  - **Window:** an omitted bound is unbounded and echoed as `null` (owner decision A3).
  - **Computation:** done in PostgreSQL from stored decision columns, never from allocations or `engineResponse`; see §5.4.
  - **Exclusions:** comparisons are never included.

## 4. Inference integration

### 4.1 Endpoints consumed

[`src/inferenceClient/client.ts`](src/inferenceClient/client.ts) is the only module that calls the inference service. It accepts only the nine documented paths, and any other path is refused without a call:

- GET: `/v1/health`, `/v1/version`, `/v1/network`, `/v1/state`, `/v1/replay/calendar`, `/v1/scenarios`;
- POST: `/v1/route`, `/v1/compare`, `/v1/explain`.

**Headers:** only `Accept`, `Content-Type` (POST) and `X-Request-Id` are sent. The client never sees the incoming request, so `Authorization`, tokens and cookies can't be forwarded (§5).

**Redirects** are not followed; a 3xx is an invalid response.

### 4.2 Timeouts and retries (as implemented)

- **Timeout:** `INFERENCE_TIMEOUT_MS` (default 15000) bounds each whole call, response body included. A timeout is `503 INFERENCE_UNAVAILABLE`.
- **No retries.** POST is never retried (§5). §5 *permits* one GET retry; it is not used, and nothing requires it.
- **Health probe:** it uses the same `INFERENCE_TIMEOUT_MS`. See §8 for why that matters.

### 4.3 Error mapping

From [`src/inferenceClient/errors.ts`](src/inferenceClient/errors.ts). Messages are always the backend's own text.

| Inference outcome | Application response |
|---|---|
| Unreachable or timed out; no client configured; mock mode with no answer | `503 INFERENCE_UNAVAILABLE` |
| `503 NOT_READY` | `503 INFERENCE_UNAVAILABLE`, `details.cause: "NOT_READY"`, `Retry-After` forwarded |
| `503 ENGINE_BUSY` | same code and status, `Retry-After` forwarded |
| `504 ENGINE_TIMEOUT` | same code and status |
| Engine 422s: `VALIDATION_ERROR`, `UNSUPPORTED_CORRIDOR`, `INVALID_AMOUNT`, `DATE_OUT_OF_RANGE`, `DATE_IN_GAP_BUFFER`, `UNKNOWN_SCENARIO`, `STATE_VENUE_MISMATCH`, `INVALID_STATE_VALUE`, `POLICY_UNAVAILABLE_FOR_STATE` | passed through. Engine field paths are mapped to app paths through an explicit table ([`src/inferenceClient/fieldPaths.ts`](src/inferenceClient/fieldPaths.ts)); an unmappable path is dropped. Other details are dropped |
| `409 POLICY_DISABLED` | passed through only by `/v1/route` (transactions) and `/v1/explain` (explanations), which opt in. Elsewhere, `/v1/compare` included, it is `502` |
| Any other code or status, a status/code mismatch, non-JSON, a non-object body, or a 200 that fails the endpoint's response validation | `502 INFERENCE_ERROR` |

`Retry-After` is forwarded only for `ENGINE_BUSY` and `NOT_READY`, and only when it is a valid integer number of seconds; otherwise it is dropped.

### 4.4 Inference status in `/api/v1/health`

[`src/inferenceClient/health.ts`](src/inferenceClient/health.ts) reads only `ready` and `status` from `/v1/health`:

| Answer | `inference` |
|---|---|
| 200, `ready: true`, `status: "ok"` | `ok` |
| 200, `ready: true`, `status: "degraded"` | `degraded` |
| 503 not ready, a `NOT_READY` envelope, a timeout, an unreachable service, any other answer, or no client | `unavailable` |
| `INFERENCE_MODE=mock` (no call is made) | `mock` |

### 4.5 Shared cache and invalidation

[`src/inferenceClient/cache.ts`](src/inferenceClient/cache.ts) holds one in-memory cache per app instance, filled lazily:

- **What is cached:** `/v1/version`, `/v1/network`, `/v1/replay/calendar` and `/v1/scenarios`. `/v1/state` and the POST endpoints are never cached.
- **Version refresh:** `/v1/version` is re-fetched once 30 s (`VERSION_REFRESH_MS`, a constant) have passed since the last successful fetch. Every cached read first makes sure the version is fresh.
- **Invalidation:** each refresh computes the §5 fingerprint. It covers `git_commit`, `engine_version`, `reward_weights`, `knowledge.sha256`, the `data.*_sha256` hashes (daily state, bridge network, normalisation stats, macro-risk proxy, RPW corridor quarterly, scenarios) and `checkpoint.sha256`. When the fingerprint changes, the cached network, calendar and scenarios are dropped.
- **Failures:** a version body that fails validation is a 502 and is not stored. Failures are never cached, and a failed version refresh fails the dependent read, so no resource is served past a failed refresh.
- **Concurrency:** concurrent callers share one in-flight fetch per resource.

### 4.6 Mock mode (current limitation)

`INFERENCE_MODE=mock` makes no network call: the client answers only from an injected `mockHandler`. **The server (`src/server.ts`) injects none.** When no mock handler is injected, mock mode behaves as follows:
- **Inference-backed routes return `503 INFERENCE_UNAVAILABLE`.** These are the routes that call inference: `/meta`, `/network`, `/scenarios`, `/replay/calendar`, `/state`, `POST /transactions`, `POST /comparisons`, and `/transactions/:id/explanation` when no explanation is stored yet. Like any 503 from inference, `POST /transactions` saves a failed transaction (§3.2).
- **Routes that don't call inference are unaffected.** That covers `/health/live`, `/auth/me`, `GET /transactions`, `GET /transactions/:id`, `GET /comparisons/:id`, `/dashboard/summary`, and a stored explanation.
- **Health is separate:** `/api/v1/health` makes no inference call in mock mode and reports `inference: "mock"`. Its HTTP status depends only on the database: 200 `ok` when the database is up, 503 when it isn't (§3.2).

Mock handlers are used only by the tests. A fixture-backed mock that answers from `contracts/fixtures/inference/` is not implemented. Its selection rule, for choosing between several fixtures for one operation, is deferred by the owner (contract §10 Q20: Nisarga, Anvesh, Varshini). The deferral concerns mock mode only; it does not block integration against a running inference service.

### 4.7 Integration dependencies

- **The inference service** (Dev A) is developed on `feature/ayush-inference-engine` and is not merged into this branch. The backend has not yet called it.
  - Contract §9.1 lists the inference requirements, for example a real `decision_id`, A-1. The backend relies on them, and they are not verified here.
- **`infra/compose.yaml`** (Dev D) does not exist yet. It is needed for milestone M2, the backend calling the real service, and M3, end to end (arch §10).

## 5. Database and persistence

### 5.1 Models

[`prisma/schema.prisma`](prisma/schema.prisma), contract §6.3:

| Model | Notes |
|---|---|
| `User` | `id`, `email` and `role`, seeded from the token file. No token or hash |
| `TransactionRequest` | The request, the validated `stateSpec` (JSON) and `status` (`routed`/`failed`). `failureCode` is set only on failed rows. `corridor` is null when failed |
| `RoutingDecision` | One per routed transaction: the normalised decision columns, including `feeCostUsd`, plus the verbatim `engineResponse` |
| `Allocation` | One row per allocation slot; unique on (`routingDecisionId`, `slot`) |
| `Comparison` | An independent record: the transaction fields, the effective `stateSpec`, the resolved canonical `policies` and the verbatim `engineResponse` |
| `Explanation` | At most one per decision (unique `routingDecisionId`), with its verbatim `engineResponse` |
| `AuditLog` | Identifiers only: `userId`, `action`, `requestId`, `entityType`, `entityId`, `outcome` |

Several fields are marked `PROVISIONAL` in the schema, for example the `AuditLog.action` and `outcome` values and some indexes. They follow team decisions still awaiting confirmation.

### 5.2 Migrations

| Migration | Content |
|---|---|
| `20261102110157_init` | The seven tables, generated with `prisma migrate diff --from-empty --script`, plus one manual edit: `Comparison.policies` is `NOT NULL` |
| `20261104120000_failure_code_fee_cost_usd` | Adds the `FailureCode` enum and `TransactionRequest.failureCode`, with a CHECK constraint (`failureCode IS NULL OR status = 'failed'`), and adds `RoutingDecision.feeCostUsd`, backfilled from `engineResponse.metrics.fee_cost_usd` where that is a JSON number in range |

- **Drift guard:** `test/unit/migration.test.ts` checks, without a database, that each migration matches the SQL Prisma generates plus its documented manual edits. It also checks that the second migration only adds.
- **Schema changes:** create a new migration; never edit an applied one.

### 5.3 Write rules (§6.1, §6.2)

- **Append-only:** inserts only, with no updates or deletes.
- **One transaction per record:** each persisted record (a routed or failed transaction, a comparison or an explanation) and its audit row are written in **one database transaction**. If any insert fails, nothing is saved and the response is `500 INTERNAL_ERROR`.
- **No record, no audit row:** requests that persist nothing write no audit row. That covers 401, 403, 405, 422, passed-through 409s, and errors on endpoints that save nothing.
- **Audit values** ([`src/audit/auditLog.ts`](src/audit/auditLog.ts)):
  - `TRANSACTION_CREATE`, with `SUCCESS` or `FAILED`;
  - `COMPARISON_CREATE` and `EXPLANATION_CREATE`, with `SUCCESS` only.

  The action names are provisional.
- **Users are never created by requests.** The caller's `User` row must already exist from the seed; otherwise the request fails with 500 before inference is called.

### 5.4 Dashboard aggregation

From `src/db/dashboard.ts`, contract §3.8:

- **Populations:**
  - "allowed routed" means `status = routed` with `allowed = true`. It is the denominator of `completionRate` and the population of every mean.
  - "rejected by feasibility" means routed with `allowed = false`.
- **`completionRate`:** completed allowed routed ÷ allowed routed, or null when the denominator is 0.
- **`meanFeeCostPct`:** `100 × AVG(feeCostUsd / executedUsd)` over the allowed routed decisions with `executedUsd > 0`.
- **Nulls:** a NULL metric column, possible only on rows saved before those columns were always filled, is skipped by `AVG`, never treated as 0.
- **Groups:** `byPolicy` groups by requested policy, failed rows included in `count`. `byCorridor` covers routed rows only.
- **Exclusions:** the `Comparison` table is never read.

## 6. Requirements, configuration and setup

### 6.1 Requirements

- **Node.js 20, 20.6 or later** (`engines: >=20.6.0 <21` in `package.json`). Docker and CI are planned on Node 20 (arch §7.3). The repository has no `.nvmrc` yet; Dev D owns that.
  - The 2026-11-16 verification ran on Node 24.7.0, outside this range. npm doesn't enforce `engines` by default. Re-check on Node 20 before relying on the result.
- **npm 10 or later.**
- **PostgreSQL**, for the database-backed routes and the integration tests. The Step 6E-3 run used PostgreSQL 18.6; the server version of the later 1543-test run was not recorded (§7.3).

### 6.2 Configuration

[`src/config/config.ts`](src/config/config.ts) reads and validates every variable at startup. It reports all problems at once and exits with code 1. Its messages never include a value, token or hash. Empty values count as unset.

| Variable | Default | Rule |
|---|---|---|
| `AUTH_MODE` | none (required) | Must be exactly `dev` |
| `NODE_ENV` | unset | `production` is refused: the auth is development-only (arch §8.1) |
| `DEV_TOKENS_FILE` | `./dev-tokens.json` | Must exist and be valid (§6.3). A relative path is resolved from the working directory |
| `DATABASE_URL` | none (optional) | A `postgresql://` or `postgres://` URL with a host. Without it the server starts, health reports `database: "unavailable"` (HTTP 503), and every database route returns 500. Contains credentials: never committed or logged |
| `INFERENCE_URL` | `http://inference:8000` | An `http(s)://` base URL with no credentials, query or fragment |
| `INFERENCE_MODE` | `live` | `live` or `mock` (§4.6) |
| `INFERENCE_TIMEOUT_MS` | `15000` | A positive whole number of milliseconds |
| `BIND_HOST` | `127.0.0.1` | An IPv4 or IPv6 address, or `localhost`. Set `0.0.0.0` **only inside a container** whose port is published on host loopback; the server warns at startup for any non-loopback address |

The port is not configurable: the server listens on port 4000.

The server doesn't load `.env` by itself. Either set the variables in your shell and use `npm run dev` or `npm start`, or put them in `services/backend/.env` and use the `:env` scripts. On Node 20 these fail with `.env: not found` if the file is missing. Passing `-- --env-file=.env` to `npm run dev` does **not** work. `.env` and `.env.*` are git-ignored.

### 6.3 Development tokens

Each developer creates their own tokens. Only SHA-256 hashes go in `dev-tokens.json`, which is git-ignored (arch §8.2).

1. Generate a token and keep it private:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. Compute its hash:
   ```bash
   node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" <token>
   ```
3. Copy `dev-tokens.example.json` to `dev-tokens.json` and replace each placeholder with a hash.

File layout:

```json
{"users": [{"userId": "u-analyst-1", "email": "analyst@example.test", "role": "analyst", "tokenSha256": "<64 lowercase hex>"}]}
```

The file must satisfy these rules:
- a non-empty `users` array and no other top-level field;
- `email` ends in `example.test`;
- `role` is `viewer` or `analyst`;
- `tokenSha256` is 64 hex characters;
- no unknown fields;
- unique user IDs and unique hashes.

The example file's placeholders fail validation on purpose.

### 6.4 Commands

Run from `services/backend/`:

```bash
npm ci                    # install exactly what package-lock.json records (runs prisma generate)
npm run dev               # development server with reload (tsx watch)
npm run dev:env           # the same, loading .env
npm run typecheck         # tsc --noEmit
npm run build             # compile src/ into dist/
npm start                 # run dist/server.js (after npm run build)
npm run start:env         # the same, loading .env
npm test                  # unit tests; integration suites only with CBDC_TEST_DATABASE_URL (§7)
npm run prisma:validate   # check the schema (needs DATABASE_URL set; makes no connection)
npm run prisma:generate   # regenerate Prisma Client
npm run prisma:seed       # upsert development users from the token file (needs a migrated database)
```

**Database setup** (with `DATABASE_URL` pointing at your development database):

```bash
npx prisma migrate deploy   # apply prisma/migrations
npm run prisma:seed         # seed users from DEV_TOKENS_FILE
```

**Quick check:** `curl -i http://127.0.0.1:4000/api/v1/health`. Expect 503 while the database is unavailable.

**About the seed:**
- **Validation:** it checks the token file with the startup code and aborts before connecting if the file is invalid.
- **Writes:** it upserts each user by `id`, writing only `id`, `email` and `role`. Users no longer in the file are kept.
- **Output:** it prints only a count.

**About Prisma:**
- **Version:** `prisma` and `@prisma/client` are pinned to exactly 6.19.3. Prisma 7 needs Node 20.19 or later.
- **Runtime dependency:** `prisma` is one because `migrate deploy` runs at container start (arch §7.3).
- **Engine binaries:** they are downloaded at install time from `binaries.prisma.sh`, or from `PRISMA_ENGINES_MIRROR`.
- **Seed setting:** in `package.json`; Prisma 6.19.3 prints a deprecation warning for it.
- **Update check:** `CHECKPOINT_DISABLE=1` disables it.

## 7. Testing

### 7.1 Organisation

| Folder | What | Needs |
|---|---|---|
| `test/unit/` | One file per module or endpoint: validation, mappers, inference client, cache, health, every route (with fake stores and mock inference handlers), persistence logic, migration SQL, config, auth, logging | Nothing: no database, no inference service |
| `test/integration/transactions.test.ts` | Four PostgreSQL suites in one file, so they run sequentially: `GET /api/v1/transactions`, `POST /api/v1/transactions` (including `GET :id`, rollback and explanations), `GET /api/v1/dashboard/summary`, comparisons (including atomicity and constraints) | A disposable PostgreSQL database |
| `test/helpers/` | Shared helpers, not tests | — |

Tests use Node's built-in runner through `tsx` (`scripts/run-tests.mjs`). There is no Vitest; see §10.

### 7.2 PostgreSQL integration tests: safety

The integration file **empties every table (`TRUNCATE … CASCADE`, `User` included) before and after each suite.** It therefore guards itself:
- it runs only when `CBDC_TEST_DATABASE_URL` is set;
- the URL must be `postgresql://` or `postgres://`;
- the database name must end in `_test`, or the file fails without connecting;
- it never changes the schema, so migrations must be applied first.

Use a dedicated, disposable database, never a development database with data you want to keep. For example, in PowerShell from `services/backend/`, with placeholders only:

```powershell
# 1. Create a disposable database, e.g. cbdc_router_test, with your PostgreSQL tools.
# 2. Apply the migrations to it:
$env:DATABASE_URL = "postgresql://<user>:<password>@localhost:5432/cbdc_router_test"; npx prisma migrate deploy
# 3. Run unit and integration tests together:
$env:CBDC_TEST_DATABASE_URL = $env:DATABASE_URL; npm test
# 4. Clean up: clear the variables, and drop the database when finished.
Remove-Item Env:CBDC_TEST_DATABASE_URL, Env:DATABASE_URL
```

These URLs contain credentials: never commit or log them.

### 7.3 Skipped suites and recorded integration results

Without `CBDC_TEST_DATABASE_URL`, each of the four suites is skipped as a whole and printed as `﹣ <suite name> # CBDC_TEST_DATABASE_URL is not set`. Node's summary still says `skipped 0`, because it counts tests, and the skipped suites' tests are never registered. **A green `npm test` therefore does not show that no integration test ran.** Check the output for those four lines.

#### Integration results: historical reports and current verification

No integration result is stored in the repository: there are no test logs, and no commit message records a run. The results below were reported during development. They are **historical and not independently reproducible from repository artifacts**.

| When | Code tested | Reported result | Evidence available |
|---|---|---|---|
| After Step 6E-3, reported by Dev B | Working tree at that step: init migration only | PostgreSQL 18.6, database `cbdc_router_test`. 691 passed, 0 failed, 0 skipped, of which 16 integration tests (6 GET, 10 POST) | Earlier version of this README only |
| 2026-11-16, 16:22 UTC (21:52 IST), about 49 min before commit `5414275` (22:41 IST) | **Pre-commit working tree** of `feature/phase2-backend`, with the comparison, dashboard and explanation suites | `prisma migrate status`: 2 migrations, "Database schema is up to date". `npm test` with `CBDC_TEST_DATABASE_URL` → `cbdc_router_test`: **1543 passed, 0 failed, 0 skipped**, 172 suites, of which 30 comparison integration tests. Afterwards, a read-only check counted **0 rows in every table** | Runner output in a Claude Code session log and its saved copy (`pg-run.txt` in that session's temporary folder), outside the repository |
| `5414275` (committed) | — | **No run of the committed code is recorded** | — |

**How far the 1543 run matches `5414275`** (checked on 2026-11-16 without a database):
- Every test reported by a no-database `npm test` at `5414275` (1469 passed) appears with the same title in the 1543 run's log. The only differences are the four skipped-suite markers, which are expected without a database.
- Every literal `it()` title in `test/integration/transactions.test.ts` at `5414275` appears in that log. Four titles are templates, which a text search can't confirm.
- 1543 − 1469 = 74 integration tests.

This makes the 1543 run consistent with the committed test set. It is still **not** a verification of `5414275`: the code was not hashed at run time, and files could have changed before the commit. To verify the committed code, re-run §7.2 at `5414275` and record the commit, date, PostgreSQL version and summary lines.

### 7.4 Other checks

| Check | Command | Where |
|---|---|---|
| TypeScript | `npm run typecheck`, `npm run build` | `services/backend/` |
| Contract checker (Dev D) | `python infra/scripts/check_contracts.py`, and its tests with `python -m pytest infra/scripts/tests -q`, in `infra/.venv` per [`contracts/README.md`](../../contracts/README.md) | repository root; CI: `.github/workflows/phase2-integration.yml` |

The contract checker validates the fixtures and OpenAPI files. It does not run the backend, so it is not evidence about this code.

## 8. Limitations and open items

Verified against the code at `5414275`. Project-wide items are tracked in [`docs/PHASE2_STATUS.md`](../../docs/PHASE2_STATUS.md).

- **PostgreSQL at the committed HEAD is not independently verified.** A pre-commit run reported 1543 passed; see §7.3 for what that does and doesn't establish.
- **Not run against the real inference service.** Every inference path is tested with mock handlers (§4.7).
- **Mock mode is not usable for inference-backed routes.** Without an injected mock handler they return 503; the other routes and health are unaffected (§4.6). A fixture-backed mock is not implemented; its selection rule (Q20) is deferred, which does not block integration against a running inference service.
- **Inference health timeout.** The health probe uses the 15 s `INFERENCE_TIMEOUT_MS`, so `/api/v1/health` can take up to 15 s while inference hangs. Contract §5 asks the backend to use its own short timeout for this check (3 s was proposed); that is not implemented yet.
- **No response-size limit** on inference bodies; only the timeout bounds them. A limit awaits expected sizes from Dev A.
- **Legacy failed rows** (owner decision Q22, contract §3.4). A failed transaction saved before `20261104120000_failure_code_fee_cost_usd` has no `failureCode`, and `GET :id` returns it with `failure: null`. No code is invented. A newly created failed transaction must store its actual failure code: `saveFailed` refuses anything that isn't one of the §3.2 failure codes.
- **Contract decisions affecting this service** (contract §10). Q11a (non-UUID `:id` → 404), Q14 (authentication before 405) and Q22 (legacy `failure: null`) were decided by the owner on 18 November 2026. Q20 (mock fixture selection) is deferred and does not block live inference integration.
- **Database-failure reporting** to callers is not defined by the contract; it is implemented as `500 INTERNAL_ERROR`.
- **Provisional schema values:** the `AuditLog.action` and `outcome` names and several indexes (§5.1).
- **No backend CI workflow and no Dockerfile** (arch §5.4, §7.3).
- **No GET retry.** This is permitted by §5, not required, and is not a defect.
- **Stale comment:** `src/inferenceClient/client.ts` says `contracts/fixtures/inference/` doesn't exist. It now does, though nothing loads it.

## 9. Layout

```text
src/
  app.ts                  builds the Express app: routes, API_ROUTES (405 table), middleware order
  server.ts               validates configuration, wires Prisma, inference client and stores; listens on 127.0.0.1:4000
  lifecycle.ts            graceful shutdown (SIGINT/SIGTERM, forced after 10 s)
  logger.ts               JSON-lines logger with secret redaction
  config/                 config.ts (environment), devTokens.ts (token file), backendVersion.ts
  auth/                   devAuth.ts (bearer tokens), policies.ts (analyst-only ppoProjected)
  middleware/             requestId, requestLogger, jsonBody, methodNotAllowed (405), errors (envelope, 404, handler)
  validation/             transactionRequest.ts, comparisonRequest.ts (aliases, duplicates)
  routes/                 health, auth, meta, metadata (network, scenarios), replay, state,
                          transactions (list, POST, GET :id), explanations, comparisons, dashboard
  mappers/                camelCase, routeRequest, routeResponse, compareResponse, explainResponse,
                          stateResponse, versionResponse
  inferenceClient/        client.ts, errors.ts (error mapping), fieldPaths.ts, cache.ts, health.ts
  db/                     prisma.ts, health.ts, errors.ts, seedDevUsers.ts, transactions.ts,
                          transactionPersistence.ts, explanations.ts, comparisons.ts, dashboard.ts
  audit/auditLog.ts       audit row values
test/
  unit/                   *.test.ts, no external dependencies
  integration/            PostgreSQL suites (§7.2)
  helpers/                shared helpers
scripts/run-tests.mjs     finds test/**/*.test.ts and runs node --test
prisma/
  schema.prisma           the seven models
  migrations/             two migrations and migration_lock.toml
  seed.ts                 development-user seed
dev-tokens.example.json   placeholder token file (committed; fails validation on purpose)
```

## 10. Notes and accepted advisory

- **Tests use `node:test`, not Vitest.** Vitest 5 needs Node 22 or later, Vitest 4.1.12 failed to install, and Vitest 3.2.x pulls in packages with known advisories.
- **Use `npm ci`, not `npm install`,** except when deliberately changing dependencies.
- **Never commit secrets.** `.env*` and `dev-tokens.json` are git-ignored.

**Known advisory (recorded earlier; not re-checked on 2026-11-16).** `npm audit` reported 3 high-severity findings, all one advisory counted along its chain:
- **Advisory:** [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx), stack exhaustion in `deepmerge-ts` below 8.0.0.
- **Path:** `prisma@6.19.3` → `@prisma/config` → `deepmerge-ts@7.1.5`.
- **Why it is accepted for now:**
  - It is reached only through the Prisma command-line tool's own configuration loading, never by the running server.
  - It handles developer-controlled settings only.
  - The worst case is a crashed command.
  - npm's fix, Prisma 7, needs Node 20.19 or later and a different client setup.
- **Revisit when:** Prisma ships a fixed 6.x, the Node minimum is raised to 20.19 or later, or untrusted input reaches the Prisma CLI.
