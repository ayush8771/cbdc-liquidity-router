# Phase 2 contracts

**Status: DRAFT v0.3.0, pending approval by Dev A, B and C** (arch §10). Until it is approved, `docs/PHASE2_API_CONTRACT.md` is normative. Any difference between that document and these files is a bug here, except for the open issues listed below, which need a decision.

Owner: Dev D. Changes need approval from every consumer (arch §4.1).

| Path | What |
|---|---|
| `openapi/inference.v1.yaml` | Inference API (`/v1`, snake_case). Producer A, consumer B. |
| `openapi/app.v1.yaml` | Application API (`/api/v1`, camelCase). Producer B, consumer C. |
| `fixtures/inference/` | `meta/ state/ route/ compare/ explain/ errors/`. Used by the backend's mock mode and by Prism. |
| `fixtures/app/` | `meta/ auth/ transactions/ comparisons/ dashboard/ errors/`. Used by MSW in the web app. |

## Fixture format

Each fixture is one request and its response:

```json
{
  "description": "what this case shows",
  "source": "illustrative | phase1_derived | engine_generated",
  "request_valid": false,
  "derived_from": {"kind": "transaction", "fixture": "inference/route/200_waterfall_replay.json"},
  "request":  {"method": "POST", "path": "/v1/route", "query": {}, "headers": {}, "body": {}},
  "response": {"status": 200, "headers": {"X-Request-Id": "..."}, "body": {}}
}
```

- `source`:
  - `illustrative`: hand-authored values, as in the contract's examples. They are not engine output. Dev A replaces the inference ones with `engine_generated` fixtures.
  - `phase1_derived`: copied exactly from Phase 1 files. The network comes from `bridge_network.csv`, the calendar from `split.py`, and the scenarios from `scenarios.py`.
- `request_valid: false` marks a request that must fail schema validation (a `VALIDATION_ERROR` case). `request.body_raw` holds a non-JSON body for `MALFORMED_REQUEST`.
- `derived_from` marks an app fixture that must equal the camelCase mapping of an inference fixture. The checker enforces this.
- Auth headers use only the MSW mock tokens `mock-viewer` and `mock-analyst`. The checker rejects any 64-hex token.
- The illustrative `ppo_projected` fixtures use the checkpoint ID `fixture-only-not-approved`. **No checkpoint is approved** (§7).

## Engine → app mapping (§3.2)

- Every key changes from snake_case to camelCase, for example `unrouted_amount_based_usd` → `unroutedAmountBasedUsd`.
- Only two kinds of value change:
  - policy names: `cheapest_feasible` → `cheapestFeasible`, `ppo_projected` → `ppoProjected`;
  - state modes: `historical_replay` → `historicalReplay`.
- No other value changes. That covers codes, IDs, tags, `bridgeUid`, `regime`, `valuesProvenance`, `scenarioId` and `split`.
- `decision` is the `RouteResponse` without `transaction`. The reference implementation is `to_app()` in `infra/scripts/check_contracts.py`.

## Validate

```bash
py -3.10 -m venv infra/.venv          # Linux: python3.10 -m venv infra/.venv
infra/.venv/Scripts/python -m pip install -r infra/scripts/requirements.txt   # Linux: infra/.venv/bin/python
infra/.venv/Scripts/python infra/scripts/check_contracts.py
infra/.venv/Scripts/python -m pytest infra/scripts/tests -q
```

The checker:
- validates both documents as OpenAPI 3.1;
- validates every fixture's request and response against its operation;
- checks that each error code uses its §4 HTTP status;
- applies the §2.8 field definitions: execution, clipping, totals, reward terms, `completed`, the regime and warnings;
- checks `decision_id` stability across route, explain and compare;
- checks the app ↔ engine mapping;
- checks coverage: every operation has a success fixture, and every error code has a fixture.

CI runs it in `.github/workflows/phase2-integration.yml`.

## Open issues found while writing the contract (need a decision)

| # | Issue | What these files do now | Who decides |
|---|---|---|---|
| C1 | App health `database`: the contract shows only `"ok"`, but the backend branch returns `"unavailable"`. | Enum `[ok, unavailable]` | B, C |
| C2 | `ENGINE_TIMEOUT` through the app: §3.2 lists it with the 503s, while the §4 table says 504, passed through. | 504, per the §4 table. §3.2 needs a wording fix. | B |
| C3 | `POLICY_DISABLED` (409) through the app is undefined. An analyst requesting a disabled `ppoProjected` gets a 409 from inference; §3.2 only says that 422s pass through. | Not in the app spec. Proposal: pass it through as 409, not persisted, like a 422. | B, C |
| C4 | `GET /transactions/:id` for a `failed` transaction: §3.4 says "same body as the 201", but there is no decision. | `decision: null`; the list's decision fields are nullable | B, C |
| C5 | **`decision_id` is not platform-independent if it hashes file bytes.** With `core.autocrlf=true`, a Windows checkout's SHA-256 of `bridge_network.csv`, `regulatory_facts.json` and `normalization_stats.json` differs from the committed bytes in the Linux image (measured). `src/memory/knowledge.py` hashes raw bytes. A decision stored from one platform and explained on the other would then return `409 DECISION_MISMATCH`. | Fixtures use the committed (LF) blob hashes | A (hash the committed or normalised content), or the owner (a `.gitattributes` rule for `data/`, which is a Phase 1 change) |
| C6 | The `semantic_context` inner shape is undefined. | Any object, or null | A, C |
| C7 | The `decision_id` canonical form is undefined: do `client_reference` and `include_semantic_context` enter it? The second must not, or explain can't match route. | Fixtures assume neither enters it | A |
| C8 | Unknown fields outside `state`: §2.4 only requires rejecting them inside `state`. | Rejected inside `state` and its venues; the top level and `transaction` are open | A, B |
| C9 | The item shape of `VALIDATION_ERROR` `details.errors[]` is undefined. FastAPI's default is `{loc, msg, type}`. | `{field, message}` | A, B, C |
| C10 | Non-ok values of the health checks `structured_data`, `daily_state` and `knowledge_base` are undefined. | `[ok, error]` | A |
| C11 | Explain `outcome` values: only `used` and `unused` are shown. | `[used, unused]`; a rejection uses `unused` + `INFEASIBLE_REGULATORY` | A, C |
| C12 | Arch §4 has no fixture folder for health, version, network, calendar or scenarios. | Added `meta/` under both APIs | all (doc update) |
| C13 | The §2.8 example request sends `client_reference` but the response shows null. | Fixtures echo the value as sent | doc fix |
| C14 | Read literally, §2.8 gives a regulatory rejection the warning `PARTIAL_COMPLETION`, because `completed` is false. | Literal rule followed | A, C |
| C15 | Arch §9.2 says the gap buffers are "the first 30 days" and "the last 30 days". Phase 1's `in_gap_buffer()` uses `<= 30`, so each buffer is 31 days: 2011-01-01..01-31 and 2025-08-31..09-30. | Calendar fixture uses the computed ranges | doc fix |
| C16 | Phase 1 `validate_simulation_date()` raises one exception type for both "out of range" and "in a gap buffer". | Contract unchanged. Dev A must tell them apart, for example with `assign_split()`. | A (implementation note) |
