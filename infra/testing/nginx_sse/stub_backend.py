"""TEST-ONLY stub of the Express observation stream, for the P-7 Nginx checks (AD-1 v0.5 section 3.6).

It exists so that the Nginx reverse proxy can be tested before, and independently of, Dev B's backend. It is NOT part of
any image: it lives under infra/testing/, no Dockerfile copies it, and the workflow mounts it read-only into a throwaway
container. Standard library only. It never logs a request header, so no token can reach a log.

Paths (all under /api/, so the repo's nginx.conf.template proxies them unchanged):
  GET /api/rt/v1/observations/stream   a Server-Sent Events stream. Scenario by header `X-Stub-Scenario`:
        updates (default)  snapshot at once, then an `update` every `X-Stub-Interval-S` (default 1), a heartbeat every
                           `X-Stub-Heartbeat-S` (default 15)
        quiet              snapshot, then heartbeats only
        silent             snapshot, then nothing at all (control: Nginx's read timeout must end it)
        buffered-control   like updates, but WITHOUT `X-Accel-Buffering: no` (observation only: Nginx 1.28.0 still delivers promptly)
        batched-control    like updates, but the STUB holds updates for 3 s and writes them together (control: the timing
                           checks must be able to see batched delivery)
        401 | 429 | 503    an error response in the Phase 2 envelope, with the headers the real route sends
      `X-Stub-Max-S` (default 300) ends any stream, so an orphan connection cannot outlive a test run.
  GET /api/__stub/state                counters: open_streams, total_streams, aborted
  GET /api/__stub/echo                 which proxy headers arrived; never the Authorization value
  anything but GET                     405 with `Allow: GET`, as the real route (HEAD included)

Usage:  python stub_backend.py [--host 0.0.0.0] [--port 4000]
"""
from __future__ import annotations

import argparse
import json
import select
import socket
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STREAM_PATH = "/api/rt/v1/observations/stream"
STATE_PATH = "/api/__stub/state"
ECHO_PATH = "/api/__stub/echo"

ERRORS = {
    "401": (401, "UNAUTHENTICATED", "Authentication required.", {"WWW-Authenticate": "Bearer"}),
    "429": (429, "STREAM_LIMIT", "Too many streams.", {"Retry-After": "5"}),
    "503": (503, "SHUTTING_DOWN", "The server is shutting down.", {"Retry-After": "1"}),
}


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.open_streams = 0
        self.total_streams = 0
        self.aborted = 0

    def snapshot(self):
        with self.lock:
            return {"open_streams": self.open_streams, "total_streams": self.total_streams, "aborted": self.aborted}


def make_handler(state: State):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        _hold = None  # only the batched-control scenario keeps updates back

        def log_message(self, *args):  # never log: a request line or header could carry a token
            pass

        # ---- helpers -------------------------------------------------------------------------------------------
        def _json(self, status, body, extra=None):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Request-Id", str(uuid.uuid4()))
            self.send_header("Content-Length", str(len(data)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)

        def _chunk(self, data: bytes):
            self.wfile.write(b"%x\r\n" % len(data) + data + b"\r\n")
            self.wfile.flush()

        def _event(self, seq, kind, **extra):
            body = {"protocol_version": "1.0", "type": kind, "stream_seq": seq, "sent_at": time.time(), **extra}
            data = f"event: {kind}\ndata: {json.dumps(body)}\n\n".encode()
            if self._hold is not None and kind == "update":
                self._hold.append(data)  # batched-control: kept back, written together by the loop
            else:
                self._chunk(data)

        def _client_gone(self):
            try:
                if select.select([self.connection], [], [], 0.05)[0]:
                    return self.connection.recv(1, socket.MSG_PEEK) == b""
            except OSError:
                return True
            return False

        # ---- routing -------------------------------------------------------------------------------------------
        def do_GET(self):
            path = self.path.split("?")[0]
            scenario = (self.headers.get("X-Stub-Scenario") or "updates").lower()
            if path == STATE_PATH:
                return self._json(200, state.snapshot())
            if path == ECHO_PATH:
                h = self.headers
                return self._json(200, {"authorization_forwarded": h.get("Authorization") is not None,
                                        "host": h.get("Host"), "x_forwarded_for": h.get("X-Forwarded-For") is not None,
                                        "x_forwarded_proto": h.get("X-Forwarded-Proto"), "x_real_ip": h.get("X-Real-IP") is not None})
            if path == STREAM_PATH:
                if scenario in ERRORS:
                    status, code, message, extra = ERRORS[scenario]
                    return self._json(status, {"error": {"code": code, "message": message}}, extra)
                return self._stream(scenario)
            return self._json(404, {"error": {"code": "NOT_FOUND", "message": "Unknown path."}})

        def _not_get(self):
            self._json(405, {"error": {"code": "METHOD_NOT_ALLOWED", "message": "Only GET is allowed."}}, {"Allow": "GET"})

        do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = _not_get

        # ---- the stream ----------------------------------------------------------------------------------------
        def _stream(self, scenario):
            interval = float(self.headers.get("X-Stub-Interval-S") or 1)
            heartbeat = float(self.headers.get("X-Stub-Heartbeat-S") or 15)
            max_s = float(self.headers.get("X-Stub-Max-S") or 300)
            with state.lock:
                state.open_streams += 1
                state.total_streams += 1
            aborted = False
            self._hold = [] if scenario == "batched-control" else None
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-store, no-transform")
                if scenario != "buffered-control":
                    self.send_header("X-Accel-Buffering", "no")
                self.send_header("X-Request-Id", str(uuid.uuid4()))
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                self.wfile.flush()
                seq = 1
                self._event(seq, "snapshot", profile={"stale_after_ms": 6000, "unavailable_after_ms": 30000}, values=[])
                start = last_update = last_beat = last_flush = time.monotonic()
                while time.monotonic() - start < max_s:
                    if self._client_gone():
                        aborted = True
                        break
                    now = time.monotonic()
                    if scenario in ("updates", "buffered-control", "batched-control") and now - last_update >= interval:
                        seq += 1
                        last_update = now
                        self._event(seq, "update", value={"pair": "USD/INR"})
                    if self._hold and now - last_flush >= 3:
                        self._chunk(b"".join(self._hold))
                        self._hold, last_flush = [], now
                    if scenario != "silent" and now - last_beat >= heartbeat:
                        seq += 1
                        last_beat = now
                        self._event(seq, "heartbeat")
                    time.sleep(0.02)
                if not aborted:
                    self._chunk(b"")  # normal end of stream: the terminating chunk
            except (BrokenPipeError, ConnectionResetError, OSError):
                aborted = True
            finally:
                with state.lock:
                    state.open_streams -= 1
                    if aborted:
                        state.aborted += 1
                self.close_connection = True

    return Handler


def make_server(host="127.0.0.1", port=0):
    state = State()
    server = ThreadingHTTPServer((host, port), make_handler(state))
    server.daemon_threads = True
    server.state = state
    return server


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=4000)
    args = ap.parse_args()
    make_server(args.host, args.port).serve_forever()
