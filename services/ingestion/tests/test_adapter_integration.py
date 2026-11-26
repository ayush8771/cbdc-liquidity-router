"""The service-side integration of the adapter path (authorization §7.2).

Two things are asserted, and the first matters more than the second:

1. **The D-24 generator path is the default and is bit-identical.** With no
   source named, the service behaves exactly as it did: the registry and the
   allocation file are not read, the adapters package is not even imported by
   the default path, and the events are the same bytes.
2. The adapter path is wired, validated and startable **only when named**, and
   its one unresolved item — `pipeline.build_envelope`'s `source_id` refusal —
   fails **loudly and by name** rather than emitting a mislabelled envelope.

**What is deliberately not asserted here**, because it is not implemented:
AD5-Q1/AD5-Q8 deduplication and conflict classification (`dedup.py`, criteria 5
and 5a), the internal status machine (`status.py`, criterion 6) and the
plausibility bounds (criterion 16). Their suites do not exist yet, and this one
does not stand in for them.
"""
from __future__ import annotations

import json

import pytest

from cbdc_ingestion.adapters.faults import FaultClass
from cbdc_ingestion.adapters.registry import load_registry
from cbdc_ingestion.adapters.synthetic_fx import SyntheticFxAdapter
from cbdc_ingestion.clock import ManualClock
from cbdc_ingestion.generator import FxGenerator, rate_for
from cbdc_ingestion.pairs import PAIRS
from cbdc_ingestion.pipeline import SOURCE_ID_UNRESOLVED
from cbdc_ingestion.service import IngestionService
from cbdc_ingestion.settings import from_environment
from cbdc_ingestion.sink import CHANNELS, ServiceSink

from .adapter_cases import make_context
from .conftest import SEED, START_MS

ADAPTER_SOURCE_ID = "synthetic.fx.adapter"


# ------------------------------------------- 1. the D-24 default, bit-identical
def test_the_default_service_names_no_source():
    assert from_environment({}).sources == ()
    assert from_environment({}).uses_adapter_path is False
    assert IngestionService(SEED, clock=ManualClock(START_MS)).sources == ()


def test_the_default_path_produces_byte_identical_events():
    """The strongest form of the D-24 preservation claim."""
    clock = ManualClock(START_MS)
    service = IngestionService(SEED, clock=clock, start_ms=START_MS)
    service.start(run_loop=False)
    try:
        clock.advance_ms(5000)
        service.tick()
        produced = service.store.events()
    finally:
        service.stop()

    reference = FxGenerator(SEED, ManualClock(START_MS), start_ms=START_MS)
    expected = reference.due(START_MS + 5000)
    assert json.dumps(produced, sort_keys=True) == json.dumps(expected, sort_keys=True)


def test_the_default_path_starts_no_adapter():
    clock = ManualClock(START_MS)
    service = IngestionService(SEED, clock=clock, start_ms=START_MS)
    service.start(run_loop=False)
    try:
        assert service._adapters == []
        assert service._sink is None, "the default path builds no sink"
    finally:
        service.stop()


# --------------------------------------------- 2. the adapter path, when named
def test_an_unknown_source_id_is_a_startup_failure():
    from cbdc_ingestion.adapters.registry import RegistryInvalid

    service = IngestionService(SEED, clock=ManualClock(START_MS), start_ms=START_MS,
                               sources=("synthetic.not_a_source",))
    with pytest.raises(RegistryInvalid, match="no registry record"):
        service.start(run_loop=False)


def test_a_named_source_starts_its_adapter_and_validates_it():
    """Criteria 1, 2 and 8 together, through the service's own entry point."""
    clock = ManualClock(START_MS)
    service = IngestionService(SEED, clock=clock, start_ms=START_MS,
                               sources=(ADAPTER_SOURCE_ID,))
    service.start(run_loop=False)
    try:
        assert len(service._adapters) == 1
        adapter, record, seed = service._adapters[0]
        assert isinstance(adapter, SyntheticFxAdapter)
        assert record.source_id == ADAPTER_SOURCE_ID
        # The seed comes from the recorded allocation, never from the record and
        # never from CBDC_INGESTION_SEED (AD-12 §3.1 mitigation 1).
        assert seed == load_registry().allocation_for(ADAPTER_SOURCE_ID).seed
        assert seed != SEED
    finally:
        service.stop()


def test_the_adapter_path_refuses_by_name_rather_than_mislabelling_an_envelope():
    """The one unresolved item, asserted as a named refusal.

    `envelope.py` writes a constant `source.source_id` and is untouched by rule
    (§7.3), so the adapter path cannot yet emit an envelope carrying its own
    record's `source_id`. It refuses with a `contract_violation`, which is
    **permanent**: a configuration fault must not be retried forever.
    """
    clock = ManualClock(START_MS)
    service = IngestionService(SEED, clock=clock, start_ms=START_MS,
                               sources=(ADAPTER_SOURCE_ID,))
    service.start(run_loop=False)
    try:
        clock.advance_ms(5000)
        assert service.tick() == 4, "the D-24 generator still produces its four events"
        adapter, _record, _seed = service._adapters[0]
        assert adapter.state == "failed_permanent"
        assert adapter.last_fault.fault_class is FaultClass.CONTRACT_VIOLATION
        assert adapter.last_fault.reason == SOURCE_ID_UNRESOLVED
        assert service._sink.counters()["faults"]["total"] >= 1
    finally:
        service.stop()


def test_a_failed_adapter_does_not_make_the_service_unready():
    """Criterion 6's distinction: an adapter fault must never produce a 503.

    `failed_permanent` on an adapter leaves the service running and
    `/v1/latest` answering 200 with its last-held value. Only the service or
    generator not running reaches `503 NOT_READY`, which is existing, approved
    D-24 behaviour and is unchanged.
    """
    clock = ManualClock(START_MS)
    service = IngestionService(SEED, clock=clock, start_ms=START_MS,
                               sources=(ADAPTER_SOURCE_ID,))
    service.start(run_loop=False)
    try:
        clock.advance_ms(5000)
        service.tick()
        assert service._adapters[0][0].state == "failed_permanent"
        assert service.ready, "an adapter fault must not make the service unready"
        assert service.latest_response()["events"], "the last-held values are still served"
    finally:
        service.stop()


def test_stopping_the_service_stops_its_adapters():
    clock = ManualClock(START_MS)
    service = IngestionService(SEED, clock=clock, start_ms=START_MS,
                               sources=(ADAPTER_SOURCE_ID,))
    service.start(run_loop=False)
    adapter = service._adapters[0][0]
    service.stop()
    assert adapter.state == "stopped"
    service.stop()  # idempotent


# --------------------------------------------------------- the adapter's values
def test_the_adapter_reproduces_the_generator_s_values_for_the_same_seed():
    """The two paths call the same pure function, so they cannot drift."""
    adapter = SyntheticFxAdapter(ADAPTER_SOURCE_ID, SEED)
    context = make_context(adapter, clock=ManualClock(START_MS))
    adapter.start(context)
    context.clock.advance_ms(2500)
    observations = adapter.produce()
    assert len(observations) == len(PAIRS)
    for index, observation in enumerate(observations):
        pair = PAIRS[index]
        # Against the observation's own sequence: at t+2500 ms the earlier pairs
        # are already on their second observation, exactly as on the D-24 path.
        assert observation.payload["rate"] == rate_for(SEED, pair, observation.sequence)
        assert observation.subject == (pair.base, pair.quote, "mid")
        assert observation.source_timestamp_basis == "observed"

    # And the sequences are the ones the generator's own schedule gives.
    reference = FxGenerator(SEED, ManualClock(START_MS), start_ms=START_MS)
    expected = reference.due(START_MS + 2500)
    assert [o.sequence for o in observations] == [int(e["source_sequence"]) for e in expected]
    assert [o.payload["rate"] for o in observations] == [e["payload"]["rate"] for e in expected]


def test_the_adapter_preserves_decimal_strings_with_their_trailing_zeros():
    """AD-5 §4: no float round-trip; a trailing zero is significant to the hash."""
    adapter = SyntheticFxAdapter(ADAPTER_SOURCE_ID, SEED)
    context = make_context(adapter, clock=ManualClock(START_MS))
    adapter.start(context)
    context.clock.advance_ms(2500)
    for observation in adapter.produce():
        rate = observation.payload["rate"]
        assert isinstance(rate, str)
        assert len(rate.split(".")[1]) == 6, "all six decimal places survive"


def test_the_adapter_never_sets_supersedes():
    """AD5-Q10: a synthetic adapter publishes no corrections (§4.4)."""
    adapter = SyntheticFxAdapter(ADAPTER_SOURCE_ID, SEED)
    context = make_context(adapter, clock=ManualClock(START_MS))
    adapter.start(context)
    context.clock.advance_ms(2500)
    for observation in adapter.produce():
        assert "supersedes" not in observation.payload
    assert not hasattr(adapter, "supersedes")


def test_the_adapter_emits_no_bridge_state_value():
    """Criterion 12: no such event type exists (AD-6 §1)."""
    description = SyntheticFxAdapter(ADAPTER_SOURCE_ID, SEED).describe()
    assert description.event_types == ("fx_rate",)
    for event_type in description.event_types:
        assert "bridge" not in event_type and "liquidity" not in event_type


# ------------------------------------------------------------------- the sink
def test_the_sink_has_exactly_the_three_ad5_channels():
    assert CHANNELS == ("observations", "quarantine", "faults")


def test_an_unknown_sink_channel_is_an_error_not_a_silent_drop():
    """AD-5 §3.7: loss is counted, never silent."""
    with pytest.raises(ValueError, match="unknown sink channel"):
        ServiceSink().publish("somewhere_else", {})


def test_the_quarantine_and_fault_channels_retain_no_payload():
    """AD-1 §3.4: counters by reason, and no review queue."""
    sink = ServiceSink()
    sink.publish("quarantine", "FUTURE_SOURCE_TIMESTAMP")
    sink.publish("faults", "internal")
    counters = sink.counters()
    assert counters["quarantine"] == {"total": 1,
                                      "by_reason": {"FUTURE_SOURCE_TIMESTAMP": 1}}
    assert counters["faults"] == {"total": 1, "by_reason": {"internal": 1}}
    for channel in (sink.quarantine, sink.faults):
        assert not hasattr(channel, "items"), "a queue here would be the review queue AD-1 §3.4 forbids"
