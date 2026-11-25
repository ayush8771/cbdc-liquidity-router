"""Tests for e2e/p3_stream_probe.py (Dev D): the measurements and judgements, against a local fake of the stream.

No container starts. The fake speaks the stream's HTTP surface closely enough to exercise the probe's phases end to end (auth
checks, a short soak), and a second, deliberately broken fake proves the probe fails when the stream is wrong.
Run: pytest infra/scripts/tests/test_p3_stream_probe.py
"""
import copy
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
REPO = SCRIPTS.parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(REPO / "e2e"))

import check_event_contracts as cec  # noqa: E402
import p3_stack as p3  # noqa: E402
import p3_stream_probe as probe  # noqa: E402

FIXTURES = REPO / "contracts" / "events" / "fixtures" / "stream-message"


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))["instance"]


@pytest.fixture(scope="module")
def shared():
    checker = cec.Checker(REPO)
    validators = checker.load_schemas()
    assert validators is not None, checker.problems
    return checker, validators


# --- pure helpers -----------------------------------------------------------------------------------------------

def test_percentile_is_nearest_rank():
    data = list(range(1, 101))
    assert probe.percentile(data, 95) == 95 and probe.percentile(data, 50) == 50 and probe.percentile(data, 100) == 100
    assert probe.percentile([7], 95) == 7 and probe.percentile([3, 1, 2], 100) == 3
    with pytest.raises(ValueError):
        probe.percentile([], 95)


def test_epoch_ms_reads_ad4_timestamps_and_refuses_anything_else():
    assert probe.epoch_ms("1970-01-01T00:00:01.250Z") == 1250
    assert probe.epoch_ms("2026-11-24T10:00:00.700Z") == 1795514400700
    with pytest.raises(ValueError):
        probe.epoch_ms("2026-02-30T00:00:00.000Z")


def _update_at(emitted_ms, arrival_ms):
    msg = fixture("valid_update.json")
    ts = cec.datetime.utcfromtimestamp(emitted_ms / 1000).strftime("%Y-%m-%dT%H:%M:%S.") + f"{emitted_ms % 1000:03d}Z"
    msg["value"]["event"]["timestamps"].update(emitted_at=ts, retrieved_at=ts, source_timestamp=ts)
    return {"connection": "c", "event": "update", "msg": msg, "t": arrival_ms / 1000}


def test_update_latency_is_arrival_minus_emitted_corrected_by_the_clock_skew():
    frames = [_update_at(1_000_000, 1_000_300), _update_at(2_000_000, 2_000_900)]
    assert probe.update_latencies(frames) == pytest.approx([300, 900])
    # The VM clock runs 250 ms ahead of the host: an event "emitted" at VM time T was emitted at host time T - 250.
    assert probe.update_latencies(frames, skew_ms=250) == pytest.approx([550, 1150])
    heartbeat = {"connection": "c", "event": "heartbeat", "msg": fixture("valid_heartbeat_outage.json"), "t": 1.0}
    assert probe.update_latencies([heartbeat]) == []


# --- frame judgement --------------------------------------------------------------------------------------------

def _frames():
    out = []
    for i, name in enumerate(("valid_snapshot.json", "valid_update.json", "valid_heartbeat_outage.json"), 1):
        msg = fixture(name)
        msg["stream_seq"] = i
        out.append({"connection": "c", "event": msg["type"], "msg": msg, "t": float(i)})
    return out


def test_frames_from_valid_fixtures_pass(shared):
    assert probe.frame_problems(*shared, _frames()) == []


@pytest.mark.parametrize("change, expected", [
    (lambda f: f[1]["msg"].update(stream_seq=9), "stream_seq 9 is not 2"),
    (lambda f: f[1].update(event="snapshot"), "differs from the SSE event name"),
    (lambda f: f.pop(0), "first frame is not a snapshot"),
    (lambda f: f[0]["msg"]["values"][0].update(freshness="stale"), "freshness disagrees"),
    (lambda f: f[1]["msg"].update(extra=1), "schema"),
])
def test_a_wrong_frame_is_reported(shared, change, expected):
    frames = _frames()
    change(frames)
    assert any(expected in p for p in probe.frame_problems(*shared, frames)), expected


# --- a local fake of the stream ----------------------------------------------------------------------------------

class FakeStream(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    token = "good"
    break_sequence = False
    duration = 6.0

    def log_message(self, *_a):
        pass

    def _json(self, status, code, headers=None):
        body = json.dumps({"error": {"code": code, "message": "x"}}).encode()
        self.send_response(status)
        for k, v in {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", **(headers or {})}.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _handle(self):
        path, _, query = self.path.partition("?")
        if self.headers.get("Authorization") != f"Bearer {self.token}":
            return self._json(401, "UNAUTHENTICATED")
        if self.command != "GET":
            return self._json(405, "METHOD_NOT_ALLOWED", {"Allow": "GET"})
        if query:
            return self._json(422, "VALIDATION_ERROR")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store, no-transform")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        snap = fixture("valid_snapshot.json")
        snap["stream_seq"] = 1
        seq = 1
        values = snap["values"]
        end = time.time() + self.duration
        try:
            self._send("snapshot", snap)
            i = 0
            while time.time() < end:
                time.sleep(0.25)
                seq += 2 if (self.break_sequence and i == 3) else 1
                v = copy.deepcopy(values[i % 4])
                now = int(time.time() * 1000)
                stamp = time.strftime("%Y-%m-%dT%H:%M:%S.", time.gmtime(now / 1000)) + f"{now % 1000:03d}Z"
                v["event"]["timestamps"].update(source_timestamp=stamp, retrieved_at=stamp, emitted_at=stamp)
                v.update(age_ms=0, freshness="fresh")
                self._send("update", {"protocol_version": "1.0", "type": "update", "stream_seq": seq, "server_time": stamp,
                                      "source": {"source_id": "synthetic.fx", "status": "ok"}, "value": v})
                i += 1
        except (BrokenPipeError, ConnectionError, OSError):
            pass

    def _send(self, name, msg):
        self.wfile.write(f"event: {name}\ndata: {json.dumps(msg)}\n\n".encode())
        self.wfile.flush()

    do_GET = do_POST = do_HEAD = _handle


def _serve(**attrs):
    handler = type("H", (FakeStream,), attrs)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def _ctx(server, shared, monkeypatch):
    monkeypatch.setattr(p3, "set_fault", lambda *_a, **_k: "{}")
    state = {"port": server.server_address[1], "project": "cbdc-p3s-00000000", "fault": True}
    return probe.Ctx(state, {"analyst": {"token": "good"}, "viewer": {"token": "good"}}, *shared, skew_ms=0.0)


def test_auth_phase_against_a_conforming_fake(shared, monkeypatch):
    server = _serve()
    try:
        ctx = _ctx(server, shared, monkeypatch)
        probe.phase_auth(ctx)
        assert ctx.failed == [] and ctx.passed >= 10, ctx.failed
    finally:
        server.shutdown()


def test_soak_phase_measures_a_conforming_fake_and_passes(shared, monkeypatch, capsys):
    server = _serve(duration=8.0)
    try:
        ctx = _ctx(server, shared, monkeypatch)
        monkeypatch.setattr(time, "sleep", lambda s: __import__("threading").Event().wait(min(s, 0.2)))  # the fixed 3 s warm-up is not under test
        probe.phase_soak(ctx, 5)
        assert ctx.failed == [], ctx.failed
        out = capsys.readouterr().out
        assert "delivery latency over" in out and "p95" in out
    finally:
        server.shutdown()


def test_soak_phase_fails_on_a_sequence_gap(shared, monkeypatch):
    server = _serve(break_sequence=True, duration=8.0)
    try:
        ctx = _ctx(server, shared, monkeypatch)
        monkeypatch.setattr(time, "sleep", lambda s: __import__("threading").Event().wait(min(s, 0.2)))
        probe.phase_soak(ctx, 5)
        assert any("shared checker" in name for name in ctx.failed), "a stream_seq gap must fail the soak"
    finally:
        server.shutdown()


def test_auth_phase_fails_when_the_token_is_not_checked(shared, monkeypatch):
    server = _serve(token="something-else")
    try:
        ctx = _ctx(server, shared, monkeypatch)
        probe.phase_auth(ctx)
        assert ctx.failed, "a stream that rejects the valid token cannot pass the auth phase"
    finally:
        server.shutdown()


def test_arguments_are_validated():
    assert probe.main([]) == 2
    assert probe.main(["--up", "--project", "cbdc-p3s-00000000"]) == 2
    assert probe.main(["--project", "cbdc-p3s-00000000", "--only", "nope"]) == 2
    assert probe.main(["--project", "cbdc-p3s-00000000", "--soak-seconds", "1"]) == 2
    assert probe.main(["--project", "cbdc-router"]) == 2  # a foreign project is refused by p3_stack.load_state
    assert probe.PHASES == ("auth", "soak", "quiet", "limits", "faults", "restart", "sigterm")


def test_skew_is_read_from_the_streams_own_server_time():
    # A VM clock 217 ms ahead stamps server_time 217 ms later than the host clock says; delivery takes 2 to 40 ms.
    def frame(host_ms, delay_ms, skew=217):
        stamp = host_ms + skew - delay_ms  # server_time is stamped just before the write, in the VM's time
        ts = cec.datetime.utcfromtimestamp(stamp / 1000).strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(stamp) % 1000:03d}Z"
        return {"connection": "c", "event": "heartbeat", "msg": {"server_time": ts}, "t": host_ms / 1000}
    frames = [frame(1_000_000 + i * 1000, d) for i, d in enumerate((40, 2, 15, 30))]
    assert probe.skew_from_frames(frames) == pytest.approx(217 - 2, abs=1)  # understates by the smallest delivery delay only
    assert probe.skew_from_frames([]) is None
    assert probe.skew_from_frames([{"connection": "c", "event": "x", "msg": "not json", "t": 1.0}]) is None
