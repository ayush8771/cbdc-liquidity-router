"""AD-5 §9.2's internal status machine. **In process only** (§4.3).

Per source, inside ingestion, with thresholds from AD-8. These are **internal**
states, not wire values. The state is exposed as a **metric label and a log
field** and **nothing else** (AD-8 §7.1); it is **never serialized to a wire
body**.

**Ingestion publishes no status, and this module does not change that.**
`contracts/events/ingestion-latest.v1.schema.json` requires exactly
`protocol_version`, `instance_id`, `source_id`, `generated_at` and `events`,
with `additionalProperties: false`, and has **no status field**. The published
`source.status` is derived by **Express's own poller** from poll success and
failure (AD-1 §3.2) — it is a statement about Express's poll of ingestion, not
about an adapter. Giving ingestion a published status would change an approved
contract and is **excluded** (authorization §8 item 11).

**So how does adapter failure reach a viewer?** Only indirectly, and that is
correct: a failed adapter stops producing, `/v1/latest` keeps answering 200 with
its last-held value, Express's poller keeps reporting `ok`, and the values
**age** through Simulated-`stale` to `unavailable` on their own (AD-4 §7).

**The two `/v1/latest` failure modes are not the same**, and an implementation
must not conflate them:

| What failed | `/v1/latest` | Published status |
|---|---|---|
| An **adapter** reaches `down` while the service runs | **200**, last-held value | stays `ok`; values age |
| The **service or generator** is not running | **503 `NOT_READY`** | `outage` after 3 failures or 2 s |

An adapter fault must **never** produce a 503. Doing so would convert one
adapter's permanent fault into a whole-service outage and change D-24 behaviour.

**`down` is internal and is never a fourth wire value.**
`contracts/events/stream-message.v1.schema.json` enumerates `source.status` as
exactly `starting`, `ok`, `outage`; the deployed client validates `source`
strictly, so a fourth value would **fault every open stream**. §9.3's mapping
sends `down`, `stopping` and `stopped` to `outage`: to a viewer, a permanently
failed source and an unreachable one are the same thing. The distinction is
**operational**, and it is carried in the metric label and the log field, where
it is actionable.
"""
from __future__ import annotations

import threading
from typing import Optional

# AD-5 §9.2's internal states.
INTERNAL_STATES = ("starting", "ok", "outage", "down", "stopping", "stopped")

# The approved, closed three-value wire set (AD-1 §3.1, §3.2;
# stream-message.v1.schema.json). **Never extended.**
PUBLISHED_STATUSES = ("starting", "ok", "outage")

# §9.3's mapping. Every internal state maps onto one of the three, so no
# internal state can ever escape as a new wire value.
PUBLISHED_MAPPING = {
    "starting": "starting",
    "ok": "ok",
    "outage": "outage",
    "down": "outage",
    "stopping": "outage",
    "stopped": "outage",
}

# Authorization §5.1, synthetic column. The silence window is a multiple of the
# source's own expected interval, so a `scheduled` source would be judged
# against its schedule rather than an interval.
OUTAGE_CONSECUTIVE_FAILURES = 3
OUTAGE_SILENCE_MULTIPLE = 3

assert set(PUBLISHED_MAPPING) == set(INTERNAL_STATES)
assert set(PUBLISHED_MAPPING.values()) <= set(PUBLISHED_STATUSES)


def published_status(internal: str) -> str:
    """§9.3's mapping. Raises on an unknown state rather than inventing a value."""
    if internal not in PUBLISHED_MAPPING:
        raise ValueError(f"unknown internal status {internal!r}; AD-5 §9.2 defines {INTERNAL_STATES}")
    return PUBLISHED_MAPPING[internal]


class SourceStatus:
    """One source's internal status (AD-5 §9.2).

    **Two outage criteria, applied independently, whichever comes first**
    (§9.2): consecutive failures reaching the AD-8 count, **or** no successful
    item for the silence window. The two-criteria form matters for a streaming
    transport, where a silent subscription produces **no failures at all** — so
    a failure count alone would never fire.

    **A silent source is a degraded source**, judged against
    `expected_interval_ms`.

    `down` is reached only by a permanent fault and left by **an operator action
    only** — never by a successful item, and never by time. That is the one
    respect in which it differs from `outage`, and it is why it exists
    internally at all.
    """

    def __init__(self, source_id: str, *, expected_interval_ms: int,
                 consecutive_failures: int = OUTAGE_CONSECUTIVE_FAILURES,
                 silence_multiple: int = OUTAGE_SILENCE_MULTIPLE,
                 now_ms: int = 0) -> None:
        if expected_interval_ms < 1:
            raise ValueError("expected_interval_ms must be positive")
        self.source_id = str(source_id)
        self.expected_interval_ms = int(expected_interval_ms)
        self.failure_threshold = int(consecutive_failures)
        self.silence_window_ms = int(expected_interval_ms) * int(silence_multiple)
        self._lock = threading.RLock()
        self._state = "starting"
        self._consecutive_failures = 0
        self._last_success_ms: Optional[int] = None
        self._started_ms = int(now_ms)
        self.transitions = 0

    @property
    def state(self) -> str:
        with self._lock:
            return self._state

    @property
    def published(self) -> str:
        """What a consumer would see **if** a path existed. None does here."""
        return published_status(self.state)

    def _set(self, target: str) -> str:
        if target not in INTERNAL_STATES:
            raise ValueError(f"unknown internal status {target!r}")
        with self._lock:
            if self._state != target:
                self._state = target
                self.transitions += 1
            return self._state

    # ------------------------------------------------------------------ signals
    def record_success(self, now_ms: int) -> str:
        """One successful item. Leaves `starting` and `outage`; **never `down`**."""
        with self._lock:
            self._consecutive_failures = 0
            self._last_success_ms = int(now_ms)
            if self._state == "down":
                # §9.2: an operator action only. A successful item cannot occur
                # here anyway, and if it did it must not clear the fault.
                return self._state
            if self._state in ("stopping", "stopped"):
                return self._state
            return self._set("ok")

    def record_failure(self, now_ms: int, *, permanent: bool = False) -> str:
        """One failure. A permanent fault goes straight to `down`."""
        with self._lock:
            if permanent:
                return self._set("down")
            if self._state in ("down", "stopping", "stopped"):
                return self._state
            self._consecutive_failures += 1
            if self._consecutive_failures >= self.failure_threshold:
                return self._set("outage")
            return self._state

    def tick(self, now_ms: int) -> str:
        """Applies the **silence** criterion, which no failure reports.

        Measured from the last success, or from the start when there has been
        none: a source that never produced its first item is silent too.
        """
        with self._lock:
            if self._state in ("down", "stopping", "stopped"):
                return self._state
            since = self._last_success_ms if self._last_success_ms is not None else self._started_ms
            if int(now_ms) - since >= self.silence_window_ms:
                return self._set("outage")
            return self._state

    def record_stopping(self) -> str:
        return self._set("stopping")

    def record_stopped(self) -> str:
        return self._set("stopped")

    # ------------------------------------------------------------------ reporting
    def as_metric_labels(self) -> dict:
        """The state as a **metric label**, one of the two places §9.2 allows.

        Counters and state labels only. No payload, no provider text (AD-8 §7.1).
        """
        return {"source_id": self.source_id, "state": self.state}

    def as_log_field(self) -> str:
        """The state as a **log field**, the other allowed place."""
        return f"source_id={self.source_id} internal_state={self.state}"

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "source_id": self.source_id,
                "state": self._state,
                "consecutive_failures": self._consecutive_failures,
                "silence_window_ms": self.silence_window_ms,
                "transitions": self.transitions,
            }
