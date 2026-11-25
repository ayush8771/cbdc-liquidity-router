#!/usr/bin/env python3
"""Authenticated SSE through Nginx on the disposable D-24 stack (Dev D; AD-1 v0.5 section 3.2, 3.3, 3.5, 3.6 [P-7], 3.7, C-2).

Drives GET /api/rt/v1/observations/stream through the PUBLISHED web port, with development tokens, against a stack started
by infra/scripts/p3_stack.py with the test-only fake ingestion (--fault --load-users 7). Every frame it receives is judged by
the shared checker (infra/scripts/check_event_contracts.py): the same schema and semantic rules as the contract fixtures.

  python e2e/p3_stream_probe.py --up                     start a disposable stack, run everything, remove it
  python e2e/p3_stream_probe.py --project cbdc-p3s-XXXX  run against a stack made by `p3_stack.py up --fault --load-users 7`
  options: --only auth,soak,quiet,limits,faults,restart,sigterm   --soak-seconds 300   --quiet-seconds 75   --keep   --root DIR

Phases (each prints PASS / FAIL / INFO / SKIP lines; nothing is skipped silently):
  auth     401 before everything, 405, 422, headers, an immediate snapshot, Last-Event-ID ignored
  soak     a continuous stream: consecutive stream_seq, updates and heartbeats at their cadence, p95 delivery latency <= 1 s
  quiet    a stream with no updates survives longer than 60 s on heartbeats alone
  limits   3 streams per user and 20 in total (429 STREAM_LIMIT, Retry-After 5), the slot freed after a client abort
  faults   every fake-ingestion scenario: source status outage and recovery, freshness fresh -> stale -> unavailable and back
  restart  a real backend restart: Nginx recovers, a new stream starts, reconnect <= 5 s from the moment the backend is reachable
  sigterm  docker stop with active streams: streams end, exit 0, within the 10 s forced-exit grace
Exit status: 0 when every check passed, 1 on any failure, 2 on unusable arguments.

Latency is arrival minus the event's emitted_at. The fake service (in the Docker VM) and this probe (on the host) may not share a
clock, so the VM clock's offset is measured and applied, and both the raw and the corrected figures are printed. Requests are made
with raw sockets (infra/testing/nginx_sse/sse_probe.py) and Docker with Python subprocess calls, so no shell rewrites a path.
"""
from __future__ import annotations

import argparse
import calendar
import json
import math
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "infra" / "scripts"))
sys.path.insert(0, str(REPO / "infra" / "testing" / "nginx_sse"))
sys.path.insert(0, str(REPO / "infra" / "testing" / "fault_ingestion"))
sys.path.insert(0, str(REPO / "services" / "ingestion"))

import check_event_contracts as cec  # noqa: E402
import p3_stack as p3  # noqa: E402
import scenarios  # noqa: E402
from sse_probe import Response  # noqa: E402

PATH = "/api/rt/v1/observations/stream"
HOST = "127.0.0.1"
HEARTBEAT_S = 15
STALE_MS, UNAVAILABLE_MS = 6000, 30000          # AD-1 section 3.2 profile
P95_BUDGET_MS = 1000                            # AD-1 section 3 (AD-8): display p95 <= 1 s from emitted_at
RECONNECT_BUDGET_MS = 5000                      # AD-1 section 3 (AD-9): reconnect p95 <= 5 s through Nginx
SHUTDOWN_GRACE_MS = 10000                       # lifecycle.ts SHUTDOWN_TIMEOUT_MS
PER_USER, TOTAL = 3, 20                         # AD-1 section 3.5
PHASES = ("auth", "soak", "quiet", "limits", "faults", "restart", "sigterm")


# --- pure helpers (unit-tested) ---------------------------------------------------------------------------------

def percentile(values, p: float) -> float:
    """Nearest-rank percentile: the smallest value with at least p percent of the values at or below it."""
    if not values:
        raise ValueError("no values")
    ordered = sorted(values)
    return ordered[max(0, math.ceil(p / 100 * len(ordered)) - 1)]


def epoch_ms(timestamp: str) -> int:
    parsed = cec.parse_ts(timestamp)
    if parsed is None:
        raise ValueError(f"not an AD-4 timestamp: {timestamp!r}")
    return calendar.timegm(parsed.timetuple()) * 1000 + parsed.microsecond // 1000


def update_latencies(frames, skew_ms: float = 0.0) -> list:
    """Delivery latency of every update that carries an event: arrival - emitted_at, corrected by the VM-minus-host clock skew."""
    out = []
    for f in frames:
        msg = f["msg"]
        if f["event"] == "update" and isinstance(msg, dict) and msg.get("value", {}).get("event"):
            emitted = epoch_ms(msg["value"]["event"]["timestamps"]["emitted_at"])
            out.append(f["t"] * 1000 - emitted + skew_ms)
    return out


def skew_from_frames(frames):
    """VM-minus-host clock skew in ms, from the stream itself. Express stamps `server_time` just before it writes a frame, so
    arrival - server_time = delivery delay - skew, and its minimum over many frames is -skew plus the smallest delivery delay (a few ms
    on loopback). Returns None without frames carrying a server_time."""
    deltas = []
    for f in frames:
        msg = f["msg"]
        if isinstance(msg, dict) and isinstance(msg.get("server_time"), str):
            deltas.append(f["t"] * 1000 - epoch_ms(msg["server_time"]))
    return -min(deltas) if deltas else None


def frame_problems(checker, validators, frames) -> list:
    """Shared-checker verdict on every frame, plus type = SSE event name and consecutive stream_seq from 1 on a snapshot."""
    out, last = [], 0
    for i, f in enumerate(frames):
        msg, where = f["msg"], f"{f['connection']} frame {i} ({f['event']})"
        if not isinstance(msg, dict):
            out.append(f"{where}: data is not a JSON object")
            continue
        out += [f"{where}: {p}" for p in checker.verdict(validators, "stream-message", {"instance": msg})]
        if msg.get("type") != f["event"]:
            out.append(f"{where}: type {msg.get('type')!r} differs from the SSE event name")
        if i == 0 and f["event"] != "snapshot":
            out.append(f"{where}: the first frame is not a snapshot")
        if msg.get("stream_seq") != last + 1:
            out.append(f"{where}: stream_seq {msg.get('stream_seq')!r} is not {last + 1}")
        last = msg.get("stream_seq") if isinstance(msg.get("stream_seq"), int) else last + 1
    return out


def pair_of(msg: dict) -> str:
    v = msg["value"]
    return f"{v['base_currency']}/{v['quote_currency']}"


# --- connections ------------------------------------------------------------------------------------------------

class Stream:
    """One authenticated stream. A reader thread keeps every frame with its arrival time; nothing is dropped."""

    def __init__(self, ctx, who: str, label: str, path: str = PATH, headers: dict | None = None):
        self.label, self.frames, self.lock = label, [], threading.Lock()
        self.done, self.closed_at = threading.Event(), None
        token = ctx.tokens[who]
        self.resp = Response(HOST, ctx.port, path, headers={"Authorization": f"Bearer {token}", **(headers or {})}, timeout=10)
        self.status, self.headers = self.resp.status, self.resp.headers
        self.opened_at = self.resp.sent_at
        if self.status == 200:
            threading.Thread(target=self._run, daemon=True).start()
        else:
            self.done.set()
        ctx.streams.append(self)

    def _run(self) -> None:
        try:
            for t, name, data in self.resp.events(time.time() + 86400):
                try:
                    msg = json.loads(data)
                except ValueError:
                    msg = data
                with self.lock:
                    self.frames.append({"connection": self.label, "event": name, "msg": msg, "t": t})
        except Exception:  # noqa: BLE001 - a reset socket is an ordinary end of stream here
            pass
        finally:
            self.closed_at = time.time()
            self.done.set()

    def snapshot_frames(self) -> list:
        with self.lock:
            return list(self.frames)

    def wait_frames(self, predicate, timeout: float):
        """The first frame (arrival order) satisfying predicate, waiting up to timeout seconds; None on timeout or close."""
        deadline, seen = time.time() + timeout, 0
        while True:
            frames = self.snapshot_frames()
            for f in frames[seen:]:
                if predicate(f):
                    return f
            seen = len(frames)
            if self.done.is_set() or time.time() >= deadline:
                return None
            time.sleep(0.05)

    def is_open(self) -> bool:
        return not self.done.is_set()

    def close(self) -> None:
        self.resp.close()
        self.done.wait(3)


def status_in(f) -> str | None:
    msg = f["msg"]
    return msg.get("source", {}).get("status") if isinstance(msg, dict) else None


# --- context ---------------------------------------------------------------------------------------------------

class Ctx:
    def __init__(self, state: dict, tokens: dict, checker, validators, skew_ms: float | None = None):
        self.state, self.port = state, state["port"]
        self.tokens = {name: v["token"] for name, v in tokens.items()}
        self.checker, self.validators = checker, validators
        self.streams, self.passed, self.failed, self.skipped = [], 0, [], 0
        self._skew = skew_ms

    # reporting
    def check(self, ok: bool, name: str, detail: str = "") -> bool:
        print(f"{'PASS' if ok else 'FAIL'} {name}" + (f": {detail}" if detail else ""), flush=True)
        if ok:
            self.passed += 1
        else:
            self.failed.append(name)
        return ok

    def info(self, text: str) -> None:
        print(f"INFO {text}", flush=True)

    def skip(self, name: str, why: str) -> None:
        self.skipped += 1
        print(f"SKIP {name}: {why}", flush=True)

    # docker, always as argument lists (never through a shell)
    def compose(self, *args, timeout=180):
        return p3.run(p3.compose_args(self.state) + list(args), env=p3.compose_env(self.state), capture=True, check=False, timeout=timeout)

    def fault(self, scenario: str) -> None:
        p3.set_fault(self.state, scenario)

    def skew_ms(self) -> float:
        """VM clock minus host clock, from the median of three `Date.now()` samples taken inside the backend container."""
        if self._skew is None:
            samples = []
            for _ in range(3):
                t0 = time.time() * 1000
                out = self.compose("exec", "-T", "backend", "node", "-e", "console.log(Date.now())", timeout=60).stdout.strip().splitlines()
                t1 = time.time() * 1000
                if out and out[-1].isdigit():
                    samples.append(int(out[-1]) - (t0 + t1) / 2)
            self._skew = statistics.median(samples) if samples else 0.0
        return self._skew

    def open(self, who: str, label: str, **kw) -> Stream:
        return Stream(self, who, f"{label}#{len(self.streams)}", **kw)

    def request(self, method: str, path: str, who: str | None = None, headers: dict | None = None):
        h = dict(headers or {})
        if who:
            h["Authorization"] = f"Bearer {self.tokens[who]}"
        if method == "POST":
            h["Content-Length"] = "0"
        with Response(HOST, self.port, path, method=method, headers=h, timeout=10) as r:
            body = b"" if method == "HEAD" else r.body(5)
            return r.status, r.headers, body

    def error_code(self, body: bytes) -> str | None:
        try:
            return json.loads(body).get("error", {}).get("code")
        except (ValueError, AttributeError):
            return None


# --- phases -----------------------------------------------------------------------------------------------------

def phase_auth(ctx: Ctx) -> None:
    for name, who in (("no token", None), ("a wrong token", "bogus")):
        if who:
            ctx.tokens["bogus"] = "0" * 64
        s, h, b = ctx.request("GET", PATH, who)
        ctx.check(s == 401 and ctx.error_code(b) == "UNAUTHENTICATED" and h.get("content-type", "").startswith("application/json"),
                  f"auth: {name} is 401 UNAUTHENTICATED with a JSON envelope", f"status {s}, code {ctx.error_code(b)}")
    s, _h, b = ctx.request("POST", PATH, None)
    ctx.check(s == 401, "auth: authentication is checked before the method (POST without a token is 401)", f"status {s}")
    s, h, b = ctx.request("POST", PATH, "analyst")
    ctx.check(s == 405 and ctx.error_code(b) == "METHOD_NOT_ALLOWED" and h.get("allow") == "GET", "auth: POST is 405 with Allow: GET", f"status {s}, allow {h.get('allow')}")
    s, h, _b = ctx.request("HEAD", PATH, "analyst")
    ctx.check(s == 405, "auth: HEAD is 405", f"status {s}")
    s, _h, b = ctx.request("GET", PATH + "?x=1", "analyst")
    ctx.check(s == 422 and ctx.error_code(b) == "VALIDATION_ERROR", "auth: any query string is 422 VALIDATION_ERROR", f"status {s}")
    st = ctx.open("analyst", "auth", headers={"Last-Event-ID": "99"})
    ctx.check(st.status == 200, "auth: a valid token opens the stream (200)", f"status {st.status}")
    ctx.check(st.headers.get("content-type") == "text/event-stream; charset=utf-8", "auth: Content-Type text/event-stream; charset=utf-8", st.headers.get("content-type", ""))
    ctx.check(st.headers.get("cache-control") == "no-store, no-transform", "auth: Cache-Control no-store, no-transform", st.headers.get("cache-control", ""))
    ctx.info(f"X-Accel-Buffering reaches the client as {st.headers.get('x-accel-buffering')!r} (Nginx consumes it)")
    first = st.wait_frames(lambda f: True, 3)
    ms = (first["t"] - st.opened_at) * 1000 if first else None
    ctx.check(first is not None and first["event"] == "snapshot" and first["msg"].get("stream_seq") == 1 and ms <= 1000,
              "auth: the first message is the snapshot at stream_seq 1, within 1 s of the request (Last-Event-ID is ignored)",
              f"{ms:.0f} ms" if ms is not None else "no frame")
    if first:
        ctx.check(len(first["msg"].get("values", [])) == 4, "auth: the snapshot carries exactly 4 values")
    st.close()


def phase_soak(ctx: Ctx, seconds: int) -> None:
    ctx.fault("normal")
    time.sleep(3)
    st = ctx.open("analyst", "soak")
    ctx.check(st.status == 200, "soak: the stream opens", f"status {st.status}")
    if st.status != 200:
        return
    end = time.time() + seconds
    while time.time() < end and st.is_open():
        time.sleep(1)
    survived = st.is_open()
    frames = st.snapshot_frames()
    ctx.check(survived, f"soak: the stream stayed open for {seconds} s")
    problems = frame_problems(ctx.checker, ctx.validators, frames)
    ctx.check(not problems, f"soak: all {len(frames)} frames pass the shared checker with consecutive stream_seq", "; ".join(problems[:3]))
    updates = [f for f in frames if f["event"] == "update"]
    beats = [f for f in frames if f["event"] == "heartbeat"]
    expected = 2 * seconds  # 4 pairs, each every 2 s
    ctx.check(len(updates) >= 0.9 * expected, f"soak: updates arrive at about 2 per second ({len(updates)} in {seconds} s, expected about {expected})")
    per_pair = {}
    for u in updates:
        per_pair[pair_of(u["msg"])] = per_pair.get(pair_of(u["msg"]), 0) + 1
    ctx.check(len(per_pair) == 4 and min(per_pair.values()) >= 0.9 * seconds / 2, "soak: every pair updates about every 2 s", str(per_pair))
    gaps = [b["t"] - a["t"] for a, b in zip(updates, updates[1:])]
    ctx.check(not gaps or max(gaps) <= 3.0, "soak: no gap between updates longer than 3 s", f"max {max(gaps):.2f} s" if gaps else "")
    ctx.check(len(beats) >= max(0, seconds // HEARTBEAT_S - 1), f"soak: heartbeats arrive about every {HEARTBEAT_S} s ({len(beats)} in {seconds} s)")
    spacing = [b["t"] - a["t"] for a, b in zip(beats, beats[1:])]
    ctx.check(not spacing or all(HEARTBEAT_S - 2 <= g <= HEARTBEAT_S + 3 for g in spacing), "soak: heartbeat spacing is 15 s +- a small tolerance",
              f"{min(spacing):.1f}-{max(spacing):.1f} s" if spacing else "")
    raw = update_latencies(frames)
    skew = skew_from_frames(frames)
    exec_skew = ctx.skew_ms()
    if skew is None:
        skew = exec_skew
    fixed = update_latencies(frames, skew)
    if fixed:
        p95 = percentile(fixed, 95)
        ctx.info(f"delivery latency over {len(fixed)} updates: raw p50 {percentile(raw, 50):.0f} / p95 {percentile(raw, 95):.0f} ms; "
                 f"VM clock is {skew:+.0f} ms from the host (from the stream's own server_time; the coarser docker-exec reading says {exec_skew:+.0f} ms); "
                 f"corrected p50 {percentile(fixed, 50):.0f} / p95 {p95:.0f} / max {max(fixed):.0f} ms")
        ctx.info(f"for comparison, p95 with the docker-exec skew: {percentile(update_latencies(frames, exec_skew), 95):.0f} ms")
        ctx.check(p95 <= P95_BUDGET_MS, f"soak: p95 delivery latency (clock-corrected) is at most {P95_BUDGET_MS} ms", f"{p95:.0f} ms")
    else:
        ctx.check(False, "soak: there were updates to measure")
    st.close()


def phase_quiet(ctx: Ctx, seconds: int) -> None:
    ctx.fault("empty")  # a valid success with no events: nothing to update
    time.sleep(3)
    st = ctx.open("analyst", "quiet")
    start = time.time()
    while time.time() - start < seconds and st.is_open():
        time.sleep(1)
    frames = st.snapshot_frames()
    held = time.time() - start
    ctx.check(st.is_open() and held >= seconds, f"quiet: the stream is still open after {held:.0f} s (limit to beat: 60 s)")
    kinds = [f["event"] for f in frames]
    ctx.check(kinds and kinds[0] == "snapshot" and "update" not in kinds, "quiet: only the snapshot and heartbeats arrived", str({k: kinds.count(k) for k in set(kinds)}))
    ctx.check(kinds.count("heartbeat") >= seconds // HEARTBEAT_S - 1, f"quiet: heartbeats kept it alive ({kinds.count('heartbeat')} in {held:.0f} s)")
    problems = frame_problems(ctx.checker, ctx.validators, frames)
    ctx.check(not problems, "quiet: every frame passes the shared checker", "; ".join(problems[:3]))
    st.close()
    ctx.fault("normal")


def try_open(ctx: Ctx, who: str, label: str):
    s = ctx.open(who, label)
    if s.status == 200:
        return s, None
    body = s.resp.body(3)
    return s, (s.status, s.headers, body)


def phase_limits(ctx: Ctx) -> None:
    ctx.fault("normal")
    time.sleep(2)
    held = []
    for i in range(PER_USER):
        s, err = try_open(ctx, "analyst", "limit-analyst")
        ctx.check(err is None, f"limits: analyst stream {i + 1} of {PER_USER} opens", f"status {s.status}")
        held.append(s)
    s4, err = try_open(ctx, "analyst", "limit-analyst")
    ok = err is not None and err[0] == 429 and ctx.error_code(err[2]) == "STREAM_LIMIT" and err[1].get("retry-after") == "5"
    ctx.check(ok, "limits: the 4th stream of one user is 429 STREAM_LIMIT with Retry-After: 5", f"status {s4.status}, retry-after {s4.headers.get('retry-after')}")
    ctx.check(err is not None and err[1].get("content-type", "").startswith("application/json") and bool(err[1].get("x-request-id")),
              "limits: the 429 arrives through Nginx with its JSON envelope and an X-Request-Id")
    ctx.info(f"429 Cache-Control reaches the client as {err[1].get('cache-control') if err else None!r} (AD-1 does not specify one for errors)")
    sv, errv = try_open(ctx, "viewer", "limit-viewer")
    ctx.check(errv is None, "limits: another user is not affected by the first user's limit", f"status {sv.status}")
    # a client abort frees the slot at once
    held[0].close()
    freed, t0 = None, time.time()
    while time.time() - t0 < 5:
        s, err = try_open(ctx, "analyst", "limit-reopen")
        if err is None:
            freed = time.time() - t0
            held.append(s)
            break
        time.sleep(0.25)
    ctx.check(freed is not None, "limits: after a client abort the slot is released and a new stream opens", f"{freed * 1000:.0f} ms" if freed is not None else "still 429 after 5 s")
    # global limit
    loads = sorted(k for k in ctx.tokens if k.startswith("load"))
    if len(loads) < 7:
        ctx.skip("limits: the global limit of 20", f"needs 7 load users (this stack has {len(loads)}); start it with --load-users 7")
    else:
        opened = [s for s in held + [sv] if s.is_open()]
        for _ in range(2):  # viewer to its own limit
            s, err = try_open(ctx, "viewer", "limit-viewer")
            if err is None:
                opened.append(s)
        for who in loads:
            for _ in range(PER_USER):
                if len(opened) >= TOTAL:
                    break
                s, err = try_open(ctx, who, f"limit-{who}")
                if err is None:
                    opened.append(s)
        ctx.check(len(opened) == TOTAL, f"limits: {TOTAL} streams are open in total", str(len(opened)))
        extra, err = try_open(ctx, loads[-1], "limit-global-user")
        ctx.check(err is not None and err[0] == 429 and ctx.error_code(err[2]) == "STREAM_LIMIT" and err[1].get("retry-after") == "5",
                  "limits: the 21st stream is 429 STREAM_LIMIT, Retry-After: 5, even for a user under their own limit", f"status {extra.status}")
        opened[-1].close()
        time.sleep(0.5)
        again, err = try_open(ctx, loads[-1], "limit-global-user")
        ctx.check(err is None, "limits: one slot freed by an abort is immediately usable by another user", f"status {again.status}")
        held += opened
    for s in ctx.streams:
        s.close()


def wait_status(st: Stream, want: str, timeout: float, since: float):
    return st.wait_frames(lambda f: f["t"] >= since and status_in(f) == want, timeout)


def phase_faults(ctx: Ctx) -> None:
    ctx.fault("normal")
    time.sleep(3)
    obs = ctx.open("analyst", "faults")
    ctx.check(obs.status == 200, "faults: the observer stream opens", f"status {obs.status}")
    ok = obs.wait_frames(lambda f: f["event"] == "update", 6)
    ctx.check(ok is not None and status_in(ok) == "ok", "faults: normal gives updates with source status ok")

    ctx.fault("extreme")
    f = obs.wait_frames(lambda f: f["event"] == "update" and f["msg"]["value"]["event"] and f["msg"]["value"]["event"]["payload"]["rate"] in scenarios.EXTREME_RATES, 10)
    ctx.check(f is not None, "faults: extreme-but-valid rates are delivered unchanged", f["msg"]["value"]["event"]["payload"]["rate"] if f else "none within 10 s")

    ctx.fault("malformed_hash")
    t0 = time.time()
    time.sleep(7)
    late = [x for x in obs.snapshot_frames() if x["t"] > t0 + 1 and x["event"] == "update" and x["msg"]["value"]["event"] and x["msg"]["value"]["event"]["payload"]["rate"] not in scenarios.EXTREME_RATES]
    pairs = {pair_of(x["msg"]) for x in late}
    ctx.check(pairs == {"EUR/USD", "GBP/PHP", "USD/INR"}, "faults: one event with a wrong hash is refused alone; the other three pairs keep updating", str(sorted(pairs)))
    ctx.check(not any(status_in(x) == "outage" for x in obs.snapshot_frames() if x["t"] > t0), "faults: a partly invalid response is a successful poll (no outage)")

    ctx.fault("empty")
    t0 = time.time()
    time.sleep(4)
    ctx.check(not any(status_in(x) == "outage" for x in obs.snapshot_frames() if x["t"] > t0), "faults: an empty (valid) response is not an outage")

    ctx.fault("stale")
    f = obs.wait_frames(lambda x: x["event"] == "update" and x["msg"]["value"]["freshness"] == "stale", 10)
    ctx.check(f is not None, "faults: stale events (10 s old) are delivered as freshness stale", "" if f else "none within 10 s")
    ctx.fault("unavailable")  # 60 s old: older than the stale events already current, so they are late (AD-1 3.4) and must change nothing
    t0 = time.time()
    time.sleep(6)
    late = [x for x in obs.snapshot_frames() if x["t"] > t0 + 1 and x["event"] == "update"]
    ctx.check(not late, "faults: events older than the current value are late and ignored: no update, values never regress", f"{len(late)} updates")
    ctx.check(obs.is_open() and not any(status_in(x) == "outage" for x in obs.snapshot_frames() if x["t"] > t0), "faults: late events are a successful poll (no outage, stream open)")

    for scenario in ("http:503", "http:401", "http:302", "http:429:3", "drop", "slow:600", "malformed_json", "malformed_body", "html_200"):
        ctx.fault("normal")
        ok = obs.wait_frames(lambda x: status_in(x) == "ok" and x["t"] > time.time() - 3, 6)
        t0 = time.time()
        ctx.fault(scenario)
        out = wait_status(obs, "outage", 12, t0)
        ctx.check(out is not None, f"faults: {scenario} drives the source to outage and the stream stays open",
                  f"outage after {out['t'] - t0:.1f} s" if out else "no outage within 12 s")
        ctx.check(obs.is_open(), f"faults: the stream is not closed by {scenario}")
        t1 = time.time()
        ctx.fault("normal")
        back = wait_status(obs, "ok", 12, t1)
        ctx.check(back is not None, f"faults: recovery from {scenario}: status returns to ok",
                  f"ok after {back['t'] - t1:.1f} s" if back else "no recovery within 12 s")
        upd = obs.wait_frames(lambda x: x["event"] == "update" and x["t"] > t1, 8)
        ctx.check(upd is not None, f"faults: updates resume after {scenario}")
        time.sleep(1)

    # freshness over time, with the source down: fresh -> stale (> 6 s) -> unavailable (> 30 s) -> fresh again after recovery
    ctx.fault("normal")
    time.sleep(3)
    t0 = time.time()
    ctx.fault("http:503")
    expect = ((1.0, "fresh"), (9.0, "stale"), (34.0, "unavailable"))
    for at, want in expect:
        time.sleep(max(0.0, t0 + at - time.time()))
        s = ctx.open("analyst", f"fresh-{want}")
        snap = s.wait_frames(lambda x: x["event"] == "snapshot", 3)
        values = snap["msg"]["values"] if snap else []
        got = {v["freshness"] for v in values}
        ctx.check(got == {want} and snap["msg"]["source"]["status"] in ("ok", "outage"), f"faults: {at:.0f} s into the outage the snapshot values are all {want}", str(sorted(got)))
        if want == "stale":
            ages = [v["age_ms"] for v in values]
            ctx.check(all(STALE_MS < a <= UNAVAILABLE_MS for a in ages), "faults: stale ages sit between 6 s and 30 s", str(ages))
        if want == "unavailable":
            ctx.check(all(v["event"] is None and v["age_ms"] is None for v in values), "faults: past 30 s every value is withdrawn: no event, no age, no number")
            ctx.check(snap["msg"]["source"]["status"] == "outage", "faults: the source status says outage while the values are unavailable")
        s.close()
    ctx.fault("normal")
    time.sleep(4)
    s = ctx.open("analyst", "fresh-recovered")
    snap = s.wait_frames(lambda x: x["event"] == "snapshot", 3)
    ctx.check(snap is not None and {v["freshness"] for v in snap["msg"]["values"]} == {"fresh"} and snap["msg"]["source"]["status"] == "ok",
              "faults: after recovery a new snapshot is fresh again and the source is ok")
    s.close()
    obs.close()


def backend_id(ctx: Ctx) -> str:
    return ctx.compose("ps", "-a", "-q", "backend").stdout.strip()


def phase_restart(ctx: Ctx, rounds: int = 3) -> None:
    ctx.fault("normal")
    times = []
    for i in range(rounds):
        old = ctx.open("analyst", f"restart-old{i}")
        old.wait_frames(lambda x: x["event"] == "snapshot", 3)
        if i == 0:
            ctx.fault("unavailable")  # the restarted backend has an empty store, so it accepts these old events: unavailable on arrival
        t_cmd = time.time()
        proc = subprocess.Popen(p3.compose_args(ctx.state) + ["restart", "-t", "15", "backend"], cwd=p3.REPO, env=p3.compose_env(ctx.state),
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        statuses, reach, snapshot_at, new, down_seen = [], None, None, None, False
        deadline = time.time() + 120
        while time.time() < deadline:
            try:
                with Response(HOST, ctx.port, "/api/v1/health/live", timeout=3) as r:
                    status = r.status
            except (OSError, TimeoutError):
                status = 0
            statuses.append(status)
            down_seen = down_seen or status != 200
            # Reachable through Nginx: a 200 after the outage was seen, or once the restart command has finished.
            if reach is None and status == 200 and (down_seen or proc.poll() is not None):
                reach = time.time()
            if reach is not None:
                try:
                    new = ctx.open("analyst", f"restart-new{i}")
                except (OSError, TimeoutError):
                    new = None
                if new is not None and new.status == 200:
                    first = new.wait_frames(lambda x: x["event"] == "snapshot", 5)
                    if first:
                        snapshot_at = first["t"]
                        break
                elif new is not None:
                    new.close()
            time.sleep(0.25)
        proc.wait(timeout=120)
        ctx.check(old.done.wait(1), f"restart {i + 1}: the old stream ended when the backend stopped")
        ok = reach is not None and snapshot_at is not None
        ms = (snapshot_at - reach) * 1000 if ok else None
        ctx.check(ok and ms <= RECONNECT_BUDGET_MS, f"restart {i + 1}: a new stream starts at most {RECONNECT_BUDGET_MS} ms after the backend is reachable through Nginx",
                  f"{ms:.0f} ms" if ok else "never reconnected")
        bad = sorted({s for s in statuses if s not in (200, 0)})
        ctx.info(f"restart {i + 1}: {len(statuses)} health probes through Nginx during the restart; non-200 statuses {bad or 'none'}, connection errors {statuses.count(0)}; "
                 f"stream down for {(reach - t_cmd):.1f} s from the restart command" if reach else f"restart {i + 1}: backend never became reachable")
        if ok:
            times.append(ms)
            if i == 0:
                gone = new.wait_frames(lambda x: x["event"] == "update" and x["msg"]["value"]["freshness"] == "unavailable", 6)
                ctx.check(gone is not None and gone["msg"]["value"]["event"] is None and gone["msg"]["value"]["age_ms"] is None,
                          "restart 1: on an empty store a 60 s old event is accepted and delivered as unavailable, with no event and no age")
                ctx.fault("normal")
            upd = new.wait_frames(lambda x: x["event"] == "update" and x["msg"]["value"]["freshness"] == "fresh", 8)
            ctx.check(upd is not None, f"restart {i + 1}: updates resume on the new stream (the poller restarted)")
            problems = frame_problems(ctx.checker, ctx.validators, new.snapshot_frames())
            ctx.check(not problems, f"restart {i + 1}: the new stream's frames pass the shared checker", "; ".join(problems[:2]))
            new.close()
        old.close()
        time.sleep(2)
    if times:
        ctx.info(f"reconnect after restart: {[round(t) for t in times]} ms; p95 {percentile(times, 95):.0f} ms (budget {RECONNECT_BUDGET_MS} ms; {len(times)} samples)")


def phase_sigterm(ctx: Ctx) -> None:
    ctx.fault("normal")
    time.sleep(2)
    streams = [ctx.open("analyst", "term") for _ in range(PER_USER)] + [ctx.open("viewer", "term-viewer")]
    ctx.check(all(s.status == 200 for s in streams), "sigterm: four active streams are open (three users' limit and another user)", str([s.status for s in streams]))
    for s in streams:
        s.wait_frames(lambda x: x["event"] == "snapshot", 3)
    cid = backend_id(ctx)
    t0 = time.time()
    p3.run(["docker", "kill", "--signal", "SIGTERM", cid], capture=True, check=False)  # exactly what `docker stop` sends first
    during = None
    try:
        with Response(HOST, ctx.port, PATH, headers={"Authorization": f"Bearer {ctx.tokens['viewer']}"}, timeout=3) as r:
            during = (r.status, r.headers.get("retry-after"), ctx.error_code(r.body(2)))
    except (OSError, TimeoutError) as e:
        during = ("connection", type(e).__name__)
    waited = p3.run(["docker", "wait", cid], capture=True, check=False, timeout=60)
    elapsed = (time.time() - t0) * 1000
    ended = [s.done.wait(2) for s in streams]
    code = waited.stdout.strip().splitlines()[-1] if waited.stdout.strip() else "?"
    ctx.check(code == "0", "sigterm: the backend exits 0 (not the forced exit 1)", f"exit code {code}")
    ctx.check(elapsed < SHUTDOWN_GRACE_MS, f"sigterm: it exits within the {SHUTDOWN_GRACE_MS} ms forced-exit grace of the signal", f"{elapsed:.0f} ms from SIGTERM")
    ctx.check(all(ended), "sigterm: every active stream was ended", str(ended))
    refused = during is not None and (during[0] == 502 or (during[0] == 503 and during[1] == "1" and during[2] == "SHUTTING_DOWN") or during[0] == "connection")
    ctx.check(refused, "sigterm: a stream requested right after SIGTERM is refused, never served",
              f"{during} (503 SHUTTING_DOWN from Express, or Nginx's 502 once the backend has stopped listening, which clients treat as recoverable)")
    if during and during[0] != 503:
        ctx.info("503 SHUTTING_DOWN with Retry-After: 1 was not observed through Nginx in this run: the backend stopped listening first (that path is covered by the backend's own tests)")
    for s in streams:
        s.close()


# --- orchestration ----------------------------------------------------------------------------------------------

def finish(ctx: Ctx, full: bool = True) -> int:
    frames = [f for s in ctx.streams for f in s.snapshot_frames()]
    if frames:
        problems = frame_problems_by_connection(ctx, frames)
        ctx.check(not problems, f"all {len(frames)} frames from {len(ctx.streams)} connections pass the shared checker", "; ".join(problems[:3]))
        cov = cec.frames_problems(ctx.checker, ctx.validators, frames)
        if full:  # only a run that includes the soak (heartbeats) and the faults (stale, unavailable) can show every state
            ctx.check(not cov, "frames cover every message type and freshness state", "; ".join(cov[:3]))
        else:
            ctx.info("coverage of every message type and freshness state is checked only when --only includes soak and faults")
    print(f"\n{ctx.passed} passed, {len(ctx.failed)} failed, {ctx.skipped} skipped", flush=True)
    for name in ctx.failed:
        print(f"  failed: {name}")
    return 1 if ctx.failed else 0


def frame_problems_by_connection(ctx: Ctx, frames) -> list:
    out, by = [], {}
    for f in frames:
        by.setdefault(f["connection"], []).append(f)
    for label, fs in by.items():
        out += frame_problems(ctx.checker, ctx.validators, fs)
    return out


def run_phases(ctx: Ctx, only, soak: int, quiet: int) -> int:
    runners = {"auth": lambda: phase_auth(ctx), "soak": lambda: phase_soak(ctx, soak), "quiet": lambda: phase_quiet(ctx, quiet),
               "limits": lambda: phase_limits(ctx), "faults": lambda: phase_faults(ctx), "restart": lambda: phase_restart(ctx),
               "sigterm": lambda: phase_sigterm(ctx)}
    for name in PHASES:
        if name in only:
            print(f"\n== {name}", flush=True)
            try:
                runners[name]()
            except Exception as e:  # noqa: BLE001 - a crashed phase is a failed check, never a silent skip
                ctx.check(False, f"{name}: the phase crashed", f"{type(e).__name__}: {str(e)[:200]}")
    return finish(ctx, {"soak", "faults"} <= set(only))


def make_ctx(state: dict) -> Ctx:
    checker = cec.Checker(REPO)
    validators = checker.load_schemas()
    if validators is None:
        raise RuntimeError("the shared schemas did not load: " + "; ".join(checker.problems))
    tokens = json.loads((Path(state["work"]) / "smoke-tokens.json").read_text(encoding="utf-8"))
    return Ctx(state, tokens, checker, validators)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--project", help="an existing stack from p3_stack.py up --fault --load-users 7")
    ap.add_argument("--up", action="store_true", help="start a disposable stack, run, and remove it")
    ap.add_argument("--root", type=Path, default=p3.default_root())
    ap.add_argument("--only", default=",".join(PHASES))
    ap.add_argument("--soak-seconds", type=int, default=300)
    ap.add_argument("--quiet-seconds", type=int, default=75)
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args(argv)
    only = [x for x in args.only.split(",") if x]
    if bool(args.project) == bool(args.up) or any(x not in PHASES for x in only) or args.soak_seconds < 5 or args.quiet_seconds < 5:
        print("choose exactly one of --project/--up; --only takes a subset of " + ",".join(PHASES), file=sys.stderr)
        return 2
    try:
        state = p3.up(args.root, None, True, 7) if args.up else p3.load_state(args.root, args.project)
    except p3.HarnessError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    try:
        return run_phases(make_ctx(state), only, args.soak_seconds, args.quiet_seconds)
    finally:
        if args.up and not args.keep:
            p3.cleanup(state, args.root)


if __name__ == "__main__":
    sys.exit(main())
