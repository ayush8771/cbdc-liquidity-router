# Major Phase 2 — Implementation Status

**As of:** 24 November 2026, after the merge into `main`. [PR #14](https://github.com/ayush8771/cbdc-liquidity-router/pull/14) merged `feature/phase2-platform` (head `350137f`) into `main` on 24 November 2026 at 14:00:11 UTC as merge commit `28da68f`, and all 11 check runs on that commit passed (§8.4). Evidence also comes from the branch at `e5c4a25` and the acceptance and redeploy smoke runs recorded in §8.
**Sign-off:** the project owner recorded **Phase 2 integration sign-off** on 24 November 2026 (`docs/PHASE3_SCOPE.md` D-14). It is **not** production readiness and **not** formal OpenAPI approval: the OpenAPI files stay DRAFT and the open items below stay open.
**Design and rules:** `docs/PHASE2_ARCHITECTURE.md`, and `docs/PHASE2_API_CONTRACT.md` (**approved v0.4, normative**). Decisions and open questions: contract §10 and `docs/TEAM_REVIEW_RESOLUTION.md` §16.
**Scope:** this page tracks progress. It defines no rule. Where it and the contract differ, the contract wins.

> **Contract authority.** `docs/PHASE2_API_CONTRACT.md` **v0.4 is the authoritative, normative API definition.** The OpenAPI files in `contracts/openapi/` (`app.v1.yaml`, `inference.v1.yaml`, both 0.4.0) remain **DRAFT pending formal approval by Dev A, B and C** (arch §10), and are not independently normative. Any difference between an OpenAPI file and the contract is a bug in the OpenAPI file. `infra/scripts/check_contracts.py` enforces their agreement in CI. See §5 and `contracts/README.md`.

## How to read this page

| Label | Meaning |
|---|---|
| **Implemented** | The code exists and its tests pass in the environment named. It doesn't mean "verified against the real dependencies" |
| **Verified** | Implemented, and a required check has been run at the commit named, with the result recorded here |
| **Awaiting verification** | Implemented, but a required check hasn't been run at the current commit, or its last recorded result predates the code |
| **Blocked** | Can't proceed until another developer delivers something |
| **Awaiting decision** | Needs a recorded decision by the named person (contract §10) |
| **Not started** | Planned in the architecture or contract; nothing is in the repository |

No item here is "approved" unless the contract or `TEAM_REVIEW_RESOLUTION.md` records the approval.

## Milestones (arch §10)

| Milestone | Done when | State |
|---|---|---|
| M0 | Contract approved; fixtures, mock servers and locks published (D) | **Partial.** The contract is approved (v0.4, PR #3 and PR #4). Fixtures (86), the contract checker, the root `.nvmrc` and the Node locks are published. **Open:** the OpenAPI files are still DRAFT pending formal approval, and no fixture-backed mock server exists (Q20 deferred) |
| M1 | Each module works against mocks | **Done.** Backend unit tests run against mock inference handlers; the web app has its own test suite; the inference service has its own pytest suite |
| M2 | Backend calls the real inference service; Compose `full` runs on Linux and Windows | **Done.** The backend calls the real `/v1/*` over the private Compose network (`INFERENCE_URL=http://inference:8000`). The `phase2-stack` workflow runs the `full` profile on ubuntu-24.04; the same stack was run on Windows 11 with Docker Desktop (§8) |
| M3 | End to end: sign in → submit → route → persist → read back → explain | **Done.** Verified in the browser and over HTTP at `76fe95e` (acceptance, §8.1) and again at `e5c4a25` after redeploy (§8.3) |
| M4 | Phase 2 exit criteria met; docs updated | **Integrated and merged; not marked done.** The stack is in `main` (PR #14, `28da68f`), CI is green there, the three acceptance defects are closed and integration sign-off is recorded (D-14). Remaining: formal OpenAPI approval and the other open items below |

## Integration (M2/M3)

All services are in `main` and run together from `infra/compose.yaml` (`--profile full`): `postgres`, `migrate` (one-shot), `inference`, `backend`, `web`. Only `web` is published, on host loopback; backend (4000), inference (8000) and PostgreSQL (5432) stay on the private network. The optional `seed` profile upserts the development `User` rows.

- **Inference service** (`services/inference/`, 52 files) is merged into `main` and serves `/v1/*` to the backend. It was previously developed on `feature/ayush-inference-engine` and is no longer separate.
- **Backend** (`services/backend/`, 108 files) calls the real inference service, persists to PostgreSQL through Prisma, and serves the 15 Application API pairs of contract §3.1.
- **Web app** (`services/web/`, 195 files) is a React application served by nginx, which proxies `/api` to the backend. It exists and is integrated; the earlier note that no `services/web/` existed is obsolete.
- **Docker** (`services/{backend,inference,web}/Dockerfile`) is delivered for every service, with a configurable bind host for containers (`BIND_HOST`), and `migrate` and `build`/`test` targets in the backend image.
- **End-to-end checks** (`e2e/`): `api-smoke.py`, `stack-security.py` and the Playwright browser suite (`tests/app.spec.ts`).

## Backend (Dev B, `services/backend/`)

Details: `services/backend/README.md`.

### Implemented

- **All 15 method/path pairs of contract §3.1:**
  - health, liveness, `auth/me`;
  - meta, network, scenarios, replay calendar, state;
  - transactions: create, list, get, explanation;
  - comparisons: create, get;
  - dashboard summary.

  `API_ROUTES` in `services/backend/src/app.ts` matches §3.1 exactly, and so do the paths in `contracts/openapi/app.v1.yaml` (15 pairs in all three, cross-checked 24 November 2026).
- **Request handling:**
  - development bearer-token auth with the analyst-only `ppoProjected` rule;
  - strict request validation;
  - the §4 error envelope with fixed messages;
  - 405 with `Allow`;
  - request IDs;
  - redacted logging.
- **Inference client:**
  - error mapping, including `NOT_READY` → `INFERENCE_UNAVAILABLE` and `Retry-After` forwarding;
  - engine field-path mapping;
  - the shared GET cache with §5 fingerprint invalidation;
  - the short dedicated health timeout of contract §5 (`INFERENCE_HEALTH_TIMEOUT_MS = 3000`, capped by the request timeout).
- **Persistence:** Prisma schema and migrations. Records are append-only, each written atomically with its audit row. The stored engine response keeps its exact binary64 doubles (`src/db/exactEngineResponse.ts`; see D1 in §8.2).
- **Comparisons:** the Q18 rules (aliases, role defaults, result order, effective `state`, `skipped` messages unchanged).
- **Dashboard:** aggregation in SQL over stored decision columns, with `meanFeeCostPct` from `feeCostUsd`.
- **CI:** `phase2-integration.yml` runs the backend suite against a PostgreSQL service container, and `phase2-docker.yml` builds and tests the backend image targets. The earlier plan for a separate `phase2-backend.yml` was met by these workflows instead.

### Verified

- **Unit and integration suites in CI**, on pushes to the branches in the workflow triggers and on pull requests. All four workflows are green at `28da68f` (§8.4). This supersedes the 16 November local-only record: the previously outstanding "independent run of the committed revision against PostgreSQL" is now done by `phase2-integration` whenever a push or pull request matches its paths.
- **Historical local record,** kept for provenance: at `5414275` (16 November 2026, Node 24.7.0, outside the declared `>=20.6.0 <21`), `npm test` reported 1469 passed with no database and 1543 passed with `cbdc_router_test` (74 integration tests), `tsc --noEmit` and the build exited 0, and `prisma validate` was valid. That evidence lived in a session log outside the repository and was not reproducible from it; CI now provides the reproducible record.

### Not started (Dev B)

- **Response-size limit:** a limit on inference responses, which waits for expected sizes from Dev A.

### Owner decisions, recorded 18 November 2026 (contract §10)

- **Q11a:** a non-UUID `:id` returns 404 on the transaction, explanation and comparison detail routes. Implemented.
- **Q22:** legacy failed rows may return `failure: null`; new failed transactions store their actual failure code. Implemented.
- **Q14:** authentication before method validation, except the public health endpoints. Implemented and in CI: an unauthenticated unsupported method is 401, an authenticated one 405 with `Allow`.

### Blocked or awaiting decision (Dev B)

| Item | Waiting on |
|---|---|
| Fixture-backed mock mode: in `INFERENCE_MODE=mock`, every inference-backed route returns 503 today | Q20 decision (Nisarga, Anvesh, Varshini); deferred by the owner on 18 November 2026, not blocking live inference integration |
| Caller-facing behaviour when a database write fails after inference succeeded (implemented as 500) | Not defined by the contract (`TEAM_REVIEW_RESOLUTION.md` §6) |
| `AuditLog` `action` and `outcome` values (provisional in the schema) | Team agreement |

## Contracts and integration tooling (Dev D, `contracts/`, `infra/`)

- **Implemented:**
  - both OpenAPI files (**DRAFT 0.4.0, not independently normative**; the contract stays authoritative — see the note at the top);
  - 86 fixtures for both APIs;
  - the `decision_id` and daily-state test vectors;
  - `infra/scripts/check_contracts.py` with its tests;
  - `infra/compose.yaml`, `infra/env/*.env.example`, `infra/README.md`;
  - the root `.nvmrc`, `.gitattributes` and the Node lockfiles;
  - `e2e/` (API smoke, runtime security checks, Playwright browser suite);
  - the workflows `phase2-integration.yml` (contract + backend), `phase2-docker.yml` (images, compose configuration, tracked-secret guard) and `phase2-stack.yml` (the whole stack).
- **Verified:** the contract checker and its tests run in `phase2-integration` on pushes and pull requests that match its paths, green at `28da68f` (86 fixtures, 2 OpenAPI documents: OK; 193 infrastructure tests passed on each OS). The 16 November local run under Python 3.11 (rather than the pinned 3.10.11) printed "86 fixtures, 2 OpenAPI documents: OK" with 139 checker tests passing.
- **Awaiting decision:** **formal OpenAPI approval** (Dev A, B and C; recorded by Ayush — `TEAM_REVIEW_RESOLUTION.md` §15). Until then the OpenAPI files stay DRAFT and `docs/PHASE2_API_CONTRACT.md` v0.4 is authoritative. This is the one remaining part of M0.
- **Not started:** `infra/mocks/` (a fixture-backed mock server), which depends on Q20; and the remaining fixture coverage of `TEAM_REVIEW_RESOLUTION.md` §3, item 12.
- **Known documentation gap:** `infra/env/web.env.example` is not used by Compose (the nginx image takes no `VITE_*` values at run time); it describes `VITE_API_MODE` as `live`/`mock` where the app accepts `live`/`preview`, and lists `VITE_PROXY_TARGET`, which `vite.config.ts` does not read. Recorded in `infra/README.md`.

## Inference service (Dev A, `services/inference/`)

- **Merged into `main`** and running in the Compose stack, built from `services/inference/Dockerfile` with the repository at `/repo` (`CBDC_REPO_ROOT`). It reports `/v1/version`, including the `CBDC_GIT_COMMIT` build argument, which is the source of `gitCommit` in `GET /api/v1/meta`.
- It wraps the frozen Phase 1 engine (tag `phase1-complete`) without changing it; `src/`, `tests/`, `data/` and `outputs/` are untouched by Phase 2.
- Its own pytest suite lives in `services/inference/tests/` and never runs as part of Phase 1's `python -m pytest tests/`.
- **Awaiting decision:** **checkpoint approval for `ppo_projected`** (arch §11.1) — `approved_checkpoints.json` is empty, **no checkpoint is approved**, and no checkpoint is mounted in Compose, so `ppoProjected` is disabled (§7). Engine pool defaults (arch §11.6) are also undecided.
- Contract §9.1 requirements (A-1 to A-9) are not separately re-assessed on this page.

## Web app (Dev C, `services/web/`)

- **Implemented and integrated.** A React application built with Vite and served by nginx, which proxies `/api` to the backend. Screens: sign-in, dashboard, new transaction, history, transaction detail, comparison, network/bridge monitor.
- Development authentication keeps the token in `sessionStorage` only (`cbdc.devToken`); it is never placed in the URL, a cookie or the rendered page (verified in the browser, §8.1).
- The data screens start at 1024 px; below that breakpoint the comparison and new-transaction screens show a placeholder. Form state is held above that switch, so crossing the breakpoint no longer discards input (see D2 in §8.2).
- Its own Vitest suite runs in the web image's `test` target. Last recorded: 1341 tests in 43 files passing in the `web image` job at `28da68f`. An earlier run at `ec64763` gave the same counts, eslint clean, under Node 20.20.2 via `docker build --target test`.

## Open items (unchanged by the integration sign-off)

Integration sign-off (D-14) was recorded with these items open. It closes none of them.

1. **Formal OpenAPI approval** (Dev A, B and C; Ayush records it) — the last open part of M0.
2. **Response-size limit** on inference responses (Dev B), pending expected sizes from Dev A.
3. **Q20** fixture-backed mock mode and `infra/mocks/` — deferred, not blocking.
4. **F1** Phase 1 cost-baseline unit (contract §10) — Phase 2 passes the value through unchanged; any correction is a separately reviewed, versioned Phase 1 change.
5. **`AuditLog` `action`/`outcome` values** — provisional, awaiting team agreement.
6. **Remaining fixture coverage** of `TEAM_REVIEW_RESOLUTION.md` §3, item 12.

## Known limitations (unchanged)

These are properties of the system as delivered and merged.

- **`ppoProjected` is disabled.** No checkpoint is approved (`approved_checkpoints.json` is empty) and none is mounted. `GET /api/v1/meta` reports `ppoProjected` as `enabled: false`, `status: "experimental"`, `checkpoint: null`. An analyst requesting it gets `409 POLICY_DISABLED`; a viewer gets 403; in a comparison it is `skipped`, not an error. Enabling it needs the owner's checkpoint approval (arch §11.1).
- **Phase 1's findings stand.** PPO is **not** shown to beat the liquidity-aware waterfall on reward, and the trained policy is **not** liquidity-aware on its own — the inference-time capacity projection is what makes it capacity-aware. `docs/STAGE1D_RESULTS.md` and `docs/STAGE1F_RESULTS.md` are authoritative.
- **Data, liquidity and congestion are synthetic**, and all data ends 2025-09-30. No genuinely independent out-of-time holdout exists. Stress scenarios are uniform multipliers, not calibrated shocks, and the reward weights are placeholders (all λ = 1.0).
- **Float32 tolerance.** Policy actions are float32, so Σ `share_requested` may differ from 1 by about 2 × 10⁻⁷ relative and `completion_ratio` may be slightly above 1. Consumers must not assume `completion_ratio ≤ 1` (contract §2.8).
- **Development authentication only.** Bearer tokens from a git-ignored `dev-tokens.json` of SHA-256 hashes, intended for a container published on host loopback. Not a production authentication scheme.
- **Stage 1E knowledge population is deferred.** Feasibility comes only from the deterministic knowledge base through `StaticMemoryProvider`; Cognee is limited to explanations and audit, and knowledge is never a PPO input.
- **`INFERENCE_MODE=mock` returns 503** on every inference-backed route until Q20 is decided.
- **Phase 3 implementation is not started:** no live feeds, no streaming, no production inference. Only planning documents exist (`docs/PHASE3_SCOPE.md`).

## Evidence

### 8.1 Acceptance test run (`76fe95e`, 24 November 2026)

Full record: `ACCEPTANCE_REPORT.md` in the evidence directory outside the repository (`C:\dev\cbdc-test-logs\phase2-acceptance\`), with `results.json` and raw responses.

**155 automated tests: 151 PASS, 4 FAIL, 0 BLOCKED, 0 NOT TESTED** — 38 browser tests (Playwright + Google Chrome against the real UI) and 117 Application API tests. The 4 failures were 3 distinct defects, all low severity (one counted twice because the contract states its rule in two places). All ten acceptance areas passed. `ppoProjected` was confirmed disabled at the start and at the end of the run.

### 8.2 The three acceptance defects are closed

| ID | Defect | Resolution |
|---|---|---|
| **D1** | Stored records were not byte-identical to their `201` body: floats came back with the 17th significant digit dropped (contract §3.4, §3.6, §6.1) | **Fixed** in `9b78983`. Prisma Client reduced every double in a `Json` field to 16 significant digits; each store now follows its insert with an `$executeRaw` UPDATE writing `JSON.stringify(engineResponse)::jsonb` in the same transaction. No column type, migration, engine behaviour or engine output changed |
| **D2** | The Compare form silently discarded every field and the policy selection when the window crossed the 1024 px breakpoint | **Fixed** in `ec64763`. `useCompareState()` moved into `ComparePage`, above the layout switch, matching `NewTransactionPage` |
| **D3** | `completionRatio` could exceed 1.0 under liquidity stress (e.g. `1.000000011175871`) | **Documented, not changed**, in `e5c4a25`. The cause is Phase 1's float32 action vector; changing it would alter every routing output and invalidate the recorded Stage 1D and 1F results. Contract §2.8 now states the tolerance and tells consumers not to assume `completion_ratio ≤ 1` |

### 8.3 Redeploy smoke run (`e5c4a25`, 24 November 2026, Windows 11 + Docker Desktop)

`backend` and `web` were rebuilt and recreated from `infra/compose.yaml` with `--no-deps`; `postgres`, `inference` and `migrate` were left running and the `pgdata` volume was never removed. All five services healthy afterwards.

**36 of 36 checks passed:**

- `e2e/api-smoke.py`: **21 passed, 0 failed** — nginx and backend health (database and inference ok), analyst and viewer identity, `/meta` with `ppoProjected` disabled, `/network`, transaction create/get/list/explanation, comparison create/get, the four 401 paths, viewer 403 and analyst 409 on `ppoProjected`, SPA shell and deep link.
- **D1 re-verification: 10 passed, 0 failed** — POST `201` against GET compared by exact `repr` of every float: one transaction and three separate comparisons round-trip identically; repeated GETs byte-identical; the documented float32 tolerance holds.
- **D2 re-verification: 2 passed** — the Comparison form and the New transaction form both keep Corridor, Amount, Date and Client reference across 1440 → 1000 → 1440 px, and the Comparison form keeps both checked policies and their order.
- **Browser health, login and routing: 3 passed** — unauthenticated redirect with protected routes guarded, analyst sign-in through the real backend with the token out of the page, and a waterfall replay transaction routed from the form.
- **Preservation:** the acceptance transaction `b65cc68b-3c4d-4b99-86e6-16af6ee075cd` ("UAT-ROUTE-002") returned **byte-identical** to its pre-rebuild and pre-recorded form. Row counts rose only by what the smoke tests created (transactions 108 → 110, comparisons 30 → 34, audit 149 → 157); nothing was lost.

### 8.4 CI

All four workflows are green on the merge commit `28da68f` in `main` (push runs, 24 November 2026), and were green at `e5c4a25` before the merge. **11 of 11 check runs** on `28da68f` concluded `success`:

| Workflow | Run | Check runs and results |
|---|---|---|
| `tests` | 45409280838 | `pytest`: 183 passed, 10 deselected (they need the git-ignored raw datasets) |
| `phase2-integration` | 45409280504 | `contract conformance` on ubuntu-24.04 and windows-latest: 86 fixtures, 2 OpenAPI documents OK, 193 infrastructure tests passed on each; `backend PostgreSQL integration`: 1838 passed, 0 failed, 0 skipped |
| `phase2-docker` | 45409280448 | `changed areas`, `tracked secret files`, `compose configuration`; `backend images`: 1761 passed; `web image`: 43 files, 1341 tests passed; `inference image`: 426 passed, 1 warning |
| `phase2-stack` | 45409280659 | `full stack`: API smoke 21 passed, 0 failed; Playwright (Chromium) 7 passed; runtime security checks passed |

What each workflow covers:

| Workflow | What it covers |
|---|---|
| `tests` | Phase 1 suite (`python -m pytest tests/`), unchanged by Phase 2 |
| `phase2-integration` | Contract checker and fixtures; backend suite against a PostgreSQL service container |
| `phase2-docker` | Image builds and targets, compose configuration resolution, tracked-secret guard |
| `phase2-stack` | The `full` profile on ubuntu-24.04: build, image/compose match, start, seed twice, API smoke, Playwright Chromium browser suite, runtime security checks |

`phase2-stack` is the Linux half of M2 and, with §8.3, the evidence for M3 on both platforms.
