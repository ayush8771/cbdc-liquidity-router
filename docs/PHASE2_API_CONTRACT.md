# Major Phase 2 — API Contract

**Status:** v0.4, revised on 4 November 2026 after the team reviews, proposed for a second team review. `docs/TEAM_REVIEW_RESOLUTION.md` lists what each review changed and what is still open. This document is normative until `contracts/openapi/inference.v1.yaml` and `contracts/openapi/app.v1.yaml` are approved and merged; after that the OpenAPI files are, and this document must be kept in sync with them.
**Architecture and roles:** `docs/PHASE2_ARCHITECTURE.md`. Section references written "arch §n" point there.

**How to read v0.4.** Rules without a marker are approved. Rules marked **proposed** need the named person's approval before they're implemented. A question that is still disputed or undecided is not stated as a rule: the text says it is open and points to §10, which gives each side's position and who decides.

**Revision after the team reviews (4 November 2026):**
- **Owner decisions applied** (Ayush):
  - `decision_id` includes `engine_version`, every output-affecting artefact and `id_scheme: 1`, and excludes `api_version` and `git_commit` (§2.11);
  - the request deadline is configurable, default 12 s, and independent of the 10 s worker execution timeout; a running task isn't killed when the caller's deadline passes (§5);
  - strict requests and closed responses in CI, in both APIs (§1);
  - `ready_workers` (§2.1);
  - wrong-length history is `VALIDATION_ERROR` (§2.4);
  - `include_semantic_context` removed (§2.10);
  - form-level errors omit `field`, and mapped engine field paths are forwarded (§4);
  - `details.cause: "NOT_READY"` (§4);
  - the `completionRate` formula (§3.8);
  - database-down readiness is a 503 with the Health body, and liveness is separate (§3.9);
  - the 0.0 risk fallback with `RISK_FALLBACK_USED` (§2.8);
  - no range warning from `/v1/state` (§2.4).
- **Review fixes:**
  - tightened app request validation, so failed records always match their schema (§3.2);
  - aligned `scenarioId` handling across `/state` and `POST` (§2.5, §3.7);
  - nullable dashboard window bounds;
  - the list query rules (§3.3);
  - comparison persistence confirmed (§3.6);
  - audit wording (§6.2);
  - unknown enum values handled at run time (§1).
- **Fixtures corrected:** risk fallback on every 2024-06-14 decision, a PPO-enabled meta fixture, a dashboard derived from the stored transactions, and new health and validation fixtures.

**Changes in v0.4:**
- **Errors (§4):**
  - new codes `METHOD_NOT_ALLOWED` (405, with `Allow`) and `TRANSACTION_FAILED` (409);
  - `POLICY_DISABLED` is passed through by the app;
  - `NOT_READY` maps to `503 INFERENCE_UNAVAILABLE` in the app;
  - `ENGINE_TIMEOUT` is 504 everywhere (the §3.2 wording is fixed);
  - `Retry-After` is forwarded;
  - rules for forwarding engine messages and for `details.errors[]`.
- **Requests are strict (§1).** Also: `clientReference` is at most 200 characters, `policy: null` is rejected, and an empty `venues` list returns `STATE_VENUE_MISMATCH`.
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
  - a 12 s request deadline and a 10 s worker execution timeout;
  - individual worker recycling;
  - `CBDC_ENGINE_STARTUP_TIMEOUT_S`.
- **Health (§3.9):** mock mode reports `ok`, and the `database` values are defined.
- **Other definitions:**
  - `completionRate` counts only routed, feasible decisions;
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
  - **Responses: closed in CI, tolerant at run time** (owner decision). Every OpenAPI response schema, in both APIs, is closed (`additionalProperties: false`), and the fixture and producer tests enforce that in CI, so an undocumented field is caught before it ships. At run time, a consumer ignores unknown response fields and never rejects a response because of one. Producers add only optional fields within a version, and must add them to the OpenAPI file first.
  - **Unknown enum values.** At run time, a consumer that meets an enum value it doesn't know treats it generically and doesn't fail. It shows an unknown warning `code` as a plain warning with its `message`, and handles an unknown error `code` by its HTTP status. CI still rejects undocumented values.
  - **Requests are strict.** Every request body object, at every level, in both APIs, accepts only the fields this contract defines. An unknown field returns `422 VALIDATION_ERROR`, so a misspelt field never silently falls back to its default. CI enforces this with closed request schemas. Query parameters are not request bodies; for app list and dashboard queries, see §3.3.
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
  "engine_pool": {"workers": 2, "ready_workers": 2, "queued": 0, "max_queue": 32, "rebuilds_since_start": 0},
  "time": "2026-11-02T10:00:00Z"
}
```

- `status` is `ok` or `degraded`. It is `degraded` when `engine_workers` is `rebuilding` or `error`.
  - `rebuilding` means at least one engine worker process is being replaced. A worker is replaced after a timeout, a crash or a failed integrity check (arch §6.2). Each worker is replaced on its own; the other workers keep serving.
  - Expect more `ENGINE_BUSY` responses while a worker is being replaced.
- `engine_pool`:
  - `workers` is the configured number of worker processes.
  - `rebuilds_since_start` counts individual worker replacements.
  - `ready_workers` (required) is the number of workers that have finished warming up and can take a task.
- `ppo_checkpoint` is `ok`, `disabled` (none approved or configured) or `error` (hash mismatch). A `disabled` checkpoint doesn't make the service `degraded`.
- `structured_data`, `daily_state` and `knowledge_base` are exactly `"ok"` or `"error"` (R5; Q12 closed).
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
    "macro_risk_proxy_sha256": "<hex>",
    "rpw_corridor_quarterly_sha256": "<hex>",
    "scenarios_sha256": "<hex>",
    "date_range": {"start": "2011-01-01", "end": "2025-09-30"}
  },
  "reward_weights": {"lambda_latency": 1.0, "lambda_risk": 1.0, "lambda_unrouted": 1.0, "status": "placeholder"},
  "runtime": {"platform": "linux-x86_64", "python": "3.10.11", "torch": "2.13.0+cpu", "device": "cpu", "lock_file": "services/inference/requirements/linux-x86_64-cpu.txt"}
}
```

When a checkpoint is enabled, `checkpoint` is `{"checkpoint_id": "...", "sha256": "<hex>", "approved_by": "...", "approved_on": "YYYY-MM-DD", "source_run": "outputs/experiments/..."}`.

- `source_run` is the directory containing the checkpoint file, for now. It is to be revisited when the first checkpoint is approved.
- `git_commit` is provenance only. It is read at build time, never hard-coded, and does **not** enter `decision_id` (§2.11).
- `engine_version` is the semantic version of the inference logic that can change routing outputs. It must be bumped whenever a code change can change any output for the same request and artefacts, and it enters `decision_id` (§2.11). A change that can't affect outputs, such as logging or error text, needn't bump it.
- `api_version` does **not** enter `decision_id`.
- The hashes in `knowledge` and `data` are computed as §2.11 describes. They include `macro_risk_proxy_sha256` (`data/processed/macro_risk_proxy.parquet`) and `rpw_corridor_quarterly_sha256` (`data/processed/rpw_corridor_quarterly.parquet`). Both are binary, so they are hashed as committed, and both enter `decision_id` (R4).
- `data.scenarios_sha256` is the SHA-256 of the RFC 8785 serialisation of the `scenarios` array that `/v1/scenarios` returns, **sorted by `scenario_id`** in ascending ordinal (code-point) order. It is therefore independent of the order in which scenarios are defined or inserted. It is a cache key (§5). It doesn't enter `decision_id`, because the scenario fields that affect a decision (`scenario_id` and its three multipliers) are hashed directly (§2.11).
- **Two knowledge hashes; don't mix them up.**
  - `knowledge.sha256` here, and `knowledge_sha256` in `decision_id`, is the **Phase 2 service hash**: SHA-256 of `data/knowledge/regulatory_facts.json` after CRLF→LF normalisation (§2.11). It is identical on Windows and Linux.
  - Phase 1's `KnowledgeBase.sha256` (`src/memory/knowledge.py`) is SHA-256 of the **raw file bytes**, so on a Windows CRLF checkout it differs from the committed blob. Phase 2 never reports or hashes the Phase 1 value; the service computes its own.
- **`engine_version` and imported Phase 1 constants.** The engine imports Phase 1 code whose constants affect routing outputs: for example `RELATIVE_UNROUTED_TOLERANCE`, `MEANINGFUL_ALLOCATION_THRESHOLD`, `DEFAULT_RISK_PLACEHOLDER`, the regime tolerance and the reward computation. They are not artefact files, so no fingerprint covers them. **`engine_version` must be bumped whenever any such imported value changes.** Phase 1 is frozen at `phase1-complete`, so that should only happen through an approved change, and the bump makes it visible in every `decision_id`.

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
- **Venue order doesn't matter.** The caller may list explicit venues in any order. Each venue's values are matched to its slot by `bridge_uid`. Execution, `allocations[].slot`, the PPO observation and the explanations always use Phase 1's `bridge_network` slot order for the corridor, whatever order the request uses. The ordinal `bridge_uid` sort in §2.11 applies to hashing only.
- **Unsafe integers.** An integer-valued number in `transaction` or `state` whose absolute value exceeds 2⁵³ − 1 (9007199254740991) returns `422 VALIDATION_ERROR`, with `details.errors[].field` giving its path. It is never rounded (§2.11).
- **Explicit values.** `liquidity_usd` ≥ 0 and `congestion` ≥ 0, both finite. Otherwise the error is `INVALID_STATE_VALUE`.
- **Explicit history**, when given, has exactly 30 numbers per channel (oldest first).
  - A wrong **length** is a schema rule (`minItems`/`maxItems` 30) and returns `VALIDATION_ERROR` in both APIs (owner decision).
  - The **value** rules return `INVALID_STATE_VALUE`: every value finite and non-negative, and the last element equal to the current value (within 1e-9 relative).
  - `history: null` and an omitted `history` mean the same thing.
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
  - **Where.** Only `/v1/route` and `/v1/compare` (each result) emit it, because the values checked depend on the policy. `/v1/state` never emits it (owner decision). So the bridge monitor can't show this warning before a transaction is routed.
- **No future dates.** No data exists after 2025-09-30. A "today" what-if must use explicit mode with a valid `reference_date`, and its cost and risk context come from that date.
- **"Historical" replay is synthetic.** It is the Phase 1 simulation conditioned on real lagged data, not observed bridge history.
- **No unseen dates for PPO.** Train dates trained the model, validation dates selected checkpoints, and test dates were examined in Phase 1. `provenance.split` is always reported, and `ppo_projected` on a train date adds `DATE_IN_TRAINING_SPLIT`.
- **Granularity:** state is daily, risk is monthly, and the cost baseline is quarterly and lagged by one quarter.
- **No liquidity carry-over.** Each transaction is independent, so routing one never reduces liquidity for the next (arch §9.3).
- **No mixing modes.** Explicit states can't be combined with scenarios in v1.

### 2.5 `GET /v1/state`

Query: `corridor=GBR->PHL&mode=historical_replay&date=2024-06-14`, or `&mode=scenario&scenario_id=...`, plus optional `include_history=true`. Explicit states are not looked up; they are what the caller already has.

- `scenario_id` is required with `mode=scenario`; it returns `VALIDATION_ERROR` if missing, and also if it is given with `historical_replay`.
- Any string passes the schema. An unknown value returns `UNKNOWN_SCENARIO`, exactly as on `/v1/route`, so both endpoints treat an unknown scenario the same way.
- `warnings` may contain `RISK_FALLBACK_USED`, when `corridor_risk` is the 0.0 fallback (§2.8). It never contains `STATE_OUTSIDE_TRAINING_RANGE` (§2.4).

```json
{
  "corridor": "GBR->PHL",
  "state": {"mode": "historical_replay", "date": "2024-06-14", "split": "test", "scenario_id": null},
  "corridor_risk": 0.0,
  "baseline_cost_pct": 0.0612,
  "venues": [
    {"slot": 0, "bridge_uid": "GBR->PHL#0", "fee_pct": 0.02, "liquidity_usd": 412345.6, "congestion": 0.31,
     "data_source_tag": "real_static_bridge", "values_provenance": "synthetic_simulation"}
  ],
  "warnings": [{"code": "RISK_FALLBACK_USED", "message": "The corridor risk proxy is unavailable for this date, so the static placeholder 0.0 is used."}]
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

`scenarios` is always sorted by `scenario_id`, in ascending ordinal (code-point) order, whatever the order of the Phase 1 definitions or of any dictionary they pass through. That is the same order `scenarios_sha256` hashes (§2.2).

`scenario_id` values are **unique**: each appears at most once in `scenarios`. A duplicate is an error in the service's scenario definitions, not something a client handles; the contract checker rejects a fixture that has one. Uniqueness also keeps the sorted order, and so `scenarios_sha256`, well defined.

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
- `client_reference` is optional: a string or null, echoed back unchanged. It is at most 200 characters, counted as Unicode code points (as JSON Schema `maxLength` counts them; the backend counts `[...s].length`, not `s.length`), the same limit as the Application API.
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
     "liquidity_usd": 412345.6, "congestion": 0.31, "risk": 0.0,
     "share_requested": 0.5, "amount_requested_usd": 150000.0, "amount_executed_usd": 150000.0, "amount_clipped_usd": 0.0,
     "share_before_projection": null},
    {"slot": 1, "bridge_uid": "GBR->PHL#1", "data_source_tag": "synthetic_bridge_expansion", "fee_pct": 0.014,
     "liquidity_usd": 150000.0, "congestion": 0.22, "risk": 0.0,
     "share_requested": 0.5, "amount_requested_usd": 150000.0, "amount_executed_usd": 150000.0, "amount_clipped_usd": 0.0,
     "share_before_projection": null},
    {"slot": 2, "bridge_uid": "GBR->PHL#2", "data_source_tag": "synthetic_bridge_expansion", "fee_pct": 0.03,
     "liquidity_usd": 85000.0, "congestion": 0.48, "risk": 0.0,
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
    "risk_term": 0.0,
    "unrouted_term_env": 0.0,
    "unrouted_term_amount_based": 0.0,
    "reward_env": -0.2208,
    "reward_amount_based": -0.2208,
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
  "warnings": [{"code": "RISK_FALLBACK_USED", "message": "The corridor risk proxy is unavailable for this date, so the static placeholder 0.0 is used."}]
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
- `metrics` (confirmed by Ayush): **always present, with every field non-null**, including on a regulatory rejection.
  - `fee_cost_usd` = Σ `allocations[].amount_executed_usd × fee_pct`. It uses executed amounts only (never requested or clipped amounts), and `fee_pct` exactly as the bridge network defines it: a fraction, so 0.015 means 1.5% (§2.3).
  - `baseline_cost_pct` is the value Phase 1's lagged RPW lookup returns, **unchanged**: no conversion is applied. Its unit is an open Phase 1 finding (F1, §10, `docs/TEAM_REVIEW_RESOLUTION.md` §14). The `0.0612` in the example is illustrative.
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
| `RISK_FALLBACK_USED` | The corridor risk proxy is missing or NaN for the date's month, so Phase 1's static placeholder `0.0` (`DEFAULT_RISK_PLACEHOLDER`) is used, as Phase 1 does. Every venue's `risk` is then 0.0. The warning is emitted **only when that fallback actually happens**. A risk of 0.0 alone doesn't imply it, and a regulatory rejection, which does no risk lookup, never carries it. Example: in June 2024 the proxy is NaN for PHL, USA and ARE, so all three corridors fall back. |
| `COST_BASELINE_FALLBACK_USED` | No lagged RPW baseline exists, so the reward default was used |
| `SYNTHETIC_COST_ANCHOR` | Corridor ARE→MEX: the cost baseline uses the synthetic USA→MEX fallback |
| `PARTIAL_COMPLETION` | `completed` is false **and** `feasibility.allowed` is true. A regulatory rejection never carries it (C14). |

**Regulatory rejection:** HTTP 200, with:
- `feasibility.allowed = false`, `reason` set to Phase 1's reason string, and `decisive_fact_ids` filled;
- `allocations = []`;
- in `totals`: `requested_usd = 0`, **`executed_usd = 0`**, **`completion_ratio = 0`** and `completed = false`;
- the full `metrics` object (confirmed by Ayush), separate from `totals`:
  - **`fee_cost_usd = 0`**;
  - every execution-related cost is 0: `cost_term`, `latency_term`, `risk_term`;
  - **the two unrouted figures differ, deliberately** (confirmed by Ayush). Both are always present and non-null:
    - `unrouted_amount_based_usd` = the full amount the caller asked to route (`amount_usd`), because nothing was executed. So `unrouted_term_amount_based = 1` and `reward_amount_based = −λ_unrouted`.
    - `unrouted_env_usd` = **0**, because it is requested − executed and `requested_usd = 0`. So `unrouted_term_env = 0` and `reward_env = 0`. This preserves the Phase 1 environment's accounting unchanged;
- no `PARTIAL_COMPLETION` warning;
- no `RISK_FALLBACK_USED`: a rejection does no risk lookup, and the warning appears only when the fallback was actually used.

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

Each result's `decision_id` is computed for that one policy (§2.11), never over the `policies` list. It therefore equals the `decision_id` that `/v1/route` returns for the same transaction, state and policy.

### 2.10 `POST /v1/explain`

**Request:** the same body as `/v1/route`. The service recomputes the decision deterministically, and the response's `decision_id` must equal the one `/v1/route` returned. `include_semantic_context` is **removed** from v1 (owner decision): `semantic_context` is always null, so the flag could have no effect, and the strict request rule (§1) rejects it with `VALIDATION_ERROR`.

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

`decision_id` identifies a decision's *inputs*, not its outputs. It is `"sha256:"` followed by the lowercase hex SHA-256 of a canonical JSON document. The backend treats it as an opaque string: it stores it and compares it by exact equality, and **never computes, recalculates or parses it** (confirmed by Ayush). Producing it is Dev A's inference responsibility (§9.1 A-1).

**Approved rules:**
- **Canonical form.** The document is serialised with RFC 8785, the JSON Canonicalization Scheme (JCS), and hashed as UTF-8 bytes. The implementation uses the pinned, pure-Python `rfc8785` package (arch §7.2).
- **Excluded:** `git_commit` (provenance only, §2.2), and every output field.
- **Text artefacts.** Artefact hashes of text files (CSV, JSON) are computed after converting CRLF line endings to LF. A Windows checkout made with `core.autocrlf=true` therefore hashes the same as the committed blob. Binary files are hashed as they are. No `.gitattributes` rule is added for `data/`.
- **Daily-state fingerprint** (`daily_state_sha256`, `state_frame_sha256`; owner-confirmed, scheme 1). For a frame `F`:
  1. **Descriptor.** A JSON object with exactly these members:
     - `"scheme": 1`;
     - `"columns"`: one `{"name": str(column), "dtype": str(F[column].dtype)}` per column, in column order;
     - `"index"`: `{"names": [each level's name, or null], "dtypes": [str(dtype) of each level]}`;
     - `"row_count"`: `len(F)`;
     - `"pandas_version": "2.3.3"`;
     - `"hashing": {"function": "pandas.util.hash_pandas_object", "index": true, "categorize": false, "hash_key": "0123456789123456", "row_hash_dtype": "<u8"}`.

     It is serialised with RFC 8785 and encoded as UTF-8: `schema_bytes`.
  2. **Row hashes.** With **pandas 2.3.3**: `pandas.util.hash_pandas_object(F, index=True, categorize=False, hash_key="0123456789123456")`. That is one `uint64` per row, **index included**. They are converted with `.to_numpy().astype("<u8")` (explicitly little-endian) and concatenated: `row_bytes`.
  3. **Combine.** SHA-256 of `DOMAIN || u64le(len(schema_bytes)) || schema_bytes || u64le(len(row_bytes)) || row_bytes`.
     - `DOMAIN` is the ASCII bytes `cbdc-liquidity-router/daily-state-fingerprint/v1`.
     - `u64le(n)` is `n` as 8 bytes, little-endian.
     - The result is lowercase hex.
  4. **Pinning.** Any other pandas version is an error, not a silent difference. A change to any of these rules needs a new scheme number.
  5. **Golden vector.** `contracts/test-vectors/daily_state_fingerprint.v1.json` records a fixed DataFrame with its descriptor and fingerprint. The contract checker verifies it on Windows and Ubuntu CI, and Dev A's implementation must reproduce it (§9.1). The checker's tests also show that index values, column order, dtypes, column names, row count and values each change the fingerprint.

**The canonical document (`id_scheme` 1)** (owner decision, A1/R3). It is a JSON object with exactly these members. Every member is always present, so `null` is written out, never omitted:

| Member | Value |
|---|---|
| `id_scheme` | `1` |
| `engine_version` | The `/v1/version` `engine_version` string (§2.2) |
| `transaction` | `{"sender_country", "receiver_country", "amount_usd"}`. `amount_usd` is the normalised binary64 value (see below), so `300000` and `300000.0` both serialise as `300000` |
| `state` | Replay: `{"mode": "historical_replay", "date"}`. Scenario: `{"mode": "scenario", "date", "scenario_id"}`. Explicit: `{"mode": "explicit", "reference_date", "venues"}`, with each venue `{"bridge_uid", "liquidity_usd", "congestion", "history"}`. `history` is `{"liquidity_usd": [30], "congestion": [30]}` or `null`; an omitted history is written as `null`. `venues` are sorted by `bridge_uid` in ascending **ordinal** (Unicode code-point) order: no natural or locale-aware sorting, so `#10` sorts before `#2`. This sort is for hashing only (see "Venue order" below) |
| `policy` | The one policy, after defaulting (`waterfall` when omitted). In `/v1/compare`, each result's own policy; never the `policies` list |
| `scenario` | Scenario mode: `{"scenario_id", "liquidity_multiplier", "congestion_multiplier", "cheapest_venue_liquidity_multiplier"}`, as `/v1/scenarios` defines them. The `description` is excluded. Other modes: `null` |
| `reward_weights` | `{"lambda_latency", "lambda_risk", "lambda_unrouted"}`. The `status` label is excluded |
| `artefacts` | `{"knowledge_sha256", "daily_state_sha256", "bridge_network_sha256", "normalization_stats_sha256", "macro_risk_proxy_sha256", "rpw_corridor_quarterly_sha256"}`: exactly the fingerprints `/v1/version` reports (§2.2) |
| `checkpoint_sha256` | For `ppo_projected`: the enabled checkpoint's SHA-256. A `ppo_projected` request without one is `POLICY_DISABLED` and gets no ID. For every other policy: `null`, so a checkpoint change never changes a baseline ID |

- **Numeric normalisation** (owner-confirmed). During request validation, every finite number in `transaction` and `state` (amount, liquidity, congestion, history values) is converted to an IEEE 754 **binary64** value.
  - **Unsafe integers are rejected, never rounded** (owner decision). If the value is integer-valued and its absolute value exceeds 2⁵³ − 1 (9007199254740991), the request fails with `422 VALIDATION_ERROR`, and `details.errors[].field` is the value's path in the request, for example `transaction.amount_usd` or `state.venues[1].liquidity_usd` (the venue's position as sent).
    - The rule depends on the **value**, not its spelling. `9007199254740993`, `9007199254740992.0`, `9.007199254740992e15` and `1e21` are all rejected. This matters because a JSON parser such as the backend's `JSON.parse` doesn't preserve whether a number was written as an integer, so a token-based rule could make the app and the engine disagree.
    - Every binary64 value at or above 2⁵³ is integer-valued, so in practice this rejects any magnitude above 2⁵³ − 1.
    - Both APIs apply it: the backend before calling inference, using the app path (`amountUsd`, `state.venues[1].liquidityUsd`), and the inference service.
  - **Execution and hashing use the identical normalised values.** There is no separate "hash form", so a request can't hash one value and route with another.
  - Non-finite values can't occur: JSON has no NaN or Infinity, and validation rejects anything that overflows.
  - Numerically equal safe inputs therefore give the same ID: `300000` = `300000.0`, `1.5e-7` = `0.00000015`, `0` = `-0.0`, and `9007199254740991` = `9007199254740991.0`. The checker tests cover these, and rejection of unsafe values in each spelling.
- **Venue order** (owner decision). The ordinal `bridge_uid` sort of `state.venues` above is used **only to build this document**. It never changes how the request is executed: execution, `allocations[].slot`, the PPO observation and the explanations keep Phase 1's `bridge_network` slot order for the corridor, matching each request venue to its slot by `bridge_uid` (§2.4). So reordering an explicit request's venues gives the same `decision_id` **and** identical allocations by slot. The checker verifies the slot order against `/v1/network`, and a test reorders a fixture's venues.
- **Serialisation and hash.** The document is serialised with RFC 8785 (JCS: sorted keys, no whitespace, ECMAScript number formatting) and hashed as UTF-8 bytes. `decision_id` = `"sha256:"` + the lowercase hex SHA-256.
- **Never hashed:** `api_version`, `git_commit`, `client_reference`, the scenario `description`, the reward-weight `status`, `request_id`, `device`, `platform`, and every output field.
- **A new input means a new scheme.** Adding or removing a member, or changing how one is written, requires `id_scheme` 2. Any other change that can alter outputs must bump `engine_version`.
- **Test vectors.** `contracts/test-vectors/decision_id.v1.json` holds exact canonical strings and IDs:
  - for replay, scenario, compare and explicit modes;
  - two equivalence pairs: `300000` vs `300000.0`, and a null vs missing `history` with venues reordered;
  - a baseline that ignores a supplied checkpoint.

  The contract checker rebuilds each document from its inputs and verifies the string and the hash. Its tests show that changing any hashed member changes the ID, and changing an excluded one doesn't. Dev A's implementation must reproduce every vector byte for byte, on Windows and Linux (§9.1).

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
| `GET` | `/api/v1/health` | Readiness: backend, database and inference status (no auth) | `/v1/health` |
| `GET` | `/api/v1/health/live` | Liveness: the process is running (no auth, §3.9) | — |
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
- `senderCountry` and `receiverCountry` must be three upper-case letters, or the backend returns `422 VALIDATION_ERROR`. `amountUsd` must be greater than 0, or the backend returns **`422 INVALID_AMOUNT`**: the code is preserved for zero or negative amounts (owner decision), not turned into `VALIDATION_ERROR`. Both checks run before inference is called, and nothing is saved.
- **Precedence** (approved): the backend first collects **every** schema problem (country codes, types, unknown fields, `policy: null`, history length, the `clientReference` limit) and returns them together as one `422 VALIDATION_ERROR` with `details.errors[]`. It returns `422 INVALID_AMOUNT` **only** when the body is otherwise valid. A body with a bad country code and a zero amount therefore gets `VALIDATION_ERROR`, listing the country problem and not the amount (fixture `app/errors/422_validation_error_precedence.json`).
  - This is the chosen fix for a frontend review finding: a request that inference never validated (because it was unavailable) is still saved as a failed record, and that record must match the response schema (`CountryCode`, positive `amountUsd`).
  - So the backend's checks are tightened, rather than the failed-record schema relaxed. `INVALID_AMOUNT` is therefore raised by the backend itself (§4), with `details.field: "amountUsd"`.
  - Whether a valid-shaped but unsupported corridor (e.g. `FRA->DEU`) is also checked by the backend is not required: a failed record keeps `corridor: null` in that case.
- `explicit` history arrays must have exactly 30 numbers each, or the backend returns `VALIDATION_ERROR`, the same code inference uses (§2.4).
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
       "liquidityUsd": 412345.6, "congestion": 0.31, "risk": 0.0, "shareRequested": 0.5,
       "amountRequestedUsd": 150000.0, "amountExecutedUsd": 150000.0, "amountClippedUsd": 0.0, "shareBeforeProjection": null}
    ],
    "totals": {"amountUsd": 300000.0, "requestedUsd": 300000.0, "executedUsd": 300000.0, "unroutedEnvUsd": 0.0,
               "unroutedAmountBasedUsd": 0.0, "completionRatio": 1.0, "completed": true, "bridgesUsed": 2},
    "metrics": {"feeCostUsd": 5100.0, "baselineCostPct": 0.0612, "costTerm": 0.0442, "latencyTerm": 0.265, "riskTerm": 0.0,
                "unroutedTermEnv": 0.0, "unroutedTermAmountBased": 0.0, "rewardEnv": -0.2208, "rewardAmountBased": -0.2208,
                "rewardWeights": {"lambdaLatency": 1.0, "lambdaRisk": 1.0, "lambdaUnrouted": 1.0, "status": "placeholder"}},
    "diagnostics": {"regime": "splitting_needed", "combinedLiquidityUsd": 647345.6, "projectionApplied": false},
    "provenance": {"stateMode": "historicalReplay", "stateDate": "2024-06-14", "split": "test", "scenarioId": null,
                   "valuesProvenance": "synthetic_simulation", "engineVersion": "0.1.0", "gitCommit": "bc9905e",
                   "knowledgeSha256": "<hex>", "dailyStateSha256": "<hex>", "stateFrameSha256": "<hex>",
                   "checkpoint": null, "device": "cpu", "platform": "linux-x86_64"},
    "warnings": [{"code": "RISK_FALLBACK_USED", "message": "The corridor risk proxy is unavailable for this date, so the static placeholder 0.0 is used."}]
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
  | `503 NOT_READY` | `503 INFERENCE_UNAVAILABLE`, with `Retry-After` forwarded and `details.cause: "NOT_READY"` |
  | `503 ENGINE_BUSY`, including a request whose deadline expired while queued (§5) | `503 ENGINE_BUSY`, with `Retry-After` forwarded |
  | `504 ENGINE_TIMEOUT`: the deadline expired while the task was running (§5) | `504 ENGINE_TIMEOUT` |

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
     "executedUsd": 300000.0, "rewardAmountBased": -0.2208}
  ],
  "page": 1, "pageSize": 20, "total": 1
}
```

For a `failed` transaction, the fields that come from a decision are null: `corridor`, `policyStatus`, `allowed`, `completed`, `completionRatio`, `executedUsd` and `rewardAmountBased`. `policy` is the requested policy.

Query rules (they match the backend's implementation, `services/backend/src/routes/transactions.ts`):
- `from` is inclusive and `to` is exclusive, both on `createdAt`, as full ISO 8601 UTC timestamps. `from` must not be later than `to`.
- `sort` accepts only `createdAt:desc`, the default.
- `completed=true|false` matches only transactions with a decision, so never a failed row.
- `corridor` matches the stored corridor, so it never matches a failed row, whose corridor is null.
- `policy` matches the requested policy, so failed rows are included.
- A documented parameter given twice is a `VALIDATION_ERROR`. Unknown query parameters are ignored: the strict rule in §1 covers request bodies, not queries.
- There is no `status` filter in v1.
- Every problem returns `422 VALIDATION_ERROR` with `details.errors[]`, all at once.

### 3.4 `GET /api/v1/transactions/:id`

Returns the same body as the 201 response in §3.2. That includes failed transactions, with `status: "failed"`, `decision: null`, `transaction.corridor: null` and `failure` set. Unknown IDs return `404 NOT_FOUND`. What a non-UUID `:id` returns (404 or 422) is not yet defined (§10, Q11a).

### 3.5 `GET /api/v1/transactions/:id/explanation`

Returns the camelCase mapping of the `/v1/explain` response, plus `"transactionId"`. The backend calls `/v1/explain` with the stored request, checks that the returned `decisionId` equals the stored one (otherwise `409 DECISION_MISMATCH`, which means the engine artefacts changed), and stores the result.

- **Failed transaction.** If the transaction's `status` is `failed`, the backend returns `409 TRANSACTION_FAILED` without calling inference, and stores nothing. A 404 would wrongly say the transaction doesn't exist, and `DECISION_MISMATCH` means something else.
- **Stored `ppoProjected` decisions** (owner decision, Q17). The rules apply in this order:
  1. If the decision already has a stored explanation, return it (200). Nothing is recomputed.
  2. Otherwise, if no checkpoint is enabled now, return `409 POLICY_DISABLED`.
  3. Otherwise, if the enabled checkpoint's SHA-256 differs from the decision's stored `checkpointSha256`, return `409 DECISION_MISMATCH`.
  4. Otherwise call `/v1/explain`, which uses the same checkpoint, and check the `decisionId` as above.

  The backend makes checks 2 and 3 from the cached `/v1/version` `checkpoint` before calling inference, so a decision is **never recomputed with another checkpoint**. If inference itself answers `409 POLICY_DISABLED` (the checkpoint was disabled after the cache was read), it is passed through. Nothing is stored in any of these error cases.
- **Other errors.** Inference failures map as in §3.2, but nothing is persisted.

### 3.6 `POST /api/v1/comparisons`

The request is the same as §3.2, with `"policies": [...]` in place of `policy`. It is strict in the same way, and `policies: null` is rejected. A viewer who includes `ppoProjected` gets `403 FORBIDDEN_POLICY`. If a viewer omits `policies`, the backend sends only the non-experimental policies. A disabled policy is reported in `skipped`, never as an error. The response is HTTP 201 with `{"id", "createdAt", "createdBy", "transaction", "results": [decision…], "skipped": [...], "sameState": true, "note": "..."}`.

**A comparison is an independent record.**
- It creates no transaction record, has no `transactionId`, and never appears in `GET /api/v1/transactions` or the dashboard.
- It stores its own transaction fields, the state spec, the policy list sent to the engine, its creator and the verbatim `/v1/compare` response (§6.3).
- `transaction.corridor` is null only if every policy was skipped. In that case no result confirms the corridor, and it is not derived.
- A comparison is persisted **only** when `/v1/compare` returns 200, including a 200 in which some or all policies are skipped. On any error nothing is saved, and the §3.2 error is returned with no `transactionId` (confirmed by Dev B).
- Not yet defined (§10, Q18):
  - which list the backend sends when an **analyst** omits `policies`;
  - the order of `results`;
  - whether the record echoes `state` and `policies`. Both are stored, but not returned.

### 3.7 `GET /api/v1/state`

Query: `corridor`, `mode` (`historicalReplay` or `scenario`), `date`, `scenarioId`, `includeHistory`. It returns the camelCase mapping of §2.5.

- `scenarioId` follows the §2.5 rules. It is required with `scenario`, and a `VALIDATION_ERROR` with `historicalReplay`.
- Any string passes the app schema, and an unknown value is passed through as `UNKNOWN_SCENARIO`, the same as on `POST /transactions`. (The v0.4 draft schema used a closed enum here, which made the two endpoints disagree.)

### 3.8 `GET /api/v1/dashboard/summary`

Query: `from`, `to`, `corridor`, `policy`.

```json
{
  "window": {"from": "2026-11-01T00:00:00Z", "to": "2026-11-02T23:59:59Z"},
  "totals": {"transactions": 7, "routed": 6, "failed": 1, "rejectedByFeasibility": 1},
  "byPolicy": [
    {"policy": "waterfall", "count": 5, "allowedRouted": 3, "completionRate": 0.666667,
     "meanRewardAmountBased": -0.251407, "meanFeeCostPct": 1.563333, "meanLatencyTerm": 0.257083, "meanRiskTerm": 0.0}
  ],
  "byCorridor": [{"corridor": "GBR->PHL", "routed": 5, "allowedRouted": 4, "completionRate": 0.5}],
  "note": "Aggregates of independent what-if decisions on synthetic states, under placeholder reward weights. Transactions do not consume liquidity. Not a backtest."
}
```

The aggregates are computed from stored decision fields only, never recomputed from allocations. Comparisons are not included (§3.6).

- `totals.failed` counts transactions with `status: "failed"`. `totals.rejectedByFeasibility` counts routed decisions with `allowed = false`.
- **`completionRate`** (owner decision) = completed allowed routed decisions ÷ all allowed routed decisions. Rejected and failed transactions are excluded from both, and counted separately in `totals`. It is **null** when the denominator is zero. The same rule applies in `byPolicy` and `byCorridor`.
  - This changes the v0.3 definition (the mean of every stored `completed` value, under which a rejection pulled the rate down). The change is deliberate and documented here, not silent.
- **Window** (owner decision, A3): an omitted `from` or `to` means that side is **unbounded**: no lower or upper limit on `createdAt`. `window.from` and `window.to` echo the query, and are **null** for an omitted bound. `from` is inclusive and `to` exclusive, as in §3.3.
- **Groups and denominators** (owner decision):
  - `byPolicy` groups by the requested policy. `count` is every transaction with that policy, failed and rejected included.
  - `allowedRouted` is the number of routed decisions with `allowed = true`: the denominator of `completionRate` and of every mean.
  - `byCorridor` covers routed transactions only, because a failed row has no corridor. `byCorridor.count` is **renamed `routed`**: the routed decisions on that corridor. It also has `allowedRouted` and `completionRate`.
- **Means** (owner decision): `meanRewardAmountBased`, `meanLatencyTerm` and `meanRiskTerm` average over the allowed routed decisions, and are **null** when `allowedRouted` is 0.
- **`meanFeeCostPct`** (owner decision) = **100 × AVG(`feeCostUsd` / `executedUsd`)** over the allowed routed decisions with `executedUsd > 0`, and null when there are none. It is a percentage: 1.4 means 1.4 %.
  - **Dependency:** the backend has no `feeCostUsd` column today. Dev B must add it to `RoutingDecision` with a Prisma migration, copied from `metrics.fee_cost_usd`.
  - That migration is **not part of this contracts change** and has not been made. Until it lands, the backend can't compute this field from stored columns.
- The dashboard fixture is derived from the stored transactions and their records. The checker recomputes `allowedRouted`, `routed`, `completionRate`, every mean and `meanFeeCostPct` from them.

### 3.9 `GET /api/v1/health`, `GET /api/v1/meta`

`health` (no auth):
```json
{"status": "ok", "database": "ok", "inference": "ok", "authMode": "dev", "time": "..."}
```
- `database` is `ok` or `unavailable`.
- `inference` is `ok`, `degraded`, `unavailable` or `mock`. `mock` means `INFERENCE_MODE=mock`, and inference is not called.
- **`/api/v1/health` is the readiness check** (owner decision):
  - database `unavailable` → HTTP **503**, `status: "unavailable"`;
  - database `ok` and `inference` `ok` or `mock` → HTTP 200, `status: "ok"`. Mock mode is a deliberate configuration, not a fault.
  - database `ok` and `inference` `degraded` or `unavailable` → HTTP 200, `status: "degraded"`.
- **The 503 body is the `Health` object, not the §4 error envelope.** Its component fields name what failed (`"database": "unavailable"`), so the UI can still say which component is down.
- **Liveness is separate.** Liveness asks only whether the backend process is running, and checks no dependency. It stays 200 while the database or inference is down, so a container orchestrator doesn't restart the backend for a database outage.
  - `GET /api/v1/health/live` (approved by the owner) is public, with no auth, and returns HTTP 200 with exactly `{"status": "ok"}`, no other field, while the process can serve HTTP. It checks no dependency: not the database, not inference. The path and body are final.
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
  - **An error that is about no single field omits `field`** (owner decision). There is one representation, and no empty-string marker. Consumers treat a missing `field` as a form-level error.
- Other 422 codes may set `details.field` with the same path syntax, omitted when there is no single field.
- A failed `POST /api/v1/transactions` sets `details.transactionId` (§3.2).
- An app `503 INFERENCE_UNAVAILABLE` caused by inference `NOT_READY` sets the optional `details.cause: "NOT_READY"` (owner decision), so the UI can say "starting up". It is absent for other causes.
- **Engine messages** (owner decision). An engine 4xx `message` never exposes internal filesystem paths, exception representations or internal configuration values. Sanitised values the caller supplied may be echoed.

**How the backend passes inference errors on** (owner decision: mapped field paths are forwarded through an explicit table):
- **Field paths.** Engine paths are mapped to app paths with an explicit table, not a generic camelCase conversion. For example, `transaction.amount_usd` becomes the top-level `amountUsd`, and `state.venues[1].history.liquidity_usd` becomes `state.venues[1].history.liquidityUsd`. The app keeps the shapes the engine used, so no new envelope is invented:
  - an engine `VALIDATION_ERROR`'s `details.errors[]` is forwarded as app `details.errors[]`, with every `field` mapped;
  - a domain 422's `details.field` (for example `state.date` on `DATE_IN_GAP_BUFFER`) is forwarded as app `details.field`, mapped.
  - A path the table can't map is dropped, so the item becomes a form-level error with no `field`. A raw engine path never reaches the app.
- **Everything else in engine `details` is dropped.**
- **Message** (approved, Q16 closed). Every app error `message` is the **backend's fixed text for its code**, for passed-through 4xx codes as much as for 5xx and stored failures. **Engine messages are never forwarded.** Consumers key their behaviour on `code`, never on `message`. The checker rejects an app passthrough fixture that copies the engine's message.
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
| 422 | `VALIDATION_ERROR` | both | Schema or type error, including any unknown request field (§1), `policy: null`, explicit `history` of the wrong length, and an integer-valued number outside ±(2⁵³ − 1) in `transaction` or `state` (§2.11). `details.errors[]` lists them. |
| 422 | `UNSUPPORTED_CORRIDOR` | inference | Corridor not in the network |
| 422 | `INVALID_AMOUNT` | both | Amount ≤ 0 or not finite. The app raises it itself for `amountUsd` ≤ 0 (§3.2). |
| 422 | `DATE_OUT_OF_RANGE` | inference | Outside 2011-01-01 to 2025-09-30 |
| 422 | `DATE_IN_GAP_BUFFER` | inference | Within a gap buffer |
| 422 | `UNKNOWN_SCENARIO` | inference | `scenario_id` not defined |
| 422 | `STATE_VENUE_MISMATCH` | inference | Explicit venues don't match the corridor exactly, including an empty list |
| 422 | `INVALID_STATE_VALUE` | inference | Value rules only: a negative, NaN or infinite value, or a last history value ≠ the current one. A wrong history length is `VALIDATION_ERROR`. |
| 422 | `POLICY_UNAVAILABLE_FOR_STATE` | inference | `ppo_projected` in explicit mode without `history` on every venue |
| 500 | `INTERNAL_ERROR` | both | Unexpected failure, with no result returned. Includes a failed engine integrity check and a failed allocation invariant (§2.8). |
| 502 | `INFERENCE_ERROR` | app | Inference returned a 5xx other than `NOT_READY`, `ENGINE_BUSY` or `ENGINE_TIMEOUT`, or an invalid body |
| 503 | `INFERENCE_UNAVAILABLE` | app | Inference unreachable, the backend's 15 s timeout elapsed, or inference returned `NOT_READY` |
| 503 | `ENGINE_BUSY` | inference (passed through by app) | Engine queue full (`CBDC_ENGINE_MAX_QUEUE`), or the request's deadline expired while it was still queued (§5). It never ran, so a retry is safe. |
| 503 | `NOT_READY` | inference (app maps it to `INFERENCE_UNAVAILABLE` with `details.cause: "NOT_READY"`) | No engine worker is ready yet, or required artefacts failed to load |
| 504 | `ENGINE_TIMEOUT` | inference (passed through by app) | The request's deadline expired while its task was **running** (§5). The worker is not killed for that. |

A regulatory rejection is **not** an error (§2.8). `ENGINE_BUSY` and `NOT_READY` responses include a `Retry-After` header in integer seconds. The app forwards it (see above).

The optional `details.cause: "NOT_READY"` is described above.

---

## 5. Inter-service behaviour

- **Backend → inference:** a 15 s timeout (`INFERENCE_TIMEOUT_MS`). `POST` requests are never retried automatically; `GET` requests may retry once. `X-Request-Id` is forwarded. The `Authorization` header is never forwarded: the inference service has no auth.
- **Engine deadlines** (owner decision). Two limits apply, independently.
  - **Request deadline:** configurable, default **12 s**, counted from when the inference service accepts the request. Set with `CBDC_ENGINE_REQUEST_DEADLINE_S` (owner decision, §8).
    - If it expires while the request is still **queued**, the task is removed without running and the request fails with `503 ENGINE_BUSY` and `Retry-After`.
    - If it expires while the task is **running**, the request fails with `504 ENGINE_TIMEOUT`. The worker is **not** killed because the caller's deadline passed: the task runs on, its result is discarded, and the worker then takes the next task.
  - **Minimum start budget** (owner decision, A2).
    - A worker takes a queued task only if at least `CBDC_ENGINE_MIN_START_BUDGET_S` (provisional default **1 s**, to be confirmed by measurement) is left on the request deadline. Otherwise the task is treated as expired while queued: `503 ENGINE_BUSY` with `Retry-After`, never run.
    - Reason: the execution timeout is never shortened, so a task dispatched with almost no time left would be certain to return `ENGINE_TIMEOUT`, while still holding a worker for up to 10 s.
    - This doesn't conflict with the decisions above. It only changes *when* the queued-expiry rule applies; it never kills a worker and never shortens the execution timeout. With a budget of 0, the behaviour is exactly the approved rule.
  - **Worker execution timeout:** `CBDC_ENGINE_TASK_TIMEOUT_S`, **10 s**, counted from when the worker starts the task. It is not shortened to the time left on the request deadline. A task that runs past it is stopped: its worker process is terminated and replaced (worker recycling, arch §6.2). The request, if still waiting, gets `504 ENGINE_TIMEOUT`.
  - The 12 s default leaves 3 s for transport inside the backend's 15 s timeout, so the engine normally answers before the backend gives up. A configured deadline must stay below `INFERENCE_TIMEOUT_MS`.
  - One consequence: a task the caller has already been told timed out may keep a worker busy for up to 10 s, so `ENGINE_BUSY` can rise under load. That is accepted at development scale.
- **Health checks.** The backend's check of `/v1/health` uses its own short timeout (set by Dev B; 3 s, like the database probe, was proposed), not the 15 s routing timeout.
- **Caching:** cached `GET` results (`version`, `network`, `calendar`, `scenarios`) are invalidated when `/v1/version` reports a different value for any of: `git_commit`, `engine_version`, `reward_weights` (any λ), `knowledge.sha256`, `data.daily_state_sha256`, `data.bridge_network_sha256`, `data.normalization_stats_sha256`, `data.macro_risk_proxy_sha256`, `data.rpw_corridor_quarterly_sha256`, `data.scenarios_sha256` or `checkpoint.sha256`. That covers every input of `decision_id` that `/v1/version` reports, plus the cached scenario list.
- **Network exposure:** the inference service listens on the internal Compose network only and must not be published to the host in the `full` profile of `infra/compose.yaml`. For local debugging, Dev A may publish it on `127.0.0.1:8000`.

---

## 6. Persistence (backend)

### 6.1 Principles
- Store the full inference response verbatim (`engineResponse` JSON), plus the normalised columns needed for queries.
- Never store tokens, token hashes or other secrets in database records. Token hashes live only in `dev-tokens.json`.
- Records are append-only. Corrections create new records.

### 6.2 What is persisted
Each transaction request (including the full state spec, so explicit states can be replayed, and, for a failed transaction, its failure code), its routing decision, each allocation row, comparisons (as independent records), explanations, and an audit log entry for each of those writes.
- **Audit rule** (approved, Q19 closed).
  - An audit row is written **only together with a persisted record**: a transaction (routed or failed), a comparison or an explanation. It is written in the **same database transaction** as that record, so neither exists without the other.
  - A request that persists nothing creates **no** audit row. That includes 401, 403, 405, 422, a passed-through 409, and an error on an endpoint that saves nothing.
  - The v0.3 wording "an audit log entry for every mutating call" no longer applies.

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
| `CBDC_ENGINE_TASK_TIMEOUT_S` | inference | `10` | Worker execution timeout, counted from when the task starts. Independent of the request deadline and never shortened to it (§5). Exceeding it recycles **that worker**: its process is terminated and replaced; the other workers keep serving. |
| `CBDC_ENGINE_REQUEST_DEADLINE_S` | inference | `12` | Request deadline from acceptance (§5). Expiry while queued → `ENGINE_BUSY`; while running → `ENGINE_TIMEOUT`, without killing the worker. Must stay below `INFERENCE_TIMEOUT_MS`. |
| `CBDC_ENGINE_MIN_START_BUDGET_S` | inference | `1` (provisional) | A queued task is not dispatched if less than this is left on its request deadline; it gets `ENGINE_BUSY` instead (§5). 0 disables it. **Startup validation:** the service refuses to start unless `0 <= CBDC_ENGINE_MIN_START_BUDGET_S < CBDC_ENGINE_REQUEST_DEADLINE_S`, because a budget at or above the deadline would reject every queued request. |
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
| A (`services/inference/tests/concurrency/`) | **Deadlines and workers:** a request whose deadline expires while queued gets `503 ENGINE_BUSY` and never runs; one that expires while running gets `504 ENGINE_TIMEOUT` and its worker is **not** killed; a task past the 10 s execution timeout recycles only its worker. `ENGINE_BUSY` while a worker is rebuilding. Workers start within `CBDC_ENGINE_STARTUP_TIMEOUT_S`; `ready_workers` reports them. |
| B (`services/backend/test/` · `phase2-backend.yml`) | Mapping completeness (every engine field maps to an app field, unknown engine fields included), persistence round trip, error passthrough, timeout → 503, mock mode. **Also:**<br>• failed transactions: `failureCode` and `failure`, the null fields, `409 TRANSACTION_FAILED`;<br>• `POLICY_DISABLED` passthrough with fixed messages (engine text never forwarded), the field-path mapping table, `NOT_READY` → `INFERENCE_UNAVAILABLE`, and `Retry-After` forwarding;<br>• strict request bodies, the 200-character `clientReference`, `policy: null` → 422, `VALIDATION_ERROR` before `INVALID_AMOUNT`, and 405 with `Allow`;<br>• an audit row only in the same transaction as a persisted record, and none for a rejected request.<br>**Auth:** startup refusal in each forbidden configuration; 401 for missing, malformed or unknown tokens; 403 for a viewer requesting `ppoProjected`; `Authorization` never logged or persisted. |
| C (`services/web/test/` · `phase2-web.yml`) | Rendering from every fixture, including rejection, partial completion, the disabled experimental policy, an explicit state, a failed transaction (null fields, `failure`), 401, 403, 409 and 503 with `Retry-After`. Mandatory labels and the dev-auth banner present. Token absent from `localStorage`, URLs and the built bundle; cleared on 401 and sign-out. |
| D (`e2e/`, `infra/scripts/` · `phase2-integration.yml`) | Every fixture in `contracts/fixtures/` validates against `contracts/openapi/`, and `infra/scripts/check_contracts.py` applies the §2.8, §3.2 and §4 rules the schemas can't express. It also verifies the `decision_id` test vectors (§2.11). Lock drift and install checks on Linux and Windows, including the dependency checks of arch §7.2. Docker images build. The `infra/compose.yaml` `full` profile end to end: sign in → submit → route → persist → read back → explain. |

### 9.1 Requirements for Dev A's implementation

These are **requirements** that Dev A's inference service and its tests must meet. They are specified here; this contracts change implements none of them. Each needs a test in `services/inference/tests/` before it is called done.

| # | Requirement | Contract | Test that shows it |
|---|---|---|---|
| A-1 | Deterministic `decision_id`: RFC 8785 over the §2.11 document, covering every output-affecting input; numbers normalised to binary64 during validation and the same values used for execution, with integer-valued numbers outside ±(2⁵³ − 1) rejected as `VALIDATION_ERROR`, never rounded; venues in ordinal `bridge_uid` order for hashing only, while execution keeps Phase 1 slot order; checkpoint hash for `ppo_projected` only; `engine_version` bumped when an imported Phase 1 constant affecting outputs changes | §2.2, §2.11 | Reproduce every vector in `contracts/test-vectors/decision_id.v1.json` byte for byte |
| A-2 | Cross-platform artefact and daily-state hashing (text files CRLF→LF, binaries raw, little-endian row hashes with column names and dtypes). Covers the **six** `decision_id` artefact fingerprints: knowledge, daily state, bridge network, normalisation stats, macro-risk proxy and RPW cost baseline. Also `scenarios_sha256` in `/v1/version` | §2.2, §2.11; arch §6.2, §7.4 | Golden-hash test, identical on Windows and Linux CI: reproduce `contracts/test-vectors/daily_state_fingerprint.v1.json` exactly with pandas 2.3.3. The service `knowledge_sha256` equals the LF-normalised hash, not Phase 1's raw-byte `KnowledgeBase.sha256` |
| A-3 | 10 s worker execution timeout; 12 s request deadline (`CBDC_ENGINE_REQUEST_DEADLINE_S`); 1 s minimum start budget (`CBDC_ENGINE_MIN_START_BUDGET_S`), with startup refused unless `0 <= budget < deadline` | §5, §8 | Queued expiry and under-budget → `ENGINE_BUSY`, never run; deadline while running → `ENGINE_TIMEOUT` with the worker kept; past 10 s → only that worker recycled |
| A-4 | Configurable worker startup timeout, default 180 s (`CBDC_ENGINE_STARTUP_TIMEOUT_S`) | §8; arch §6.2 | Before readiness, `NOT_READY` and `ready: false` |
| A-5 | Strict request validation and the agreed error formats (`details.errors[]`, `field` omitted for form-level errors, sanitised 4xx messages, `VALIDATION_ERROR` for wrong-length history) | §1, §2.4, §4 | Every inference error fixture |
| A-5b | `405 METHOD_NOT_ALLOWED` with an `Allow` header listing the path's methods | §4 | `inference/errors/405_method_not_allowed.json` |
| A-6 | `ready_workers` in health | §2.1 | Health fixtures; changes during warm-up and recycling |
| A-7 | `STATE_OUTSIDE_TRAINING_RANGE`: a warning only, from route and compare only, on the policy-consumed values | §2.4 | One case per state mode; never from `/v1/state`; never blocks a baseline |
| A-8 | Regulatory rejection: `requested_usd = 0`, `allocations = []`, the full non-null `metrics` with zero fee cost and zero execution costs, `totals.executed_usd = 0` and `totals.completion_ratio = 0`, no `PARTIAL_COMPLETION`, and no `RISK_FALLBACK_USED`, because the rejection prevents the risk lookup. On allowed decisions, `RISK_FALLBACK_USED` appears exactly when the proxy lookup falls back | §2.8 | Rejection fixtures; a fallback month and a non-fallback month |
| A-9 | Consistent `decision_id` across route, compare and explain. `fee_cost_usd` = Σ executed × `fee_pct` on every decision, with `metrics` always non-null | §2.9–§2.11 | The same request gives the same ID on all three; a compare entry equals its route |

---

## 10. Open decisions (v0.4 revision)

Ayush's owner decisions resolved Q1–Q10, Q11 (including the window defaults, A3), Q12 (R5), Q13, Q15, Q17, Q21 (A2), Q3a and Q9a, and the corrections R1–R6. Those rules are now stated in the sections above. `docs/TEAM_REVIEW_RESOLUTION.md` maps each one to where it landed. The questions below are still open: the contract states no rule for them, or states an interim rule marked as such.

**Blocking: needed before the dependent implementation lands**

| # | Question | Positions | Decides |
|---|---|---|---|
| Q11-dep | `meanFeeCostPct` needs a `feeCostUsd` column on `RoutingDecision`, added by a Prisma migration (§3.8) | Formula decided by the owner; the migration is not made | Anvesh (implementation) |

**Non-blocking: they can follow v0.4**

| # | Question | Notes | Decides |
|---|---|---|---|
| Q11a | A non-UUID `:id`: `404 NOT_FOUND` or `422 VALIDATION_ERROR`? | Not implemented yet | Anvesh |
| Q14 | Is `405` checked before or after authentication in the app? | The fixtures send a token, so they don't depend on it | Anvesh |
| Q18 | Comparisons: the analyst default for an omitted `policies`, the order of `results`, and whether the record echoes `state` and `policies` | Both are already persisted (§6.3) | Anvesh and Varshini |
| F1 | **Phase 1 cost-baseline unit** (a technical finding, not a Phase 2 contract change). `real_cost_baseline` looks like percentage points but is used as a fraction in the reward. Any correction would change Phase 1 rewards, so it needs a separately reviewed and versioned change. Phase 2 passes the value through unchanged | Evidence and the open points: `docs/TEAM_REVIEW_RESOLUTION.md` §14 | Ayush |
| Q20 | Mock fixture selection: how MSW and the backend mock pick between several fixtures for one operation (for example the PPO-enabled meta) | C proposed method, path, query and deep-equal body, ignoring headers, plus a warning on fallback | Nisarga, Anvesh, Varshini |
