"""Acceptance criterion 6: the internal status machine (A-7), **in process only**.

Both outage criteria **independently**; recovery on one successful item;
`failed_permanent` **never retries**; `down` and `stopped` map to `outage`
(AD-5 v0.8 §9.2, §9.3).

**And the internal state is never serialized.** `GET /v1/latest` still conforms
to `ingestion-latest.v1.schema.json` with `additionalProperties: false`, so no
status field appears, and Express's poller-derived `source.status` is
unaffected.

**The two failure modes are asserted apart** (§4.3): an adapter in
`failed_permanent` while the service runs leaves `/v1/latest` answering **200**
with its last-held value, and the existing **`503 NOT_READY`** stays reachable
only when the service or generator is not running. An adapter fault must never
produce it.
"""
from __future__ import annotations

import json

import pytest

from cbdc_ingestion.adapters.faults import AdapterFault, FaultClass
from cbdc_ingestion.clock import ManualClock
from cbdc_ingestion.http_api import ERRORS
from cbdc_ingestion.service import IngestionService
from cbdc_ingestion.status import (
    INTERNAL_STATES,
    OUTAGE_CONSECUTIVE_FAILURES,
    OUTAGE_SILENCE_MULTIPLE,
    PUBLISHED_MAPPING,
    PUBLISHED_STATUSES,
    SourceStatus,
    published_status,
)

from .conftest import CONTRACTS, SEED, START_MS

INTERVAL_MS = 2000
ADAPTER_SOURCE_ID = "synthetic.fx"


@pytest.fixture
def status() -> SourceStatus:
    return SourceStatus("synthetic.fx", expected_interval_ms=INTERVAL_MS, now_ms=START_MS)


# ------------------------------------------------------------- the state set
def test_a_new_source_is_starting(status):
    assert status.state == "starting"
    assert status.published == "starting"


def test_one_successful_item_leaves_starting(status):
    assert status.record_success(START_MS) == "ok"


# ----------------------------------- the two outage criteria, INDEPENDENTLY
def test_consecutive_failures_reach_outage(status):
    """Criterion one, on its own: no silence is involved."""
    status.record_success(START_MS)
    for _ in range(OUTAGE_CONSECUTIVE_FAILURES - 1):
        assert status.record_failure(START_MS) == "ok"
    assert status.record_failure(START_MS) == "outage"


def test_the_silence_window_reaches_outage_with_no_failure_at_all(status):
    """Criterion two, on its own — and why the two-criteria form is required.

    A silent subscription produces **no failures**, so a failure count alone
    would never fire. This case records zero failures and still reaches outage.
    """
    status.record_success(START_MS)
    assert status.snapshot()["consecutive_failures"] == 0
    assert status.tick(START_MS + status.silence_window_ms - 1) == "ok"
    assert status.tick(START_MS + status.silence_window_ms) == "outage"
    assert status.snapshot()["consecutive_failures"] == 0, "no failure was reported"


def test_the_silence_window_is_three_expected_intervals(status):
    assert status.silence_window_ms == INTERVAL_MS * OUTAGE_SILENCE_MULTIPLE == 6000


def test_a_source_silent_from_the_start_reaches_outage(status):
    """A source that never produced a first item is silent too."""
    assert status.tick(START_MS + status.silence_window_ms) == "outage"


def test_recovery_on_one_successful_item(status):
    status.record_success(START_MS)
    status.tick(START_MS + status.silence_window_ms)
    assert status.state == "outage"
    assert status.record_success(START_MS + 10_000) == "ok"


# --------------------------------------------------- down never self-heals
def test_a_permanent_fault_reaches_down(status):
    status.record_success(START_MS)
    assert status.record_failure(START_MS, permanent=True) == "down"


def test_down_is_not_left_by_a_successful_item(status):
    """§9.2: an operator action only. It never self-heals."""
    status.record_failure(START_MS, permanent=True)
    assert status.record_success(START_MS + 10_000) == "down"


def test_down_is_not_left_by_time(status):
    status.record_failure(START_MS, permanent=True)
    assert status.tick(START_MS + 10 * status.silence_window_ms) == "down"


def test_down_is_not_overwritten_by_a_further_recoverable_failure(status):
    status.record_failure(START_MS, permanent=True)
    assert status.record_failure(START_MS + 1) == "down"


# ------------------------------------------------- §9.3's mapping, exactly
def test_the_published_set_is_the_approved_three(status):
    assert PUBLISHED_STATUSES == ("starting", "ok", "outage")


@pytest.mark.parametrize("internal, expected", [
    ("starting", "starting"), ("ok", "ok"), ("outage", "outage"),
    ("down", "outage"), ("stopping", "outage"), ("stopped", "outage"),
])
def test_the_mapping_matches_ad5_9_3(internal, expected):
    assert published_status(internal) == expected


def test_no_internal_state_escapes_as_a_fourth_wire_value():
    """A fourth value would fault every open stream (AD-1 §3.3.3)."""
    assert set(PUBLISHED_MAPPING) == set(INTERNAL_STATES)
    assert set(PUBLISHED_MAPPING.values()) <= set(PUBLISHED_STATUSES)
    assert "down" not in PUBLISHED_STATUSES


def test_the_wire_enum_is_still_the_approved_three_values():
    """Asserted against the committed contract, not against our own constant."""
    schema = json.loads(
        (CONTRACTS / "events" / "stream-message.v1.schema.json").read_text(encoding="utf-8"))
    blob = json.dumps(schema)
    assert '"starting"' in blob and '"ok"' in blob and '"outage"' in blob
    assert '"down"' not in blob, "down must never appear in the wire contract"


def test_an_unknown_internal_state_raises_rather_than_inventing_a_value():
    with pytest.raises(ValueError):
        published_status("something_else")


# --------------------------------- the state reaches only a label and a log
def test_the_state_is_exposed_as_a_metric_label_and_a_log_field(status):
    """The two places §9.2 permits, and nothing that looks like a wire value."""
    assert status.as_metric_labels() == {"source_id": "synthetic.fx", "state": "starting"}
    assert "internal_state=starting" in status.as_log_field()


def test_the_latest_response_carries_no_status_field():
    """Criterion 6: the internal state is **never serialized**."""
    clock = ManualClock(START_MS)
    service = IngestionService(SEED, clock=clock, start_ms=START_MS,
                               sources=(ADAPTER_SOURCE_ID,))
    service.start(run_loop=False)
    try:
        clock.advance_ms(5000)
        service.tick()
        body = service.latest_response()
    finally:
        service.stop()
    # Structural, not a substring search: `validation.status` is a legitimate
    # envelope field, and the claim is that no *source* status is published.
    assert set(body) == {"protocol_version", "instance_id", "source_id",
                         "generated_at", "events"}
    assert "status" not in body
    for event in body["events"]:
        assert "status" not in event
        assert set(event["source"]) == {"source_id", "transport", "source_url",
                                        "gate3_decision_ref"}
        assert set(event["validation"]) == {"status", "reasons"}, (
            "the only `status` in the body is the envelope's own validation verdict")
    for internal in INTERNAL_STATES:
        if internal not in PUBLISHED_STATUSES:
            assert internal not in json.dumps(body)


def test_the_latest_body_still_conforms_with_an_adapter_in_down():
    """A failed adapter does not change the response **shape**."""
    jsonschema = pytest.importorskip("jsonschema")
    referencing = pytest.importorskip("referencing")

    clock = ManualClock(START_MS)
    service = IngestionService(SEED, clock=clock, start_ms=START_MS,
                               sources=(ADAPTER_SOURCE_ID,))
    service.start(run_loop=False)
    try:
        clock.advance_ms(5000)
        service.tick()
        adapter = service._adapters[0][0]
        adapter._record_fault(AdapterFault(FaultClass.AUTH_FAILURE, "injected"))
        _, pipeline = service._pipelines[0]
        pipeline.status.record_failure(clock.now_ms(), permanent=True)
        assert adapter.state == "failed_permanent"
        assert pipeline.status.state == "down"
        body = service.latest_response()
    finally:
        service.stop()

    envelope_schema = json.loads(
        (CONTRACTS / "events" / "event-envelope.v1.schema.json").read_text(encoding="utf-8"))
    latest_schema = json.loads(
        (CONTRACTS / "events" / "ingestion-latest.v1.schema.json").read_text(encoding="utf-8"))
    registry = referencing.Registry().with_resource(
        envelope_schema["$id"], referencing.Resource.from_contents(envelope_schema))
    jsonschema.Draft202012Validator(latest_schema, registry=registry).validate(body)


# ----------------------------- the two failure modes, asserted APART (§4.3)
def test_an_adapter_in_failed_permanent_leaves_the_service_answering_200():
    """Mode one: the adapter failed, the service did not."""
    clock = ManualClock(START_MS)
    service = IngestionService(SEED, clock=clock, start_ms=START_MS,
                               sources=(ADAPTER_SOURCE_ID,))
    service.start(run_loop=False)
    try:
        clock.advance_ms(5000)
        service.tick()
        adapter = service._adapters[0][0]
        adapter._record_fault(AdapterFault(FaultClass.AUTH_FAILURE, "injected"))
        assert adapter.state == "failed_permanent"
        assert service.ready, "an adapter fault must never make the service unready"
        assert service.latest_response()["events"], "the last-held value is still served"
    finally:
        service.stop()


def test_503_not_ready_stays_reachable_only_when_the_service_is_not_running():
    """Mode two: existing, approved D-24 behaviour, unchanged."""
    clock = ManualClock(START_MS)
    service = IngestionService(SEED, clock=clock, start_ms=START_MS,
                               sources=(ADAPTER_SOURCE_ID,))
    service.start(run_loop=False)
    clock.advance_ms(5000)
    service.tick()
    assert service.ready
    service.stop()
    assert not service.ready, "a stopped service is what reaches 503 NOT_READY"
    assert "NOT_READY" in ERRORS


def test_the_internal_statuses_accessor_is_not_a_wire_body():
    """It exists for a log field and a metric label, which is all §9.2 allows."""
    clock = ManualClock(START_MS)
    service = IngestionService(SEED, clock=clock, start_ms=START_MS,
                               sources=(ADAPTER_SOURCE_ID,))
    service.start(run_loop=False)
    try:
        clock.advance_ms(5000)
        service.tick()
        statuses = service.internal_statuses()
        assert statuses[ADAPTER_SOURCE_ID]["state"] == "ok"
        # It is not reachable from the response body.
        assert "state" not in service.latest_response()
    finally:
        service.stop()


def test_the_default_d24_path_has_no_internal_status_machine():
    """D-24 preservation: no status object is created when none is selected."""
    clock = ManualClock(START_MS)
    service = IngestionService(SEED, clock=clock, start_ms=START_MS)
    service.start(run_loop=False)
    try:
        clock.advance_ms(5000)
        service.tick()
        assert service.internal_statuses() == {}
    finally:
        service.stop()
