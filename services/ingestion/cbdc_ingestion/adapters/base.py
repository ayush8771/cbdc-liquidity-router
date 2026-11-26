"""The adapter interface: AD-5 §3.2's operations and §3.3's lifecycle.

An adapter turns **one registered source** into a stream of normalized
observations, or into recorded failures, and does nothing else (AD-5 §3.1). One
adapter instance serves exactly one `source_id`.

**What an adapter must not do, and cannot do from here.** The service owns
envelope construction, canonical hashing, schema validation, the clock, the
sink, metrics and logging (AD-5 §3.1, §3.4). An adapter that built its own
envelope or its own hash would be a defect, because two implementations of AD-4
would eventually disagree. `normalize()` therefore returns a
`NormalizedObservation` — values, codes and timestamps — and **never** an
envelope, a hash or an `event_id`.

**Unidirectional by rule** (AD-5 §3.2): an adapter has no operation that accepts
an observation, a routing request, a routing result, a user identity or a form
value. Its only output is the sink.

**Lifecycle** (AD-5 §3.3), with `failed_permanent` reached only by a permanent
fault and left by **nothing**:

```text
   created --> starting --> running <----> degraded
                  |            |             |
                  |            v             v
                  +-------> stopping --> stopped
                                            ^
                     failed_permanent ------+   (no automatic restart)
```
"""
from __future__ import annotations

import threading
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional, Sequence

from .context import AdapterContext
from .faults import AdapterFault, FaultClass, is_permanent

# AD-5 §3.3's states, in the order they are reached.
ADAPTER_STATES = (
    "created", "starting", "running", "degraded", "stopping", "stopped", "failed_permanent",
)

# The permitted transitions. `failed_permanent` has **no** outgoing edge other
# than an explicit `stop()`, which releases resources without restarting
# anything: AD-5 §3.3 says it needs an operator action, and an operator action
# here is a new process, not a self-transition.
ALLOWED_TRANSITIONS = {
    "created": frozenset({"starting", "stopping", "stopped"}),
    "starting": frozenset({"running", "degraded", "failed_permanent", "stopping", "stopped"}),
    "running": frozenset({"degraded", "failed_permanent", "stopping"}),
    "degraded": frozenset({"running", "failed_permanent", "stopping"}),
    "stopping": frozenset({"stopped"}),
    "stopped": frozenset({"stopped"}),
    "failed_permanent": frozenset({"stopping", "stopped"}),
}

# The transports AD-5 §6.1 names. Phase 3.3-A authorizes **`synthetic` only**;
# the others are listed so a registry mismatch is a startup failure rather than
# an unrecognized string, and no code path in this scope can select one.
TRANSPORTS = ("websocket", "poll", "scheduled", "manual", "synthetic")
AUTHORIZED_TRANSPORTS = ("synthetic",)

# The AD-4 §5 bases. A synthetic generator is its own provider, so it observes.
TIMESTAMP_BASES = ("observed", "published", "none")


class AdapterStateError(RuntimeError):
    """An operation was attempted from a state AD-5 §3.3 does not permit."""


@dataclass(frozen=True)
class AdapterDescription:
    """`describe()`'s result: the adapter's **static** capabilities (AD-5 §3.2).

    Checked against the registry record at start; a mismatch is a **startup
    failure, not a warning** (acceptance criterion 1). It is static because it
    describes the code, not the configuration: a description that varied with
    the record could never contradict it, and the check would be vacuous.
    """

    adapter_id: str
    transports: tuple
    event_types: tuple
    subjects: tuple
    required_registry_fields: tuple = ()
    emits_timestamp_basis: str = "observed"
    # Exactly one of the two production operations, matching the transport
    # (AD-5 §3.2). A synthetic source produces on a schedule, so it polls.
    production_mode: str = "poll"

    def __post_init__(self) -> None:
        if not self.adapter_id:
            raise ValueError("an adapter description needs an adapter_id")
        if not self.transports or any(t not in TRANSPORTS for t in self.transports):
            raise ValueError(f"transports must be drawn from {TRANSPORTS}")
        if not self.event_types:
            raise ValueError("an adapter description names at least one event type")
        if self.emits_timestamp_basis not in TIMESTAMP_BASES:
            raise ValueError(f"emits_timestamp_basis must be one of {TIMESTAMP_BASES}")
        if self.production_mode not in ("poll", "subscribe"):
            raise ValueError("production_mode is 'poll' or 'subscribe' (AD-5 §3.2)")


@dataclass(frozen=True)
class NormalizedObservation:
    """One observation, after **format work only** (AD-5 §4).

    It carries no `event_id`, no `payload_sha256` and no envelope: identity and
    hashing are the service's (AD-5 §3.1, §3.4). Numbers are **decimal strings**
    with the producer's digits preserved exactly — a trailing zero is significant
    to the hash, so it is kept as received and never round-tripped through a
    float (AD-5 §4).

    `source_timestamp_ms` is `None` exactly when the producer gives no timestamp,
    and `source_timestamp_basis` is then `none`. It is **never filled from a
    local clock** (AD-5 §3.5, AD-4 §5).
    """

    event_type: str
    subject: tuple
    payload: dict
    source_timestamp_ms: Optional[int]
    source_timestamp_basis: str = "observed"
    sequence: Optional[int] = None
    raw: Optional[bytes] = None

    def __post_init__(self) -> None:
        if self.source_timestamp_basis not in TIMESTAMP_BASES:
            raise ValueError(f"source_timestamp_basis must be one of {TIMESTAMP_BASES}")
        # AD-4 §5's nullability rule, enforced where the value is made rather
        # than only where it is validated.
        if (self.source_timestamp_ms is None) != (self.source_timestamp_basis == "none"):
            raise ValueError(
                "a null source_timestamp requires basis 'none', and a non-null one forbids it "
                "(AD-4 §5)")
        for key, value in self.payload.items():
            if isinstance(value, float):
                raise ValueError(
                    f"payload.{key} is a float; AD-5 §4 requires decimal strings with the "
                    "producer's digits preserved")


class Adapter(ABC):
    """The base class every adapter passes the shared contract suite as (A-1).

    Subclasses implement `describe`, `_start`, `_produce`, `normalize` and
    `_stop`. The state machine, the cancellation handling and the fault
    classification live here, so no adapter re-implements them and every adapter
    reaches `failed_permanent` on the same classes (AD-5 §7.1).
    """

    def __init__(self, source_id: str) -> None:
        self.source_id = str(source_id)
        self._state = "created"
        self._state_lock = threading.RLock()
        self._context: Optional[AdapterContext] = None
        self._last_fault: Optional[AdapterFault] = None

    # ------------------------------------------------------------------- state
    @property
    def state(self) -> str:
        with self._state_lock:
            return self._state

    @property
    def last_fault(self) -> Optional[AdapterFault]:
        with self._state_lock:
            return self._last_fault

    def _transition(self, target: str) -> str:
        if target not in ADAPTER_STATES:
            raise ValueError(f"unknown adapter state {target!r}")
        with self._state_lock:
            current = self._state
            if target == current:
                return current
            if target not in ALLOWED_TRANSITIONS[current]:
                raise AdapterStateError(f"{current} -> {target} is not an AD-5 §3.3 transition")
            self._state = target
            if self._context is not None:
                self._context.metrics.set_state(
                    "adapter_state", target, source_id=self.source_id)
            return target

    # -------------------------------------------------------------- operations
    @abstractmethod
    def describe(self) -> AdapterDescription:
        """The adapter's static capabilities (AD-5 §3.2)."""

    def start(self, context: AdapterContext) -> str:
        """Acquires what the transport needs. Returns the resulting state.

        Cancellation delivered **mid-`start`** leaves nothing acquired and the
        adapter `stopped` (acceptance criterion 14): the check happens before and
        after `_start`, and `_stop` runs so a partially acquired resource is
        released.
        """
        if context.source_id != self.source_id:
            raise AdapterStateError(
                f"context is for {context.source_id!r}, adapter for {self.source_id!r}")
        with self._state_lock:
            if self._state in ("stopping", "stopped"):
                raise AdapterStateError("a stopped adapter is not restarted in process (AD-5 §3.3)")
            if self._state != "created":
                return self._state
            self._context = context
        self._transition("starting")
        if context.cancelled:
            return self._cancel_during_start()
        try:
            self._start(context)
        except AdapterFault as fault:
            return self._record_fault(fault)
        except Exception as exc:  # noqa: BLE001 - any other defect is `internal`
            return self._record_fault(AdapterFault(FaultClass.INTERNAL, type(exc).__name__,
                                                   source_id=self.source_id))
        if context.cancelled:
            return self._cancel_during_start()
        return self.state

    def _cancel_during_start(self) -> str:
        """Nothing acquired, nothing left running, and the adapter is `stopped`."""
        try:
            self._stop()
        finally:
            self._transition("stopping")
            self._transition("stopped")
        return self.state

    def produce(self) -> Sequence[NormalizedObservation]:
        """The due observations, normalized. Empty when nothing is due.

        This is the service-facing form of AD-5 §3.2's `poll()` / `subscribe()`
        pair: the adapter declares which it is through
        `describe().production_mode`, and the service never calls both.
        """
        if self.state in ("stopping", "stopped", "failed_permanent"):
            return ()
        if self._context is None:
            raise AdapterStateError("produce() before start() (AD-5 §3.3)")
        if self._context.cancelled:
            return ()
        try:
            items = tuple(self._produce())
        except AdapterFault as fault:
            self._record_fault(fault)
            return ()
        except Exception as exc:  # noqa: BLE001
            self._record_fault(AdapterFault(FaultClass.INTERNAL, type(exc).__name__,
                                            source_id=self.source_id))
            return ()
        if items and self.state in ("starting", "degraded"):
            # One successful item is what leaves `starting` and `degraded`
            # (AD-5 §3.3, §9.2). A successful connection is not progress.
            self._transition("running")
        return items

    @abstractmethod
    def normalize(self, raw) -> NormalizedObservation:
        """Maps one raw item to a normalized observation. **No** hashing, no
        envelope assembly and no I/O (AD-5 §3.2)."""

    def health(self) -> dict:
        """The adapter's own, **advisory** view (AD-5 §3.2).

        The authoritative source status is the service's internal machine
        (AD-5 §9.2), which is why this returns the adapter's state and its last
        reason code and nothing that could be mistaken for a wire value.
        """
        fault = self.last_fault
        return {
            "source_id": self.source_id,
            "state": self.state,
            "reason": None if fault is None else fault.fault_class.value,
        }

    def stop(self, *, deadline_ms: int = 2000) -> str:
        """Releases everything, **idempotently**, within the AD-8 budget.

        Safe from **any** state, including `created`, mid-`start` and after
        `failed_permanent` (AD-5 §3.2, §5.2; acceptance criterion 15). It is
        cooperative: the cancellation signal is set and the adapter returns.
        Nothing is killed.
        """
        with self._state_lock:
            if self._state == "stopped":
                return "stopped"
            context = self._context
        if context is not None:
            context.cancellation.cancel()
        self._transition("stopping")
        try:
            self._stop(deadline_ms=deadline_ms)
        finally:
            self._transition("stopped")
        return self.state

    # ------------------------------------------------------- fault bookkeeping
    def _record_fault(self, fault: AdapterFault) -> str:
        """Classifies a fault and moves the state accordingly (AD-5 §7.1).

        An **item** fault changes no adapter state: one bad item does not
        discard a good response.
        """
        with self._state_lock:
            self._last_fault = fault
            context = self._context
        if context is not None:
            context.metrics.increment("adapter_faults", 1, source_id=self.source_id,
                                      fault_class=fault.fault_class.value)
        if fault.item_level:
            return self.state
        if is_permanent(fault.fault_class):
            return self._transition("failed_permanent")
        if self.state in ("starting", "running"):
            return self._transition("degraded")
        return self.state

    # ----------------------------------------------------- subclass hook points
    def _start(self, context: AdapterContext) -> None:
        """Acquire the transport. The default acquires nothing."""

    def _produce(self) -> Sequence[NormalizedObservation]:
        """The due raw items, already normalized. The default produces nothing."""
        return ()

    def _stop(self, *, deadline_ms: int = 2000) -> None:
        """Release the transport. The default releases nothing."""


@dataclass
class AdapterRunResult:
    """What one service-side production cycle did, for counters and tests."""

    produced: int = 0
    published: int = 0
    quarantined: int = 0
    rejected: int = 0
    duplicates: int = 0
    collisions: int = 0
    conflicts: int = 0
    reasons: list = field(default_factory=list)
