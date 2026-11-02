# Major Phase 2 — Team Architecture

**Status:** v0.3 (2 November 2026), proposed for team approval through the Phase 2 pull request. Nothing described here is implemented yet.
**Companion document:** `docs/PHASE2_API_CONTRACT.md`, which defines the endpoints, schemas and error codes.
**Baseline:** tag `phase1-complete` (`bc9905e`). Phase 1 code, data, checkpoints and results are read-only for Phase 2.

> **Scope rule.** Phase 2 turns the validated Phase 1 engine into a web application. It supports **historical replay** and **synthetic simulation** only. It does not use live bridge data, live FX feeds or streaming; those belong to Major Phase 3. Simulated values must always be labelled as simulated.

**Changes in v0.3:**
- Folder structure finalised (§4). Every Phase 2 test suite now sits outside Phase 1's `tests/`:
  - inference tests in `services/inference/tests/`;
  - end-to-end tests in a top-level `e2e/`.
- Compose moves to `infra/compose.yaml`.
- Python locks move to `services/inference/requirements/`, so there is no top-level `locks/`.
- The inference code is one package, `cbdc_inference/{api,engine}`.
- Docker:
  - each service has its own `.dockerignore`;
  - the inference image includes `src/` and the small data folders it reads;
  - only checkpoints are mounted, read-only (§4.2).
- `.gitattributes` applies to Phase 2 paths only. Each Phase 2 folder has its own `.gitignore`; the root `.gitignore` is unchanged.
- CODEOWNERS: making reviews mandatory requires GitHub branch protection or a ruleset (§3.1).
- One path-filtered CI workflow per service (§5.4). The Phase 1 suite no longer needs `--ignore`.

**Changes in v0.2:**
- Ownership split restated as fixed (§3).
- Concurrency design for the shared Phase 1 state (§6).
- Windows and Linux dependency lock strategy (§7).
- Development-only authentication (§8).
- Limits of explicit states and reference dates (§9).
- Open decisions updated (§11).

---

## 1. Fixed decisions

These come from Phase 1 results and from the project owner. Changing any of them needs explicit approval.

| # | Decision | Reason |
|---|---|---|
| D1 | **The liquidity-aware waterfall is the default routing policy.** | Stage 1F: PPO is not shown to beat the waterfall on reward (inconclusive in 5 of 6 scenarios). |
| D2 | **PPO + capacity projection (`ppo_projected`) is experimental.** It is off unless an approved checkpoint is configured, and every response labels it `experimental`. | Its capacity awareness comes from the projection, not the learned policy (Stage 1F). |
| D3 | **Raw PPO (no projection) is not served.** | It completes only 15.6% of transactions under a venue outage (Stage 1F). |
| D4 | **No checkpoint path is hard-coded.** A checkpoint is loaded only if it is listed, with its SHA-256, in an approval registry the project owner maintains (API contract §7). | No Phase 1 checkpoint has been approved for serving yet. |
| D5 | **Phase 1 code under `src/` is imported, never modified.** The inference service wraps `CBDCLiquidityEnv`, the baselines, the PPO model, the projection and `StaticMemoryProvider`. | Preserves Stage 1A–1F behaviour and the 193 regression tests. |
| D6 | **Feasibility comes only from `StaticMemoryProvider`.** Cognee is optional, off by default, and used for explanation text only. | Stage 1E influence boundaries. |
| D7 | **Responses report the amount-based unrouted figure and reward alongside the environment's.** | Stage 1F: the environment's accounting hides never-requested amounts. |
| D8 | **Reward weights are shown as placeholders** (all λ = 1.0, `status: "placeholder"`). | They are uncalibrated. |
| D9 | **The frontend talks only to the Express backend.** Only the backend calls the inference service. | One public API, one place for auth, persistence and audit. |
| D10 | **Phase 2 authentication is for development only** (§8). It must not be deployed beyond a developer's machine or a private Compose network. | Real identity management is Phase 3 production hardening. |

---

## 2. System overview

```text
 ┌────────────────────┐  same-origin   ┌───────────────────────┐   HTTP/JSON (internal)  ┌──────────────────────────────┐
 │  Web frontend       │  /api/v1/*     │  Application backend   │   /v1/*                 │  Inference service            │
 │  React + Vite +     │ ─────────────▶ │  Node + Express        │ ──────────────────────▶ │  FastAPI front process        │
 │  Tailwind           │ ◀───────────── │  Prisma                │ ◀────────────────────── │     │ dispatch                │
 │  (Dev C)            │  (Vite proxy)  │  (Dev B)               │                         │     ▼                         │
 └────────────────────┘                └──────────┬────────────┘                         │  Engine worker processes      │
                                                  │ Prisma                                │  (wrap Phase 1 src/) (Dev A)  │
                                                  ▼                                       └──────────────┬───────────────┘
                                       ┌───────────────────────┐                                         │ read-only
                                       │  PostgreSQL            │                         ┌──────────────▼───────────────┐
                                       │  requests, decisions,  │                         │  Phase 1 artefacts            │
                                       │  allocations, audit    │                         │  data/structured, processed,  │
                                       └───────────────────────┘                         │  knowledge; approved checkpoint│
                                                                                         └──────────────────────────────┘
        Contracts, mocks, Docker Compose, dependency locks, CI, end-to-end tests: Dev D (cross-cutting)
```

### Responsibility split between FastAPI and Express

There is one rule: **routing logic lives only in the inference service, and application state lives only in the backend.**

| Concern | Inference service (FastAPI) | Application backend (Express) |
|---|---|---|
| Feasibility, allocation, execution, metrics | Yes, computed by Phase 1 code | No. It never recomputes them. |
| Bridge state for a date, scenario or explicit spec | Yes | Passes it through and caches the read-only lookups |
| Policy selection and defaulting | Applies the default and enforces the experimental gate | Passes the choice through after its role check (§8) |
| Persistence, history, analytics | No. It is stateless. | Yes |
| Users, auth, audit log | No. Internal network only. | Yes (development-only auth) |
| Response shape for the UI | Engine schema (snake_case) | Application schema (camelCase), mapped field for field with no recalculation |

The inference service is **stateless and deterministic for a given platform and device**: the same request against the same artefacts returns the same body. Baseline results are identical across platforms. PPO results may differ in the last floating-point digits between CPU and CUDA, or between operating systems; `provenance.device` records which was used. `decision_id` hashes the canonical request plus the artefact versions, never the outputs, so it is identical everywhere.

---

## 3. Team of four: roles and ownership

**This split is fixed.** Each developer owns their directories, and pull requests touching another owner's directory need that owner's review (enforced as described in §3.1).

| Dev | Role | Owns (directories) | Main deliverables |
|---|---|---|---|
| **A** | **Phase 2A: inference engine and FastAPI** | `services/inference/` (except the generated lock files) | A `route(transaction, state, policy)` interface over Phase 1 code; replay, scenario and explicit state modes; the isolated engine-worker design (§6); checkpoint registry and gate; `/v1/*` endpoints; parity, concurrency-isolation and API tests in `services/inference/tests/`; the inference `Dockerfile`, `Dockerfile.dockerignore` and the `requirements/*.in` inputs. |
| **B** | **Phase 2B: Express + Prisma backend** | `services/backend/` (Express, Prisma schema, migrations, seed) | The `/api/v1/*` endpoints; Prisma models and migrations; the inference client with timeout and mock mode; snake_case → camelCase mapping; persistence; history and dashboard aggregates; development-only auth and role checks (§8); audit log; backend unit and integration tests; the backend `Dockerfile`. |
| **C** | **Phase 2C: React frontend** | `services/web/` (React, Vite, Tailwind) | Transaction form; route inspector; corridor/network view; bridge monitor; policy comparison; explanation panel; history and dashboard; mandatory labels (§5.3); dev sign-in and token handling (§8.3); mock mode (MSW); component and UI tests; the web `Dockerfile`. |
| **D** | **Phase 2D: contracts, Docker, CI and E2E** | `contracts/`, `infra/`, `e2e/`, `services/inference/requirements/*.txt` (generated locks), `.github/CODEOWNERS`, `.github/workflows/phase2-*.yml`, `.gitattributes`, `.nvmrc`, `docs/PHASE2_*.md` (with review from all) | OpenAPI specs from the API contract; shared JSON fixtures; mock servers; Docker Compose with `mock` and `full` profiles; the dependency lock strategy and lock generation (§7); CI workflows for every service; contract-conformance checks; end-to-end tests. Also proposes fixes for the earlier CI review findings (Windows-only root lock, tests that depend on the working directory) for owner approval. Those fixes would touch Phase 1 files (`requirements-lock.txt`, `tests/`, `.github/workflows/tests.yml`), so they need explicit approval. |

Each developer reviews any pull request that changes a contract they consume. Dev A writes `services/inference/requirements/*.in`; Dev D compiles and maintains the locks generated from it.

### 3.1 CODEOWNERS and enforcing reviews

`.github/CODEOWNERS` maps each folder to its owner:

```text
/services/inference/                 @<dev-a>
/services/inference/requirements/    @<dev-a> @<dev-d>
/services/backend/                   @<dev-b>
/services/web/                       @<dev-c>
/contracts/                          @<dev-a> @<dev-b> @<dev-c> @<dev-d>
/infra/  /e2e/  /.github/  /.gitattributes  /.nvmrc   @<dev-d>
/docs/PHASE2_*.md                    @<dev-a> @<dev-b> @<dev-c> @<dev-d>
/src/  /data/  /outputs/  /tests/  /requirements*.txt   @<project-owner>
```

The `@<…>` handles are placeholders, to be replaced with real GitHub usernames.

**CODEOWNERS alone only requests reviews; it doesn't require them.** To make an owner's approval mandatory, the repository admin must:
- enable **branch protection** on `main` (or a **repository ruleset** targeting `main`), with "Require a pull request before merging" and "Require review from Code Owners";
- add the CI workflows as **required status checks**;
- block direct pushes and force-pushes to `main`.

Other conditions:
- Code owners need write access to the repository, or GitHub ignores them.
- When a line lists several owners, any one of them can approve. If a folder needs approval from every consumer (as `contracts/` does under §10), that has to be checked during review; CODEOWNERS can't express it.
- Branch protection and rulesets on private repositories depend on the GitHub plan.

Until the admin configures this, ownership is a team agreement only.

---

## 4. Repository structure

Phase 2 adds new files and folders only. **No Phase 1 file is moved or edited.** That covers:
- `src/`, `data/`, `outputs/`, `tests/` and `venv/`;
- the root scripts and CSVs;
- `requirements.txt` and `requirements-lock.txt`;
- the root `.gitignore`, `CLAUDE.md` and `README.md`;
- `.github/workflows/tests.yml`.

Any change to them needs the owner's approval.

```text
cbdc-liquidity-router/
│
├── src/  data/  outputs/  tests/  venv/             ┐
├── run_*.py  test_run.py  *_analysis.py/.csv        │ Phase 1, all unchanged
├── requirements.txt  requirements-lock.txt          │ (no files moved or edited)
├── .gitignore  CLAUDE.md  README.md                 │
├── .github/workflows/tests.yml                      ┘
│
├── docs/
│   ├── (Phase 1 docs, unchanged)
│   ├── PHASE2_ARCHITECTURE.md                       # all devs review; D maintains
│   └── PHASE2_API_CONTRACT.md
│
├── contracts/                                       # Dev D (A, B, C must approve changes)
│   ├── openapi/
│   │   ├── inference.v1.yaml
│   │   └── app.v1.yaml
│   ├── fixtures/
│   │   ├── inference/   route/ compare/ explain/ state/ errors/
│   │   └── app/         transactions/ comparisons/ auth/ dashboard/ errors/
│   └── README.md
│
├── services/
│   ├── inference/                                   # Dev A
│   │   ├── cbdc_inference/
│   │   │   ├── api/          FastAPI app, routers, pydantic schemas, error handlers
│   │   │   ├── engine/       route(), state frames, worker pool, policies, explain
│   │   │   └── settings.py
│   │   ├── config/approved_checkpoints.json          # owner-maintained; ships empty
│   │   ├── requirements/                             # A writes *.in, D generates locks (§7)
│   │   │   ├── service.in   cognee.in
│   │   │   ├── linux-x86_64-cpu.txt
│   │   │   ├── windows-x86_64-cpu.txt
│   │   │   └── windows-x86_64-cu130.txt
│   │   ├── tests/            unit/ parity/ concurrency/ api/  conftest.py
│   │   ├── Dockerfile
│   │   ├── Dockerfile.dockerignore
│   │   ├── .gitignore        .venv/, caches
│   │   ├── pyproject.toml    pytest config for this service only
│   │   └── README.md
│   │
│   ├── backend/                                     # Dev B
│   │   ├── src/              routes/ inferenceClient/ mappers/ auth/ audit/ db/
│   │   ├── prisma/           schema.prisma  migrations/  seed.ts
│   │   ├── test/             unit/ integration/
│   │   ├── dev-tokens.example.json
│   │   ├── package.json  package-lock.json  tsconfig.json
│   │   ├── Dockerfile  .dockerignore
│   │   ├── .gitignore        node_modules/, dist/, .env, dev-tokens.json
│   │   └── README.md
│   │
│   └── web/                                         # Dev C
│       ├── src/              pages/ components/ api/ auth/ mocks/
│       │   └── api/generated/  types generated from contracts (git-ignored)
│       ├── public/
│       ├── test/
│       ├── package.json  package-lock.json  vite.config.ts  tailwind.config.ts
│       ├── Dockerfile  .dockerignore
│       ├── .gitignore        node_modules/, dist/, .env*
│       └── README.md
│
├── infra/                                           # Dev D
│   ├── compose.yaml          profiles: mock, full
│   ├── env/                  *.env.example only (real .env files git-ignored)
│   ├── postgres/             init scripts
│   ├── mocks/                Prism mock-server config pointing at contracts/openapi
│   ├── scripts/              lock compilation, fixture checks (Python, not .sh/.ps1 pairs)
│   ├── .gitignore            env/*.env
│   └── README.md
│
├── e2e/                                             # Dev D
│   ├── specs/                sign-in → submit → route → persist → explain
│   ├── package.json  package-lock.json  playwright.config.ts
│   └── .gitignore
│
├── .github/
│   ├── CODEOWNERS            new; enforcement needs branch protection (§3.1)
│   └── workflows/
│       ├── tests.yml                 Phase 1, unchanged
│       ├── phase2-inference.yml
│       ├── phase2-backend.yml
│       ├── phase2-web.yml
│       └── phase2-integration.yml
│
├── .gitattributes            new: line-ending rules for Phase 2 paths only
└── .nvmrc                    new: the one Node version for backend, web and e2e
```

### 4.1 Purpose of each Phase 2 folder

| Folder | Owner | Purpose |
|---|---|---|
| `contracts/` | D | The machine-readable contract and shared fixtures. All three mock modes (backend mock, MSW, Prism) read the same fixtures, so they are never copied. Splitting the fixtures by API lets Dev A regenerate the engine fixtures without touching the app ones. |
| `services/inference/` | A | The engine and FastAPI service. Its code is one package, `cbdc_inference`, so it can't clash on `sys.path` with Phase 1's `src` package or with installed packages. It has its own tests, locks, `.venv`, Dockerfile and pytest configuration, and it never uses the Phase 1 `venv/`. |
| `services/inference/requirements/` | A (`*.in`), D (`*.txt`) | Only this service uses the Phase 2 Python locks, so they live next to it. The root `requirements-lock.txt` stays as the record that reproduces Phase 1. |
| `services/inference/tests/` | A | Parity, concurrency and API tests. They are outside Phase 1's `tests/`: the repository has no `conftest.py` or `pytest.ini`, so `python -m pytest tests/` would collect anything placed under it. |
| `services/backend/` | B | Express, the Prisma schema, migrations and seed, development auth, the inference client and mappers. |
| `services/web/` | C | React, Vite and Tailwind. The MSW mocks read `contracts/fixtures/app/`. TypeScript types are generated from `contracts/openapi/app.v1.yaml`. |
| `infra/` | D | Compose, environment templates, the database init, mock servers and cross-platform Python scripts. Each service keeps its own Dockerfile, so its owner can change the build without a cross-team PR. |
| `e2e/` | D | Playwright and API smoke tests across the whole stack, with their own `package.json`. Kept apart from Phase 1 pytest. |
| `.github/workflows/phase2-*.yml` | D | One workflow per service, each triggered only by changes to its own folders. |

Conflict avoidance:
- Each Node service has its own `package-lock.json`. There are no npm workspaces and no root `package.json`.
- Each Phase 2 folder has its own `.gitignore`, so the root `.gitignore` is never edited.
- The only files several developers may change are `contracts/` and these two documents, and both need approval from every consumer.

### 4.2 Working directory and container layout

The engine imports Phase 1 as the `src` package. Phase 1 opens relative paths such as `data/structured/...`, so **engine worker processes run with the repository root as their working directory**. The worker initialiser calls `os.chdir(CBDC_REPO_ROOT)`, so it doesn't matter how the server was started. In the container, `CBDC_REPO_ROOT=/repo`.

The inference image:
- is built with the **repository root as its build context**, using `services/inference/Dockerfile` and its own `Dockerfile.dockerignore` (supported by BuildKit, the default builder in Compose v2);
- uses that ignore file as an allow-list, which copies only `src/`, `data/structured/`, `data/processed/`, `data/knowledge/` and `services/inference/` to `/repo`;
- excludes everything else: `data/raw/` (about 255 MB, not read at inference), `outputs/`, `.cognee/`, `venv/`, `tests/` and caches;
- has approved checkpoints mounted read-only at run time (`../outputs/experiments` → `/repo/outputs/experiments`, read-only). They are never copied into the image, and without an approved checkpoint nothing is mounted.

Because code and data are part of the image, a Windows host never needs a bind mount from a OneDrive folder at run time. The backend and web images use their own folders as build context, each with its own `.dockerignore`. Compose paths in `infra/compose.yaml` are relative to `infra/`, for example `context: ..` for inference and `context: ../services/backend`. They resolve the same way on Windows and Linux.

---

## 5. Module boundaries

### 5.1 Inference service internals (Dev A)

```text
cbdc_inference/api/ (FastAPI: validation, routing, errors — imports NO Phase 1 module)
   │  submit(task) ──► EnginePool (§6)
   ▼
cbdc_inference/engine/ — engine worker process:  route(transaction, state, policy) ──► RouteResult (plain dataclass)
   ├── state.build_frame(state)     historical_replay → the worker's baseline daily table (no copy)
   │                                scenario          → Stage 1F perturb(baseline, scenario) — new frame
   │                                explicit          → copy of baseline with the request's rows overridden (§9)
   ├── with injected_daily_state(frame):   (Stage 1F mechanism, unchanged; per-process only)
   │     ├── feasibility            CBDCLiquidityEnv.get_feasibility_mask() → StaticMemoryProvider
   │     ├── policy                 waterfall (default) | cheapest_feasible | ppo_projected (gated)
   │     │                          baselines.py | Stage1DRawObservationWrapper + PPOActorCritic
   │     │                          (deterministic) + capacity_projection.project_capped_simplex
   │     ├── execution              CBDCLiquidityEnv.step() — the Phase 1 evaluation path
   │     └── regime label           transaction_generator.true_regime_for_row()
   └── explain                      StaticMemoryProvider.explain() + template text; Cognee optional
```

Rules:
- `cbdc_inference/engine/` doesn't import FastAPI, and `cbdc_inference/api/` doesn't import `src/`. Phase 1 state exists only inside engine worker processes.
- Every policy result goes through **`CBDCLiquidityEnv.step()`**. There is no second execution or reward implementation.
- **Parity:** on Phase 1 datasets, `route()` must reproduce the per-transaction action, executed amount, unrouted amount and reward of the Phase 1 evaluation path (`src/training/evaluate.py`, `src/backtesting/evaluation.py`). Baselines must match exactly; PPO within 1e-6.
- PPO inference runs on **CPU** by default. GPU is opt-in (`CBDC_DEVICE=cuda`).

### 5.2 Backend boundaries (Dev B)

- `inferenceClient` is the only module that calls the inference service: a 15 s timeout (longer than the engine's 10 s task timeout), with errors mapped as in API contract §5. `INFERENCE_MODE=mock` serves `contracts/fixtures/inference/`.
- `mappers/` converts engine responses to application responses field for field. Mappers never compute a metric.
- `auth/` implements development-only auth (§8). Every route except `/api/v1/health` requires it.
- Engine responses are stored verbatim as JSON (`engineResponse`), next to the normalised columns used for queries.

### 5.3 Frontend boundaries (Dev C)

- `api/` is a typed client for the relative path `/api/v1/*` (same origin through the Vite proxy), typed from `contracts/openapi/app.v1.yaml`. `VITE_API_MODE=mock` enables MSW.
- Components only display values from the API. They don't recompute allocations or metrics.
- Mandatory labels:
  - liquidity, congestion and risk are **Simulated**;
  - explicit states are **User-supplied synthetic state**;
  - `ppo_projected` is **Experimental**;
  - reward weights are **Placeholder weights**;
  - the default policy is **Default (waterfall)**;
  - venues tagged `synthetic_bridge_expansion` are **Synthetic venue**;
  - a persistent banner reads **Development authentication — not secure**.
- The UI states that replay transactions don't consume liquidity (§9.3).

### 5.4 Integration (Dev D)

- `contracts/` is the shared source of truth once it exists. Until then, `docs/PHASE2_API_CONTRACT.md` is.
- CI workflows. Each is path-filtered, so one service's failure doesn't block another's pull request:

  | Workflow | Triggered by changes to | Runs |
  |---|---|---|
  | `tests.yml` (Phase 1, unchanged) | as today | `python -m pytest tests/` with its existing deselections. Phase 2 tests are outside `tests/`, so no `--ignore` is needed. |
  | `phase2-inference.yml` | `services/inference/**`, `src/**`, `data/**`, `contracts/**` | `pytest services/inference/tests` on Linux and Windows, using each platform's lock; parity, concurrency and API tests; the inference image build |
  | `phase2-backend.yml` | `services/backend/**`, `contracts/**` | `npm ci`, lint, unit and integration tests (mock inference), Prisma migrate against a service PostgreSQL; the backend image build |
  | `phase2-web.yml` | `services/web/**`, `contracts/**` | `npm ci`, lint, type check, component tests (MSW), production build; checks that no token appears in the bundle |
  | `phase2-integration.yml` | `contracts/**`, `infra/**`, `e2e/**`, every lock file, `.nvmrc` | fixture validation against OpenAPI; lock-drift and install checks (§7.4); `npm ci` on Ubuntu and Windows; the Compose `full` profile with `e2e/` on Linux |

- These workflows only become merge gates once the admin marks them as required status checks (§3.1).

### 5.5 Developing independently with mocks

| Module | Depends on | Mock used until the real one is ready |
|---|---|---|
| Inference (A) | Phase 1 `src/` only | None needed. A replaces the hand-written inference fixtures with engine-generated ones. |
| Backend (B) | Inference API | `INFERENCE_MODE=mock` (in-process fixture stub), or a Prism mock of `contracts/openapi/inference.v1.yaml` on port 8000 |
| Frontend (C) | Application API | `VITE_API_MODE=mock`: MSW serving `contracts/fixtures/app/`, with mock-only tokens (§8.3) |
| Integration (D) | All of them | Compose `mock` profile: Prism for both APIs; `full` profile: real services |

Fixtures cover every response in the contract, including regulatory rejection, partial completion, a disabled experimental policy, invalid date, explicit state without history, 401/403, and inference unavailable.

| Service | Port |
|---|---|
| Inference (FastAPI) | 8000 (Compose-internal only) |
| Backend (Express) | 4000 |
| Web (Vite dev server / preview) | 5173 |
| PostgreSQL | 5432 (Compose-internal only) |

---

## 6. Concurrency and isolation of the shared Phase 1 state

### 6.1 The problem

Phase 1 was written for single-threaded batch evaluation. It holds state in process-wide mutable objects:

| Object | Read by | Risk under concurrent requests |
|---|---|---|
| `dynamic_bridge_state._daily_df_cache[DAILY_PARQUET_PATH]` | `get_dynamic_state()`, which is called by env execution and observations, both baselines and the regime label | Stage 1F's `injected_daily_state()` swaps this entry. Two requests with different states would read each other's liquidity. |
| `Stage1DRawObservationWrapper._daily_df` | CNN windows | Same problem, per wrapper instance |
| `risk_proxy._macro_risk_cache`, `cost_baseline._cache`, `stage1c_windowing._shared_cnn` | risk, cost baseline, CNN | Lazy initialisation can race |
| `CBDCLiquidityEnv.current_step` and `requests_df` | `step()` | Instance state; an env can't be shared between requests |

A single worker that handles one request at a time avoids interleaving, but it isn't enough:
- one slow request blocks every other request, including health checks;
- a request that fails mid-swap, or a bug that mutates a cache, silently corrupts every later request;
- nothing detects that corruption.

### 6.2 Design: isolated engine worker processes

1. **The FastAPI process holds no Phase 1 state.** It validates requests and submits each one as a task to an `EnginePool`. This is a `concurrent.futures.ProcessPoolExecutor` using the **spawn** start method on every platform (`multiprocessing.get_context("spawn")`), so Windows and Linux behave the same. Size: `CBDC_ENGINE_WORKERS`, default 2.
2. **One task at a time per process.** A process-pool worker runs one task at a time, and processes share no memory. Each Phase 1 global is therefore touched by one request at a time, and never by two requests at once.
3. **The worker initialiser warms everything eagerly**, removing lazy-initialisation races:
   - `chdir` to the repo root;
   - load the daily table, macro-risk table, RPW cost baselines for all corridors, normalisation stats and knowledge base;
   - build the shared CNN;
   - load the approved checkpoint, if any, on the configured device, in `eval()` mode;
   - call `torch.set_num_threads(1)`;
   - keep the baseline daily table as `BASELINE_FRAME` and record its fingerprint (`pandas.util.hash_pandas_object` → SHA-256).
4. **State is scoped to the request:**
   - Replay uses `BASELINE_FRAME` as is.
   - A scenario uses `perturb(BASELINE_FRAME, scenario)`, which returns a new frame. Each worker memoises at most 6 such frames, one per scenario; they are read-only.
   - An explicit state uses a new copy of the baseline with only the request's rows overridden (§9.1). It is discarded after the task.
   - The frame is installed with the unchanged Stage 1F `injected_daily_state()` context manager, which restores the previous entry on exit, even after an exception. The wrapper's `_daily_df` is set and restored the same way.
   - Each worker keeps one `CBDCLiquidityEnv`, built in the initialiser. Before each task it is given a one-row `requests_df` and `current_step = 0`, as `src/training/evaluate.py` does. It is never shared between processes or between concurrent tasks.
5. **Integrity guard (fail closed).** After every task the worker checks that:
   - the cache entry *is* `BASELINE_FRAME` again (an identity check);
   - the wrapper frame is restored;
   - the fingerprint is unchanged (a cheap check; the daily table has about 16,000 rows).

   If any check fails, the task returns `INTERNAL_ERROR` with no result. The pool is then marked unhealthy and rebuilt, and `/v1/health` reports `degraded` until it's back.
6. **Timeouts.** Each task has a timeout (`CBDC_ENGINE_TASK_TIMEOUT_S`, default 10 s). On timeout the request fails with `ENGINE_TIMEOUT`, and the pool is recycled, because a running process-pool task can't be cancelled.
7. **Backpressure.** At most `CBDC_ENGINE_MAX_QUEUE` tasks wait (default 32). Beyond that, the service returns `503 ENGINE_BUSY` immediately rather than queueing without limit.
8. **Server workers.** Engine state lives only in pool processes, so the FastAPI layer can use any number of async workers. Each uvicorn worker owns its own pool. The default is one uvicorn worker with 2 engine workers.

### 6.3 Why not the alternatives

| Alternative | Why it was rejected |
|---|---|
| A single worker | Head-of-line blocking; no isolation from corruption; no detection of it |
| Threads with a global lock | Serialises all engine work in the process; lazy caches and the CNN singleton stay exposed to code that bypasses the lock; a failure inside the lock leaves corrupted state in the process |
| Refactoring Phase 1 to pass state explicitly | Not allowed (D5) |
| Patching Phase 1 functions at runtime | Changes Phase 1 behaviour without changing its files; harder to audit than process isolation |

### 6.4 Required tests (Dev A)

- **Isolation:** many concurrent mixed requests (replay, `cheapest_venue_outage`, explicit states on the same date and corridor). Each result must equal its serial reference result exactly, and the baseline fingerprint must be unchanged afterwards.
- **Fault injection:** a task that raises inside the injected-state block leaves the cache restored, and the next request is correct.
- **Integrity failure:** a deliberately corrupted cache triggers `INTERNAL_ERROR`, a pool rebuild and `degraded` health.
- **Timeout and backpressure:** `ENGINE_TIMEOUT` and `ENGINE_BUSY` paths.
- These tests run on both Windows and Linux, because spawn behaviour and import paths differ.

---

## 7. Dependency lock strategy (Windows development, Linux Docker)

### 7.1 The problem

The root `requirements-lock.txt` is a `pip freeze` of the Windows development venv, and it is the record that reproduces Phase 1 results. It can't build a Linux image:
- it pins Windows-only packages (`pywin32`, `python-magic-bin`) with no platform markers;
- it leaves out `torch`, whose wheel depends on the accelerator (`2.13.0+cu130` on the development machine);
- it includes the whole Cognee stack, which Phase 2 doesn't need by default.

### 7.2 Python

| Rule | Detail |
|---|---|
| One Python version | **3.10.11** everywhere. Docker uses `python:3.10.11-slim-bookworm`, pinned by digest. CI uses 3.10.11. |
| Inputs | `requirements.txt` (Phase 1 direct dependencies, unchanged) plus `services/inference/requirements/service.in` (FastAPI, uvicorn, pydantic, httpx and test tools; owned by Dev A). Cognee and its dependencies are in a separate `services/inference/requirements/cognee.in`, installed only when `CBDC_ENABLE_COGNEE=true`. |
| Compiler | `uv pip compile`, which can resolve for another platform (`--python-platform`, `--python-version 3.10.11`). Every lock can therefore be produced from any one machine, with `--generate-hashes`. |
| Generated locks (`services/inference/requirements/`, owned by Dev D) | `linux-x86_64-cpu.txt` (Docker and Linux CI; `torch==2.13.0+cpu` from the PyTorch CPU index); `windows-x86_64-cpu.txt` (developers without an NVIDIA GPU, Windows CI); `windows-x86_64-cu130.txt` (the GPU development machine; `torch==2.13.0+cu130`). Optional `cognee-<platform>.txt` locks follow the same pattern. Generation is a cross-platform Python script in `infra/scripts/`. |
| Platform-only packages | Must carry markers (`; sys_platform == "win32"`), or appear only in the matching platform's lock. |
| Install | `pip install --require-hashes --no-deps -r services/inference/requirements/<platform>.txt` into `services/inference/.venv` (never the Phase 1 `venv/`), then `pip check`. The Dockerfile installs `linux-x86_64-cpu.txt`. Torch is part of each lock, with its index set in the lock header, so there is no second torch install step. |
| Root lock | Stays unchanged as the Phase 1 reproduction record. Adding markers to it, the earlier review finding, needs the owner's approval. |

### 7.3 Node (backend and web)

| Rule | Detail |
|---|---|
| One Node version | Node 20 LTS, pinned exactly in the root `.nvmrc`, in each `package.json` `engines` (backend, web, e2e) and in Docker (`node:20.x.y-bookworm-slim` by digest). npm ≥ 10. |
| One lock per package | `services/backend/`, `services/web/` and `e2e/` each have their own `package-lock.json`; there are no npm workspaces. Each lock is cross-platform. Generate it from a clean install (no `node_modules`) so the optional platform binaries for every OS are recorded (esbuild, Rollup, Prisma engines). |
| Install | Always `npm ci`, never `npm install`, in CI and Docker. |
| Containers build their own `node_modules` | `services/backend/.dockerignore` and `services/web/.dockerignore` exclude `node_modules`, `dist`, `.env*` and `dev-tokens.json`, so host binaries and secrets never enter an image. `services/inference/Dockerfile.dockerignore` is an allow-list (§4.2). |
| Prisma | `binaryTargets = ["native", "debian-openssl-3.0.x"]`. `prisma generate` runs inside the image build; `prisma migrate deploy` runs at container start. |

### 7.4 Cross-platform hygiene and checks

- **Line endings.** The development machine has `core.autocrlf=true`, so a Windows checkout gives text files Windows line endings, which breaks shell scripts inside Linux containers. The root `.gitattributes` therefore sets `text=auto eol=lf` for Phase 2 paths only (`services/**`, `infra/**`, `contracts/**`, `e2e/**`, `.github/workflows/phase2-*.yml`). It has no global `* text=auto` rule, so no Phase 1 file is renormalised.
- **Case and length.** Use lower-case folder and file names; Linux CI catches imports with the wrong case. Set `git config core.longpaths true` on Windows to handle deep `node_modules` paths.
- **No symlinks** in Phase 2 folders: Windows needs Developer Mode to create them.
- No OS-specific paths in code. Python uses `pathlib`; Node uses `path`.
- On Windows, run Docker Desktop with the WSL 2 backend. Clone the repository outside OneDrive-synced folders: sync locks slow down and break builds, and they also affect the read-only checkpoint mount (§4.2).
- CI checks:
  - **lock drift:** recompile every lock and fail on any diff;
  - **install:** each lock installs and passes `pip check` on its platform;
  - `npm ci` passes on both Ubuntu and Windows runners;
  - the Docker images build.

---

## 8. Development-only authentication

### 8.1 Scope

Phase 2 auth exists so that the prototype has users, roles and an audit trail. **It is not production security.** The backend runs only with `AUTH_MODE=dev`, and it refuses to start if:
- `NODE_ENV=production`;
- `AUTH_MODE` has any other value;
- the token file is missing or empty;
- any stored hash is malformed.

It binds to `localhost` or the private Compose network only. Phase 3 replaces this with a real identity provider (for example OIDC) and removes dev mode.

### 8.2 Backend (Dev B)

- **Tokens are never committed.**
  - Each developer generates their own random token locally: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
  - `services/backend/dev-tokens.json` is git-ignored. It stores only the **SHA-256 of each token**, with the user ID, email (`*.example.test`) and role (`viewer` or `analyst`).
  - The committed `dev-tokens.example.json` holds placeholders only.
- Requests send `Authorization: Bearer <token>`. The backend hashes the token and compares it with `crypto.timingSafeEqual`. A token that isn't 64 hex characters is rejected before any lookup.
- **Roles are enforced on the server.** Only `analyst` may request `ppoProjected`, alone or in a comparison; anyone else gets `403 FORBIDDEN_POLICY`. Hiding options in the UI is convenience only.
- `GET /api/v1/auth/me` returns the caller's identity and role (API contract §3.0).
- Users are seeded into PostgreSQL from `dev-tokens.json` (the hashes are not copied).
- The audit log records the user ID and request ID, never the token. Request logging redacts `Authorization`.
- The frontend is same-origin through the Vite proxy, so CORS stays disabled by default. If it is ever enabled, only `http://localhost:5173` is allowed, and never with `*`.

### 8.3 Frontend token handling (Dev C)

- **Sign-in:** a development sign-in screen where the developer pastes their token. The UI then calls `/api/v1/auth/me` to validate it and learn the role.
- **Storage:** the token is held in memory (React context) and mirrored to `sessionStorage`, so a page reload keeps the session but closing the tab ends it. It is cleared on sign-out and on any 401. It is **never** written to:
  - `localStorage` or cookies;
  - URLs or query strings;
  - logs, error reports or analytics;
  - persisted developer-tool state.
- **Never in build configuration:** tokens must not appear in `VITE_*` environment variables or source code. Vite inlines `VITE_*` values into the built JavaScript bundle.
- **Transport:** only the API client attaches the token, as `Authorization: Bearer`, and only to the same-origin `/api/v1` path.
- **Errors:** a 401 clears the token and returns to sign-in. A 403 `FORBIDDEN_POLICY` shows a message without signing out.
- **Mock mode:** MSW accepts the fixed mock tokens `mock-viewer` and `mock-analyst`. The real backend rejects them, because they aren't 64-hex tokens.
- **Accepted risk:** `sessionStorage` can be read by script injected into the page. This is accepted for a local development prototype only. Phase 3 must use an identity provider, httpOnly cookies and a strict content security policy.

---

## 9. Explicit synthetic states and reference-date limitations

### 9.1 What an explicit state can and cannot set

| Input | Source in explicit mode | Overridable? |
|---|---|---|
| Venue set, slot order, fees, `data_source_tag` | `bridge_network.csv` | No |
| Current liquidity per venue | Caller | Yes (required) |
| Current congestion per venue | Caller | Yes (required) |
| 30-day liquidity/congestion history per venue | Caller, optional (required for `ppo_projected`) | Yes |
| Corridor risk | Phase 1 risk proxy at `reference_date` | **No**. In Phase 1, risk is one value per corridor and month, shared by all its venues; per-venue risk would change the semantics. |
| Cost baseline | Lagged quarterly RPW baseline at `reference_date` | **No** |
| Regulatory feasibility | `StaticMemoryProvider` (facts are undated today) | **No** |
| Split label and the model-has-seen-it warning | `reference_date` | No |

How it works:
- The engine copies the baseline daily table and overrides the caller's venues at `reference_date`. If `history` is supplied, it overrides the 30 days from `reference_date − 29` to `reference_date`. Execution, baselines, CNN windows and the regime label then read that copy (§6.2).
- **If `history` is omitted,** only the `reference_date` row changes. The baselines read only that row, so they are exact. `ppo_projected` is refused with `POLICY_UNAVAILABLE_FOR_STATE`, because its 30-day window would mix synthetic and replay values.
- Values are normalised with the frozen train-only statistics. Values outside a venue's train-period range return `STATE_OUTSIDE_TRAINING_RANGE`. PPO behaviour on such inputs is out of distribution and unvalidated.
- Explicit states can't be combined with scenarios in v1. Responses label them `values_provenance: "user_supplied_synthetic"`, and they are never presented as replay data.

### 9.2 Reference and replay date limits

- **Range:** 2011-01-01 to 2025-09-30, minus the 30-day gap buffers around split boundaries (Phase 1 `validate_simulation_date()`). This includes the first 30 days of 2011 and the last 30 days before 2025-09-30.
- **No future dates:** no data exists after 2025-09-30. A "today" what-if must use explicit mode with a valid `reference_date`, and the response states that cost and risk context comes from that date.
- **"Historical" means synthetic history.** Replay shows the Phase 1 synthetic daily simulation, conditioned on real lagged data. It is not observed bridge history.
- **No unseen dates:**
  - train dates were used to train PPO;
  - validation dates were used to select checkpoints;
  - test dates were examined in Phase 1.

  Responses report `provenance.split`. For `ppo_projected`, a train-split date also triggers `DATE_IN_TRAINING_SPLIT`.
- **Cost-baseline granularity:** the RPW baseline is quarterly and lagged by one quarter, so it is constant within a quarter. ARE→MEX has no real RPW anchor and uses the documented USA→MEX fallback (`SYNTHETIC_COST_ANCHOR` warning).
- **Risk granularity:** monthly. Locally supplied FRED daily FX begins around 2021-08; earlier months rely on WDI/CPI-derived signals or an unconditioned default. When the proxy is unavailable, the static placeholder is used (`RISK_FALLBACK_USED`).
- **Knowledge:** facts are undated today, and dated facts can't affect feasibility (Stage 1E). The reference date doesn't change feasibility.
- **Scenarios** multiply the whole series, so the 30-day CNN window is stressed too, as in Stage 1F. They are not calibrated shocks.

### 9.3 No liquidity carry-over between transactions

Phase 1 treats each transaction as an independent one-step episode. Execution doesn't deplete a venue for the next transaction. In Phase 2:
- every transaction on the same date and state sees the same liquidity, however many are submitted;
- persisted transactions never reduce later availability;
- dashboard totals are sums of independent what-if decisions, not a simulated ledger.

The UI must say so. Modelling depletion would be a new simulator feature and needs approval.

---

## 10. Integration workflow

1. **Contract first.** Endpoint or schema changes start as a pull request to `docs/PHASE2_API_CONTRACT.md` (later `contracts/`), approved by the producer and every consumer before implementation.
2. **Versioning.** Both APIs use `/v1`. Adding an optional field is non-breaking. Removing or renaming a field, or changing its type or meaning, is breaking. Consumers ignore unknown fields.
3. **Branches.** Each developer works on their own feature branch (Dev A: `feature/phase2-inference`) and opens pull requests after CI passes. No direct commits to `main`. Pushes and merges follow the project owner's approval.
4. **Milestones.**

   | Milestone | Done when |
   |---|---|
   | M0 | Contract approved; fixtures, mock servers and locks published (D) |
   | M1 | Each module works against mocks |
   | M2 | Backend calls the real inference service; Compose `full` runs on Linux and on Windows (Docker Desktop) |
   | M3 | End to end: sign in → submit → route → persist → read back → explain |
   | M4 | Phase 2 exit criteria met (roadmap §3); docs updated |

5. **Definition of done for any PR:**
   - its tests pass on the required platforms;
   - the Phase 1 suite passes unchanged;
   - conformance with the contract is checked;
   - locks are in sync;
   - no secrets or tokens are committed;
   - no Phase 1 file is modified.

---

## 11. Open decisions (need the owner's approval)

1. **Which checkpoint, if any, to approve for `ppo_projected`.** The candidates are the six Stage 1F multi-seed checkpoints. Until one is approved, it stays disabled.
2. **Whether viewers may see `ppo_projected` in comparisons.** The draft says no: analysts only.
3. **Cognee in Phase 2.** Off by default in the draft. Turning it on needs local Ollama, the `cognee` lock, and adds only explanation text.
4. **How checkpoints are distributed** to other machines: they stay tracked under `outputs/`, or move to release assets.
5. **Whether to fix the root lock now** (platform markers) or leave it frozen as the Phase 1 record (draft: leave it; Phase 2 uses `services/inference/requirements/`).
6. **Engine pool defaults** (`CBDC_ENGINE_WORKERS=2`, a 10 s timeout, a queue of 32), to be confirmed after measurement.
7. **Who administers GitHub branch protection or rulesets** (§3.1), and the real GitHub handles for CODEOWNERS.

Resolved in v0.2: the concurrency approach (§6), the lock strategy (§7) and the development auth model (§8). Resolved in v0.3: the folder structure and container layout (§4).
