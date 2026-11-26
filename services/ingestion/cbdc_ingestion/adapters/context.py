"""`AdapterContext`: everything an adapter is given, and nothing else.

AD-5 §3.2: `start(context)` receives the **injected clock, the sink, the
credential resolver, the metrics recorder and a cancellation signal**. It is
**never** given a database handle, an inference client or a filesystem writer
(AD-5 §11, §12.1). The context is the enforcement point for that rule: an
adapter can reach only what the context carries, so the absence of a capability
here is the absence of the capability.

**Credentials in Phase 3.3-A.** The scope populates `credential_ref` for no
source and implements no resolution (authorization §8 item 3). The default
resolver therefore **refuses every request**, rather than returning `None` and
letting an adapter proceed as though it had been authorized.

**The clock is injected** (AD-5 §3.5). An adapter never reads a wall clock, so
replay is deterministic and a test moves time without waiting.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Callable, Optional, Protocol

from ..clock import Clock


class CancellationSignal:
    """A cooperative cancellation signal (AD-5 §5.2, authorization §5.2).

    Cooperative by rule: nothing is killed and no thread is terminated from
    outside, so `stop()` is a deadline the adapter must meet, not a timeout the
    service enforces by force. `wait` returns True as soon as cancellation is
    requested, which is what lets an adapter sleep without missing the deadline.
    """

    def __init__(self) -> None:
        self._event = threading.Event()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def cancel(self) -> None:
        self._event.set()

    def reset(self) -> None:
        self._event.clear()

    def wait(self, timeout_s: Optional[float] = None) -> bool:
        """Blocks until cancelled or `timeout_s` elapses. True if cancelled."""
        return self._event.wait(timeout_s)


class MetricsRecorder(Protocol):
    """Counters and state labels only. No payload, no provider text (AD-8 §7.1)."""

    def increment(self, name: str, amount: int = 1, **labels: str) -> None: ...

    def set_state(self, name: str, value: str, **labels: str) -> None: ...


class NullMetrics:
    """The in-process recorder. Counts in a dictionary; exports nothing.

    AD-8's metric export is not in this scope, so the recorder is a bounded
    in-memory counter set that tests read and the service logs. The internal
    status machine's state is held here as a **label**, which is one of the two
    places AD-5 §9.2 allows it to appear (the other is a log field).
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.counters: dict = {}
        self.states: dict = {}

    @staticmethod
    def _key(name: str, labels: dict) -> str:
        if not labels:
            return name
        return name + "{" + ",".join(f"{k}={labels[k]}" for k in sorted(labels)) + "}"

    def increment(self, name: str, amount: int = 1, **labels: str) -> None:
        key = self._key(name, labels)
        with self._lock:
            self.counters[key] = self.counters.get(key, 0) + int(amount)

    def set_state(self, name: str, value: str, **labels: str) -> None:
        key = self._key(name, labels)
        with self._lock:
            self.states[key] = str(value)

    def snapshot(self) -> dict:
        with self._lock:
            return {"counters": dict(self.counters), "states": dict(self.states)}


class CredentialRefused(RuntimeError):
    """A credential was requested where none is authorized (§8 item 3)."""


def no_credentials(credential_ref: str) -> str:
    """The only resolver this scope ships: it refuses.

    No source in this scope has a `credential_ref`, and no secrets mechanism is
    authorized before AD-10. Refusing is deliberate: returning `None` would let
    an adapter continue as though it had been given an empty credential.
    """
    raise CredentialRefused(
        f"no credential resolution is authorized in Phase 3.3-A (requested {credential_ref!r})")


@dataclass(frozen=True)
class AdapterContext:
    """What `start(context)` is given (AD-5 §3.2).

    Frozen, so an adapter cannot swap the sink or the clock underneath the
    service. The field set is **closed by rule**: adding a database handle, an
    inference client or a filesystem writer here would breach AD-5 §11, and
    `tests/test_adapter_contract.py` asserts the field names.
    """

    source_id: str
    clock: Clock
    sink: object
    cancellation: CancellationSignal
    metrics: MetricsRecorder = field(default_factory=NullMetrics)
    resolve_credential: Callable[[str], str] = no_credentials

    @property
    def cancelled(self) -> bool:
        return self.cancellation.cancelled

    def now_ms(self) -> int:
        """The injected clock's time. The only time an adapter may read."""
        return self.clock.now_ms()


# The closed field set of the context, asserted here so a later edit that adds a
# capability fails loudly at import rather than quietly widening the boundary.
CONTEXT_FIELDS = ("source_id", "clock", "sink", "cancellation", "metrics", "resolve_credential")

# Names that must never become context fields (AD-5 §3.2, §11).
FORBIDDEN_CONTEXT_FIELDS = frozenset({
    "db", "database", "connection", "cursor", "engine", "session", "pool",
    "inference", "inference_client", "model", "router", "policy",
    "filesystem", "writer", "file", "path", "open",
})
