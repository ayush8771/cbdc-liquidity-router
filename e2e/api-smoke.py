#!/usr/bin/env python3
"""API smoke test for the running Phase 2 stack (arch §4, §5.4). Standard library only.

Every request body comes from the contract fixtures in contracts/fixtures/app (each fixture's
`request.body`); no route or body is invented here. Responses are checked against the contract's
status codes and error codes, and against the fixture's key names. Tokens are read from a JSON file
(never from the command line or the environment) and are scrubbed from everything printed.

  python3 e2e/api-smoke.py --tokens-file <file> [--base-url http://127.0.0.1:8080]

The tokens file is {"analyst": {"userId": "...", "token": "..."}, "viewer": {"userId": "...", "token": "..."}}.
The stack must be running and seeded (the seed creates the User rows that creating a transaction needs).
Exit code 0 only if every check passes; 2 if the arguments or the tokens file are unusable.

The script POSTs transactions and comparisons, so it only talks to a loopback address unless
--allow-remote is given. It never contacts anything but --base-url.

CURRENT-CONFIGURATION ASSUMPTION: ppoProjected is disabled. The stack runs with an empty
services/inference/config/approved_checkpoints.json and no checkpoint mounted, so three checks expect
that: GET /meta reports ppoProjected enabled=false and checkpoint=null; the comparison fixture's
`skipped` entry is ppoProjected / POLICY_DISABLED; and an analyst requesting ppoProjected gets 409
POLICY_DISABLED. If a checkpoint is ever approved and mounted, those three checks (marked ASSUMPTION
below) must be updated together with the comparison fixture's expected `skipped` list.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "contracts" / "fixtures" / "app"


class Smoke:
    def __init__(self, base_url: str, tokens: dict, timeout: float):
        self.base = base_url.rstrip("/")
        self.timeout = timeout
        self.tokens = tokens
        self.secrets = [v["token"] for v in tokens.values()]
        self.state: dict = {}
        self.failures: list[str] = []
        self.passed = 0

    # -- output ------------------------------------------------------------------------------
    def scrub(self, text: str) -> str:
        for s in self.secrets:
            if s:
                text = text.replace(s, "***")
        return text

    def say(self, text: str) -> None:
        print(self.scrub(text), flush=True)

    # -- http --------------------------------------------------------------------------------
    def call(self, method: str, path: str, who: str | None = None, body=None, token: str | None = None):
        headers = {"Accept": "application/json"}
        bearer = token if token is not None else (self.tokens[who]["token"] if who else None)
        if bearer is not None:
            headers["Authorization"] = "Bearer " + bearer
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    @staticmethod
    def json(raw: bytes):
        try:
            return json.loads(raw)
        except ValueError:
            return None

    def api(self, method, path, who=None, body=None, token=None):
        status, headers, raw = self.call(method, path, who, body, token)
        return status, headers, self.json(raw), raw

    # -- fixtures ----------------------------------------------------------------------------
    @staticmethod
    def fixture(rel: str) -> dict:
        return json.loads((FIXTURES / rel).read_text(encoding="utf-8"))

    def request_body(self, rel: str):
        return self.fixture(rel)["request"]["body"]

    # -- runner ------------------------------------------------------------------------------
    def check(self, name: str, fn) -> None:
        try:
            detail = fn() or ""
            self.passed += 1
            self.say(f"PASS  {name}" + (f"  ({detail})" if detail else ""))
        except AssertionError as e:
            self.failures.append(name)
            self.say(f"FAIL  {name}: {e}")
        except Exception as e:  # network error, unexpected shape: report it, keep going
            self.failures.append(name)
            self.say(f"FAIL  {name}: {type(e).__name__}: {e}")


def need(cond, message):
    if not cond:
        raise AssertionError(message)


def code_of(body) -> str | None:
    return ((body or {}).get("error") or {}).get("code") if isinstance(body, dict) else None


def has_keys(actual, expected_from_fixture, where: str) -> None:
    missing = sorted(set(expected_from_fixture) - set(actual))
    need(not missing, f"{where} lacks the contract fields {missing}")


def run(s: Smoke) -> None:
    analyst, viewer = s.tokens["analyst"]["userId"], s.tokens["viewer"]["userId"]

    # --- health, through nginx ---
    def healthz():
        st, h, raw = s.call("GET", "/healthz")
        need(st == 200 and raw.strip() == b"ok", f"expected 200 ok, got {st}")
    s.check("nginx /healthz", healthz)

    def live():
        st, _, b, _ = s.api("GET", "/api/v1/health/live")
        need(st == 200 and b == {"status": "ok"}, f"expected 200 {{'status': 'ok'}}, got {st} {b}")
    s.check("backend liveness through nginx", live)

    def health():
        st, _, b, _ = s.api("GET", "/api/v1/health")
        need(st == 200, f"expected 200, got {st}")
        for k, v in (("status", "ok"), ("database", "ok"), ("inference", "ok"), ("authMode", "dev")):
            need(b.get(k) == v, f"health.{k} is {b.get(k)!r}, expected {v!r}")
    s.check("backend health through nginx (database and inference ok)", health)

    # --- authentication ---
    for who, uid in (("analyst", analyst), ("viewer", viewer)):
        def me(who=who, uid=uid):
            st, _, b, _ = s.api("GET", "/api/v1/auth/me", who)
            need(st == 200, f"expected 200, got {st} {code_of(b)}")
            need(b.get("role") == who and b.get("userId") == uid, f"unexpected identity {b.get('userId')!r} / {b.get('role')!r}")
            return f"{who}"
        s.check(f"GET /auth/me as {who}", me)

    # --- read-only reads ---
    def meta():
        st, _, b, _ = s.api("GET", "/api/v1/meta", "analyst")
        need(st == 200, f"expected 200, got {st}")
        has_keys(b, s.fixture("meta/200_meta.json")["response"]["body"], "meta")
        enabled = {p["policy"]: p["enabled"] for p in b["policies"]}
        need(enabled.get("waterfall") is True and enabled.get("cheapestFeasible") is True, f"baseline policies not enabled: {enabled}")
        # ASSUMPTION: no approved checkpoint in this stack (see the module docstring).
        need(enabled.get("ppoProjected") is False and b.get("checkpoint") is None, "ppoProjected must be disabled (no approved checkpoint)")
    s.check("GET /meta (ppoProjected disabled)", meta)

    def network():
        st, _, b, _ = s.api("GET", "/api/v1/network", "analyst")
        need(st == 200, f"expected 200, got {st}")
        has_keys(b, s.fixture("meta/200_network.json")["response"]["body"], "network")
        need(isinstance(b["corridors"], list) and b["corridors"], "no corridors")
        return f"{len(b['corridors'])} corridors"
    s.check("GET /network", network)

    # --- transaction: create, retrieve, list, explain ---
    def create():
        want = s.fixture("transactions/201_waterfall_replay.json")["response"]["body"]
        st, _, b, _ = s.api("POST", "/api/v1/transactions", "analyst", s.request_body("transactions/201_waterfall_replay.json"))
        need(st == 201, f"expected 201, got {st} {code_of(b)} (500 means the users were not seeded)")
        has_keys(b, want, "transaction")
        has_keys(b["decision"], want["decision"], "transaction.decision")
        need(b["status"] == "routed", f"status {b['status']!r}")
        need(b["createdBy"] == analyst, f"createdBy {b['createdBy']!r}")
        need(b["decision"]["policy"] == want["decision"]["policy"], f"policy {b['decision']['policy']!r}")
        need(b["decision"]["allocations"], "no allocations")
        s.state["tid"], s.state["decision_id"] = b["id"], b["decision"]["decisionId"]
        return f"{len(b['decision']['allocations'])} allocations"
    s.check("POST /transactions (waterfall replay fixture, analyst)", create)

    def retrieve():
        need("tid" in s.state, "no transaction was created")
        st, _, b, _ = s.api("GET", f"/api/v1/transactions/{s.state['tid']}", "analyst")
        need(st == 200 and b["id"] == s.state["tid"] and b["status"] == "routed", f"expected the routed transaction, got {st}")
    s.check("GET /transactions/{id}", retrieve)

    def listing():
        need("tid" in s.state, "no transaction was created")
        st, _, b, _ = s.api("GET", "/api/v1/transactions?pageSize=10", "analyst")
        need(st == 200, f"expected 200, got {st}")
        need(any(i["id"] == s.state["tid"] for i in b["items"]), "the created transaction is not in the list")
        return f"total {b.get('total')}"
    s.check("GET /transactions (list contains it)", listing)

    def explanation():
        need("tid" in s.state, "no transaction was created")
        st, _, b, _ = s.api("GET", f"/api/v1/transactions/{s.state['tid']}/explanation", "analyst")
        need(st == 200, f"expected 200, got {st} {code_of(b)}")
        has_keys(b, s.fixture("transactions/200_explanation_waterfall.json")["response"]["body"], "explanation")
        need(b["decisionId"] == s.state["decision_id"], "explanation decisionId differs from the routed decision")
    s.check("GET /transactions/{id}/explanation (same decisionId)", explanation)

    # --- comparison: create, retrieve ---
    def compare():
        want = s.fixture("comparisons/201_scenario_outage.json")["response"]["body"]
        st, _, b, _ = s.api("POST", "/api/v1/comparisons", "analyst", s.request_body("comparisons/201_scenario_outage.json"))
        need(st == 201, f"expected 201, got {st} {code_of(b)}")
        has_keys(b, want, "comparison")
        need([r["policy"] for r in b["results"]] == [r["policy"] for r in want["results"]], "unexpected result policies")
        # ASSUMPTION: ppoProjected is disabled, so it is skipped with POLICY_DISABLED (see the module docstring).
        need([(x["policy"], x["code"]) for x in b["skipped"]] == [(x["policy"], x["code"]) for x in want["skipped"]], f"unexpected skipped {b['skipped']}")
        need(b["sameState"] is True, "sameState is not true")
        s.state["cid"] = b["id"]
    s.check("POST /comparisons (outage scenario fixture; ppoProjected skipped)", compare)

    def get_compare():
        need("cid" in s.state, "no comparison was created")
        st, _, b, _ = s.api("GET", f"/api/v1/comparisons/{s.state['cid']}", "analyst")
        need(st == 200 and b["id"] == s.state["cid"], f"expected the comparison, got {st}")
    s.check("GET /comparisons/{id}", get_compare)

    # --- rejected requests ---
    def unauth(label, **kw):
        st, _, b, _ = s.api(kw.get("method", "GET"), kw.get("path", "/api/v1/auth/me"), None, kw.get("body"), kw.get("token"))
        need(st == 401 and code_of(b) == "UNAUTHENTICATED", f"expected 401 UNAUTHENTICATED, got {st} {code_of(b)}")
    s.check("401 with no token", lambda: unauth("none"))
    s.check("401 with a wrong (well-formed) token", lambda: unauth("wrong", token="0" * 64))
    s.check("401 with a malformed token", lambda: unauth("malformed", token="not-a-token"))
    s.check("401 creating a transaction with no token", lambda: unauth("post", method="POST", path="/api/v1/transactions", body=s.request_body("transactions/201_waterfall_replay.json")))

    def viewer_forbidden():
        fx = s.fixture("errors/403_forbidden_policy_transaction.json")
        st, _, b, _ = s.api("POST", "/api/v1/transactions", "viewer", fx["request"]["body"])
        need(st == fx["response"]["status"] and code_of(b) == code_of(fx["response"]["body"]), f"expected {fx['response']['status']} {code_of(fx['response']['body'])}, got {st} {code_of(b)}")
    s.check("viewer requesting ppoProjected is forbidden", viewer_forbidden)

    def analyst_disabled():
        # ASSUMPTION: ppoProjected is disabled in this stack (see the module docstring).
        fx = s.fixture("errors/409_policy_disabled_passthrough.json")
        st, _, b, _ = s.api("POST", "/api/v1/transactions", "analyst", fx["request"]["body"])
        need(st == fx["response"]["status"] and code_of(b) == code_of(fx["response"]["body"]), f"expected {fx['response']['status']} {code_of(fx['response']['body'])}, got {st} {code_of(b)}")
    s.check("analyst requesting disabled ppoProjected is rejected", analyst_disabled)

    # --- the single-page app, served by nginx ---
    def spa(path):
        st, h, raw = s.call("GET", path)
        need(st == 200 and "text/html" in (h.get("Content-Type") or "") and b'id="root"' in raw, f"expected the app shell, got {st} {h.get('Content-Type')}")
    s.check("SPA shell at /", lambda: spa("/"))
    s.check("SPA deep link /transactions/<id> falls back to the app", lambda: spa(f"/transactions/{s.state.get('tid', 'unknown-id')}"))


def wait_for_web(s: Smoke, seconds: float) -> None:
    end = time.time() + seconds
    while True:
        try:
            if s.call("GET", "/healthz")[0] == 200:
                return
        except OSError:
            pass
        if time.time() >= end:
            return  # the first check reports the real failure
        time.sleep(2)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--tokens-file", required=True, help="JSON file with the analyst and viewer userId and token")
    ap.add_argument("--base-url", default="http://127.0.0.1:8080")
    ap.add_argument("--timeout", type=float, default=60.0, help="seconds per request")
    ap.add_argument("--wait", type=float, default=60.0, help="seconds to wait for /healthz before the first check")
    ap.add_argument("--allow-remote", action="store_true", help="allow a base URL that is not a loopback address")
    args = ap.parse_args(argv)
    host = urllib.parse.urlparse(args.base_url).hostname
    if host not in ("127.0.0.1", "localhost", "::1") and not args.allow_remote:
        print(f"refusing to run against {host!r}: this test creates data, so it only targets a loopback address (use --allow-remote to override)", file=sys.stderr)
        return 2
    try:
        tokens = json.loads(Path(args.tokens_file).read_text(encoding="utf-8"))
        assert all(isinstance(tokens[w]["token"], str) and isinstance(tokens[w]["userId"], str) for w in ("analyst", "viewer"))
    except (OSError, ValueError, KeyError, TypeError, AssertionError) as e:
        print(f"cannot use the tokens file ({type(e).__name__}); it must hold analyst and viewer entries with userId and token", file=sys.stderr)
        return 2
    s = Smoke(args.base_url, tokens, args.timeout)
    wait_for_web(s, args.wait)
    run(s)
    s.say(f"\n{s.passed} passed, {len(s.failures)} failed")
    for name in s.failures:
        s.say(f"  failed: {name}")
    return 1 if s.failures else 0


if __name__ == "__main__":
    sys.exit(main())
