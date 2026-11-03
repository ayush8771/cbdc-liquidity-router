# Phase 2 contracts

**Status: DRAFT v0.4.0, pending approval by Dev A, B and C** (arch §10). Until it is approved, `docs/PHASE2_API_CONTRACT.md` is normative. Any difference between that document and these files is a bug here.
- Rules the contract marks **Pending: <name>** are included and labelled `PENDING` in the OpenAPI descriptions.
- Questions the contract leaves open (contract §10, Q1–Q15) are left open here: the schemas accept every proposed form.

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
- applies the §2.8 field definitions:
  - execution, clipping and totals, including the allocation invariant `requested_usd = Σ amount_requested_usd`;
  - reward terms;
  - the Stage 1F `completed` rule and `bridges_used` above 1e-6;
  - regulatory rejections (`requested_usd = 0`, `allocations = []`);
  - the regime and warnings, including C14: no `PARTIAL_COMPLETION` on a rejection;
- checks `decision_id` stability across route, explain and compare;
- checks failed transaction records (§3.2–§3.4):
  - `decision` and `corridor` are null and `failure` is set;
  - the list's decision-derived fields are null;
  - `failure` repeats the code and message of the `POST` error that created it;
- checks that a 405 sends an `Allow` header listing the path's methods;
- checks the app ↔ engine mapping, including that a passed-through 4xx keeps the engine message (at most 500 characters);
- checks coverage: every operation has a success fixture, and every error code has a fixture.

CI runs it in `.github/workflows/phase2-integration.yml`.

## Issues found while writing the contract: status in v0.4

| # | Issue | v0.4 outcome |
|---|---|---|
| C1 | App health `database` values | **Resolved:** `[ok, unavailable]`; mock mode reports `ok`. Still open: HTTP status and `status` when the database is down (contract §10, Q3). |
| C2 | `ENGINE_TIMEOUT` listed with the 503s in §3.2 | **Resolved:** 504 everywhere; §3.2 rewritten. |
| C3 | `POLICY_DISABLED` through the app | **Resolved:** passed through as 409, not persisted; a viewer gets 403 first. |
| C4 | `GET /transactions/:id` for a failed transaction | **Resolved:** `decision: null`, `corridor: null`, `failure: {code, message}`; `409 TRANSACTION_FAILED` for its explanation. |
| C5 | `decision_id` and CRLF checkouts | **Resolved (Ayush):** text artefacts are hashed after CRLF→LF; binaries raw; no `.gitattributes` for `data/`. A golden-hash test on Windows and Linux is required. |
| C6 | `semantic_context` inner shape | **Resolved (Ayush):** reserved, always null in v1. |
| C7 | `decision_id` canonical form | **Partly resolved:** RFC 8785, `git_commit` excluded (Ayush). The composition rules are **Pending: Ayush** (contract §2.11). `api_version` and `engine_version` are open (Q1, Q2). |
| C8 | Unknown fields outside `state` | **Resolved for the app:** requests strict at every level. Inference top level and `transaction`: **Pending: Ayush**. |
| C9 | `details.errors[]` item shape | **Resolved:** `{field, message}` with camelCase app paths. Still open: how a non-field error is written (Q4). |
| C10 | Non-ok values of three health checks | Open (Q12). Schema keeps `[ok, error]`. |
| C11 | Explain `outcome` values | **Resolved (Ayush):** `used`/`unused`; a rejection uses `unused` + `INFEASIBLE_REGULATORY`. |
| C12 | No fixture folder for metadata | **Resolved:** `meta/` added to arch §4. |
| C13 | §2.8 example `client_reference` not echoed | **Resolved:** examples fixed. |
| C14 | `PARTIAL_COMPLETION` on a regulatory rejection | **Resolved (Ayush):** omitted; fixtures and checker updated. |
| C15 | Gap-buffer length in arch §9.2 | **Resolved:** arch §9.2 states the 31-day ranges computed by Phase 1. |
| C16 | One Phase 1 exception for two date errors | **Resolved (Ayush):** no contract change; implementation note for Dev A. |

New questions raised in the v0.4 reviews are tracked in `docs/PHASE2_API_CONTRACT.md` §10.
