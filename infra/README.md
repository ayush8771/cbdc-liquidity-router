# infra/ (Dev D)

Cross-platform tooling for Phase 2 integration (arch §4, §5.4, §7).

| Path | Status |
|---|---|
| `scripts/check_contracts.py` | Contract conformance for `contracts/`. Its tests are in `scripts/tests/`, and it runs in `.github/workflows/phase2-integration.yml`. |
| `scripts/requirements.txt` | Pinned tooling for the scripts. Install it into `infra/.venv`, never into the Phase 1 `venv/`. |
| `scripts/compile_locks.py` | Compiles the hashed inference locks from `services/inference/requirements/service.in` with pinned `uv` 0.9.5 (`--check` for lock drift, `--verify-only` to check the committed locks, `--dry-run` to print the commands). Only the Linux CPU lock (`linux-x86_64-cpu.txt`) is defined; see the script's docstring. Tests: `scripts/tests/test_compile_locks.py`. |
| `env/*.env.example` | Variable templates for inference, backend, web and PostgreSQL (contract §8). The examples hold placeholders only. For Compose, copy them to a directory **outside the checkout** (see "Compose setup"); `test_env_examples.py` fails if a real `env/*.env` exists here. Tests: `scripts/tests/test_env_examples.py`. |
| `compose.yaml` | The local stack, profile `full`: postgres, a one-shot `migrate`, inference, backend and web. Only web is published, on `127.0.0.1:${WEB_HOST_PORT:-8080}`. An optional `seed` service has its own profile. Validated end to end once, on Windows with Docker Desktop (Docker 29.9.2, Compose 5.6.1, Buildx Bake 0.38.1); see "Compose setup" and "Windows build error". |
| `postgres/`, `mocks/` | Not yet written (next steps). |

## Compose setup

`infra/compose.yaml` runs web (nginx) -> backend (Express) -> inference (FastAPI) and PostgreSQL. All services are in the profile `full`, so every command needs `--profile full`. Run all commands from the repository root. Real env files and passwords stay outside the checkout.

**Network exposure.** Only `web` is published, on `127.0.0.1:8080` (loopback only). The backend (4000), inference (8000) and PostgreSQL (5432) are not published to the host; they are reachable only from other containers in the project network.

### 1. External env files
Make a directory **outside the repository** (for example `~/cbdc-env`) with three files, copied from `infra/env/*.env.example`:

| File | Source |
|---|---|
| `postgres.env` | `infra/env/postgres.env.example` |
| `backend.env` | `infra/env/backend.env.example` |
| `inference.env` | `infra/env/inference.env.example` |

Replace `CHANGE_ME_LOCAL_ONLY` with one local password, **the same** in `postgres.env` and in `backend.env`'s `DATABASE_URL`. Keep the host `postgres` and port `5432` in that URL. Set `CBDC_ENV_DIR` to that directory; it is required, and Compose stops with a message if it is unset. `test_env_examples.py` fails if a real `infra/env/*.env` exists in the checkout, which is why these files live elsewhere.

### 2. Development tokens
Copy `services/backend/dev-tokens.example.json` to `services/backend/dev-tokens.json` (git-ignored) and put SHA-256 hashes of your own tokens in it (backend README, section 6.3). To keep the file elsewhere, set `CBDC_DEV_TOKENS_FILE` to its path. Compose mounts it **read-only** at `/app/dev-tokens.json` in the backend (and the seed job), and fails to start if the file is missing; it is never copied into an image.

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

Setup and usage: see `contracts/README.md`, section "Validate".
