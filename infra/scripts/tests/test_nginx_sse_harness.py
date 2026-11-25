"""Tests of the P-7 harness itself (infra/testing/nginx_sse), without Nginx or Docker.

The stub backend and the SSE client are test tools. They must behave exactly as the runtime checks assume, or a runtime
PASS or FAIL would mean nothing. Here they talk to each other directly on loopback, which is also the positive control for
the timing measurements later taken through Nginx. The last tests check that the stub cannot end up in an image.
"""
import re
import sys
import threading
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
HARNESS = REPO / "infra" / "testing" / "nginx_sse"
sys.path.insert(0, str(HARNESS))

import sse_probe  # noqa: E402
import stub_backend  # noqa: E402

STREAM = stub_backend.STREAM_PATH


@pytest.fixture(scope="module")
def stub():
    server = stub_backend.make_server("127.0.0.1", 0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield server
    server.shutdown()
    server.server_close()


def open_stream(stub, headers=None, path=STREAM, method="GET"):
    return sse_probe.Response("127.0.0.1", stub.server_address[1], path, method=method, headers=headers, timeout=5)


def state(stub):
    _, _, body = sse_probe.get_json("127.0.0.1", stub.server_address[1], stub_backend.STATE_PATH)
    return body


def test_snapshot_arrives_at_once_with_the_stream_headers(stub):
    with open_stream(stub) as r:
        got = list(r.events(time.time() + 3, stop_after=1))
        assert got and got[0][1] == "snapshot"
        assert got[0][0] - r.sent_at < 0.5
        assert r.status == 200 and r.headers["transfer-encoding"] == "chunked" and "content-length" not in r.headers
        assert r.headers["content-type"] == "text/event-stream; charset=utf-8"
        assert r.headers["cache-control"] == "no-store, no-transform"
        assert r.headers["x-accel-buffering"] == "no" and r.headers["x-request-id"]


def test_updates_arrive_one_by_one_at_the_requested_interval(stub):
    with open_stream(stub, {"X-Stub-Interval-S": "0.2"}) as r:
        events = list(r.events(time.time() + 1.5))
    updates = [e for e in events if e[1] == "update"]
    assert len(updates) >= 4
    gaps = [b[0] - a[0] for a, b in zip(updates, updates[1:])]
    assert min(gaps) > 0.1 and max(gaps) < 0.5, gaps


def test_heartbeats_only_in_the_quiet_scenario(stub):
    with open_stream(stub, {"X-Stub-Scenario": "quiet", "X-Stub-Heartbeat-S": "0.3"}) as r:
        kinds = [e[1] for e in r.events(time.time() + 1.4)]
    assert kinds[0] == "snapshot" and kinds.count("heartbeat") >= 3 and "update" not in kinds


def test_silent_scenario_sends_nothing_after_the_snapshot(stub):
    with open_stream(stub, {"X-Stub-Scenario": "silent"}) as r:
        kinds = [e[1] for e in r.events(time.time() + 1)]
    assert kinds == ["snapshot"]


def test_buffered_control_omits_the_accel_header_only(stub):
    with open_stream(stub, {"X-Stub-Scenario": "buffered-control"}) as r:
        assert r.status == 200 and "x-accel-buffering" not in r.headers
        assert r.headers["cache-control"] == "no-store, no-transform"


def test_batched_control_holds_updates_and_writes_them_together(stub):
    with open_stream(stub, {"X-Stub-Scenario": "batched-control", "X-Stub-Interval-S": "0.2"}) as r:
        t0 = time.time()
        updates = [e for e in r.events(time.time() + 4.2) if e[1] == "update"]
    assert len(updates) >= 10
    assert min(u[0] - t0 for u in updates) > 2.5, "nothing is delivered before the 3 s flush"
    lat = [t - __import__("json").loads(d)["sent_at"] for t, n, d in updates]
    gaps = [b[0] - a[0] for a, b in zip(updates, updates[1:])]
    assert max(lat) > 1.0 and min(gaps) < 0.1, "the control must look batched to the timing measurement"


def test_max_lifetime_ends_a_stream_with_the_terminating_chunk(stub):
    with open_stream(stub, {"X-Stub-Max-S": "0.4"}) as r:
        list(r.events(time.time() + 3))
        assert r.eof and r.closed_at is not None


@pytest.mark.parametrize("scenario,status,code,retry", [("401", 401, "UNAUTHENTICATED", None), ("429", 429, "STREAM_LIMIT", "5"), ("503", 503, "SHUTTING_DOWN", "1")])
def test_error_scenarios_use_the_phase2_envelope_and_headers(stub, scenario, status, code, retry):
    with open_stream(stub, {"X-Stub-Scenario": scenario}) as r:
        body = r.json()
        assert r.status == status and body["error"]["code"] == code
        assert r.headers["content-type"].startswith("application/json") and r.headers["cache-control"] == "no-store"
        assert r.headers.get("retry-after") == retry and r.headers["x-request-id"]


@pytest.mark.parametrize("method", ["POST", "PUT", "DELETE", "HEAD"])
def test_only_get_is_allowed(stub, method):
    with open_stream(stub, method=method) as r:
        assert r.status == 405 and r.headers["allow"] == "GET"


def test_client_abort_is_seen_and_the_slot_is_freed(stub):
    before = state(stub)
    r = open_stream(stub)
    list(r.events(time.time() + 3, stop_after=1))
    assert state(stub)["open_streams"] == before["open_streams"] + 1, "positive control: the open stream is counted"
    r.close()
    deadline = time.time() + 5
    while time.time() < deadline and state(stub)["open_streams"] != before["open_streams"]:
        time.sleep(0.1)
    after = state(stub)
    assert after["open_streams"] == before["open_streams"] and after["aborted"] == before["aborted"] + 1


def test_echo_reports_forwarded_headers_but_never_the_token(stub):
    with open_stream(stub, {"Authorization": "Bearer not-a-real-token", "X-Forwarded-Proto": "http"}, path=stub_backend.ECHO_PATH) as r:
        body = r.json()
    assert body["authorization_forwarded"] is True and body["x_forwarded_proto"] == "http"
    assert "not-a-real-token" not in str(body)


def test_unknown_path_is_a_json_404(stub):
    with open_stream(stub, path="/api/nothing") as r:
        assert r.status == 404 and r.json()["error"]["code"] == "NOT_FOUND"


# --- the stub stays out of images --------------------------------------------------------------------------------

def test_no_dockerfile_copies_the_testing_folder():
    for dockerfile in (REPO / "services").glob("*/Dockerfile"):
        text = dockerfile.read_text(encoding="utf-8")
        for line in text.splitlines():
            if line.strip().upper().startswith(("COPY", "ADD")):
                assert "infra" not in line and "testing" not in line and "stub_backend" not in line, f"{dockerfile}: {line}"


def test_the_inference_allow_list_does_not_admit_infra():
    allow = (REPO / "services" / "inference" / "Dockerfile.dockerignore").read_text(encoding="utf-8").splitlines()
    admitted = [l for l in allow if l.startswith("!")]
    assert admitted and not any("infra" in l for l in admitted)


def test_pinned_images_match_the_repository_dockerfiles():
    runner = (HARNESS / "run_checks.py").read_text(encoding="utf-8")
    ingestion = (REPO / "services" / "ingestion" / "Dockerfile").read_text(encoding="utf-8")
    python_image = re.search(r"^FROM (\S+)$", ingestion, re.M).group(1)
    assert python_image in runner, "the stub's Python image must be the ingestion image's pinned base"
    assert "services/web/Dockerfile" in runner and "NGINX_IMAGE" in runner, "the Nginx image must be read from the web Dockerfile"
