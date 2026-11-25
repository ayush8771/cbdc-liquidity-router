"""Event identity across a process restart.

A restart keeps the seed (it is fixed configuration), resets every pair's
sequence to 1 and re-bases the 500 ms stagger on a new `start_ms`. The
within-run argument for collision-freedom — that `500i + 2000(n-1)` is distinct
per pair — therefore does not carry across restarts, and before the pair entered
the UUIDv5 name three of the four pairs collided at a 500 ms restart offset,
with different pairs and different rates sharing one `event_id`.

Under AD-1 §3.4 that is not cosmetic: Express rejects an event whose `event_id`
matches a current event with different content or another pair, so the affected
pairs' values would stall, pass `stale_after_ms` and then `unavailable_after_ms`,
and never recover while the offset held — and the offset is constant, so it
holds for the whole run.

These tests pin both halves of the fix: **no two events with different content
ever share an ID**, and **deterministic replay is unchanged** (the same seed,
sequence and injected clock still reproduce the same ID, which putting
`start_ms` or `instance_id` in the name would have destroyed).
"""
from __future__ import annotations

import pytest

from cbdc_ingestion.clock import ManualClock
from cbdc_ingestion.envelope import event_id_for, fx_payload
from cbdc_ingestion.generator import PAIR_INTERVAL_MS, PAIR_STAGGER_MS, FxGenerator
from cbdc_ingestion.pairs import PAIRS

from .conftest import SEED, START_MS

# The offsets that aligned one run's pair i with another run's pair j. 0 and 2000
# are the harmless ones (they realign a pair with itself, giving a true duplicate).
COLLIDING_OFFSETS_MS = (500, 1000, 1500)
ALL_OFFSETS_MS = (0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2500, 60_000)


def run(start_ms: int, span_ms: int = 8000, seed: int = SEED) -> list:
    """One generator run from `start_ms`, as a fresh process would do it."""
    generator = FxGenerator(seed, ManualClock(start_ms), start_ms=start_ms)
    return [event for ms in range(0, span_ms, 100) for event in generator.due(start_ms + ms)]


def identity_map(events: list) -> dict:
    """`event_id` -> the content it stands for: the pair, the sequence and the payload."""
    return {e["event_id"]: (e["payload"]["base_currency"], e["payload"]["quote_currency"],
                            e["source_sequence"], e["payload"]["rate"],
                            e["timestamps"]["source_timestamp"]) for e in events}


# ------------------------------------------------- no ID is reused for other content
@pytest.mark.parametrize("offset_ms", ALL_OFFSETS_MS)
def test_a_restart_never_gives_two_contents_one_id(offset_ms):
    """The regression. Every offset, including the three that used to collide."""
    before = run(START_MS)
    after = run(START_MS + offset_ms)
    assert before and after

    seen = {}
    for label, events in (("before", before), ("after", after)):
        for event in events:
            content = identity_map([event])[event["event_id"]]
            previous = seen.get(event["event_id"])
            if previous is not None:
                previous_label, previous_content = previous
                # A repeat is allowed only when it is the *same* observation: same
                # pair, same sequence, same rate, same source timestamp (AD-4 §2's
                # redelivery). Anything else is the defect this test exists for.
                assert previous_content == content, (
                    f"offset {offset_ms} ms: event_id {event['event_id']} stands for "
                    f"{previous_content} in run {previous_label} and {content} in run {label}")
            else:
                seen[event["event_id"]] = (label, content)


@pytest.mark.parametrize("offset_ms", COLLIDING_OFFSETS_MS)
def test_the_previously_colliding_offsets_now_share_no_id_at_all(offset_ms):
    """At these offsets the two runs' events differ in pair, so no ID may be shared.

    Before the fix, three of four pairs shared an ID here. The timestamps of the
    two runs do coincide, which is what made the old name collide, so this also
    shows the fix does not merely re-space the timestamps.
    """
    before, after = run(START_MS), run(START_MS + offset_ms)
    assert set(identity_map(before)) & set(identity_map(after)) == set()
    before_stamps = {e["timestamps"]["source_timestamp"] for e in before}
    after_stamps = {e["timestamps"]["source_timestamp"] for e in after}
    assert before_stamps & after_stamps, "the offset must still make timestamps coincide"


def test_a_whole_interval_restart_shares_a_timestamp_but_not_an_id():
    """A restart one whole interval later lands on the same pair, not the same event.

    Run B's sequence *m* falls at run A's sequence *m+1*: the pair and the source
    timestamp coincide, but the sequence differs, so the rate differs and the ID
    must differ too. It is therefore **not** AD-4 §2's redelivery.

    What Express sees is AD-1 §3.4's last conflict row — "same `source_timestamp`,
    different `event_id`: first kept; counted". One post-restart event per pair is
    dropped as a tie and the next one, 2 s later, is accepted. That is a single
    counted event, not a stall, and it is the documented behaviour of the approved
    ordering rules rather than a defect in this component.
    """
    before = {e["event_id"]: e for e in run(START_MS)}
    after = {e["event_id"]: e for e in run(START_MS + PAIR_INTERVAL_MS)}
    assert set(before) & set(after) == set(), "a different sequence must give a different ID"

    overlapping = {e["timestamps"]["source_timestamp"] for e in before.values()} & \
                  {e["timestamps"]["source_timestamp"] for e in after.values()}
    assert overlapping, "a whole-interval offset must still make timestamps coincide"
    for stamp in sorted(overlapping):
        a = next(e for e in before.values() if e["timestamps"]["source_timestamp"] == stamp)
        b = next(e for e in after.values() if e["timestamps"]["source_timestamp"] == stamp)
        assert a["payload"]["base_currency"] == b["payload"]["base_currency"]
        assert a["source_sequence"] != b["source_sequence"]
        assert a["event_id"] != b["event_id"]


def test_many_restarts_at_every_millisecond_offset_collide_on_nothing():
    """A sweep rather than named offsets, so no colliding offset can hide.

    Every restart offset from 0 to 2 000 ms at 50 ms steps, against the same first
    run: no `event_id` may ever stand for two different contents.
    """
    first = run(START_MS, span_ms=6000)
    baseline = identity_map(first)
    for offset_ms in range(0, 2001, 50):
        for event_id, content in identity_map(run(START_MS + offset_ms, span_ms=6000)).items():
            if event_id in baseline:
                assert baseline[event_id] == content, f"offset {offset_ms} ms"


# ----------------------------------------------------------- replay stays reproducible
def test_the_id_still_depends_only_on_seed_pair_sequence_and_clock():
    """Two processes given the same seed and the same injected clock agree exactly.

    This is AD-1 §6 item 1. It is what rules out `start_ms` or `instance_id` in the
    name: either would make the same replay produce different IDs.
    """
    assert [e["event_id"] for e in run(START_MS)] == [e["event_id"] for e in run(START_MS)]


def test_each_of_the_four_name_inputs_changes_the_id():
    stamp = "2025-11-25T00:00:00.000Z"
    base = event_id_for(SEED, "USD/INR", 1, stamp)
    assert base == event_id_for(SEED, "USD/INR", 1, stamp)
    assert base != event_id_for(SEED + 1, "USD/INR", 1, stamp)
    assert base != event_id_for(SEED, "EUR/USD", 1, stamp)
    assert base != event_id_for(SEED, "USD/INR", 2, stamp)
    assert base != event_id_for(SEED, "USD/INR", 1, "2025-11-25T00:00:00.001Z")


def test_the_id_matches_the_payload_pair():
    """The ID is derived from the payload, so the two cannot disagree."""
    from cbdc_ingestion.envelope import build_fx_event

    for pair in PAIRS:
        event = build_fx_event(seed=SEED, sequence=3,
                               payload=fx_payload(pair.base, pair.quote, "1.500000"),
                               retrieved_at_ms=START_MS)
        assert event["event_id"] == event_id_for(
            SEED, pair.key, 3, event["timestamps"]["source_timestamp"])


def test_the_four_pairs_of_one_tick_window_have_four_distinct_ids():
    """Belt and braces: the stagger is no longer the only thing separating them."""
    generator = FxGenerator(SEED, ManualClock(START_MS), start_ms=START_MS)
    ids = {e["event_id"] for ms in range(0, 2000, 100) for e in generator.due(START_MS + ms)}
    assert len(ids) == len(PAIRS)
    assert PAIR_STAGGER_MS * len(PAIRS) == PAIR_INTERVAL_MS, "the schedule this relies on"
