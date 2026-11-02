# Major Phase 2 — API Contract

**Status:** v0.2 (2 November 2026), proposed for team approval through the Phase 2 pull request. This document is normative until `contracts/*.openapi.yaml` exists; after that the OpenAPI files are, and this document must be kept in sync with them.
**Architecture and roles:** `docs/PHASE2_ARCHITECTURE.md`. Section references written "arch §n" point there.

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

> **Example values in this document are illustrative.** They show the shape of each response, not real engine output. Dev A will replace the fixtures with engine-generated ones.

---

## 1. Shared conventions

- Content type: `application/json; charset=utf-8`. Money values are USD as JSON numbers (floats, as in Phase 1), never strings.
- Dates are `YYYY-MM-DD`. Timestamps are ISO 8601 UTC.
- Shares are fractions of the transaction amount in [0, 1].
- Every request may send an `X-Request-Id` header. If it is missing, the receiver generates one. It is echoed in the response header and in error bodies, and the backend forwards it to the inference service.
- Consumers ignore unknown fields. Producers only add optional fields within a version.
- **Determinism:** the same request against the same artefacts returns the same body *on the same platform and device*. Baseline results are identical across platforms. PPO values may differ in the last floating-point digits between CPU and CUDA, or between operating systems (see `provenance.device`). `decision_id` hashes the canonical request plus the artefact versions, never the outputs, so it is platform-independent.
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

- `status` is `ok` or `degraded`. It is `degraded` when `engine_workers` is `rebuilding` or `error`, for example after a failed integrity check (arch §6.2).
- `ppo_checkpoint` is `ok`, `disabled` (none approved or configured) or `error` (hash mismatch). A `disabled` checkpoint doesn't make the service `degraded`.
- HTTP 200 when `ready`, otherwise 503.

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
  "runtime": {"platform": "linux-x86_64", "python": "3.10.11", "torch": "2.13.0+cpu", "device": "cpu", "lock_file": "locks/inference-linux-x86_64-cpu.txt"}
}
```

When a checkpoint is enabled, `checkpoint` is `{"checkpoint_id": "...", "sha256": "<hex>", "approved_by": "...", "approved_on": "YYYY-MM-DD", "source_run": "outputs/experiments/..."}`.

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
- **Explicit venues** must list **exactly** the corridor's venues, each once, or the error is `STATE_VENUE_MISMATCH`.
- **Explicit values.** `liquidity_usd` ≥ 0 and `congestion` ≥ 0, both finite. Otherwise the error is `INVALID_STATE_VALUE`.
- **Explicit history**, when given, has exactly 30 finite, non-negative numbers per channel, and the last element equals the current value (within 1e-9 relative). Otherwise the error is `INVALID_STATE_VALUE`.
- **Fields that can't be set.** Explicit mode accepts **no** `fee`, `risk`, `baseline_cost_pct`, `data_source_tag` or extra venues. Unknown fields inside `state` are rejected with `VALIDATION_ERROR`, rather than ignored, so callers can't believe they set a value that had no effect.

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
- **Out-of-range values.** They are normalised with the frozen train-only statistics. Any value outside the venue's train-period min–max adds `STATE_OUTSIDE_TRAINING_RANGE`. PPO on such inputs is out of distribution and unvalidated.
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
    "client_reference": "optional, echoed back"
  },
  "state": {"mode": "historical_replay", "date": "2024-06-14"},
  "policy": "waterfall"
}
```

- `policy` is optional and defaults to `waterfall`.
- `amount_usd` must be > 0 and finite. Amounts above the $500K cap are **not** a validation error: they return 200 with `feasibility.allowed = false`, exactly as Phase 1 does.
- The transaction's `simulation_date` is `state.date` (replay and scenario modes) or `state.reference_date` (explicit mode).

**Response (`RouteResponse`)** — HTTP 200
```json
{
  "decision_id": "sha256:9f2c…",
  "policy": "waterfall",
  "policy_status": "default",
  "transaction": {"sender_country": "GBR", "receiver_country": "PHL", "amount_usd": 300000.0, "corridor": "GBR->PHL",
                  "simulation_date": "2024-06-14", "client_reference": null},
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
- `allocations`: one entry per feasible venue, sorted by `slot`.
  - `share_requested` is the policy's action for that slot.
  - `amount_requested_usd` = `share_requested × amount_usd`.
  - `amount_executed_usd` = min(requested, liquidity), from `CBDCLiquidityEnv.step()`.
  - `amount_clipped_usd` = requested − executed. Clipped amounts are never redistributed.
  - `share_before_projection` is the raw PPO share for `ppo_projected`, and null otherwise.
  - `risk` is the corridor risk, the same for every venue in the corridor.
- `totals`:
  - `unrouted_env_usd` = requested − executed (the environment's figure).
  - `unrouted_amount_based_usd` = amount − executed (Stage 1F's figure).
  - `completed` uses the Phase 1 rule: amount-based unrouted ≤ 1e-4 × amount (`RELATIVE_UNROUTED_TOLERANCE`).
  - `completion_ratio` = executed / amount.
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
| `STATE_OUTSIDE_TRAINING_RANGE` | An explicit or scenario value is outside the venue's train-period range |
| `RISK_FALLBACK_USED` | The risk proxy was unavailable, so the static placeholder was used |
| `COST_BASELINE_FALLBACK_USED` | No lagged RPW baseline exists, so the reward default was used |
| `SYNTHETIC_COST_ANCHOR` | Corridor ARE→MEX: the cost baseline uses the synthetic USA→MEX fallback |
| `PARTIAL_COMPLETION` | `completed` is false |

**Regulatory rejection:** HTTP 200, with `feasibility.allowed = false`, `reason` set to Phase 1's reason string, `decisive_fact_ids` filled, `allocations = []`, every executed amount 0 and `completed = false`.

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

### 2.10 `POST /v1/explain`

**Request:** the same body as `/v1/route`. The service recomputes the decision deterministically, and the response's `decision_id` must equal the one `/v1/route` returned. Optional: `"include_semantic_context": false`.

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
- `reason_code` values:
  - waterfall: `CHEAPEST_FILLED_TO_LIQUIDITY`, `NEXT_CHEAPEST_REMAINDER`, `FILLED_TO_LIQUIDITY`, `AMOUNT_EXHAUSTED`, `NO_LIQUIDITY`;
  - cheapest-feasible: `CHEAPEST_SELECTED`, `NOT_CHEAPEST`, `CLIPPED_AT_LIQUIDITY`;
  - PPO: `PPO_SHARE`, `PROJECTION_REDUCED_TO_CAPACITY`, `PROJECTION_INCREASED`;
  - any policy: `INFEASIBLE_REGULATORY`.
- For `ppo_projected`, `policy_notes` must state that shares come from a learned policy with no causal explanation, and that the capacity projection adjusted them. It also lists each slot's change from `share_before_projection`. **No made-up causal reasons for PPO's choices.**
- In explicit mode, `limitations` also states that liquidity and congestion were supplied by the user, and that risk and cost come from `reference_date`.
- `semantic_context` is null unless Cognee is enabled and `include_semantic_context` is true. When present, it contains only results grounded to known `fact_id`s. It never changes `feasibility`.

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
| `POST` | `/api/v1/comparisons` | Compare policies for one transaction; persisted | `/v1/compare` |
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
  "clientReference": "optional"
}
```

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
                  "simulationDate": "2024-06-14", "clientReference": null},
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
- `status` is `routed` when inference returned 200, including regulatory rejections, which show `feasibility.allowed = false`. It is `failed` otherwise.
- **If the inference service fails,** the backend persists the request with `status: "failed"`. It returns `502 INFERENCE_ERROR`, or `503 INFERENCE_UNAVAILABLE` / `ENGINE_BUSY` / `ENGINE_TIMEOUT`, with `"transactionId"` in `error.details`.
- **Engine validation errors (422)** are passed through with the same `code` and are not persisted.

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

### 3.4 `GET /api/v1/transactions/:id`

Returns the same body as the 201 response in §3.2. Unknown IDs return `404 NOT_FOUND`.

### 3.5 `GET /api/v1/transactions/:id/explanation`

Returns the camelCase mapping of the `/v1/explain` response, plus `"transactionId"`. The backend calls `/v1/explain` with the stored request, checks that the returned `decisionId` equals the stored one (otherwise `409 DECISION_MISMATCH`, which means the engine artefacts changed), and stores the result.

### 3.6 `POST /api/v1/comparisons`

The request is the same as §3.2, with `"policies": [...]` in place of `policy`. A viewer who includes `ppoProjected` gets `403 FORBIDDEN_POLICY`. If a viewer omits `policies`, the backend sends only the non-experimental policies. The response is HTTP 201 with `{"id", "createdAt", "createdBy", "transaction", "results": [decision…], "skipped": [...], "sameState": true, "note": "..."}`.

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

The aggregates are computed from stored decision fields only, never recomputed from allocations. The completion rate is the mean of the stored `completed` values.

### 3.9 `GET /api/v1/health`, `GET /api/v1/meta`

`health` (no auth):
```json
{"status": "ok", "database": "ok", "inference": "ok", "authMode": "dev", "time": "..."}
```
`status` is `ok` or `degraded`; `inference` is `ok`, `degraded`, `unavailable` or `mock`.

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

| HTTP | `code` | Raised by | When |
|---|---|---|---|
| 400 | `MALFORMED_REQUEST` | both | Invalid JSON |
| 401 | `UNAUTHENTICATED` | app | Missing, malformed or unknown token |
| 403 | `FORBIDDEN_POLICY` | app | A non-analyst requested `ppoProjected` |
| 404 | `NOT_FOUND` | both | Unknown resource |
| 409 | `DECISION_MISMATCH` | app | Recomputed `decision_id` differs from the stored one |
| 409 | `POLICY_DISABLED` | inference | `ppo_projected` requested but no approved checkpoint is enabled |
| 422 | `VALIDATION_ERROR` | both | Schema or type error, including unknown fields inside `state`; `details.errors[]` lists them |
| 422 | `UNSUPPORTED_CORRIDOR` | inference | Corridor not in the network |
| 422 | `INVALID_AMOUNT` | inference | Amount ≤ 0 or not finite |
| 422 | `DATE_OUT_OF_RANGE` | inference | Outside 2011-01-01 to 2025-09-30 |
| 422 | `DATE_IN_GAP_BUFFER` | inference | Within a gap buffer |
| 422 | `UNKNOWN_SCENARIO` | inference | `scenario_id` not defined |
| 422 | `STATE_VENUE_MISMATCH` | inference | Explicit venues don't match the corridor exactly |
| 422 | `INVALID_STATE_VALUE` | inference | Negative, NaN or infinite value; history of the wrong length; last history value ≠ current |
| 422 | `POLICY_UNAVAILABLE_FOR_STATE` | inference | `ppo_projected` in explicit mode without `history` on every venue |
| 500 | `INTERNAL_ERROR` | both | Unexpected failure, including a failed engine integrity check (no result is returned) |
| 502 | `INFERENCE_ERROR` | app | Inference returned 5xx or an invalid body |
| 503 | `INFERENCE_UNAVAILABLE` | app | Inference unreachable, or the backend's 15 s timeout elapsed |
| 503 | `ENGINE_BUSY` | inference (passed through by app) | Engine queue full (`CBDC_ENGINE_MAX_QUEUE`) |
| 503 | `NOT_READY` | inference | Required artefacts failed to load |
| 504 | `ENGINE_TIMEOUT` | inference (passed through by app) | Engine task exceeded `CBDC_ENGINE_TASK_TIMEOUT_S` |

A regulatory rejection is **not** an error (§2.8). `ENGINE_BUSY` and `NOT_READY` responses include a `Retry-After` header.

---

## 5. Inter-service behaviour

- **Backend → inference:** a 15 s timeout (the engine's own task timeout is 10 s). `POST` requests are never retried automatically; `GET` requests may retry once. `X-Request-Id` is forwarded. The `Authorization` header is never forwarded: the inference service has no auth.
- **Caching:** cached `GET` results (`version`, `network`, `calendar`, `scenarios`) are invalidated when `/v1/version` reports a different `git_commit`, `knowledge.sha256` or `checkpoint.sha256`.
- **Network exposure:** the inference service listens on the internal Compose network only and must not be published to the host in the `full` profile. For local debugging, Dev A may publish it on `127.0.0.1:8000`.

---

## 6. Persistence (backend)

### 6.1 Principles
- Store the full inference response verbatim (`engineResponse` JSON), plus the normalised columns needed for queries.
- Never store tokens, token hashes or other secrets in database records. Token hashes live only in `dev-tokens.json`.
- Records are append-only. Corrections create new records.

### 6.2 What is persisted
Each transaction request (including the full state spec, so explicit states can be replayed), its routing decision, each allocation row, comparisons, explanations and an audit log entry for every mutating call.

### 6.3 Prisma models (outline; Dev B finalises)

| Model | Key fields |
|---|---|
| `User` | `id`, `email`, `role` (`viewer`/`analyst`); seeded from `dev-tokens.json`, without the hashes |
| `TransactionRequest` | `id`, `createdAt`, `createdById`, `senderCountry`, `receiverCountry`, `corridor`, `amountUsd`, `stateMode`, `stateSpec` (JSON), `simulationDate`, `requestedPolicy`, `status`, `clientReference` |
| `RoutingDecision` | `id`, `transactionId`, `decisionId`, `policy`, `policyStatus`, `allowed`, `completed`, `completionRatio`, `executedUsd`, `unroutedEnvUsd`, `unroutedAmountBasedUsd`, `rewardEnv`, `rewardAmountBased`, `valuesProvenance`, `stateFrameSha256`, `checkpointSha256`, `knowledgeSha256`, `gitCommit`, `engineResponse` (JSON) |
| `Allocation` | `id`, `decisionId`, `slot`, `bridgeUid`, `shareRequested`, `amountRequestedUsd`, `amountExecutedUsd`, `amountClippedUsd`, `liquidityUsd`, `congestion`, `risk`, `shareBeforeProjection` |
| `Comparison` | `id`, `transactionId`, `createdById`, `policies`, `engineResponse` (JSON) |
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

---

## 8. Configuration (environment variables)

| Variable | Service | Default | Meaning |
|---|---|---|---|
| `CBDC_REPO_ROOT` | inference | `.` | Repository root; engine workers `chdir` here |
| `CBDC_PPO_CHECKPOINT_ID` | inference | unset | Entry in the approval registry; unset disables `ppo_projected` |
| `CBDC_DEVICE` | inference | `cpu` | `cpu` or `cuda` |
| `CBDC_ENGINE_WORKERS` | inference | `2` | Engine worker processes per server process |
| `CBDC_ENGINE_TASK_TIMEOUT_S` | inference | `10` | Per-task timeout; exceeding it recycles the pool |
| `CBDC_ENGINE_MAX_QUEUE` | inference | `32` | Waiting tasks before `ENGINE_BUSY` |
| `CBDC_ENABLE_COGNEE` | inference | `false` | Explanation-only semantic context (needs local Ollama and the `cognee` lock; see `docs/STAGE1E_MEMORY.md`) |
| `INFERENCE_URL` | backend | `http://inference:8000` | Inference base URL |
| `INFERENCE_MODE` | backend | `live` | `live` or `mock` |
| `INFERENCE_TIMEOUT_MS` | backend | `15000` | Inference request timeout |
| `AUTH_MODE` | backend | — (required) | Must be `dev`; anything else stops startup |
| `DEV_TOKENS_FILE` | backend | `./dev-tokens.json` | Git-ignored token-hash file |
| `DATABASE_URL` | backend | — | PostgreSQL URL, kept in `.env` (git-ignored), never committed |
| `VITE_API_MODE` | web | `live` | `live` or `mock` (MSW) |
| `VITE_PROXY_TARGET` | web (dev server only) | `http://localhost:4000` | Vite proxy target for `/api` |

No token, password or secret is ever put in a `VITE_*` variable: Vite embeds those values in the built bundle.

---

## 9. Contract tests (minimum)

| Owner | Test |
|---|---|
| A | **Parity:** on the Stage 1D validation split and one holdout, `route()` and `/v1/route` match `src/training/evaluate.py`'s waterfall and cheapest-feasible results for every row (action, executed, unrouted, reward) exactly. With a configured checkpoint, `ppo_projected` matches `src/backtesting/evaluation.py`'s projected PPO path within 1e-6. Under a scenario, results match the Stage 1F harness for that scenario. |
| A | **Explicit state:** an explicit state equal to the replay values for a date gives results identical to replay on that date. Overriding one venue changes only that venue's inputs. The history rules and every 422 code. |
| A | **Concurrency and isolation** (arch §6.4), on Windows and Linux. |
| A | **API:** schemas, defaults (no policy given → `waterfall`), the disabled-PPO path, regulatory rejection returning 200, determinism (same request → same body and `decision_id`), and that no Phase 1 file changes (hashes before and after). |
| B | Mapping completeness (every engine field maps to an app field), persistence round trip, error passthrough, timeout → 503, mock mode. **Auth:** startup refusal in each forbidden configuration; 401 for missing, malformed or unknown tokens; 403 for a viewer requesting `ppoProjected`; `Authorization` never logged or persisted. |
| C | Rendering from every fixture, including rejection, partial completion, the disabled experimental policy, an explicit state, 401 and 403. Mandatory labels and the dev-auth banner present. Token absent from `localStorage`, URLs and the built bundle; cleared on 401 and sign-out. |
| D | Every fixture validates against the OpenAPI specs. Lock drift and install checks on Linux and Windows. Docker images build. The `full` profile end to end: sign in → submit → route → persist → read back → explain. |
