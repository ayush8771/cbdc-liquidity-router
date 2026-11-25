"""Service lifecycle, readiness and the `/v1/latest` body (AD-1 §3.1).

Readiness is about the generator, not about having a value: before the first
event the service is ready and reports an empty list, which is what AD-1 §3.1
requires in place of `204` or `404`.
"""
from __future__ import annotations

from cbdc_ingestion import PROTOCOL_VERSION, SOURCE_ID
from cbdc_ingestion.clock import ManualClock, parse_timestamp
from cbdc_ingestion.service import IngestionService

from .conftest import SEED, START_MS


def test_a_new_service_is_not_ready():
    service = IngestionService(SEED, clock=ManualClock(START_MS), start_ms=START_MS)
    assert service.state == "starting"
    assert service.ready is False


def test_starting_makes_it_ready_and_stopping_makes_it_unready():
    service = IngestionService(SEED, clock=ManualClock(START_MS), start_ms=START_MS)
    service.start()
    assert (service.state, service.ready) == ("running", True)
    service.stop()
    assert (service.state, service.ready) == ("stopped", False)


def test_start_and_stop_are_idempotent():
    service = IngestionService(SEED, clock=ManualClock(START_MS), start_ms=START_MS)
    service.start().start()
    service.stop()
    service.stop()
    assert service.state == "stopped"


def test_the_context_manager_starts_and_stops():
    with IngestionService(SEED, clock=ManualClock(START_MS), start_ms=START_MS) as service:
        assert service.ready
    assert service.state == "stopped"


def test_the_empty_state_is_a_200_body_with_no_events(service):
    body = service.latest_response()
    assert body["events"] == []
    assert body["protocol_version"] == PROTOCOL_VERSION
    assert body["source_id"] == SOURCE_ID
    assert parse_timestamp(body["generated_at"]) == START_MS


def test_the_body_has_exactly_the_contract_members(service):
    assert set(service.latest_response()) == {
        "protocol_version", "instance_id", "source_id", "generated_at", "events"}


def test_instance_id_is_fresh_at_each_start():
    first = IngestionService(SEED, clock=ManualClock(START_MS), start_ms=START_MS)
    second = IngestionService(SEED, clock=ManualClock(START_MS), start_ms=START_MS)
    assert first.instance_id != second.instance_id


def test_ticking_fills_the_four_pairs_in_order(service, clock):
    clock.set_ms(START_MS + 1500)
    assert service.tick() == 4
    served = service.latest_response()["events"]
    assert [(e["payload"]["base_currency"], e["payload"]["quote_currency"]) for e in served] == [
        ("AED", "MXN"), ("EUR", "USD"), ("GBP", "PHP"), ("USD", "INR")]
    assert service.store.counters()["accepted"] == 4


def test_generated_at_follows_the_injected_clock(service, clock):
    clock.set_ms(START_MS + 4242)
    assert parse_timestamp(service.latest_response()["generated_at"]) == START_MS + 4242


def test_a_clock_moved_backwards_produces_nothing_and_keeps_the_current_values(service, clock):
    """AD-1 §3.4: a clock moved backwards must leave values ageing out safely.

    The generator's sequence only moves forward, so a backwards jump produces no
    event at all; the current values stand and simply grow older. The store's late
    and tie paths, which a repeated or out-of-order delivery would take, are
    covered in `test_store.py`.
    """
    clock.set_ms(START_MS + 10_000)
    service.tick()
    current = {key: service.store.latest_for(key)["event_id"] for key in ("AED/MXN", "USD/INR")}
    clock.set_ms(START_MS - 60_000)
    assert service.tick() == 0
    assert {key: service.store.latest_for(key)["event_id"] for key in current} == current
    assert service.store.counters()["accepted"] == 4


def test_the_withheld_log_states_the_reason_and_nothing_else(service, clock, caplog):
    """AD-1 §3.4: the reason and, if well formed, the `event_id`. No payload.

    The log is also rate-limited, so a fault that repeats every tick cannot fill a
    disk: one line per reason per `LOG_INTERVAL_MS`.
    """
    import logging

    from cbdc_ingestion.envelope import CLOCK_TOLERANCE_MS, build_fx_event, fx_payload
    from cbdc_ingestion.service import LOG_INTERVAL_MS

    caplog.set_level(logging.WARNING, logger="cbdc_ingestion.service")
    quarantined = build_fx_event(seed=SEED, sequence=1, payload=fx_payload("USD", "INR", "1.234500"),
                                 retrieved_at_ms=START_MS,
                                 source_timestamp_ms=START_MS + CLOCK_TOLERANCE_MS + 1)
    for _ in range(5):
        service._log_withheld(quarantined)
    lines = [r.getMessage() for r in caplog.records if "event withheld" in r.getMessage()]
    assert len(lines) == 1, "a repeating fault must not fill the log"
    assert "FUTURE_SOURCE_TIMESTAMP" in lines[0]
    assert quarantined["event_id"] in lines[0]
    assert "1.234500" not in lines[0] and "USD" not in lines[0]

    clock.advance_ms(LOG_INTERVAL_MS)
    service._log_withheld(quarantined)
    assert len([r for r in caplog.records if "event withheld" in r.getMessage()]) == 2


def test_the_loop_survives_a_failing_tick():
    """A defect in one tick must not stop the component dead (`service._loop`)."""
    import threading

    service = IngestionService(SEED, clock=ManualClock(START_MS), start_ms=START_MS)
    calls = []
    reached_twice = threading.Event()

    def boom(*_args, **_kwargs):
        calls.append(1)
        if len(calls) >= 2:
            reached_twice.set()
        raise RuntimeError("deliberate")

    service.generator.due = boom
    service.start()
    try:
        assert reached_twice.wait(timeout=5.0), "the loop stopped after the first failure"
        assert service.ready
    finally:
        service.stop()
