"""The generator: determinism, schedule, provenance and bounded catch-up.

AD-1 §6 acceptance item 1: "The same seed, sequence and injected clock give
identical events; payloads and hashes do not depend on the clock. Every event
passes the AD-4 schema." The schema half is `test_schema_conformance.py`; the
rest is here.
"""
from __future__ import annotations

import pytest

from cbdc_ingestion import GENERATOR_VERSION, SOURCE_ID
from cbdc_ingestion.clock import ManualClock, parse_timestamp
from cbdc_ingestion.generator import (BASE_RATES, PAIR_INTERVAL_MS, PAIR_STAGGER_MS, FxGenerator,
                                      rate_for, scheduled_ms)
from cbdc_ingestion.pairs import PAIRS, RATE_TYPE
from cbdc_ingestion.validation import validate_fx_envelope

from .conftest import SEED, START_MS


# --------------------------------------------------------------- determinism
def test_same_seed_and_clock_give_byte_identical_events():
    first = FxGenerator(SEED, ManualClock(START_MS), start_ms=START_MS)
    second = FxGenerator(SEED, ManualClock(START_MS), start_ms=START_MS)
    for step in range(1, 9):
        now = START_MS + step * 500
        assert first.due(now) == second.due(now), f"divergence at +{step * 500} ms"


def test_payloads_and_hashes_do_not_depend_on_the_clock():
    """The same seed and sequence at a different wall-clock start.

    Only the timestamps and the derived `event_id` may differ; `payload` and
    `payload_sha256` must be identical (AD-1 §6 item 1).
    """
    early = FxGenerator(SEED, ManualClock(START_MS), start_ms=START_MS)
    late = FxGenerator(SEED, ManualClock(START_MS + 86_400_000), start_ms=START_MS + 86_400_000)
    a = early.due(START_MS + 2 * PAIR_INTERVAL_MS)
    b = late.due(START_MS + 86_400_000 + 2 * PAIR_INTERVAL_MS)
    assert [e["payload"] for e in a] == [e["payload"] for e in b]
    assert [e["payload_sha256"] for e in a] == [e["payload_sha256"] for e in b]
    assert [e["source_sequence"] for e in a] == [e["source_sequence"] for e in b]
    assert [e["event_id"] for e in a] != [e["event_id"] for e in b]


def test_a_different_seed_changes_the_rates():
    a = FxGenerator(SEED, ManualClock(START_MS), start_ms=START_MS).due(START_MS + 1500)
    b = FxGenerator(SEED + 1, ManualClock(START_MS), start_ms=START_MS).due(START_MS + 1500)
    assert [e["payload"]["rate"] for e in a] != [e["payload"]["rate"] for e in b]


def test_rate_for_is_a_pure_function():
    for pair in PAIRS:
        assert rate_for(SEED, pair, 7) == rate_for(SEED, pair, 7)
        assert rate_for(SEED, pair, 7) != rate_for(SEED, pair, 8)


def test_rejects_an_unusable_seed():
    for bad in (-1, 2 ** 53, True, "1", 1.0):
        with pytest.raises(ValueError):
            FxGenerator(bad, ManualClock(START_MS))


# ------------------------------------------------------------------ schedule
def test_the_four_pairs_are_staggered_by_500_ms(generator):
    """2 events/s: each pair every 2 s, staggered by 500 ms (AD-1 §3)."""
    emitted = []
    for step in range(8):  # 0 .. 3500 ms
        for event in generator.due(START_MS + step * 500):
            emitted.append((step * 500, event["payload"]["base_currency"],
                            event["payload"]["quote_currency"]))
    assert emitted == [
        (0, "AED", "MXN"), (500, "EUR", "USD"), (1000, "GBP", "PHP"), (1500, "USD", "INR"),
        (2000, "AED", "MXN"), (2500, "EUR", "USD"), (3000, "GBP", "PHP"), (3500, "USD", "INR")]


def test_two_events_per_second_over_a_minute(generator):
    total = sum(len(generator.due(START_MS + ms)) for ms in range(0, 60_000, 100))
    assert total == 120


def test_nothing_is_due_before_its_moment(generator):
    assert generator.due(START_MS - 1) == []
    assert len(generator.due(START_MS)) == 1
    assert generator.due(START_MS + 1) == []


def test_next_due_ms_names_the_earliest_pair(generator):
    assert generator.next_due_ms() == START_MS
    generator.due(START_MS)
    assert generator.next_due_ms() == START_MS + PAIR_STAGGER_MS


def test_timestamps_are_the_scheduled_moment_not_the_poll(generator):
    """A late poll must not make an observation look fresher than it is."""
    event = generator.due(START_MS + 9_000)[0]
    assert parse_timestamp(event["timestamps"]["source_timestamp"]) == START_MS + 8_000
    assert event["timestamps"]["retrieved_at"] == event["timestamps"]["source_timestamp"]
    assert event["timestamps"]["emitted_at"] == event["timestamps"]["source_timestamp"]


def test_a_clock_jump_skips_the_backlog_instead_of_replaying_it(generator):
    """Bounded work: at most one event per pair per call (AD-1 §3.4)."""
    events = generator.due(START_MS + 60_000)
    assert len(events) == 4
    # AED/MXN is due 31 times by +60 s and the three staggered pairs 30 times each.
    assert generator.skipped_ticks == 30 + 29 + 29 + 29
    # The emitted event is the newest due one, not the oldest.
    assert generator.due(START_MS + 60_000) == []


def test_a_very_large_clock_jump_is_cheap_and_still_bounded(generator):
    """Catch-up is arithmetic, not iterative: a year's jump costs one division."""
    events = generator.due(START_MS + 365 * 24 * 3_600_000)
    assert len(events) == 4
    assert generator.skipped_ticks > 15_000_000
    assert generator.due(START_MS + 365 * 24 * 3_600_000) == []


def test_event_ids_never_collide_across_pairs_and_sequences(generator):
    seen = set()
    for ms in range(0, 120_000, 250):
        for event in generator.due(START_MS + ms):
            assert event["event_id"] not in seen
            seen.add(event["event_id"])
    assert len(seen) == 240


# ------------------------------------------------- provenance and plausibility
def test_every_event_is_synthetic_display_only_and_valid(generator):
    events = [e for ms in range(0, 20_000, 250) for e in generator.due(START_MS + ms)]
    assert events
    for event in events:
        validate_fx_envelope(event)  # raises on any breach
        assert event["usage"] == "display_only"
        assert event["provenance_class"] == "synthetic"
        assert event["source"] == {"source_id": SOURCE_ID, "transport": "synthetic",
                                   "source_url": None, "gate3_decision_ref": None}
        assert event["synthetic"] == {"generator_version": GENERATOR_VERSION, "seed": SEED,
                                      "case_id": "normal"}
        assert event["validation"] == {"status": "validated", "reasons": []}
        assert event["payload"]["rate_type"] == RATE_TYPE


def test_rates_are_deliberately_unrealistic_and_bounded(generator):
    """AD-1 §3: no reader may mistake a generated rate for a market quote."""
    for ms in range(0, 40_000, 250):
        for event in generator.due(START_MS + ms):
            payload = event["payload"]
            base = BASE_RATES[f"{payload['base_currency']}/{payload['quote_currency']}"]
            rate = float(payload["rate"])
            assert abs(rate - float(base)) <= 0.01 + 1e-9
            assert 1.0 < rate < 4.0, "every base rate is a small multiple, unlike any real quote"
            assert len(payload["rate"].split(".")[1]) == 6


def test_case_id_reaches_the_envelope():
    generator = FxGenerator(SEED, ManualClock(START_MS), start_ms=START_MS, case_id="clock_back")
    assert generator.due(START_MS)[0]["synthetic"]["case_id"] == "clock_back"


def test_scheduled_ms_matches_the_documented_formula():
    for index, _pair in enumerate(PAIRS):
        for sequence in (1, 2, 10):
            assert scheduled_ms(START_MS, index, sequence) == (
                START_MS + index * PAIR_STAGGER_MS + (sequence - 1) * PAIR_INTERVAL_MS)
