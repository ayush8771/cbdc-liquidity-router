"""The Phase 3.3-A adapter foundation: **synthetic sources only**.

Authorized by `docs/PHASE3_33A_AUTHORIZATION.md` v1.2 §7 (scope), §8 (exclusions)
and §9 (acceptance criteria), with the start authorized on 27 November 2026
(v1.3 §14). The scope is **local-only and synthetic-only**:

- **No real provider, and no contact with one** — not even a recorded sample —
  before Gate 3 (§8 item 1; D-5, D-17). **All four capability gates are CLOSED.**
- **No outbound network access.** Ingestion contacts nothing at all (§8 item 2),
  and that is **unchanged** by the Phase 3.3-S A-4 work below: the transport seam
  admits one kind, `in_process_simulation`, and the package contains no
  implementation of a transport at all.
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

---

**Phase 3.3-S, obligation A-4: synthetic fault handling.** AD-5 §13's A-4 asks
for fault injection against a controllable fake provider, which 3.3-A could not
do: with no transport, `transient_network`, `provider_unavailable`,
`rate_limited` and `auth_failure` were unreachable. Five additive modules make
them reachable **without adding a network**:

| Module | What it adds |
|---|---|
| `simulation.py` | `SimulatedTimingProfile`, labelled **`SIMULATION_ONLY`**. AD-8 §3.5's `poll` column is **unapproved**, so its numbers appear nowhere in this package |
| `transport.py` | The pull-only transport seam. One admitted kind, `in_process_simulation`; a body read in chunks so an oversized one is refused **while reading** |
| `response.py` | AD-5 §7.1's status classification and §7.3's whole-response rejection, with each condition's class **and its authority** declared |
| `retry.py` | §7.2's backoff with injected full jitter, `Retry-After` parsing and clamping, and §7.4's per-`source_id` circuit breaker |
| `simulated_fx.py` | The adapter that drives a transport. **No registry record selects it**, so the service path cannot reach it |

**What A-4 does not change:** no gate opens, no provider exists, no credential
resolves, no egress is granted, the D-24 generator stays the default, and
`usage` remains `display_only` on every envelope.
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
from .response import (
    STATUS_CLASSES,
    WHOLE_RESPONSE_CLASSES,
    classify_status,
    read_response,
)
from .retry import (
    BackoffPolicy,
    BreakerRegistry,
    CircuitBreaker,
    FullJitter,
    RetryDecision,
    parse_retry_after,
)
from .simulated_fx import SimulatedTransportFxAdapter
from .simulation import SIMULATION_ONLY, SIMULATION_TIMING, SimulatedTimingProfile
from .transport import (
    AUTHORIZED_TRANSPORT_KINDS,
    Transport,
    TransportRefused,
    TransportResponse,
    assert_admissible,
    read_body,
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
    # Phase 3.3-S, A-4.
    "SIMULATION_ONLY",
    "SIMULATION_TIMING",
    "SimulatedTimingProfile",
    "SimulatedTransportFxAdapter",
    "AUTHORIZED_TRANSPORT_KINDS",
    "Transport",
    "TransportRefused",
    "TransportResponse",
    "assert_admissible",
    "read_body",
    "STATUS_CLASSES",
    "WHOLE_RESPONSE_CLASSES",
    "classify_status",
    "read_response",
    "BackoffPolicy",
    "BreakerRegistry",
    "CircuitBreaker",
    "FullJitter",
    "RetryDecision",
    "parse_retry_after",
]
