"""TEST-ONLY fake ingestion service (Dev D; AD-1 v0.5 section 3.7 fault injection). Standard library plus the ingestion package.

Replaces the real ingestion process inside the SAME container image and network position, through the test override
infra/compose.observations-test.yaml. It answers what Express polls (GET /v1/latest, GET /healthz on 0.0.0.0:8300) and obeys one
scenario at a time (scenarios.py). The control interface listens on 127.0.0.1:8301 INSIDE the container only: nothing is
published, nothing else on the network can reach it, and non-loopback clients are refused anyway. A test steers it with
`docker compose exec ingestion python /fault/ctl.py set SCENARIO` (p3_stack.py fault). It is mounted read-only from this
directory, so it is in no image and in no default stack.

Control (loopback only):  POST /scenario  body=<scenario>   GET /state   -> {"scenario", "set_at_ms", "requests", "last_status"}
"""
from __future__ import annotations

import json
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scenarios  # noqa: E402

DEFAULT_SCENARIO = "normal"
DATA_PORT = 8300
CONTROL_HOST, CONTROL_PORT = "127.0.0.1", 8301
NOT_FOUND = b'{"error":{"code":"NOT_FOUND","message":"Request refused."}}'
NOT_ALLOWED = b'{"error":{"code":"METHOD_NOT_ALLOWED","message":"Request refused."}}'


class State:
    def __init__(self, text: str = DEFAULT_SCENARIO, clock=lambda: int(time.time() * 1000)):
        self.lock = threading.Lock()
        self.clock = clock
        self.requests = 0
        self.last_status = None
        self.set(text)

    def set(self, text: str) -> None:
        parsed = scenarios.parse(text)  # raises before anything changes
        with self.lock:
            self.text, self.scenario, self.set_at_ms = text.strip(), parsed, self.clock()

    def snapshot(self) -> dict:
        with self.lock:
            return {"scenario": self.text, "set_at_ms": self.set_at_ms, "requests": self.requests, "last_status": self.last_status}


class DataHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    state: State

    def log_message(self, *_args) -> None:  # silent: no request is logged
        pass

    def _send(self, status, body=b"", content_type="application/json", headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/healthz":
            return self._send(200, b'{"status":"ok"}')
        if self.path != "/v1/latest":
            return self._send(404, NOT_FOUND)
        with self.state.lock:
            scenario, set_at = self.state.scenario, self.state.set_at_ms
            self.state.requests += 1
        response = scenarios.respond(scenario, self.state.clock(), set_at)
        if response.delay_ms:
            time.sleep(response.delay_ms / 1000)
        with self.state.lock:
            self.state.last_status = "drop" if response.drop else response.status
        if response.drop:
            self.close_connection = True
            self.connection.close()
            return
        self._send(response.status, response.body, response.content_type, response.headers)

    def do_POST(self):
        self._send(405, NOT_ALLOWED, headers={"Allow": "GET"})


class ControlHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    state: State

    def log_message(self, *_args) -> None:
        pass

    def _json(self, status, doc):
        body = json.dumps(doc).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _allowed(self) -> bool:
        if scenarios.is_loopback(self.client_address[0]):
            return True
        self._json(403, {"error": "control is loopback only"})
        return False

    def do_GET(self):
        if not self._allowed():
            return
        if self.path == "/state":
            return self._json(200, self.state.snapshot())
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self._allowed():
            return
        if self.path != "/scenario":
            return self._json(404, {"error": "not found"})
        size = min(int(self.headers.get("Content-Length") or 0), 256)
        text = self.rfile.read(size).decode("utf-8", "replace")
        try:
            self.state.set(text)
        except scenarios.ScenarioError as error:
            return self._json(400, {"error": str(error)})
        self._json(200, self.state.snapshot())


def make_servers(state: State, data_host: str = "0.0.0.0", data_port: int = DATA_PORT, control_port: int = CONTROL_PORT):
    data = type("Data", (DataHandler,), {"state": state})
    control = type("Control", (ControlHandler,), {"state": state})
    return ThreadingHTTPServer((data_host, data_port), data), ThreadingHTTPServer((CONTROL_HOST, control_port), control)


def main() -> int:
    state = State(os.environ.get("CBDC_FAULT_SCENARIO", DEFAULT_SCENARIO))
    data, control = make_servers(state)
    threading.Thread(target=control.serve_forever, daemon=True).start()
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=data.shutdown, daemon=True).start())
    print(f"fault ingestion: scenario {state.text!r}; data :{DATA_PORT}, control {CONTROL_HOST}:{CONTROL_PORT} (container loopback only)", flush=True)
    try:
        data.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
