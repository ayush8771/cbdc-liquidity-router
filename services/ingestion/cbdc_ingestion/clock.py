"""The injected clock and AD-4 timestamp formatting.

AD-1 §3 (AD-12 row) requires that timestamps come from an **injected** clock and
that payloads and hashes do not depend on it (§6 acceptance item 1). Nothing in
this component calls `time.time()` or `datetime.now()` directly: every timestamp
is read from a `Clock`, so tests drive time exactly and a fault-injection case
can move the clock backwards or forwards.

All AD-4 timestamps are UTC, RFC 3339, with exactly three fractional digits and
`Z` (AD-4 §5). Formatting **truncates** towards the past instead of rounding, so
a formatted timestamp never names a moment that has not happened yet and so can
never turn a valid event into a future one (AD-1 §3.4).
"""
from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Protocol

EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


class Clock(Protocol):
    """A source of wall-clock time, in integer milliseconds since the Unix epoch."""

    def now_ms(self) -> int:  # pragma: no cover - structural type
        ...


class SystemClock:
    """The real clock. Used by the running service only."""

    def now_ms(self) -> int:
        return time.time_ns() // 1_000_000


class ManualClock:
    """A test clock. It moves only when told to, and it may move backwards.

    Moving backwards is a real fault case: AD-1 §3.4 says a clock moved backwards
    must yield late events, which age out safely, rather than corrupt state.
    """

    def __init__(self, start_ms: int = 0) -> None:
        self._now_ms = int(start_ms)
        self._lock = threading.Lock()

    def now_ms(self) -> int:
        with self._lock:
            return self._now_ms

    def advance_ms(self, delta_ms: int) -> int:
        with self._lock:
            self._now_ms += int(delta_ms)
            return self._now_ms

    def set_ms(self, value_ms: int) -> int:
        with self._lock:
            self._now_ms = int(value_ms)
            return self._now_ms


def format_timestamp(epoch_ms: int) -> str:
    """`epoch_ms` as an AD-4 §5 timestamp: `YYYY-MM-DDTHH:MM:SS.mmmZ`.

    Sub-millisecond precision cannot occur: the input is already whole
    milliseconds, which is the resolution AD-4 fixes.
    """
    epoch_ms = int(epoch_ms)
    if epoch_ms < 0:
        raise ValueError("timestamps before 1970-01-01T00:00:00.000Z cannot be formatted (AD-4 §5)")
    moment = EPOCH + timedelta(milliseconds=epoch_ms)
    return f"{moment.strftime('%Y-%m-%dT%H:%M:%S')}.{epoch_ms % 1000:03d}Z"


def parse_timestamp(value: str) -> int:
    """The inverse of `format_timestamp`, for tests and ordering checks."""
    moment = datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    return int((moment - EPOCH).total_seconds() * 1000)
