"""TEST-ONLY fake provider scaffold (authorization v1.3 section 7.1). Created for **A-4**, which Phase 3.3-A leaves **unexercised**.

Outside the ingestion build context, so it cannot enter the image. No network,
no real provider, no credential, and no import of `cbdc_ingestion`, `src/` or
`services/`. See `provider.py` for why it does nothing yet.
"""
from .provider import (
    FAULT_CLASSES,
    Deliver,
    FakeProvider,
    Fault,
    ScriptError,
    Silence,
    Step,
)

__all__ = [
    "FAULT_CLASSES",
    "Deliver",
    "FakeProvider",
    "Fault",
    "ScriptError",
    "Silence",
    "Step",
]
