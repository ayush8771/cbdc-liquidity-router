"""The sink: three channels, and nothing that resembles a distribution mechanism.

AD-5 §3.6: an adapter's only output is the sink, and the sink has three
channels — `observations`, `quarantine` and `faults`. An adapter publishes to
none of them directly; the **service** does, after the §3.4 steps.

**The in-memory sink is the slice's choice and not a template**
(authorization §8 item 5). The distribution mechanism is **C-4**, AD-2 and AD-3
are drafts, and AD-1 §4 records that the mechanism eventually *replaces* the
poll. Nothing here may be read as choosing it. Accordingly this module claims:

- **no durability** — a restart loses the state, which AD-1 §3 allows
  explicitly;
- **no replay, and no acknowledgement protocol** (§8 item 4, AD5-Q7, which
  stays provisional at **at-least-once**);
- **no restart-safe deduplication** — the source is marked `dedup: within_run`
  (authorization §5.3).

**`observations` is the existing `LatestStore`**, unchanged. That is deliberate:
the store already implements AD-1 §3.1's "latest validated envelope per pair"
and §3.4's withholding of quarantined events, and a second implementation of
those rules would eventually disagree with the first.

**The `quarantine` and `faults` channels retain no payload** (AD-1 §3.4): a
quarantined event leaves "only counters by reason and rate-limited logs with the
reason and, if well formed, the `event_id`. No payload is stored and there is no
review queue." So those two channels are **bounded counters**, not queues. A
queue is AD-10 and AD-11's, in milestone 3.6.
"""
from __future__ import annotations

import threading
from typing import Optional, Protocol

from .store import LatestStore

CHANNELS = ("observations", "quarantine", "faults")


class Sink(Protocol):
    """What an adapter's output reaches, and the only thing it reaches."""

    def publish(self, channel: str, item) -> bool:  # pragma: no cover - structural
        ...


class CountingChannel:
    """A bounded per-reason counter. **Not a queue, and not a review queue.**

    It holds integers only: AD-1 §3.4 permits counters by reason and
    rate-limited logs, and nothing else. Storing the item would create the
    review queue that section says does not exist, and would retain a payload
    the component is not allowed to keep.
    """

    def __init__(self, name: str) -> None:
        self.name = name
        self._lock = threading.Lock()
        self._total = 0
        self._by_reason: dict = {}

    def record(self, reason: str, amount: int = 1) -> int:
        with self._lock:
            self._total += int(amount)
            self._by_reason[reason] = self._by_reason.get(reason, 0) + int(amount)
            return self._total

    @property
    def total(self) -> int:
        with self._lock:
            return self._total

    def by_reason(self) -> dict:
        with self._lock:
            return dict(self._by_reason)


class ServiceSink:
    """The three channels, over the existing store.

    `observations` takes a **validated AD-4 envelope** and hands it to
    `LatestStore.apply`, which keeps its own acceptance, ordering, duplicate and
    quarantine rules exactly as approved — this class adds none of its own.
    """

    def __init__(self, store: Optional[LatestStore] = None) -> None:
        self.store = LatestStore() if store is None else store
        self.quarantine = CountingChannel("quarantine")
        self.faults = CountingChannel("faults")

    def publish(self, channel: str, item) -> bool:
        """Publishes `item` to `channel`. Returns whether it became current.

        An unknown channel is an error rather than a silent drop: a typo that
        quietly discarded observations is exactly the loss AD-5 §3.7 says must
        be counted and never silent.
        """
        if channel not in CHANNELS:
            raise ValueError(f"unknown sink channel {channel!r}; AD-5 §3.6 defines {CHANNELS}")
        if channel == "observations":
            return self.store.apply(item)
        reason = item if isinstance(item, str) else str(getattr(item, "reason", "unknown"))
        target = self.quarantine if channel == "quarantine" else self.faults
        target.record(reason)
        return False

    def counters(self) -> dict:
        """Counters only. No payload, no provider text, no rate (AD-1 §3.4)."""
        return {
            "observations": self.store.counters(),
            "quarantine": {"total": self.quarantine.total,
                           "by_reason": self.quarantine.by_reason()},
            "faults": {"total": self.faults.total, "by_reason": self.faults.by_reason()},
        }
