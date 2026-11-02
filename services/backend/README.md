# CBDC Liquidity Router: Application Backend (Phase 2B)

The Express + TypeScript application backend for Major Phase 2. Owner: Dev B.

It serves the public Application API (`/api/v1/*`) to the web frontend and applies development-only auth. It will call the internal inference service and persist decisions in PostgreSQL through Prisma. Routing logic never lives here; it belongs to the inference service.

- Architecture: [`docs/PHASE2_ARCHITECTURE.md`](../../docs/PHASE2_ARCHITECTURE.md)
- API contract: [`docs/PHASE2_API_CONTRACT.md`](../../docs/PHASE2_API_CONTRACT.md)

## Status

Steps 1–5D are implemented and covered by unit tests (243 tests, run with `npm test`; none needs a database). Step 5D provisionally reviewed; real PostgreSQL validation remains pending.

**Endpoints so far:**

| Endpoint | Auth | Since |
|---|---|---|
| `GET /api/v1/health` | Public | Step 1; full API contract §3.9 body since Step 5D |
| `GET /api/v1/auth/me` | Bearer token | Step 4 |

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
    - **`inference`:** `unavailable` until the inference client exists. Neither live calls nor mock fixtures are implemented yet, so `ok` or `mock` would be untrue.
    - **`status`:** `ok` only when both `database` and `inference` are `ok`; otherwise `degraded`. For now it is therefore always `degraded`.
  - **Errors from Prisma:** they are logged with their class name, `P####` code and stack frames only, never their message, which can contain the host, user or connection string. The client still gets the standard `500 INTERNAL_ERROR` envelope.
  - **Start-up:** the server starts even if the database is down.
  - **Logging:** database status changes are logged with a reason (`not_configured`, `timeout`, a Prisma error code or class name), never a message, URL or credential.
  - **Shutdown:** on `SIGINT`/`SIGTERM` the server stops accepting connections, disconnects Prisma and exits, forced after 10 s.

### Implemented but not yet tested against a real PostgreSQL database

The unit tests use fake database clients, and no database has been involved so far:
- **The migration** has not been applied to any database.
- **The seed** has not been run against a database. Only its token-file checks and its upsert calls have been tested, with a fake client.
- **A successful database connection** has not been verified. Health has been checked live only with `DATABASE_URL` unset, or pointing at a closed port; both correctly report `database: "unavailable"`.
- **Shutdown** is tested with fakes only. Windows can't deliver `SIGTERM` to another process, so a real signal-driven shutdown hasn't been exercised.
- **One check is still to do:** whether Prisma's drift detection accepts the migration's manual `NOT NULL` on `Comparison.policies`. Run `prisma migrate dev`, or `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url <url>`, against a development database.

### Remaining work

- **Database repositories:** saving and reading transactions, decisions, allocations, comparisons, explanations and audit log entries, append-only. Includes checking that the policy returned by inference matches `TransactionRequest.requestedPolicy` before saving.
- **When the server requires `DATABASE_URL`:** it stays optional until the repositories need it.
- **The inference client:** live mode with a 15 s timeout, mock mode, and the error mapping of API contract §5. After that, health reports a real `inference` value.
- **Mappers:** converting the engine's snake_case responses to the frontend's camelCase.
- **The remaining endpoints** (API contract §3.1):
  - **Read-only, via inference:** `/meta`, `/network`, `/state`, `/replay/calendar`, `/scenarios`;
  - **Transactions:** `POST /transactions`, `GET /transactions`, `GET /transactions/:id`;
  - **Explanation:** `GET /transactions/:id/explanation`;
  - **Comparisons:** `POST /comparisons`, `GET /comparisons/:id`;
  - **Dashboard:** `GET /dashboard/summary`.
- **Wiring the role check:** `authorizePolicies()` into the transaction and comparison endpoints.
- **Docker:** the backend `Dockerfile` and `.dockerignore`, including a configurable host for running inside Docker.
- **Integration tests** in `test/integration/` against a real PostgreSQL database.
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
  middleware/          requestId, requestLogger, errors (ApiError, 404 and error handlers)
  auth/devAuth.ts      bearer parsing, token lookup, requireAuth
  auth/policies.ts     analyst-only rule for ppoProjected
  routes/auth.ts       GET /api/v1/auth/me
  db/seedDevUsers.ts   maps token-file users to User rows and upserts them
  db/prisma.ts         the single PrismaClient; Prisma events logged without message text
  db/health.ts         database probe for /api/v1/health (one query at a time)
  db/errors.ts         safe descriptions of Prisma errors for logs (name, code, frames)
  lifecycle.ts         graceful shutdown
test/
  unit/                tests, named *.test.ts
  helpers/             shared test helpers (not tests)
scripts/
  run-tests.mjs        finds test/**/*.test.ts and runs them with node --test
prisma/
  schema.prisma        the seven models (API contract §6.3)
  migrations/          the initial migration and migration_lock.toml
  seed.ts              development-user seed (run with npm run prisma:seed)
dev-tokens.example.json  placeholder token file (committed)
```

`src/auth/`, `src/db/`, `src/routes/` and `prisma/` already exist. Later steps add the database repositories under `src/db/`, plus `src/inferenceClient/`, `src/mappers/`, `src/audit/`, more `src/routes/`, and `test/integration/` (arch §4).

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
