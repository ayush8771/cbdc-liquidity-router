"""Error envelope (API contract §4) and X-Request-Id handling (contract §1)."""
from __future__ import annotations

import logging
import uuid
from typing import Any, Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger(__name__)

REQUEST_ID_HEADER = "X-Request-Id"


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
    body = {"error": {"code": code, "message": message, "details": details or {}, "request_id": rid}}
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

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError):
        errors = exc.errors()
        if any(e.get("type") == "json_invalid" for e in errors):
            return error_response(request, 400, "MALFORMED_REQUEST", "Request body is not valid JSON.")
        safe = [{"loc": list(e.get("loc", ())), "msg": e.get("msg", ""), "type": e.get("type", "")} for e in errors]
        return error_response(request, 422, "VALIDATION_ERROR", "Request failed validation.", {"errors": safe})

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException):
        if exc.status_code == 404:
            return error_response(request, 404, "NOT_FOUND", "Unknown resource.")
        # The contract defines no code for other framework errors (e.g. 405); keep them
        # in the envelope with the closest generic code rather than inventing a new one.
        logger.warning("framework HTTP %s on %s", exc.status_code, request.url.path)
        return error_response(request, exc.status_code, "MALFORMED_REQUEST" if exc.status_code < 500 else "INTERNAL_ERROR",
                              str(exc.detail), headers=getattr(exc, "headers", None))
