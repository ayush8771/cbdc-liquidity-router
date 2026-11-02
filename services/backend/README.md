# CBDC Liquidity Router: Application Backend (Phase 2B)

The Express + TypeScript application backend for Major Phase 2. Owner: Dev B.

It serves the public Application API (`/api/v1/*`) to the web frontend and applies development-only auth. It will call the internal inference service and persist decisions in PostgreSQL through Prisma. Routing logic never lives here; it belongs to the inference service.

- Architecture: [`docs/PHASE2_ARCHITECTURE.md`](../../docs/PHASE2_ARCHITECTURE.md)
- API contract: [`docs/PHASE2_API_CONTRACT.md`](../../docs/PHASE2_API_CONTRACT.md)

## Status

Steps 1–5D, 6A–6D, 6E-1 and 6E-2 are implemented and covered by unit tests (627 tests, run with `npm test`; none needs a database or a running inference service). An optional PostgreSQL integration test exists but has not been run (see Step 6D). Step 5D provisionally reviewed; real PostgreSQL validation remains pending. Steps 6A–6D and 6E-1 approved; Step 6E-2 awaits review.

**Endpoints so far:**

| Endpoint | Auth | Since |
|---|---|---|
| `GET /api/v1/health` | Public | Step 1; full API contract §3.9 body since Step 5D; real `inference` value since Step 6B |
| `GET /api/v1/auth/me` | Bearer token | Step 4 |
| `GET /api/v1/replay/calendar` | Bearer token (viewer or analyst) | Step 6C |
| `GET /api/v1/transactions` | Bearer token (viewer or analyst) | Step 6D |

Every other path returns `404 NOT_FOUND`.

### Implemented

- **Step 1: project setup.**
  - **Stack:** Express 5 and TypeScript, with exactly pinned dependencies.
  - **Server:** listens on `127.0.0.1:4000` and reports a port conflict clearly before exiting with code 1.
  - **Health endpoint:** added here as a placeholder; its full body is described under Step 5D.
- **Step 2: configuration and startup safety.** The server validates its environment and the development token file before it opens the port, and refuses to start on any problem.
- **Step 3: request IDs, errors and logging.**
  - Every response carries `X-Request-Id`: the caller's value, or a generated UUID.
  - Errors use the contract envelope `{"error": {"code", "message", "details", "requestId"}}` (API contract §4). Unknown routes return `404 NOT_FOUND`; unexpected failures return `500 INTERNAL_ERROR`, never with a stack trace or the internal message.
  - Requests are logged as JSON lines, and `Authorization`, `token` and `tokenSha256` values are always redacted.
- **Step 4: development authentication.**
  - `GET /api/v1/auth/me` requires `Authorization: Bearer <token>`. The scheme is matched in any letter case, followed by exactly one 64-character hex token.
  - The token is hashed with SHA-256 and compared with `crypto.timingSafeEqual` against every hash in the token file.
  - A missing, malformed or unknown token returns `401 UNAUTHENTICATED`. `/api/v1/health` stays public, and unknown paths return 404 with or without a token.
  - `authorizePolicies()` (in `src/auth/policies.ts`) refuses `ppoProjected` for non-analysts with `403 FORBIDDEN_POLICY`. It will be wired in when the transaction and comparison endpoints exist.
- **Step 5B: Prisma schema.**
  - **What it defines:** `prisma/schema.prisma` has the seven models from API contract §6.3 (`User`, `TransactionRequest`, `RoutingDecision`, `Allocation`, `Comparison`, `Explanation`, `AuditLog`) and six enums.
  - **Versions:** Prisma 6.19.3, exactly pinned.
  - **Checks:** the schema passes `prisma validate`, and Prisma Client is generated from it on every `npm ci` (the `postinstall` script).
  - **Provisional fields:** some fields follow team decisions still awaiting confirmation; they are marked `PROVISIONAL` in the schema.
- **Step 5C: initial migration and development-user seed.**
  - **Migration:** `prisma/migrations/20261102110157_init/` holds the SQL that creates the seven tables, generated from the schema with one documented manual edit (see "About the migration").
  - **Seed:** `prisma/seed.ts` upserts development users from the token file, writing only `id`, `email` and `role`.
- **Step 5D: database connectivity.**
  - **One client:** `src/db/prisma.ts` holds the process's single `PrismaClient`, created only when `DATABASE_URL` is set. It connects on the first query.
  - **Health check:** `GET /api/v1/health` returns the API contract §3.9 fields `{"status", "database", "inference", "authMode", "time"}`, always with HTTP 200 (the contract doesn't specify a status code).
    - **`database`:** `SELECT 1` with a 3 s timeout. `ok`, or `unavailable` when unset, unreachable or timed out (provisional; the contract only shows `ok`).
    - **No query pile-up:** Prisma can't cancel a query, so at most one probe query runs at a time. Checks made while it's running wait on it rather than starting another.
    - **`inference`:** from Step 6B; see below.
    - **`status`:** `ok` only when both `database` and `inference` are `ok`; otherwise `degraded`.
  - **Errors from Prisma:** they are logged with their class name, `P####` code and stack frames only, never their message, which can contain the host, user or connection string. The client still gets the standard `500 INTERNAL_ERROR` envelope.
  - **Start-up:** the server starts even if the database is down.
  - **Logging:** database status changes are logged with a reason (`not_configured`, `timeout`, a Prisma error code or class name), never a message, URL or credential.
  - **Shutdown:** on `SIGINT`/`SIGTERM` the server stops accepting connections, disconnects Prisma and exits, forced after 10 s.

- **Step 6A: inference client foundation** (`src/inferenceClient/`). Used by health (Step 6B) and the calendar endpoint (Step 6C).
  - **Interface:** `createInferenceClient(config.inference, {logger, mockHandler?})` returns `get(path, {query, requestId})` and `post(path, body, {requestId})`. Only the nine documented `/v1/*` endpoints are accepted (GET or POST as in API contract §2); any other path is refused without a call. Success returns the engine's snake_case JSON object unchanged; mapping is left to the mappers.
  - **Timeout:** `INFERENCE_TIMEOUT_MS` (default 15 s) covers the whole call, response body included.
  - **Headers:** only `Accept`, `Content-Type` (POST) and `X-Request-Id` (when supplied) are set. The client never sees the incoming request, so `Authorization`, development tokens and cookies can't be forwarded.
  - **No retries.** POST is never retried (§5). §5 allows one GET retry; it isn't implemented. Redirects aren't followed.
  - **Errors** are `InferenceError`, a subclass of `ApiError`, so the existing handler renders them with the backend's own `requestId`. Only a documented error code can reach the client. The inference `message`, `details`, `request_id` and headers never do: the message is written by the backend (paraphrasing API contract §4's "When" column) and `details` is always `{}`.
    | Inference outcome | Application error |
    |---|---|
    | Unreachable, connection reset, or timeout | `503 INFERENCE_UNAVAILABLE` |
    | Engine validation error with its documented status (§3.2: "passed through with the same `code`"): `VALIDATION_ERROR`, `UNSUPPORTED_CORRIDOR`, `INVALID_AMOUNT`, `DATE_OUT_OF_RANGE`, `DATE_IN_GAP_BUFFER`, `UNKNOWN_SCENARIO`, `STATE_VENUE_MISMATCH`, `INVALID_STATE_VALUE`, `POLICY_UNAVAILABLE_FOR_STATE` (all 422) | `422`, same code, backend message, empty details |
    | `ENGINE_BUSY` 503, `ENGINE_TIMEOUT` 504 (§4: "passed through by app") | Same status and code, backend message, empty details. `Retry-After` is kept on the error object but **not** sent to the client. |
    | `NOT_FOUND` 404, `POLICY_DISABLED` 409, `MALFORMED_REQUEST` 400, or any other 4xx error envelope | `502 INFERENCE_ERROR` (generic message) |
    | Any 5xx not listed above, including `INTERNAL_ERROR` and `NOT_READY` | `502 INFERENCE_ERROR` |
    | Anything else: status other than 200, non-JSON, a body that isn't a JSON object, a malformed envelope, a pass-through code with the wrong status, a 3xx | `502 INFERENCE_ERROR` |
  - **Mock mode** (`INFERENCE_MODE=mock`) makes no network call. It answers only from an injected `mockHandler`, through the same mapping as live mode. `contracts/fixtures/inference/` doesn't exist yet, so no fixture loader exists and, without a handler, every call fails with `503 INFERENCE_UNAVAILABLE`. No response fixtures or schemas have been invented.
  - **Logging:** failures are logged with request ID, method, path, failure kind, code, upstream status, the inference code (only when it looks like one: upper case, digits and underscores) and duration; never bodies, query values or inference messages. Passed-through inference errors are logged at `info`, other failures at `warn`.
  - **Tested on** Node 20.20.2 and 20.6.0 (via `npx -p node@<version>`), as well as Node 24 (Steps 6A and 6B).
  - **Limitations and provisional decisions** (to confirm with Dev A, C and D):
    - `NOT_FOUND` and `POLICY_DISABLED` from inference become `502 INFERENCE_ERROR`: neither §3.2 nor §4 says they pass through. The frontend can't yet tell a disabled PPO policy from an inference fault on these endpoints.
    - Engine validation errors carry no `details`, so the frontend can't see which field failed. §4 shows `details.field` and `details.errors[]` but defines no schema, and the field paths are snake_case.
    - `Retry-After` is not forwarded until its behaviour is agreed.
    - Response bodies have **no size limit**; only the timeout bounds them. A limit is pending expected response sizes from Dev A.
    - `INFERENCE_UNAVAILABLE` for a missing mock response is a borrowed code.

- **Step 6B: inference health** (`src/inferenceClient/health.ts`, `health()` in `client.ts`).
  - **Client:** `health({requestId})` calls `GET /v1/health` and accepts HTTP 200 **and 503** (API contract §2.1: "HTTP 200 when `ready`, otherwise 503"), returning `{httpStatus, body}`. Every other outcome throws the same `InferenceError` as `get()`, but isn't logged per call. `get()` and `post()` are unchanged: a 503 from any endpoint, `/v1/health` included, is still an error for them.
  - **Probe:** `createInferenceHealthProbe(client, logger).check(requestId)` never rejects. It reads only `ready` and `status` from the body:
    | Inference answer | `inference` |
    |---|---|
    | Mock mode (no call is made, even with a mock handler) | `mock` |
    | HTTP 200, `ready: true`, `status: "ok"` | `ok` |
    | HTTP 200, `ready: true`, `status: "degraded"` | `degraded` |
    | HTTP 503 with `ready: false` and `status` `ok`/`degraded`, or a §4 `NOT_READY` envelope | `unavailable` |
    | Timeout, unreachable, any other status, or an invalid or contradictory body (e.g. 200 with `ready: false`, 503 with `ready: true`, an unknown `status`) | `unavailable` |
    | No client | `unavailable` |
  - **Timeout:** `INFERENCE_TIMEOUT_MS` (default 15 s), so `/api/v1/health` can take up to that long when inference hangs. No retry.
  - **Route:** the database and inference checks run in parallel; the backend's request ID is forwarded to inference. Nothing from the inference body or an error appears in the response: the fields and HTTP 200 are unchanged.
  - **Logging:** only when the status or its reason changes, as `inference status` with `inference` and a fixed `reason` (`ok`, `degraded`, `mock`, `not_ready`, `timeout`, `unreachable`, `upstream_4xx`, `upstream_5xx`, `invalid_response`, `not_configured`, `error`). `ok` and `mock` are logged at `info`, the rest at `warn`.
  - **`server.ts`** creates the client and probe, and logs the initial inference status at startup.
  - **Provisional** (not specified by the contract): which inference answers count as `unavailable` rather than `degraded`; that mock mode makes `status` `degraded` (because `status` is `ok` only when inference is `ok`); the always-200 health response; the contract doesn't say whether a not-ready 503 carries a health body or a `NOT_READY` envelope, so both are accepted.

- **Step 6C: `GET /api/v1/replay/calendar`** (`src/routes/replay.ts`, `src/mappers/camelCase.ts`).
  - **Auth:** bearer token required; viewer and analyst both allowed. A missing, malformed or unknown token returns `401` without calling inference.
  - **Call:** `GET /v1/replay/calendar` through the inference client, forwarding the request ID (the caller's or the generated one). Query parameters are ignored and not forwarded; none are documented.
  - **Response:** HTTP 200 with the camelCase mapping of API contract §2.6, e.g. `gap_buffer_days` → `gapBufferDays`, `excluded_ranges` → `excludedRanges`. Values are never changed. The body must be a JSON object (checked by the client); no fields are validated, so unknown fields are kept (mapped).
  - **Mapper:** `toCamelCase` converts object keys recursively, including objects inside arrays; values, including strings with underscores, are untouched; the input isn't mutated; a `__proto__` key stays an ordinary property. If two keys of one object map to the same name (`a_b` and `aB`), the endpoint returns `502 INFERENCE_ERROR` and logs `reason: "key_collision"` without the key names. It maps keys only: enum values (§3.2) are left to endpoint-specific mappers.
  - **Errors:** the Step 6A mapping: unreachable or timeout → `503 INFERENCE_UNAVAILABLE`; 5xx (including `NOT_READY`) or an invalid body → `502 INFERENCE_ERROR`. Mock mode (no fixtures yet) and an app without an inference client → `503 INFERENCE_UNAVAILABLE`, with no network call. Other methods → `404 NOT_FOUND`.
  - **Not cached yet.** API contract §3.1 marks it "(cached)", and §5 invalidates cached results when `/v1/version` reports a different `git_commit`, `knowledge.sha256` or `checkpoint.sha256`. The contract doesn't say when the backend should check `/v1/version`, so caching waits for that decision; every request calls inference.

- **Step 6D: `GET /api/v1/transactions`** (`src/routes/transactions.ts`, `src/db/transactions.ts`).
  - **Auth:** bearer token required; viewer and analyst both allowed. Every user's transactions are visible to any authenticated user (API contract §3.3).
  - **Response:** HTTP 200 with `{items, page, pageSize, total}`. Each item has the §3.3 fields in order, copied from stored columns: `createdBy` is the user ID, `createdAt` ISO 8601 UTC, `simulationDate` `YYYY-MM-DD`, `policy` the transaction's `requestedPolicy`. **A failed transaction has no decision,** so `policyStatus`, `allowed`, `completed`, `completionRatio`, `executedUsd` and `rewardAmountBased` are `null` (provisional; §3.3 shows only a routed item).
  - **Query parameters** (invalid ones → `422 VALIDATION_ERROR`, all problems at once, before any database access):
    | Parameter | Rule |
    |---|---|
    | `page` | Positive whole number; default 1 |
    | `pageSize` | Whole number 1–100; default 20 |
    | `corridor` | `USA->IND`, `GBR->PHL` or `ARE->MEX` |
    | `policy` | `waterfall`, `cheapestFeasible` or `ppoProjected`; matches `requestedPolicy`, so failed rows are included |
    | `stateMode` | `historicalReplay`, `scenario` or `explicit` |
    | `completed` | `true` or `false`; matches only transactions with a decision, so failed rows match neither |
    | `from`, `to` | `YYYY-MM-DDTHH:MM:SS[.f-fff]Z` (UTC only, no offsets, no date-only values, at most millisecond precision); `from` inclusive, `to` exclusive; `from` later than `to` is rejected, equal gives an empty page |
    | `sort` | Only `createdAt:desc` (the documented default) |
    - A documented parameter given twice is rejected; unknown parameters are ignored.
    - `details.errors` is a list of `{field, message}` (provisional shape; §4 names the list but not its entries).
  - **Ordering:** `createdAt` DESC, then `id` DESC, so pages are stable when timestamps are equal.
  - **Repository:** `TransactionRepository.list()` runs `findMany` and `count` in one Prisma transaction at REPEATABLE READ, so the page and `total` come from the same snapshot. It selects only the item's columns (never `engineResponse` or `stateSpec`).
  - **Errors:** a database error returns `500 INTERNAL_ERROR` (§4 has no database code); the Prisma error is logged with its class name and code only, as in Step 5D. Without `DATABASE_URL` the endpoint also returns `500 INTERNAL_ERROR`. Other methods → `404 NOT_FOUND`.
  - **Data:** nothing writes transactions yet (`POST /transactions` is a later step), so in practice the list is empty.
  - **Integration test** (`test/integration/transactions.test.ts`): runs only when `CBDC_TEST_DATABASE_URL` is set, and otherwise reports `SKIP`. It **empties every table** before and after, so the database must be disposable; its name must end in `_test`, or the test file fails without connecting. Apply the migrations to it first; the test never changes the schema:
    ```bash
    DATABASE_URL=<test url> npx prisma migrate deploy
    CBDC_TEST_DATABASE_URL=<test url> npm test
    ```
    **It has not been run yet:** no disposable test database was configured, and no migration has been applied to any database.

- **Step 6E-1: transaction request parsing, validation and mapping** (`src/middleware/jsonBody.ts`, `src/validation/transactionRequest.ts`, `src/mappers/routeRequest.ts`). Building blocks for `POST /api/v1/transactions`; **no route uses them yet**.
  - **`jsonBody()`** (per-route middleware): parses `application/json` bodies (any parameters, such as `charset=utf-8`, allowed) up to 100kb, UTF-8 only, with gzip/deflate/br decoding. Every rejection is `400 MALFORMED_REQUEST` with a backend-written message, never the parser's: wrong or missing `Content-Type`, an empty body, invalid JSON, a top-level value that isn't an object or array, a body over 100kb, another charset, or an unsupported content encoding. PROVISIONAL: API contract §4 has no 413 or 415 code, so size and charset/encoding problems also use 400 `MALFORMED_REQUEST`.
  - **`validateTransactionRequest()`**: shape and type checks for the §3.2 body, reporting every problem as `details.errors[]` entries `{field, message}`, with paths such as `state.venues[1].history.congestion`.
    | Field | Rule |
    |---|---|
    | `senderCountry`, `receiverCountry` | Required non-empty strings |
    | `amountUsd` | Required finite JSON number (a value like `1e400` parses to Infinity and is rejected) |
    | `policy` | `waterfall`, `cheapestFeasible` or `ppoProjected`; omitted or `null` → `waterfall` |
    | `clientReference` | Optional string, any length, empty allowed; omitted or `null` → `null` |
    | `state.mode` | `historicalReplay` (`date`), `scenario` (`date`, `scenarioId`) or `explicit` (`referenceDate`, `venues[]`) |
    | `date`, `referenceDate` | `YYYY-MM-DD` real calendar dates |
    | `scenarioId` | Non-empty string, kept exactly as sent |
    | `venues[]` | Objects with `bridgeUid` (non-empty string), `liquidityUsd` and `congestion` (finite numbers), optional `history` (or `null`) of exactly `{liquidityUsd, congestion}`, each exactly 30 finite numbers |
    - Unknown fields inside `state`, a venue or `history` are rejected (§2.4), including another mode's fields.
    - **Left to inference** (its own codes, §2.4 and §4): amount > 0, supported corridor, date range and gap buffers, known scenario, venues matching the corridor, non-negative values, and the last history value equalling the current one. No allocation or feasibility logic is in the backend.
  - **`toRouteRequest()`**: the validated request as the §2.8 `RouteRequest`, field for field, with documented fields only. Enum values mapped (§3.2): `cheapestFeasible` → `cheapest_feasible`, `ppoProjected` → `ppo_projected`, `historicalReplay` → `historical_replay`. Everything else is unchanged, including `bridge_uid`, dates and numbers. `policy` is always sent, already defaulted; `client_reference` only when given.
  - **Provisional decisions** (unspecified in the contract): unknown **top-level** fields are rejected too, so a misspelt `polcy` can't silently route with the default policy; `null` counts as omitted for `policy` and `clientReference`; `clientReference` has no length limit beyond the body limit; the `details.errors[]` entry shape.
  - **Pending confirmation (Dev A/C):** the `scenarioId` value convention. The backend passes it to inference unchanged and doesn't guess whether the Application API uses the engine's values (`cheapest_venue_outage`) or camelCase ones.

- **Step 6E-2: inference response validation and mapping** (`src/mappers/routeResponse.ts`). For `POST /api/v1/transactions`; **no route uses it yet**.
  - **`mapRouteResponse(body, request)`** takes a `/v1/route` 200 body and the validated request (Step 6E-1) and returns:
    - `transaction`: the §3.2 response `transaction`, i.e. the engine's `transaction` in camelCase;
    - `decision`: the §3.2 `decision`, i.e. the rest of the response in camelCase;
    - `columns`: `corridor` (from the engine), the `RoutingDecision` column values and one `Allocation` column set per entry, copied from the response, never computed.
  - **Mapping:** keys via `toCamelCase`, so unknown fields are kept at every level. Enum values mapped: `policy` (`cheapest_feasible` → `cheapestFeasible`, `ppo_projected` → `ppoProjected`) and `provenance.stateMode` (`historical_replay` → `historicalReplay`). Unchanged: IDs, codes, tags, `bridgeUid`, `valuesProvenance`, `split`, `regime`, `policyStatus`, warning codes, reason strings and `scenarioId` (convention pending).
  - **Validated** (only what persistence and the response rely on): `decision_id`; `policy` (must equal the requested, defaulted policy); `policy_status`; `transaction` (must echo the request's sender, receiver, amount, simulation date and client reference; `corridor` must be a non-empty string); `feasibility.allowed`; the five `totals` columns; `metrics` (see below); `provenance.state_mode` (must equal the requested mode), `values_provenance`, `state_frame_sha256`, `knowledge_sha256`, `git_commit`, `checkpoint`; and every allocation's column fields, with unique whole-number slots. Not validated, only passed through: `feasibility.reason`/`decisive_fact_ids`/`knowledge_version`, the other `totals` and `metrics` fields, `diagnostics`, the rest of `provenance`, and `warnings`.
  - **Rejection:** any problem throws `InvalidRouteResponseError`, a `502 INFERENCE_ERROR` with empty `details`. Its `problems` list names field paths for logging, never values. Colliding keys are rejected the same way.
  - **Regulatory rejection:** `allowed: false` with `allocations: []` maps normally; no rejection invariants are enforced (that's the engine's rule).
  - **Immutability:** neither the response nor the request is mutated, so the response can later be stored verbatim as `engineResponse` (§6.1).
  - **Assumptions about undocumented `RouteResponse` details** (to confirm with Dev A):
    - `metrics` may be absent or `null`, e.g. on a regulatory rejection; then `rewardEnv`, `rewardAmountBased`, `latencyTerm` and `riskTerm` are `null`. When present, each of those may be a number, `null` or absent.
    - `provenance.checkpoint` is always present: `null`, or an object with a `sha256` string (the §2.2 checkpoint shape).
    - `transaction` echoes the request exactly (amounts compared as numbers; `client_reference` is `null` when none was sent), and `simulation_date` is `state.date` or `state.reference_date` (§2.8).
    - Slots are unique whole numbers (the `Allocation` table's unique key).
    - Not enforced, though they might be: that `policy_status` matches the policy (§2.2: default, baseline, experimental), that `ppo_projected` has a checkpoint, and that `share_before_projection` is set only for `ppo_projected`.

### Implemented but not yet tested against a real PostgreSQL database

The unit tests use fake database clients or a fake repository, and no database has been involved so far:
- **The migration** has not been applied to any database.
- **Transaction history** (Step 6D) has been tested with a fake repository and a fake Prisma client only. Its Prisma queries (the relation filter on `completed`, the ordering, REPEATABLE READ) are type-checked against the generated client but haven't run against PostgreSQL.
- **The seed** has not been run against a database. Only its token-file checks and its upsert calls have been tested, with a fake client.
- **A successful database connection** has not been verified. Health has been checked live only with `DATABASE_URL` unset, or pointing at a closed port; both correctly report `database: "unavailable"`.
- **Shutdown** is tested with fakes only. Windows can't deliver `SIGTERM` to another process, so a real signal-driven shutdown hasn't been exercised.
- **One check is still to do:** whether Prisma's drift detection accepts the migration's manual `NOT NULL` on `Comparison.policies`. Run `prisma migrate dev`, or `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url <url>`, against a development database.

### Remaining work

- **Database repositories:** reading the history list exists (Step 6D). Still to do: saving and reading single transactions, decisions, allocations, comparisons, explanations and audit log entries, append-only. Includes checking that the policy returned by inference matches `TransactionRequest.requestedPolicy` before saving.
- **When the server requires `DATABASE_URL`:** it stays optional until the repositories need it.
- **Inference client follow-ups:** load mock responses from `contracts/fixtures/inference/` once they exist; optionally the one GET retry §5 allows; whether and how to forward error `details` and `Retry-After`; a response-size limit; validating responses against `contracts/openapi/inference.v1.yaml` once it exists; caching of `version`, `network`, `calendar` and `scenarios` (§3.1, §5), pending when the backend checks `/v1/version`.
- **Mappers:** the generic key mapper exists (Step 6C). Endpoint-specific mapping of enum values (§3.2, e.g. `historical_replay` → `historicalReplay`) is still to do, and which value fields are enums rather than IDs or tags needs confirmation.
- **The remaining endpoints** (API contract §3.1):
  - **Read-only, via inference:** `/meta`, `/network`, `/state`, `/scenarios`;
  - **Transactions:** `POST /transactions` (request side done in Step 6E-1, response side in 6E-2; persistence, audit and the route remain), `GET /transactions/:id`;
  - **Explanation:** `GET /transactions/:id/explanation`;
  - **Comparisons:** `POST /comparisons`, `GET /comparisons/:id`;
  - **Dashboard:** `GET /dashboard/summary`.
- **Wiring the role check:** `authorizePolicies()` into the transaction and comparison endpoints.
- **Docker:** the backend `Dockerfile` and `.dockerignore`, including a configurable host for running inside Docker.
- **Integration tests** in `test/integration/` against a real PostgreSQL database: the first one exists (Step 6D) but hasn't been run.
- **Open team decisions:** several schema and health-response details (e.g. the health HTTP status code, the `meanFeeCostPct` source, the audit log rules) need agreement with Dev A, C and D.

## Requirements

- **Node.js 20 LTS, 20.6 or later** (`engines: >=20.6.0 <21`). Docker and CI use Node 20, so develop on it too. With nvm-windows, run `nvm install 20` then `nvm use 20`. The exact version will be pinned in the root `.nvmrc` (Dev D).
- npm ≥ 10.

## Configuration

`src/config/config.ts` reads and validates every variable at startup. It reports all problems at once and exits with code 1. Its messages never include a variable's value, a token or a token hash.

| Variable | Default | Rule |
|---|---|---|
| `AUTH_MODE` | none (required) | Must be exactly `dev` |
| `DATABASE_URL` | none (optional for now) | If set, it must be a `postgresql://` or `postgres://` URL with a host. Without it the server still starts, and health reports `database: "unavailable"`. It will become required once the database repositories exist. Prisma's command-line tools need it too, from the environment or `.env`. It contains credentials, so it is never logged. |
| `DEV_TOKENS_FILE` | `./dev-tokens.json` | Must exist and be valid (see below). A relative path is resolved from the working directory. |
| `INFERENCE_URL` | `http://inference:8000` | An `http://` or `https://` base URL, with no credentials, query string or fragment. A trailing slash is removed. |
| `INFERENCE_MODE` | `live` | `live` or `mock` |
| `INFERENCE_TIMEOUT_MS` | `15000` | A positive whole number |
| `NODE_ENV` | unset | `production` is refused, because the auth is development-only (arch §8.1) |

Empty values count as unset. The server doesn't load a `.env` file by itself. Either set the variables in your shell and use `npm run dev` / `npm start`, or put them in `services/backend/.env` and use the `:env` scripts:

```bash
npm run dev:env     # tsx watch --env-file=.env src/server.ts
npm run start:env   # node --env-file=.env dist/server.js (needs npm run build first)
```

On Node 20 the `:env` scripts fail with `.env: not found` if the file doesn't exist. Passing `-- --env-file=.env` to `npm run dev` or `npm start` does **not** work: npm hands the flag to the script, not to Node.

`.env` and `.env.*` are git-ignored. Never commit one.

## Development tokens

Each developer creates their own tokens. Only their SHA-256 hashes go in `dev-tokens.json`, which is git-ignored (arch §8.2).

1. Generate a token and keep it private. You will paste it into the web sign-in screen:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. Compute its hash:
   ```bash
   node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" <token>
   ```
3. Copy `dev-tokens.example.json` to `dev-tokens.json` and replace each placeholder with a hash.

The file layout:

```json
{"users": [{"userId": "u-analyst-1", "email": "analyst@example.test", "role": "analyst", "tokenSha256": "<64 lowercase hex>"}]}
```

Rules:
- **Structure:** the file is a JSON object with a non-empty `users` array and no other top-level field.
- **`userId`:** any non-empty string.
- **`email`:** must end in `example.test`. It is kept exactly as written.
- **`role`:** `viewer` or `analyst`.
- **`tokenSha256`:** exactly 64 hexadecimal characters, upper- or lower-case. Hashes are stored lower-case internally.
- **No unknown fields.** For example, a raw `token` field is rejected.
- **No duplicates:** user IDs (case-sensitive) and hashes (ignoring case) must each be unique. Emails need not be unique.

The example file's placeholders fail validation on purpose, so the example can't be used as a real token file.

## Setup and commands

Run these from `services/backend/`:

```bash
npm ci              # install exactly what package-lock.json records
npm run dev         # development server with reload on change (tsx watch)
npm run dev:env     # the same, loading variables from .env
npm run build       # compile TypeScript from src/ into dist/
npm start           # run the compiled server (needs npm run build first)
npm run start:env   # the same, loading variables from .env
npm run typecheck   # type-check src/ without emitting files
npm test            # run the tests (Node's built-in test runner)
npm run prisma:validate   # check prisma/schema.prisma (needs DATABASE_URL set; no connection is made)
npm run prisma:generate   # regenerate Prisma Client into node_modules (the postinstall script runs it on every npm ci)
npm run prisma:seed       # upsert development users from the token file (needs a migrated database)
```

**Database setup**, once a PostgreSQL database is available and `DATABASE_URL` points to it:

```bash
npx prisma migrate deploy   # apply prisma/migrations
npm run prisma:seed         # seed users from DEV_TOKENS_FILE (default ./dev-tokens.json)
```

**About the migration:**
- **How it was made:** generated from `schema.prisma` with `prisma migrate diff --from-empty --script`, with one manual edit. `Comparison.policies` is `NOT NULL`, because Prisma emits list columns without it although the field is required.
- **How it's protected:** `test/unit/migration.test.ts` fails if the schema and the migration drift apart. It needs no database.
- **When the schema changes:** create a new migration; never edit an applied one.

**About the seed:**
- **Validation:** it checks the token file with the same code as server start-up, and aborts before connecting if the file is invalid.
- **What it writes:** it upserts each user by `id`, writing only `id`, `email` and `role`. Users no longer in the file are kept.
- **What it prints:** only a count, never a token or a hash.
- **Configuration:** it's set in `package.json` under `"prisma": {"seed": ...}`. Prisma 6.19.3 prints a deprecation warning for that setting. Moving it to a `prisma.config.ts` file would stop Prisma from loading `.env` automatically.

**About Prisma:**
- **Version:** `prisma` and `@prisma/client` are pinned to exactly 6.19.3. Prisma 7 needs Node 20.19 or later, and npm's `latest` tag currently points at an 8.0 release candidate that needs Node 22.
- **Why `prisma` is a runtime dependency:** `prisma migrate deploy` runs when the container starts (arch §7.3).
- **Engine binaries aren't in `package-lock.json`.** Installation and `prisma generate` download them from `binaries.prisma.sh`, or from `PRISMA_ENGINES_MIRROR` if set. They include the Linux engine required by `binaryTargets`. Docker builds and CI need network access to that server.
- **`.env`:** Prisma's command-line tools read `DATABASE_URL` from `.env` automatically. The server itself does not; use the `:env` scripts.
- **Telemetry:** set `CHECKPOINT_DISABLE=1` to turn off Prisma's update check.

The server listens on `http://127.0.0.1:4000`. Check it with:

```bash
curl http://127.0.0.1:4000/api/v1/health
```

It binds to localhost only, because development auth must never be exposed beyond the developer's machine (arch §8.1). Running inside Docker will need a configurable host; that comes with the Dockerfile step.

## Layout

```text
src/
  app.ts               builds the Express app (no network listening; used by tests)
  server.ts            validates configuration, then starts the app on port 4000
  config/config.ts     environment variables: loadConfig(), ConfigError
  config/devTokens.ts  development token file validation
  logger.ts            JSON-lines logger with secret redaction
  middleware/          requestId, requestLogger, errors (ApiError, 404 and error handlers), jsonBody
  auth/devAuth.ts      bearer parsing, token lookup, requireAuth
  auth/policies.ts     analyst-only rule for ppoProjected
  routes/auth.ts       GET /api/v1/auth/me
  routes/replay.ts     GET /api/v1/replay/calendar
  routes/transactions.ts GET /api/v1/transactions (query parsing, item mapping)
  mappers/camelCase.ts snake_case → camelCase key mapping
  mappers/routeRequest.ts  transaction request → inference RouteRequest
  mappers/routeResponse.ts inference RouteResponse → §3.2 decision and database column values
  validation/transactionRequest.ts  POST /api/v1/transactions body validation
  db/seedDevUsers.ts   maps token-file users to User rows and upserts them
  db/prisma.ts         the single PrismaClient; Prisma events logged without message text
  db/health.ts         database probe for /api/v1/health (one query at a time)
  db/errors.ts         safe descriptions of Prisma errors for logs (name, code, frames)
  db/transactions.ts   TransactionRepository and its Prisma implementation (history list)
  inferenceClient/     client.ts (calls to /v1/*, live and mock), errors.ts (InferenceError, error mapping),
                       health.ts (inference status for /api/v1/health)
  lifecycle.ts         graceful shutdown
test/
  unit/                tests, named *.test.ts
  integration/         PostgreSQL tests; skipped unless CBDC_TEST_DATABASE_URL is set
  helpers/             shared test helpers (not tests)
scripts/
  run-tests.mjs        finds test/**/*.test.ts and runs them with node --test
prisma/
  schema.prisma        the seven models (API contract §6.3)
  migrations/          the initial migration and migration_lock.toml
  seed.ts              development-user seed (run with npm run prisma:seed)
dev-tokens.example.json  placeholder token file (committed)
```

`src/auth/`, `src/db/`, `src/inferenceClient/`, `src/mappers/`, `src/routes/`, `src/validation/` and `prisma/` already exist. Later steps add more repositories under `src/db/`, more mappers, `src/audit/`, more `src/routes/`, and more `test/integration/` tests (arch §4).

## Notes

- **Tests use `node:test`, not Vitest.** Vitest 5 needs Node 22 or later. Vitest 4.1.12 fails to install (npm crashes while resolving its optional peer dependencies). Vitest 3.2.x pulls in packages with known security advisories. Node's built-in runner, run through `tsx`, needs no test dependency.
- **Use `npm ci`, not `npm install`,** except when you are deliberately changing dependencies. Regenerate `package-lock.json` from a clean install (no `node_modules`).
- **Never commit secrets.** `.env*` and `dev-tokens.json` are git-ignored.

## Known advisory (accepted as a temporary risk)

`npm audit` reports 3 high-severity findings. They are one advisory, counted along its dependency chain.

| Item | Detail |
|---|---|
| Advisory | [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx): "DeepmergeTS has stack exhaustion when merging recursive object graphs" (CWE-674, uncontrolled recursion) |
| Affected package | `deepmerge-ts` below 8.0.0; installed 7.1.5 |
| Path | `prisma@6.19.3` → `@prisma/config@6.19.3` → `deepmerge-ts@7.1.5` |
| Severity | High (npm audit). The advisory gives no CVSS score. |
| Fix offered by npm | Prisma 7.10.1. Prisma 7 requires Node `^20.19`, outside our `>=20.6.0 <21`, and changes the client setup in arch §7.3. |

**Why it is accepted for now:**
- **The running server never loads it.** It is reached only through `@prisma/config`, the package that loads the Prisma command-line tool's own configuration. Neither `@prisma/client` nor the generated client references `deepmerge-ts`.
- **It only handles our own configuration.** The command-line tool merges developer-controlled settings (`prisma generate`, `validate`, `migrate deploy`), not request data. No user input reaches it.
- **The worst case is a crashed command,** not data exposure.

**Constraints:**
- `prisma` and `@prisma/client` stay pinned at exactly 6.19.3.
- No forced override of `deepmerge-ts`: 8.x is a major version that Prisma 6 hasn't been tested with.

**Revisit when:**
- Prisma publishes a 6.x release with a fixed `deepmerge-ts`;
- the team raises the Node minimum to 20.19 or later;
- the server starts passing untrusted input to the Prisma command-line tool.
