"""Criterion 5a fixtures are invalid for the right reason — checked WITHOUT pipeline.py.

Asserts, today, that every case in `envelope_validation_cases.py` is rejected
by the committed `event-envelope.v1.schema.json`, is exactly the single
mutation it declares, and is also rejected by the existing D-24 strict
validator (`validation.validate_fx_envelope`, approved and unchanged).

What is **not** asserted here: that `pipeline.py` rejects these **before**
classification. That binding is in `test_idempotency_conformance.py`.
"""
from __future__ import annotations

import pytest

from cbdc_ingestion.validation import EnvelopeInvalid, validate_fx_envelope

from .conformance_support import envelope_validator, leaf_diff, schema_errors
from .envelope_validation_cases import INVALID_CASES
from .idempotency_cases import base_envelope

NAMED_BY_CRITERION_5A = {"instance-id-in-source", "transport-only", "validated-with-reasons",
                         "basis-none-with-timestamp", "review-without-supersedes"}


def test_every_case_criterion_5a_names_is_present():
    assert {c.case_id for c in INVALID_CASES if c.required_by == "5a"} == NAMED_BY_CRITERION_5A


def test_the_unmutated_base_is_valid():
    assert schema_errors(envelope_validator(), base_envelope()) == []


@pytest.mark.parametrize("case", INVALID_CASES, ids=lambda c: c.case_id)
def test_case_is_rejected_by_the_committed_schema(case):
    assert schema_errors(envelope_validator(), case.envelope), f"schema accepted {case.case_id} ({case.schema_rule})"


@pytest.mark.parametrize("case", INVALID_CASES, ids=lambda c: c.case_id)
def test_case_is_exactly_its_declared_mutation(case):
    assert leaf_diff(base_envelope(), case.envelope) == set(case.mutated)


@pytest.mark.parametrize("case", INVALID_CASES, ids=lambda c: c.case_id)
def test_d24_strict_validator_also_rejects_the_case(case):
    """Both validators the repository has today agree; neither is the pipeline's entry point (unconfirmed)."""
    with pytest.raises(EnvelopeInvalid):
        validate_fx_envelope(case.envelope)


def test_no_invalid_case_leaks_into_the_classifier_catalogue():
    """Criteria 5 and 5a are not mixed (AD-5 §8.2b.2)."""
    from .idempotency_cases import PAIR_CASES, SEQUENCE_CASES
    validator = envelope_validator()
    for c in PAIR_CASES:
        assert not schema_errors(validator, c.first) and not schema_errors(validator, c.second), c.case_id
    for s in SEQUENCE_CASES:
        assert all(not schema_errors(validator, e) for e in s.events), s.case_id
