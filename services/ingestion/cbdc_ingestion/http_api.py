"""The private HTTP endpoint: `GET /v1/latest` and `GET /healthz` (AD-1 §3.1, P-1).

A standard-library `ThreadingHTTPServer`. There is no framework, no router, no
template and no static file: two paths, one method, one response shape.

The contract this implements, exactly as AD-1 §3.1 fixes it:

- **`GET /v1/latest`** takes no query, no body and **no authentication**: the
  component holds no credential and never checks one. Its isolation is the
  internal Compose network, or host loopback outside Docker (AD-1 §2). It
  returns `200 application/json` with `Cache-Control: no-store` and a closed
  body of `protocol_version`, `instance_id`, `source_id`, `generated_at` and
  `events` (0 to 4 validated envelopes, at most one per pair, sorted by base
  then quote). Before the first event it is `200` with `events: []` -- never
  `204`, never `404`.
- **Errors** are `{"error": {"code", "message"}}` and **nothing else**: no
  internal detail, no path, no traceback, no request echo.

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_REQUEST` | Any query parameter or body |
| 404 | `NOT_FOUND` | Unknown path |
| 405 | `METHOD_NOT_ALLOWED` | A method other than GET, with `Allow: GET` |
| 500 | `INTERNAL_ERROR` | Unexpected failure |
| 503 | `NOT_READY` | The generator is not running, or is stopping |

- **`GET /healthz`** returns 200 while the process is alive (AD-1 §3.1) and is
  the container health check. It is deliberately independent of readiness: it
  answers 200 even while the service is `starting` or `stopping`, because its
  question is whether the process lives, not whether a value exists.

An unknown path answers 404 whatever the method, because the method of a path
that does not exist is not worth reporting; a known path with the wrong method
answers 405 with `Allow: GET`.
"""
from __future__ import annotations

import json
import logging
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional, Tuple

from .service import IngestionService

logger = logging.getLogger(__name__)

LATEST_PATH = "/v1/latest"
HEALTH_PATH = "/healthz"
JSON_CONTENT_TYPE = "application/json"

# The largest refused body this endpoint reads and discards so that the client can
# read its error response. Anything larger is left unread (see `_drain_body`).
MAX_DRAIN_BYTES = 8192

ERRORS = {
    "INVALID_REQUEST": (HTTPStatus.BAD_REQUEST, "This endpoint takes no query parameters and no body."),
    "NOT_FOUND": (HTTPStatus.NOT_FOUND, "Unknown path."),
    "METHOD_NOT_ALLOWED": (HTTPStatus.METHOD_NOT_ALLOWED, "Only GET is allowed."),
    "INTERNAL_ERROR": (HTTPStatus.INTERNAL_SERVER_ERROR, "The request could not be served."),
    "NOT_READY": (HTTPStatus.SERVICE_UNAVAILABLE, "The generator is not running."),
}


class IngestionHandler(BaseHTTPRequestHandler):
    """One request. The service is read from the server object; the handler holds no state."""

    protocol_version = "HTTP/1.1"  # so Content-Length and keep-alive behave predictably

    # The default banner names Python and its exact version. This component is
    # unauthenticated on a shared internal network, so it states nothing about its
    # runtime.
    server_version = "cbdc-ingestion"
    sys_version = ""

    @property
    def service(self) -> IngestionService:
        return self.server.service  # type: ignore[attr-defined]

    # ------------------------------------------------------------------ methods
    def do_GET(self) -> None:
        self._handle()

    def do_HEAD(self) -> None:
        # 405 like any other non-GET method, but with no body, as HEAD requires.
        self._reject_method(send_body=False)

    def do_POST(self) -> None:
        self._reject_method()

    def do_PUT(self) -> None:
        self._reject_method()

    def do_PATCH(self) -> None:
        self._reject_method()

    def do_DELETE(self) -> None:
        self._reject_method()

    def do_OPTIONS(self) -> None:
        self._reject_method()

    def _reject_method(self, send_body: bool = True) -> None:
        path, _has_query = self._split_target()
        if send_body:
            # HEAD carries no body to drain; every other refused method may.
            self._drain_body()
        if path not in (LATEST_PATH, HEALTH_PATH):
            self._error("NOT_FOUND", send_body=send_body)
            return
        self._error("METHOD_NOT_ALLOWED", headers={"Allow": "GET"}, send_body=send_body)

    def version_string(self) -> str:
        """The `Server` header. The default appends the exact Python version."""
        return self.server_version

    # ------------------------------------------------------------------ routing
    def _split_target(self) -> Tuple[str, bool]:
        """The request path, and whether the target carried a query string at all.

        A bare `?` with nothing after it is treated as a query and refused with the
        rest: this endpoint accepts no input, and accepting the one spelling that
        happens to be empty would be a special case with nothing to recommend it.
        No fragment can reach a server.
        """
        path, marker, _query = self.path.partition("?")
        return path, bool(marker)

    def _handle(self) -> None:
        try:
            path, has_query = self._split_target()
            if path not in (LATEST_PATH, HEALTH_PATH):
                self._error("NOT_FOUND")
                return
            if has_query or self._has_body():
                self._drain_body()
                self._error("INVALID_REQUEST")
                return
            if path == HEALTH_PATH:
                self._json(HTTPStatus.OK, {"status": "alive", "state": self.service.state})
                return
            if not self.service.ready:
                self._error("NOT_READY")
                return
            self._json(HTTPStatus.OK, self.service.latest_response())
        except Exception:  # noqa: BLE001 - never leak an exception to the client
            logger.exception("request handling failed")
            try:
                self._error("INTERNAL_ERROR")
            except Exception:  # noqa: BLE001 - the connection is already gone
                pass

    def _has_body(self) -> bool:
        length = self.headers.get("Content-Length")
        if length is not None and length.strip() not in ("", "0"):
            return True
        return bool(self.headers.get("Transfer-Encoding"))

    def _drain_body(self) -> None:
        """Reads and discards a small declared body, so the client reads its 400.

        The component accepts no input, so the bytes are thrown away unparsed and
        never logged. The read is **bounded** by `MAX_DRAIN_BYTES`: a larger or
        chunked body is left unread and the connection is closed instead (`_json`
        adds `Connection: close`), because draining an arbitrary number of bytes for
        a request that is already refused is exactly the work an unauthenticated
        endpoint must not be made to do.
        """
        length = self.headers.get("Content-Length")
        try:
            declared = int((length or "0").strip() or 0)
        except ValueError:
            return
        if 0 < declared <= MAX_DRAIN_BYTES:
            try:
                self.rfile.read(declared)
                self._body_drained = True
            except OSError:
                pass

    # ---------------------------------------------------------------- responses
    def _json(self, status: HTTPStatus, body: dict, headers: Optional[dict] = None,
              send_body: bool = True) -> None:
        raw = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", JSON_CONTENT_TYPE)
        self.send_header("Content-Length", str(len(raw)))
        # AD-1 §3.1: no cached observation may be served as current.
        self.send_header("Cache-Control", "no-store")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        if self._has_body() and not getattr(self, "_body_drained", False):
            # The body was not read, so the connection cannot carry another request.
            self.close_connection = True
            self.send_header("Connection", "close")
        self.end_headers()
        if send_body:
            self.wfile.write(raw)

    def _error(self, code: str, headers: Optional[dict] = None, send_body: bool = True) -> None:
        status, message = ERRORS[code]
        self._json(status, {"error": {"code": code, "message": message}}, headers=headers,
                   send_body=send_body)

    # The default implementation writes an HTML error page and its own status line.
    # Everything here answers with the JSON envelope instead.
    def send_error(self, code, message=None, explain=None) -> None:  # noqa: D102
        mapped = {400: "INVALID_REQUEST", 404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED",
                  501: "METHOD_NOT_ALLOWED", 503: "NOT_READY"}.get(int(code), "INTERNAL_ERROR")
        extra = {"Allow": "GET"} if mapped == "METHOD_NOT_ALLOWED" else None
        self._error(mapped, headers=extra)

    def log_message(self, fmt: str, *args) -> None:
        """Access logging through the component's logger, at debug level.

        The request line can hold anything a client sent, so it is logged at debug
        only and never at warning or above, where it would end up in an operator's
        default view.
        """
        logger.debug("%s - %s", self.address_string(), fmt % args)


class IngestionHTTPServer(ThreadingHTTPServer):
    """A threading server that carries the `IngestionService` the handlers read."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, service: IngestionService) -> None:
        super().__init__(address, IngestionHandler)
        self.service = service


def make_server(service: IngestionService, host: str = "127.0.0.1", port: int = 8300) -> IngestionHTTPServer:
    """A server bound to `host:port`. Port 0 binds an ephemeral port, which the tests use.

    The default host is loopback: outside Docker the component must not be
    reachable from the network (AD-1 §2). The container form binds `0.0.0.0`
    inside its own internal network and publishes no port (AD-1 §3.6, P-6).
    """
    return IngestionHTTPServer((host, port), service)
