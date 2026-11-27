"""3.3-A acceptance criterion 5a: envelope-validation cases — DATA ONLY.

Each case is an envelope the committed schema **forbids**. Criterion 5a requires
it to be rejected **at validation, before the classifier sees it** (AD-5 v0.7b
§8.2b.2). Validation is owned by `pipeline.py` (confirmed by Ayush). This module
builds the inputs only; `test_idempotency_conformance.py` binds them to the confirmed
`validation.validate_fx_envelope` in front of a real `dedup.DedupIndex` (a9a3742).

Kept apart from `idempotency_cases.py` on purpose: criteria 5 and 5a "are not
mixed", so the classifier suite never receives an invalid input.

Fixture origin (3.3-A §6.2 format; A-10): `ORIGIN`. Built in code; nothing is
recorded from a provider.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass

from .idempotency_cases import base_envelope

ORIGIN = {
    "origin": "hand-written",
    "created": "2026-11-27",
    "note": "AD-5 v0.8 criterion 5a invalid envelopes built in code from build_fx_event",
}


@dataclass(frozen=True)
class InvalidEnvelopeCase:
    case_id: str
    required_by: str       # "5a" for the five cases criterion 5a names; "extra" for added ones
    description: str
    envelope: dict
    mutated: frozenset     # leaf paths that differ from base_envelope()
    schema_rule: str


def _from_base(fn) -> dict:
    e = copy.deepcopy(base_envelope())
    fn(e)
    return e


def _case(cid, required_by, description, fn, mutated, rule) -> InvalidEnvelopeCase:
    return InvalidEnvelopeCase(cid, required_by, description, _from_base(fn), frozenset(mutated), rule)


INVALID_CASES: tuple = (
    # --- the five cases criterion 5a names ---
    _case("instance-id-in-source", "5a", "an instance_id inserted into source",
          lambda e: e["source"].update(instance_id="6f1f6c0e-2f0a-4b6e-8a53-0d6a2d1f3a11"),
          {"source.instance_id"}, "source additionalProperties: false"),
    _case("transport-only", "5a", "source.transport changed alone (synthetic -> poll)",
          lambda e: e["source"].update(transport="poll"),
          {"source.transport"}, "allOf rule 0 (synthetic class implies synthetic transport)"),
    _case("validated-with-reasons", "5a", "validation.status 'validated' carrying a reason",
          lambda e: e["validation"].update(reasons=["VALUE_JUMP"]),
          {"validation.reasons"}, "validation if/then: validated requires reasons maxItems 0"),
    _case("basis-none-with-timestamp", "5a", "source_timestamp_basis 'none' with a non-null source_timestamp",
          lambda e: e["timestamps"].update(source_timestamp_basis="none"),
          {"timestamps.source_timestamp_basis"}, "timestamps if/then/else: non-null requires observed|published"),
    _case("review-without-supersedes", "5a", "a non-null review without supersedes",
          lambda e: e.update(review={"reviewer_ref": "test-reviewer", "reviewed_at": "2025-11-25T00:00:01.000Z"}),
          {"review", "review.reviewer_ref", "review.reviewed_at"}, "allOf rule 5: review requires supersedes string"),
    # --- further single-field mutations the schema forbids (AD-5 §8.2b.2's other pairings) ---
    _case("quarantined-without-reasons", "extra", "validation.status 'quarantined' with no reason (status-only change)",
          lambda e: e["validation"].update(status="quarantined"),
          {"validation.status"}, "validation if/then/else: quarantined requires reasons minItems 1"),
    _case("provenance-only", "extra", "provenance_class changed alone (synthetic -> real)",
          lambda e: e.update(provenance_class="real"),
          {"provenance_class"}, "allOf rule 0 else-branch (transport, source_id prefix, synthetic block); rule 1"),
    _case("derived-from-without-derivation", "extra", "derived_from set with derivation left null",
          lambda e: e.update(derived_from=["11111111-1111-4111-8111-111111111111"]),
          {"derived_from"}, "allOf rule 3: non-empty derived_from requires derivation string"),
    _case("null-timestamp-observed", "extra", "source_timestamp null with basis left 'observed'",
          lambda e: e["timestamps"].update(source_timestamp=None),
          {"timestamps.source_timestamp"}, "timestamps if/then: null requires basis none"),
    _case("instance-id-top-level", "extra", "an instance_id inserted at the envelope's top level",
          lambda e: e.update(instance_id="6f1f6c0e-2f0a-4b6e-8a53-0d6a2d1f3a11"),
          {"instance_id"}, "envelope additionalProperties: false"),
    _case("synthetic-block-null", "extra", "synthetic block nulled on a synthetic-class envelope",
          lambda e: e.update(synthetic=None),
          {"synthetic", "synthetic.seed", "synthetic.case_id", "synthetic.generator_version"},
          "allOf rule 0: synthetic class requires the synthetic object"),
)
