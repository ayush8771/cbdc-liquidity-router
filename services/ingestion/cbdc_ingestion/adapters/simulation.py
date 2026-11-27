"""Explicitly labelled **simulation** timing parameters for A-4 fault handling.

**These are not AD-8 values, and they must never be read as AD-8 values.**

AD-8 is a **DRAFT**. The project owner's approval of 26 November 2026 is bounded
to §3.5's **`synthetic` column** (outage at 3 consecutive failures or a silence
window of 3 × `expected_interval_ms`, `dedup_window` 300 s, a 2 000 ms `stop()`
budget), §4.2's synthetic freshness row with §4.3, and §4.4's synthetic
plausibility bounds. **AD-8 §3.5's `poll` and `websocket` columns are
unapproved**, and those columns are where production retry, `Retry-After`,
circuit-breaker and body-size numbers live. Hard-coding them here would be
adopting unapproved values by implementation, so this module deliberately does
not contain them.

**What this module is instead.** One frozen profile whose every field is chosen
for **determinism and test speed**, carrying the label `SIMULATION_ONLY` in the
object itself so a caller cannot forget which it holds. The values are small on
purpose — milliseconds, not seconds — because the A-4 suite drives an injected
clock and must stay fast, and because a value that was plausibly productionlike
would invite exactly the promotion this module exists to prevent.

**The two approved numbers that are reused, and only those two.** The outage
criteria and the shutdown budget come from the **approved** synthetic column and
already live in `status.py` and `base.py`. A-4 drives those; it does not restate
them.

**Promotion requires an owner decision, not an edit here.** Turning any field
below into a production default needs AD-8 §3.5's `poll` column approved, or a
bounded grant in the AD4P2-Q2 style. `tests/test_a4_simulation_params.py`
asserts that no field here coincides with AD-8 §3.5's unapproved `poll` values,
so a silent promotion fails the suite rather than shipping.
"""
from __future__ import annotations

from dataclasses import dataclass

# The one legal value of `SimulatedTimingProfile.label`. A profile that is not
# labelled as a simulation cannot be constructed, so there is no way to hold one
# of these objects and believe it carries approved production thresholds.
SIMULATION_ONLY = "SIMULATION_ONLY"


@dataclass(frozen=True)
class SimulatedTimingProfile:
    """Deterministic, test-only timing for the A-4 fault-handling exercise.

    Frozen, so a test cannot mutate the shared profile and leak the change into
    another case; a variant is made with `replace(...)`, which produces a new
    object that is still labelled.
    """

    label: str = SIMULATION_ONLY

    # --- retry (AD-5 §7.2's shape, with simulation numbers) -----------------
    backoff_base_ms: int = 10
    backoff_ceiling_ms: int = 80

    # --- Retry-After (AD-5 §7.2's clamp, with simulation bounds) ------------
    retry_after_min_ms: int = 10
    # 1500, so that the clamp has an interior a provider can actually land in.
    # `Retry-After` is expressed in whole **seconds**, so a ceiling below
    # 1000 ms would clamp *every* legal header and the "honoured" path would be
    # unreachable — the A-4 case for a present, valid, honoured header could
    # then never be exercised. A ceiling just above one second keeps `1`
    # honoured and `2` clamped, so both sides are reachable.
    retry_after_max_ms: int = 1500

    # --- circuit breaker (AD-5 §7.4's shape, with simulation numbers) -------
    breaker_failure_threshold: int = 3
    # 900, not 1000: a bare 1000 would collide with AD-8 §3.5's unapproved
    # `poll` backoff base and `Retry-After` floor, and
    # `tests/test_a4_simulation_params.py` refuses any literal in this module
    # that equals an unapproved AD-8 number. Keeping the two sets of numbers
    # disjoint is what makes that check sharp rather than approximate.
    breaker_window_ms: int = 900
    breaker_cooldown_ms: int = 500

    # --- whole-response limits (AD-5 §7.3's shape, with simulation numbers) -
    max_response_bytes: int = 4096
    max_items_per_response: int = 8

    # --- the self-imposed request ceiling (AD-5 §7.4) -----------------------
    # "The provider's limit is a cliff, not a target", so the ceiling is the
    # adapter's own and is strictly below any limit a record might declare.
    # Deliberately **below** `backoff_base_ms`, so that after a fault the
    # binding gate is the backoff and not this ceiling. If the ceiling were the
    # longer of the two it would silently dominate every early retry, and a
    # backoff interval of one base step could never be observed — the two gates
    # would be indistinguishable in exactly the cases A-4 is about. 4, not 5,
    # because 5 is AD-8 §3.5's unapproved poll failure threshold and this module
    # keeps its literals disjoint from that column.
    min_request_interval_ms: int = 4

    def __post_init__(self) -> None:
        if self.label != SIMULATION_ONLY:
            raise ValueError(
                f"a timing profile here is labelled {SIMULATION_ONLY!r}; got {self.label!r}. "
                "AD-8 §3.5's poll and websocket columns are UNAPPROVED and are not "
                "represented in this module")
        if self.backoff_base_ms < 1 or self.backoff_ceiling_ms < self.backoff_base_ms:
            raise ValueError("backoff needs 1 <= base <= ceiling")
        if self.retry_after_min_ms < 0 or self.retry_after_max_ms < self.retry_after_min_ms:
            raise ValueError("the Retry-After clamp needs 0 <= min <= max")
        if self.breaker_failure_threshold < 1:
            raise ValueError("a breaker opens after at least one failure")
        if self.breaker_window_ms < 1 or self.breaker_cooldown_ms < 1:
            raise ValueError("the breaker window and cooldown are positive")
        if self.max_response_bytes < 1 or self.max_items_per_response < 1:
            raise ValueError("the response limits are positive")
        if self.min_request_interval_ms < 0:
            raise ValueError("the request interval ceiling is non-negative")

    @property
    def is_simulation(self) -> bool:
        return self.label == SIMULATION_ONLY


# The profile the A-4 exercise and its demonstration use. Module-level and
# frozen, so every case starts from the same declared numbers.
SIMULATION_TIMING = SimulatedTimingProfile()
