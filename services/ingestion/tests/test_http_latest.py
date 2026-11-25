"""`GET /v1/latest` and `GET /healthz` against AD-1 §3.1 (P-1).

These run a real `ThreadingHTTPServer` on an ephemeral loopback port and speak
to it with `http.client`, so the status line, the headers and the exact body are
checked as a client sees them, not as the handler intended them. Nothing listens
outside loopback and no request leaves the machine.
"""
from __future__ import annotations

import http.client
import json
import threading

import pytest

from cbdc_ingestion import PROTOCOL_VERSION, SOURCE_ID
from cbdc_ingestion.clock import ManualClock
from cbdc_ingestion.http_api import make_server
from cbdc_ingestion.service import IngestionService

from .conftest import SEED, START_MS


class Harness:
    """A running server plus a client that talks to it."""

    def __init__(self, service: IngestionService) -> None:
        self.service = service
        self.server = make_server(service, host="127.0.0.1", port=0)
        self.host, self.port = self.server.server_address[:2]
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()

    def request(self, method: str, path: str, body: bytes = None, headers: dict = None):
        connection = http.client.HTTPConnection(self.host, self.port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            raw = response.read()
            return response.status, dict(response.getheaders()), raw
        finally:
            connection.close()

    def json(self, method: str, path: str, **kwargs):
        status, headers, raw = self.request(method, path, **kwargs)
        return status, headers, (json.loads(raw) if raw else None)

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


@pytest.fixture
def harness():
    clock = ManualClock(START_MS)
    service = IngestionService(SEED, clock=clock, start_ms=START_MS)
    service.start(run_loop=False)
    harness = Harness(service)
    harness.clock = clock
    try:
        yield harness
    finally:
        harness.close()
        service.stop()


# ------------------------------------------------------------------------- 200
def test_the_empty_state_is_200_with_an_empty_list(harness):
    """AD-1 §3.1: "Never 204 or 404"."""
    status, headers, body = harness.json("GET", "/v1/latest")
    assert status == 200
    assert headers["Content-Type"] == "application/json"
    assert headers["Cache-Control"] == "no-store"
    assert body["events"] == []
    assert body["protocol_version"] == PROTOCOL_VERSION
    assert body["source_id"] == SOURCE_ID


def test_200_serves_the_four_pairs_in_order(harness):
    harness.clock.set_ms(START_MS + 1500)
    harness.service.tick()
    _, _, body = harness.json("GET", "/v1/latest")
    assert [(e["payload"]["base_currency"], e["payload"]["quote_currency"]) for e in body["events"]] == [
        ("AED", "MXN"), ("EUR", "USD"), ("GBP", "PHP"), ("USD", "INR")]
    assert set(body) == {"protocol_version", "instance_id", "source_id", "generated_at", "events"}
    assert all(e["validation"]["status"] == "validated" for e in body["events"])
    assert all(e["provenance_class"] == "synthetic" for e in body["events"])


def test_a_quarantined_event_is_never_served(harness):
    """AD-1 §3.1: only validated envelopes reach a reader."""
    from cbdc_ingestion.envelope import CLOCK_TOLERANCE_MS, build_fx_event, fx_payload

    harness.service.store.apply(build_fx_event(
        seed=SEED, sequence=1, payload=fx_payload("USD", "INR", "1.234500"),
        retrieved_at_ms=START_MS, source_timestamp_ms=START_MS + CLOCK_TOLERANCE_MS + 1))
    _, _, body = harness.json("GET", "/v1/latest")
    assert body["events"] == []


def test_at_most_four_events_and_one_per_pair(harness):
    harness.clock.set_ms(START_MS + 60_000)
    harness.service.tick()
    _, _, body = harness.json("GET", "/v1/latest")
    keys = [f"{e['payload']['base_currency']}/{e['payload']['quote_currency']}" for e in body["events"]]
    assert len(keys) == 4 == len(set(keys))


# ----------------------------------------------------------------------- errors
def test_a_query_parameter_is_400_invalid_request(harness):
    status, _, body = harness.json("GET", "/v1/latest?pair=USD/INR")
    assert status == 400
    assert body == {"error": {"code": "INVALID_REQUEST",
                              "message": "This endpoint takes no query parameters and no body."}}


def test_an_empty_query_string_is_also_400(harness):
    assert harness.json("GET", "/v1/latest?")[0] == 400


def test_a_body_on_get_is_400_invalid_request(harness):
    status, _, body = harness.json("GET", "/v1/latest", body=b'{"x":1}',
                                   headers={"Content-Type": "application/json"})
    assert status == 400
    assert body["error"]["code"] == "INVALID_REQUEST"


def test_an_oversized_refused_body_is_not_drained(harness):
    """A body past `MAX_DRAIN_BYTES` is left unread and the connection is closed.

    An unauthenticated endpoint must not be made to read an arbitrary number of
    bytes for a request it has already refused. The client therefore sees either
    the 400 (when the whole body fitted in the socket buffers before the close) or
    the aborted connection; both are correct, and the assertion allows both rather
    than depending on the host's buffer sizes.
    """
    import http.client as client_module

    from cbdc_ingestion.http_api import MAX_DRAIN_BYTES

    try:
        status, headers, body = harness.json("GET", "/v1/latest", body=b"x" * (MAX_DRAIN_BYTES + 1),
                                             headers={"Content-Type": "text/plain"})
    except (OSError, client_module.HTTPException):
        return  # the connection was closed with the body unread, as intended
    assert status == 400
    assert body["error"]["code"] == "INVALID_REQUEST"
    assert headers.get("Connection") == "close"


def test_an_unknown_path_is_404_not_found(harness):
    status, _, body = harness.json("GET", "/v1/events")
    assert status == 404
    assert body["error"]["code"] == "NOT_FOUND"
    # Also for a method that would otherwise be refused: the path does not exist.
    assert harness.json("POST", "/nope")[0] == 404


def test_the_root_path_is_404(harness):
    assert harness.json("GET", "/")[0] == 404


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
def test_another_method_is_405_with_allow_get(harness, method):
    status, headers, body = harness.json(method, "/v1/latest")
    assert status == 405
    assert headers["Allow"] == "GET"
    assert body["error"]["code"] == "METHOD_NOT_ALLOWED"


def test_head_is_405_with_allow_get_and_no_body(harness):
    status, headers, raw = harness.request("HEAD", "/v1/latest")
    assert status == 405
    assert headers["Allow"] == "GET"
    assert raw == b""


def test_not_ready_is_503(harness):
    harness.service.stop()
    status, _, body = harness.json("GET", "/v1/latest")
    assert status == 503
    assert body["error"]["code"] == "NOT_READY"


def test_an_error_body_carries_no_internal_detail(harness):
    for path, method in (("/v1/latest?x=1", "GET"), ("/nope", "GET"), ("/v1/latest", "POST")):
        _, _, body = harness.json(method, path)
        assert set(body) == {"error"}
        assert set(body["error"]) == {"code", "message"}
        text = json.dumps(body)
        for leak in ("Traceback", "cbdc_ingestion", "File \"", "/v1/latest?", "127.0.0.1"):
            assert leak not in text


def test_an_internal_failure_is_500_and_says_nothing_else(harness, monkeypatch):
    monkeypatch.setattr(harness.service, "latest_response",
                        lambda: (_ for _ in ()).throw(RuntimeError("secret detail")))
    status, _, body = harness.json("GET", "/v1/latest")
    assert status == 500
    assert body == {"error": {"code": "INTERNAL_ERROR",
                              "message": "The request could not be served."}}


# ----------------------------------------------------------------------- health
def test_healthz_is_200_while_the_process_lives(harness):
    status, _, body = harness.json("GET", "/healthz")
    assert status == 200
    assert body["status"] == "alive"


def test_healthz_is_200_even_when_not_ready(harness):
    """It answers for the process, not for readiness (AD-1 §3.1)."""
    harness.service.stop()
    status, _, body = harness.json("GET", "/healthz")
    assert status == 200
    assert body["state"] == "stopped"


def test_the_server_banner_names_no_runtime(harness):
    _, headers, _ = harness.request("GET", "/healthz")
    assert headers["Server"] == "cbdc-ingestion"
    assert "Python" not in headers["Server"]
