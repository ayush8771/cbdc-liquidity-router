"""The Phase 3.3-A adapter foundation: **synthetic sources only**.

Authorized by `docs/PHASE3_33A_AUTHORIZATION.md` v1.2 §7 (scope), §8 (exclusions)
and §9 (acceptance criteria), with the start authorized on 27 November 2026
(v1.3 §14). The scope is **local-only and synthetic-only**:

- **No real provider, and no contact with one** — not even a recorded sample —
  before Gate 3 (§8 item 1; D-5, D-17). **All four capability gates are CLOSED.**
- **No outbound network access.** Ingestion contacts nothing at all (§8 item 2).
  The fault taxonomy's network members exist as classifications and are
  **unexercised here**, because there is no transport to fault.
- **No credential.** A registry record carries a `credential_ref` field; this
  scope populates it for **no** source and resolves nothing (§8 item 3).
- **No distribution mechanism, no durability, no replay, no acknowledgement**
  (§8 items 4 and 5). The sink's `observations` channel is the existing
  in-memory `LatestStore`, which is the slice's choice and not a template.

**The D-24 generator path is untouched.** It stays the service default, no
registry record selects the adapter path, and the env-configured generator is
exempt from the registry and seed-allocation checks (authorization §6.1,
acceptance criterion 8). Nothing in this package is imported by `envelope.py`,
`canonical.py`, `validation.py` or `generator.py`.
"""
from __future__ import annotations

from .base import (
    ADAPTER_STATES,
    Adapter,
    AdapterDescription,
    NormalizedObservation,
)
from .context import AdapterContext, CancellationSignal, NullMetrics, no_credentials
from .faults import (
    PERMANENT_FAULTS,
    RECOVERABLE_FAULTS,
    AdapterFault,
    FaultClass,
    is_permanent,
)
from .registry import (
    Registry,
    RegistryInvalid,
    SeedAllocation,
    SourceRecord,
    check_description,
    load_registry,
    selected_records,
)

__all__ = [
    "ADAPTER_STATES",
    "Adapter",
    "AdapterDescription",
    "NormalizedObservation",
    "AdapterContext",
    "CancellationSignal",
    "NullMetrics",
    "no_credentials",
    "AdapterFault",
    "FaultClass",
    "PERMANENT_FAULTS",
    "RECOVERABLE_FAULTS",
    "is_permanent",
    "Registry",
    "RegistryInvalid",
    "SeedAllocation",
    "SourceRecord",
    "check_description",
    "load_registry",
    "selected_records",
]
