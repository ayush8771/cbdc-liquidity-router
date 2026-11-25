"""P-7: Nginx streaming checks through the published port (AD-1 v0.5 section 3.6, acceptance item 7). TEST-ONLY.

    P3_PROJECT=<unique name> python infra/testing/nginx_sse/run_checks.py

Runs the repository's own `services/web/nginx.conf.template` in the pinned Nginx image that `services/web/Dockerfile`
uses, in front of the test-only stub backend (stub_backend.py), on a throwaway network. It changes no Nginx
configuration. The static React bundle is not needed: only the proxy is under test. The real backend is checked
later, when Dev B's observation module exists; this proves the proxy does not break a correct stream.

Checks (each prints PASS or FAIL; exit status 1 on any FAIL):
  1  the snapshot arrives at once, and the stream's headers arrive intact
  2  updates arrive one by one, not batched      control: the same measurement DOES detect a stub that batches (and an INFO
                                                   line records what Nginx does without `X-Accel-Buffering: no`)
  3  a quiet stream with 15 s heartbeats stays open past 60 s   control: a silent stream is cut by Nginx's read timeout
  4  a client abort reaches the backend and frees its slot      control: the open stream is counted first
  5  401, 429, 503 and 405 arrive with status, headers and JSON body intact, and request headers are forwarded
  6  a 502 while the backend is gone, and recovery after it returns on a NEW address   control: the address did change
     (a filler container takes the freed address first, because Docker would otherwise hand it to the restarted backend)
Every socket and docker call has a deadline. Everything created is named with $P3_PROJECT and removed at the end.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sse_probe  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
# The ingestion image's pinned base (services/ingestion/Dockerfile), which is also the inference image's.
PYTHON_IMAGE = "python:3.10.11-slim-bullseye@sha256:fd86924ba14682eb11a3c244f60a35b5dfe3267cbf26d883fb5c14813ce926f1"
STREAM = "/api/rt/v1/observations/stream"
STATE = "/api/__stub/state"
ECHO = "/api/__stub/echo"
DUMMY_AUTH = {"Authorization": "Bearer p3-test-not-a-secret"}
RECOVERY_LIMIT_S = 20.0  # Nginx caches the backend address for 10 s (`resolver ... valid=10s`); the rest is margin

failures: list[str] = []


def check(ok: bool, name: str, detail: str = "") -> bool:
    print(("PASS " if ok else "FAIL ") + name + (f": {detail}" if detail else ""), flush=True)
    if not ok:
        failures.append(name)
    return ok


def docker(*args: str, timeout: int = 90, ok_codes=(0,)) -> str:
    r = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)
    if r.returncode not in ok_codes:
        raise RuntimeError(f"docker {' '.join(args[:3])} failed ({r.returncode}): {r.stderr.strip()[:300]}")
    return r.stdout.strip()


def nginx_image() -> str:
    text = (REPO / "services" / "web" / "Dockerfile").read_text(encoding="utf-8")
    m = re.search(r"^ARG NGINX_IMAGE=(\S+)$", text, re.M)
    if not m:
        raise RuntimeError("services/web/Dockerfile no longer declares ARG NGINX_IMAGE")
    return m.group(1)


class Rig:
    def __init__(self, project: str):
        self.project = project
        self.net = f"{project}_nginx"
        self.stub = f"{project}-nginx-stub"
        self.nginx = f"{project}-nginx"
        self.filler = f"{project}-nginx-filler"
        self.host = "127.0.0.1"
        self.port = 0

    def start_stub(self) -> str:
        docker("run", "-d", "--name", self.stub, "--network", self.net, "--network-alias", "backend",
               "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
               "-v", f"{HERE.as_posix()}:/stub:ro", PYTHON_IMAGE, "python", "/stub/stub_backend.py", "--port", "4000")
        return docker("inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", self.stub)

    def up(self) -> None:
        docker("network", "create", self.net)
        self.start_stub()
        docker("run", "-d", "--name", self.nginx, "--network", self.net, "-p", "127.0.0.1::80",
               "-e", "BACKEND_HOST=backend", "-e", "BACKEND_PORT=4000", "-e", "NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1",
               "-e", "NGINX_ENVSUBST_FILTER=^(BACKEND_|NGINX_LOCAL_RESOLVERS)",
               "-v", f"{(REPO / 'services' / 'web' / 'nginx.conf.template').as_posix()}:/etc/nginx/templates/default.conf.template:ro",
               nginx_image())
        self.port = int(docker("port", self.nginx, "80/tcp").splitlines()[0].rsplit(":", 1)[1])
        deadline = time.time() + 40
        while time.time() < deadline:
            try:
                with sse_probe.Response(self.host, self.port, STATE, timeout=3) as r:
                    if r.status == 200:
                        return
            except (OSError, TimeoutError):
                pass
            time.sleep(0.5)
        raise RuntimeError("nginx and the stub did not become ready within 40 s")

    def down(self) -> None:
        for name in (self.nginx, self.stub, self.filler):
            subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=60)
        subprocess.run(["docker", "network", "rm", self.net], capture_output=True, timeout=60)

    def get(self, path=STREAM, headers=None, method="GET", timeout=8.0):
        return sse_probe.Response(self.host, self.port, path, method=method, headers={**DUMMY_AUTH, **(headers or {})}, timeout=timeout)

    def state(self) -> dict:
        with self.get(STATE) as r:
            return r.json()


# ---- 1: immediate snapshot and intact headers --------------------------------------------------------------------------
def check_snapshot_and_headers(rig: Rig) -> None:
    with rig.get() as r:
        first = next(iter(r.events(time.time() + 5, stop_after=1)), None)
        check(first is not None and first[1] == "snapshot", "1 the first event is the snapshot")
        if first:
            check(first[0] - r.sent_at < 1.0, "1 the snapshot arrives at once", f"{first[0] - r.sent_at:.3f} s after the request")
        h = r.headers
        check(r.status == 200 and h.get("content-type") == "text/event-stream; charset=utf-8", "1 status 200 and the SSE content type", h.get("content-type", ""))
        check(h.get("cache-control") == "no-store, no-transform", "1 Cache-Control: no-store, no-transform arrives intact", h.get("cache-control", ""))
        check(h.get("transfer-encoding", "").lower() == "chunked" and "content-length" not in h and "content-encoding" not in h,
              "1 the response is chunked, not compressed and has no length")
        check(bool(h.get("x-request-id")), "1 X-Request-Id arrives intact")
        check("nginx/" not in h.get("server", ""), "1 the Nginx version is not disclosed", h.get("server", ""))


# ---- 2: updates are not batched ----------------------------------------------------------------------------------------
def check_unbuffered(rig: Rig) -> None:
    with rig.get() as r:
        events = list(r.events(time.time() + 9))
    updates = [e for e in events if e[1] == "update"]
    check(len(updates) >= 6, "2 at least 6 updates in 9 s", f"{len(updates)}")
    lat = [t - json.loads(d)["sent_at"] for t, n, d in updates]
    check(bool(lat) and max(lat) < 0.5, "2 every update arrives within 0.5 s of being sent", f"max {max(lat):.3f} s" if lat else "none")
    gaps = [b[0] - a[0] for a, b in zip(updates, updates[1:])]
    check(bool(gaps) and min(gaps) > 0.5, "2 updates arrive one by one, about 1 s apart, not in a burst", f"min gap {min(gaps):.3f} s" if gaps else "none")
    # Control: the measurement above must be able to FAIL. This stub holds its updates for 3 s and writes them together;
    # through the same Nginx the latency must then exceed 1 s and the updates must arrive in bursts.
    with rig.get(headers={"X-Stub-Scenario": "batched-control"}) as c:
        batched = [e for e in c.events(time.time() + 9) if e[1] == "update"]
    blat = [t - json.loads(d)["sent_at"] for t, n, d in batched]
    bgaps = [b[0] - a[0] for a, b in zip(batched, batched[1:])]
    check(bool(blat) and max(blat) > 1.0 and bool(bgaps) and min(bgaps) < 0.5, "2 control: the measurement detects batched delivery",
          f"max latency {max(blat):.2f} s, min gap {min(bgaps):.3f} s" if blat and bgaps else f"{len(batched)} updates")
    # Observation only, not a pass or fail: the first verification run showed that Nginx 1.28.0 with the approved template
    # delivers promptly even without `X-Accel-Buffering: no`, so this run cannot show that the header is what keeps it
    # unbuffered. The header stays as the approved safeguard; the result is printed for the record.
    try:
        with rig.get(headers={"X-Stub-Scenario": "buffered-control"}, timeout=7) as o:
            seen = list(o.events(time.time() + 4))
        print(f"INFO 2 without X-Accel-Buffering, Nginx delivered {len(seen)} events in 4 s", flush=True)
    except TimeoutError:
        print("INFO 2 without X-Accel-Buffering, Nginx sent no response headers within 7 s (it buffered)", flush=True)


# ---- 3: a quiet stream outlives the 60 s read timeout ------------------------------------------------------------------
def check_quiet_stream(rig: Rig) -> None:
    out: dict = {}

    def quiet():
        with rig.get(headers={"X-Stub-Scenario": "quiet", "X-Stub-Heartbeat-S": "15"}, timeout=10) as r:
            t0 = r.sent_at
            ev = list(r.events(t0 + 72))
            out["quiet"] = (ev, r.eof, t0)

    def silent():
        with rig.get(headers={"X-Stub-Scenario": "silent"}, timeout=10) as r:
            t0 = r.sent_at
            closed = r.wait_closed(t0 + 80)
            out["silent"] = (closed, t0)

    threads = [threading.Thread(target=quiet), threading.Thread(target=silent)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=120)
    ev, eof, t0 = out.get("quiet", ([], True, 0))
    beats = [e[0] for e in ev if e[1] == "heartbeat"]
    check(not eof and len(beats) >= 4, "3 the quiet stream is still open after 72 s, with at least 4 heartbeats", f"{len(beats)} heartbeats, closed={eof}")
    gaps = [b - a for a, b in zip(beats, beats[1:])]
    check(bool(gaps) and max(gaps) < 17, "3 heartbeats arrive about 15 s apart", f"max gap {max(gaps):.1f} s" if gaps else "none")
    closed, s0 = out.get("silent", (None, 0))
    check(closed is not None and 55 <= closed - s0 <= 70, "3 control: a silent stream is cut by Nginx's 60 s read timeout",
          f"closed after {closed - s0:.1f} s" if closed else "never closed within 80 s")


# ---- 4: a client abort reaches the backend -----------------------------------------------------------------------------
def check_abort(rig: Rig) -> None:
    # Streams opened by earlier checks may still be closing: take the baseline only once none is open.
    settle = time.time() + 15
    while time.time() < settle and rig.state()["open_streams"] != 0:
        time.sleep(0.3)
    check(rig.state()["open_streams"] == 0, "4 control: no stream is open before the test")
    before = rig.state()
    r = rig.get()
    try:
        list(r.events(time.time() + 5, stop_after=1))
        deadline = time.time() + 5
        while time.time() < deadline and rig.state()["open_streams"] != before["open_streams"] + 1:
            time.sleep(0.2)
        check(rig.state()["open_streams"] == before["open_streams"] + 1, "4 control: the open stream is counted by the backend")
    finally:
        r.close()
    t0 = time.time()
    deadline = t0 + 15
    while time.time() < deadline:
        s = rig.state()
        if s["open_streams"] == before["open_streams"] and s["aborted"] == before["aborted"] + 1:
            check(True, "4 the abort reached the backend and freed the slot", f"{time.time() - t0:.1f} s")
            return
        time.sleep(0.3)
    check(False, "4 the abort reached the backend and freed the slot", f"state {rig.state()} (before {before})")


# ---- 5: errors and request headers -------------------------------------------------------------------------------------
def check_errors_and_forwarding(rig: Rig) -> None:
    for scenario, status, code, retry in (("401", 401, "UNAUTHENTICATED", None), ("429", 429, "STREAM_LIMIT", "5"), ("503", 503, "SHUTTING_DOWN", "1")):
        with rig.get(headers={"X-Stub-Scenario": scenario}) as r:
            body = r.json()
            h = r.headers
            ok = (r.status == status and body.get("error", {}).get("code") == code and h.get("content-type", "").startswith("application/json")
                  and h.get("cache-control") == "no-store" and h.get("retry-after") == retry and bool(h.get("x-request-id")))
            check(ok, f"5 {status} {code}: status, JSON body, Cache-Control, Retry-After and X-Request-Id arrive intact", f"status {r.status}, retry-after {h.get('retry-after')}")
    with rig.get(method="POST") as r:
        check(r.status == 405 and r.headers.get("allow") == "GET", "5 405 with Allow: GET arrives intact", f"status {r.status}")
    with rig.get(ECHO, headers={"X-Forwarded-Proto": "spoofed"}) as r:
        e = r.json()
        check(e["authorization_forwarded"] and e["x_forwarded_for"] and e["x_real_ip"], "5 the Authorization header and the proxy headers are forwarded")
        check(e["x_forwarded_proto"] == "http", "5 X-Forwarded-Proto is set by Nginx, not by the client", str(e["x_forwarded_proto"]))
        check(e["host"] == f"{rig.host}:{rig.port}", "5 the Host header is passed on unchanged", str(e["host"]))


# ---- 6: 502 while the backend is gone, and recovery on a new address ---------------------------------------------------
def check_502_and_recovery(rig: Rig) -> None:
    old_ip = docker("inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", rig.stub)
    live = rig.get()
    list(live.events(time.time() + 5, stop_after=1))
    docker("rm", "-f", rig.stub)
    # A filler takes the freed address, so the restarted backend cannot get it back (Docker hands out the lowest free one).
    docker("run", "-d", "--name", rig.filler, "--network", rig.net, PYTHON_IMAGE, "python", "-c", "import time; time.sleep(900)")
    filler_ip = docker("inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", rig.filler)
    check(filler_ip == old_ip, "6 control: a filler took the backend's old address", f"{old_ip} / {filler_ip}")
    ended = live.wait_closed(time.time() + 10)
    live.close()
    check(ended is not None, "6 an open stream ends when the backend goes away", "" if ended else "still open after 10 s")
    seen_502 = False
    deadline = time.time() + 15
    while time.time() < deadline and not seen_502:
        try:
            with rig.get(timeout=5) as r:
                seen_502 = r.status == 502
        except (OSError, TimeoutError):
            pass
        time.sleep(0.5)
    check(seen_502, "6 a request while the backend is gone gets a 502 within 15 s")
    new_ip = rig.start_stub()
    check(new_ip != old_ip and bool(new_ip), "6 control: the restarted backend has a different address", f"{old_ip} -> {new_ip}")
    t0 = time.time()
    statuses: list[int] = []
    recovered = None
    while time.time() - t0 < 30:
        try:
            with rig.get(timeout=3) as r:
                statuses.append(r.status)
                if r.status == 200 and next(iter(r.events(time.time() + 3, stop_after=1)), (0, ""))[1] == "snapshot":
                    recovered = time.time() - t0
                    break
        except (OSError, TimeoutError):
            statuses.append(0)
        time.sleep(0.5)
    check(recovered is not None and recovered <= RECOVERY_LIMIT_S, f"6 the proxy follows the backend to its new address within {RECOVERY_LIMIT_S:.0f} s",
          f"recovered after {recovered:.1f} s, {statuses.count(502)} x 502 first" if recovered is not None else f"not recovered in 30 s, statuses {statuses[-5:]}")


def main() -> int:
    project = os.environ.get("P3_PROJECT", "")
    if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{2,60}", project):
        print("FAIL P3_PROJECT must be set to a unique lower-case name for this run", file=sys.stderr)
        return 2
    rig = Rig(project)
    try:
        rig.up()
        print(f"nginx published on {rig.host}:{rig.port}", flush=True)
        for step in (check_snapshot_and_headers, check_unbuffered, check_abort, check_errors_and_forwarding, check_quiet_stream, check_502_and_recovery):
            try:
                step(rig)
            except Exception as exc:  # noqa: BLE001 - a check that cannot run is a failure, never a pass
                check(False, step.__name__, f"{type(exc).__name__}: {str(exc)[:200]}")
    except Exception as exc:  # noqa: BLE001
        check(False, "setup", f"{type(exc).__name__}: {str(exc)[:300]}")
    finally:
        if failures:
            try:
                print("--- nginx log (last lines) ---\n" + docker("logs", "--tail", "15", rig.nginx, timeout=20), flush=True)
            except Exception:  # noqa: BLE001
                pass
        rig.down()
    print(f"{len(failures)} failure(s)" if failures else "all Nginx streaming checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
