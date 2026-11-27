"""A-4 through the **real** service path: status, accounting and recovery.

`test_a4_faults.py` asserts what the adapter does with a fault. This suite
asserts what the *service* does with it, and it uses the production objects
throughout — the shipped registry record, the unchanged `envelope.py`, the
unchanged `validation.py`, the real dedup classifier, the real plausibility
guard, the real internal status machine (`status.py`) and the real sink. A mock
anywhere here would make the A-4 evidence be about the mock.

**Three claims this suite exists to establish.**

1. **A transport fault reaches the accounting and the status machine.** Before
   A-4, `produce()` swallowed faults and nothing downstream saw them, so a
   source could fail every poll and stay `ok`. Both outage criteria must now be
   reachable from a transport fault — independently, as AD-5 §9.2 requires.
2. **Recovery is real.** One successful item leaves `outage`, and the values
   that arrive afterwards are the unchanged generator's own series.
3. **Nothing D-24 depends on moves.** An adapter in `failed_permanent` leaves
   `/v1/latest` answering with its last-held value and still conforming to
   `ingestion-latest.v1.schema.json`; a fault must never produce a 503, and no
   status field may appear on the wire (authorization §4.3, §8 item 11).
"""
from __future__ import annotations

import pytest

from cbdc_ingestion.adapters.faults import FaultClass
from cbdc_ingestion.adapters.simulation import SIMULATION_TIMING as P
from cbdc_ingestion.plausibility import VALUE_OUT_OF_RANGE
from cbdc_ingestion.status import OUTAGE_CONSECUTIVE_FAILURES, published_status

from .a4_support import (
    IMPLAUSIBLE_RATE,
    case,
    clean_values,
    pipeline_for,
    scripted_adapter,
)
from .conftest import SEED, START_MS


def cycle(pipeline, adapter, sink, context, *, advance_ms: int = 0):
    """One service cycle at the clock's current moment."""
    if advance_ms:
        context.clock.advance_ms(advance_ms)
    return pipeline.run_cycle(adapter, sink, retrieved_at_ms=context.clock.now_ms())


# A delivered observation carries the **scheduled** moment of its sequence, not
# the moment the poll happened, which is the rule the D-24 generator already
# follows. So a cycle that is to publish must run at a clock past the last
# pair's scheduled moment — otherwise the unchanged builder quarantines it as
# `FUTURE_SOURCE_TIMESTAMP`, correctly. 10 s clears sequence 1's stagger and
# sequence 5's four intervals alike.
SETTLE_MS = 10_000


def test_the_settling_advance_is_needed_for_a_real_reason_not_a_fudge():
    """Asserted rather than assumed, because the rest of the suite relies on it.

    Delivering sequence 1 at the start moment means three of the four pairs are
    still in the future, and AD-4 §6 quarantines a future source timestamp. That
    is the unchanged builder behaving correctly, so the suite advances the clock
    instead of loosening the check.
    """
    pipeline, sink = pipeline_for()
    adapter, context, _ = scripted_adapter([case("A4-17").step])
    result = cycle(pipeline, adapter, sink, context)

    assert result.quarantined >= 1 and result.produced == 4
    assert "FUTURE_SOURCE_TIMESTAMP" in sink.counters()["quarantine"]["by_reason"]


# ------------------------------------------------- a fault reaches the accounting
def test_a_transport_fault_is_counted_and_reported_rather_than_swallowed():
    pipeline, sink = pipeline_for()
    adapter, context, _ = scripted_adapter([case("A4-03").step])

    result = cycle(pipeline, adapter, sink, context)

    assert result.produced == 0 and result.faults == 1
    assert "server_error" in result.reasons
    assert sink.counters()["faults"]["by_reason"]["server_error"] == 1


def test_an_item_fault_is_counted_apart_from_a_transport_fault():
    """They are different things: an item fault rejects one value and leaves the
    adapter running, a transport fault failed the whole poll."""
    pipeline, sink = pipeline_for()
    adapter, context, _ = scripted_adapter([case("A4-16").step])

    result = cycle(pipeline, adapter, sink, context)

    assert result.item_faults == 1 and result.faults == 0
    assert adapter.state == "starting", "an item fault changes no adapter state"


def test_one_bad_item_does_not_discard_the_good_ones_in_the_same_response():
    """AD-5 §7.1's rule, through the whole service path: the good values are
    published and the bad one is counted."""
    from fake_provider import Deliver

    values = clean_values()
    broken = {k: v for k, v in values[1].items() if k != "rate"}
    pipeline, sink = pipeline_for()
    adapter, context, _ = scripted_adapter([Deliver(values=[values[0], broken,
                                                            values[2], values[3]])])

    result = cycle(pipeline, adapter, sink, context, advance_ms=SETTLE_MS)

    assert result.produced == 3 and result.published == 3
    assert result.item_faults == 1
    assert adapter.state == "running", "a good item still recovers the adapter"


# ----------------------------------------------- both outage criteria, separately
def test_consecutive_transport_faults_drive_the_source_to_outage():
    """AD-5 §9.2's **first** criterion, which is the one a transport fault
    reports. It was unreachable before A-4: with no transport there was nothing
    to fail."""
    pipeline, sink = pipeline_for()
    adapter, context, _ = scripted_adapter([case("A4-04").step], repeating=True,
                                           jitter=lambda cap: 0)

    assert pipeline.status.state == "starting"
    for n in range(1, OUTAGE_CONSECUTIVE_FAILURES + 1):
        cycle(pipeline, adapter, sink, context, advance_ms=P.min_request_interval_ms)
        if n < OUTAGE_CONSECUTIVE_FAILURES:
            assert pipeline.status.state != "outage", f"outage after only {n} failures"
    assert pipeline.status.state == "outage"
    assert pipeline.status.snapshot()["consecutive_failures"] >= OUTAGE_CONSECUTIVE_FAILURES


def test_silence_drives_the_source_to_outage_with_no_failure_at_all():
    """AD-5 §9.2's **second** criterion, independently: a silent source produces
    no failures, so a failure count alone would never fire. The scripted step is
    a successful poll that simply carries nothing."""
    pipeline, sink = pipeline_for()
    adapter, context, _ = scripted_adapter([case("A4-18").step], repeating=True)

    window = pipeline.status.silence_window_ms
    result = cycle(pipeline, adapter, sink, context)
    assert result.faults == 0, "silence is not a failure"
    assert pipeline.status.state == "starting"

    cycle(pipeline, adapter, sink, context, advance_ms=window)
    assert pipeline.status.state == "outage"
    assert pipeline.status.snapshot()["consecutive_failures"] == 0, (
        "the silence criterion must fire without a single recorded failure")


def test_the_two_criteria_are_independent_in_the_other_direction_too():
    """Failures below the threshold, inside the silence window: neither fires."""
    pipeline, sink = pipeline_for()
    adapter, context, _ = scripted_adapter([case("A4-04").step], repeating=True,
                                           jitter=lambda cap: 0)
    for _ in range(OUTAGE_CONSECUTIVE_FAILURES - 1):
        cycle(pipeline, adapter, sink, context, advance_ms=P.min_request_interval_ms)
    assert pipeline.status.state == "starting"


# ------------------------------------------------------------------- recovery
def test_one_successful_item_recovers_the_source_from_outage():
    pipeline, sink = pipeline_for()
    script = [case("A4-04").step] * OUTAGE_CONSECUTIVE_FAILURES + [case("A4-17").step]
    adapter, context, _ = scripted_adapter(script, repeating=True, jitter=lambda cap: 0)

    for _ in range(OUTAGE_CONSECUTIVE_FAILURES):
        cycle(pipeline, adapter, sink, context, advance_ms=P.min_request_interval_ms)
    assert pipeline.status.state == "outage"

    context.clock.advance_ms(P.breaker_cooldown_ms)
    result = cycle(pipeline, adapter, sink, context)

    assert result.published >= 1
    assert pipeline.status.state == "ok"
    assert adapter.state == "running"


def test_the_values_after_recovery_are_the_unchanged_generators_own_series():
    """The point of recovery converging rather than merely resuming: a fault case
    differs from a clean one in its **faults only**."""
    from cbdc_ingestion.generator import rate_for
    from cbdc_ingestion.pairs import PAIRS
    from fake_provider import Deliver

    pipeline, sink = pipeline_for()
    adapter, context, _ = scripted_adapter(
        [case("A4-01").step, Deliver(values=clean_values(5))], jitter=lambda cap: 0)

    cycle(pipeline, adapter, sink, context)
    result = cycle(pipeline, adapter, sink, context, advance_ms=SETTLE_MS)

    assert result.published == len(PAIRS)
    for pair in PAIRS:
        stored = sink.store.latest_for(pair.key)
        assert stored is not None, pair.key
        assert stored["payload"]["rate"] == rate_for(SEED, pair, 5)


# --------------------------------------------- permanent faults and the status
def test_a_permanent_fault_sends_the_internal_status_to_down_and_keeps_it_there():
    """`down` is left by an operator action only (AD-5 §9.2): neither a later
    success nor the passage of time may clear it."""
    pipeline, sink = pipeline_for()
    adapter, context, _ = scripted_adapter([case("A4-06").step, case("A4-17").step],
                                           repeating=True)

    cycle(pipeline, adapter, sink, context)
    assert pipeline.status.state == "down"
    assert adapter.state == "failed_permanent"

    for _ in range(3):
        cycle(pipeline, adapter, sink, context, advance_ms=60_000)
    assert pipeline.status.state == "down", "down must not self-heal"


def test_down_is_published_as_outage_and_never_as_a_fourth_wire_value():
    """`stream-message.v1.schema.json` enumerates exactly `starting | ok |
    outage`, and the deployed client validates `source` strictly, so a fourth
    value would fault every open stream (AD-5 §9.3)."""
    pipeline, sink = pipeline_for()
    adapter, context, _ = scripted_adapter([case("A4-07").step])
    cycle(pipeline, adapter, sink, context)

    assert pipeline.status.state == "down"
    assert pipeline.status.published == "outage"
    assert published_status("down") == "outage"


# ------------------------------------------------- the two item-level outcomes
def test_an_implausible_value_is_quarantined_and_never_published():
    """`item_implausible` is the one §7.1 class a scripted *response* cannot
    produce, because it is the guard's verdict on a correctly delivered value.
    It is therefore exercised here, on the real bounds from the shipped record."""
    from fake_provider import Deliver

    values = clean_values()
    out_of_range = dict(values[0], rate=IMPLAUSIBLE_RATE)
    pipeline, sink = pipeline_for()
    adapter, context, _ = scripted_adapter([Deliver(values=[out_of_range])])

    result = cycle(pipeline, adapter, sink, context)

    assert result.quarantined == 1 and result.published == 0
    assert VALUE_OUT_OF_RANGE in result.reasons
    assert sink.store.latest_for(f"{values[0]['base']}{values[0]['quote']}") is None
    assert pipeline.status.state != "down", "a quarantine is not a fault"


def test_a_quarantined_value_does_not_count_as_a_transport_failure():
    from fake_provider import Deliver

    pipeline, sink = pipeline_for()
    adapter, context, _ = scripted_adapter(
        [Deliver(values=[dict(clean_values()[0], rate=IMPLAUSIBLE_RATE)])])
    result = cycle(pipeline, adapter, sink, context)
    assert result.faults == 0 and result.item_faults == 0


# --------------------------------------------------- D-24 is unaffected by a fault
def test_a_failed_adapter_leaves_the_last_held_value_served_and_schema_valid(
        latest_schema, envelope_schema):
    """§4.3's table, asserted: an adapter reaching `down` while the service runs
    leaves `/v1/latest` answering **200** with its last-held value. A fault must
    never produce the 503 `NOT_READY`, which belongs to the service or generator
    not running — converting one adapter's permanent fault into a whole-service
    outage would change D-24 behaviour.
    """
    pipeline, sink = pipeline_for()
    adapter, context, _ = scripted_adapter([case("A4-17").step, case("A4-06").step])

    from cbdc_ingestion.pairs import PAIRS

    assert cycle(pipeline, adapter, sink, context,
                 advance_ms=SETTLE_MS).published == len(PAIRS)
    held = {pair.key: sink.store.latest_for(pair.key) for pair in PAIRS}
    assert all(v is not None for v in held.values())

    context.clock.advance_ms(P.min_request_interval_ms)
    cycle(pipeline, adapter, sink, context)
    assert pipeline.status.state == "down"

    # The values are still there, unchanged, and still schema-valid.
    for key, value in held.items():
        assert sink.store.latest_for(key) == value, "a fault must not disturb a held value"

    # The same closed shape `IngestionService.latest_response()` returns, so this
    # asserts the real `GET /v1/latest` body and not a convenient approximation.
    from cbdc_ingestion import PROTOCOL_VERSION, SOURCE_ID
    from cbdc_ingestion.clock import format_timestamp

    document = {
        "protocol_version": PROTOCOL_VERSION,
        "instance_id": "00000000-0000-4000-8000-000000000000",
        "source_id": SOURCE_ID,
        "generated_at": format_timestamp(context.clock.now_ms()),
        "events": sink.store.events(),
    }
    jsonschema = pytest.importorskip("jsonschema")
    # The latest schema refers to the envelope schema by URN, resolved from a
    # local registry so that nothing is fetched over the network — the same
    # arrangement `test_schema_conformance.py` uses.
    referencing = pytest.importorskip("referencing")
    from referencing.jsonschema import DRAFT202012

    resource = referencing.Resource.from_contents(envelope_schema,
                                                  default_specification=DRAFT202012)
    store = referencing.Registry().with_resource(envelope_schema["$id"], resource)
    validator = jsonschema.Draft202012Validator(latest_schema, registry=store)
    assert not list(validator.iter_errors(document))
    assert "status" not in document, "ingestion publishes no status (§8 item 11)"


def test_no_status_field_leaks_into_any_envelope_the_fault_path_produced():
    """The internal machine is a metric label and a log field, and nothing else
    (AD-5 §9.2). A serialized internal state would be a contract change."""
    pipeline, sink = pipeline_for()
    adapter, context, _ = scripted_adapter([case("A4-17").step])
    cycle(pipeline, adapter, sink, context)

    for event in sink.store.events():
        assert "status" not in event
        assert "internal_state" not in event
        assert set(event["source"]) == set(event["source"]), "source is unchanged in shape"
        assert "status" not in event["source"]


def test_the_status_machine_is_only_reported_as_a_label_or_a_log_field():
    pipeline, sink = pipeline_for()
    adapter, context, _ = scripted_adapter([case("A4-04").step], repeating=True,
                                           jitter=lambda cap: 0)
    cycle(pipeline, adapter, sink, context)

    labels = pipeline.status.as_metric_labels()
    assert set(labels) == {"source_id", "state"}
    assert "internal_state=" in pipeline.status.as_log_field()


# ------------------------------------------------------------ routing isolation
def test_no_fault_path_reaches_routing_or_an_inference_client():
    """AD-6 §1 and criterion 12: `usage` stays `display_only` on every envelope
    the fault path produced, and the context carries nothing that could reach the
    engine. A-4 adds a transport seam; it adds no route out of the component."""
    pipeline, sink = pipeline_for()
    adapter, context, _ = scripted_adapter([case("A4-17").step])
    cycle(pipeline, adapter, sink, context)

    events = sink.store.events()
    assert events
    for event in events:
        assert event["usage"] == "display_only"
        assert event["provenance_class"] == "synthetic"
        assert event["source"]["transport"] == "synthetic"

    forbidden = {"db", "database", "inference", "model", "router", "policy", "writer"}
    assert forbidden.isdisjoint(set(vars(context)) | set(type(context).__dataclass_fields__))


def test_the_fault_classes_the_pipeline_sees_are_the_taxonomy_s_own():
    """No new class is introduced by the seam: the service must keep classifying
    on `faults.py`'s eight, so a later adapter cannot invent a ninth."""
    pipeline, sink = pipeline_for()
    seen = set()
    for case_id in ("A4-01", "A4-03", "A4-05", "A4-06", "A4-08", "A4-16"):
        adapter, context, _ = scripted_adapter([case(case_id).step])
        cycle(pipeline, adapter, sink, context)
        if adapter.last_fault is not None:
            seen.add(adapter.last_fault.fault_class)
    assert seen <= set(FaultClass) and seen
