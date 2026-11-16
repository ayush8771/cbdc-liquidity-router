# Major Phase 2 — Implementation Status

**As of:** 16 November 2026. Evidence comes from `feature/phase2-backend` at `5414275` and the local remote-tracking refs. Other developers' branches were read from local refs, which may lag their remotes.
**Design and rules:** `docs/PHASE2_ARCHITECTURE.md`, and `docs/PHASE2_API_CONTRACT.md` (approved v0.4, normative). Decisions and open questions: contract §10 and `docs/TEAM_REVIEW_RESOLUTION.md` §16.
**Scope:** this page tracks progress. It defines no rule. Where it and the contract differ, the contract wins.

## How to read this page

| Label | Meaning |
|---|---|
| **Implemented** | The code exists and its tests pass in the environment named. It doesn't mean "verified against the real dependencies" |
| **Awaiting verification** | Implemented, but a required check hasn't been run at the current commit, or its last recorded result predates the code |
| **Blocked** | Can't proceed until another developer delivers something |
| **Awaiting decision** | Needs a recorded decision by the named person (contract §10) |
| **Not started** | Planned in the architecture or contract; nothing is in the repository |

No item here is "approved" unless the contract or `TEAM_REVIEW_RESOLUTION.md` records the approval.

## Milestones (arch §10)

| Milestone | Done when | State |
|---|---|---|
| M0 | Contract approved; fixtures, mock servers and locks published (D) | **Partial.** The contract is approved (v0.4, PR #3 and PR #4). Fixtures and the contract checker are published. The OpenAPI files are still DRAFT. Mock servers, the root `.nvmrc` and the Node locks are not in this branch |
| M1 | Each module works against mocks | **Backend: implemented** (unit tests with mock inference handlers). Inference and web: not assessed here |
| M2 | Backend calls the real inference service; Compose `full` runs on Linux and Windows | **Not started** |
| M3 | End to end: sign in → submit → route → persist → read back → explain | **Not started** |
| M4 | Phase 2 exit criteria met; docs updated | **Not started** |

## Backend (Dev B, `services/backend/`)

Details: `services/backend/README.md`.

### Implemented

- **All 15 method/path pairs of contract §3.1:**
  - health, liveness, `auth/me`;
  - meta, network, scenarios, replay calendar, state;
  - transactions: create, list, get, explanation;
  - comparisons: create, get;
  - dashboard summary.

  `API_ROUTES` in `services/backend/src/app.ts` matches §3.1 exactly.
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
  - the shared GET cache with §5 fingerprint invalidation.
- **Persistence:** Prisma schema and two migrations. Records are append-only, each written atomically with its audit row.
- **Comparisons:** the Q18 rules (aliases, role defaults, result order, effective `state`, `skipped` messages unchanged).
- **Dashboard:** aggregation in SQL over stored decision columns, with `meanFeeCostPct` from `feeCostUsd`.
- **Last verified (2026-11-16, Node 24.7.0, which is outside the declared `>=20.6.0 <21`):**
  - `npm test`: 1469 passed, 0 failed;
  - `tsc --noEmit` and a build: both exit 0;
  - `prisma validate`: valid.

### Awaiting verification

- **PostgreSQL integration at `5414275` (verification-only task).** The endpoints and the PostgreSQL integration suites are already implemented. The only outstanding work is an independent run of the exact committed revision. The result was previously reported as passing, but that report is not an independent verification of this commit.
  - **Historical report:** on 2026-11-16 at 16:22 UTC, about 49 minutes before the commit, `npm test` on the pre-commit working tree against `cbdc_router_test` reported 1543 passed, 0 failed, 0 skipped (74 integration tests across the four suites). Migrations were up to date, and a read-only check afterwards found every table empty.
  - **Where the evidence lives:** in a Claude Code session log outside the repository, not in a repository artifact. It is not reproducible from the repository.
  - **Consistency with HEAD:** checked on 2026-11-16 without a database, its test titles match the committed test set (`services/backend/README.md` §7.3).
  - **Older history:** the earlier 16/16 integration result (691 in total) predates these suites.
  - **To verify the committed code:** re-run at `5414275` and record the result.
- **Node 20.** The declared runtime has not been re-checked since the latest changes.

### Not started (Dev B)

- **Inference health timeout:** the short dedicated timeout of contract §5. Today the probe uses the 15 s `INFERENCE_TIMEOUT_MS`.
- **Backend CI:** `.github/workflows/phase2-backend.yml` (arch §5.4). No CI job runs the backend tests.
- **Docker:** the backend `Dockerfile`, and a configurable bind host for containers (arch §7.3).
- **Response-size limit:** a limit on inference responses, which waits for expected sizes from Dev A.

### Blocked or awaiting decision (Dev B)

| Item | Waiting on |
|---|---|
| Fixture-backed mock mode: in `INFERENCE_MODE=mock`, every inference-backed route returns 503 today | Q20 decision (Nisarga, Anvesh, Varshini) |
| Calling the real inference service | Dev A's service on this integration line, and `infra/compose.yaml` (Dev D) |
| Q11a (non-UUID `:id`; implemented as 404) | Recorded decision by Anvesh |
| Q14 (405 before or after auth; implemented before) | Recorded decision by Anvesh |
| Q22 (legacy failed rows return `failure: null`) | Decision by the contract owner (Ayush) |
| Caller-facing behaviour when a database write fails after inference succeeded (implemented as 500) | Not defined by the contract (`TEAM_REVIEW_RESOLUTION.md` §6) |
| `AuditLog` `action` and `outcome` values (provisional in the schema) | Team agreement |

## Contracts and integration tooling (Dev D, `contracts/`, `infra/`)

- **Implemented:**
  - both OpenAPI files (**DRAFT**, not independently normative);
  - fixtures for both APIs;
  - the `decision_id` and daily-state test vectors;
  - `infra/scripts/check_contracts.py` with its tests;
  - the `phase2-integration.yml` workflow (contract job only).

  On 2026-11-16, run under Python 3.11 rather than the pinned 3.10.11: the checker printed "86 fixtures, 2 OpenAPI documents: OK", and its tests passed (139).
- **Awaiting decision:** formal OpenAPI approval (Ayush; `TEAM_REVIEW_RESOLUTION.md` §15).
- **Not started in this branch:**
  - `infra/compose.yaml`, `infra/env/`, `infra/postgres/`, `infra/mocks/`;
  - the root `.nvmrc` and locks (a branch `infra/p0-env-nvmrc-locks-script` exists on the remote but hasn't been reviewed here);
  - `e2e/`;
  - the remaining fixture coverage of `TEAM_REVIEW_RESOLUTION.md` §3, item 12.

## Inference service (Dev A, `services/inference/`)

- Developed on `feature/ayush-inference-engine`. Its local ref at `a2d8ab1` has 41 files under `services/inference/`, and the remote has moved since. **It is not merged into the backend or platform branches.**
- The requirements in contract §9.1 (A-1 to A-9) are not assessed here.
- **Awaiting decision:** checkpoint approval for `ppo_projected` (arch §11.1; no checkpoint is approved), and engine pool defaults (arch §11.6).

## Web app (Dev C, `services/web/`)

- No `services/web/` exists on any branch visible in the local refs. Not assessed further.

## Next tasks, in dependency order

1. **Verify the backend against PostgreSQL at the committed `5414275`** (Dev B; **verification only**: no implementation or test changes are needed). A pre-commit run reported 1543 passed, but no run of the commit is recorded. Run `npx prisma migrate deploy` and `npm test` with `CBDC_TEST_DATABASE_URL` on a disposable `*_test` database, then record the commit, date, PostgreSQL version and summary lines. It needs no decision and no other developer.
2. **Contract housekeeping** (Anvesh, Ayush): record decisions for Q11a and Q14 (Anvesh) and Q22 (Ayush), and confirm the Q18 wording in contract §3.6 during branch review.
3. **Short inference health timeout** (Dev B, contract §5).
4. **Backend CI workflow** `phase2-backend.yml` (Dev B with Dev D, arch §5.4).
5. **Review and merge** `feature/phase2-backend` into `feature/phase2-platform` (project owner). The branch also carries the Q18 contract, OpenAPI, fixture and checker changes.
6. **Fixture-backed mock mode**, after the Q20 decision.
7. **Cross-service integration** (M2): the inference service merged, `infra/compose.yaml`, and the backend calling the real `/v1/*`.
8. **End to end** (M3), and formal OpenAPI approval.
