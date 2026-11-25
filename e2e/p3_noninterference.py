#!/usr/bin/env python3
"""AD-6 T-1 and T-2 on the real D-24 stack (Dev D; docs/PHASE3_AD6_ENGINE_BOUNDARY.md section 8).

  T-1 Non-interference: "the same request with observations absent, normal, extreme, stale, malformed and in outage gives the same
      `decision_id` and the same engine response, on one platform and device."
  T-2 No trigger: "a burst of events with no user request causes zero calls to /v1/route, /v1/compare and /v1/explain."

Evidence is real: the real backend, the real inference engine and the real PostgreSQL of disposable stacks started by
infra/scripts/p3_stack.py, with synthetic events only (T-1 allows nothing else until Gate 3).

  T-1  the same two requests (the contract's waterfall transaction and scenario comparison fixtures) are sent to
       (a) the plain Phase 2 stack, where observations are absent (the stream route is 404), and (b) the observations stack with the
       test-only fake ingestion in each state. The decision (API) and the stored engine response (PostgreSQL, verbatim) of every
       state must equal the baseline, field for field. A different request must differ (sensitivity control).
  T-2  counts of TransactionRequest, RoutingDecision, Comparison, Explanation and AuditLog rows, and the inference service's own access
       log of POST /v1/route, /v1/compare and /v1/explain, are taken before and after a burst of observations with open streams and no
       user action. Positive controls come first: a real routing, comparison and explanation must move every one of those counters.

  python e2e/p3_noninterference.py --up                         both stacks, everything, then remove them
  python e2e/p3_noninterference.py --project P [--absent-project Q]   against stacks made by p3_stack.py (P: up --fault; Q: up --no-observations)
  options: --burst-seconds 60   --root DIR   --keep
Exit status: 0 when every check passed, 1 on any failure, 2 on unusable arguments.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import p3_stream_probe as sp  # noqa: E402  (also puts infra/scripts, the fake ingestion and the nginx harness on sys.path)

p3 = sp.p3
scenarios = sp.scenarios
REPO = sp.REPO
FIXTURES = REPO / "contracts" / "fixtures" / "app"
TX_FIXTURE = "transactions/201_waterfall_replay.json"
CMP_FIXTURE = "comparisons/201_scenario_outage.json"
OTHER_TX_FIXTURE = "transactions/201_cheapest_feasible_partial.json"  # a different request: the sensitivity control
TABLES = ("TransactionRequest", "RoutingDecision", "Comparison", "Explanation", "AuditLog")
CALLS = ("route", "compare", "explain")
ACCESS_LINE = re.compile(r'"(?:GET|POST|PUT|PATCH|DELETE) (/v1/[A-Za-z0-9_/\-]*)[^"]*" (\d{3})')


# --- pure judgement (unit-tested) ---------------------------------------------------------------------------------

def diff(a, b, path: str = "$") -> list:
    """Every difference between two JSON values, as `path: a != b`. Numbers compare exactly: no tolerance."""
    if type(a) is not type(b):
        return [f"{path}: {type(a).__name__} {a!r:.60} != {type(b).__name__} {b!r:.60}"]
    if isinstance(a, dict):
        out = [f"{path}.{k}: missing on one side" for k in sorted(set(a) ^ set(b))]
        for k in sorted(set(a) & set(b)):
            out += diff(a[k], b[k], f"{path}.{k}")
        return out
    if isinstance(a, list):
        if len(a) != len(b):
            return [f"{path}: length {len(a)} != {len(b)}"]
        return [d for i, (x, y) in enumerate(zip(a, b)) for d in diff(x, y, f"{path}[{i}]")]
    return [] if a == b else [f"{path}: {a!r:.60} != {b!r:.60}"]


def parse_counts(text: str) -> dict:
    parts = text.strip().split("|")
    if len(parts) != len(TABLES) or not all(p.isdigit() for p in parts):
        raise ValueError(f"unexpected row-count output {text!r}")
    return dict(zip(TABLES, map(int, parts)))


def parse_inference_log(text: str) -> dict:
    """Counts of the engine endpoints in the inference service's access log. Health and version probes are not engine calls."""
    out = {"route": 0, "compare": 0, "explain": 0, "other": 0}
    for path, _status in ACCESS_LINE.findall(text):
        name = path.rstrip("/").rsplit("/", 1)[-1]
        if path.startswith("/v1/") and name in CALLS and path.count("/") == 2:
            out[name] += 1
        elif name not in ("health", "healthz", "version", "live", "ready"):
            out["other"] += 1
    return out


def control_problems(before: dict, after: dict, expect_up: dict) -> list:
    """A positive control: each named counter must have risen by at least the expected amount, or the measurement cannot see activity."""
    return [f"{k} rose by {after.get(k, 0) - before.get(k, 0)}, expected at least {n}" for k, n in expect_up.items()
            if after.get(k, 0) - before.get(k, 0) < n]


def quiet_problems(before: dict, after: dict, keys) -> list:
    """T-2: every named counter must be exactly unchanged."""
    return [f"{k}: {before[k]} -> {after[k]}" for k in keys if before[k] != after[k]]


# --- real evidence ----------------------------------------------------------------------------------------------

def load_fixture(rel: str) -> dict:
    return json.loads((FIXTURES / rel).read_text(encoding="utf-8"))["request"]["body"]


def api(ctx, method: str, path: str, who: str, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(f"http://{sp.HOST}:{ctx.port}{path}", data=data, method=method,
                                 headers={"Authorization": f"Bearer {ctx.tokens[who]}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


def psql(ctx, sql: str) -> str:
    """One SQL statement in the stack's own PostgreSQL. The statement is a separate argument: no shell quoting is involved."""
    out = ctx.compose("exec", "-T", "postgres", "sh", "-c", 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -c "$1"', "sh", sql, timeout=60)
    if out.returncode != 0:
        raise RuntimeError(f"psql failed: {out.stdout.strip()[:200]}")
    return out.stdout.strip()


def row_counts(ctx) -> dict:
    return parse_counts(psql(ctx, "select " + ", ".join(f'(select count(*) from "{t}")' for t in TABLES)))


def inference_calls(ctx) -> dict:
    cid = ctx.compose("ps", "-a", "-q", "inference").stdout.strip()
    logs = p3.run(["docker", "logs", cid], capture=True, check=False, timeout=60).stdout
    return parse_inference_log(logs)


def snapshot(ctx) -> dict:
    return {**row_counts(ctx), **inference_calls(ctx)}


def collect(ctx, label: str) -> dict:
    """Sends the same two requests and returns what the engine decided: the API decision and the engine responses as stored."""
    status, tx = api(ctx, "POST", "/api/v1/transactions", "analyst", load_fixture(TX_FIXTURE))
    if status != 201:
        raise RuntimeError(f"{label}: POST /transactions gave {status}")
    stored_tx = json.loads(psql(ctx, f"select \"engineResponse\"::text from \"RoutingDecision\" where \"transactionId\" = '{tx['id']}'"))
    status, cmp_ = api(ctx, "POST", "/api/v1/comparisons", "analyst", load_fixture(CMP_FIXTURE))
    if status != 201:
        raise RuntimeError(f"{label}: POST /comparisons gave {status}")
    stored_cmp = json.loads(psql(ctx, f"select \"engineResponse\"::text from \"Comparison\" where id = '{cmp_['id']}'"))
    return {"decision": tx["decision"], "decision_id": tx["decision"]["decisionId"], "route_response": stored_tx, "compare_response": stored_cmp,
            "tx_id": tx["id"]}


def compare_with(ctx, baseline: dict, got: dict, label: str) -> None:
    ctx.check(got["decision_id"] == baseline["decision_id"], f"T-1 {label}: the decision_id is identical", got["decision_id"][:24])
    for key, what in (("decision", "the API decision"), ("route_response", "the stored /v1/route response"), ("compare_response", "the stored /v1/compare response")):
        d = diff(baseline[key], got[key])
        ctx.check(not d, f"T-1 {label}: {what} equals the baseline, field for field", "; ".join(d[:2]))


# --- phases -------------------------------------------------------------------------------------------------------

def t1_absent(ctx) -> dict:
    """The plain stack: the observation route is not registered, and the engine's answer is the baseline for every state."""
    with sp.Response(sp.HOST, ctx.port, sp.PATH, headers={"Authorization": f"Bearer {ctx.tokens['analyst']}"}) as r:
        ctx.check(r.status == 404, "T-1 absent: with observations off the stream route does not exist (404)", f"status {r.status}")
    baseline = collect(ctx, "absent")
    ctx.info(f"baseline decision_id {baseline['decision_id']}; route response {len(json.dumps(baseline['route_response']))} bytes, "
             f"compare response {len(json.dumps(baseline['compare_response']))} bytes")
    return baseline


def wait_state(ctx, obs, scenario: str) -> bool:
    """Waits until the backend has demonstrably taken the scenario in, from what a stream sees. Returns whether it did."""
    if scenario in ("malformed_json", "http:503"):
        # An outage is only announced when the source status changes, so start from a healthy source.
        ctx.fault("normal")
        if obs.wait_frames(lambda f: f["t"] >= time.time() - 0.1 and f["event"] == "update" and sp.status_in(f) == "ok", 8) is None:
            return False
    ctx.fault(scenario)
    t0 = time.time()
    since = lambda f: f["t"] >= t0  # noqa: E731
    if scenario == "normal":
        return obs.wait_frames(lambda f: since(f) and f["event"] == "update" and f["msg"]["value"]["event"]
                               and f["msg"]["value"]["event"]["payload"]["rate"] not in scenarios.EXTREME_RATES, 10) is not None
    if scenario == "extreme":
        return obs.wait_frames(lambda f: since(f) and f["event"] == "update" and f["msg"]["value"]["event"]
                               and f["msg"]["value"]["event"]["payload"]["rate"] in scenarios.EXTREME_RATES, 10) is not None
    if scenario == "stale":
        return obs.wait_frames(lambda f: since(f) and f["event"] == "update" and f["msg"]["value"]["freshness"] == "stale", 12) is not None
    if scenario == "malformed_hash":  # only the first pair is refused: the others keep updating, that pair does not
        time.sleep(7)
        pairs = {sp.pair_of(f["msg"]) for f in obs.snapshot_frames() if f["t"] > t0 + 1 and f["event"] == "update"}
        return pairs == {"EUR/USD", "GBP/PHP", "USD/INR"}
    if scenario in ("malformed_json", "http:503"):
        return sp.wait_status(obs, "outage", 12, t0) is not None
    raise ValueError(scenario)


def t1_states(ctx, baseline: dict) -> None:
    ctx.fault("normal")
    time.sleep(3)
    obs = ctx.open("analyst", "t1-observer")
    ctx.check(obs.status == 200, "T-1: the observer stream opens on the observations stack", f"status {obs.status}")
    for scenario in ("normal", "extreme", "malformed_hash", "malformed_json", "http:503", "stale"):
        if scenario == "stale":
            time.sleep(13)  # nothing newer than the outage's last event may be current, or the 10 s old events would be late and ignored
        ok = wait_state(ctx, obs, scenario)
        ctx.check(ok, f"T-1 {scenario}: the backend is demonstrably in this state before the request", "" if ok else "no evidence on the stream")
        compare_with(ctx, baseline, collect(ctx, scenario), scenario)
    # sensitivity: the comparison is able to fail, because a different request really gives a different decision
    status, other = api(ctx, "POST", "/api/v1/transactions", "analyst", load_fixture(OTHER_TX_FIXTURE))
    ctx.check(status == 201 and other["decision"]["decisionId"] != baseline["decision_id"] and diff(baseline["decision"], other["decision"]),
              "T-1 control: a different request gives a different decision_id and decision, so a difference would be seen",
              other["decision"]["decisionId"][:24] if status == 201 else f"status {status}")
    obs.close()


def t2(ctx, burst_seconds: int) -> None:
    ctx.fault("normal")
    time.sleep(3)
    # Positive controls first: a real route, compare and explain must move every counter this test relies on.
    before = snapshot(ctx)
    status, tx = api(ctx, "POST", "/api/v1/transactions", "analyst", load_fixture(TX_FIXTURE))
    status2, _ = api(ctx, "POST", "/api/v1/comparisons", "analyst", load_fixture(CMP_FIXTURE))
    status3, _ = api(ctx, "GET", f"/api/v1/transactions/{tx['id']}/explanation", "analyst")
    after = snapshot(ctx)
    ctx.check((status, status2, status3) == (201, 201, 200), "T-2 control: a real transaction, comparison and explanation succeed", str((status, status2, status3)))
    problems = control_problems(before, after, {"TransactionRequest": 1, "RoutingDecision": 1, "Comparison": 1, "Explanation": 1, "AuditLog": 3,
                                                "route": 1, "compare": 1, "explain": 1})
    ctx.check(not problems, "T-2 control: the row counts and the inference access log both see a real route, compare and explain",
              "; ".join(problems) or f"+{after['TransactionRequest'] - before['TransactionRequest']} tx, +{after['Comparison'] - before['Comparison']} cmp, "
              f"+{after['Explanation'] - before['Explanation']} explanation, +{after['AuditLog'] - before['AuditLog']} audit rows; inference "
              f"route +{after['route'] - before['route']}, compare +{after['compare'] - before['compare']}, explain +{after['explain'] - before['explain']}")
    # The burst: events in every state, with several streams open, and no request from any user.
    quiet_before = snapshot(ctx)
    streams = [ctx.open("analyst", f"t2-burst{i}") for i in range(3)]
    plan = (("normal", 0.15), ("extreme", 0.15), ("malformed_hash", 0.15), ("http:503", 0.15), ("malformed_json", 0.1), ("normal", 0.3))
    for scenario, share in plan:
        ctx.fault(scenario)
        time.sleep(max(2.0, burst_seconds * share))
    ctx.fault("normal")
    time.sleep(3)
    quiet_after = snapshot(ctx)
    frames = sum(len(s.snapshot_frames()) for s in streams)
    updates = sum(1 for s in streams for f in s.snapshot_frames() if f["event"] == "update")
    ctx.check(all(s.status == 200 for s in streams) and updates >= 30,
              "T-2: the burst was real: events reached the open streams", f"{updates} updates and {frames} frames over {len(streams)} streams")
    ctx.check(not quiet_problems(quiet_before, quiet_after, TABLES), "T-2: the Transaction, Comparison, Explanation, RoutingDecision and AuditLog row counts are unchanged",
              "; ".join(quiet_problems(quiet_before, quiet_after, TABLES)) or ", ".join(f"{t} {quiet_after[t]}" for t in TABLES))
    ctx.check(not quiet_problems(quiet_before, quiet_after, CALLS), "T-2: zero calls to /v1/route, /v1/compare and /v1/explain during the burst",
              "; ".join(quiet_problems(quiet_before, quiet_after, CALLS)) or f"route {quiet_after['route']}, compare {quiet_after['compare']}, explain {quiet_after['explain']} (unchanged)")
    ctx.info(f"other non-health inference requests during the burst: {quiet_after['other'] - quiet_before['other']}")
    for s in streams:
        s.close()


# --- orchestration ----------------------------------------------------------------------------------------------

def finish(contexts) -> int:
    passed = sum(c.passed for c in contexts)
    failed = [n for c in contexts for n in c.failed]
    print(f"\n{passed} passed, {len(failed)} failed, {sum(c.skipped for c in contexts)} skipped", flush=True)
    for name in failed:
        print(f"  failed: {name}")
    return 1 if failed else 0


def run_on(state_a: dict, state_b: dict, burst: int) -> int:
    a, b = sp.make_ctx(state_a), sp.make_ctx(state_b)
    print("\n== T-1 absent (the plain Phase 2 stack)", flush=True)
    baseline = None
    try:
        baseline = t1_absent(a)
    except Exception as e:  # noqa: BLE001 - a crash is a failed check, never a skip
        a.check(False, "T-1 absent: the phase crashed", f"{type(e).__name__}: {str(e)[:200]}")
    phases = [("T-2", lambda: t2(b, burst))]
    if baseline is not None:
        phases.insert(0, ("T-1 states (the observations stack)", lambda: t1_states(b, baseline)))
    for name, fn in phases:
        print(f"\n== {name}", flush=True)
        try:
            fn()
        except Exception as e:  # noqa: BLE001
            b.check(False, f"{name}: the phase crashed", f"{type(e).__name__}: {str(e)[:200]}")
    return finish([a, b])


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--project", help="the observations stack (p3_stack.py up --fault)")
    ap.add_argument("--absent-project", help="the plain stack (p3_stack.py up --no-observations)")
    ap.add_argument("--up", action="store_true")
    ap.add_argument("--root", type=Path, default=p3.default_root())
    ap.add_argument("--burst-seconds", type=int, default=60)
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args(argv)
    if args.up == bool(args.project) or bool(args.project) != bool(args.absent_project) and not args.up or args.burst_seconds < 10:
        print("choose --up, or --project together with --absent-project; --burst-seconds is at least 10", file=sys.stderr)
        return 2
    started = []
    try:
        if args.up:
            state_a = p3.up(args.root, None, False, 0, False)
            started.append(state_a)
            state_b = p3.up(args.root, None, True, 0, True)
            started.append(state_b)
        else:
            state_a, state_b = p3.load_state(args.root, args.absent_project), p3.load_state(args.root, args.project)
        return run_on(state_a, state_b, args.burst_seconds)
    except p3.HarnessError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    finally:
        if not args.keep:
            for state in started:
                p3.cleanup(state, args.root)


if __name__ == "__main__":
    sys.exit(main())
