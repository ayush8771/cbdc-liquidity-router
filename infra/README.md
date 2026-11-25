# infra/ (Dev D)

Cross-platform tooling for Phase 2 integration (arch §4, §5.4, §7).

| Path | Status |
|---|---|
| `scripts/check_contracts.py` | Contract conformance for `contracts/`. Its tests are in `scripts/tests/`, and it runs in `.github/workflows/phase2-integration.yml`. |
| `scripts/requirements.txt` | Pinned tooling for the scripts. Install it into `infra/.venv`, never into the Phase 1 `venv/`. |
| `scripts/compile_locks.py` | Compiles the hashed inference locks from `services/inference/requirements/service.in` with pinned `uv` 0.9.5 (`--check` for lock drift, `--verify-only` to check the committed locks, `--dry-run` to print the commands). Only the Linux CPU lock (`linux-x86_64-cpu.txt`) is defined; see the script's docstring. Tests: `scripts/tests/test_compile_locks.py`. |
| `env/*.env.example` | Variable templates for inference, backend, web and PostgreSQL (contract §8). The examples hold placeholders only. For Compose, copy them to a directory **outside the checkout** (see "Compose setup"); `test_env_examples.py` fails if a real `env/*.env` exists here. Tests: `scripts/tests/test_env_examples.py`. |
| `compose.yaml` | The local stack, profile `full`: postgres, a one-shot `migrate`, inference, backend and web. Only web is published, on `127.0.0.1:${WEB_HOST_PORT:-8080}`. An optional `seed` service has its own profile. Validated end to end on Windows with Docker Desktop (Docker 29.9.2, Compose 5.6.1, Buildx Bake 0.38.1) and on Ubuntu 24.04 in CI (`phase2-stack`, green at the PR #14 merge commit `28da68f`); see "Compose setup" and "Windows build error". |
| `postgres/`, `mocks/` | Not yet written (next steps). |

## Prerequisites

- **Docker with Compose v2.** The repository states no minimum versions beyond Compose v2 with BuildKit (arch §4.2); on Windows it asks for Docker Desktop with the WSL 2 backend, and a checkout **outside OneDrive** (arch §7.4). The detailed local validation used Docker Engine 29.9.2, Compose 5.6.1 and Buildx 0.38.1 (the Bake version named in the Windows build error below) on Windows 10 with Docker Desktop (WSL 2). The later acceptance and redeploy runs used Windows 11 with Docker Desktop (`docs/PHASE2_STATUS.md` §8). CI runs the `full` profile on Ubuntu 24.04, building the images with plain `docker build` and starting them with `up --no-build`. Other versions and platforms are untested.
- **Resources.** The validation machine gave Docker 4 CPUs and 5.7 GiB of memory. At rest the stack used about 0.7 GiB (inference) plus under 0.1 GiB for each other service. The images are large (inference about 2 GB, backend 0.7 GB, web 0.3 GB, plus PostgreSQL), so allow several GB of disk. The first build needs network access (PyPI and the PyTorch wheel index, `binaries.prisma.sh` for Prisma engines, `apt`) and takes minutes; the inference image took about 9 minutes cold.
- **On the host:** `git`, and Node 20 (`.nvmrc`) only for generating token hashes (see "2. Development tokens"). Python 3.10 is needed only for the infrastructure tests.
- **Shells.** Commands are from the repository root. PowerShell is shown where Windows differs; bash is for Linux/macOS (these exact commands are not validated; CI exercises the stack on Ubuntu 24.04 through its own steps). The differences are the way variables are set (`$env:NAME = "value"` versus `export NAME=value`), `$HOME\cbdc-env` versus `~/cbdc-env`, and `\` versus `/` in the `infra/.venv` paths.

## Compose setup

`infra/compose.yaml` runs web (nginx) -> backend (Express) -> inference (FastAPI) and PostgreSQL. All services are in the profile `full`, so every command needs `--profile full`. Run all commands from the repository root. Real env files and passwords stay outside the checkout.

**Network exposure.** Only `web` is published, on `127.0.0.1:8080` (loopback only). The backend (4000), inference (8000) and PostgreSQL (5432) are not published to the host; they are reachable only from other containers in the project network.

**Three different web ports, not to be confused:**

| Port | What it is |
|---|---|
| 5173 | The Vite dev server (and `vite preview`) run directly on the host from `services/web`. It is not part of Compose, and its `/api` proxy points at a backend on the host (`http://localhost:4000`). |
| 80 | nginx inside the `web` container. It is never published directly. |
| 8080 | The default **host** port for the Compose `web` service, mapped as `127.0.0.1:8080` -> container port 80. Change it with `WEB_HOST_PORT`. |

### 1. External env files
Make a directory **outside the repository** (for example `~/cbdc-env`) with three files, copied from `infra/env/*.env.example`:

| File | Source |
|---|---|
| `postgres.env` | `infra/env/postgres.env.example` |
| `backend.env` | `infra/env/backend.env.example` |
| `inference.env` | `infra/env/inference.env.example` |

Replace `CHANGE_ME_LOCAL_ONLY` with one local password, **the same** in `postgres.env` and in `backend.env`'s `DATABASE_URL`. Keep the host `postgres` and port `5432` in that URL. Set `CBDC_ENV_DIR` to that directory; it is required, and Compose stops with a message if it is unset. `test_env_examples.py` fails if a real `infra/env/*.env` exists in the checkout, which is why these files live elsewhere.

Compose sets some variables itself, and they win over the env files: `CBDC_REPO_ROOT=/repo` (inference), `BIND_HOST=0.0.0.0` and `INFERENCE_URL=http://inference:8000` (backend), and `BACKEND_HOST=backend`, `BACKEND_PORT=4000` (web). `infra/env/web.env.example` is not used by Compose: the nginx image takes no `VITE_*` values at run time. (For a host-run Vite dev server, only `VITE_API_MODE` is read by the app; `vite.config.ts` hard-codes the `/api` proxy target `http://localhost:4000` and does not read `VITE_PROXY_TARGET`.) Never print or commit a filled-in env file.

### 2. Development tokens
Copy `services/backend/dev-tokens.example.json` to `services/backend/dev-tokens.json` (git-ignored) and put SHA-256 hashes of your own tokens in it (backend README, section 6.3). To keep the file elsewhere, set `CBDC_DEV_TOKENS_FILE` to its path. Compose mounts it **read-only** at `/app/dev-tokens.json` in the backend (and the seed job), and fails to start if the file is missing; it is never copied into an image.

To prepare the file with the documented procedure (backend README, section 6.3):
1. Generate a random token and keep it private: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
2. Hash it: `node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" <token>`. The token appears in your shell history, so clear it afterwards.
3. Paste the 64-character hash into `tokenSha256`. The example holds two users (`u-analyst-1`, role `analyst`, and `u-viewer-1`, role `viewer`); the placeholders fail validation on purpose, emails must end in `example.test`, and the backend refuses to start with an invalid file. Only hashes go in the file; keep the plain tokens somewhere private for the tests below.

### 3. Start, inspect, stop
PowerShell:
```powershell
$env:CBDC_ENV_DIR = "$HOME\cbdc-env"
$env:CBDC_GIT_COMMIT = (git rev-parse HEAD)   # optional; reported by the inference /v1/version
docker compose -f infra/compose.yaml --profile full up --build -d
docker compose -f infra/compose.yaml --profile full ps -a
docker compose -f infra/compose.yaml --profile full logs backend
docker compose -f infra/compose.yaml --profile full down
```
bash:
```bash
export CBDC_ENV_DIR=~/cbdc-env CBDC_GIT_COMMIT=$(git rev-parse HEAD)
docker compose -f infra/compose.yaml --profile full up --build -d
```
- Startup order is enforced by health checks: postgres, then the one-shot `migrate` (applies the Prisma migrations and exits), then the backend (also waits for inference to be healthy), then web. The first build is slow (the inference image takes several minutes).
- Open `http://127.0.0.1:8080`. To use another host port, set `WEB_HOST_PORT` (for example `$env:WEB_HOST_PORT = "8090"`); it is still bound to `127.0.0.1`.
- **Do not add `-v` to `down`.** `down` removes the containers and the network but keeps the named volume `cbdc-router_pgdata`, so the database survives. Delete that volume only on purpose, with `docker volume rm cbdc-router_pgdata`, because it erases all stored data.

### 4. Seed the development users (optional, explicit)
`POST /transactions`, `/comparisons` and the explanation route return HTTP 500 for a caller with no `User` row, and nothing else creates one. **Seed once before creating a transaction.** The `seed` service upserts `id`, `email` and `role` from the token file (idempotent, never deletes, stores no token or hash). It is in its own profile, so it never runs with `--profile full` alone, and it needs both profiles because it depends on `migrate`:
```powershell
docker compose -f infra/compose.yaml --profile full --profile seed run --rm seed
```
Read-only routes (health, `/auth/me`, `/meta`, `/network`) work without it.

### Windows build error: "additional privileges requested"
On Windows, `docker compose build` or `up --build` may stop within a second or two with:
```text
additional privileges requested: pass "--allow=fs.read=services\backend\Dockerfile" to grant requested privileges
```
This was observed with Docker 29.9.2, Compose 5.6.1 and Buildx Bake 0.38.1. Compose passes the build to Buildx Bake, whose filesystem-entitlement check rejects the build contexts, which sit outside `infra/`. It is not a Dockerfile error, and the build contexts do not need changing.

Temporary workaround, in the current PowerShell session only:
```powershell
$env:BUILDX_BAKE_ENTITLEMENTS_FS = "0"
```
This **disables Buildx's filesystem-entitlement enforcement** for builds started from that session, so a build may read any path it asks for. Use it only in a trusted local checkout and only when the error occurs. Remove it when you are done:
```powershell
Remove-Item Env:BUILDX_BAKE_ENTITLEMENTS_FS
```
`COMPOSE_BAKE=false` did not help in this setup. The error may not occur with other Docker or Compose versions.

## Verify the running stack

```powershell
docker compose -f infra/compose.yaml --profile full ps -a
```
Expected: `postgres`, `inference`, `backend` and `web` are `running (healthy)`, and `migrate` is `Exited (0)`. A warm start took about 40 seconds. A cold inference start can take up to 3 minutes (its health check allows 180 seconds). The health checks are the images' own: PostgreSQL `pg_isready` over TCP, inference `GET /v1/health` (503 until the engine workers are ready), backend `GET /api/v1/health/live`, web `GET /healthz`.

| Check | Expected |
|---|---|
| `GET /healthz` (nginx) | 200 `ok` |
| `GET /api/v1/health` | 200 `{"status":"ok","database":"ok","inference":"ok","authMode":"dev"}` |
| `GET /api/v1/health/live` | 200 `{"status":"ok"}` |
| `GET /api/v1/auth/me` with your analyst token | 200, your `userId` and `role` |
| `GET /api/v1/auth/me` with no, wrong or malformed token | 401 `UNAUTHENTICATED` |
| `POST /api/v1/transactions`, body from `contracts/fixtures/app/transactions/201_waterfall_replay.json` (`request.body`), analyst token | 201 `routed` after seeding; 500 before seeding |
| `GET /api/v1/transactions/{id}` and `GET /api/v1/transactions` | 200, the created transaction is returned |
| `POST /api/v1/comparisons`, body from `contracts/fixtures/app/comparisons/201_scenario_outage.json` | 201; `ppoProjected` is listed under `skipped` with `POLICY_DISABLED` |
| `POST /api/v1/transactions`, body from `transactions/201_ppo_projected_analyst.json`, **viewer** token | 403 `FORBIDDEN_POLICY` |
| `GET /transactions/abc` (browser route) | 200 HTML (the single-page app) |

These results were first observed on the validation machine with a small Python client. `e2e/api-smoke.py` now automates API smoke checks in CI (21 passed, 0 failed at `28da68f`). The fixtures' own `Authorization: Bearer mock-...` headers are for mock mode; use your own tokens. The PowerShell below was syntax-checked and its body conversion was compared with the fixtures, but it was not run against a live stack when written:
```powershell
$env:CBDC_TOKEN = "<your analyst token>"     # never commit it; remove it afterwards
$h = @{ Authorization = "Bearer $env:CBDC_TOKEN" }
$u = "http://127.0.0.1:8080"
Invoke-RestMethod "$u/healthz"
Invoke-RestMethod "$u/api/v1/health"
Invoke-RestMethod "$u/api/v1/auth/me" -Headers $h
$body = (Get-Content contracts/fixtures/app/transactions/201_waterfall_replay.json -Raw | ConvertFrom-Json).request.body | ConvertTo-Json -Depth 10
$tx = Invoke-RestMethod "$u/api/v1/transactions" -Method Post -Headers $h -ContentType "application/json" -Body $body
Invoke-RestMethod "$u/api/v1/transactions/$($tx.id)" -Headers $h
Remove-Item Env:CBDC_TOKEN
```
For the read-only checks on Linux/macOS (not validated):
```bash
curl -s http://127.0.0.1:8080/api/v1/health
curl -s -H "Authorization: Bearer $CBDC_TOKEN" http://127.0.0.1:8080/api/v1/auth/me
```

## Run the test suites

Run from the repository root. `docker build` did not hit the Windows Buildx error below in these runs; only Compose builds did.

| Suite | Command | Last validated result (CI at `28da68f`, 24 November 2026) |
|---|---|---|
| Infrastructure | one-time setup (Python 3.10): `py -3.10 -m venv infra/.venv` then `infra/.venv/Scripts/python -m pip install -r infra/scripts/requirements.txt` (Linux: `python3.10`, `infra/.venv/bin/python`). Run: `infra/.venv/Scripts/python -m pytest infra/scripts/tests -q -p no:cacheprovider`. Contract checker: `infra/.venv/Scripts/python infra/scripts/check_contracts.py` | 193 passed on ubuntu-24.04 and on windows-latest. `check_contracts.py`: `86 fixtures, 2 OpenAPI documents: OK` on both |
| Backend (typecheck and tests, in Docker) | `docker build --target test --build-context contracts=contracts -t cbdc-backend-test:local services/backend` | 1761 passed. With PostgreSQL (`phase2-integration`): 1838 passed |
| Inference (in the built image) | `docker build -f services/inference/Dockerfile --build-arg "CBDC_GIT_COMMIT=$(git rev-parse HEAD)" -t cbdc-inference:local .` then `docker run --rm cbdc-inference:local python -m pytest -q -p no:cacheprovider` | 426 passed, 1 warning, in about 6 minutes in CI (about 26 minutes in an earlier local run) |
| Frontend (lint and tests, in Docker) | `docker build --no-cache --progress=plain --target test --build-context contracts=contracts --build-context docs=docs -t cbdc-web-test:local services/web` | 43 files, 1341 passed |

- The infrastructure tests fail while any `infra/env/*.env` exists in the checkout, so keep real env files outside it.
- The backend `test` target runs the unit tests. The PostgreSQL-backed integration suites run only with `CBDC_TEST_DATABASE_URL` (backend README, section 7). They **empty every table**, so use a disposable database whose name ends in `_test`, never the Compose stack's database.
- The frontend tests read `contracts/fixtures` and `docs/PHASE2_ARCHITECTURE.md` from outside the web build context, which is why both `--build-context` flags are required. The `test` stage runs Vitest with two workers (`--maxWorkers=2`).

## Troubleshooting

| Symptom | Likely cause and what to do |
|---|---|
| `required variable CBDC_ENV_DIR is missing a value` | `CBDC_ENV_DIR` is unset. Point it at the external env directory (step 1). |
| `env file ...\inference.env not found` (or `backend.env`, `postgres.env`) | A file is missing from `CBDC_ENV_DIR`. All three are required. |
| `up` fails on the backend's token mount | `services/backend/dev-tokens.json` (or `CBDC_DEV_TOKENS_FILE`) does not exist. Compose is set not to create it. The exact error text was not captured. Create the file (step 2). |
| `POST /transactions`, `/comparisons` or an explanation returns 500 `INTERNAL_ERROR` | The user has no row in the database. Run the seed (step 4). |
| `migrate` exits non-zero, or the backend never starts | `docker compose -f infra/compose.yaml --profile full logs postgres migrate`. Check that `DATABASE_URL` uses host `postgres`, port `5432` and the same password as `postgres.env`. The PostgreSQL image applies `POSTGRES_PASSWORD` only when it creates an empty data directory, so editing `postgres.env` later does not change an existing database; the fix then is a deliberate volume removal (see "Security and cleanup"), which erases the data. |
| `inference` stays `unhealthy` | Wait up to 3 minutes on a cold start, then read `logs inference`. `/v1/health` returns 503 until the workers are ready. |
| `backend` is `unhealthy` or exits | `logs backend`. It reports every configuration problem at once and exits with code 1. It refuses `NODE_ENV=production`, requires `AUTH_MODE=dev`, and validates the token file. |
| nginx `502 Bad Gateway` on `/api/...` while `/healthz` is 200 | nginx is up but cannot reach the backend. Check `ps -a` and `logs web backend`; `BACKEND_HOST` must be the backend's service name. |
| Port 8080 is already in use | Set `WEB_HOST_PORT` to a free port. To find the owner on Windows: `Get-NetTCPConnection -LocalPort 8080 -State Listen`. A PostgreSQL already running on the host does not conflict, because the stack does not publish 5432. |
| `additional privileges requested` on build | The Windows Buildx error; see the section above. |
| A frontend test reports `Test timed out in 5000ms` | CPU contention. One earlier full run with four workers timed out on one test; with two workers one full run passed. Re-run, close other heavy programs, or give Docker Desktop more CPUs. Do not raise test timeouts without a decision. |

## Security and cleanup

- Only `web` is published, on `127.0.0.1` (loopback). The backend, inference and PostgreSQL have no host ports; check with `docker compose -f infra/compose.yaml --profile full ps` that only `web` shows a published port.
- This is **development-only** authentication (arch §8). Do not expose the stack beyond your machine.
- Secrets stay outside the repository: the env files in `CBDC_ENV_DIR`, and the token-hash file. The token file is mounted read-only and is never copied into an image. Do not paste env files, tokens or hashes into issues, logs or commits.
- Stop the stack with `docker compose -f infra/compose.yaml --profile full down`. It removes this project's containers and network and keeps the database volume.
- **Do not run `down -v` or `docker volume prune` casually.** `down -v` deletes the database volume, and `docker volume prune` deletes every unused volume on the machine, including other projects'. Remove only this project's volume, on purpose: `docker volume rm cbdc-router_pgdata`.
- The project name is `cbdc-router` (from `name:` in `compose.yaml`), so `down` leaves unrelated containers and volumes alone. To run a throwaway copy, use a different project name (`-p <name>` or `COMPOSE_PROJECT_NAME`); `compose.yaml` tags the images `cbdc-*:local`, so building under another name retags them unless you override `image:`.

## Known limitations

- Full-stack runtime validation covers Windows with Docker Desktop (`docs/PHASE2_STATUS.md` §8) and Ubuntu 24.04 in CI, which includes the Playwright (Chromium) browser tests. There is no macOS run, no Linux run of the Compose build itself (CI uses plain `docker build`), and no cold-cache timing on a second machine.
- On the tested Windows setup, Compose builds need the Buildx workaround above.
- Seeding is a manual, explicit step. The `mock` profile (Prism) from the architecture is not implemented.
- The frontend Docker tests (two workers) passed in the CI `web image` job at `28da68f`; their flake rate has not been measured.
- PPO is disabled (`approved_checkpoints.json` is empty and no checkpoint is mounted).
- Existing documentation differences, recorded here and not changed (each belongs to another owner's file):
  - `docs/PHASE2_ARCHITECTURE.md` names the Python base image `slim-bookworm`, but `services/inference/Dockerfile` uses `slim-bullseye` (its comment explains why: no 3.10.11 image exists for bookworm).
  - The architecture lists only port 5173 for the web app (the Vite dev server and preview) and does not mention the Compose web port, which is 8080 on the host and 80 in the container.
  - `infra/env/web.env.example` describes `VITE_API_MODE` as `live` or `mock (MSW)`, while the app accepts `live` or `preview`. It also lists `VITE_PROXY_TARGET`, which `vite.config.ts` does not read (the proxy target is hard-coded).
  - `services/backend/README.md` says the repository has no `.nvmrc`; it now has one (`20.20.2`).

Python tooling and the contract checker: see `contracts/README.md`, section "Validate".

## Phase 3 observations overlay (optional, D-24 only)

`infra/compose.observations.yaml` adds the synthetic FX ingestion service and turns the observation feature on. It is optional, local only and off by default: `compose.yaml` and `--profile full` on their own are unchanged and never start ingestion. Design: `docs/PHASE3_AD1_COMPONENT_VIEW.md` §3.6.

```powershell
$env:CBDC_ENV_DIR = "<dir>"   # the same env files as above
docker compose -f infra/compose.yaml -f infra/compose.observations.yaml --profile full --profile observations up --build
```

- **Docker Engine 28.0.0 or newer is required.** The `observations` network uses `com.docker.network.bridge.gateway_mode_ipv4: isolated`, which Docker accepts from Engine 28.0.0 and only on an `internal` network. An isolated internal network has no address on the host, so ingestion cannot reach host services through the bridge gateway. `internal: true` alone does not give that: the isolation probe reached a host listener through the gateway. On an older engine the network fails to create, which is the safe failure. GitHub's `ubuntu-24.04` image lists Docker 28.0.4 at the time of writing. Check yours with `docker version --format '{{.Server.Version}}'`.
- **IPv6 is disabled** on that network (`enable_ipv6: false`, and the network has one IPv4 subnet). Isolation was verified for IPv4 only; the CI job fails if the container has any IPv6 address, so enabling IPv6 would need an explicit decision and its own checks.
- Ingestion is on the `observations` network only. The backend is on both networks and forwards nothing between them. No port is published, and ingestion gets no env file, secret or volume.
- The overlay builds separately tagged images (`cbdc-backend-observations:local`, `cbdc-web-observations:local`, `cbdc-ingestion:local`) so it never replaces the default `cbdc-*:local` images.
- `OBSERVATIONS_URL` is an origin only (`http://ingestion:8300`); Express appends `/v1/latest`.
- AD-6 B-4 stays open: the inference side is not isolated by this overlay (D-25, D-24 slice only; closed by AD-10).
- The checks are in `.github/workflows/phase3-observations.yml`; the Nginx stub under `infra/testing/` is test-only and is in no image.
