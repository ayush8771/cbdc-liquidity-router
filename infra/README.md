# infra/ (Dev D)

Cross-platform tooling for Phase 2 integration (arch §4, §5.4, §7).

| Path | Status |
|---|---|
| `scripts/check_contracts.py` | Contract conformance for `contracts/`. Its tests are in `scripts/tests/`, and it runs in `.github/workflows/phase2-integration.yml`. |
| `scripts/requirements.txt` | Pinned tooling for the scripts. Install it into `infra/.venv`, never into the Phase 1 `venv/`. |
| `scripts/compile_locks.py` | Compiles the hashed inference locks from `services/inference/requirements/service.in` with pinned `uv` 0.9.5 (`--check` for lock drift, `--verify-only` to check the committed locks, `--dry-run` to print the commands). Only the Linux CPU lock (`linux-x86_64-cpu.txt`) is defined; see the script's docstring. Tests: `scripts/tests/test_compile_locks.py`. |
| `env/*.env.example` | Variable templates for inference, backend, web and PostgreSQL (contract §8). Copy to `env/<name>.env` (git-ignored); the examples hold placeholders only. Tests: `scripts/tests/test_env_examples.py`. |
| `compose.yaml`, `postgres/`, `mocks/` | Not yet written (next steps). |

Setup and usage: see `contracts/README.md`, section "Validate".
