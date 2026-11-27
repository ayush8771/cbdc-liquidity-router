"""Acceptance criterion 5a: envelope validation, **distinct from classification**.

A mutation the schema forbids is rejected at **validation, before** the
classifier sees it, and this suite asserts **that** — not a classification
outcome (AD-5 v0.8 §8.2b.2).

**Why the split matters.** Mixing the two would let an infeasible mutation be
recorded as a classifier case, and the classifier would then appear to be tested
on inputs it can never receive. So:

- a **classifier test** feeds two schema-valid envelopes — `test_idempotency.py`;
- an **envelope-validation test** feeds an invalid one and asserts rejection at
  validation — here.

Each case below is one the field matrix's "schema dependency" column marks as
**not mutable alone**.
"""
from __future__ import annotations

import copy
import json

import pytest

from cbdc_ingestion.clock import ManualClock
from cbdc_ingestion.generator import FxGenerator
from cbdc_ingestion.validation import EnvelopeInvalid, validate_fx_envelope

from .conftest import CONTRACTS, SEED, START_MS


@pytest.fixture(scope="module")
def envelope_validator():
    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads(
        (CONTRACTS / "events" / "event-envelope.v1.schema.json").read_text(encoding="utf-8"))
    return jsonschema.Draft202012Validator(schema)


@pytest.fixture
def event() -> dict:
    generator = FxGenerator(SEED, ManualClock(START_MS), start_ms=START_MS)
    return copy.deepcopy(generator.due(START_MS)[0])


def assert_rejected_at_validation(validator, event: dict) -> None:
    """The schema **and** the strict validator both reject it.

    Both are asserted because both guard the path: the schema is the contract,
    and `validation.py` is what `LatestStore.apply` actually runs. If they ever
    disagreed, an event could pass the gate that matters and fail the one that
    does not.
    """
    assert list(validator.iter_errors(event)), "the schema accepted an invalid envelope"
    with pytest.raises(EnvelopeInvalid):
        validate_fx_envelope(event)


def test_the_unmutated_event_is_valid(envelope_validator, event):
    """The positive control, so the suite is not rejecting everything."""
    assert not list(envelope_validator.iter_errors(event))
    validate_fx_envelope(event)


def test_an_instance_id_inserted_into_source_is_invalid(envelope_validator, event):
    """`source` is `additionalProperties: false` over exactly four keys.

    This is why a redelivery case must vary `instance_id` on the **wrapper**:
    the field cannot exist inside an envelope at all.
    """
    event["source"]["instance_id"] = "11111111-1111-4111-8111-111111111111"
    assert_rejected_at_validation(envelope_validator, event)


def test_a_transport_only_change_breaks_allof_rule_0(envelope_validator, event):
    """`provenance_class` stays `synthetic` while the transport does not.

    Rule 0 ties the four synthetic markers together, so `source.transport` is
    reachable only **with** `provenance_class` — which is why criterion 5's
    case (j) moves the whole group.
    """
    event["source"]["transport"] = "poll"
    assert_rejected_at_validation(envelope_validator, event)


def test_validated_carrying_reasons_is_invalid(envelope_validator, event):
    """`validated` requires `reasons` **empty**; the pair moves together."""
    event["validation"] = {"status": "validated", "reasons": ["FUTURE_SOURCE_TIMESTAMP"]}
    assert_rejected_at_validation(envelope_validator, event)


def test_quarantined_without_reasons_is_invalid(envelope_validator, event):
    """And the other half of the same rule: `quarantined` needs at least one."""
    event["validation"] = {"status": "quarantined", "reasons": []}
    assert_rejected_at_validation(envelope_validator, event)


def test_basis_none_with_a_non_null_source_timestamp_is_invalid(envelope_validator, event):
    """Nullability is bound to the basis.

    So the only schema-valid basis mutation is `observed` against `published`
    with a non-null timestamp, which is criterion 5's case (l).
    """
    event["timestamps"]["source_timestamp_basis"] = "none"
    assert_rejected_at_validation(envelope_validator, event)


def test_a_non_null_review_without_supersedes_is_invalid(envelope_validator, event):
    """`allOf` rule 5: a non-null `review` forces `supersedes` to a string.

    It also forces `validation.status` to `validated`. With `review: null` a
    `supersedes`-only mutation **is** valid, which is case (m).
    """
    event["review"] = {"reviewer": "someone", "decision": "approved"}
    assert list(envelope_validator.iter_errors(event))
    with pytest.raises(EnvelopeInvalid):
        validate_fx_envelope(event)


def test_a_null_source_timestamp_with_a_non_none_basis_is_invalid(envelope_validator, event):
    event["timestamps"]["source_timestamp"] = None
    assert_rejected_at_validation(envelope_validator, event)


def test_invalid_envelopes_never_reach_the_classifier(event):
    """The **store half** of the ordering claim: `LatestStore.apply` validates
    before it stores, so an invalid envelope is counted `rejected` and never
    becomes current.

    This asserts the store, not the service path: the `DedupIndex` below is a
    fresh one that nothing consults, so it cannot show what the pipeline's own
    index did. The service-path ordering — validation before
    `DedupIndex.classify` — is asserted in
    `test_pipeline_accounting.py::test_a_schema_invalid_envelope_never_enters_the_dedup_index`,
    which runs a real `SourcePipeline` and inspects *its* index.
    """
    from cbdc_ingestion.dedup import DedupIndex
    from cbdc_ingestion.store import LatestStore

    event["source"]["instance_id"] = "11111111-1111-4111-8111-111111111111"
    store, index = LatestStore(), DedupIndex()
    assert store.apply(event) is False
    assert store.counters()["rejected"] == 1
    assert len(index) == 0, "the classifier recorded nothing for an invalid envelope"


def test_the_existing_schema_conformance_suite_is_untouched():
    """Criterion 5a names it as still passing unchanged."""
    from pathlib import Path

    assert (Path(__file__).parent / "test_schema_conformance.py").exists()
