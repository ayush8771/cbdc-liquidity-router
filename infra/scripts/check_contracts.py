"""Contract-conformance check for contracts/ (arch §5.4, contract §9 row D).

Checks, in order:
  1. Both OpenAPI documents are valid OpenAPI 3.1.
  2. Every fixture matches a documented operation and status, its request and
     response validate against the schemas, and error bodies use the HTTP status
     the contract assigns to their code (§4).
  3. Semantic rules the schemas can't express: the RouteResponse field
     definitions of §2.8 (including the allocation invariant, the C14 warning
     rule and regulatory rejections), policy defaults, compare and explain
     rules (§2.9, §2.10), decision_id stability across fixtures, failed
     transaction records (§3.2–§3.4), and 405 responses with Allow (§4).
  4. App fixtures marked `derived_from` are the field-for-field camelCase
     mapping of their inference fixture (§3.2), with no recomputation; a
     passed-through 4xx keeps the engine message, truncated to 500 characters.
  5. Coverage: every operation has a success fixture, and every error code the
     API raises has at least one fixture.
  6. No real-looking bearer token appears in any fixture.

Usage:  python infra/scripts/check_contracts.py [--root REPO_ROOT]
Exit status 0 when everything conforms, 1 otherwise. Needs only the packages
in infra/scripts/requirements.txt; it never imports Phase 1 code.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

import yaml
from jsonschema import Draft202012Validator, FormatChecker
from openapi_spec_validator import validate as validate_openapi

APIS = ("inference", "app")
SPEC_FILES = {"inference": "inference.v1.yaml", "app": "app.v1.yaml"}

# §3.2 mapping: only policy names and state modes change value.
POLICY_TO_APP = {"cheapest_feasible": "cheapestFeasible", "ppo_projected": "ppoProjected"}
MODE_TO_APP = {"historical_replay": "historicalReplay"}
POLICY_STATUS = {"waterfall": "default", "cheapest_feasible": "baseline", "ppo_projected": "experimental"}
VALUES_PROVENANCE = {"historical_replay": "synthetic_simulation", "scenario": "synthetic_scenario",
                     "explicit": "user_supplied_synthetic"}

# Phase 1 constants the §2.8 definitions refer to (src/training/metrics.py).
RELATIVE_UNROUTED_TOLERANCE = 1e-4  # Stage 1F amount-based completed (src/backtesting/evaluation.py)
MEANINGFUL_ALLOCATION_THRESHOLD = 1e-6  # bridges_used counts shares above this
FORWARDED_MESSAGE_LIMIT = 500  # §4: a passed-through 4xx message is truncated to this many characters
FAILURE_CODES = ("INFERENCE_ERROR", "INFERENCE_UNAVAILABLE", "ENGINE_BUSY", "ENGINE_TIMEOUT")
NEAR_BOUNDARY_TOLERANCE = 0.15  # src/training/transaction_generator.py true_regime_for_row()

HEX64_TOKEN = re.compile(r"Bearer\s+[0-9a-fA-F]{64}\b")


def camel(key: str) -> str:
    head, *rest = key.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


def to_app(value, key: str | None = None):
    """Engine (snake_case) → Application API (camelCase), contract §3.2."""
    if isinstance(value, dict):
        return {camel(k): to_app(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [to_app(v, key) for v in value]
    if key in ("policy", "default_policy", "policies") and isinstance(value, str):
        return POLICY_TO_APP.get(value, value)
    if key in ("mode", "state_mode") and isinstance(value, str):
        return MODE_TO_APP.get(value, value)
    return value


def close(a: float, b: float) -> bool:
    return math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-6)


class Checker:
    def __init__(self, root: Path):
        self.root = root
        self.contracts = root / "contracts"
        self.problems: list[str] = []
        self.specs: dict[str, dict] = {}
        self.fixtures: dict[str, dict] = {}  # "inference/route/x.json" -> fixture
        self.decision_ids: dict[str, tuple[str, str]] = {}  # canonical request -> (decision_id, fixture)
        self.failed_posts: dict[str, tuple[str, str, str]] = {}  # transactionId -> (code, message, fixture)
        self.failed_records: dict[str, tuple[dict, str]] = {}  # id -> (failure, fixture)

    def fail(self, where: str, message: str) -> None:
        self.problems.append(f"{where}: {message}")

    # ------------------------------------------------------------- loading
    def load(self) -> None:
        for api, name in SPEC_FILES.items():
            path = self.contracts / "openapi" / name
            spec = yaml.safe_load(path.read_text(encoding="utf-8"))
            try:
                validate_openapi(spec)
            except Exception as exc:  # report every problem, don't stop at the first
                self.fail(f"openapi/{name}", f"invalid OpenAPI: {str(exc).splitlines()[0]}")
            self.specs[api] = spec
        for api in APIS:
            for path in sorted((self.contracts / "fixtures" / api).rglob("*.json")):
                rel = path.relative_to(self.contracts / "fixtures").as_posix()
                try:
                    self.fixtures[rel] = json.loads(path.read_text(encoding="utf-8"))
                except json.JSONDecodeError as exc:
                    self.fail(rel, f"not valid JSON: {exc}")

    def validator(self, api: str, schema: dict) -> Draft202012Validator:
        root = dict(schema)
        root["components"] = self.specs[api]["components"]
        return Draft202012Validator(root, format_checker=FormatChecker())

    def schema_errors(self, api: str, schema: dict, instance) -> list[str]:
        errors = sorted(self.validator(api, schema).iter_errors(instance), key=lambda e: list(e.absolute_path))
        return [f"{'/'.join(map(str, e.absolute_path)) or '<root>'}: {e.message[:200]}" for e in errors]

    def deref(self, api: str, node: dict) -> dict:
        while "$ref" in node:
            parts = node["$ref"].lstrip("#/").split("/")
            target = self.specs[api]
            for part in parts:
                target = target[part]
            node = target
        return node

    def find_path(self, api: str, path: str):
        for template, item in self.specs[api]["paths"].items():
            pattern = "^" + re.sub(r"\\\{[^}]+\\\}", "[^/]+", re.escape(template)) + "$"
            if re.match(pattern, path):
                return template, item
        return None, None

    def find_operation(self, api: str, method: str, path: str):
        template, item = self.find_path(api, path)
        if item is not None and method.lower() in item:
            return template, item[method.lower()]
        return None, None

    # ------------------------------------------------------------- per fixture
    def check_fixture(self, rel: str, fx: dict) -> None:
        api = rel.split("/", 1)[0]
        for key in ("description", "source", "request", "response"):
            if key not in fx:
                self.fail(rel, f"wrapper is missing '{key}'")
                return
        if fx["source"] not in ("illustrative", "phase1_derived", "engine_generated"):
            self.fail(rel, f"unknown source {fx['source']!r}")
        req, resp = fx["request"], fx["response"]
        status, body = resp["status"], resp["body"]
        req_headers = {k.lower(): v for k, v in req.get("headers", {}).items()}
        resp_headers = {k.lower(): v for k, v in resp.get("headers", {}).items()}

        if "x-request-id" not in resp_headers:
            self.fail(rel, "response has no X-Request-Id header (§1)")
        elif "x-request-id" in req_headers and req_headers["x-request-id"] != resp_headers["x-request-id"]:
            self.fail(rel, "X-Request-Id is not echoed unchanged")

        template, op = self.find_operation(api, req["method"], req["path"])
        if op is None:
            # Only an unknown-resource 404, or a 405 on a documented path, may target an undocumented operation.
            path_template, item = self.find_path(api, req["path"])
            if status == 404 or (status == 405 and item is not None):
                self.check_schema(rel, api, {"$ref": "#/components/schemas/ErrorResponse"}, body, "response")
                self.check_error(rel, api, status, body, resp_headers)
                if status == 405:
                    self.check_allow(rel, item, resp_headers)
            elif status == 405:
                self.fail(rel, f"405 for {req['path']}, which is not a documented path (that is a 404)")
            else:
                self.fail(rel, f"no operation {req['method']} {req['path']} in {SPEC_FILES[api]}")
            return

        # security: every app operation except health needs a bearer token, unless the fixture is a 401
        secured = op.get("security", self.specs[api].get("security", []))
        if secured and status != 401 and "authorization" not in req_headers:
            self.fail(rel, "secured operation without an Authorization header")

        self.check_query(rel, api, op, req.get("query", {}))
        request_ok = self.check_request_body(rel, api, op, req, fx.get("request_valid", True), status, body)

        responses = op.get("responses", {})
        if str(status) not in responses:
            self.fail(rel, f"status {status} is not documented for {req['method']} {template}")
            return
        documented = self.deref(api, responses[str(status)])
        schema = documented.get("content", {}).get("application/json", {}).get("schema")
        if schema is None:
            self.fail(rel, f"status {status} of {template} has no JSON schema")
            return
        response_ok = self.check_schema(rel, api, schema, body, "response")
        if isinstance(body, dict) and "error" in body:
            self.check_error(rel, api, status, body, resp_headers)
        elif status < 400 and request_ok and response_ok:  # semantics assume schema-valid bodies
            self.check_semantics(rel, api, template, req, body)

    def check_schema(self, rel, api, schema, instance, label) -> bool:
        errors = self.schema_errors(api, schema, instance)
        for err in errors[:10]:
            self.fail(rel, f"{label} schema: {err}")
        return not errors

    def check_query(self, rel, api, op, query) -> None:
        params = [self.deref(api, p) for p in op.get("parameters", [])]
        known = {p["name"]: p for p in params if p["in"] == "query"}
        for name, raw in query.items():
            if name not in known:
                self.fail(rel, f"undocumented query parameter {name!r}")
                continue
            schema = self.deref(api, known[name]["schema"])
            value = raw
            if schema.get("type") == "boolean":
                value = {"true": True, "false": False}.get(raw, raw)
            elif schema.get("type") == "integer" and isinstance(raw, str) and raw.isdigit():
                value = int(raw)
            for err in self.schema_errors(api, known[name]["schema"], value):
                self.fail(rel, f"query {name}: {err}")
        for name, p in known.items():
            if p.get("required") and name not in query:
                self.fail(rel, f"required query parameter {name!r} missing")

    def check_request_body(self, rel, api, op, req, expect_valid, status, body) -> bool:
        if "body_raw" in req:
            code = body.get("error", {}).get("code") if isinstance(body, dict) else None
            if code != "MALFORMED_REQUEST":
                self.fail(rel, "a raw (non-JSON) request body must produce MALFORMED_REQUEST")
            return False
        spec_body = op.get("requestBody")
        if spec_body is None:
            if "body" in req:
                self.fail(rel, "request has a body but the operation takes none")
            return True
        if "body" not in req:
            self.fail(rel, "operation requires a request body")
            return False
        schema = spec_body["content"]["application/json"]["schema"]
        errors = self.schema_errors(api, schema, req["body"])
        if expect_valid:
            for err in errors[:10]:
                self.fail(rel, f"request schema: {err}")
            return not errors
        if not errors:
            self.fail(rel, "request_valid is false but the request validates against the schema")
        code = body.get("error", {}).get("code") if isinstance(body, dict) else None
        if code not in ("VALIDATION_ERROR", "MALFORMED_REQUEST"):
            self.fail(rel, f"a schema-invalid request must produce VALIDATION_ERROR, not {code}")
        return False

    def check_error(self, rel, api, status, body, resp_headers) -> None:
        err = body.get("error", {})
        code = err.get("code")
        expected = self.specs[api].get("x-error-status", {}).get(code)
        if expected is None:
            self.fail(rel, f"error code {code!r} is not in the {api} API's x-error-status table")
        elif expected != status:
            self.fail(rel, f"{code} must be HTTP {expected} (§4), fixture has {status}")
        rid_key = "request_id" if api == "inference" else "requestId"
        if err.get(rid_key) != resp_headers.get("x-request-id"):
            self.fail(rel, f"error.{rid_key} does not equal the X-Request-Id header")
        if code in ("ENGINE_BUSY", "NOT_READY") and "retry-after" not in resp_headers:
            self.fail(rel, f"{code} must send Retry-After (§4)")
        if code == "METHOD_NOT_ALLOWED" and "allow" not in resp_headers:
            self.fail(rel, "METHOD_NOT_ALLOWED must send an Allow header (§4)")
        transaction_id = err.get("details", {}).get("transactionId") if api == "app" else None
        if transaction_id is not None:
            if code not in FAILURE_CODES:
                self.fail(rel, f"only an inference failure ({', '.join(FAILURE_CODES)}) persists a transaction (§3.2)")
            self.failed_posts[transaction_id] = (code, err.get("message"), rel)

    def check_allow(self, rel, item, resp_headers) -> None:
        documented = {m.upper() for m in item if m in ("get", "post", "put", "patch", "delete")}
        allow = {m.strip().upper() for m in resp_headers.get("allow", "").split(",") if m.strip()}
        if not documented <= allow:
            self.fail(rel, f"Allow must list every method of the path: {sorted(documented)}")
        if allow - documented - {"HEAD", "OPTIONS"}:
            self.fail(rel, f"Allow lists undocumented methods: {sorted(allow - documented - {'HEAD', 'OPTIONS'})}")

    # ------------------------------------------------------------- semantics
    def check_semantics(self, rel, api, template, req, body) -> None:
        if api == "app":
            if template in ("/api/v1/transactions", "/api/v1/transactions/{id}") and "status" in body:
                self.check_record(rel, body)
            elif template == "/api/v1/transactions" and "items" in body:
                for item in body["items"]:
                    self.check_summary(rel, item)
            return
        if template == "/v1/route":
            self.check_route(rel, req["body"], body)
        elif template == "/v1/compare":
            self.check_compare(rel, req["body"], body)
        elif template == "/v1/explain":
            self.check_explain(rel, req["body"], body)

    def check_record(self, rel, body) -> None:
        """§3.2–§3.4: a failed record has no decision, no corridor and a failure; a routed one the reverse."""
        failed = body["status"] == "failed"
        if failed != (body["decision"] is None):
            self.fail(rel, "decision must be null exactly when status is failed (§3.2)")
        if failed != (body["failure"] is not None):
            self.fail(rel, "failure must be set exactly when status is failed (§3.2)")
        if failed and body["transaction"]["corridor"] is not None:
            self.fail(rel, "a failed transaction's corridor must be null; it is never derived (§3.2)")
        if failed and body["failure"] is not None:
            self.failed_records[body["id"]] = (body["failure"], rel)

    def check_summary(self, rel, item) -> None:
        derived = ("corridor", "policyStatus", "allowed", "completed", "completionRatio", "executedUsd",
                   "rewardAmountBased")
        if item["status"] == "failed":
            for field in derived:
                if item[field] is not None:
                    self.fail(rel, f"item {item['id']}: {field} must be null for a failed transaction (§3.3)")
        elif any(item[field] is None for field in derived):
            self.fail(rel, f"item {item['id']}: a routed transaction has every decision-derived field (§3.3)")

    def check_failures(self) -> None:
        """A stored failure repeats the code and message of the POST that created it (§3.2)."""
        for record_id, (failure, rel) in self.failed_records.items():
            post = self.failed_posts.get(record_id)
            if post is not None and (failure["code"], failure["message"]) != post[:2]:
                self.fail(rel, f"failure must repeat the code and message returned by {post[2]}")

    def register_decision(self, rel, request, policy, decision_id) -> None:
        tx = request["transaction"]
        key = json.dumps({"transaction": {k: tx[k] for k in ("sender_country", "receiver_country", "amount_usd")},
                          "state": request["state"], "policy": policy}, sort_keys=True)
        seen = self.decision_ids.get(key)
        if seen is None:
            for other_key, (other_id, other_rel) in self.decision_ids.items():
                if other_id == decision_id:
                    self.fail(rel, f"decision_id equals the one in {other_rel}, for a different request")
            self.decision_ids[key] = (decision_id, rel)
        elif seen[0] != decision_id:
            self.fail(rel, f"same request as {seen[1]} but a different decision_id (§2.10)")

    def check_route(self, rel, request, r, policy=None) -> None:
        policy = policy or request.get("policy", "waterfall")
        tx, state, at = request["transaction"], request["state"], f"{rel}"
        if r["policy"] != policy:
            self.fail(at, f"policy {r['policy']} != requested {policy} (default is waterfall)")
        if r["policy_status"] != POLICY_STATUS[r["policy"]]:
            self.fail(at, f"policy_status for {r['policy']} must be {POLICY_STATUS[r['policy']]}")
        self.register_decision(rel, request, policy, r["decision_id"])

        echo = r["transaction"]
        corridor = f"{tx['sender_country']}->{tx['receiver_country']}"
        state_date = state.get("date") or state.get("reference_date")
        for field, want in (("sender_country", tx["sender_country"]), ("receiver_country", tx["receiver_country"]),
                            ("amount_usd", tx["amount_usd"]), ("corridor", corridor), ("simulation_date", state_date),
                            ("client_reference", tx.get("client_reference"))):
            if echo[field] != want:
                self.fail(at, f"transaction.{field} = {echo[field]!r}, expected {want!r}")

        prov = r["provenance"]
        if prov["state_mode"] != state["mode"] or prov["state_date"] != state_date:
            self.fail(at, "provenance.state_mode/state_date do not match the request state")
        if prov["values_provenance"] != VALUES_PROVENANCE[state["mode"]]:
            self.fail(at, f"values_provenance must be {VALUES_PROVENANCE[state['mode']]} for {state['mode']}")
        if prov["scenario_id"] != state.get("scenario_id"):
            self.fail(at, "provenance.scenario_id does not match the request")
        if state["mode"] == "historical_replay" and prov["state_frame_sha256"] != prov["daily_state_sha256"]:
            self.fail(at, "replay: state_frame_sha256 must equal daily_state_sha256 (§2.8)")
        if (prov["checkpoint"] is not None) != (policy == "ppo_projected"):
            self.fail(at, "provenance.checkpoint must be set exactly when the policy is ppo_projected")

        allocs, totals, m = r["allocations"], r["totals"], r["metrics"]
        amount = tx["amount_usd"]
        slots = [a["slot"] for a in allocs]
        if slots != sorted(set(slots)):
            self.fail(at, "allocations must be sorted by slot, each slot once")
        for a in allocs:
            where = f"{at} slot {a['slot']}"
            if not a["bridge_uid"].startswith(corridor + "#"):
                self.fail(where, "bridge_uid is not in the transaction's corridor")
            if not close(a["amount_requested_usd"], a["share_requested"] * amount):
                self.fail(where, "amount_requested_usd != share_requested × amount_usd")
            if not close(a["amount_executed_usd"], min(a["amount_requested_usd"], a["liquidity_usd"])):
                self.fail(where, "amount_executed_usd != min(requested, liquidity)")
            if not close(a["amount_clipped_usd"], a["amount_requested_usd"] - a["amount_executed_usd"]):
                self.fail(where, "amount_clipped_usd != requested − executed")
            if (a["share_before_projection"] is not None) != (policy == "ppo_projected"):
                self.fail(where, "share_before_projection must be non-null exactly for ppo_projected")
        if len({a["risk"] for a in allocs}) > 1:
            self.fail(at, "risk must be the corridor risk, equal for every venue")
        if policy == "ppo_projected" and allocs and not close(sum(a["share_requested"] for a in allocs), 1.0):
            self.fail(at, "projected PPO shares must sum to 1")

        # Allocation invariant: requested_usd is the sum of per-venue requested amounts, never amount_usd.
        requested = sum(a["amount_requested_usd"] for a in allocs)
        executed = sum(a["amount_executed_usd"] for a in allocs)
        checks = [
            ("totals.amount_usd", totals["amount_usd"], amount),
            ("totals.requested_usd", totals["requested_usd"], requested),
            ("totals.executed_usd", totals["executed_usd"], executed),
            ("totals.unrouted_env_usd", totals["unrouted_env_usd"], requested - executed),
            ("totals.unrouted_amount_based_usd", totals["unrouted_amount_based_usd"], amount - executed),
            ("totals.completion_ratio", totals["completion_ratio"], executed / amount),
            ("totals.bridges_used", totals["bridges_used"],
             sum(1 for a in allocs if a["share_requested"] > MEANINGFUL_ALLOCATION_THRESHOLD)),
        ]
        fee_cost = sum(a["amount_executed_usd"] * a["fee_pct"] for a in allocs)
        latency = sum(a["amount_executed_usd"] / amount * a["congestion"] for a in allocs)
        risk = sum(a["amount_executed_usd"] / amount * a["risk"] for a in allocs)
        cost = (m["baseline_cost_pct"] * executed - fee_cost) / amount
        w = m["reward_weights"]
        un_env, un_amt = totals["unrouted_env_usd"] / amount, totals["unrouted_amount_based_usd"] / amount
        base = cost - w["lambda_latency"] * latency - w["lambda_risk"] * risk
        checks += [
            ("metrics.fee_cost_usd", m["fee_cost_usd"], fee_cost),
            ("metrics.cost_term", m["cost_term"], cost),
            ("metrics.latency_term", m["latency_term"], latency),
            ("metrics.risk_term", m["risk_term"], risk),
            ("metrics.unrouted_term_env", m["unrouted_term_env"], un_env),
            ("metrics.unrouted_term_amount_based", m["unrouted_term_amount_based"], un_amt),
            ("metrics.reward_env", m["reward_env"], base - w["lambda_unrouted"] * un_env),
            ("metrics.reward_amount_based", m["reward_amount_based"], base - w["lambda_unrouted"] * un_amt),
        ]
        for name, got, want in checks:
            if not close(got, want):
                self.fail(at, f"{name} = {got}, but the §2.8 definition gives {want}")
        completed = max(amount - executed, 0.0) <= RELATIVE_UNROUTED_TOLERANCE * amount
        if totals["completed"] != completed:
            self.fail(at, "totals.completed disagrees with the Stage 1F rule (max(amount − executed, 0) ≤ 1e-4 × amount)")

        feas = r["feasibility"]
        if not feas["allowed"]:
            if allocs or executed or totals["requested_usd"] or totals["completed"]:
                self.fail(at, "a regulatory rejection must have allocations=[], requested_usd=0, nothing executed, "
                              "completed=false")
            if not feas["reason"] or not feas["decisive_fact_ids"]:
                self.fail(at, "a regulatory rejection needs reason and decisive_fact_ids")
        elif feas["reason"] is not None:
            self.fail(at, "feasibility.reason must be null when allowed")

        if allocs:
            liquidities = sorted(allocs, key=lambda a: a["fee_pct"])
            cheapest = liquidities[0]["liquidity_usd"]
            combined = sum(a["liquidity_usd"] for a in allocs)
            if not close(r["diagnostics"]["combined_liquidity_usd"], combined):
                self.fail(at, "diagnostics.combined_liquidity_usd != sum of venue liquidity")
            if amount > combined:
                regime = "exceeds_combined"
            elif (1 - NEAR_BOUNDARY_TOLERANCE) * cheapest <= amount <= (1 + NEAR_BOUNDARY_TOLERANCE) * cheapest:
                regime = "near_boundary"
            else:
                regime = "splitting_needed" if amount > cheapest else "below_cheapest"
            if r["diagnostics"]["regime"] != regime:
                self.fail(at, f"diagnostics.regime is {r['diagnostics']['regime']}, true_regime_for_row gives {regime}")
        if r["diagnostics"]["projection_applied"] != (policy == "ppo_projected"):
            self.fail(at, "diagnostics.projection_applied must be true exactly for ppo_projected")

        codes = [wn["code"] for wn in r["warnings"]]
        if len(codes) != len(set(codes)):
            self.fail(at, "duplicate warning codes")
        for code, required in (("EXPERIMENTAL_POLICY", policy == "ppo_projected"),
                               # C14: a regulatory rejection never carries PARTIAL_COMPLETION.
                               ("PARTIAL_COMPLETION", not totals["completed"] and feas["allowed"]),
                               ("SYNTHETIC_COST_ANCHOR", corridor == "ARE->MEX")):
            if (code in codes) != required:
                self.fail(at, f"warning {code} must be present {'' if required else 'only '}when the §2.8 condition holds")
        if "DATE_IN_TRAINING_SPLIT" in codes and not (policy == "ppo_projected" and prov["split"] == "train"):
            self.fail(at, "DATE_IN_TRAINING_SPLIT only applies to ppo_projected on a train-split date")
        if policy == "ppo_projected" and prov["split"] == "train" and "DATE_IN_TRAINING_SPLIT" not in codes:
            self.fail(at, "ppo_projected on a train-split date must warn DATE_IN_TRAINING_SPLIT")

    def check_compare(self, rel, request, body) -> None:
        requested = request.get("policies")
        ran = [r["policy"] for r in body["results"]]
        skipped = [s["policy"] for s in body["skipped"]]
        if set(ran) & set(skipped):
            self.fail(rel, "a policy is both in results and in skipped")
        if requested is not None and sorted(ran + skipped) != sorted(requested):
            self.fail(rel, "results + skipped must cover exactly the requested policies")
        frames = {r["provenance"]["state_frame_sha256"] for r in body["results"]}
        if len(frames) > 1:
            self.fail(rel, "results use different state frames; same_state requires one (§2.9)")
        for r in body["results"]:
            self.check_route(rel + f" [{r['policy']}]", request, r, policy=r["policy"])

    def check_explain(self, rel, request, body) -> None:
        policy = request.get("policy", "waterfall")
        if body["policy"] != policy:
            self.fail(rel, f"policy {body['policy']} != requested {policy}")
        self.register_decision(rel, request, policy, body["decision_id"])
        tx = request["transaction"]
        corridor = f"{tx['sender_country']}->{tx['receiver_country']}"
        for v in body["venue_explanations"]:
            if not v["bridge_uid"].startswith(corridor + "#"):
                self.fail(rel, f"venue explanation for {v['bridge_uid']} is outside the corridor")
        if not body["feasibility"]["allowed"]:
            if any(v["reason_code"] != "INFEASIBLE_REGULATORY" for v in body["venue_explanations"]):
                self.fail(rel, "a rejected transaction's venues must all be INFEASIBLE_REGULATORY")
        if policy == "ppo_projected" and not body["policy_notes"]:
            self.fail(rel, "ppo_projected explanations must carry policy_notes (§2.10)")
        if body["semantic_context"] is not None:
            self.fail(rel, "semantic_context must be null in v1 (C6, §2.10)")

    # ------------------------------------------------------------- mapping
    def check_derived(self, rel, fx) -> None:
        derived = fx.get("derived_from")
        if not derived:
            return
        src_rel = derived["fixture"]
        src = self.fixtures.get(src_rel)
        if src is None:
            self.fail(rel, f"derived_from fixture {src_rel} does not exist")
            return
        kind, app_body, eng_body = derived["kind"], fx["response"]["body"], src["response"]["body"]
        if kind == "identity":
            expected = to_app(eng_body)
        elif kind == "meta":
            expected = {**to_app(eng_body), "backendVersion": app_body.get("backendVersion"),
                        "inferenceMode": app_body.get("inferenceMode")}
        elif kind == "transaction":
            expected = {**{k: app_body.get(k) for k in ("id", "createdAt", "createdBy", "status")},
                        "transaction": to_app(eng_body["transaction"]),
                        "failure": None,  # derived from a 200, so routed
                        "decision": to_app({k: v for k, v in eng_body.items() if k != "transaction"})}
            self.check_request_mapping(rel, fx["request"].get("body"), src["request"]["body"], fx["request"]["method"])
        elif kind == "comparison":
            expected = {**{k: app_body.get(k) for k in ("id", "createdAt", "createdBy")},
                        "transaction": to_app(eng_body["results"][0]["transaction"]),
                        "results": [to_app({k: v for k, v in r.items() if k != "transaction"}) for r in eng_body["results"]],
                        "skipped": to_app(eng_body["skipped"]), "sameState": eng_body["same_state"], "note": eng_body["note"]}
            self.check_request_mapping(rel, fx["request"].get("body"), src["request"]["body"], fx["request"]["method"])
        elif kind == "explanation":
            expected = {"transactionId": app_body.get("transactionId"), **to_app(eng_body)}
        elif kind == "error":
            if app_body["error"]["code"] != eng_body["error"]["code"] or fx["response"]["status"] != src["response"]["status"]:
                self.fail(rel, f"passthrough must keep the engine's code and status ({src_rel})")
            if fx["response"]["status"] < 500:
                want = eng_body["error"]["message"][:FORWARDED_MESSAGE_LIMIT]
                if app_body["error"]["message"] != want:
                    self.fail(rel, f"a passed-through 4xx forwards the engine message, truncated to "
                                   f"{FORWARDED_MESSAGE_LIMIT} characters (§4)")
            return
        else:
            self.fail(rel, f"unknown derived_from kind {kind!r}")
            return
        if app_body != expected:
            self.fail(rel, f"not the field-for-field camelCase mapping of {src_rel}: {first_diff(app_body, expected)}")

    def check_request_mapping(self, rel, app_req, eng_req, method) -> None:
        if method != "POST" or app_req is None:
            return
        tx = eng_req["transaction"]
        want = {"senderCountry": tx["sender_country"], "receiverCountry": tx["receiver_country"],
                "amountUsd": tx["amount_usd"], "state": to_app(eng_req["state"])}
        if "policy" in eng_req:
            want["policy"] = to_app(eng_req["policy"], "policy")
        if "policies" in eng_req:
            want["policies"] = to_app(eng_req["policies"], "policies")
        got = {k: v for k, v in app_req.items() if k != "clientReference"}
        if got != want:
            self.fail(rel, f"app request does not map to the engine request: {first_diff(got, want)}")

    # ------------------------------------------------------------- coverage & secrets
    def check_coverage(self) -> None:
        for api in APIS:
            mine = {rel: fx for rel, fx in self.fixtures.items() if rel.startswith(api + "/")}
            for template, item in self.specs[api]["paths"].items():
                for method, op in item.items():
                    if method not in ("get", "post", "put", "patch", "delete"):
                        continue
                    successes = [s for s in op["responses"] if s.startswith("2")]
                    covered = any(fx["request"]["method"].lower() == method
                                  and self.find_operation(api, method, fx["request"]["path"])[0] == template
                                  and str(fx["response"]["status"]) in successes for fx in mine.values())
                    if not covered:
                        self.fail(f"coverage/{api}", f"no success fixture for {method.upper()} {template}")
            optional = set(self.specs[api].get("x-passthrough-codes", []))
            used = {fx["response"]["body"]["error"]["code"] for fx in mine.values()
                    if isinstance(fx["response"]["body"], dict) and "error" in fx["response"]["body"]}
            for code in self.specs[api].get("x-error-status", {}):
                if code not in used and code not in optional:
                    self.fail(f"coverage/{api}", f"no fixture for error code {code}")

    def check_secrets(self) -> None:
        for rel, fx in self.fixtures.items():
            if HEX64_TOKEN.search(json.dumps(fx)):
                self.fail(rel, "contains a 64-hex bearer token; fixtures may only use mock-viewer / mock-analyst")

    def run(self) -> list[str]:
        self.load()
        for rel, fx in self.fixtures.items():
            self.check_fixture(rel, fx)
        for rel, fx in self.fixtures.items():
            self.check_derived(rel, fx)
        self.check_failures()
        self.check_coverage()
        self.check_secrets()
        return self.problems


def first_diff(a, b, path="") -> str:
    if type(a) is not type(b):
        return f"{path or '<root>'}: {a!r} vs expected {b!r}"
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                return f"{path}/{k}: present in only one side"
            if a[k] != b[k]:
                return first_diff(a[k], b[k], f"{path}/{k}")
    if isinstance(a, list):
        if len(a) != len(b):
            return f"{path}: length {len(a)} vs expected {len(b)}"
        for i, (x, y) in enumerate(zip(a, b)):
            if x != y:
                return first_diff(x, y, f"{path}/{i}")
    return f"{path or '<root>'}: {a!r} vs expected {b!r}"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args(argv)
    checker = Checker(args.root)
    problems = checker.run()
    for problem in problems:
        print(f"FAIL {problem}")
    print(f"{len(checker.fixtures)} fixtures, 2 OpenAPI documents: "
          f"{'OK' if not problems else f'{len(problems)} problem(s)'}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
