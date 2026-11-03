"""Engine-side errors carrying API contract §4 codes.

The engine never imports FastAPI; the API layer will map `EngineError.code`
and `http_status` onto the contract's error envelope.
"""
from __future__ import annotations

from typing import Optional


class EngineError(Exception):
    code = "INTERNAL_ERROR"
    http_status = 500

    def __init__(self, message: str, details: Optional[dict] = None):
        super().__init__(message)
        self.message = message
        self.details = details or {}


class ValidationFailed(EngineError):
    code, http_status = "VALIDATION_ERROR", 422


class UnsupportedCorridor(EngineError):
    code, http_status = "UNSUPPORTED_CORRIDOR", 422


class InvalidAmount(EngineError):
    code, http_status = "INVALID_AMOUNT", 422


class DateOutOfRange(EngineError):
    code, http_status = "DATE_OUT_OF_RANGE", 422


class DateInGapBuffer(EngineError):
    code, http_status = "DATE_IN_GAP_BUFFER", 422


class UnknownScenario(EngineError):
    code, http_status = "UNKNOWN_SCENARIO", 422


class PolicyDisabled(EngineError):
    code, http_status = "POLICY_DISABLED", 409


class EngineIntegrityError(EngineError):
    """Shared Phase 1 state was not restored after a task (arch §6.2 step 5). Fail closed."""
    code, http_status = "INTERNAL_ERROR", 500


class EngineNotReady(EngineError):
    code, http_status = "NOT_READY", 503


class EngineBusy(EngineError):
    """The bounded wait queue (CBDC_ENGINE_MAX_QUEUE) is full. Sent with Retry-After."""
    code, http_status = "ENGINE_BUSY", 503


class EngineTimeout(EngineError):
    """A task exceeded CBDC_ENGINE_TASK_TIMEOUT_S; its worker is killed and rebuilt."""
    code, http_status = "ENGINE_TIMEOUT", 504


class EngineWorkerCrashed(EngineError):
    """The worker process died mid-task (no result). The worker is rebuilt."""
    code, http_status = "INTERNAL_ERROR", 500


def rebuild_error(class_name: str, message: str, details: dict) -> EngineError:
    """Re-creates an engine error sent back from a worker process by class name."""
    cls = globals().get(class_name)
    if not (isinstance(cls, type) and issubclass(cls, EngineError)):
        cls = EngineError
    return cls(message, details)
