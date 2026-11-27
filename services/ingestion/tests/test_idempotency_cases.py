"""Criterion 5 fixtures are what AD-5 v0.8 needs them to be — checked WITHOUT a classifier.

These tests run today and assert only properties of the inputs in
`idempotency_cases.py`:

- every classifier input validates against `event-envelope.v1.schema.json`
  and carries a correct `payload_sha256` (AD-5 §8.2b.2: classifier tests take
  schema-valid envelopes only);
- each case differs in exactly the leaf paths it declares, no more;
- each case's claim about sharing `event_id` and the two AD-5 §8.1 keys holds
  (this is why (c) and (e) would fall to D, and (d) to neither, without C-b);
- the §8.2b.1 field matrix is covered completely, in both directions;
- the D-24 slice stays compatible: its own events never form a C-b pair.

The outcomes themselves (C-b rejected, D discarded, C-a first kept, the order
C-b → D → C-a) are asserted against the real `dedup.py` / `pipeline.py` in
`test_idempotency_conformance.py` (interfaces confirmed at a9a3742). Nothing here mocks or re-implements classification.
"""
from __future__ import annotations

import copy

import pytest

from cbdc_ingestion.canonical import payload_sha256
from cbdc_ingestion.clock import ManualClock
from cbdc_ingestion.generator import FxGenerator

from .conformance_support import (envelope_validator, flatten, idempotency_key, leaf_diff, observation_key,
                                  schema_errors, wrapper_validator)
from .conftest import SEED, START_MS
from .idempotency_cases import (CA, CA_AND_CONTROL_CASES, CB, CB_CASES, D, D_CASES, DEDUP_WINDOW_MS,
                                DIRECT_CLASSIFIER_ONLY, NEW, ORIGIN, OUTCOMES, PAIR_CASES, SEQUENCE_CASES,
                                WINDOW_CASES, base_envelope)

# ---------------------------------------------------------------------------
# AD-5 v0.8 (APPROVED) §8.2b.1, transcribed. Every envelope leaf path must appear here.
# IDENTITY_DEVB marks the rows that were [PROPOSED]/[DevB] in v0.7b and are now identity-
# bearing by AD5-Q8's adoption; the tag is kept only so their coverage is checked separately.
# ---------------------------------------------------------------------------
KEY, IDENTITY, IDENTITY_DEVB, EXCLUDED, DEFERRED, NOT_APPLICABLE = (
    "key", "identity", "identity[adopted AD5-Q8]", "excluded", "excluded-deferred", "n/a")

FIELD_MATRIX = {
    "event_id": KEY,
    "payload": IDENTITY, "payload_sha256": IDENTITY,
    "event_type": IDENTITY,
    "source": NOT_APPLICABLE,  # container; its members are classified
    "source.source_id": IDENTITY,
    "source.transport": IDENTITY_DEVB,
    "source.source_url": IDENTITY_DEVB,
    "source.gate3_decision_ref": IDENTITY_DEVB,
    "source_sequence": IDENTITY,
    "timestamps": NOT_APPLICABLE,
    "timestamps.source_timestamp": IDENTITY,
    "timestamps.source_timestamp_basis": IDENTITY_DEVB,
    "timestamps.retrieved_at": EXCLUDED,
    "timestamps.emitted_at": EXCLUDED,
    "provenance_class": IDENTITY_DEVB,
    "derived_from": IDENTITY_DEVB,
    "derivation": IDENTITY_DEVB,
    "synthetic": NOT_APPLICABLE,
    "synthetic.seed": IDENTITY,
    "synthetic.case_id": IDENTITY,
    "synthetic.generator_version": IDENTITY,
    "supersedes": IDENTITY_DEVB,
    "raw_sha256": EXCLUDED,
    "validation": NOT_APPLICABLE,
    "validation.status": EXCLUDED,
    "validation.reasons": EXCLUDED,
    "extraction": DEFERRED,
    "review": DEFERRED,
    "schema_version": NOT_APPLICABLE,
    "usage": NOT_APPLICABLE,
}

# The subject fields live inside `payload`; the matrix row "the subject inside payload".
SUBJECT_PATHS = {"payload.base_currency", "payload.quote_currency", "payload.rate_type"}


def _matrix_row(path: str) -> str:
    if path.startswith("payload."):
        return IDENTITY
    return FIELD_MATRIX[path]


# ---------------------------------------------------------------------------
# Catalogue integrity
# ---------------------------------------------------------------------------

def test_case_ids_are_unique_and_outcomes_are_spec_labels():
    ids = [c.case_id for c in PAIR_CASES] + [c.case_id for c in SEQUENCE_CASES] + [c.case_id for c in WINDOW_CASES]
    assert len(ids) == len(set(ids))
    for c in PAIR_CASES:
        assert c.expected in OUTCOMES
    for s in SEQUENCE_CASES:
        assert set(s.expected) <= OUTCOMES and len(s.expected) == len(s.events)


def test_every_criterion_5_letter_has_a_case():
    letters = {c.criterion for c in PAIR_CASES}
    for letter in "abcdefghijklmnopqrs":
        assert f"5({letter})" in letters, letter


def test_c_b_letters_expect_c_b_and_d_letters_expect_d():
    for c in CB_CASES:
        if c.case_id != "k2":  # (k)'s reordering-only variant must be D
            assert c.expected == CB, c.case_id
    assert next(c for c in CB_CASES if c.case_id == "k2").expected == D
    assert all(c.expected == D for c in D_CASES)


def test_j_to_m_are_unconditional_c_b_under_ad5_v0_8():
    """AD5-Q8 = YES (AD-5 v0.8 §15) adopts the formerly [PROPOSED]/[DevB] rows: no fallback outcome."""
    by_id = {c.case_id: c for c in PAIR_CASES}
    assert all(by_id[cid].expected == CB for cid in "jklm")
    assert not any(hasattr(c, "expected_if_devb_rows_not_adopted") for c in PAIR_CASES)


def test_direct_classifier_only_list_matches_the_unchanged_strict_validator():
    """Which schema-valid cases the adapter path's validator (validation.py, untouched by rule) refuses."""
    from cbdc_ingestion.validation import EnvelopeInvalid, validate_fx_envelope

    refused = set()
    for c in PAIR_CASES:
        for e in (c.first, c.second):
            try:
                validate_fx_envelope(e)
            except EnvelopeInvalid:
                refused.add(c.case_id)
    assert refused == set(DIRECT_CLASSIFIER_ONLY)


def test_fx_fixture_rates_sit_inside_the_generators_declared_ranges():
    """Keeps fixtures clear of criterion 16's VALUE_OUT_OF_RANGE / VALUE_JUMP quarantine."""
    from decimal import Decimal
    from cbdc_ingestion.generator import BASE_RATES

    half_width = Decimal("0.010000")
    for label, e in _all_pair_envelopes():
        if e["event_type"] != "fx_rate":
            continue
        p = e["payload"]
        centre = BASE_RATES[f"{p['base_currency']}/{p['quote_currency']}"]
        assert abs(Decimal(p["rate"]) - centre) <= half_width, label
    for c in PAIR_CASES:
        a, b = c.first["payload"], c.second["payload"]
        if c.first["event_type"] == c.second["event_type"] == "fx_rate" and \
                (a["base_currency"], a["quote_currency"]) == (b["base_currency"], b["quote_currency"]):
            assert abs(Decimal(b["rate"]) / Decimal(a["rate"]) - 1) <= Decimal("0.2"), c.case_id


def test_fixture_origin_record_matches_the_6_2_format():
    from .envelope_validation_cases import ORIGIN as ORIGIN_5A
    for origin in (ORIGIN, ORIGIN_5A):
        assert origin["origin"] == "hand-written"
        assert not {"seed", "generator_version", "case_id"} & origin.keys()  # must be absent for hand-written
        assert set(origin) <= {"origin", "created", "note"}


# ---------------------------------------------------------------------------
# Every classifier input is schema-valid and correctly hashed
# ---------------------------------------------------------------------------

def _all_pair_envelopes():
    for c in PAIR_CASES:
        yield f"{c.case_id}/first", c.first
        yield f"{c.case_id}/second", c.second
    for s in SEQUENCE_CASES:
        for i, e in enumerate(s.events):
            yield f"{s.case_id}/{i}", e


@pytest.mark.parametrize("label,envelope", list(_all_pair_envelopes()), ids=lambda v: v if isinstance(v, str) else "")
def test_classifier_input_is_schema_valid(label, envelope):
    assert schema_errors(envelope_validator(), envelope) == []


@pytest.mark.parametrize("label,envelope", list(_all_pair_envelopes()), ids=lambda v: v if isinstance(v, str) else "")
def test_classifier_input_has_a_correct_payload_hash(label, envelope):
    assert envelope["payload_sha256"] == payload_sha256(envelope["event_type"], envelope["payload"])


@pytest.mark.parametrize("label,envelope", list(_all_pair_envelopes()), ids=lambda v: v if isinstance(v, str) else "")
def test_classifier_input_is_display_only(label, envelope):
    """Criterion 12: usage display_only on every envelope, fixtures included."""
    assert envelope["usage"] == "display_only"


@pytest.mark.parametrize("label,envelope", list(_all_pair_envelopes()), ids=lambda v: v if isinstance(v, str) else "")
def test_only_case_q_carries_a_quarantined_verdict(label, envelope):
    """No input is quarantined by accident (e.g. a future source_timestamp); only (q) moves validation."""
    expected = "quarantined" if label == "q/second" else "validated"
    assert envelope["validation"]["status"] == expected


def test_wrapper_redelivery_case_p_is_valid_on_the_wrapper_and_byte_identical_inside():
    c = next(c for c in PAIR_CASES if c.case_id == "p")
    a_id, b_id = c.wrapper_instance_ids
    assert a_id != b_id
    assert c.first == c.second  # byte-identical envelope
    validator = wrapper_validator()
    for instance_id, env in ((a_id, c.first), (b_id, c.second)):
        wrapper = {"protocol_version": "1.0", "instance_id": instance_id, "source_id": "synthetic.fx",
                   "generated_at": "2025-11-25T00:00:00.300Z", "events": [env]}
        assert schema_errors(validator, wrapper) == []
        assert "instance_id" not in flatten(env)  # varied on the wrapper, never inside the envelope


# ---------------------------------------------------------------------------
# Each case is exactly the mutation it claims, with the key properties it claims
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("case", PAIR_CASES, ids=lambda c: c.case_id)
def test_case_differs_in_exactly_its_declared_paths(case):
    assert leaf_diff(case.first, case.second) == set(case.mutated)


@pytest.mark.parametrize("case", PAIR_CASES, ids=lambda c: c.case_id)
def test_case_key_properties_hold(case):
    assert (case.first["event_id"] == case.second["event_id"]) is case.shares_event_id
    assert (observation_key(case.first) == observation_key(case.second)) is case.shares_observation_key
    assert (idempotency_key(case.first) == idempotency_key(case.second)) is case.shares_idempotency_key


def test_criterion_5_letters_all_reuse_the_event_id():
    for c in CB_CASES + D_CASES:
        assert c.shares_event_id, c.case_id


def test_the_cases_that_need_c_b_first_are_present():
    """AD-5 §8.2: why C-b needs its own event_id index and must be evaluated first."""
    by_id = {c.case_id: c for c in PAIR_CASES}
    # equal event_id AND both §8.1 keys equal -> would be D without C-b first
    for cid in ("a", "b", "c", "e"):
        assert by_id[cid].shares_idempotency_key and by_id[cid].expected == CB
    # equal event_id, neither key equal -> would be NEW without the event_id index
    assert not by_id["d"].shares_observation_key and by_id["d"].expected == CB
    # equal event_id, C-a condition also true -> C-b before C-a
    f = by_id["f"]
    assert f.shares_observation_key and not f.shares_idempotency_key and f.expected == CB


# ---------------------------------------------------------------------------
# §8.2b.1 matrix coverage, both directions
# ---------------------------------------------------------------------------

def test_matrix_names_every_envelope_leaf_path():
    for path in flatten(base_envelope()):
        if path.startswith("payload."):
            continue
        assert path in FIELD_MATRIX, f"{path} has no §8.2b.1 classification"


def test_every_identity_bearing_field_has_a_c_b_case():
    touched = set().union(*(c.mutated for c in PAIR_CASES if c.expected == CB and c.shares_event_id))
    identity = {p for p, cls in FIELD_MATRIX.items() if cls in (IDENTITY, IDENTITY_DEVB)} - {"payload"}
    missing = {p for p in identity if p not in touched}
    assert not missing, missing
    assert SUBJECT_PATHS <= touched  # every fx_rate subject field
    assert any(p.startswith("payload.") and p not in SUBJECT_PATHS for p in touched)  # a non-subject payload change


def test_every_excluded_field_has_a_d_case_and_no_c_b_case_touches_only_excluded_fields():
    d_touched = set().union(*(c.mutated for c in PAIR_CASES if c.expected == D and c.shares_event_id))
    excluded = {p for p, cls in FIELD_MATRIX.items() if cls == EXCLUDED}
    assert excluded <= d_touched, excluded - d_touched
    for c in PAIR_CASES:
        if c.expected == CB:
            assert any(_matrix_row(p) in (IDENTITY, IDENTITY_DEVB) for p in c.mutated), c.case_id


def test_d_cases_touch_no_identity_bearing_field_except_the_set_reordering():
    for c in PAIR_CASES:
        if c.expected == D and c.shares_event_id:
            rows = {_matrix_row(p) for p in c.mutated}
            if c.case_id == "k2":
                assert c.mutated == {"derived_from"}
                assert set(c.first["derived_from"]) == set(c.second["derived_from"])
            else:
                assert rows <= {EXCLUDED}, (c.case_id, rows)


def test_deferred_fields_get_no_case():
    """Criterion 5: extraction and review are deferred to milestone 3.6, with no case here."""
    for c in PAIR_CASES:
        assert not {p for p in c.mutated if p.split(".")[0] in ("extraction", "review")}, c.case_id


def test_each_adopted_devb_row_is_exercised_by_a_c_b_case():
    adopted = {p for p, cls in FIELD_MATRIX.items() if cls == IDENTITY_DEVB}
    touched = set().union(*(c.mutated for c in PAIR_CASES if c.expected == CB))
    assert adopted <= touched, adopted - touched


# ---------------------------------------------------------------------------
# C-a, sequences and the window
# ---------------------------------------------------------------------------

def test_c_a_and_control_cases_use_distinct_event_ids():
    for c in CA_AND_CONTROL_CASES:
        assert not c.shares_event_id, c.case_id
    assert next(c for c in CA_AND_CONTROL_CASES if c.case_id == "ca").expected == CA
    assert {c.expected for c in CA_AND_CONTROL_CASES} >= {CA, D, NEW}


def test_window_cases_straddle_300_seconds():
    assert DEDUP_WINDOW_MS == 300_000
    offsets = {(w.pair_case_id, w.second_arrival_offset_ms) for w in WINDOW_CASES}
    for pc in ("s", "a"):
        assert {(pc, DEDUP_WINDOW_MS - 1), (pc, DEDUP_WINDOW_MS), (pc, DEDUP_WINDOW_MS + 1)} <= offsets
    for w in WINDOW_CASES:
        assert w.expected is not None or w.not_expected is not None or w.open_question, w.case_id


# ---------------------------------------------------------------------------
# D-24 compatibility (AD5-Q11(a): the slice path keeps AD-1 §3.4, unchanged)
# ---------------------------------------------------------------------------

def _slice_events(seed: int = SEED, span_ms: int = 60_000) -> list:
    generator = FxGenerator(seed, ManualClock(START_MS), start_ms=START_MS)
    return [e for ms in range(0, span_ms, 250) for e in generator.due(START_MS + ms)]


def test_d24_events_are_valid_classifier_inputs():
    validator = envelope_validator()
    for e in _slice_events():
        assert schema_errors(validator, e) == []


def test_d24_slice_never_forms_an_identity_collision_within_a_run():
    """AD-5 §8.2b.1: 'Nothing in the matrix is reachable in the D-24 slice.'"""
    events = _slice_events()
    assert len({e["event_id"] for e in events}) == len(events)


def test_d24_replay_pairs_are_matrix_d_cases_not_c_b():
    """Same seed + injected clock reproduces each envelope exactly (C-1), so a replay
    of a slice event shares every identity-bearing field: a duplicate, never a collision."""
    for a, b in zip(_slice_events(), _slice_events()):
        assert a["event_id"] == b["event_id"]
        assert not {p for p in leaf_diff(a, b) if _matrix_row(p) in (IDENTITY, IDENTITY_DEVB)}


def test_option_b_configurations_never_share_an_event_id_and_both_validate_unchanged():
    """Option B (fbef1ec): both configurations write source_id synthetic.fx and differ only by seed.

    P-4 consequences checked on the unchanged builder and validators: (1) at equal pair, sequence and
    source_timestamp the two seeds never produce one event_id, so no cross-configuration C-b can arise
    from the derivation; (2) each envelope passes the committed schema and the strict validator with
    the shared source_id."""
    from cbdc_ingestion import SOURCE_ID
    from cbdc_ingestion.envelope import build_fx_event, fx_payload
    from cbdc_ingestion.generator import rate_for
    from cbdc_ingestion.pairs import PAIRS
    from cbdc_ingestion.validation import validate_fx_envelope
    from .idempotency_cases import ADAPTER_SEED

    assert ADAPTER_SEED != SEED
    validator = envelope_validator()
    for pair in PAIRS:
        for seq in range(1, 51):
            pair_events = []
            for seed in (SEED, ADAPTER_SEED):
                e = build_fx_event(seed=seed, sequence=seq, retrieved_at_ms=START_MS + 2000 * seq,
                                   payload=fx_payload(pair.base, pair.quote, rate_for(seed, pair, seq)))
                assert e["source"]["source_id"] == SOURCE_ID == "synthetic.fx"
                validate_fx_envelope(e)
                assert schema_errors(validator, e) == []
                pair_events.append(e)
            g, a = pair_events
            assert g["event_id"] != a["event_id"]
            assert observation_key(g) == observation_key(a)  # why the pair would be C-a/D, never C-b


def test_fixtures_do_not_disturb_the_d24_builder():
    """The base envelope is the unmodified build_fx_event output; mutations are on copies."""
    a, b = base_envelope(), base_envelope()
    for c in PAIR_CASES:
        _ = copy.deepcopy(c.second)
    assert a == b and a["supersedes"] is None and a["synthetic"]["seed"] == SEED
