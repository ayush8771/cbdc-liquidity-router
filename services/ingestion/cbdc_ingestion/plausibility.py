"""Synthetic plausibility bounds (AD-5 §10, authorization §5.5).

For a synthetic source the bounds are **the generator's declared range, never a
market range**, so a **generator defect** is caught rather than displayed. The
D-24 generator's rates are deliberately unrealistic (AD-1 §3), which is exactly
why no market range may be attached to them.

**A breach is a quarantine — not a rejection and not a silent clamp.**

- **Not a rejection**: the event is well formed and its provenance is real; what
  is in doubt is the value. A rejection would discard the evidence of the fault.
- **Not a clamp**: a clamped value is a number no producer ever published,
  presented as though it had been. `LatestStore` withholds a quarantined event,
  so it is never served and never becomes the ordering watermark.

**Boundaries are inclusive, asserted on both sides** (criterion 16): at exactly
the range endpoints and at exactly `max_relative_jump`, the value is
**accepted**. Only *above* the jump, or *outside* the range, is it quarantined.

**Decimal arithmetic throughout.** Bounds and rates are decimal **strings** and
are compared as `Decimal`, never through a float: a float round-trip loses the
producer's digits, and a trailing zero is significant to the payload hash
(AD-5 §4). `Decimal("1.10") == Decimal("1.100000")` is true, which is what the
comparison wants — the *value* is equal even though the strings differ.
"""
from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Optional

# AD-4 §6 quarantine reasons this module can raise. `VALUE_OUT_OF_RANGE` and
# `VALUE_JUMP` are AD-5 §10's and are distinct on purpose: one says the value
# cannot be right, the other says it cannot have got there that fast.
VALUE_OUT_OF_RANGE = "VALUE_OUT_OF_RANGE"
VALUE_JUMP = "VALUE_JUMP"

PLAUSIBILITY_REASONS = (VALUE_OUT_OF_RANGE, VALUE_JUMP)


def range_key(event_type: str, subject) -> str:
    """The `plausibility.ranges` key: the type and the subject, joined by `/`."""
    return f"{event_type}:" + "/".join(str(part) for part in subject)


def _decimal(value) -> Optional[Decimal]:
    """`value` as a `Decimal`, or `None` when it is not a decimal string.

    A non-string is `None` rather than coerced: AD-5 §4 requires decimal
    strings, and silently accepting a float here would defeat the rule the
    registry and the adapter both enforce.
    """
    if not isinstance(value, str):
        return None
    try:
        parsed = Decimal(value)
    except (InvalidOperation, ValueError):
        return None
    if not parsed.is_finite():
        return None
    return parsed


def check_range(value: str, bounds: dict) -> Optional[str]:
    """`None` when `value` is inside `bounds` **inclusive**, else the reason.

    `min` and `max` are the generator's declared range. At exactly either
    endpoint the value is accepted.
    """
    parsed = _decimal(value)
    if parsed is None:
        return VALUE_OUT_OF_RANGE
    low, high = _decimal(bounds.get("min")), _decimal(bounds.get("max"))
    if low is None or high is None:
        # A malformed bound quarantines rather than passes: a range nobody can
        # read is not a range that admits everything.
        return VALUE_OUT_OF_RANGE
    if parsed < low or parsed > high:
        return VALUE_OUT_OF_RANGE
    return None


def check_jump(value: str, previous: Optional[str], max_relative_jump) -> Optional[str]:
    """`None` when the move from `previous` is within the limit, else the reason.

    The limit is **relative to the subject's current value**, within one
    `expected_interval_ms`. **At exactly the limit the value is accepted**; only
    above it is quarantined.

    With no previous value there is nothing to jump from, so the first
    observation of a subject always passes. A previous value of zero cannot
    occur — the generator's constants keep every rate positive — and is treated
    as "no baseline" rather than as a division by zero.
    """
    if previous is None:
        return None
    parsed, before = _decimal(value), _decimal(previous)
    if parsed is None:
        return VALUE_OUT_OF_RANGE
    if before is None or before == 0:
        return None
    limit = _decimal(str(max_relative_jump)) if not isinstance(
        max_relative_jump, Decimal) else max_relative_jump
    if limit is None:
        return VALUE_JUMP
    relative = abs(parsed - before) / abs(before)
    return VALUE_JUMP if relative > limit else None


class PlausibilityGuard:
    """One source's bounds, with the last accepted value per subject.

    It holds **one decimal string per subject** — four for this slice — and no
    event, so its memory is bounded whatever the run length.

    **The baseline is the last value that passed**, not the last seen: a
    quarantined value must not become the baseline the next jump is measured
    against, or one bad reading would silently re-centre the check and admit a
    second bad reading as a small move from it.
    """

    def __init__(self, plausibility: dict) -> None:
        self.max_relative_jump = plausibility.get("max_relative_jump")
        self.ranges = dict(plausibility.get("ranges") or {})
        self._last: dict = {}
        self.counters = {reason: 0 for reason in PLAUSIBILITY_REASONS}

    def check(self, event_type: str, subject, value: str) -> Optional[str]:
        """The quarantine reason for `value`, or `None` when it is plausible."""
        key = range_key(event_type, subject)
        bounds = self.ranges.get(key)
        if bounds is not None:
            reason = check_range(value, bounds)
            if reason is not None:
                self.counters[reason] += 1
                return reason
        reason = check_jump(value, self._last.get(key), self.max_relative_jump)
        if reason is not None:
            self.counters[reason] += 1
            return reason
        self._last[key] = value
        return None

    def last_accepted(self, event_type: str, subject) -> Optional[str]:
        return self._last.get(range_key(event_type, subject))

    def snapshot(self) -> dict:
        return {"counters": dict(self.counters), "subjects": len(self._last)}
