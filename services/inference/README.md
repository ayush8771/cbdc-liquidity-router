# Inference service (Major Phase 2A, Dev A)

The FastAPI service and engine that wrap the Phase 1 routing code. It's internal: only the Express backend calls it (arch D9).

- **Specs:** `docs/PHASE2_ARCHITECTURE.md` and the approved `docs/PHASE2_API_CONTRACT.md` **v0.4**, which is the authoritative, normative source. Both OpenAPI files in `contracts/openapi/` remain **DRAFT**; where they disagree with the written contract, the contract wins.
- **Phase 1 is read-only.** The service imports `src/`, and never modifies `src/`, `data/`, `outputs/`, `tests/`, `venv/` or the root requirements files.

## Status

**All nine `/v1` endpoints of contract §2 are implemented**, against the approved v0.4 contract.

| Piece | State |
|---|---|
| Package layout `cbdc_inference/{api,engine}` | Created |
| Settings from the `CBDC_*` environment variables (contract §8) | Done |
| Checkpoint approval registry and the `ppo_projected` gate (contract §7) | Done. The registry ships empty, so PPO is disabled |
| Error envelope and `X-Request-Id` (contract §1, §4) | Done |
| `EngineWorker.route(transaction, state, policy)` (`engine/worker.py`) | Done for `waterfall` (default) and `cheapest_feasible`, in `historical_replay` and `scenario` modes. Parity with Phase 1 is exact. |
| Explicit state mode (`engine/state.py`, `EngineWorker._explicit_frame`) | Done (contract §2.4, arch §9.1). Available through `/v1/route`. |
| `STATE_OUTSIDE_TRAINING_RANGE` | Done (contract §2.4, v0.4 settled it): per-venue liquidity and congestion min-max bounds over the **union of the actual 30-day windows of all training transactions**. A **warning only**, in all three state modes, from `/v1/route` and `/v1/compare` only, on the values the selected policy actually reads. Never from `/v1/state`, and it never blocks a baseline. |
| `decision_id` (`cbdc_inference/hashing.py`) | Done (contract §2.11, `id_scheme` 1): RFC 8785 over the canonical document, hashing `engine_version`, the transaction, the state, the policy, the scenario multipliers, the reward weights, the six artefact fingerprints and `checkpoint_sha256`. Numbers are normalised to binary64 during validation and the **same** values are executed with; integer-valued numbers outside +/-(2^53 - 1) are rejected, never rounded. Reproduces every vector in `contracts/test-vectors/decision_id.v1.json` byte for byte. |
| Artefact and daily-state fingerprints | Done (§2.11): text artefacts hashed after CRLF->LF, binaries as they are, and the scheme-1 daily-state fingerprint with pandas pinned to 2.3.3. Reproduces `contracts/test-vectors/daily_state_fingerprint.v1.json`. The service `knowledge_sha256` is the LF-normalised hash, **not** Phase 1's raw-byte `KnowledgeBase.sha256`. |
| `ppo_projected` | Implemented, and **disabled** because the approval registry ships empty, so requests return `409 POLICY_DISABLED`. Served only with an approved checkpoint whose SHA-256 **each worker re-verifies itself**, and only through the Stage 1F capacity projection. Raw PPO is never exposed (D3). |
| `EnginePool` (`engine/pool.py`) | Done: spawned worker processes, one task each, a bounded queue (`ENGINE_BUSY`), and individual worker recycling after a timeout, crash or failed integrity check. The two limits of §5 are independent: the **request deadline** (`CBDC_ENGINE_REQUEST_DEADLINE_S`, 12 s) fails a task expiring while queued with `503 ENGINE_BUSY` without running it, and one expiring while running with `504 ENGINE_TIMEOUT` **without killing the worker**; the **worker execution timeout** (`CBDC_ENGINE_TASK_TIMEOUT_S`, 10 s) is never shortened to it, and passing it recycles only that worker. The **minimum start budget** (`CBDC_ENGINE_MIN_START_BUDGET_S`, 1 s) is validated at start-up (`0 <= budget < deadline`). Health reports `engine_workers` and the `engine_pool` block, including `ready_workers`. |
| `/v1/health`, `/v1/version` (`api/routers/meta.py`) | Done. Answered from startup metadata and the pool's in-memory health, without queuing a worker task. |
| `/v1/network`, `/v1/state` (`api/routers/reference.py`) | Done. Each request runs as a task in an engine worker; `/v1/state` uses the same request-scoped frame and integrity check as routing. |
| `/v1/replay/calendar`, `/v1/scenarios` | Done. Answered from startup metadata, which a worker computes from Phase 1 `split.py` and `scenarios.py`. |
| `POST /v1/route` (`api/routers/route.py`) | Done for every policy in all three state modes, with a non-null `decision_id`. **Requests are strict** (§1): every body object accepts only the contract's fields, `policy: null` is rejected while an omitted `policy` defaults to `waterfall`, and `client_reference` is capped at 200 code points. |
| `POST /v1/compare` (§2.9) | Done. Every policy runs in **one** engine task on one request-scoped state frame, so `same_state` holds and every result shares a `state_frame_sha256`. A disabled or state-unavailable policy goes into `skipped` instead of failing the request, and each result's `decision_id` is hashed for its own policy, so it equals the `/v1/route` ID. |
| `POST /v1/explain` (§2.10) | Done. Recomputes the decision deterministically, so its `decision_id` equals `/v1/route`'s. `semantic_context` is **always null in v1**, and `include_semantic_context` is rejected as an unknown field. For `ppo_projected`, `policy_notes` state that the shares come from a learned policy with no causal explanation and list each slot's change from `share_before_projection`; no causal reason is ever invented. |
| Error envelope details (§4) | Done. `VALIDATION_ERROR` carries `details.errors[]` of `{field, message}`, with `field` **omitted** for a form-level error; other 422 codes carry `details.field`. `405 METHOD_NOT_ALLOWED` carries an `Allow` header. Only the contract's `details` keys are returned, so no internal path, exception text or configuration value can leak. |
| Dockerfile, `Dockerfile.dockerignore` | Not started |
| Platform locks `requirements/*.txt` | Dev D generates them from `requirements/*.in` |

## Layout

```text
services/inference/
├── cbdc_inference/
│   ├── __init__.py        version constants
│   ├── settings.py        CBDC_* environment settings
│   ├── checkpoints.py     approval registry + ppo_projected gate (no Phase 1 imports)
│   ├── api/               FastAPI: app factory, error envelope, routers/ (imports no Phase 1 module)
│   └── engine/            route(), worker pool, policies (placeholder; never imports FastAPI)
├── config/approved_checkpoints.json   owner-maintained; ships with "approved": []
├── requirements/service.in, cognee.in dependency inputs (Dev A); locks *.txt (Dev D)
├── tests/                 unit/ api/ parity/ concurrency/ conftest.py
├── pyproject.toml         package + pytest configuration for this service only
└── .gitignore
```

## Windows setup (PowerShell)

Use a **separate** venv in `services/inference/.venv`. Never install into the Phase 1 `venv/`. Python 3.10.11 is required.

```powershell
cd services\inference
py -3.10 -m venv .venv
.\.venv\Scripts\Activate.ps1          # if blocked: Set-ExecutionPolicy -Scope Process RemoteSigned
python -m pip install --upgrade pip
```

Install the dependencies:

- **Once Dev D has published the locks** (preferred):
  ```powershell
  pip install --require-hashes --no-deps -r requirements\windows-x86_64-cpu.txt
  pip check
  ```
  Use `windows-x86_64-cu130.txt` on the GPU machine.
- **Until then** (unhashed, for local development only):
  - For the API and tests only (enough for the current foundation tests; no torch):
    ```powershell
    pip install fastapi==0.141.1 uvicorn==0.52.1 pydantic==2.13.4 pydantic-settings==2.15.0 pytest==9.1.1 httpx==0.28.1
    ```
  - For everything in `service.in`, including the Phase 1 runtime and CPU torch:
    ```powershell
    pip install -r requirements\service.in --extra-index-url https://download.pytorch.org/whl/cpu
    ```

## Run the service

From `services/inference/`, with `.venv` active:

```powershell
$env:CBDC_REPO_ROOT = (Resolve-Path ..\..).Path   # the repository root; engine workers will chdir here
uvicorn cbdc_inference.api.app:create_app --factory --host 127.0.0.1 --port 8000
```

- Bind it to `127.0.0.1` only (contract §5).
- Startup doesn't wait for the engine workers. They warm up in the background (a few seconds each), and until one is ready `GET /v1/health` returns 503 with `ready: false` and `GET /v1/version` returns 503 `NOT_READY`.
- Check readiness: `Invoke-RestMethod http://127.0.0.1:8000/v1/health`, then `Invoke-RestMethod http://127.0.0.1:8000/v1/version`.
- Ctrl+C shuts down cleanly: queued tasks fail with `NOT_READY`, and the worker processes are stopped.

Configuration (contract §8; all optional):

| Variable | Default | |
|---|---|---|
| `CBDC_REPO_ROOT` | `.` | Repository root |
| `CBDC_PPO_CHECKPOINT_ID` | unset | Must name an entry in `config/approved_checkpoints.json` with a matching SHA-256, or `ppo_projected` stays disabled |
| `CBDC_DEVICE` | `cpu` | `cpu` or `cuda` |
| `CBDC_ENGINE_WORKERS` | `2` | |
| `CBDC_ENGINE_TASK_TIMEOUT_S` | `10` | |
| `CBDC_ENGINE_MAX_QUEUE` | `32` | |
| `CBDC_ENABLE_COGNEE` | `false` | Explanation text only |

## Tests

```powershell
cd services\inference
python -m pytest
```

Or from the repository root: `python -m pytest services/inference/tests`. These tests never run as part of Phase 1's `python -m pytest tests/`.

---

## Phase 1 integration plan

This plan was mapped from the live code at `phase1-complete` (`5d0ae02` on this branch). Nothing here is implemented yet. Every item below is a Phase 1 symbol the engine will **call, unchanged**.

### Components the engine wraps

| Need | Phase 1 symbol | Notes |
|---|---|---|
| Environment / execution / reward | `src.envs.cbdc_env.CBDCLiquidityEnv` | Methods `get_feasibility_mask(req)`, `_get_observation(req)`, `_resolve_dynamic_state(b, s, r, date)` and `step(action)`. The engine sets `env.requests_df` to a 1-row frame with columns `transaction_id, sender_country, receiver_country, amount_usd, simulation_date`, and sets `current_step = 0` (as in `evaluate._make_eval_env`). `step()` returns `info["executed_total"]`, `info["unrouted"]` and `info["reward_components"]`. |
| Feasibility | `CBDCLiquidityEnv.get_feasibility_mask` → `memory_layer` (`src.memory.cognee_layer.CogneeMemoryLayer` → `StaticMemoryProvider`) | Returns `(mask, bridges, rejection)`. A rejection is a 200 response, not an error (contract §2.8). |
| Waterfall (default) | `src.training.baselines.liquidity_aware_waterfall_action(bridges, mask, amount, simulation_date)` | |
| Cheapest-feasible | `src.training.baselines.cheapest_feasible_action(bridges, mask)` | |
| `ppo_projected` (gated) | `src.models.ppo_actor_critic.PPOActorCritic` with `net.act(raw, windows, mask, deterministic=True)`; `src.envs.stage1d_raw_obs_wrapper.Stage1DRawObservationWrapper._wrap_obs`; `src.training.capacity_projection.project_capped_simplex(action, caps, mask)` | Use the same steps as `src.backtesting.evaluation.evaluate_scenario`: `caps[j] = liquidity_j / amount`, and load the checkpoint with `torch.load(..., weights_only=True)` and then `eval()`. Raw PPO is never returned (D3). |
| Scenarios | `src.backtesting.scenarios.SCENARIOS`, `perturb(df, scenario)`, `injected_daily_state(df)` | `perturb` returns a new frame. The context manager swaps `dynamic_bridge_state._daily_df_cache[DAILY_PARQUET_PATH]` and restores it. |
| Daily state | `src.envs.dynamic_bridge_state.load_daily_series`, `DAILY_PARQUET_PATH` | |
| Date validation, split | `src.models.stage1c_windowing.validate_simulation_date` (raises `InvalidSimulationDateError`); `src.preprocessing.split.assign_split`, `in_gap_buffer` | The messages distinguish out-of-range from gap-buffer dates, giving `DATE_OUT_OF_RANGE` and `DATE_IN_GAP_BUFFER`. |
| Regime label | `src.training.transaction_generator.true_regime_for_row(s, r, amount, date)` | |
| Explanation | `StaticMemoryProvider.explain()`; Cognee optional (`CBDC_ENABLE_COGNEE`) | `cognee_adapter` and `explanation_audit` are never imported on the routing path. |
| Amount-based figures (D7) | Same formula as `src.backtesting.evaluation._step` | `amount_unrouted = max(amount − executed, 0)` and the `RELATIVE_UNROUTED_TOLERANCE` completion rule from `src.training.metrics`. |
| Parity references | `src.training.evaluate.run_baseline`, `src.backtesting.evaluation.evaluate_scenario` | |

### Process-global state to isolate (arch §6)

- `dynamic_bridge_state._daily_df_cache`
- `Stage1DRawObservationWrapper._daily_df` (per instance)
- `risk_proxy._macro_risk_cache`
- `cost_baseline._cache`
- `stage1c_windowing._shared_cnn` (via `get_shared_cnn()`)
- `CBDCLiquidityEnv.current_step` and `requests_df`

Each engine worker warms all of these once, at spawn.

### Data read at inference

Paths are relative to `CBDC_REPO_ROOT`:

- `data/structured/{countries,bridge_network,transaction_requests}.csv`. `CBDCLiquidityEnv.__init__` reads all three.
- `data/processed/synthetic_liquidity_congestion_daily.parquet`
- `data/processed/normalization_stats.json`
- `data/processed/macro_risk_proxy.parquet`
- `data/processed/rpw_corridor_quarterly.parquet`
- `data/knowledge/regulatory_facts.json`
- `data/raw/` is **not** read. `raw_dir` is accepted by `CBDCLiquidityEnv` but unused.
- Checkpoints: only an approved `outputs/experiments/.../ppo_checkpoint.pt`.

### Implementation order (next steps)

1. **Engine worker initialiser** (spawn, `chdir`, eager warm-up, `BASELINE_FRAME` fingerprint) and `route()` for `waterfall` and `cheapest_feasible` in replay mode. Then **parity tests** against `run_baseline` on the validation split and one holdout, which must match exactly.
2. **`EnginePool`:** timeout, backpressure, integrity guard and rebuild. Then the **concurrency and fault-injection tests** (arch §6.4).
3. **Endpoints:** `/v1/health`, `/v1/version`, `/v1/scenarios`, `/v1/replay/calendar`, `/v1/network`, then `/v1/route`. These come with **pydantic schemas** copied exactly from the contract.
4. **Scenario mode** (parity with Stage 1F), then **explicit mode** (§9.1 rules and every 422 code).
5. ~~**`/v1/compare` and `/v1/explain`.**~~ Done.
6. ~~**`ppo_projected`.**~~ Implemented. It is only exercised in tests with a temporary registry, because no checkpoint is approved.
7. **Dockerfile** and its allow-list `Dockerfile.dockerignore` (arch §4.2). **Still to do** -- the only remaining item in this service, together with Dev D's platform locks.

### Open points to raise with Nisaraga / Dev D (no contract change made)

-1. **`decision_id.v1.json`'s `daily_state_sha256` input predates the §2.11 fingerprint scheme.** Not a defect, and no contract or vector change is needed, but Dev D's contract checker must not recompute it.
   - Five of the six artefact hashes in the vectors' `inputs.artefacts` equal the live repository's values, because they are plain file hashes under the §2.11 text/binary rule: `knowledge_sha256` `b01faa5a…`, `bridge_network_sha256` `99982af3…`, `normalization_stats_sha256` `bc70dfaa…`, `macro_risk_proxy_sha256` `6fc4c870…` and `rpw_corridor_quarterly_sha256` `2b6abc03…`.
   - The sixth, `daily_state_sha256` `d0f4b6e7…`, does **not**. It was reproduced exactly as
     `sha256(pandas.util.hash_pandas_object(pd.read_parquet(daily), index=True).values.tobytes())`
     — the **pre-scheme-1 row-hashes-only** digest, taken over the **raw** parquet read rather than the frame Phase 1 actually loads (`load_daily_series()` sorts by `(bridge_id, date)` and resets the index).
   - The approved scheme-1 fingerprint (§2.11: `DOMAIN || u64le(len) || descriptor || u64le(len) || rows`) over the loaded frame is `c8757974…`, which is what `/v1/version` and `decision_id` report. Over the raw unsorted read it would be `059de5f9…`.
   - **Why this is harmless:** in `decision_id.v1.json` the artefact hashes are *inputs* the vector supplies ("Inputs are illustrative but the canonical strings and IDs are exact"), so the implementation reproduces every canonical string and ID byte for byte regardless of that value. The normative test of the fingerprint algorithm is `daily_state_fingerprint.v1.json`, which this service reproduces exactly (descriptor string and `sha256`).
   - **The risk:** if `infra/scripts/check_contracts.py` ever *recomputes* `daily_state_sha256` from the repository and compares it with the vector's input, it will fail. It must rebuild each document **from the vector's inputs**, as §2.11 specifies.

0. **`STATE_OUTSIDE_TRAINING_RANGE` -- RESOLVED by contract v0.4 §2.4**, which chose option (b): per-venue min-max over the union of the actual 30-day windows of all training transactions, as a **warning** only. The findings below are kept as the record of why the question was raised.
   - **Two sets of "frozen train-only statistics" exist.**
     - The CNN daily stats (`liquidity_level` / `congestion_level`, keyed by parquet bridge ID) use every train-period day (n = 4018 per venue).
     - The raw PPO stats (`capacity`, keyed by `bridge_uid`) use only liquidity on training-transaction dates (for example n = 179 for GBR->PHL#1). Raw congestion has no stat of its own.
     - Both hold mean and std only. Neither has a min or max.
   - **Error or warning?** Arch §9.1 says out-of-range values "return" the code, like an error. Contract §2.4 and the §2.8 table make it a warning.
   - **Not settled either:**
     - whether it applies to the current values only or also to the 30 history values;
     - whether replay dates outside the range should be flagged (the contract only covers explicit and scenario values);
     - whether the bounds are inclusive.
   - **Measured, against the per-venue train-period daily min–max:**
     - test-period replay: 0.7% of venue-days fall outside (validation: 0.9%);
     - `cheapest_venue_outage`: 11.8%;
     - `congestion_x2`: 23.9%;
     - `combined_stress`: 6.1%.
   - **Options:**
     - (a) per-venue min–max over the train-period daily rows (2011-01-01 to 2021-12-31, gap buffers included, matching the n = 4018 stats);
     - (b) min–max over training-transaction dates only.

1. **Inputs vs. Cognee:** arch §7.2 lists the root `requirements.txt` as a lock input, but that file pins `cognee==1.4.2`, which is meant to be separate. `service.in` therefore repeats the Phase 1 runtime pins without Cognee or openpyxl. Confirm this with Dev D.
2. **Framework errors with no contract code -- RESOLVED by v0.4 §4**, which added `405 METHOD_NOT_ALLOWED` with an `Allow` header. The envelope now uses it.
3. **Version mismatch -- RESOLVED.** This branch carries the approved v0.4 contract.
4. **Branch and tag reference:** the architecture names `phase1-complete` = `bc9905e` as the baseline. `git_commit` in `/v1/version` must be read at build time, not hard-coded.
