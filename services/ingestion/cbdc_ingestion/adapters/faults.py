"""AD-5 §7.1's fault taxonomy: recoverable against permanent.

Every fault is classified, because the classification decides the retry
(AD-5 §7.1). Retrying a 401 forever burns a provider's rate limit and hides a
configuration fault; retrying a 503 is correct.

**The network members were defined and unexercised in Phase 3.3-A**
(`docs/PHASE3_33A_AUTHORIZATION.md` §7.1), because a synthetic source has no
transport. **They are exercised now**, under the Phase 3.3-S A-4 work: the
in-process transport seam (`transport.py`) lets a scripted fake provider produce
each of them, and `tests/test_a4_faults.py` asserts every class in this module.

**Still true, and still the point of this module:** the classes an adapter may
raise are fixed by the contract rather than by whichever adapter is written
first. **No backoff, no circuit breaker and no `Retry-After` handling is
implemented *here*:** those are AD-5 §7.2 and §7.4 and live in `retry.py`, on
**explicitly labelled simulation parameters** (`simulation.py`), because AD-8
§3.5's `poll` column is unapproved.

**Item faults are not adapter faults.** `item_invalid` rejects one item and
`item_implausible` quarantines one item; neither changes the adapter's state,
because one bad item does not discard a good response (AD-5 §7.1, §7.3).
"""
from __future__ import annotations

from enum import Enum


class FaultClass(str, Enum):
    """AD-5 §7.1's eight classes. The value is the reason code used in logs and
    metric labels; no payload ever accompanies it (AD-1 §3.4)."""

    TRANSIENT_NETWORK = "transient_network"
    PROVIDER_UNAVAILABLE = "provider_unavailable"
    RATE_LIMITED = "rate_limited"
    AUTH_FAILURE = "auth_failure"
    CONTRACT_VIOLATION = "contract_violation"
    ITEM_INVALID = "item_invalid"
    ITEM_IMPLAUSIBLE = "item_implausible"
    INTERNAL = "internal"

    def __str__(self) -> str:  # pragma: no cover - trivial
        return self.value


# A permanent fault sends the adapter to `failed_permanent`, which **never
# retries** and needs an operator action (AD-5 §3.3, §7.1).
PERMANENT_FAULTS = frozenset({FaultClass.AUTH_FAILURE, FaultClass.CONTRACT_VIOLATION})

# A recoverable fault is retried with backoff, and drives the internal status to
# `outage` through the §9.2 criteria. `internal` is recoverable: a defect in this
# component restarts with backoff and alerts (AD-5 §7.1's last row).
RECOVERABLE_FAULTS = frozenset({
    FaultClass.TRANSIENT_NETWORK,
    FaultClass.PROVIDER_UNAVAILABLE,
    FaultClass.RATE_LIMITED,
    FaultClass.INTERNAL,
})

# Item-level outcomes. They are faults of an *item*, never of the adapter, so
# they appear in neither set above and change no adapter state.
ITEM_FAULTS = frozenset({FaultClass.ITEM_INVALID, FaultClass.ITEM_IMPLAUSIBLE})

# The taxonomy is partitioned: every class is exactly one of the three kinds.
assert PERMANENT_FAULTS | RECOVERABLE_FAULTS | ITEM_FAULTS == set(FaultClass)
assert not (PERMANENT_FAULTS & RECOVERABLE_FAULTS)
assert not (ITEM_FAULTS & (PERMANENT_FAULTS | RECOVERABLE_FAULTS))

# The classes a synthetic source reaches **with no transport at all** — the
# Phase 3.3-A arrangement, which is still the service default: no network and no
# credential, so only a defect in this component and the two item-level outcomes
# are reachable. The A-4 transport seam does not change this set, because it does
# not change the generator path; it adds an adapter that is reachable only from
# the A-4 suite and the demonstration.
SYNTHETIC_REACHABLE = frozenset({FaultClass.INTERNAL}) | ITEM_FAULTS


def is_permanent(fault_class: FaultClass) -> bool:
    """Whether `fault_class` sends the adapter to `failed_permanent` (AD-5 §3.3)."""
    return FaultClass(fault_class) in PERMANENT_FAULTS


def is_item_fault(fault_class: FaultClass) -> bool:
    """Whether `fault_class` concerns one item and leaves the adapter's state alone."""
    return FaultClass(fault_class) in ITEM_FAULTS


class AdapterFault(Exception):
    """A classified fault.

    `reason` is a short code, never a payload and never provider text: AD-1 §3.4
    allows the reason and, where the envelope is well formed, the `event_id`, and
    nothing else reaches a log line.
    """

    def __init__(self, fault_class: FaultClass, reason: str, *, source_id: str = "") -> None:
        self.fault_class = FaultClass(fault_class)
        self.reason = str(reason)
        self.source_id = str(source_id)
        super().__init__(f"{self.fault_class.value}: {self.reason}")

    @property
    def permanent(self) -> bool:
        return is_permanent(self.fault_class)

    @property
    def item_level(self) -> bool:
        return is_item_fault(self.fault_class)
