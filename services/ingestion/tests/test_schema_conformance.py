"""Generated events against the committed contracts.

AD-1 §6 item 1: "Every event passes the AD-4 schema." AD-1 §3.7 adds that both
languages must give the same verdict on each event fixture; this is the Python
side, and it is run two ways:

1. **always**, against the hand-written strict validator, which implements the
   schema's rules without a dependency (`validation.py`);
2. **when `jsonschema` is importable**, against
   `contracts/events/event-envelope.v1.schema.json` itself, which is what keeps
   the validator and the schema from drifting apart.

The committed schemas are DRAFT (AD-4 header, P-8): the repository check over
`contracts/events/` is Dev D's and does not exist yet, so these tests are
currently the only automated use of them.
"""
from __future__ import annotations

import pytest

from cbdc_ingestion.clock import ManualClock
from cbdc_ingestion.envelope import CLOCK_TOLERANCE_MS, build_fx_event, fx_payload
from cbdc_ingestion.generator import FxGenerator
from cbdc_ingestion.http_api import ERRORS
from cbdc_ingestion.service import IngestionService
from cbdc_ingestion.validation import validate_fx_envelope

from .conftest import SEED, START_MS


def sample_events(count_ms: int = 20_000) -> list:
    generator = FxGenerator(SEED, ManualClock(START_MS), start_ms=START_MS)
    return [event for ms in range(0, count_ms, 250) for event in generator.due(START_MS + ms)]


def envelope_validator(schema: dict):
    """A `jsonschema` validator for the envelope schema, or a skip."""
    jsonschema = pytest.importorskip("jsonschema")
    return jsonschema.Draft202012Validator(schema)


def test_the_strict_validator_accepts_every_generated_event():
    events = sample_events()
    assert len(events) == 40
    for event in events:
        validate_fx_envelope(event)


def test_every_generated_event_passes_the_committed_envelope_schema(envelope_schema):
    validator = envelope_validator(envelope_schema)
    for event in sample_events():
        errors = sorted(validator.iter_errors(event), key=str)
        assert not errors, errors[0].message if errors else ""


def test_a_quarantined_envelope_also_passes_the_schema(envelope_schema):
    """A quarantined event is a *valid envelope* that is withheld (AD-4 §6)."""
    validator = envelope_validator(envelope_schema)
    event = build_fx_event(seed=SEED, sequence=1, payload=fx_payload("USD", "INR", "1.234500"),
                           retrieved_at_ms=START_MS,
                           source_timestamp_ms=START_MS + CLOCK_TOLERANCE_MS + 1)
    assert not list(validator.iter_errors(event))
    assert event["validation"]["status"] == "quarantined"


def test_the_schema_rejects_what_the_strict_validator_rejects(envelope_schema):
    """The two must agree on the cases the schema can see.

    A rule that needs a clock, a registry or another event is AD-4 §6's, not the
    schema's, so only schema-visible breaches are compared here.
    """
    import copy

    validator = envelope_validator(envelope_schema)
    good = build_fx_event(seed=SEED, sequence=1, payload=fx_payload("USD", "INR", "1.234500"),
                          retrieved_at_ms=START_MS)
    breaches = [
        ("usage", lambda e: e.update(usage="engine_input")),
        ("schema_version", lambda e: e.update(schema_version="2.0")),
        ("synthetic markers", lambda e: e["source"].update(transport="poll")),
        ("synthetic block", lambda e: e.update(synthetic=None)),
        ("gate 3 on synthetic", lambda e: e["source"].update(gate3_decision_ref="GATE3-1")),
        ("closed envelope", lambda e: e.update(extra="x")),
        ("closed payload", lambda e: e["payload"].update(extra="x")),
        ("numeric rate", lambda e: e["payload"].update(rate=1.2345)),
        ("identical currencies", lambda e: e["payload"].update(quote_currency="USD")),
    ]
    for name, mutate in breaches:
        event = copy.deepcopy(good)
        mutate(event)
        schema_errors = list(validator.iter_errors(event))
        if name == "identical currencies":
            # AD-4 §6 puts this in validation, not the schema: the schema checks the
            # shape of a currency code, and `base != quote` is a validation rule.
            assert not schema_errors
            continue
        assert schema_errors, f"the schema should reject: {name}"


def test_the_latest_response_passes_the_ingestion_schema(latest_schema, envelope_schema):
    jsonschema = pytest.importorskip("jsonschema")
    # The ingestion schema refers to the envelope schema by its URN. The reference
    # is resolved from a local registry, so nothing is fetched over the network.
    referencing = pytest.importorskip("referencing")
    from referencing.jsonschema import DRAFT202012

    resource = referencing.Resource.from_contents(envelope_schema, default_specification=DRAFT202012)
    store = referencing.Registry().with_resource(envelope_schema["$id"], resource)
    validator = jsonschema.Draft202012Validator(latest_schema, registry=store)

    service = IngestionService(SEED, clock=ManualClock(START_MS),
                               start_ms=START_MS).start(run_loop=False)
    try:
        assert not list(validator.iter_errors(service.latest_response())), "the empty state must validate"
        service.tick(START_MS + 1500)
        body = service.latest_response()
        assert len(body["events"]) == 4
        assert not list(validator.iter_errors(body))
    finally:
        service.stop()

    for code, (status, message) in ERRORS.items():
        assert not list(validator.iter_errors({"error": {"code": code, "message": message}})), code
    # A body that is neither shape must fail.
    assert list(validator.iter_errors({"error": {"code": "NOPE", "message": "x"}}))
    assert list(validator.iter_errors({"events": []}))
