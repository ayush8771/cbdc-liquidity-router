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
from cbdc_ingestion.adapters.registry import SOURCES_PATH, load_registry
from cbdc_ingestion.adapters.synthetic_fx import SyntheticFxAdapter
from cbdc_ingestion.clock import ManualClock
from cbdc_ingestion.generator import FxGenerator, rate_for
from cbdc_ingestion.pairs import PAIRS
from cbdc_ingestion.pipeline import SOURCE_ID_UNRESOLVED
from cbdc_ingestion.service import IngestionService
from cbdc_ingestion.settings import from_environment
from cbdc_ingestion.sink import CHANNELS, ServiceSink

from .adapter_cases import make_context
from .conftest import CONTRACTS, SEED, START_MS

ADAPTER_SOURCE_ID = "synthetic.fx"


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


def test_the_adapter_path_publishes_under_the_shared_source_id():
    """Option B: the adapter path now runs, under `synthetic.fx`.

    The owner's decision of 27 November 2026 permits the generator and the
    adapter to share the `source_id` **provided they are mutually exclusive**.
    `envelope.py` is unchanged, so the envelope's `source.source_id` and the
    record that selected it agree by construction.
    """
    clock = ManualClock(START_MS)
    service = IngestionService(SEED, clock=clock, start_ms=START_MS,
                               sources=(ADAPTER_SOURCE_ID,))
    service.start(run_loop=False)
    try:
        clock.advance_ms(5000)
        assert service.tick() == 4
        adapter, record, _seed = service._adapters[0]
        assert adapter.state == "running"
        assert adapter.last_fault is None
        events = service.store.events()
        assert len(events) == 4
        for event in events:
            assert event["source"]["source_id"] == record.source_id == "synthetic.fx"
            assert event["provenance_class"] == "synthetic"
            assert event["usage"] == "display_only"
    finally:
        service.stop()


def test_the_adapter_path_uses_its_allocated_seed_not_the_generator_s():
    """The two configurations are told apart by seed, which IS a C-1 input.

    `source_id` is absent from the derivation, so it cannot distinguish them;
    the allocated seed can, and does.
    """
    clock = ManualClock(START_MS)
    service = IngestionService(SEED, clock=clock, start_ms=START_MS,
                               sources=(ADAPTER_SOURCE_ID,))
    service.start(run_loop=False)
    try:
        clock.advance_ms(5000)
        service.tick()
        allocated = load_registry().allocation_for(ADAPTER_SOURCE_ID).seed
        for event in service.store.events():
            assert event["synthetic"]["seed"] == allocated != SEED
    finally:
        service.stop()


def test_a_record_naming_another_source_id_still_refuses_by_name():
    """The agreement check survives the decision.

    Option B settled `synthetic.fx`; it did not authorize an `envelope.py`
    change. A record naming anything else is still a **permanent**
    `contract_violation`, because the builder cannot write another value.
    """
    from cbdc_ingestion.adapters.registry import parse_record
    from cbdc_ingestion.pipeline import build_envelope
    from cbdc_ingestion.adapters.faults import AdapterFault

    shipped = json.loads(SOURCES_PATH.read_text(encoding="utf-8"))["sources"][0]
    record = parse_record({**shipped, "source_id": "synthetic.fx.elsewhere"})

    adapter = SyntheticFxAdapter(record.source_id, 20261127)
    context = make_context(adapter, clock=ManualClock(START_MS))
    adapter.start(context)
    context.clock.advance_ms(2500)
    observation = adapter.produce()[0]
    with pytest.raises(AdapterFault) as info:
        build_envelope(record, observation, seed=20261127, retrieved_at_ms=START_MS)
    assert info.value.fault_class is FaultClass.CONTRACT_VIOLATION
    assert info.value.reason == SOURCE_ID_UNRESOLVED


def test_a_failed_adapter_does_not_make_the_service_unready():
    """Criterion 6's distinction: an adapter fault must never produce a 503.

    `failed_permanent` on an adapter leaves the service running and
    `/v1/latest` answering 200 with its last-held value. Only the service or
    generator not running reaches `503 NOT_READY`, which is existing, approved
    D-24 behaviour and is unchanged.
    """
    from cbdc_ingestion.adapters.faults import AdapterFault

    clock = ManualClock(START_MS)
    service = IngestionService(SEED, clock=clock, start_ms=START_MS,
                               sources=(ADAPTER_SOURCE_ID,))
    service.start(run_loop=False)
    try:
        clock.advance_ms(5000)
        service.tick()
        assert service.latest_response()["events"], "values were served first"
        adapter = service._adapters[0][0]
        adapter._record_fault(AdapterFault(FaultClass.AUTH_FAILURE, "injected_unreachable"))
        assert adapter.state == "failed_permanent"
        clock.advance_ms(5000)
        service.tick()
        assert service.ready, "an adapter fault must not make the service unready"
        assert service.latest_response()["events"], "the last-held values are still served"
    finally:
        service.stop()


def test_the_adapter_path_conforms_to_the_UNCHANGED_approved_contracts():
    """The assertion Option B rests on, and the reason no contract moved.

    The `/v1/latest` body pins `source_id` to `{"const": "synthetic.fx"}` and
    is untouched by rule (§7.3, §4.3). Because the adapter publishes under that
    same `source_id`, the body validates against the **unchanged** schema, and
    the envelopes validate against the **unchanged** envelope schema. Had the
    record kept `synthetic.fx.adapter`, both would have failed — which is what
    made the alternative a multi-contract change across three owners.
    """
    jsonschema = pytest.importorskip("jsonschema")
    referencing = pytest.importorskip("referencing")

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

    envelope_schema = json.loads(
        (CONTRACTS / "events" / "event-envelope.v1.schema.json").read_text(encoding="utf-8"))
    latest_schema = json.loads(
        (CONTRACTS / "events" / "ingestion-latest.v1.schema.json").read_text(encoding="utf-8"))
    assert latest_schema["$defs"]["success"]["properties"]["source_id"] == {
        "const": "synthetic.fx"}, "the wrapper's const is the constraint Option B satisfies"

    registry = referencing.Registry().with_resource(
        envelope_schema["$id"], referencing.Resource.from_contents(envelope_schema))
    jsonschema.Draft202012Validator(latest_schema, registry=registry).validate(body)

    # And the component's own strict validator, also unchanged, accepts them.
    from cbdc_ingestion.validation import validate_fx_envelope

    assert body["events"]
    for event in body["events"]:
        validate_fx_envelope(event)


# ------------------------------------------- the owner's mutual-exclusivity rule
def test_selecting_a_record_replaces_the_generator():
    """Only one generator configuration is active for `synthetic.fx` at a time.

    The events carry the **allocated** seed, never the env-configured one, which
    is the observable proof that the generator did not also run.
    """
    clock = ManualClock(START_MS)
    service = IngestionService(SEED, clock=clock, start_ms=START_MS,
                               sources=(ADAPTER_SOURCE_ID,))
    service.start(run_loop=False)
    try:
        clock.advance_ms(5000)
        service.tick()
        seeds = {e["synthetic"]["seed"] for e in service.store.events()}
        assert seeds == {load_registry().allocation_for(ADAPTER_SOURCE_ID).seed}
        assert SEED not in seeds, "the generator must not run beside the adapter"
        # The generator's own counters never moved: it was never driven.
        assert service.generator._next_sequence == {p.key: 1 for p in PAIRS}
    finally:
        service.stop()


def test_two_selected_records_sharing_a_source_id_are_a_startup_failure():
    """Enforced, not trusted: the exclusivity rule is a refusal."""
    from cbdc_ingestion.adapters.registry import RegistryInvalid

    service = IngestionService(SEED, clock=ManualClock(START_MS), start_ms=START_MS,
                               sources=(ADAPTER_SOURCE_ID, ADAPTER_SOURCE_ID))
    with pytest.raises(RegistryInvalid, match="one generator configuration"):
        service.start(run_loop=False)


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
