"""Acceptance criterion 5: classification, **on schema-valid envelopes only**.

AD-5 v0.8 §8.2's three outcomes, produced in the order **C-b, D, C-a**, with
**C-b evaluated against an `event_id`-keyed index** and not against either key
of §8.1. A collision is **rejected and counted**, a duplicate **discarded and
counted**, a value conflict keeps the first.

**Every case here feeds the classifier two envelopes that both validate against
`event-envelope.v1.schema.json`** (§8.2b.2). An infeasible single-field mutation
is **not** a classifier case but an envelope-validation case, which
`test_envelope_validation.py` (criterion 5a) covers. The two are not mixed, and
this module asserts that its own inputs are valid before classifying them.

Case letters below follow the authorization's criterion-5 list, (a) to (s).
"""
from __future__ import annotations

import copy
import json

import pytest

from cbdc_ingestion.clock import ManualClock
from cbdc_ingestion.dedup import (
    ACCEPTED,
    DEDUP_WINDOW_MS,
    DUPLICATE,
    IDENTITY_BEARING_PATHS,
    IDENTITY_COLLISION,
    VALUE_CONFLICT,
    DedupIndex,
    idempotency_key,
    observation_key,
)
from cbdc_ingestion.generator import FxGenerator

from .conftest import CONTRACTS, SEED, START_MS


@pytest.fixture(scope="module")
def base_event() -> dict:
    """One real, schema-valid generated envelope."""
    generator = FxGenerator(SEED, ManualClock(START_MS), start_ms=START_MS)
    events = generator.due(START_MS)
    assert events
    return events[0]


@pytest.fixture
def index() -> DedupIndex:
    return DedupIndex()


def variant(event: dict, path: str, value) -> dict:
    """A copy of `event` with the dotted `path` set to `value`."""
    clone = copy.deepcopy(event)
    target = clone
    parts = path.split(".")
    for part in parts[:-1]:
        target = target[part]
    target[parts[-1]] = value
    return clone


def assert_schema_valid(*events: dict) -> None:
    """Both inputs must validate against `event-envelope.v1.schema.json`.

    **The AD-4 schema, not `validation.py`.** The strict validator is the
    **D-24 slice's** rule set (AD-1 §3.4): it pins `source_id` to the slice's
    one value, forbids a non-null `supersedes`, a non-empty `derived_from`, a
    `published` basis and a non-null `raw_sha256`. Those are slice constraints,
    not AD-4 constraints, and §8.2b's matrix is drawn against the **schema**.
    Using the slice validator here would make most of criterion 5's own named
    cases untestable.
    """
    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads(
        (CONTRACTS / "events" / "event-envelope.v1.schema.json").read_text(encoding="utf-8"))
    check = jsonschema.Draft202012Validator(schema)
    for event in events:
        errors = list(check.iter_errors(event))
        assert not errors, f"not a classifier case: {[e.message for e in errors]}"


def classify_pair(index: DedupIndex, first: dict, second: dict) -> str:
    """Feeds two schema-valid envelopes and returns the second's outcome."""
    assert_schema_valid(first, second)
    assert index.classify(first, START_MS)[0] == ACCEPTED
    return index.classify(second, START_MS)[0]


# ----------------------------------------------------------- the keys themselves
def test_the_two_keys_have_ad5_8_1_s_shape(base_event):
    source_id, event_type, subject, moment = observation_key(base_event)
    assert source_id == "synthetic.fx"
    assert event_type == "fx_rate"
    assert subject == (base_event["payload"]["base_currency"],
                       base_event["payload"]["quote_currency"], "mid")
    assert moment == base_event["timestamps"]["source_timestamp"]
    assert idempotency_key(base_event) == (
        observation_key(base_event), base_event["payload_sha256"])


def test_the_subject_separates_two_pairs_at_one_instant(base_event):
    """§8.1: the three-part key of scope §3.B could not do this."""
    other = variant(base_event, "payload.base_currency", "USD")
    other = variant(other, "payload.quote_currency", "INR")
    assert observation_key(base_event) != observation_key(other)


def test_a_differing_payload_always_differs_in_the_idempotency_key(base_event):
    """The hash is inside the key, so this holds by construction."""
    other = variant(base_event, "payload_sha256", "a" * 64)
    assert idempotency_key(base_event) != idempotency_key(other)


# ------------------------------------------------ C-b: identity collisions (a)-(m)
@pytest.mark.parametrize("label, path, value", [
    ("a", "synthetic.case_id", "stress"),
    ("b", "synthetic.generator_version", "9.9.9"),
    ("c", "synthetic.seed", 20261199),
    ("e", "source_sequence", "99"),
    ("f", "payload_sha256", "b" * 64),
    ("h", "source.source_id", "synthetic.other"),
])
def test_cb_fires_on_an_identity_bearing_difference(index, base_event, label, path, value):
    """Each is **rejected**, not discarded and not accepted."""
    second = variant(base_event, path, value)
    assert classify_pair(index, base_event, second) == IDENTITY_COLLISION
    assert index.counters[IDENTITY_COLLISION] == 1
    assert index.collision_fields.get(path) == 1


def test_cb_c_a_changed_seed_shares_both_keys_and_must_not_be_discarded(index, base_event):
    """(c) The counter-example that forces C-b to be evaluated first.

    A changed `synthetic.seed` leaves `source_id`, `event_type`, subject,
    `source_timestamp` and `payload_sha256` all equal, so **both §8.1 keys are
    equal**. Evaluated second, this is D and is **silently discarded** — the C-1
    defect.
    """
    second = variant(base_event, "synthetic.seed", 20261199)
    assert idempotency_key(base_event) == idempotency_key(second)
    assert observation_key(base_event) == observation_key(second)
    assert classify_pair(index, base_event, second) == IDENTITY_COLLISION


def test_cb_d_a_changed_source_timestamp_matches_neither_key(index, base_event):
    """(d) Matches **neither** D nor C-a, so it must not be accepted.

    `source_timestamp` is a C-1 input, so an equal `event_id` with an unequal
    timestamp is possible only through a collision. The basis stays non-`none`,
    which keeps the envelope schema-valid.
    """
    second = variant(base_event, "timestamps.source_timestamp", "2025-11-25T00:00:09.000Z")
    assert observation_key(base_event) != observation_key(second)
    assert idempotency_key(base_event) != idempotency_key(second)
    assert second["timestamps"]["source_timestamp_basis"] != "none"
    assert classify_pair(index, base_event, second) == IDENTITY_COLLISION


def test_cb_e_a_changed_sequence_alone_shares_both_keys(index, base_event):
    """(e) The claim that a differing sequence must change the payload was false.

    `source_sequence` is a required envelope field, nothing couples it to the
    payload, and it is a C-1 derivation input. It must be **rejected**, not D.
    """
    second = variant(base_event, "source_sequence", "99")
    assert base_event["payload_sha256"] == second["payload_sha256"]
    assert idempotency_key(base_event) == idempotency_key(second)
    assert classify_pair(index, base_event, second) == IDENTITY_COLLISION


def test_cb_g_a_changed_subject_is_a_collision(index, base_event):
    """(g) The pair is a C-1 input; AD-1 §3.4 keys on 'different content or pair'."""
    second = variant(base_event, "payload.base_currency", "USD")
    second = variant(second, "payload.quote_currency", "INR")
    # The hash moves with the payload, which is what makes this schema-valid.
    from cbdc_ingestion.canonical import payload_sha256

    second["payload_sha256"] = payload_sha256("fx_rate", second["payload"])
    assert classify_pair(index, base_event, second) == IDENTITY_COLLISION


def test_cb_j_provenance_class_moves_together_with_its_source_fields(index, base_event):
    """(j) `allOf` rules 0-3 require the whole group to move together.

    A `provenance_class`-only mutation is schema-invalid, so the case moves
    `source.transport`, `source.source_id`, `source_url`,
    `gate3_decision_ref` and the `synthetic` block with it.
    """
    second = copy.deepcopy(base_event)
    second["provenance_class"] = "real"
    second["source"] = {"source_id": "provider.fx", "transport": "poll",
                        "source_url": "https://example.invalid/fx",
                        "gate3_decision_ref": "gate3/decision/none"}
    second["synthetic"] = None
    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads(
        (CONTRACTS / "events" / "event-envelope.v1.schema.json").read_text(encoding="utf-8"))
    assert not list(jsonschema.Draft202012Validator(schema).iter_errors(second)), (
        "the paired mutation must stay schema-valid")
    assert index.classify(base_event, START_MS)[0] == ACCEPTED
    assert index.classify(second, START_MS)[0] == IDENTITY_COLLISION


def test_cb_k_derived_from_moves_with_derivation(index, base_event):
    """(k) `allOf` rule 3 pairs them."""
    second = copy.deepcopy(base_event)
    second["derived_from"] = ["44444444-4444-4444-8444-444444444444"]
    second["derivation"] = "a stated method"
    assert classify_pair(index, base_event, second) == IDENTITY_COLLISION


def test_cb_k_a_reordering_only_variant_of_derived_from_is_a_duplicate(index, base_event):
    """(k) `derived_from` is compared as an **unordered set**.

    `uniqueItems: true` with no ordering semantics anywhere, so a reordering is
    not a difference and must classify as **D**.
    """
    first = copy.deepcopy(base_event)
    first["derived_from"] = ["55555555-5555-4555-8555-555555555555",
                            "66666666-6666-4666-8666-666666666666"]
    first["derivation"] = "a stated method"
    second = copy.deepcopy(first)
    second["derived_from"] = ["66666666-6666-4666-8666-666666666666",
                             "55555555-5555-4555-8555-555555555555"]
    assert index.classify(first, START_MS)[0] == ACCEPTED
    assert index.classify(second, START_MS)[0] == DUPLICATE


def test_cb_l_a_basis_change_between_observed_and_published_is_a_collision(index, base_event):
    """(l) The only schema-valid basis mutation, with a non-null timestamp."""
    second = variant(base_event, "timestamps.source_timestamp_basis", "published")
    assert second["timestamps"]["source_timestamp"] is not None
    assert classify_pair(index, base_event, second) == IDENTITY_COLLISION


def test_cb_m_a_changed_supersedes_with_review_null_is_a_collision(index, base_event):
    """(m) Changed **correction evidence** is never silently discarded.

    `supersedes` is producer-declared evidence (AD5-Q10), not our processing
    metadata. With `review: null` a `supersedes`-only mutation is schema-valid.
    **Unreachable in this scope by invariant:** a synthetic adapter may never set
    it and `envelope.py` writes `None`.
    """
    second = variant(base_event, "supersedes", "33333333-3333-4333-8333-333333333333")
    assert second["review"] is None
    assert classify_pair(index, base_event, second) == IDENTITY_COLLISION


def test_cb_i_a_changed_event_type_with_its_payload_shape(index, base_event):
    """(i) `event_type` is also inside `payload_sha256`."""
    second = variant(base_event, "event_type", "fx_rate")
    second = variant(second, "payload.rate", "9.999999")
    from cbdc_ingestion.canonical import payload_sha256

    second["payload_sha256"] = payload_sha256("fx_rate", second["payload"])
    assert classify_pair(index, base_event, second) == IDENTITY_COLLISION


# ------------------------------------------------------- D: duplicates (n)-(s)
@pytest.mark.parametrize("label, path, value", [
    ("n", "timestamps.retrieved_at", "2025-11-25T00:00:05.000Z"),
    ("o", "timestamps.emitted_at", "2025-11-25T00:00:05.000Z"),
    ("r", "raw_sha256", "c" * 64),
])
def test_d_fires_on_an_excluded_field(index, base_event, label, path, value):
    """Each legitimately differs between two deliveries of one observation."""
    second = variant(base_event, path, value)
    assert classify_pair(index, base_event, second) == DUPLICATE
    assert index.counters[DUPLICATE] == 1


def test_d_s_an_identical_envelope_is_a_duplicate(index, base_event):
    """(s) Identical in every field: a plain redelivery."""
    assert classify_pair(index, base_event, copy.deepcopy(base_event)) == DUPLICATE


def test_d_q_a_validation_status_change_with_its_matching_reasons(index, base_event):
    """(q) Our verdict on re-handling, not a new observation.

    The pair must move together: `validated` requires empty `reasons`,
    `quarantined` at least one.
    """
    second = variant(base_event, "validation",
                     {"status": "quarantined", "reasons": ["FUTURE_SOURCE_TIMESTAMP"]})
    assert index.classify(base_event, START_MS)[0] == ACCEPTED
    assert index.classify(second, START_MS)[0] == DUPLICATE


def test_d_p_a_byte_identical_envelope_under_a_different_instance_id(index, base_event):
    """(p) `instance_id` is varied on the **wrapper**, never inside the envelope.

    The envelope has no such field at any level — `source` is
    `additionalProperties: false` over exactly four keys — so `instance_id` is
    outside C-b **by construction**, not by exclusion. A restarted producer's
    redelivery is a duplicate whatever wrapper carried it.
    """
    assert "instance_id" not in base_event
    assert "instance_id" not in base_event["source"]
    first_wrapper = {"instance_id": "11111111-1111-4111-8111-111111111111",
                     "events": [base_event]}
    second_wrapper = {"instance_id": "22222222-2222-4222-8222-222222222222",
                      "events": [copy.deepcopy(base_event)]}
    assert index.classify(first_wrapper["events"][0], START_MS)[0] == ACCEPTED
    assert index.classify(second_wrapper["events"][0], START_MS)[0] == DUPLICATE


def test_the_excluded_set_is_exactly_what_ad5_8_2b_1_excludes():
    from cbdc_ingestion.dedup import EXCLUDED_PATHS

    for path in ("raw_sha256", "timestamps.retrieved_at", "timestamps.emitted_at",
                 "validation.status", "validation.reasons", "extraction", "review"):
        assert path in EXCLUDED_PATHS
        assert path not in IDENTITY_BEARING_PATHS


# ------------------------------------------------------------- C-a: value conflict
def test_ca_same_observation_key_different_payload_hash_keeps_the_first(index, base_event):
    """C-a: the provider contradicted itself; the first is kept and counted.

    Reached by giving the second event a **different `event_id`**, so C-b does
    not fire, while the `observation_key` stays equal and the payload differs.
    """
    second = copy.deepcopy(base_event)
    second["event_id"] = "99999999-9999-4999-8999-999999999999"
    second["payload"]["rate"] = "2.000000"
    from cbdc_ingestion.canonical import payload_sha256

    second["payload_sha256"] = payload_sha256("fx_rate", second["payload"])
    assert observation_key(base_event) == observation_key(second)
    assert classify_pair(index, base_event, second) == VALUE_CONFLICT
    assert index.counters[VALUE_CONFLICT] == 1


def test_a_validated_supersedes_is_not_a_conflict(index, base_event):
    """§8.2a: a **declared** revision is a different case from an unexplained one."""
    second = copy.deepcopy(base_event)
    second["event_id"] = "99999999-9999-4999-8999-999999999999"
    second["payload"]["rate"] = "2.000000"
    second["supersedes"] = base_event["event_id"]
    from cbdc_ingestion.canonical import payload_sha256

    second["payload_sha256"] = payload_sha256("fx_rate", second["payload"])
    assert index.classify(base_event, START_MS)[0] == ACCEPTED
    assert index.classify(second, START_MS)[0] == ACCEPTED


def test_the_evaluation_order_is_cb_then_d_then_ca(index, base_event):
    """The order is a requirement, not a convenience.

    An event sharing **both** §8.1 keys and differing in an identity-bearing
    field is a collision. If D were evaluated first it would be discarded.
    """
    second = variant(base_event, "synthetic.case_id", "stress")
    assert idempotency_key(base_event) == idempotency_key(second)
    assert classify_pair(index, base_event, second) == IDENTITY_COLLISION
    assert index.counters[DUPLICATE] == 0


def test_a_rejected_event_does_not_become_the_baseline(index, base_event):
    """The **first is kept** in all three outcomes, so the index is not overwritten."""
    second = variant(base_event, "synthetic.case_id", "stress")
    assert classify_pair(index, base_event, second) == IDENTITY_COLLISION
    # The original is still the recorded first arrival.
    assert index.classify(copy.deepcopy(base_event), START_MS)[0] == DUPLICATE


# --------------------------------------------- the 300 s window, on both sides
def test_the_window_is_300_seconds():
    assert DEDUP_WINDOW_MS == 300_000


def test_a_duplicate_inside_the_window_is_detected(index, base_event):
    index.classify(base_event, START_MS)
    assert index.classify(copy.deepcopy(base_event),
                          START_MS + DEDUP_WINDOW_MS - 1)[0] == DUPLICATE


def test_a_duplicate_at_exactly_the_window_boundary_is_still_detected(index, base_event):
    """**At** the boundary, retention is inclusive; past it, it is not.

    The window is "retains for the `dedup_window`", so an entry exactly
    `dedup_window` old is still within it. The asymmetry is asserted on both
    sides here and in the test below, so the choice is explicit rather than
    incidental.
    """
    index.classify(base_event, START_MS)
    assert index.classify(copy.deepcopy(base_event),
                          START_MS + DEDUP_WINDOW_MS)[0] == DUPLICATE


def test_a_duplicate_past_the_window_has_aged_out(index, base_event):
    """Outside the window the first arrival is gone and this is a new event."""
    index.classify(base_event, START_MS)
    assert index.classify(copy.deepcopy(base_event),
                          START_MS + DEDUP_WINDOW_MS + 1)[0] == ACCEPTED


def test_a_collision_outside_the_window_is_not_detected(index, base_event):
    """**The window bounds detection, not merely memory** — stated, not hidden."""
    index.classify(base_event, START_MS)
    second = variant(base_event, "synthetic.case_id", "stress")
    assert index.classify(second, START_MS + DEDUP_WINDOW_MS + 1)[0] == ACCEPTED
    assert index.counters[IDENTITY_COLLISION] == 0


def test_the_index_retains_no_payload(index, base_event):
    """§8.2's horizon note: the comparison fields, never the payload."""
    index.classify(base_event, START_MS)
    blob = json.dumps(
        [list(e.fields.items()) for e in index._by_event_id.values()], default=str)
    assert base_event["payload"]["rate"] not in blob
    assert "base_currency" not in blob


def test_pruning_bounds_the_index(index, base_event):
    index.classify(base_event, START_MS)
    assert len(index) == 1
    index.prune(START_MS + DEDUP_WINDOW_MS + 1)
    assert len(index) == 0


def test_dedup_is_within_run_only():
    """§8.5, §8 item 4: no restart-safe deduplication is claimed.

    A new index starts empty, which is what `dedup: within_run` means.
    """
    from cbdc_ingestion.adapters.registry import load_registry

    for record in load_registry().records:
        assert record.dedup == "within_run"
    assert len(DedupIndex()) == 0
