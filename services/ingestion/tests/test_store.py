"""The bounded store and the AD-1 §3.4 acceptance rules.

AD-1 §3.4's table is written for Express as the consumer, and Express applies it
independently. Ingestion applies the part it owns: it serves the latest
**validated** envelope per pair, withholds quarantined ones, keeps counters by
reason, stores no payload beyond the four current events, and never lets an
older event replace a newer one.
"""
from __future__ import annotations

import copy

from cbdc_ingestion.clock import ManualClock
from cbdc_ingestion.envelope import CLOCK_TOLERANCE_MS, build_fx_event, fx_payload
from cbdc_ingestion.generator import FxGenerator
from cbdc_ingestion.pairs import PAIR_KEYS
from cbdc_ingestion.store import LatestStore

from .conftest import SEED, START_MS


def event(pair_key="USD/INR", sequence=1, moment_ms=START_MS, rate="1.234500", **kwargs):
    base, quote = pair_key.split("/")
    return build_fx_event(seed=SEED, sequence=sequence, payload=fx_payload(base, quote, rate),
                          retrieved_at_ms=moment_ms, **kwargs)


def test_an_empty_store_serves_nothing():
    store = LatestStore()
    assert store.events() == []
    assert len(store) == 0
    assert store.counters()["accepted"] == 0


def test_a_newer_event_becomes_current():
    store = LatestStore()
    assert store.apply(event(sequence=1, moment_ms=START_MS)) is True
    assert store.apply(event(sequence=2, moment_ms=START_MS + 2000)) is True
    assert store.latest_for("USD/INR")["source_sequence"] == "2"
    assert store.counters()["accepted"] == 2


def test_an_identical_redelivery_is_a_duplicate_not_an_update():
    store = LatestStore()
    first = event()
    store.apply(first)
    assert store.apply(copy.deepcopy(first)) is False
    assert store.counters()["duplicate"] == 1
    assert store.counters()["accepted"] == 1


def test_an_older_event_is_late_and_does_not_replace_the_current_one():
    store = LatestStore()
    store.apply(event(sequence=2, moment_ms=START_MS + 2000))
    assert store.apply(event(sequence=1, moment_ms=START_MS)) is False
    assert store.counters()["late"] == 1
    assert store.latest_for("USD/INR")["source_sequence"] == "2"


def test_an_event_at_the_same_moment_does_not_replace_the_current_one():
    """AD-1 §3.4: the first of a source-timestamp tie is kept."""
    store = LatestStore()
    store.apply(event(sequence=1, rate="1.111111"))
    assert store.apply(event(sequence=9, rate="2.222222")) is False
    assert store.latest_for("USD/INR")["payload"]["rate"] == "1.111111"
    assert store.counters()["late"] == 1


def test_a_quarantined_event_is_withheld_and_counted_by_reason():
    store = LatestStore()
    withheld = event(source_timestamp_ms=START_MS + CLOCK_TOLERANCE_MS + 1)
    assert store.apply(withheld) is False
    assert store.events() == []
    counters = store.counters()
    assert counters["quarantined"] == 1
    assert counters["quarantine_reasons"] == {"FUTURE_SOURCE_TIMESTAMP": 1}
    # Withheld means it is not the watermark either: a later valid event still applies.
    assert store.apply(event(sequence=2, moment_ms=START_MS + 2000)) is True


def test_an_invalid_event_is_rejected_and_leaves_no_trace():
    store = LatestStore()
    broken = event()
    broken["payload"]["rate"] = "9.999999"  # hash no longer matches
    assert store.apply(broken) is False
    assert store.events() == []
    assert store.counters()["rejected"] == 1


def test_a_pair_outside_the_allowlist_is_rejected():
    store = LatestStore()
    assert store.apply(event(pair_key="INR/USD")) is False
    assert store.counters()["rejected"] == 1


def test_state_is_bounded_at_four_events_however_long_it_runs():
    store = LatestStore()
    generator = FxGenerator(SEED, ManualClock(START_MS), start_ms=START_MS)
    for ms in range(0, 600_000, 250):  # ten simulated minutes
        for produced in generator.due(START_MS + ms):
            store.apply(produced)
    assert len(store) == 4
    assert store.counters()["accepted"] == 1200


def test_events_are_sorted_by_base_then_quote():
    store = LatestStore()
    generator = FxGenerator(SEED, ManualClock(START_MS), start_ms=START_MS)
    for produced in generator.due(START_MS + 1500):
        store.apply(produced)
    served = [f"{e['payload']['base_currency']}/{e['payload']['quote_currency']}" for e in store.events()]
    assert served == list(PAIR_KEYS) == ["AED/MXN", "EUR/USD", "GBP/PHP", "USD/INR"]


def test_a_partial_state_keeps_the_allowlist_order():
    store = LatestStore()
    store.apply(event(pair_key="USD/INR"))
    store.apply(event(pair_key="EUR/USD", rate="2.200000"))
    served = [f"{e['payload']['base_currency']}/{e['payload']['quote_currency']}" for e in store.events()]
    assert served == ["EUR/USD", "USD/INR"]
