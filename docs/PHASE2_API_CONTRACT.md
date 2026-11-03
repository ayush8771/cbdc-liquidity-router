# Major Phase 2 — API Contract

**Status:** v0.4 (3 November 2026), proposed for team review. This document is normative until `contracts/openapi/inference.v1.yaml` and `contracts/openapi/app.v1.yaml` are approved and merged; after that the OpenAPI files are, and this document must be kept in sync with them.
**Architecture and roles:** `docs/PHASE2_ARCHITECTURE.md`. Section references written "arch §n" point there.

**How to read v0.4.** Rules without a marker are approved. A rule marked **Pending: <name>** has been agreed by every developer who answered, but still needs that person's sign-off; implement it only after the sign-off. A rule that is still disputed or undecided is not stated as a rule: the text says it is open and points to §10, which lists each side's position and who decides.

**Changes in v0.4:**
- **Errors (§4):**
  - new codes `METHOD_NOT_ALLOWED` (405, with `Allow`) and `TRANSACTION_FAILED` (409);
  - `POLICY_DISABLED` is passed through by the app;
  - `NOT_READY` maps to `503 INFERENCE_UNAVAILABLE` in the app;
  - `ENGINE_TIMEOUT` is 504 everywhere (the §3.2 wording is fixed);
  - `Retry-After` is forwarded;
  - rules for forwarding engine messages and for `details.errors[]`.
- **Requests are strict, responses are tolerant (§1).** Also: `clientReference` is at most 200 characters, `policy: null` is rejected, and an empty `venues` list returns `STATE_VENUE_MISMATCH`.
- **Failed transactions (§3.2–§3.5):**
  - a `failure` object, which is null for routed transactions;
  - `decision`, `corridor` and the decision-derived list fields are null when a transaction failed;
  - `409 TRANSACTION_FAILED` for an explanation of a failed transaction.
- **§2.8 field rules:**
  - the allocation invariant `requested_usd = Σ amount_requested_usd`, checked fail-closed;
  - regulatory rejections have `requested_usd = 0` and `allocations = []`, and no `PARTIAL_COMPLETION` warning (C14);
  - `completed` uses the Stage 1F amount-based rule;
  - `bridges_used` counts shares above 1e-6.
- **`STATE_OUTSIDE_TRAINING_RANGE` (§2.4):** per-venue liquidity and congestion bounds from the actual 30-day training windows. It is a warning in all three state modes.
- **`decision_id` (§2.11):** RFC 8785 canonical JSON; `git_commit` excluded; text artefacts hashed with LF line endings; a defined daily-state fingerprint.
- **Deadlines and engine workers (§5, §8):**
  - a 12 s end-to-end deadline and a 10 s execution limit;
  - individual worker recycling;
  - `CBDC_ENGINE_STARTUP_TIMEOUT_S`.
- **Health (§3.9):** mock mode reports `ok`, and the `database` values are defined. The HTTP status when the database is down is still open.
- **Other definitions:**
  - `completionRate` counts only routed, feasible decisions (pending the owner's sign-off);
  - comparisons are independent records (§3.6, §6.3);
  - `semantic_context` is always null in v1 (C6);
  - explanation outcomes are confirmed (C11).
- **Open decisions (§10).**

**Changes in v0.3:**
- Paths aligned with the v0.3 folder structure (arch §4):
  - OpenAPI files are in `contracts/openapi/`, fixtures in `contracts/fixtures/{inference,app}/`;
  - inference tests are in `services/inference/tests/`, end-to-end tests in `e2e/`, and Compose is in `infra/compose.yaml`.
- `runtime.lock_file` now points to `services/inference/requirements/<platform>.txt`.
- The test table (§9) names the folder and CI workflow for each suite.
- No change to any endpoint, schema or error code.

**Changes in v0.2:**
- Explicit states no longer accept per-venue `risk`. Risk and the cost baseline come from `reference_date` (§2.4).
- Explicit-state and reference-date limitations added (§2.4).
- Development-only auth: `GET /api/v1/auth/me` and token rules (§3.0).
- Engine-pool error codes `ENGINE_TIMEOUT` and `ENGINE_BUSY`; the `engine_workers` health check.
- Warning `SYNTHETIC_COST_ANCHOR`.
- Backend timeout raised to 15 s.
- Determinism clarified per platform and device.

There are two APIs:

| API | Producer | Consumer | Base path | Field case |
|---|---|---|---|---|
| **Inference API** (internal) | Dev A, FastAPI | Dev B only | `http://inference:8000/v1` | `snake_case` |
| **Application API** (public) | Dev B, Express | Dev C | `/api/v1` (same origin through the Vite proxy; backend on port 4000) | `camelCase` |

> **Example values in this document are illustrative.** They show the shape of each response, not real engine output. Dev A will replace the fixtures in `contracts/fixtures/inference/` with engine-generated ones.

---

## 1. Shared conventions

- Content type: `application/json; charset=utf-8`. Money values are USD as JSON numbers (floats, as in Phase 1), never strings.
- Dates are `YYYY-MM-DD`. Timestamps are ISO 8601 UTC.
- Shares are fractions of the transaction amount in [0, 1].
- Every request may send an `X-Request-Id` header. If it is missing, the receiver generates one. It is echoed in the response header and in error bodies, and the backend forwards it to the inference service.
- **Unknown fields.**
  - **Responses are tolerant.** Consumers ignore unknown response fields at run time and never reject a response because of them. Producers add only optional fields within a version.
    - The OpenAPI response schemas are still closed (`additionalProperties: false`) where they serve as conformance checks:
      - every Inference API response, enforced in fixture and producer tests in CI (**Pending: Ayush**);
      - the app's non-`Decision` responses, pending Q7.
    - The app `Decision` schema is open, so a new engine field reaches the app through the mapper without a backend change.
  - **Requests are strict.** Every request body object, at every level, accepts only the fields this contract defines. An unknown field returns `422 VALIDATION_ERROR`, so a misspelt field never silently falls back to its default. This applies:
    - to the Application API;
    - to the Inference API's `state` object (unchanged from v0.3);
    - to the rest of every Inference API request body (**Pending: Ayush**).
  - **Null values.** `policy: null` is rejected with `422 VALIDATION_ERROR`; an omitted `policy` takes its default. `clientReference: null` / `client_reference: null` and `history: null` are accepted and mean "not given".
- **Determinism:** the same request against the same artefacts returns the same body *on the same platform and device*. PPO values may differ in the last floating-point digits between CPU and CUDA, or between operating systems (see `provenance.device`). `decision_id` hashes a canonical form of the request plus artefact fingerprints, never the outputs (§2.11).
  - **Cross-platform claim.** Baseline results, artefact fingerprints and `decision_id` are *designed* to be identical on Windows and Linux. The claim may be made only once the golden-hash test (§9) passes identically on both platforms. Until then, treat it as unverified.
- Enumerations:

| Enum | Values |
|---|---|
| `policy` | `waterfall` (default), `cheapest_feasible`, `ppo_projected` (experimental) |
| `policy_status` | `default`, `baseline`, `experimental` |
| `state.mode` | `historical_replay`, `scenario`, `explicit` |
| `values_provenance` | `synthetic_simulation` (replay), `synthetic_scenario` (scenario), `user_supplied_synthetic` (explicit) |
| `scenario_id` | `baseline`, `liquidity_minus30`, `liquidity_minus50`, `cheapest_venue_outage`, `congestion_x2`, `combined_stress` (the Stage 1F definitions, unchanged) |
| `corridor` | `USA->IND`, `GBR->PHL`, `ARE->MEX` |
| `split` | `train`, `validation`, `test` |
| `regime` | `below_cheapest`, `near_boundary`, `splitting_needed`, `exceeds_combined` |

---

## 2. Inference API (`/v1`)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/health` | Liveness and readiness |
| `GET` | `/v1/version` | Engine, data, knowledge and checkpoint versions; which policies are enabled |
| `GET` | `/v1/network` | Corridors and venues (static metadata) |
| `GET` | `/v1/state` | Bridge state for a corridor under replay or a scenario (bridge monitor) |
| `GET` | `/v1/replay/calendar` | Valid dates and the excluded gap buffers |
| `GET` | `/v1/scenarios` | Available scenario definitions |
| `POST` | `/v1/route` | Route one transaction with one policy |
| `POST` | `/v1/compare` | Route one transaction with several policies on the same state |
| `POST` | `/v1/explain` | Structured explanation of a routing decision |

The FastAPI process answers `/v1/health`, `/v1/version`, `/v1/replay/calendar` and `/v1/scenarios` from metadata loaded at startup. Every other endpoint runs in an isolated engine worker process (arch §6).

### 2.1 `GET /v1/health`

```json
{
  "status": "ok",
  "ready": true,
  "checks": {
    "structured_data": "ok",
    "daily_state": "ok",
    "knowledge_base": "ok",
    "engine_workers": "ok",
    "ppo_checkpoint": "disabled"
  },
  "engine_pool": {"workers": 2, "queued": 0, "max_queue": 32, "rebuilds_since_start": 0},
  "time": "2026-11-02T10:00:00Z"
}
```

- `status` is `ok` or `degraded`. It is `degraded` when `engine_workers` is `rebuilding` or `error`.
  - `rebuilding` means at least one engine worker process is being replaced. A worker is replaced after a timeout, a crash or a failed integrity check (arch §6.2). Each worker is replaced on its own; the other workers keep serving.
  - Expect more `ENGINE_BUSY` responses while a worker is being replaced.
- `engine_pool`:
  - `workers` is the configured number of worker processes.
  - `rebuilds_since_start` counts individual worker replacements.
  - **Pending: Ayush.** Add `ready_workers`: the number of workers that have finished warming up and can take a task.
- `ppo_checkpoint` is `ok`, `disabled` (none approved or configured) or `error` (hash mismatch). A `disabled` checkpoint doesn't make the service `degraded`.
- The non-`ok` values of `structured_data`, `daily_state` and `knowledge_base` are not yet defined (§10, Q12).
- HTTP 200 when `ready`, otherwise 503. `ready` is false until at least one engine worker has finished warming up. Warm-up is limited by `CBDC_ENGINE_STARTUP_TIMEOUT_S` (default 180 s, §8).

### 2.2 `GET /v1/version`

```json
{
  "api_version": "v1",
  "engine_version": "0.1.0",
  "phase1_baseline_tag": "phase1-complete",
  "git_commit": "bc9905e",
  "default_policy": "waterfall",
  "policies": [
    {"policy": "waterfall", "status": "default", "enabled": true},
    {"policy": "cheapest_feasible", "status": "baseline", "enabled": true},
    {"policy": "ppo_projected", "status": "experimental", "enabled": false,
     "disabled_reason": "no approved checkpoint configured"}
  ],
  "checkpoint": null,
  "knowledge": {"knowledge_version": "2026-11-02.1", "sha256": "<hex>"},
  "data": {
    "daily_state_sha256": "<hex>",
    "bridge_network_sha256": "<hex>",
    "normalization_stats_sha256": "<hex>",
    "date_range": {"start": "2011-01-01", "end": "2025-09-30"}
  },
  "reward_weights": {"lambda_latency": 1.0, "lambda_risk": 1.0, "lambda_unrouted": 1.0, "status": "placeholder"},
  "runtime": {"platform": "linux-x86_64", "python": "3.10.11", "torch": "2.13.0+cpu", "device": "cpu", "lock_file": "services/inference/requirements/linux-x86_64-cpu.txt"}
}
```

When a checkpoint is enabled, `checkpoint` is `{"checkpoint_id": "...", "sha256": "<hex>", "approved_by": "...", "approved_on": "YYYY-MM-DD", "source_run": "outputs/experiments/..."}`.

- `source_run` is the directory containing the checkpoint file, for now. It is to be revisited when the first checkpoint is approved.
- `git_commit` is provenance only. It is read at build time, never hard-coded, and does **not** enter `decision_id` (§2.11).
- `engine_version`: what a change to it means, and when it must be bumped, is not yet defined (§10, Q2).
- Whether `api_version` enters `decision_id` is open (§10, Q1).
- The hashes in `knowledge` and `data` are computed as §2.11 describes.

### 2.3 `GET /v1/network`

```json
{
  "corridors": [
    {
      "corridor": "USA->IND",
      "sender_country": "USA",
      "receiver_country": "IND",
      "venues": [
        {"slot": 0, "bridge_uid": "USA->IND#0", "fee_pct": 0.015, "baseline_capacity_usd": 1000000.0, "data_source_tag": "real_static_bridge"},
        {"slot": 1, "bridge_uid": "USA->IND#1", "fee_pct": 0.0105, "baseline_capacity_usd": 320000.0, "data_source_tag": "synthetic_bridge_expansion"},
        {"slot": 2, "bridge_uid": "USA->IND#2", "fee_pct": 0.0225, "baseline_capacity_usd": 180000.0, "data_source_tag": "synthetic_bridge_expansion"}
      ]
    }
  ],
  "max_single_transfer_usd": 500000.0,
  "max_single_transfer_provenance": "project_assumption"
}
```

The values come from `data/structured/bridge_network.csv` and the knowledge base, unmodified. `fee_pct` is a fraction (0.015 = 1.5%). `baseline_capacity_usd` is static reference metadata; execution uses the dynamic liquidity from the state. The ARE→MEX venue #0 is tagged `synthetic_no_real_anchor` in the source file, and that tag is passed through.

### 2.4 State specification (`StateSpec`)

Used by `/v1/state` (replay and scenario only), `/v1/route`, `/v1/compare` and `/v1/explain`. Exactly one of three modes:

**a) Historical replay** — the Phase 1 synthetic daily state on a date.
```json
{"mode": "historical_replay", "date": "2024-06-14"}
```

**b) Scenario** — a Stage 1F scenario applied to the whole daily series, read on a date.
```json
{"mode": "scenario", "date": "2024-06-14", "scenario_id": "cheapest_venue_outage"}
```

**c) Explicit synthetic state** — current liquidity and congestion supplied by the caller for every venue of the corridor, anchored to a reference date.
```json
{
  "mode": "explicit",
  "reference_date": "2024-06-14",
  "venues": [
    {"bridge_uid": "GBR->PHL#0", "liquidity_usd": 210000.0, "congestion": 0.35,
     "history": {"liquidity_usd": [/* 30 numbers, oldest first; last = 210000.0 */],
                 "congestion":    [/* 30 numbers, oldest first; last = 0.35 */]}},
    {"bridge_uid": "GBR->PHL#1", "liquidity_usd": 60000.0, "congestion": 0.20, "history": null},
    {"bridge_uid": "GBR->PHL#2", "liquidity_usd": 90000.0, "congestion": 0.50, "history": null}
  ]
}
```
The `/* … */` comments stand in for the arrays; they aren't valid JSON.

#### Validation rules

- **Dates.** `date` and `reference_date` must pass Phase 1's `validate_simulation_date()`: between 2011-01-01 and 2025-09-30, and not within 30 days of a split boundary. The boundaries include the dataset start, 2011-01-01, and its end, 2025-09-30. Failures return `DATE_OUT_OF_RANGE` or `DATE_IN_GAP_BUFFER`. `/v1/replay/calendar` lists every excluded range.
- **Explicit venues** must list **exactly** the corridor's venues, each once, or the error is `STATE_VENUE_MISMATCH`. An empty `venues` list is a mismatched venue set: it returns `STATE_VENUE_MISMATCH`, not `VALIDATION_ERROR`. The schemas therefore set no `minItems` on `venues`.
- **Explicit values.** `liquidity_usd` ≥ 0 and `congestion` ≥ 0, both finite. Otherwise the error is `INVALID_STATE_VALUE`.
- **Explicit history**, when given, has exactly 30 finite, non-negative numbers per channel, and the last element equals the current value (within 1e-9 relative). Otherwise the error is `INVALID_STATE_VALUE`. Whether a wrong *length* should instead be `VALIDATION_ERROR` is open (§10, Q5). Until it is decided, the v0.3 rule above stands. `history: null` and an omitted `history` mean the same thing.
- **Fields that can't be set.** Explicit mode accepts **no** `fee`, `risk`, `baseline_cost_pct`, `data_source_tag` or extra venues. Unknown fields inside `state` are rejected with `VALIDATION_ERROR`, rather than ignored, so callers can't believe they set a value that had no effect (see also §1).

#### What comes from where in explicit mode

| Input | Source | Note |
|---|---|---|
| Venues, slots, fees, tags | `bridge_network.csv` | Fixed |
| Current liquidity and congestion | Caller | Required |
| 30-day history | Caller (optional) | Required for `ppo_projected` |
| Corridor risk | Phase 1 risk proxy at `reference_date`'s month | One value per corridor, shared by its venues, as in Phase 1 |
| Cost baseline | Lagged quarterly RPW baseline at `reference_date` | ARE→MEX uses the documented synthetic fallback |
| Feasibility | `StaticMemoryProvider` | Facts are undated; the date doesn't affect feasibility |

#### Behaviour and limitations

- **How the state is applied.** The engine copies the baseline daily table and overrides each venue's row at `reference_date`. Where `history` is given, it also overrides the 29 preceding days. Execution, baselines, CNN windows and the regime label all read that request-scoped copy (arch §6.2, §9.1).
- **Without `history`,** only the `reference_date` row changes. The baselines are exact, because they only read the current row. **`ppo_projected` is refused** with `POLICY_UNAVAILABLE_FOR_STATE`, unless every venue has `history`.
- **Out-of-range values (`STATE_OUTSIDE_TRAINING_RANGE`).** Values are normalised with the frozen train-only statistics. The training range check works as follows:
  - **Bounds.** Each venue has separate liquidity and congestion min–max bounds. They are taken over the union of the actual 30-day windows of all training transactions, so they cover the days the model actually saw. They are not the min–max over the whole train-split calendar.
  - **Values checked.** The effective values the selected policy reads, after any scenario multiplier or explicit override:
    - for `waterfall` and `cheapest_feasible`, the current-day liquidity and congestion;
    - for `ppo_projected`, the whole 30-day window, including explicit `history`.
  - **Scope.** It applies in all three modes: replay, scenario and explicit.
  - **Effect.** Any value outside its bounds adds the **warning** `STATE_OUTSIDE_TRAINING_RANGE`. It is never an error, and it never blocks routing with a baseline policy. PPO on such inputs is out of distribution and unvalidated.
  - **Not yet decided:** whether `/v1/state` also reports this warning (§10, Q15).
- **No future dates.** No data exists after 2025-09-30. A "today" what-if must use explicit mode with a valid `reference_date`, and its cost and risk context come from that date.
- **"Historical" replay is synthetic.** It is the Phase 1 simulation conditioned on real lagged data, not observed bridge history.
- **No unseen dates for PPO.** Train dates trained the model, validation dates selected checkpoints, and test dates were examined in Phase 1. `provenance.split` is always reported, and `ppo_projected` on a train date adds `DATE_IN_TRAINING_SPLIT`.
- **Granularity:** state is daily, risk is monthly, and the cost baseline is quarterly and lagged by one quarter.
- **No liquidity carry-over.** Each transaction is independent, so routing one never reduces liquidity for the next (arch §9.3).
- **No mixing modes.** Explicit states can't be combined with scenarios in v1.

### 2.5 `GET /v1/state`

Query: `corridor=GBR->PHL&mode=historical_replay&date=2024-06-14`, or `&mode=scenario&scenario_id=...`, plus optional `include_history=true`. Explicit states are not looked up; they are what the caller already has.

```json
{
  "corridor": "GBR->PHL",
  "state": {"mode": "historical_replay", "date": "2024-06-14", "split": "test", "scenario_id": null},
  "corridor_risk": 0.087,
  "baseline_cost_pct": 0.0612,
  "venues": [
    {"slot": 0, "bridge_uid": "GBR->PHL#0", "fee_pct": 0.02, "liquidity_usd": 412345.6, "congestion": 0.31,
     "data_source_tag": "real_static_bridge", "values_provenance": "synthetic_simulation"}
  ],
  "warnings": []
}
```

With `include_history=true`, each venue also has `"history": {"dates": [30 dates], "liquidity_usd": [...], "congestion": [...]}` (raw values, not normalised).

### 2.6 `GET /v1/replay/calendar`

```json
{
  "start": "2011-01-01",
  "end": "2025-09-30",
  "splits": {
    "train": {"start": "2011-01-01", "end": "2021-12-31"},
    "validation": {"start": "2022-01-01", "end": "2023-12-31"},
    "test": {"start": "2024-01-01", "end": "2025-09-30"}
  },
  "gap_buffer_days": 30,
  "excluded_ranges": [{"start": "2011-01-01", "end": "2011-01-31"}],
  "note": "Synthetic daily bridge state. Not real CBDC telemetry. No data after 2025-09-30."
}
```

`excluded_ranges` lists every range rejected by `validate_simulation_date()`. The value shown is an example; the service computes the full list from the Phase 1 split module.

### 2.7 `GET /v1/scenarios`

```json
{
  "scenarios": [
    {"scenario_id": "cheapest_venue_outage", "description": "Fee-cheapest venue of each corridor at 10% liquidity.",
     "liquidity_multiplier": 1.0, "congestion_multiplier": 1.0, "cheapest_venue_liquidity_multiplier": 0.1}
  ],
  "note": "Uniform multipliers from Stage 1F, applied to the whole series. Not calibrated historical shocks."
}
```

### 2.8 `POST /v1/route`

**Request (`RouteRequest`)**
```json
{
  "transaction": {
    "sender_country": "GBR",
    "receiver_country": "PHL",
    "amount_usd": 300000.0,
    "client_reference": "demo-001"
  },
  "state": {"mode": "historical_replay", "date": "2024-06-14"},
  "policy": "waterfall"
}
```

- `policy` is optional and defaults to `waterfall`. `null` is rejected (§1).
- `client_reference` is optional: a string or null, echoed back unchanged. **Pending: Ayush:** at most 200 characters (Unicode code points, as JSON Schema `maxLength` counts them), the same limit as the Application API.
- `amount_usd` must be > 0 and finite. Amounts above the $500K cap are **not** a validation error: they return 200 with `feasibility.allowed = false`, exactly as Phase 1 does.
- The transaction's `simulation_date` is `state.date` (replay and scenario modes) or `state.reference_date` (explicit mode).

**Response (`RouteResponse`)** — HTTP 200
```json
{
  "decision_id": "sha256:9f2c…",
  "policy": "waterfall",
  "policy_status": "default",
  "transaction": {"sender_country": "GBR", "receiver_country": "PHL", "amount_usd": 300000.0, "corridor": "GBR->PHL",
                  "simulation_date": "2024-06-14", "client_reference": "demo-001"},
  "feasibility": {
    "allowed": true,
    "reason": null,
    "decisive_fact_ids": [],
    "knowledge_version": "2026-11-02.1"
  },
  "allocations": [
    {"slot": 0, "bridge_uid": "GBR->PHL#0", "data_source_tag": "real_static_bridge", "fee_pct": 0.02,
     "liquidity_usd": 412345.6, "congestion": 0.31, "risk": 0.087,
     "share_requested": 0.5, "amount_requested_usd": 150000.0, "amount_executed_usd": 150000.0, "amount_clipped_usd": 0.0,
     "share_before_projection": null},
    {"slot": 1, "bridge_uid": "GBR->PHL#1", "data_source_tag": "synthetic_bridge_expansion", "fee_pct": 0.014,
     "liquidity_usd": 150000.0, "congestion": 0.22, "risk": 0.087,
     "share_requested": 0.5, "amount_requested_usd": 150000.0, "amount_executed_usd": 150000.0, "amount_clipped_usd": 0.0,
     "share_before_projection": null},
    {"slot": 2, "bridge_uid": "GBR->PHL#2", "data_source_tag": "synthetic_bridge_expansion", "fee_pct": 0.03,
     "liquidity_usd": 85000.0, "congestion": 0.48, "risk": 0.087,
     "share_requested": 0.0, "amount_requested_usd": 0.0, "amount_executed_usd": 0.0, "amount_clipped_usd": 0.0,
     "share_before_projection": null}
  ],
  "totals": {
    "amount_usd": 300000.0,
    "requested_usd": 300000.0,
    "executed_usd": 300000.0,
    "unrouted_env_usd": 0.0,
    "unrouted_amount_based_usd": 0.0,
    "completion_ratio": 1.0,
    "completed": true,
    "bridges_used": 2
  },
  "metrics": {
    "fee_cost_usd": 5100.0,
    "baseline_cost_pct": 0.0612,
    "cost_term": 0.0442,
    "latency_term": 0.265,
    "risk_term": 0.087,
    "unrouted_term_env": 0.0,
    "unrouted_term_amount_based": 0.0,
    "reward_env": -0.3078,
    "reward_amount_based": -0.3078,
    "reward_weights": {"lambda_latency": 1.0, "lambda_risk": 1.0, "lambda_unrouted": 1.0, "status": "placeholder"}
  },
  "diagnostics": {
    "regime": "splitting_needed",
    "combined_liquidity_usd": 647345.6,
    "projection_applied": false
  },
  "provenance": {
    "state_mode": "historical_replay",
    "state_date": "2024-06-14",
    "split": "test",
    "scenario_id": null,
    "values_provenance": "synthetic_simulation",
    "engine_version": "0.1.0",
    "git_commit": "bc9905e",
    "knowledge_sha256": "<hex>",
    "daily_state_sha256": "<hex>",
    "state_frame_sha256": "<hex>",
    "checkpoint": null,
    "device": "cpu",
    "platform": "linux-x86_64"
  },
  "warnings": []
}
```

Field definitions:
- `allocations`: one entry per feasible venue, sorted by `slot`. Infeasible venues and padding slots never appear in it.
  - `share_requested` is the policy's action for that slot.
  - `amount_requested_usd` = `share_requested × amount_usd`.
  - `amount_executed_usd` = min(requested, liquidity), from `CBDCLiquidityEnv.step()`.
  - `amount_clipped_usd` = requested − executed. Clipped amounts are never redistributed.
  - `share_before_projection` is the raw PPO share for `ppo_projected`, and null otherwise.
  - `risk` is the corridor risk, the same for every venue in the corridor.
- `totals`:
  - `requested_usd` = Σ `allocations[].amount_requested_usd`. It is **not** `amount_usd`: a policy may request less than the whole amount.
  - `executed_usd` = Σ `allocations[].amount_executed_usd`.
  - `unrouted_env_usd` = requested − executed (the environment's figure).
  - `unrouted_amount_based_usd` = amount − executed (Stage 1F's figure).
  - `completed` uses the Stage 1F amount-based rule (`src/backtesting/evaluation.py`): max(amount − executed, 0) ≤ 1e-4 × amount (`RELATIVE_UNROUTED_TOLERANCE`).
  - `completion_ratio` = executed / amount.
  - `bridges_used` = the number of allocations with `share_requested` > 1e-6. This is Phase 1's `bridges_used()` with `MEANINGFUL_ALLOCATION_THRESHOLD`, both in `src/training/metrics.py`.
- **Allocation invariant (fail closed).** Before returning a result, the engine checks that:
  - `totals.requested_usd` equals the sum of the per-venue requested amounts;
  - no infeasible venue or padding slot received a non-zero weight in the policy's action.

  If either check fails, the task returns `500 INTERNAL_ERROR` with no result. A wrong allocation is never returned.
- `metrics`:
  - `cost_term`, `latency_term`, `risk_term` and `reward_env` are the environment's `reward_components`, unchanged.
  - `reward_amount_based` replaces the unrouted term with the amount-based one, as in Stage 1F.
  - The weights are always included, with `status: "placeholder"`.
- `diagnostics.regime` is Phase 1's ground-truth regime label (`true_regime_for_row`), computed from the request-scoped state, so in explicit mode it reflects the supplied liquidity.
- `provenance.state_frame_sha256` is the fingerprint of the state actually used. For replay it equals `daily_state_sha256`.
- `warnings` is a list of `{"code": "...", "message": "..."}` objects. Defined codes:

| Code | When |
|---|---|
| `EXPERIMENTAL_POLICY` | Always present for `ppo_projected` |
| `DATE_IN_TRAINING_SPLIT` | `ppo_projected` on a train-split date |
| `STATE_OUTSIDE_TRAINING_RANGE` | An effective value read by the selected policy is outside the venue's training-window bounds, in any state mode (§2.4). A warning only. |
| `RISK_FALLBACK_USED` | The risk proxy was unavailable, so the static placeholder was used |
| `COST_BASELINE_FALLBACK_USED` | No lagged RPW baseline exists, so the reward default was used |
| `SYNTHETIC_COST_ANCHOR` | Corridor ARE→MEX: the cost baseline uses the synthetic USA→MEX fallback |
| `PARTIAL_COMPLETION` | `completed` is false **and** `feasibility.allowed` is true. A regulatory rejection never carries it (C14). |

**Regulatory rejection:** HTTP 200, with:
- `feasibility.allowed = false`, `reason` set to Phase 1's reason string, and `decisive_fact_ids` filled;
- `allocations = []`;
- `totals.requested_usd = 0`, every executed amount 0, and `completed = false`;
- no `PARTIAL_COMPLETION` warning.

### 2.9 `POST /v1/compare`

```json
{
  "transaction": {"sender_country": "GBR", "receiver_country": "PHL", "amount_usd": 300000.0},
  "state": {"mode": "scenario", "date": "2024-06-14", "scenario_id": "cheapest_venue_outage"},
  "policies": ["waterfall", "cheapest_feasible", "ppo_projected"]
}
```

`policies` defaults to every enabled policy. The response is:
```json
{
  "results": [ { "...": "RouteResponse for waterfall" }, { "...": "RouteResponse for cheapest_feasible" } ],
  "skipped": [{"policy": "ppo_projected", "code": "POLICY_DISABLED", "message": "no approved checkpoint configured"}],
  "same_state": true,
  "note": "Single-transaction comparison under placeholder reward weights. Not evidence that one policy is better; see docs/STAGE1F_RESULTS.md."
}
```

Every policy runs in **one engine task**, on one request-scoped state frame. That guarantees `same_state` and gives every result the same `state_frame_sha256`. A policy that is disabled or unavailable for the state goes into `skipped`; it doesn't fail the request.

**Pending: Ayush.** Each result's `decision_id` is computed for that one policy (§2.11), never over the `policies` list. It therefore equals the `decision_id` that `/v1/route` returns for the same transaction, state and policy.

### 2.10 `POST /v1/explain`

**Request:** the same body as `/v1/route`. The service recomputes the decision deterministically, and the response's `decision_id` must equal the one `/v1/route` returned. Optional: `"include_semantic_context": false`. Because `semantic_context` is always null in v1 (below), this flag currently has no effect. Whether it stays in the v1 request schema is open (§10, Q8).

```json
{
  "decision_id": "sha256:9f2c…",
  "policy": "waterfall",
  "summary": "Routed 100% of $300,000 across 2 venues in fee order, each filled up to its simulated liquidity.",
  "feasibility": {
    "allowed": true,
    "reason": null,
    "active_facts": [
      {"fact_id": "global_max_single_transfer_usd", "rule_type": "max_single_transfer_usd", "value": 500000.0,
       "provenance_tag": "project_assumption", "verified": false, "source": "Frozen project constraint ... Not a real regulation."}
    ],
    "provider": "StaticMemoryProvider"
  },
  "venue_explanations": [
    {"bridge_uid": "GBR->PHL#1", "outcome": "used", "reason_code": "CHEAPEST_FILLED_TO_LIQUIDITY",
     "text": "Lowest fee (1.40%). Filled to its simulated liquidity of $150,000."},
    {"bridge_uid": "GBR->PHL#0", "outcome": "used", "reason_code": "NEXT_CHEAPEST_REMAINDER",
     "text": "Next-lowest fee (2.00%). Took the remaining $150,000."},
    {"bridge_uid": "GBR->PHL#2", "outcome": "unused", "reason_code": "AMOUNT_EXHAUSTED",
     "text": "Not needed: the amount was fully routed by cheaper venues."}
  ],
  "policy_notes": [],
  "semantic_context": null,
  "limitations": [
    "Bridge liquidity and congestion are synthetic simulation values.",
    "Reward weights are uncalibrated placeholders.",
    "The only regulatory fact is an assumed $500K cap, not a real regulation.",
    "Each transaction is independent; routing does not deplete liquidity for later transactions."
  ]
}
```

- `venue_explanations` is in fill order for the waterfall and in slot order for the other policies.
- `outcome` is `used` or `unused`; no other value exists in v1 (C11). For a regulatory rejection, every venue is `unused` with `reason_code` `INFEASIBLE_REGULATORY`.
- `reason_code` values:
  - waterfall: `CHEAPEST_FILLED_TO_LIQUIDITY`, `NEXT_CHEAPEST_REMAINDER`, `FILLED_TO_LIQUIDITY`, `AMOUNT_EXHAUSTED`, `NO_LIQUIDITY`;
  - cheapest-feasible: `CHEAPEST_SELECTED`, `NOT_CHEAPEST`, `CLIPPED_AT_LIQUIDITY`;
  - PPO: `PPO_SHARE`, `PROJECTION_REDUCED_TO_CAPACITY`, `PROJECTION_INCREASED`;
  - any policy: `INFEASIBLE_REGULATORY`.
- For `ppo_projected`, `policy_notes` must state that shares come from a learned policy with no causal explanation, and that the capacity projection adjusted them. It also lists each slot's change from `share_before_projection`. **No made-up causal reasons for PPO's choices.**
- In explicit mode, `limitations` also states that liquidity and congestion were supplied by the user, and that risk and cost come from `reference_date`.
- `semantic_context` is reserved and **always null in v1** (C6). Its inner shape is undefined until a later version defines it. Cognee stays optional (arch §7.2) and never changes `feasibility`.

### 2.11 `decision_id`

`decision_id` identifies a decision's *inputs*, not its outputs. It is `"sha256:"` followed by the lowercase hex SHA-256 of a canonical JSON document. The backend treats it as an opaque string: it stores it and compares it by exact equality, and never computes or parses it.

**Approved rules:**
- **Canonical form.** The document is serialised with RFC 8785, the JSON Canonicalization Scheme (JCS), and hashed as UTF-8 bytes. The implementation uses the pinned, pure-Python `rfc8785` package (arch §7.2).
- **Excluded:** `git_commit` (provenance only, §2.2), and every output field.
- **Text artefacts.** Artefact hashes of text files (CSV, JSON) are computed after converting CRLF line endings to LF. A Windows checkout made with `core.autocrlf=true` therefore hashes the same as the committed blob. Binary files are hashed as they are. No `.gitattributes` rule is added for `data/`.
- **Daily-state fingerprint** (`daily_state_sha256`, `state_frame_sha256`): SHA-256 over:
  1. the frame's column names and dtypes, in column order;
  2. pandas' per-row `uint64` hashes, written explicitly as **little-endian** bytes.

  pandas stays pinned. Dev A fixes the exact byte layout in code, and a golden-hash test pins it (§9).

**Pending: Ayush** (agreed by Dev B and Dev D):
- **What is canonicalised.** The *validated, parsed* request model, never the raw body. So a client sending `300000` and one sending `300000.0` get the same ID; JCS writes both as `300000`. Within it:
  - the default policy is applied before hashing;
  - `history: null` and a missing `history` are the same;
  - explicit `venues` are sorted by `bridge_uid`.
- **Inputs hashed.**
  - `transaction`: `sender_country`, `receiver_country` and `amount_usd`;
  - `state`;
  - the one `policy`;
  - artefact fingerprints: knowledge, daily state, bridge network and normalisation stats;
  - the checkpoint's SHA-256, **for `ppo_projected` only**. A checkpoint change then never changes the IDs of baseline decisions.
- **Not hashed:** `client_reference` and `include_semantic_context`. Neither affects the decision.
- **One ID per policy.** Each ID is computed for one policy, so `/v1/compare` IDs equal `/v1/route` IDs (§2.9).

**Open:**
- whether `api_version` enters the hash (§10, Q1);
- what `engine_version` means, and whether it enters the hash (§10, Q2).

---

## 3. Application API (`/api/v1`)

### 3.0 Development-only authentication

The full design is in arch §8. In summary:

- **Mode.** `AUTH_MODE=dev` is the only supported mode. The backend refuses to start if `NODE_ENV=production`, if `AUTH_MODE` is unset or different, or if the token file is missing or invalid.
- **Header.** Every endpoint except `GET /api/v1/health` requires `Authorization: Bearer <token>`, where the token is 64 hex characters (32 random bytes) generated locally by each developer.
- **Storage.** The backend stores only SHA-256 hashes of tokens, in the git-ignored `services/backend/dev-tokens.json`. Each hash maps to a user ID, an email and a role (`viewer` or `analyst`).
- **Roles.** Only `analyst` may request `ppoProjected`, in a transaction or a comparison. Anyone else gets `403 FORBIDDEN_POLICY`.
- **Frontend.** It keeps the token in memory, mirrored to `sessionStorage`. It never uses `localStorage`, cookies, URLs, logs or `VITE_*` variables. It sends the token only to the same-origin `/api/v1`.
- **Mock mode.** MSW accepts only `mock-viewer` and `mock-analyst`, which the real backend rejects.

**`GET /api/v1/auth/me`** returns HTTP 200:
```json
{"userId": "u-analyst-1", "email": "analyst@example.test", "role": "analyst", "authMode": "dev",
 "permissions": {"experimentalPolicies": true}}
```
It returns `401 UNAUTHENTICATED` if the token is missing or invalid. There is no login or logout endpoint: signing out only clears the token in the browser.

### 3.1 Endpoints

| Method | Path | Purpose | Calls inference |
|---|---|---|---|
| `GET` | `/api/v1/health` | Backend, database and inference status (no auth) | `/v1/health` |
| `GET` | `/api/v1/auth/me` | Caller identity and role | — |
| `GET` | `/api/v1/meta` | Versions, enabled policies, reward-weight status | `/v1/version` (cached) |
| `GET` | `/api/v1/network` | Corridors and venues | `/v1/network` (cached) |
| `GET` | `/api/v1/state` | Bridge monitor data | `/v1/state` |
| `GET` | `/api/v1/replay/calendar` | Valid dates | `/v1/replay/calendar` (cached) |
| `GET` | `/api/v1/scenarios` | Scenario list | `/v1/scenarios` (cached) |
| `POST` | `/api/v1/transactions` | Submit and route a transaction; persist the decision | `/v1/route` |
| `GET` | `/api/v1/transactions` | Paginated history with filters | — |
| `GET` | `/api/v1/transactions/:id` | One transaction with its decision and allocations | — |
| `GET` | `/api/v1/transactions/:id/explanation` | Explanation (stored after the first request) | `/v1/explain` |
| `POST` | `/api/v1/comparisons` | Compare policies for one transaction; persisted as an independent record (§3.6) | `/v1/compare` |
| `GET` | `/api/v1/comparisons/:id` | A stored comparison | — |
| `GET` | `/api/v1/dashboard/summary` | Aggregates over stored decisions | — |

History, comparisons and the dashboard return every user's records to any authenticated user. Per-user visibility is not a Phase 2 requirement.

### 3.2 `POST /api/v1/transactions`

**Request**
```json
{
  "senderCountry": "GBR",
  "receiverCountry": "PHL",
  "amountUsd": 300000.0,
  "state": {"mode": "historicalReplay", "date": "2024-06-14"},
  "policy": "waterfall",
  "clientReference": "demo-001"
}
```

- The body is strict (§1): only the fields shown here, plus the `state` fields below, are accepted.
- `clientReference` is optional: a string of at most 200 characters (Unicode code points), or null. A longer value returns `422 VALIDATION_ERROR` with `field: "clientReference"`.
- `policy: null` is rejected with `422 VALIDATION_ERROR`. An omitted `policy` means `waterfall`.
- State mode values:
  - `historicalReplay` (with `date`);
  - `scenario` (with `date` and `scenarioId`);
  - `explicit` (with `referenceDate` and `venues[]`). Each venue has `bridgeUid`, `liquidityUsd`, `congestion` and an optional `history: {liquidityUsd: [30], congestion: [30]}`. There is no risk or fee field (§2.4).
- Policy values: `waterfall` (default), `cheapestFeasible` and `ppoProjected` (analysts only).

**Response** — HTTP 201
```json
{
  "id": "c0a8012e-7d3b-4f5e-9a51-2b1f3c4d5e6f",
  "createdAt": "2026-11-02T10:00:00Z",
  "createdBy": "u-analyst-1",
  "status": "routed",
  "transaction": {"senderCountry": "GBR", "receiverCountry": "PHL", "corridor": "GBR->PHL", "amountUsd": 300000.0,
                  "simulationDate": "2024-06-14", "clientReference": "demo-001"},
  "failure": null,
  "decision": {
    "decisionId": "sha256:9f2c…",
    "policy": "waterfall",
    "policyStatus": "default",
    "feasibility": {"allowed": true, "reason": null, "decisiveFactIds": [], "knowledgeVersion": "2026-11-02.1"},
    "allocations": [
      {"slot": 0, "bridgeUid": "GBR->PHL#0", "dataSourceTag": "real_static_bridge", "feePct": 0.02,
       "liquidityUsd": 412345.6, "congestion": 0.31, "risk": 0.087, "shareRequested": 0.5,
       "amountRequestedUsd": 150000.0, "amountExecutedUsd": 150000.0, "amountClippedUsd": 0.0, "shareBeforeProjection": null}
    ],
    "totals": {"amountUsd": 300000.0, "requestedUsd": 300000.0, "executedUsd": 300000.0, "unroutedEnvUsd": 0.0,
               "unroutedAmountBasedUsd": 0.0, "completionRatio": 1.0, "completed": true, "bridgesUsed": 2},
    "metrics": {"feeCostUsd": 5100.0, "baselineCostPct": 0.0612, "costTerm": 0.0442, "latencyTerm": 0.265, "riskTerm": 0.087,
                "unroutedTermEnv": 0.0, "unroutedTermAmountBased": 0.0, "rewardEnv": -0.3078, "rewardAmountBased": -0.3078,
                "rewardWeights": {"lambdaLatency": 1.0, "lambdaRisk": 1.0, "lambdaUnrouted": 1.0, "status": "placeholder"}},
    "diagnostics": {"regime": "splitting_needed", "combinedLiquidityUsd": 647345.6, "projectionApplied": false},
    "provenance": {"stateMode": "historicalReplay", "stateDate": "2024-06-14", "split": "test", "scenarioId": null,
                   "valuesProvenance": "synthetic_simulation", "engineVersion": "0.1.0", "gitCommit": "bc9905e",
                   "knowledgeSha256": "<hex>", "dailyStateSha256": "<hex>", "stateFrameSha256": "<hex>",
                   "checkpoint": null, "device": "cpu", "platform": "linux-x86_64"},
    "warnings": []
  }
}
```

The example `allocations` array is shortened to one entry; real responses list every feasible venue.

- The `decision` is a field-for-field camelCase mapping of `RouteResponse` (§2.8). Enum values are mapped too: `historical_replay` → `historicalReplay`, `cheapest_feasible` → `cheapestFeasible`, `ppo_projected` → `ppoProjected`. Codes, IDs, tags and `bridge_uid` values are not changed.
- **`status`** is `routed` when inference returned 200, including regulatory rejections, which show `feasibility.allowed = false`. It is `failed` when the inference call failed after the request passed the backend's validation.
- **`failure`** is null when `status` is `routed`. When `status` is `failed`, it is `{"code": "...", "message": "..."}`:
  - `code` is the error code the `POST` returned: `INFERENCE_ERROR`, `INFERENCE_UNAVAILABLE`, `ENGINE_BUSY` or `ENGINE_TIMEOUT`;
  - `message` is the backend's fixed message for that code. It never contains engine text.
  - The backend stores only the code (`failureCode`, §6.3).
- **When `status` is `failed`:**
  - `decision` is null;
  - `transaction.corridor` is null, because no engine response confirmed it, and the backend never derives it from the country codes;
  - the other `transaction` fields echo the request.
- **Inference failures are persisted.** Every inference failure after validation is saved with `status: "failed"`. The `POST` returns the error with `"transactionId"` in `error.details`:

  | Inference outcome | App response |
  |---|---|
  | 5xx other than those below, or an invalid body | `502 INFERENCE_ERROR` |
  | Unreachable, or the backend's 15 s timeout elapsed | `503 INFERENCE_UNAVAILABLE` |
  | `503 NOT_READY` | `503 INFERENCE_UNAVAILABLE`, with `Retry-After` forwarded |
  | `503 ENGINE_BUSY`, including a task that expired in the queue (§5) | `503 ENGINE_BUSY`, with `Retry-After` forwarded |
  | `504 ENGINE_TIMEOUT` | `504 ENGINE_TIMEOUT` |

  Under load this fills the history with `ENGINE_BUSY` rows. That is accepted at development scale.
- **Passed through, not persisted.** Engine validation errors (422) and `409 POLICY_DISABLED` keep their code and status and are not persisted.
  - A viewer's `ppoProjected` gets `403 FORBIDDEN_POLICY` first. Authorization is checked before anything that depends on server state, so a viewer never learns whether a checkpoint is enabled.
  - Rules for messages and details are in §4.

### 3.3 `GET /api/v1/transactions`

Query parameters: `page` (default 1), `pageSize` (default 20, max 100), `corridor`, `policy`, `stateMode`, `completed` (true/false), `from` and `to` (by `createdAt`), `sort` (`createdAt:desc` by default).

```json
{
  "items": [
    {"id": "c0a8012e-…", "createdAt": "2026-11-02T10:00:00Z", "createdBy": "u-analyst-1", "corridor": "GBR->PHL",
     "amountUsd": 300000.0, "simulationDate": "2024-06-14", "stateMode": "historicalReplay", "policy": "waterfall",
     "policyStatus": "default", "status": "routed", "allowed": true, "completed": true, "completionRatio": 1.0,
     "executedUsd": 300000.0, "rewardAmountBased": -0.3078}
  ],
  "page": 1, "pageSize": 20, "total": 1
}
```

For a `failed` transaction, the fields that come from a decision are null: `corridor`, `policyStatus`, `allowed`, `completed`, `completionRatio`, `executedUsd` and `rewardAmountBased`. `policy` is the requested policy. The `completed=true|false` filter never matches a failed row.

### 3.4 `GET /api/v1/transactions/:id`

Returns the same body as the 201 response in §3.2. That includes failed transactions, with `status: "failed"`, `decision: null`, `transaction.corridor: null` and `failure` set. Unknown IDs return `404 NOT_FOUND`.

### 3.5 `GET /api/v1/transactions/:id/explanation`

Returns the camelCase mapping of the `/v1/explain` response, plus `"transactionId"`. The backend calls `/v1/explain` with the stored request, checks that the returned `decisionId` equals the stored one (otherwise `409 DECISION_MISMATCH`, which means the engine artefacts changed), and stores the result.

- **Failed transaction.** If the transaction's `status` is `failed`, the backend returns `409 TRANSACTION_FAILED` without calling inference, and stores nothing. A 404 would wrongly say the transaction doesn't exist, and `DECISION_MISMATCH` means something else.
- **Policy now disabled.** If `/v1/explain` returns `409 POLICY_DISABLED`, for example because a `ppoProjected` transaction's checkpoint is no longer enabled, it is passed through and nothing is stored.
- **Other errors.** Inference failures map as in §3.2, but nothing is persisted.

### 3.6 `POST /api/v1/comparisons`

The request is the same as §3.2, with `"policies": [...]` in place of `policy`. It is strict in the same way, and `policies: null` is rejected. A viewer who includes `ppoProjected` gets `403 FORBIDDEN_POLICY`. If a viewer omits `policies`, the backend sends only the non-experimental policies. A disabled policy is reported in `skipped`, never as an error. The response is HTTP 201 with `{"id", "createdAt", "createdBy", "transaction", "results": [decision…], "skipped": [...], "sameState": true, "note": "..."}`.

**A comparison is an independent record.**
- It creates no transaction record, has no `transactionId`, and never appears in `GET /api/v1/transactions` or the dashboard.
- It stores its own transaction fields, the state spec, the policy list sent to the engine, its creator and the verbatim `/v1/compare` response (§6.3).
- `transaction.corridor` is null only if every policy was skipped. In that case no result confirms the corridor, and it is not derived.
- **Pending: Anvesh** (it follows from the backend schema, where `engineResponse` is required). A comparison is persisted only when `/v1/compare` returns 200. On an inference failure it returns the §3.2 error, with no `transactionId`.

### 3.7 `GET /api/v1/state`

Query: `corridor`, `mode` (`historicalReplay` or `scenario`), `date`, `scenarioId`, `includeHistory`. It returns the camelCase mapping of §2.5.

### 3.8 `GET /api/v1/dashboard/summary`

Query: `from`, `to`, `corridor`, `policy`.

```json
{
  "window": {"from": "2026-11-01T00:00:00Z", "to": "2026-11-02T23:59:59Z"},
  "totals": {"transactions": 42, "routed": 41, "failed": 1, "rejectedByFeasibility": 2},
  "byPolicy": [
    {"policy": "waterfall", "count": 35, "completionRate": 0.971, "meanRewardAmountBased": 0.874,
     "meanFeeCostPct": 0.0139, "meanLatencyTerm": 0.271, "meanRiskTerm": 0.083}
  ],
  "byCorridor": [{"corridor": "GBR->PHL", "count": 15, "completionRate": 0.933}],
  "note": "Aggregates of independent what-if decisions on synthetic states, under placeholder reward weights. Transactions do not consume liquidity. Not a backtest."
}
```

The aggregates are computed from stored decision fields only, never recomputed from allocations. Comparisons are not included (§3.6).

- `totals.failed` counts transactions with `status: "failed"`. `totals.rejectedByFeasibility` counts routed decisions with `allowed = false`.
- **`completionRate`** (**Pending: Ayush, as project owner**; agreed by Dev B, Dev C and Dev D) is the share of `completed = true` among routed decisions with `allowed = true`. Rejected and failed transactions are excluded from both the numerator and the denominator; they are counted separately in `totals`. It is null when no such decision exists. The same rule applies in `byPolicy` and `byCorridor`.
  - Rejections are feasibility outcomes and failures are infrastructure problems; neither is a policy result.
  - In v0.3 the rate was the mean of every stored `completed` value, so a rejection pulled it down. This change alters how the dashboard reads.
- Not yet defined (§10, Q11):
  - what `count` counts;
  - which decisions the `mean*` fields average over;
  - whether to add a field giving the rate's denominator.

### 3.9 `GET /api/v1/health`, `GET /api/v1/meta`

`health` (no auth):
```json
{"status": "ok", "database": "ok", "inference": "ok", "authMode": "dev", "time": "..."}
```
- `database` is `ok` or `unavailable`.
- `inference` is `ok`, `degraded`, `unavailable` or `mock`. `mock` means `INFERENCE_MODE=mock`, and inference is not called.
- `status`, with the database `ok`:
  - `ok` with HTTP 200 when `inference` is `ok` or `mock`. Mock mode is a deliberate configuration, not a fault.
  - `degraded` with HTTP 200 when `inference` is `degraded` or `unavailable`.
- **Database `unavailable`: HTTP status and `status` value are open** (§10, Q3). Dev B and Dev D propose HTTP 503 with `status: "unavailable"`. Dev C proposes HTTP 200 with `status: "degraded"`, and a separate readiness endpoint if one is needed. Until Q3 is decided, the schema allows only `ok` and `degraded`, and no 503 is specified.
- The backend checks inference health with its own short timeout, not the 15 s routing timeout (§5).

`meta`: the camelCase mapping of `/v1/version`, plus `"backendVersion"` and `"inferenceMode": "live"|"mock"`.

---

## 4. Error format

Both APIs use one envelope:

```json
{
  "error": {
    "code": "DATE_IN_GAP_BUFFER",
    "message": "simulation_date 2022-01-10 falls within the 30-day gap buffer of a split boundary.",
    "details": {"field": "state.date"},
    "request_id": "b1946ac9-…"
  }
}
```

The Application API uses `requestId` in place of `request_id`. The `code` values are identical in both, and messages never include tokens or stack traces.

**`details`:**
- `VALIDATION_ERROR` carries `details.errors`: a non-empty array of `{"field", "message"}`.
  - `field` is the path of the offending value in that API's own request body and field case, with `.` between keys and `[n]` for array indexes. For example, `state.venues[1].history.liquidityUsd` in the app and `state.venues[1].history.liquidity_usd` in inference.
  - How an error that is about no single field is written is open (§10, Q4). Dev B proposes `field: ""`, always present. Dev C proposes omitting `field`. Until Q4 is decided, the schemas accept both, and consumers treat a missing or empty `field` as a form-level error.
- Other 422 codes may set `details.field` with the same path syntax.
- A failed `POST /api/v1/transactions` sets `details.transactionId` (§3.2).

**How the backend passes inference errors on:**
- **Message.** For a passed-through 4xx code, the backend forwards the engine's `message`, truncated to 500 characters. For every 5xx it uses its own fixed message and never forwards engine text. **Pending: Ayush:** engine 4xx messages contain no internal paths or values.
- **Details.**
  - `details.errors[]` is forwarded only after each `field` is mapped from the engine path to the app path. The mapping uses an explicit table, not a generic camelCase conversion. For example, `transaction.amount_usd` becomes the top-level `amountUsd`. A path that can't be mapped becomes a form-level error, written as Q4 decides.
  - Whether `details.field` of a domain 422 (such as `DATE_IN_GAP_BUFFER`) is forwarded, after mapping, is open (§10, Q6).
  - All other engine `details` are dropped.
- **`Retry-After`.** When inference sends it, with `ENGINE_BUSY` or `NOT_READY`, the backend copies it, in integer seconds, onto the app response.

| HTTP | `code` | Raised by | When |
|---|---|---|---|
| 400 | `MALFORMED_REQUEST` | both | Invalid JSON |
| 401 | `UNAUTHENTICATED` | app | Missing, malformed or unknown token |
| 403 | `FORBIDDEN_POLICY` | app | A non-analyst requested `ppoProjected`. Checked before any call to inference. |
| 404 | `NOT_FOUND` | both | Unknown resource |
| 405 | `METHOD_NOT_ALLOWED` | both | The path exists, but not with this method. The response has an `Allow` header listing the path's methods (RFC 9110). |
| 409 | `DECISION_MISMATCH` | app | Recomputed `decision_id` differs from the stored one |
| 409 | `POLICY_DISABLED` | inference (passed through by app) | `ppo_projected` requested but no approved checkpoint is enabled. The app doesn't persist it. In comparisons it appears in `skipped`, not as an error. |
| 409 | `TRANSACTION_FAILED` | app | Explanation requested for a transaction whose `status` is `failed` |
| 422 | `VALIDATION_ERROR` | both | Schema or type error, including any unknown request field (§1) and `policy: null`. `details.errors[]` lists them. |
| 422 | `UNSUPPORTED_CORRIDOR` | inference | Corridor not in the network |
| 422 | `INVALID_AMOUNT` | inference | Amount ≤ 0 or not finite |
| 422 | `DATE_OUT_OF_RANGE` | inference | Outside 2011-01-01 to 2025-09-30 |
| 422 | `DATE_IN_GAP_BUFFER` | inference | Within a gap buffer |
| 422 | `UNKNOWN_SCENARIO` | inference | `scenario_id` not defined |
| 422 | `STATE_VENUE_MISMATCH` | inference | Explicit venues don't match the corridor exactly, including an empty list |
| 422 | `INVALID_STATE_VALUE` | inference | Negative, NaN or infinite value; history of the wrong length (§10, Q5); last history value ≠ current |
| 422 | `POLICY_UNAVAILABLE_FOR_STATE` | inference | `ppo_projected` in explicit mode without `history` on every venue |
| 500 | `INTERNAL_ERROR` | both | Unexpected failure, with no result returned. Includes a failed engine integrity check and a failed allocation invariant (§2.8). |
| 502 | `INFERENCE_ERROR` | app | Inference returned a 5xx other than `NOT_READY`, `ENGINE_BUSY` or `ENGINE_TIMEOUT`, or an invalid body |
| 503 | `INFERENCE_UNAVAILABLE` | app | Inference unreachable, the backend's 15 s timeout elapsed, or inference returned `NOT_READY` |
| 503 | `ENGINE_BUSY` | inference (passed through by app) | Engine queue full (`CBDC_ENGINE_MAX_QUEUE`). **Pending: Ayush:** also a task whose end-to-end deadline expired while it was still queued (§5). It never ran, so a retry is safe. |
| 503 | `NOT_READY` | inference (app maps it to `INFERENCE_UNAVAILABLE`) | No engine worker is ready yet, or required artefacts failed to load |
| 504 | `ENGINE_TIMEOUT` | inference (passed through by app) | A task that had **started** ran past its execution limit (§5) |

A regulatory rejection is **not** an error (§2.8). `ENGINE_BUSY` and `NOT_READY` responses include a `Retry-After` header in integer seconds. The app forwards it (see above).

**Not yet decided** (§10, Q10): an optional `details.cause` on `INFERENCE_UNAVAILABLE`, which would let the UI say "starting up". It is not part of v0.4.

---

## 5. Inter-service behaviour

- **Backend → inference:** a 15 s timeout (`INFERENCE_TIMEOUT_MS`). `POST` requests are never retried automatically; `GET` requests may retry once. `X-Request-Id` is forwarded. The `Authorization` header is never forwarded: the inference service has no auth.
- **Engine deadlines.** Each engine task has a **12 s end-to-end deadline**, counted from when the inference service accepts the request, and a **10 s execution limit** (`CBDC_ENGINE_TASK_TIMEOUT_S`).
  - A task that starts runs for at most min(10 s, 12 s − time spent queued).
  - A task that started and ran out of time fails with `504 ENGINE_TIMEOUT`. Its worker process is terminated and replaced (worker recycling, arch §6.2).
  - **Pending: Ayush.** A task whose deadline expires while it is still queued is removed without running, and fails with `503 ENGINE_BUSY` and `Retry-After`.
  - The 12 s deadline leaves 3 s for transport inside the backend's 15 s, so the engine always answers before the backend gives up.
  - Whether the 12 s value is configurable, and under which variable name, is open (§10, Q9).
- **Health checks.** The backend's check of `/v1/health` uses its own short timeout (set by Dev B; 3 s, like the database probe, was proposed), not the 15 s routing timeout.
- **Caching:** cached `GET` results (`version`, `network`, `calendar`, `scenarios`) are invalidated when `/v1/version` reports a different `git_commit`, `knowledge.sha256` or `checkpoint.sha256`.
- **Network exposure:** the inference service listens on the internal Compose network only and must not be published to the host in the `full` profile of `infra/compose.yaml`. For local debugging, Dev A may publish it on `127.0.0.1:8000`.

---

## 6. Persistence (backend)

### 6.1 Principles
- Store the full inference response verbatim (`engineResponse` JSON), plus the normalised columns needed for queries.
- Never store tokens, token hashes or other secrets in database records. Token hashes live only in `dev-tokens.json`.
- Records are append-only. Corrections create new records.

### 6.2 What is persisted
Each transaction request (including the full state spec, so explicit states can be replayed, and, for a failed transaction, its failure code), its routing decision, each allocation row, comparisons (as independent records), explanations and an audit log entry for every mutating call.

### 6.3 Prisma models (outline; Dev B finalises)

| Model | Key fields |
|---|---|
| `User` | `id`, `email`, `role` (`viewer`/`analyst`); seeded from `dev-tokens.json`, without the hashes |
| `TransactionRequest` | `id`, `createdAt`, `createdById`, `senderCountry`, `receiverCountry`, `corridor` (null when `failed`), `amountUsd`, `stateMode`, `stateSpec` (JSON), `simulationDate`, `requestedPolicy`, `status`, `failureCode` (null unless `status` is `failed`; needs a new migration), `clientReference` (≤ 200 characters) |
| `RoutingDecision` | `id`, `transactionId`, `decisionId`, `policy`, `policyStatus`, `allowed`, `completed`, `completionRatio`, `executedUsd`, `unroutedEnvUsd`, `unroutedAmountBasedUsd`, `rewardEnv`, `rewardAmountBased`, `valuesProvenance`, `stateFrameSha256`, `checkpointSha256`, `knowledgeSha256`, `gitCommit`, `engineResponse` (JSON) |
| `Allocation` | `id`, `decisionId`, `slot`, `bridgeUid`, `shareRequested`, `amountRequestedUsd`, `amountExecutedUsd`, `amountClippedUsd`, `liquidityUsd`, `congestion`, `risk`, `shareBeforeProjection` |
| `Comparison` | `id`, `createdAt`, `createdById`, `senderCountry`, `receiverCountry`, `corridor`, `amountUsd`, `simulationDate`, `clientReference`, `stateMode`, `stateSpec` (JSON), `policies`, `engineResponse` (JSON). An independent record: no `TransactionRequest` is created, and there is no `transactionId`. |
| `Explanation` | `id`, `decisionId`, `engineResponse` (JSON), `createdAt` |
| `AuditLog` | `id`, `at`, `userId`, `action`, `requestId`, `entityType`, `entityId`, `outcome` |

---

## 7. Checkpoint approval registry (inference)

`services/inference/config/approved_checkpoints.json` is maintained by the project owner and reviewed in a PR:

```json
{
  "approved": [
    {
      "checkpoint_id": "<id>",
      "path": "outputs/experiments/<run>/<seed>/<config>/ppo_checkpoint.pt",
      "sha256": "<hex>",
      "approved_by": "<owner>",
      "approved_on": "YYYY-MM-DD",
      "evidence": "docs/STAGE1F_RESULTS.md",
      "notes": "Experimental. Served only with capacity projection."
    }
  ]
}
```

- The file ships with `"approved": []`. **No checkpoint is approved yet.**
- `ppo_projected` is enabled only when `CBDC_PPO_CHECKPOINT_ID` names an entry in this file and the file at `path` has exactly that `sha256`. Otherwise it is disabled and requests return `POLICY_DISABLED`.
- A hash mismatch is logged as an error, and `/v1/health` reports `ppo_checkpoint: "error"`.
- No checkpoint path or ID appears in source code. Each engine worker verifies the hash itself when it loads the checkpoint.
- `/v1/version` reports `checkpoint.source_run` as the directory that contains the checkpoint file (§2.2).

---

## 8. Configuration (environment variables)

| Variable | Service | Default | Meaning |
|---|---|---|---|
| `CBDC_REPO_ROOT` | inference | `.` (container: `/repo`) | Repository root; engine workers `chdir` here |
| `CBDC_PPO_CHECKPOINT_ID` | inference | unset | Entry in the approval registry; unset disables `ppo_projected` |
| `CBDC_DEVICE` | inference | `cpu` | `cpu` or `cuda` |
| `CBDC_ENGINE_WORKERS` | inference | `2` | Engine worker processes per server process |
| `CBDC_ENGINE_TASK_TIMEOUT_S` | inference | `10` | Execution limit for a task that has started, capped by the 12 s end-to-end deadline (§5). Exceeding it returns `ENGINE_TIMEOUT` and recycles **that worker**: its process is terminated and replaced. The other workers keep serving. |
| `CBDC_ENGINE_STARTUP_TIMEOUT_S` | inference | `180` | Maximum time for one engine worker to finish warming up: loading the tables, the knowledge base and the CNN (arch §6.2). |
| `CBDC_ENGINE_MAX_QUEUE` | inference | `32` | Waiting tasks before `ENGINE_BUSY` |
| `CBDC_ENABLE_COGNEE` | inference | `false` | Optional Cognee support (needs local Ollama and the `services/inference/requirements/cognee-<platform>.txt` lock; see `docs/STAGE1E_MEMORY.md`). In v1, `semantic_context` is always null whatever this is set to (§2.10). |
| `INFERENCE_URL` | backend | `http://inference:8000` | Inference base URL |
| `INFERENCE_MODE` | backend | `live` | `live` or `mock` |
| `INFERENCE_TIMEOUT_MS` | backend | `15000` | Inference request timeout. It must stay above the engine's 12 s end-to-end deadline. |
| `AUTH_MODE` | backend | — (required) | Must be `dev`; anything else stops startup |
| `DEV_TOKENS_FILE` | backend | `./dev-tokens.json` | Git-ignored token-hash file |
| `DATABASE_URL` | backend | — | PostgreSQL URL, kept in `.env` (git-ignored), never committed |
| `VITE_API_MODE` | web | `live` | `live` or `mock` (MSW) |
| `VITE_PROXY_TARGET` | web (dev server only) | `http://localhost:4000` | Vite proxy target for `/api` |

No token, password or secret is ever put in a `VITE_*` variable: Vite embeds those values in the built bundle.

---

## 9. Contract tests (minimum)

Each suite lives in its owner's folder and runs in that owner's path-filtered CI workflow (arch §5.4). None of them goes under Phase 1's `tests/`.

| Owner (location · workflow) | Test |
|---|---|
| A (`services/inference/tests/parity/` · `phase2-inference.yml`) | **Parity:** on the Stage 1D validation split and one holdout, `route()` and `/v1/route` match `src/training/evaluate.py`'s waterfall and cheapest-feasible results for every row (action, executed, unrouted, reward) exactly. With a configured checkpoint, `ppo_projected` matches `src/backtesting/evaluation.py`'s projected PPO path within 1e-6. Under a scenario, results match the Stage 1F harness for that scenario. |
| A (`services/inference/tests/parity/`) | **Explicit state:** an explicit state equal to the replay values for a date gives results identical to replay on that date. Overriding one venue changes only that venue's inputs. The history rules and every 422 code. |
| A (`services/inference/tests/concurrency/`) | **Concurrency and isolation** (arch §6.4), on Windows and Linux. |
| A (`services/inference/tests/api/`) | **API:** schemas, defaults (no policy given → `waterfall`), the disabled-PPO path, regulatory rejection returning 200 (with `requested_usd = 0`, `allocations = []` and no `PARTIAL_COMPLETION`), determinism (same request → same body and `decision_id`), `405` with `Allow`, and that no Phase 1 file changes (hashes before and after). |
| A (`services/inference/tests/`) | **Golden hashes (required on Windows and Linux):** fixed inputs must produce identical artefact fingerprints, daily-state fingerprints and `decision_id`s on both platforms, including a CRLF checkout of the text artefacts. Until this passes on both, no cross-platform determinism is claimed (§1). |
| A (`services/inference/tests/`) | **Invariants and ranges:** an allocation that breaks the §2.8 invariant, or weights an infeasible or padding slot, returns `500 INTERNAL_ERROR` with no result. `STATE_OUTSIDE_TRAINING_RANGE` is raised in all three modes and never blocks a baseline policy. |
| A (`services/inference/tests/concurrency/`) | **Deadlines and workers:** a started task past its limit returns `504 ENGINE_TIMEOUT` and only its worker is replaced. A queued task past the 12 s deadline never runs (its code is pending, §5). `ENGINE_BUSY` while a worker is rebuilding. Workers start within `CBDC_ENGINE_STARTUP_TIMEOUT_S`. |
| B (`services/backend/test/` · `phase2-backend.yml`) | Mapping completeness (every engine field maps to an app field, unknown engine fields included), persistence round trip, error passthrough, timeout → 503, mock mode. **Also:**<br>• failed transactions: `failureCode` and `failure`, the null fields, `409 TRANSACTION_FAILED`;<br>• `POLICY_DISABLED` and 4xx message forwarding (capped at 500), the field-path mapping table, `NOT_READY` → `INFERENCE_UNAVAILABLE`, and `Retry-After` forwarding;<br>• strict request bodies, the 200-character `clientReference`, `policy: null` → 422, and 405 with `Allow`.<br>**Auth:** startup refusal in each forbidden configuration; 401 for missing, malformed or unknown tokens; 403 for a viewer requesting `ppoProjected`; `Authorization` never logged or persisted. |
| C (`services/web/test/` · `phase2-web.yml`) | Rendering from every fixture, including rejection, partial completion, the disabled experimental policy, an explicit state, a failed transaction (null fields, `failure`), 401, 403, 409 and 503 with `Retry-After`. Mandatory labels and the dev-auth banner present. Token absent from `localStorage`, URLs and the built bundle; cleared on 401 and sign-out. |
| D (`e2e/`, `infra/scripts/` · `phase2-integration.yml`) | Every fixture in `contracts/fixtures/` validates against `contracts/openapi/`, and `infra/scripts/check_contracts.py` applies the §2.8, §3.2 and §4 rules the schemas can't express. Lock drift and install checks on Linux and Windows, including the dependency checks of arch §7.2. Docker images build. The `infra/compose.yaml` `full` profile end to end: sign in → submit → route → persist → read back → explain. |

---

## 10. Open decisions (v0.4)

These are not decided. The contract text doesn't state a rule for them; the schemas either leave them out or accept every proposed form. Items marked **Pending** in the text above aren't listed here; each names the one person whose sign-off it needs.

| # | Question | Positions | Decides |
|---|---|---|---|
| Q1 | Does `api_version` enter `decision_id`? | No proposal yet | Ayush |
| Q2 | What does `engine_version` mean, when must it be bumped, and does it enter `decision_id`? | No proposal yet | Ayush |
| Q3 | App health when the database is `unavailable`: HTTP status and `status` value | **B, D:** 503 with `status: "unavailable"` (the backend can't save or list anything, so it isn't ready).<br>**C:** 200 with `status: "degraded"`, because the UI reads the body to name the failing component; add a separate readiness endpoint if needed. | Anvesh and Varshini (owner if they can't agree) |
| Q4 | How `details.errors[]` writes an error that isn't about one field | **B:** `field: ""`, always present.<br>**C:** omit `field`.<br>**D:** omit it for request-level errors, and `""` for an engine path that can't be mapped. | Anvesh and Varshini |
| Q5 | Error code for an explicit `history` of the wrong length | **A's v0.3 text, C and D:** `INVALID_STATE_VALUE` (kept for now).<br>**B:** `VALIDATION_ERROR`, a schema rule (`minItems`/`maxItems` 30), with `INVALID_STATE_VALUE` narrowed to value rules.<br>Note: the backend currently checks the length itself and returns `VALIDATION_ERROR` at the app, so the app and the engine disagree until this is settled. | Ayush (producer); Anvesh for the app side |
| Q6 | Is a domain 422's `details.field` (for example `state.date` on `DATE_IN_GAP_BUFFER`) forwarded to the app after path mapping? | **B:** forward only `details.errors[]`, drop everything else.<br>**C:** needs app paths for every passed-through engine error to show inline form errors.<br>Option: the engine reports domain fields in `details.errors[]`. The existing app passthrough fixture still forwards `details.field`. | Ayush, Anvesh, Varshini |
| Q7 | Should the app's non-`Decision` response schemas (meta, network, state, list, explanation and others) be open, or stay closed for fixture checks? Run-time tolerance is agreed in either case (§1). | **C:** open.<br>**B:** spoke only for `Decision`, which is now open.<br>**D:** fixture checks can stay strict either way. | Anvesh and Varshini |
| Q8 | Keep `include_semantic_context` in the v1 explain request, given `semantic_context` is always null? | Keeping it contradicts the strict-request rationale; removing it is a request change. | Ayush |
| Q9 | Is the 12 s end-to-end deadline configurable, and under which variable? | No proposal | Ayush |
| Q10 | Optional `details.cause: "NOT_READY"` on app `INFERENCE_UNAVAILABLE` | **C:** asked for it, if cheap.<br>**B:** forwards no other details. | Anvesh |
| Q11 | Dashboard: what `count` counts; which decisions the `mean*` fields average over; an optional field giving the `completionRate` denominator | **C:** asked for the denominator field. | Anvesh, Varshini (with Ayush's sign-off of §3.8) |
| Q12 | Non-`ok` values of the health checks `structured_data`, `daily_state` and `knowledge_base` (C10) | The draft schema uses `[ok, error]` | Ayush |
| Q13 | Are the illustrative fixtures' risk values right for 2022+ dates? Dev C reported a risk of 0.0 there and asked the fixtures to show `RISK_FALLBACK_USED`. | Not verified: it needs the Phase 1 data environment. | Ayush (engine-generated fixtures will settle it) |
| Q14 | Is `405` checked before or after authentication in the app? | No proposal. The fixtures send a token, so they don't depend on the answer. | Anvesh (Varshini informed) |
| Q15 | Does `/v1/state` also report `STATE_OUTSIDE_TRAINING_RANGE`? | No proposal | Ayush |
