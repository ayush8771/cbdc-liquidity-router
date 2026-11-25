"""The bounded in-memory store of the latest validated event per pair.

AD-1 §3.1: `GET /v1/latest` returns "the latest **validated** envelope per pair;
quarantined events are never served". AD-1 §3.4: quarantined events leave
"**only** counters by reason and rate-limited logs with the reason and, if well
formed, the `event_id`. No payload is stored and there is no review queue."

So this store holds **at most four** envelopes, a handful of integer counters and
nothing else. There is no history, no queue and no file: a restart loses the
state, which AD-1 §3 allows explicitly ("No broker, durability or replay; a
restart may lose state").

Ordering follows `source_timestamp` only (AD-1 §3.4). An event older than or
equal to the pair's current event is not applied, so a clock moved backwards
produces late events that are counted and dropped, and the newest value a reader
sees never goes backwards in time.
"""
from __future__ import annotations

import threading
from typing import Optional

from .clock import parse_timestamp
from .pairs import PAIRS, PAIR_KEYS
from .validation import EnvelopeInvalid, validate_fx_envelope

# Counter names are fixed, so a reader of the diagnostics cannot be surprised by a
# key appearing only after a particular fault.
COUNTER_NAMES = ("accepted", "rejected", "quarantined", "late", "duplicate")


class LatestStore:
    """Thread-safe, bounded: one envelope per allowlisted pair.

    The generator thread writes; the HTTP threads read. Both hold the same lock,
    and readers get the stored dictionaries as they are. Nothing mutates a stored
    envelope after it is accepted: events are immutable (AD-4 §2), and the only
    operation on one is replacement by a newer event for the same pair.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._latest: dict = {}
        self._counters = {name: 0 for name in COUNTER_NAMES}
        self._quarantine_reasons: dict = {}

    # ------------------------------------------------------------------ writing
    def apply(self, event: dict) -> bool:
        """Validates `event` and stores it if it is the newest for its pair.

        Returns True only when the event became the pair's current value. Every
        other outcome is counted:

        - invalid, or outside the pair allowlist -> `rejected`;
        - `quarantined` -> `quarantined`, plus a per-reason count. Withheld, so it
          is never served and never becomes the ordering watermark;
        - the same `event_id` and the same content as the current event ->
          `duplicate`;
        - not newer than the pair's current `source_timestamp` -> `late`.
        """
        try:
            validate_fx_envelope(event)
        except EnvelopeInvalid:
            # The reason is the caller's to log; no payload is retained here.
            self._bump("rejected")
            return False

        if event["validation"]["status"] != "validated":
            with self._lock:
                self._counters["quarantined"] += 1
                for reason in event["validation"]["reasons"]:
                    self._quarantine_reasons[reason] = self._quarantine_reasons.get(reason, 0) + 1
            return False

        payload = event["payload"]
        key = f"{payload['base_currency']}/{payload['quote_currency']}"
        moment = parse_timestamp(event["timestamps"]["source_timestamp"])
        with self._lock:
            current = self._latest.get(key)
            if current is not None:
                if current["event_id"] == event["event_id"] and current == event:
                    self._counters["duplicate"] += 1
                    return False
                if moment <= parse_timestamp(current["timestamps"]["source_timestamp"]):
                    self._counters["late"] += 1
                    return False
            self._latest[key] = event
            self._counters["accepted"] += 1
            return True

    def _bump(self, name: str) -> None:
        with self._lock:
            self._counters[name] += 1

    # ------------------------------------------------------------------ reading
    def events(self) -> list:
        """The current events, sorted by base then quote (AD-1 §3.1).

        0 to 4 entries: a pair that has produced nothing yet is simply absent, which
        is the empty state `GET /v1/latest` reports as `events: []`.
        """
        with self._lock:
            return [self._latest[key] for key in PAIR_KEYS if key in self._latest]

    def counters(self) -> dict:
        with self._lock:
            return {**self._counters, "quarantine_reasons": dict(self._quarantine_reasons)}

    def latest_for(self, pair_key: str) -> Optional[dict]:
        with self._lock:
            return self._latest.get(pair_key)

    def __len__(self) -> int:
        with self._lock:
            return len(self._latest)


assert len(PAIR_KEYS) == len(PAIRS) == 4, "the store is bounded at four pairs (AD-1 §3.4)"
