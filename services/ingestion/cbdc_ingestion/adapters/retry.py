"""AD-5 §7.2's backoff and §7.4's circuit breaker, on simulation parameters.

Every number comes from `simulation.SimulatedTimingProfile`, which is labelled
`SIMULATION_ONLY` because **AD-8 §3.5's `poll` column is unapproved**. Nothing
here reads a wall clock: the caller passes `now_ms` from the injected clock, so
a test drives a sixty-second window without waiting and two runs of the same
script produce the same waits.

**Three rules that are easy to get subtly wrong, so they are stated as code.**

1. **The attempt counter resets after one successful *item*, not after a
   successful connection** (AD-5 §7.2). "A connection that opens and immediately
   closes is not progress" — so `on_connect_success()` deliberately does
   nothing, and only `on_item_success()` resets.
2. **Jitter is required, not optional** (AD-5 §7.2), so that adapters restarting
   together do not synchronize onto one provider. It is **injected**, so it is
   deterministic: `FullJitter(seed)` is reproducible, and two different seeds
   give different waits, which is the property the rule is about.
3. **A `rate_limited` fault never shortens the next wait** (AD-5 §7.4). A
   server-supplied `Retry-After` *overrides* the computed wait for
   `provider_unavailable`, but for `rate_limited` the effective wait is the
   **larger** of the two, so a short `Retry-After` cannot be used to spin
   tighter than the adapter's own backoff.

**`failed_permanent` has no backoff, because it has no retry** (AD-5 §7.2). This
module refuses to compute a wait for a permanent class rather than returning a
number a caller might then sleep for.
"""
from __future__ import annotations

import random
import threading
from dataclasses import dataclass
from typing import Callable, Optional

from .faults import FaultClass, is_permanent
from .simulation import SIMULATION_TIMING, SimulatedTimingProfile

# The breaker's states (AD-5 §7.4). `half_open` admits **exactly one** probe.
BREAKER_STATES = ("closed", "open", "half_open")

# Why a `Retry-After` value was not used. Counted, never silently dropped
# (AD-5 §7.5: "no silent degradation").
RETRY_AFTER_ABSENT = "retry_after_absent"
RETRY_AFTER_INVALID = "retry_after_invalid"
RETRY_AFTER_CLAMPED = "retry_after_clamped"
RETRY_AFTER_HONOURED = "retry_after_honoured"


class FullJitter:
    """Full jitter (AD-5 §7.2), deterministic because it is seeded.

    `wait = uniform(0, cap)`. Seeded from an integer the caller chooses, so a
    replay reproduces the waits exactly, while two adapters given different
    seeds do **not** align — which is the whole point of requiring jitter.
    """

    def __init__(self, seed: int = 0) -> None:
        self.seed = int(seed)
        self._random = random.Random(self.seed)
        self._lock = threading.Lock()

    def __call__(self, cap_ms: int) -> int:
        cap_ms = int(cap_ms)
        if cap_ms <= 0:
            return 0
        with self._lock:
            return int(self._random.uniform(0, cap_ms))


def no_jitter(cap_ms: int) -> int:
    """The maximum of the interval, for a test that wants the exact ceiling.

    Named for what it is: **not** a legal production policy, because AD-5 §7.2
    requires jitter. It exists so a test can assert the ceiling itself rather
    than a bound.
    """
    return max(0, int(cap_ms))


def parse_retry_after(value, profile: SimulatedTimingProfile = SIMULATION_TIMING):
    """One `Retry-After` header as `(wait_ms, reason)`.

    Accepts **delay-seconds**, the form a provider uses for a short wait, and
    returns `None` with a reason for everything else. The HTTP-date form is
    deliberately **not** accepted and is reported as `retry_after_invalid`:
    honouring it needs a trustworthy wall clock and a timezone-correct parse,
    and AD-5 §3.5 forbids an adapter reading a wall clock at all. A provider
    that sends a date therefore gets the computed backoff — never a guess.

    - absent (`None` or empty) → `(None, RETRY_AFTER_ABSENT)`
    - not an integer, negative, or a date → `(None, RETRY_AFTER_INVALID)`
    - outside the clamp → the clamped value, with `RETRY_AFTER_CLAMPED`
    - inside it → the value, with `RETRY_AFTER_HONOURED`
    """
    if value is None:
        return None, RETRY_AFTER_ABSENT
    text = str(value).strip()
    if not text:
        return None, RETRY_AFTER_ABSENT
    try:
        seconds = int(text)
    except ValueError:
        return None, RETRY_AFTER_INVALID
    if seconds < 0:
        return None, RETRY_AFTER_INVALID
    wait_ms = seconds * 1000
    clamped = min(max(wait_ms, profile.retry_after_min_ms), profile.retry_after_max_ms)
    if clamped != wait_ms:
        return clamped, RETRY_AFTER_CLAMPED
    return wait_ms, RETRY_AFTER_HONOURED


@dataclass(frozen=True)
class RetryDecision:
    """What to do after one fault: whether to retry, when, and why.

    `wait_ms` is `None` exactly when `retry` is False, so a caller cannot sleep
    on a permanent fault by reading a field it should not have.
    """

    retry: bool
    wait_ms: Optional[int]
    attempt: int
    reason: str
    retry_after_reason: str = RETRY_AFTER_ABSENT

    def __post_init__(self) -> None:
        if self.retry != (self.wait_ms is not None):
            raise ValueError("wait_ms is set exactly when retry is True")


class BackoffPolicy:
    """Exponential backoff with full jitter (AD-5 §7.2).

    Attempt *n* waits a value in `[0, min(base * 2**(n-1), ceiling)]`. The
    interval is the **cap**; the jitter source picks inside it.
    """

    def __init__(self, profile: SimulatedTimingProfile = SIMULATION_TIMING, *,
                 jitter: Optional[Callable[[int], int]] = None, seed: int = 0) -> None:
        if not profile.is_simulation:
            raise ValueError("A-4 runs on a SIMULATION_ONLY profile")
        self.profile = profile
        self.jitter = FullJitter(seed) if jitter is None else jitter
        self._attempt = 0
        self._lock = threading.RLock()

    @property
    def attempt(self) -> int:
        with self._lock:
            return self._attempt

    def cap_ms(self, attempt: int) -> int:
        """The interval attempt `attempt` draws from. Attempt 1 is `base`."""
        if attempt < 1:
            raise ValueError("attempts are counted from 1")
        # Shifting rather than exponentiating keeps a large attempt count cheap
        # and exact; the ceiling makes the growth irrelevant past a few steps.
        if attempt - 1 >= 32:
            return self.profile.backoff_ceiling_ms
        return min(self.profile.backoff_base_ms << (attempt - 1),
                   self.profile.backoff_ceiling_ms)

    def on_item_success(self) -> None:
        """One successful **item** resets the counter (AD-5 §7.2)."""
        with self._lock:
            self._attempt = 0

    def on_connect_success(self) -> None:
        """A successful connection is **not** progress, so nothing resets.

        Deliberately a no-op with a name, rather than an absence: a caller that
        wants to report a connection has somewhere to report it, and the method
        documents that the report changes no wait.
        """
        return None

    def next_decision(self, fault_class: FaultClass, *,
                      retry_after=None) -> RetryDecision:
        """The decision for one fault of `fault_class`.

        A **permanent** class returns `retry=False` with no wait: AD-5 §7.2 says
        `failed_permanent` has no backoff because it has no retry.
        """
        fault_class = FaultClass(fault_class)
        if is_permanent(fault_class):
            return RetryDecision(retry=False, wait_ms=None, attempt=self.attempt,
                                 reason=f"permanent:{fault_class.value}")
        with self._lock:
            self._attempt += 1
            attempt = self._attempt
        computed = self.jitter(self.cap_ms(attempt))
        header_ms, header_reason = parse_retry_after(retry_after, self.profile)
        if header_ms is None:
            wait_ms, reason = computed, "computed_backoff"
        elif fault_class is FaultClass.RATE_LIMITED:
            # AD-5 §7.4: never a tighter spin. The larger of the two wins, so a
            # small `Retry-After` cannot shorten the adapter's own backoff.
            wait_ms = max(header_ms, computed)
            reason = "retry_after_or_backoff_whichever_is_longer"
        else:
            wait_ms = header_ms
            reason = "retry_after_override"
        return RetryDecision(retry=True, wait_ms=int(wait_ms), attempt=attempt,
                             reason=reason, retry_after_reason=header_reason)


class CircuitBreaker:
    """One source's breaker (AD-5 §7.4). **Per `source_id`, never global.**

    After `breaker_failure_threshold` failures inside `breaker_window_ms` the
    breaker **opens** and the adapter stops requesting for `breaker_cooldown_ms`.
    It then admits **exactly one probe**: a probe that succeeds closes it, a
    probe that fails opens it again for a fresh cooldown.

    The window is a sliding one over recorded failure times, so three failures
    spread wider than the window never open it — which is what distinguishes a
    flapping source from a failing one.
    """

    def __init__(self, source_id: str,
                 profile: SimulatedTimingProfile = SIMULATION_TIMING) -> None:
        if not profile.is_simulation:
            raise ValueError("A-4 runs on a SIMULATION_ONLY profile")
        self.source_id = str(source_id)
        self.profile = profile
        self._lock = threading.RLock()
        self._state = "closed"
        self._failures: list = []
        self._opened_ms: Optional[int] = None
        self._probe_in_flight = False
        self.opened_count = 0
        self.probes_admitted = 0
        self.refusals = 0

    @property
    def state(self) -> str:
        with self._lock:
            return self._state

    def _prune(self, now_ms: int) -> None:
        horizon = int(now_ms) - self.profile.breaker_window_ms
        self._failures = [t for t in self._failures if t > horizon]

    def allow(self, now_ms: int) -> bool:
        """Whether a request may be made now.

        While **open** this returns False *without* contacting anything, which
        is the breaker's whole purpose: the cooldown must cost no requests. In
        **half_open** it returns True for one caller only; the next caller is
        refused until that probe reports through `record_success` or
        `record_failure`.
        """
        now_ms = int(now_ms)
        with self._lock:
            if self._state == "closed":
                return True
            if self._state == "open":
                if self._opened_ms is not None and \
                        now_ms - self._opened_ms >= self.profile.breaker_cooldown_ms:
                    self._state = "half_open"
                    self._probe_in_flight = False
                else:
                    self.refusals += 1
                    return False
            # half_open: exactly one probe in flight.
            if self._probe_in_flight:
                self.refusals += 1
                return False
            self._probe_in_flight = True
            self.probes_admitted += 1
            return True

    def record_success(self, now_ms: int) -> str:
        """One successful item. Closes the breaker and clears its history."""
        with self._lock:
            self._state = "closed"
            self._failures = []
            self._opened_ms = None
            self._probe_in_flight = False
            return self._state

    def record_failure(self, now_ms: int) -> str:
        """One failure. Opens the breaker at the threshold, or re-opens on a
        failed probe."""
        now_ms = int(now_ms)
        with self._lock:
            if self._state == "half_open":
                self._state = "open"
                self._opened_ms = now_ms
                self._probe_in_flight = False
                self.opened_count += 1
                return self._state
            self._failures.append(now_ms)
            self._prune(now_ms)
            if len(self._failures) >= self.profile.breaker_failure_threshold:
                self._state = "open"
                self._opened_ms = now_ms
                self._probe_in_flight = False
                self.opened_count += 1
            return self._state

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "source_id": self.source_id,
                "state": self._state,
                "failures_in_window": len(self._failures),
                "opened_count": self.opened_count,
                "probes_admitted": self.probes_admitted,
                "refusals": self.refusals,
            }


class BreakerRegistry:
    """One breaker per `source_id`, so one source's outage cannot silence
    another (AD-5 §7.4). The isolation is the reason this exists at all rather
    than a single module-level breaker."""

    def __init__(self, profile: SimulatedTimingProfile = SIMULATION_TIMING) -> None:
        self.profile = profile
        self._lock = threading.Lock()
        self._breakers: dict = {}

    def for_source(self, source_id: str) -> CircuitBreaker:
        with self._lock:
            breaker = self._breakers.get(source_id)
            if breaker is None:
                breaker = CircuitBreaker(source_id, self.profile)
                self._breakers[source_id] = breaker
            return breaker

    def snapshot(self) -> dict:
        with self._lock:
            return {sid: b.snapshot() for sid, b in self._breakers.items()}
