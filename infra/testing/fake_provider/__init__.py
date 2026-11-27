"""TEST-ONLY fake provider (authorization v1.3 section 7.1), for obligation **A-4**.

Outside the ingestion build context, so it cannot enter the image. No network,
no real provider, no credential, and no import of `cbdc_ingestion`, `src/` or
`services/`. See `provider.py` for the step vocabulary and why it carries
semantics rather than wire detail.
"""
from .provider import (
    FAULT_CLASSES,
    STEP_KINDS,
    CloseOnConnect,
    Deliver,
    FakeProvider,
    Fault,
    MalformedBody,
    OversizedBody,
    Redirect,
    RepeatedSubject,
    ScriptError,
    Silence,
    StatusFault,
    Step,
    TooManyItems,
    TruncatedStream,
    WrongContentType,
    WrongProtocolVersion,
)

__all__ = [
    "FAULT_CLASSES",
    "STEP_KINDS",
    "CloseOnConnect",
    "Deliver",
    "FakeProvider",
    "Fault",
    "MalformedBody",
    "OversizedBody",
    "Redirect",
    "RepeatedSubject",
    "ScriptError",
    "Silence",
    "StatusFault",
    "Step",
    "TooManyItems",
    "TruncatedStream",
    "WrongContentType",
    "WrongProtocolVersion",
]
