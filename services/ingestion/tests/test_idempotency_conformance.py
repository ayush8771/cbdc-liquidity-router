"""AD-5 v0.8 criteria 5 and 5a against the REAL dedup.py / pipeline.py (Dev B conformance).

Activated from the former pending integration module. Bound against the adapter-path
interfaces confirmed at origin/feature/phase3-33a-adapters **a9a3742** (tested from an
export of that commit; not merged into this branch):

- `dedup.DedupIndex(window_ms=300_000).classify(event, now_ms) -> (outcome, detail)`,
  outcomes `accepted | duplicate | value_conflict | identity_collision`; `forget(event)`;
- `validation.validate_fx_envelope` / `EnvelopeInvalid`;
- `pipeline.SourcePipeline(record, seed=..., now_ms=0).run_cycle(adapter, sink, retrieved_at_ms=...)`,
  one persistent pipeline across cycles.

**Nothing here classifies.** `Binding` only translates the real outcome strings to the AD-5
§8.2 labels used by the fixtures (C-b / D / C-a / NEW). Every outcome comes from `DedupIndex`.

Open questions from the pending file, as answered by a9a3742:
  Q1  classifier input = the envelope plus `now_ms`; it never sees the batch wrapper, so a
      wrapper `instance_id` cannot reach it — case (p) is a byte-identical redelivery.  RESOLVED
  Q2  outcomes are `classify`'s strings; counters are `DedupIndex.counters`; on the pipeline a
      C-b is *rejected* (faults channel `identity_collision`, `AdapterRunResult.collisions`) and a
      D is *discarded* (`duplicates`, nothing on any reason channel).                  RESOLVED
  Q3  run_cycle order: admit -> plausibility -> build -> builder-verdict -> classify -> publish.
      The strict validator runs inside publication, i.e. AFTER classification (see 5a below). RESOLVED
  Q4  inclusive at 300 000 ms on `now_ms` (`retrieved_at_ms` on the pipeline).          RESOLVED
  Q5  a rejected / discarded arrival is never written to the index (seq-cb-repeat).    RESOLVED
  Q6  default `IngestionService(seed)` builds no SourcePipeline; D-24 stays on LatestStore. RESOLVED
"""
from __future__ import annotations

import copy

import pytest

from cbdc_ingestion.adapters.registry import load_registry
from cbdc_ingestion.adapters.synthetic_fx import SyntheticFxAdapter
from cbdc_ingestion.clock import ManualClock
from cbdc_ingestion.dedup import (
    ACCEPTED,
    DEDUP_WINDOW_MS as PRODUCTION_WINDOW_MS,
    DUPLICATE,
    IDENTITY_COLLISION,
    VALUE_CONFLICT,
    DedupIndex,
)
from cbdc_ingestion.pairs import Pair
from cbdc_ingestion.pipeline import SINK_UNAVAILABLE, SourcePipeline
from cbdc_ingestion.service import IngestionService
from cbdc_ingestion.sink import ServiceSink
from cbdc_ingestion.store import LatestStore
from cbdc_ingestion.validation import EnvelopeInvalid, validate_fx_envelope

from .adapter_cases import make_context
from .conformance_support import envelope_validator, schema_errors
from .conftest import SEED, START_MS
from .envelope_validation_cases import INVALID_CASES
from .idempotency_cases import (ADAPTER_SEED, ALT_RATE, BASE_RATE, BASE_SEQUENCE, CA, CB, D,
                                DEDUP_WINDOW_MS, NEW, PAIR_CASES, SEQUENCE_CASES, WINDOW_CASES)

ADAPTER_SOURCE_ID = "synthetic.fx"

# The only translation: production outcome string -> AD-5 §8.2 label. No decision is made here.
LABEL = {IDENTITY_COLLISION: CB, DUPLICATE: D, VALUE_CONFLICT: CA, ACCEPTED: NEW}


class Binding:
    """Thin calls into the real modules. No mocks, no re-implemented classification."""

    def new_classifier(self) -> DedupIndex:
        return DedupIndex(window_ms=DEDUP_WINDOW_MS)

    def classify(self, classifier: DedupIndex, envelope: dict, *, arrival_ms: int = 0,
                 instance_id: str | None = None) -> str:
        # Q1: `instance_id` lives on the batch wrapper; the real classifier has no parameter for it.
        outcome, _detail = classifier.classify(copy.deepcopy(envelope), arrival_ms)
        return LABEL[outcome]

    def counters(self, classifier: DedupIndex) -> dict:
        c = classifier.counters
        return {CB: c[IDENTITY_COLLISION], D: c[DUPLICATE], CA: c[VALUE_CONFLICT], NEW: c[ACCEPTED]}


@pytest.fixture
def binding() -> Binding:
    return Binding()


# --- the fixtures agree with production constants --------------------------

def test_fixture_window_is_the_production_window():
    assert DEDUP_WINDOW_MS == PRODUCTION_WINDOW_MS == 300_000


def test_fixture_adapter_seed_is_the_registry_allocation():
    assert load_registry().allocation_for(ADAPTER_SOURCE_ID).seed == ADAPTER_SEED


# --- criterion 5: the direct-classifier cases, pairs (a)–(s), C-a and controls

@pytest.mark.parametrize("case", PAIR_CASES, ids=lambda c: c.case_id)
def test_pair_outcome(binding, case):
    validator = envelope_validator()
    assert not schema_errors(validator, case.first) and not schema_errors(validator, case.second)
    clf = binding.new_classifier()
    ids = case.wrapper_instance_ids or (None, None)
    assert binding.classify(clf, case.first, instance_id=ids[0]) == NEW
    assert binding.classify(clf, case.second, instance_id=ids[1]) == case.expected


@pytest.mark.parametrize("case", [c for c in PAIR_CASES if c.direct_classifier_only], ids=lambda c: c.case_id)
def test_direct_classifier_only_cases_are_refused_by_the_strict_validator(case):
    """The nine cases (g2, h, i, j, k, k2, l, m, r) cannot reach dedup through run_cycle."""
    with pytest.raises(EnvelopeInvalid):
        validate_fx_envelope(case.second)


@pytest.mark.parametrize("case", [c for c in PAIR_CASES if c.expected in (CB, D, CA)], ids=lambda c: c.case_id)
def test_outcome_is_counted_once_and_the_first_is_kept(binding, case):
    clf = binding.new_classifier()
    binding.classify(clf, case.first)
    outcome = binding.classify(clf, case.second)
    counts = binding.counters(clf)
    assert counts[outcome] == 1 and counts[NEW] == 1
    assert sum(counts.values()) == 2
    assert len(clf) == 1  # the second never became an index entry


def test_c_b_detail_names_the_differing_field():
    case = next(c for c in PAIR_CASES if c.case_id == "a")
    clf = DedupIndex(window_ms=DEDUP_WINDOW_MS)
    clf.classify(case.first, 0)
    outcome, detail = clf.classify(case.second, 0)
    assert outcome == IDENTITY_COLLISION and detail == ("synthetic.case_id",)
    assert clf.collision_fields == {"synthetic.case_id": 1}


@pytest.mark.parametrize("cid, would_otherwise_be", [("c", D), ("e", D), ("k", D), ("f", CA)])
def test_precedence_c_b_before_d_before_c_a(binding, cid, would_otherwise_be):
    """(c)/(e)/(k) share both §8.1 keys (would be D); (f) satisfies C-a. C-b must win each."""
    case = next(c for c in PAIR_CASES if c.case_id == cid)
    assert case.shares_event_id
    assert case.shares_idempotency_key is (would_otherwise_be == D)
    clf = binding.new_classifier()
    binding.classify(clf, case.first)
    assert binding.classify(clf, case.second) == CB


def test_precedence_d_before_c_a(binding):
    """d-new-id: same idempotency_key (so also same observation_key) -> D, never C-a."""
    case = next(c for c in PAIR_CASES if c.case_id == "d-new-id")
    clf = binding.new_classifier()
    binding.classify(clf, case.first)
    assert binding.classify(clf, case.second) == D


@pytest.mark.parametrize("case", SEQUENCE_CASES, ids=lambda c: c.case_id)
def test_first_is_kept(binding, case):
    clf = binding.new_classifier()
    assert tuple(binding.classify(clf, e) for e in case.events) == case.expected


@pytest.mark.parametrize("case", WINDOW_CASES, ids=lambda c: c.case_id)
def test_window_boundary(binding, case):
    assert case.expected is not None, f"{case.case_id}: unresolved — {case.open_question}"
    pair = next(c for c in PAIR_CASES if c.case_id == case.pair_case_id)
    clf = binding.new_classifier()
    binding.classify(clf, pair.first, arrival_ms=0)
    outcome = binding.classify(clf, pair.second, arrival_ms=case.second_arrival_offset_ms)
    assert outcome == case.expected
    if case.not_expected is not None:
        assert outcome != case.not_expected


def test_rejected_events_do_not_refresh_the_window(binding):
    """A C-b at T+200 000 and a D at T+250 000 must not extend the first's T+300 000 expiry."""
    a = next(c for c in PAIR_CASES if c.case_id == "a")
    clf = binding.new_classifier()
    assert binding.classify(clf, a.first, arrival_ms=0) == NEW
    assert binding.classify(clf, a.second, arrival_ms=200_000) == CB
    assert binding.classify(clf, a.first, arrival_ms=250_000) == D
    assert binding.classify(clf, a.second, arrival_ms=DEDUP_WINDOW_MS + 1) == NEW


# --- DedupIndex.forget() -----------------------------------------------------

def test_forget_withdraws_an_accepted_event_so_its_retry_is_accepted():
    case = next(c for c in PAIR_CASES if c.case_id == "s")
    clf = DedupIndex(window_ms=DEDUP_WINDOW_MS)
    assert clf.classify(case.first, 0)[0] == ACCEPTED
    assert clf.forget(case.first) is True
    assert len(clf) == 0 and clf.counters[ACCEPTED] == 0
    assert clf.classify(case.second, 1)[0] == ACCEPTED  # not D
    assert clf.counters[DUPLICATE] == 0


def test_forget_of_an_unknown_event_is_a_no_op():
    case = next(c for c in PAIR_CASES if c.case_id == "s")
    clf = DedupIndex(window_ms=DEDUP_WINDOW_MS)
    assert clf.forget(case.first) is False
    assert clf.counters[ACCEPTED] == 0


# --- criterion 5 through the persistent adapter-path pipeline ----------------

class _ReplayFx(SyntheticFxAdapter):
    """Test-only: the real SyntheticFxAdapter.normalize over queued raw items, so a
    cycle can redeliver an observation. Lives in tests/, never in cbdc_ingestion."""

    def __init__(self, source_id: str, seed: int) -> None:
        super().__init__(source_id, seed)
        self.queue: list = []

    def _produce(self):
        out, self.queue = tuple(self.normalize(raw) for raw in self.queue), []
        return out


class _FailOnceSink(ServiceSink):
    """The real ServiceSink, except the first `observations` publish raises."""

    def __init__(self) -> None:
        super().__init__()
        self.failures_left = 1

    def publish(self, channel, item):
        if channel == "observations" and self.failures_left:
            self.failures_left -= 1
            raise RuntimeError("sink down")
        return super().publish(channel, item)


def _raw(*, rate: str = BASE_RATE, sequence: int = BASE_SEQUENCE, at_ms: int = START_MS) -> dict:
    return {"pair": Pair("USD", "INR"), "rate": rate, "at_ms": at_ms, "sequence": sequence}


class _Harness:
    def __init__(self, sink: ServiceSink | None = None) -> None:
        registry = load_registry()
        record = registry.record_for(ADAPTER_SOURCE_ID)
        seed = registry.allocation_for(ADAPTER_SOURCE_ID).seed
        self.adapter = _ReplayFx(record.source_id, seed)
        self.adapter.start(make_context(self.adapter, clock=ManualClock(START_MS)))
        self.sink = sink or ServiceSink()
        self.pipeline = SourcePipeline(record, seed=seed, now_ms=0)  # persistent across cycles

    def cycle(self, *raws, retrieved_at_ms: int):
        self.adapter.queue.extend(raws)
        return self.pipeline.run_cycle(self.adapter, self.sink, retrieved_at_ms=retrieved_at_ms)

    @property
    def dedup(self) -> dict:
        return dict(self.pipeline.dedup.counters)

    def current_rate(self) -> str:
        return self.sink.store.latest_for("USD/INR")["payload"]["rate"]


R0 = START_MS + 100


def test_pipeline_redelivery_is_discarded_as_d_not_rejected():
    h = _Harness()
    assert h.cycle(_raw(), retrieved_at_ms=R0).published == 1
    second = h.cycle(_raw(), retrieved_at_ms=R0 + 2000)
    assert (second.published, second.duplicates, second.collisions, second.rejected) == (0, 1, 0, 0)
    assert h.dedup[DUPLICATE] == 1
    assert h.sink.faults.total == 0 and h.sink.quarantine.total == 0  # discarded, never reported as a fault


def test_pipeline_c_b_is_rejected_first_kept_then_redelivery_d_then_repeat_c_b():
    """Case (f) through run_cycle (same seed/pair/sequence/timestamp => same event_id, new rate),
    then seq-cb-first-kept and seq-cb-repeat on the same persistent pipeline."""
    h = _Harness()
    assert h.cycle(_raw(), retrieved_at_ms=R0).published == 1
    cb = h.cycle(_raw(rate=ALT_RATE), retrieved_at_ms=R0 + 1000)
    assert (cb.collisions, cb.duplicates, cb.conflicts, cb.published) == (1, 0, 0, 0)
    assert any(r.startswith("identity_collision:") and "payload_sha256" in r for r in cb.reasons)
    assert h.sink.faults.by_reason() == {"identity_collision": 1}
    assert h.current_rate() == BASE_RATE
    assert h.cycle(_raw(), retrieved_at_ms=R0 + 2000).duplicates == 1
    assert h.cycle(_raw(rate=ALT_RATE), retrieved_at_ms=R0 + 3000).collisions == 1
    assert h.dedup == {ACCEPTED: 1, IDENTITY_COLLISION: 2, DUPLICATE: 1, VALUE_CONFLICT: 0}
    assert h.current_rate() == BASE_RATE


def test_pipeline_c_a_keeps_the_first_and_its_redelivery_is_d():
    h = _Harness()
    h.cycle(_raw(), retrieved_at_ms=R0)
    ca = h.cycle(_raw(rate=ALT_RATE, sequence=BASE_SEQUENCE + 1), retrieved_at_ms=R0 + 1000)
    assert (ca.conflicts, ca.collisions, ca.duplicates, ca.published) == (1, 0, 0, 0)
    assert h.sink.faults.by_reason() == {"value_conflict": 1}
    assert h.current_rate() == BASE_RATE
    assert h.cycle(_raw(), retrieved_at_ms=R0 + 2000).duplicates == 1
    assert h.dedup == {ACCEPTED: 1, IDENTITY_COLLISION: 0, DUPLICATE: 1, VALUE_CONFLICT: 1}


@pytest.mark.parametrize("offset, outcome", [(DEDUP_WINDOW_MS, DUPLICATE), (DEDUP_WINDOW_MS + 1, ACCEPTED)])
def test_pipeline_window_boundary_on_retrieved_at(offset, outcome):
    h = _Harness()
    h.cycle(_raw(), retrieved_at_ms=R0)
    h.cycle(_raw(), retrieved_at_ms=R0 + offset)
    assert h.dedup[outcome] == (2 if outcome == ACCEPTED else 1)


def test_pipeline_c_b_after_the_window_is_not_detected_by_dedup_and_the_store_withholds_it():
    """AD-5 §8.2: outside the window a collision is accepted as new by dedup. LatestStore (AD-1 §3.4,
    unchanged) still withholds it as `late`, so the first stays current."""
    h = _Harness()
    h.cycle(_raw(), retrieved_at_ms=R0)
    late = h.cycle(_raw(rate=ALT_RATE), retrieved_at_ms=R0 + DEDUP_WINDOW_MS + 1)
    assert h.dedup[IDENTITY_COLLISION] == 0 and h.dedup[ACCEPTED] == 2
    assert late.published == 0 and h.sink.store.counters()["late"] == 1
    assert h.current_rate() == BASE_RATE


def test_pipeline_failed_publication_is_forgotten_so_the_retry_publishes():
    h = _Harness(sink=_FailOnceSink())
    first = h.cycle(_raw(), retrieved_at_ms=R0)
    assert (first.published, first.rejected, first.duplicates) == (0, 1, 0)
    assert SINK_UNAVAILABLE in first.reasons
    assert len(h.pipeline.dedup) == 0 and h.dedup[ACCEPTED] == 0  # forget() withdrew it
    retry = h.cycle(_raw(), retrieved_at_ms=R0 + 2000)
    assert (retry.published, retry.duplicates) == (1, 0)
    assert h.dedup == {ACCEPTED: 1, IDENTITY_COLLISION: 0, DUPLICATE: 0, VALUE_CONFLICT: 0}
    assert h.current_rate() == BASE_RATE


# --- criterion 5a: rejected at validation, before classification -------------
#
# pipeline.run_cycle accepts NormalizedObservations only and builds envelopes with the unchanged
# envelope.py; there is no entry point for a pre-built envelope, and the strict validator runs
# inside publication (after classification). So 5a is bound as the confirmed validator composed
# in front of a real classifier: the validator must reject, and the classifier must be untouched.

@pytest.mark.parametrize("case", INVALID_CASES, ids=lambda c: c.case_id)
def test_invalid_envelope_is_rejected_before_classification(case):
    clf = DedupIndex(window_ms=DEDUP_WINDOW_MS)
    with pytest.raises(EnvelopeInvalid):
        validate_fx_envelope(copy.deepcopy(case.envelope))
        clf.classify(case.envelope, 0)  # reached only if validation wrongly passed
    assert len(clf) == 0 and sum(clf.counters.values()) == 0


# --- D-24 path: AD-1 §3.4 unchanged (AD5-Q11(a)) ------------------------------

def test_default_d24_path_is_unchanged_by_the_adapter_classifier():
    """`d-new-id` is D on the adapter path but withheld by LatestStore (`late`) on the D-24 path,
    and the default service builds no SourcePipeline / DedupIndex at all."""
    case = next(c for c in PAIR_CASES if c.case_id == "d-new-id")
    store = LatestStore()
    assert store.apply(copy.deepcopy(case.first)) is True
    assert store.apply(copy.deepcopy(case.second)) is False
    assert store.counters()["late"] == 1 and store.counters()["duplicate"] == 0

    service = IngestionService(SEED, clock=ManualClock(START_MS), start_ms=START_MS)
    service.start(run_loop=False)
    try:
        service.tick()
        assert service.sources == () and service.internal_statuses() == {}
    finally:
        service.stop()
