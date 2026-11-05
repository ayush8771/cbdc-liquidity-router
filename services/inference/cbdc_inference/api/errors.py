"""Error envelope (API contract §4) and X-Request-Id handling (contract §1)."""
from __future__ import annotations

import logging
import uuid
from typing import Any, Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from ..engine.errors import EngineError

logger = logging.getLogger(__name__)

REQUEST_ID_HEADER = "X-Request-Id"
# Contract §4 requires Retry-After on these codes but does not fix the values.
RETRY_AFTER_S = {"ENGINE_BUSY": 1, "NOT_READY": 5}
# §4: the only `details` members this contract defines. Anything else an engine error carries
# is dropped, so no internal filesystem path, exception text or configuration value can leak
# through `details` -- only sanitised, caller-supplied field paths reach the client.
ALLOWED_DETAIL_KEYS = ("errors", "field", "cause")


def sanitise_details(code: str, details: Optional[dict]) -> dict:
    """The contract-shaped `details` for one error code (§4).

    `VALIDATION_ERROR` carries `details.errors`, a non-empty array of `{"field", "message"}`.
    An error that is about no single field **omits** `field` entirely: there is one
    representation and no empty-string marker, and consumers read a missing `field` as a
    form-level error. Other 422 codes may carry `details.field` instead.
    """
    details = dict(details or {})
    out = {k: details[k] for k in ALLOWED_DETAIL_KEYS if k in details}
    if code != "VALIDATION_ERROR":
        return out
    errors = out.get("errors")
    if not isinstance(errors, list) or not errors:
        # Fold a single-field engine error into the required `errors[]` shape.
        item = {"message": details.get("message") or "Request failed validation."}
        if isinstance(out.get("field"), str) and out["field"]:
            item["field"] = out["field"]
        errors = [item]
    cleaned = []
    for item in errors:
        item = dict(item) if isinstance(item, dict) else {"message": str(item)}
        entry = {"message": str(item.get("message", "Request failed validation."))}
        field = item.get("field")
        if isinstance(field, str) and field:
            entry["field"] = field  # omitted entirely when there is no single field
        cleaned.append(entry)
    return {"errors": cleaned}


class EngineAPIError(Exception):
    """Raised by routers to return a contract error code (contract §4)."""

    def __init__(self, status_code: int, code: str, message: str,
                 details: Optional[dict] = None, headers: Optional[dict] = None):
        super().__init__(message)
        self.status_code, self.code, self.message = status_code, code, message
        self.details, self.headers = details or {}, headers or {}


def request_id_of(request: Request) -> str:
    return getattr(request.state, "request_id", None) or str(uuid.uuid4())


def error_response(request: Request, status_code: int, code: str, message: str,
                   details: Optional[dict[str, Any]] = None, headers: Optional[dict] = None) -> JSONResponse:
    rid = request_id_of(request)
    body = {"error": {"code": code, "message": message, "details": sanitise_details(code, details),
                      "request_id": rid}}
    return JSONResponse(status_code=status_code, content=body, headers={**(headers or {}), REQUEST_ID_HEADER: rid})


def install_error_handling(app: FastAPI) -> None:
    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):
        request.state.request_id = request.headers.get(REQUEST_ID_HEADER) or str(uuid.uuid4())
        try:
            response = await call_next(request)
        except Exception:  # noqa: BLE001 - never leak a stack trace (contract §4)
            logger.exception("unhandled error (request_id=%s)", request.state.request_id)
            return error_response(request, 500, "INTERNAL_ERROR", "Unexpected internal error.")
        response.headers[REQUEST_ID_HEADER] = request.state.request_id
        return response

    @app.exception_handler(EngineAPIError)
    async def _engine_error(request: Request, exc: EngineAPIError):
        return error_response(request, exc.status_code, exc.code, exc.message, exc.details, exc.headers)

    @app.exception_handler(EngineError)
    async def _engine_side_error(request: Request, exc: EngineError):
        """Engine errors carry their contract §4 code and HTTP status."""
        headers = {}
        if exc.code in RETRY_AFTER_S:
            headers["Retry-After"] = str(RETRY_AFTER_S[exc.code])
        if exc.code == "INTERNAL_ERROR":
            # integrity failures, worker crashes, unexpected errors: log the detail, return none of it
            logger.error("engine INTERNAL_ERROR (request_id=%s): %s %s", request_id_of(request), exc.message,
                         exc.details)
            return error_response(request, 500, "INTERNAL_ERROR", "Unexpected internal error.")
        if exc.code == "NOT_READY":
            # §4: a 503 NOT_READY never exposes which artefacts or paths were missing.
            logger.warning("engine NOT_READY (request_id=%s): %s %s", request_id_of(request), exc.message,
                           exc.details)
            return error_response(request, 503, "NOT_READY",
                                  "The inference service is not ready yet; retry shortly.", headers=headers)
        # The per-field message of a VALIDATION_ERROR is the engine's sanitised message.
        details = {**exc.details, "message": exc.message}
        return error_response(request, exc.http_status, exc.code, exc.message, details, headers)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError):
        errors = exc.errors()
        if any(e.get("type") == "json_invalid" for e in errors):
            return error_response(request, 400, "MALFORMED_REQUEST", "Request body is not valid JSON.")
        # §4: `details.errors[]` is a list of {field, message}. `field` is the value's path in
        # this API's own request body, with `.` between keys and `[n]` for array indexes; it is
        # omitted when the error is about no single field.
        items = []
        for e in errors:
            loc = [part for part in e.get("loc", ()) if part not in ("body", "query")]
            item = {"message": str(e.get("msg", "Request failed validation."))}
            field = _field_path(loc)
            if field:
                item["field"] = field
            items.append(item)
        return error_response(request, 422, "VALIDATION_ERROR", "Request failed validation.",
                              {"errors": items or [{"message": "Request failed validation."}]})

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException):
        if exc.status_code == 404:
            return error_response(request, 404, "NOT_FOUND", "Unknown resource.")
        if exc.status_code == 405:
            # §4 / A-5b: 405 METHOD_NOT_ALLOWED carries an `Allow` header listing the path's
            # methods (RFC 9110).
            headers = dict(getattr(exc, "headers", None) or {})
            allow = headers.get("Allow") or _allowed_methods(app, request.url.path)
            if allow:
                headers["Allow"] = allow
            return error_response(request, 405, "METHOD_NOT_ALLOWED",
                                  "The path exists, but not with this method.", headers=headers)
        logger.warning("framework HTTP %s on %s", exc.status_code, request.url.path)
        return error_response(request, exc.status_code,
                              "MALFORMED_REQUEST" if exc.status_code < 500 else "INTERNAL_ERROR",
                              str(exc.detail), headers=getattr(exc, "headers", None))


def _field_path(loc) -> str:
    """A pydantic/FastAPI `loc` tuple as the contract's field path: `.` between keys and
    `[n]` for array indexes (§4)."""
    out = ""
    for part in loc:
        if isinstance(part, int):
            out += f"[{part}]"
        else:
            out = f"{out}.{part}" if out else str(part)
    return out


def _allowed_methods(app: FastAPI, path: str) -> str:
    """The methods registered for `path`, for the `Allow` header of a 405 (§4)."""
    methods: set = set()
    for route in app.routes:
        if getattr(route, "path", None) == path:
            methods |= set(getattr(route, "methods", None) or ())
    if methods:
        methods.add("OPTIONS")  # Starlette answers OPTIONS for every registered route
    return ", ".join(sorted(methods))
