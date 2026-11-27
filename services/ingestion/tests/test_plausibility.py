"""Acceptance criterion 16: synthetic plausibility bounds (AD-5 §10, authorization §5.5).

Three things are asserted here, and they are the three the criterion names:

1. **The bounds are the generator's declared range, never a market range.** The
   registry's `fx_rate:EUR/USD/mid` range is `2.190000`–`2.210000`, which is not
   a real EUR/USD rate at all. That is the point: a market range attached to the
   D-24 generator's deliberately unrealistic rates would quarantine every
   correct value and pass every defective one.
2. **A breach quarantines — never rejects, never clamps.** The event is counted
   on the `quarantine` channel, is absent from `observations`, and no clamped
   number is published in its place. A clamp would present a value no producer
   published as though it had been.
3. **Boundaries are inclusive, asserted on both sides.** Exactly `min`, exactly
   `max` and exactly `max_relative_jump` are **accepted**; only outside the
   range, or strictly above the jump, is quarantined.

Decimal strings throughout: a float round-trip loses the producer's digits and a
trailing zero is significant to the payload hash (AD-5 §4).
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from cbdc_ingestion.adapters.base import NormalizedObservation
from cbdc_ingestion.adapters.registry import load_registry
from cbdc_ingestion.pipeline import SourcePipeline
from cbdc_ingestion.plausibility import (
    VALUE_JUMP,
    VALUE_OUT_OF_RANGE,
    PlausibilityGuard,
    check_jump,
    check_range,
    range_key,
)

from cbdc_ingestion.sink import ServiceSink

from .adapter_cases import SYNTHETIC_FX_SOURCE_ID
from .conftest import SEED, START_MS

EURUSD = ("EUR", "USD", "mid")
BOUNDS = {"min": "2.190000", "max": "2.210000"}
# The registry's own value, so the test moves when the record does.
JUMP = 0.2


@pytest.fixture
def record():
    return load_registry().record_for(SYNTHETIC_FX_SOURCE_ID)


@pytest.fixture
def guard(record):
    return PlausibilityGuard(record.plausibility)


# --------------------------------------------------------------- the key itself
def test_the_range_key_is_the_type_and_the_subject():
    """`range_key` must produce exactly the registry's spelling, or every lookup
    misses and every value passes unchecked — a silent failure, not a loud one."""
    assert range_key("fx_rate", EURUSD) == "fx_rate:EUR/USD/mid"


def test_every_registry_subject_has_a_range(record):
    """A subject with no range is a subject with no range check. The record
    declares four, and all four must be reachable by the key the guard builds."""
    for subject in record.subjects:
        assert range_key("fx_rate", tuple(subject)) in record.plausibility["ranges"]


# ------------------------------------------------- inclusive range, both sides
@pytest.mark.parametrize("value", ["2.190000", "2.210000", "2.200000"])
def test_a_value_inside_the_range_inclusive_is_accepted(value):
    """**Exactly `min` and exactly `max` are accepted** (criterion 16)."""
    assert check_range(value, BOUNDS) is None


def test_the_endpoints_are_accepted_whatever_their_trailing_zeros():
    """`Decimal("2.19") == Decimal("2.190000")`, so the comparison is on the
    value and not on the string. A producer that drops a trailing zero must not
    be quarantined for it."""
    assert check_range("2.19", BOUNDS) is None
    assert check_range("2.2100", BOUNDS) is None


@pytest.mark.parametrize("value", ["2.189999", "2.210001", "0", "-2.200000", "9.000000"])
def test_a_value_outside_the_range_is_out_of_range(value):
    """One unit below `min` and one above `max` are breaches: the bound is
    inclusive, so the first excluded value is adjacent to it."""
    assert check_range(value, BOUNDS) == VALUE_OUT_OF_RANGE


@pytest.mark.parametrize("value", [2.2, None, "", "abc", "NaN", "Infinity"])
def test_a_non_decimal_string_is_out_of_range_not_an_exception(value):
    """A float, a null and an unparseable string all quarantine. AD-5 §4 requires
    a decimal string; coercing a float here would defeat the rule the registry
    and the adapter both enforce, and raising would turn a bad value into a
    crashed cycle."""
    assert check_range(value, BOUNDS) == VALUE_OUT_OF_RANGE


def test_a_malformed_bound_quarantines_rather_than_admitting_everything():
    """A range nobody can read is not a range that admits everything. The
    fail-closed direction is the only safe one: the alternative publishes an
    unchecked value whenever a record is mis-edited."""
    assert check_range("2.200000", {"min": "oops", "max": "2.210000"}) == VALUE_OUT_OF_RANGE
    assert check_range("2.200000", {"min": 2.19, "max": 2.21}) == VALUE_OUT_OF_RANGE
    assert check_range("2.200000", {}) == VALUE_OUT_OF_RANGE


# -------------------------------------------------- inclusive jump, both sides
def test_the_first_observation_of_a_subject_has_nothing_to_jump_from():
    assert check_jump("2.200000", None, JUMP) is None


def test_a_move_of_exactly_the_jump_limit_is_accepted():
    """**At exactly `max_relative_jump` the value is accepted** (criterion 16).
    0.2 of 2.000000 is 0.400000, so 2.400000 is exactly the limit."""
    assert check_jump("2.400000", "2.000000", JUMP) is None
    assert check_jump("1.600000", "2.000000", JUMP) is None  # the same, downward


def test_a_move_above_the_jump_limit_is_a_jump():
    """Strictly above only — one unit past the limit in either direction."""
    assert check_jump("2.400001", "2.000000", JUMP) == VALUE_JUMP
    assert check_jump("1.599999", "2.000000", JUMP) == VALUE_JUMP


def test_the_jump_is_relative_not_absolute():
    """The same absolute move is a breach at one level and not at another, which
    is what "relative" means and what an absolute threshold would get wrong."""
    assert check_jump("1.300000", "1.000000", JUMP) == VALUE_JUMP   # +30%
    assert check_jump("100.300000", "100.000000", JUMP) is None     # +0.3%


def test_a_zero_or_unreadable_previous_value_is_no_baseline_not_a_division():
    """The generator's constants keep every rate positive, so a zero baseline
    cannot occur; it must still not raise `ZeroDivisionError` if it ever does."""
    assert check_jump("2.200000", "0", JUMP) is None
    assert check_jump("2.200000", "0.000000", JUMP) is None
    assert check_jump("2.200000", "abc", JUMP) is None


def test_the_jump_comparison_uses_decimals_not_floats():
    """A `Decimal` limit is honoured as given, so a caller holding exact digits
    is not forced through a float to use them."""
    assert check_jump("2.400000", "2.000000", Decimal("0.2")) is None
    assert check_jump("2.400001", "2.000000", Decimal("0.2")) == VALUE_JUMP


# ------------------------------------------------------------ the guard's state
def test_the_guard_accepts_then_remembers_the_subject(guard):
    assert guard.check("fx_rate", EURUSD, "2.200000") is None
    assert guard.last_accepted("fx_rate", EURUSD) == "2.200000"


def test_a_quarantined_value_does_not_become_the_jump_baseline(guard):
    """**The baseline is the last value that passed, not the last seen.** If a
    breach re-centred the check, one bad reading would admit a second bad
    reading as a small move from it — the fault would hide itself after one
    cycle. Asserted on the range breach, which is the reachable one here."""
    assert guard.check("fx_rate", EURUSD, "2.200000") is None
    assert guard.check("fx_rate", EURUSD, "9.000000") == VALUE_OUT_OF_RANGE
    assert guard.last_accepted("fx_rate", EURUSD) == "2.200000"
    # Still measured from 2.200000, so a value just inside the range passes.
    assert guard.check("fx_rate", EURUSD, "2.209999") is None


def test_the_range_is_checked_before_the_jump(guard):
    """A value that breaches both is reported as out of range: the stronger
    statement — the value cannot be right — outranks the weaker one, that it
    cannot have got there that fast."""
    assert guard.check("fx_rate", EURUSD, "2.200000") is None
    assert guard.check("fx_rate", EURUSD, "99.000000") == VALUE_OUT_OF_RANGE


def test_subjects_keep_separate_baselines(guard):
    """One subject's move must never be measured against another's value."""
    assert guard.check("fx_rate", EURUSD, "2.200000") is None
    assert guard.check("fx_rate", ("GBP", "PHP", "mid"), "3.300000") is None
    assert guard.last_accepted("fx_rate", EURUSD) == "2.200000"
    assert guard.last_accepted("fx_rate", ("GBP", "PHP", "mid")) == "3.300000"


def test_a_subject_with_no_declared_range_is_still_jump_checked(guard):
    """No range in the record means no range check — but the jump check is not
    conditional on one, so an undeclared subject is not unchecked entirely."""
    unknown = ("XXX", "YYY", "mid")
    assert guard.check("fx_rate", unknown, "1.000000") is None
    assert guard.check("fx_rate", unknown, "1.100000") is None
    assert guard.check("fx_rate", unknown, "2.000000") == VALUE_JUMP


def test_the_guard_counts_by_reason_and_holds_no_event(guard):
    """AD-8 §7.1: counters and labels only. The snapshot must carry numbers, not
    payloads or provider text."""
    guard.check("fx_rate", EURUSD, "9.000000")
    guard.check("fx_rate", EURUSD, "2.200000")
    snapshot = guard.snapshot()
    assert snapshot["counters"][VALUE_OUT_OF_RANGE] == 1
    assert snapshot["counters"][VALUE_JUMP] == 0
    assert snapshot["subjects"] == 1
    assert set(snapshot) == {"counters", "subjects"}


# ------------------------------------- a quarantine, not a rejection or a clamp
class _FixedAdapter:
    """A stand-in producing exactly the values the test names, in order.

    Not a registered adapter and never reachable at runtime; it exists so the
    pipeline's quarantine path can be driven with a chosen value, which no
    shipped adapter will emit.
    """

    def __init__(self, values, *, first_sequence: int = 1) -> None:
        self._values = list(values)
        self._sequence = int(first_sequence)
        self._context = None
        self.faults: list = []

    def produce(self):
        if not self._values:
            return ()
        value = self._values.pop(0)
        sequence, self._sequence = self._sequence, self._sequence + 1
        return (NormalizedObservation(
            event_type="fx_rate", subject=EURUSD,
            payload={"base_currency": "EUR", "quote_currency": "USD",
                     "rate_type": "mid", "rate": value},
            source_timestamp_ms=START_MS, source_timestamp_basis="observed",
            sequence=sequence),)

    def _record_fault(self, fault) -> None:   # pragma: no cover - not exercised
        self.faults.append(fault)


def test_a_breach_is_quarantined_and_never_published(record):
    """The event lands on the `quarantine` channel with a reason, and
    `observations` stays empty. **Not a rejection**: it is counted as
    quarantined, not rejected, because the event is well formed and its
    provenance is real — what is in doubt is the value."""
    pipeline = SourcePipeline(record, seed=SEED, now_ms=START_MS)
    sink = ServiceSink()
    result = pipeline.run_cycle(_FixedAdapter(["9.000000"]), sink,
                                retrieved_at_ms=START_MS)
    assert result.produced == 1
    assert result.quarantined == 1
    assert result.published == 0
    assert result.rejected == 0
    assert sink.store.events() == []
    assert sink.quarantine.by_reason() == {VALUE_OUT_OF_RANGE: 1}
    assert result.reasons == [VALUE_OUT_OF_RANGE]


def test_nothing_clamped_is_published_in_its_place(record):
    """**Not a clamp.** A clamped value is a number no producer ever published,
    presented as though it had been. So the breaching cycle must publish
    *nothing* — not the nearest in-range value."""
    pipeline = SourcePipeline(record, seed=SEED, now_ms=START_MS)
    sink = ServiceSink()
    pipeline.run_cycle(_FixedAdapter(["9.000000"]), sink, retrieved_at_ms=START_MS)
    # Nothing at all is current, and in particular not the breached boundary.
    assert sink.store.events() == []
    assert BOUNDS["max"] not in [
        event["payload"]["rate"] for event in sink.store.events()]


def test_a_plausible_value_is_published_on_the_same_path(record):
    """The control: the same pipeline, an in-range value, and it reaches
    `observations`. Without this the quarantine assertions would also pass if the
    path published nothing at all."""
    pipeline = SourcePipeline(record, seed=SEED, now_ms=START_MS)
    sink = ServiceSink()
    result = pipeline.run_cycle(_FixedAdapter(["2.200000"]), sink,
                                retrieved_at_ms=START_MS)
    assert result.published == 1
    assert result.quarantined == 0
    current = sink.store.events()
    assert len(current) == 1
    assert current[0]["payload"]["rate"] == "2.200000"


def test_the_quarantined_value_never_becomes_the_ordering_watermark(record):
    """A withheld event must not advance the source's position, or a later good
    value would be judged late against a value that was never served."""
    pipeline = SourcePipeline(record, seed=SEED, now_ms=START_MS)
    sink = ServiceSink()
    adapter = _FixedAdapter(["9.000000", "2.200000"])
    pipeline.run_cycle(adapter, sink, retrieved_at_ms=START_MS)
    result = pipeline.run_cycle(adapter, sink, retrieved_at_ms=START_MS + 2000)
    assert result.published == 1
    assert len(sink.store.events()) == 1


def test_a_quarantine_is_not_a_fault_and_does_not_change_the_status(record):
    """A value in doubt is not a transport failure. The internal status must not
    move towards `outage` because a generator defect was caught — that is the
    bound working, not the source failing."""
    pipeline = SourcePipeline(record, seed=SEED, now_ms=START_MS)
    sink = ServiceSink()
    pipeline.run_cycle(_FixedAdapter(["9.000000"]), sink, retrieved_at_ms=START_MS)
    assert sink.faults.total == 0
    assert pipeline.status.snapshot()["consecutive_failures"] == 0


# ------------------------------------------- the generator's range, not a market's
def test_the_registry_range_is_the_generators_not_the_markets(record):
    """The declared EUR/USD range is around 2.20, which is **not** a market rate.
    Asserted explicitly so a well-meaning later edit toward a realistic range
    fails a test instead of silently quarantining every correct value
    (AD-1 §3: the D-24 generator's rates are deliberately unrealistic)."""
    bounds = record.plausibility["ranges"]["fx_rate:EUR/USD/mid"]
    assert Decimal(bounds["min"]) > Decimal("2")
    assert Decimal(bounds["max"]) < Decimal("3")


def test_every_generated_value_is_inside_its_declared_range(generator, clock, record):
    """The bounds must admit the generator they describe. If they did not, the
    first real cycle would quarantine everything — the defect this check is
    meant to catch would be indistinguishable from the check being wrong."""
    guard = PlausibilityGuard(record.plausibility)
    for _ in range(50):
        clock.advance_ms(2000)
        for event in generator.due():
            payload = event["payload"]
            subject = (payload["base_currency"], payload["quote_currency"],
                       payload["rate_type"])
            assert guard.check(event["event_type"], subject, payload["rate"]) is None
    assert guard.snapshot()["counters"] == {VALUE_OUT_OF_RANGE: 0, VALUE_JUMP: 0}
