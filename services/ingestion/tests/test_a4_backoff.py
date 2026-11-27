"""A-4: retry and backoff (AD-5 §7.2), and `Retry-After` present, absent and invalid.

Everything is driven by an injected jitter source and an injected clock, so the
assertions are exact rather than statistical and the suite runs in milliseconds.
"""
from __future__ import annotations

import pytest

from cbdc_ingestion.adapters.faults import FaultClass
from cbdc_ingestion.adapters.retry import (
    RETRY_AFTER_ABSENT,
    RETRY_AFTER_CLAMPED,
    RETRY_AFTER_HONOURED,
    RETRY_AFTER_INVALID,
    BackoffPolicy,
    FullJitter,
    RetryDecision,
    no_jitter,
    parse_retry_after,
)
from cbdc_ingestion.adapters.simulation import SIMULATION_TIMING as P


# ----------------------------------------------------------------- the interval
def test_the_interval_doubles_from_the_base_and_stops_at_the_ceiling():
    policy = BackoffPolicy(P, jitter=no_jitter)
    caps = [policy.cap_ms(n) for n in range(1, 8)]
    assert caps[0] == P.backoff_base_ms
    assert caps[1] == P.backoff_base_ms * 2
    assert caps[2] == P.backoff_base_ms * 4
    assert max(caps) == P.backoff_ceiling_ms
    assert all(a <= b for a, b in zip(caps, caps[1:])), "monotonic"


def test_a_large_attempt_count_is_still_the_ceiling_and_costs_nothing():
    """Shifting rather than exponentiating: attempt 10**6 must not build a huge
    integer or overflow into a nonsense wait."""
    policy = BackoffPolicy(P, jitter=no_jitter)
    assert policy.cap_ms(10 ** 6) == P.backoff_ceiling_ms


def test_attempts_are_counted_from_one():
    with pytest.raises(ValueError, match="counted from 1"):
        BackoffPolicy(P).cap_ms(0)


def test_the_wait_is_inside_the_interval_for_every_attempt():
    """Full jitter's contract: `wait ∈ [0, cap]`, for a real seeded source."""
    policy = BackoffPolicy(P, seed=7)
    for _ in range(50):
        decision = policy.next_decision(FaultClass.PROVIDER_UNAVAILABLE)
        assert 0 <= decision.wait_ms <= policy.cap_ms(decision.attempt)


# ------------------------------------------------------------------- the jitter
def test_jitter_is_required_in_the_sense_that_matters():
    """AD-5 §7.2 requires jitter so that adapters restarting together do not
    synchronize onto one provider. The testable form of that is: two policies
    with **different seeds** produce different sequences."""
    a = [BackoffPolicy(P, seed=1).next_decision(FaultClass.PROVIDER_UNAVAILABLE).wait_ms
         for _ in range(1)]
    first = BackoffPolicy(P, seed=1)
    second = BackoffPolicy(P, seed=2)
    seq_one = [first.next_decision(FaultClass.PROVIDER_UNAVAILABLE).wait_ms for _ in range(12)]
    seq_two = [second.next_decision(FaultClass.PROVIDER_UNAVAILABLE).wait_ms for _ in range(12)]
    assert seq_one != seq_two, "two seeds must not align"
    assert a  # the single-draw form above is sane


def test_the_same_seed_reproduces_the_same_waits():
    """Determinism is what makes a fault case reproducible across machines."""
    one = BackoffPolicy(P, seed=42)
    two = BackoffPolicy(P, seed=42)
    assert [one.next_decision(FaultClass.TRANSIENT_NETWORK).wait_ms for _ in range(10)] == \
           [two.next_decision(FaultClass.TRANSIENT_NETWORK).wait_ms for _ in range(10)]


def test_full_jitter_covers_the_interval_rather_than_hugging_one_end():
    """A "jitter" that always returned the cap would pass the bound test above.
    The distribution is therefore asserted loosely but meaningfully."""
    jitter = FullJitter(3)
    draws = [jitter(1000) for _ in range(200)]
    assert min(draws) < 200 and max(draws) > 800
    assert all(0 <= d <= 1000 for d in draws)


def test_a_zero_or_negative_cap_yields_no_wait():
    jitter = FullJitter(0)
    assert jitter(0) == 0 and jitter(-5) == 0


# ------------------------------------------------- what resets the counter
def test_one_successful_item_resets_the_counter():
    policy = BackoffPolicy(P, jitter=no_jitter)
    policy.next_decision(FaultClass.PROVIDER_UNAVAILABLE)
    policy.next_decision(FaultClass.PROVIDER_UNAVAILABLE)
    assert policy.attempt == 2
    policy.on_item_success()
    assert policy.attempt == 0
    assert policy.next_decision(FaultClass.PROVIDER_UNAVAILABLE).wait_ms == P.backoff_base_ms


def test_a_successful_connection_is_not_progress_and_resets_nothing():
    """AD-5 §7.2 states this explicitly: "a connection that opens and immediately
    closes is not progress". A connect-based reset would let such a provider be
    hammered at the base interval for ever."""
    policy = BackoffPolicy(P, jitter=no_jitter)
    policy.next_decision(FaultClass.PROVIDER_UNAVAILABLE)
    policy.next_decision(FaultClass.PROVIDER_UNAVAILABLE)
    before = policy.attempt
    policy.on_connect_success()
    assert policy.attempt == before
    assert policy.next_decision(FaultClass.PROVIDER_UNAVAILABLE).attempt == before + 1


# --------------------------------------------------------- permanent has no wait
@pytest.mark.parametrize("fault_class", [FaultClass.AUTH_FAILURE,
                                         FaultClass.CONTRACT_VIOLATION])
def test_a_permanent_class_gets_no_retry_and_no_wait(fault_class):
    """`failed_permanent` has no backoff because it has no retry (AD-5 §7.2)."""
    policy = BackoffPolicy(P, jitter=no_jitter)
    decision = policy.next_decision(fault_class)
    assert decision.retry is False and decision.wait_ms is None
    assert decision.reason.startswith("permanent:")
    assert policy.attempt == 0, "a permanent fault does not advance the retry counter"


def test_a_decision_cannot_carry_a_wait_it_will_not_use():
    """The invariant is enforced by the dataclass, so no caller can sleep on a
    permanent fault by reading a field that should not be set."""
    with pytest.raises(ValueError, match="exactly when retry is True"):
        RetryDecision(retry=False, wait_ms=5, attempt=1, reason="x")
    with pytest.raises(ValueError, match="exactly when retry is True"):
        RetryDecision(retry=True, wait_ms=None, attempt=1, reason="x")


# ------------------------------------------------------------- Retry-After
@pytest.mark.parametrize("value,expected_ms,reason", [
    ("0", P.retry_after_min_ms, RETRY_AFTER_CLAMPED),   # below the floor
    ("1", 1000, RETRY_AFTER_HONOURED),                   # inside the clamp
    ("2", P.retry_after_max_ms, RETRY_AFTER_CLAMPED),    # just above the ceiling
    (None, None, RETRY_AFTER_ABSENT),
    ("", None, RETRY_AFTER_ABSENT),
    ("   ", None, RETRY_AFTER_ABSENT),
    ("soon", None, RETRY_AFTER_INVALID),
    ("-5", None, RETRY_AFTER_INVALID),
    ("1.5", None, RETRY_AFTER_INVALID),
    ("Wed, 21 Oct 2026 07:28:00 GMT", None, RETRY_AFTER_INVALID),
    ("99999", P.retry_after_max_ms, RETRY_AFTER_CLAMPED),  # above the ceiling
])
def test_retry_after_parsing_covers_present_absent_and_invalid(value, expected_ms, reason):
    """A-4 names all three explicitly. The HTTP-date form is **deliberately**
    invalid here: honouring it needs a wall clock, which AD-5 §3.5 forbids an
    adapter from reading, so the computed backoff is used instead of a guess."""
    assert parse_retry_after(value, P) == (expected_ms, reason)


def test_a_valid_retry_after_overrides_the_computed_wait():
    policy = BackoffPolicy(P, jitter=no_jitter)
    decision = policy.next_decision(FaultClass.PROVIDER_UNAVAILABLE, retry_after="1")
    assert decision.wait_ms == 1000 and decision.reason == "retry_after_override"
    assert decision.retry_after_reason == RETRY_AFTER_HONOURED


def test_an_invalid_retry_after_falls_back_to_the_computed_wait_and_is_counted():
    """No silent degradation (AD-5 §7.5): the fallback is reported, not hidden."""
    policy = BackoffPolicy(P, jitter=no_jitter)
    decision = policy.next_decision(FaultClass.PROVIDER_UNAVAILABLE, retry_after="nonsense")
    assert decision.wait_ms == P.backoff_base_ms
    assert decision.reason == "computed_backoff"
    assert decision.retry_after_reason == RETRY_AFTER_INVALID


def test_an_absent_retry_after_uses_the_computed_wait():
    policy = BackoffPolicy(P, jitter=no_jitter)
    decision = policy.next_decision(FaultClass.TRANSIENT_NETWORK)
    assert decision.wait_ms == P.backoff_base_ms
    assert decision.retry_after_reason == RETRY_AFTER_ABSENT


def test_a_rate_limited_retry_after_never_shortens_the_next_wait():
    """AD-5 §7.4: "a `rate_limited` fault never shortens the next wait", and a
    retry storm is itself alertable. So for 429 the effective wait is the
    **larger** of the header and the computed backoff — asserted at an attempt
    whose computed interval already exceeds the header's floor."""
    policy = BackoffPolicy(P, jitter=no_jitter)
    for _ in range(4):
        policy.next_decision(FaultClass.RATE_LIMITED)
    computed = policy.cap_ms(policy.attempt + 1)
    decision = policy.next_decision(FaultClass.RATE_LIMITED, retry_after="0")
    assert decision.wait_ms == max(P.retry_after_min_ms, computed)
    assert decision.wait_ms >= computed, "a 429 must never spin tighter than the backoff"
    assert decision.reason == "retry_after_or_backoff_whichever_is_longer"


def test_a_long_retry_after_is_honoured_for_a_rate_limit_too():
    """The rule is one-sided: it forbids shortening, not lengthening."""
    policy = BackoffPolicy(P, jitter=no_jitter)
    decision = policy.next_decision(FaultClass.RATE_LIMITED, retry_after="99999")
    assert decision.wait_ms == P.retry_after_max_ms
    assert decision.retry_after_reason == RETRY_AFTER_CLAMPED
