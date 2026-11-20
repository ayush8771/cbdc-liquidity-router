# infra/ (Dev D)

Cross-platform tooling for Phase 2 integration (arch §4, §5.4, §7).

| Path | Status |
|---|---|
| `scripts/check_contracts.py` | Contract conformance for `contracts/`. Its tests are in `scripts/tests/`, and it runs in `.github/workflows/phase2-integration.yml`. |
| `scripts/requirements.txt` | Pinned tooling for the scripts. Install it into `infra/.venv`, never into the Phase 1 `venv/`. |
| `scripts/compile_locks.py` | Compiles the hashed inference locks with `uv` (`--check` for lock drift, `--dry-run` to print commands). Needs `services/inference/requirements/service.in`; no lock is committed until Dev A's inputs are merged. Tests: `scripts/tests/test_compile_locks.py`. |
| `env/*.env.example` | Variable templates for inference, backend, web and PostgreSQL (contract §8). Copy to `env/<name>.env` (git-ignored); the examples hold placeholders only. Tests: `scripts/tests/test_env_examples.py`. |
| `compose.yaml`, `postgres/`, `mocks/` | Not yet written (next steps). |

Setup and usage: see `contracts/README.md`, section "Validate".
