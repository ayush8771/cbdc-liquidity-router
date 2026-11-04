# infra/ (Dev D)

Cross-platform tooling for Phase 2 integration (arch §4, §5.4, §7).

| Path | Status |
|---|---|
| `scripts/check_contracts.py` | Contract conformance for `contracts/`. Its tests are in `scripts/tests/`, and it runs in `.github/workflows/phase2-integration.yml`. |
| `scripts/requirements.txt` | Pinned tooling for the scripts. Install it into `infra/.venv`, never into the Phase 1 `venv/`. |
| `compose.yaml`, `env/`, `postgres/`, `mocks/` | Not yet written (next steps). |

Setup and usage: see `contracts/README.md`, section "Validate".
