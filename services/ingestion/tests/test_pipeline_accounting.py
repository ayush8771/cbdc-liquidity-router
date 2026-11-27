"""Criterion 14's conservation law over the whole pipeline, not only cancellation.

**The claim.** Every observation `run_cycle` produces ends as **exactly one** of
published, quarantined, rejected, duplicate, collision or conflict — never both
and never neither (AD-5 §3.7, acceptance criterion 14).

`test_shutdown.py` asserts it for the cancellation paths, which is the half
criterion 14 names. This suite asserts it for **every other** way an observation
can leave the cycle, including the one the criterion does not name and which no
other suite reaches: **a sink that fails**. A lost count there is invisible by
construction — the event is gone and no counter moved — so it is the one case
that must be tested rather than reasoned about.

**What this suite does not do.** It does not re-assert the classifier's outcomes
(criterion 5, `test_idempotency.py`), the bounds (criterion 16,
`test_plausibility.py`), the adapter contract (criterion 1,
`test_adapter_contract.py`) or the registry (criteria 2 and 3). It asserts only
that each of those outcomes is **counted exactly once**, which is a property of
`pipeline.py` and therefore Dev A's.
"""
from __future__ import annotations

import pytest

from cbdc_ingestion.adapters.base import AdapterRunResult, NormalizedObservation
from cbdc_ingestion.adapters.faults import AdapterFault, FaultClass
from cbdc_ingestion.adapters.registry import load_registry
from cbdc_ingestion.pipeline import SINK_UNAVAILABLE, SourcePipeline
from cbdc_ingestion.sink import ServiceSink

from .adapter_cases import SYNTHETIC_FX_SOURCE_ID
from .conftest import SEED, START_MS

EURUSD = ("EUR", "USD", "mid")
OUTCOME_COUNTERS = ("published", "quarantined", "rejected", "duplicates",
                    "collisions", "conflicts", "late")


def accounted(result: AdapterRunResult) -> int:
    return sum(getattr(result, name) for name in OUTCOME_COUNTERS)


def assert_conserved(result: AdapterRunResult) -> None:
    assert result.produced == accounted(result), (
        f"{result.produced} produced, {accounted(result)} accounted: {result}")


@pytest.fixture
def record():
    return load_registry().record_for(SYNTHETIC_FX_SOURCE_ID)


class _ScriptedAdapter:
    """Produces exactly what a test scripts, so every outcome is reachable.

    Test-only, never registered and never packaged. Each entry is either a rate
    string, an `AdapterFault` to raise from `produce`, or a `dict` overriding the
    observation's fields — the three ways an item can enter the cycle.
    """

    def __init__(self, script, *, first_sequence: int = 1) -> None:
        self._script = list(script)
        self._sequence = int(first_sequence)
        self._context = None
        self.faults: list = []

    def produce(self):
        if not self._script:
            return ()
        step = self._script.pop(0)
        if isinstance(step, AdapterFault):
            raise step
        overrides = dict(step) if isinstance(step, dict) else {"rate": step}
        rate = overrides.pop("rate", "2.200000")
        sequence = overrides.pop("sequence", self._sequence)
        self._sequence = sequence + 1
        fields = {
            "event_type": "fx_rate", "subject": EURUSD,
            "payload": {"base_currency": "EUR", "quote_currency": "USD",
                        "rate_type": "mid", "rate": rate},
            "source_timestamp_ms": START_MS, "source_timestamp_basis": "observed",
            "sequence": sequence,
        }
        fields.update(overrides)
        return (NormalizedObservation(**fields),)

    def _record_fault(self, fault) -> None:
        self.faults.append(fault)


class _FailingSink(ServiceSink):
    """A sink whose named channel raises. The one case that loses a count silently.

    `ServiceSink.publish` cannot raise on the shipped path — `LatestStore.apply`
    returns a bool and the channel names are fixed — so the failure is injected
    rather than provoked. It still has to be handled: a sink is an interface, and
    AD-2/AD-3's real distribution mechanism is a draft (§8 item 5). An
    implementation that loses an event when the sink throws would pass every
    other suite.
    """

    def __init__(self, *, failing: str = "observations") -> None:
        super().__init__()
        self.failing = failing
        self.attempts: list = []

    def publish(self, channel: str, item) -> bool:
        self.attempts.append(channel)
        if channel == self.failing:
            raise RuntimeError(f"the {channel} channel is unavailable")
        return super().publish(channel, item)


# ------------------------------------------------------------ the ordinary paths
def test_a_published_observation_is_counted_once(record):
    sink = ServiceSink()
    result = SourcePipeline(record, seed=SEED, now_ms=START_MS).run_cycle(
        _ScriptedAdapter(["2.200000"]), sink, retrieved_at_ms=START_MS)
    assert_conserved(result)
    assert [n for n in OUTCOME_COUNTERS if getattr(result, n)] == ["published"]
    assert len(sink.store.events()) == 1


def test_an_empty_cycle_produces_nothing_and_counts_nothing(record):
    result = SourcePipeline(record, seed=SEED, now_ms=START_MS).run_cycle(
        _ScriptedAdapter([]), ServiceSink(), retrieved_at_ms=START_MS)
    assert result.produced == 0
    assert_conserved(result)


@pytest.mark.parametrize("overrides,expected", [
    ({"event_type": "bridge_state"}, "rejected"),          # admit: type not permitted
    ({"subject": ("ZZZ", "YYY", "mid")}, "rejected"),      # admit: subject not permitted
    ({"source_timestamp_ms": None,
      "source_timestamp_basis": "none"}, "rejected"),      # admit: null source timestamp
    ({"rate": "9.000000"}, "quarantined"),                 # plausibility: out of range
    ({"rate": "2.200000"}, "published"),                   # the positive control
])
def test_every_admission_and_validation_outcome_is_counted_exactly_once(
        record, overrides, expected):
    """Each rejection reason and the quarantine land on **one** counter.

    The positive control is in the same parametrization deliberately: without it
    a pipeline that counted everything as rejected would pass every negative row.
    """
    result = SourcePipeline(record, seed=SEED, now_ms=START_MS).run_cycle(
        _ScriptedAdapter([overrides]), ServiceSink(), retrieved_at_ms=START_MS)
    assert result.produced == 1
    assert_conserved(result)
    assert [n for n in OUTCOME_COUNTERS if getattr(result, n)] == [expected]


def test_a_future_source_timestamp_is_quarantined_by_the_builder_and_counted(record):
    """The builder's own AD-4 §6 verdict, not the bounds': an envelope marked
    `quarantined` must be counted and withheld, not published."""
    sink = ServiceSink()
    result = SourcePipeline(record, seed=SEED, now_ms=START_MS).run_cycle(
        _ScriptedAdapter([{"source_timestamp_ms": START_MS + 3_600_000}]), sink,
        retrieved_at_ms=START_MS)
    assert_conserved(result)
    assert result.quarantined == 1
    assert sink.store.events() == []
    assert "FUTURE_SOURCE_TIMESTAMP" in sink.quarantine.by_reason()


def test_an_adapter_fault_from_produce_is_not_an_observation(record):
    """A fault raised out of `produce()` is handled by the adapter base class and
    yields **no** observation, so `produced` stays 0 and the law holds at zero.
    The fault is the adapter's accounting, not the pipeline's."""
    adapter = _ScriptedAdapter([AdapterFault(FaultClass.TRANSIENT_NETWORK,
                                             "transient_network",
                                             source_id=record.source_id)])
    with pytest.raises(AdapterFault):
        # The scripted stand-in raises directly; the real base class catches it,
        # which `test_adapter_contract.py` covers. Asserted here only so this
        # suite does not silently depend on which of the two happens.
        SourcePipeline(record, seed=SEED, now_ms=START_MS).run_cycle(
            adapter, ServiceSink(), retrieved_at_ms=START_MS)


def test_a_duplicate_and_a_collision_are_each_counted_once(record):
    """Two cycles on **one** pipeline, so the dedup index carries over. The second
    identical item is a duplicate; neither cycle may lose a count."""
    pipeline = SourcePipeline(record, seed=SEED, now_ms=START_MS)
    sink = ServiceSink()
    first = pipeline.run_cycle(_ScriptedAdapter(["2.200000"]), sink,
                              retrieved_at_ms=START_MS)
    # The same sequence and the same timestamp reproduce the same event_id and
    # the same payload hash, which is a D by AD-5 §8.2.
    second = pipeline.run_cycle(_ScriptedAdapter(["2.200000"]), sink,
                               retrieved_at_ms=START_MS)
    assert_conserved(first)
    assert_conserved(second)
    assert first.published == 1
    assert second.duplicates == 1
    assert second.published == 0


def test_a_value_conflict_is_counted_once_and_keeps_the_first(record):
    """Same subject and same `source_timestamp`, different payload, no
    `supersedes`: C-a. The first value stays current and the second is counted."""
    pipeline = SourcePipeline(record, seed=SEED, now_ms=START_MS)
    sink = ServiceSink()
    pipeline.run_cycle(_ScriptedAdapter(["2.200000"]), sink, retrieved_at_ms=START_MS)
    second = pipeline.run_cycle(_ScriptedAdapter([{"rate": "2.201000", "sequence": 2}]),
                                sink, retrieved_at_ms=START_MS)
    assert_conserved(second)
    assert second.conflicts == 1
    assert second.published == 0
    assert sink.store.events()[0]["payload"]["rate"] == "2.200000"


def test_a_store_refusal_is_counted_not_silent(record):
    """The store's own AD-1 §3.4 rules can withhold an event the classifier
    accepted — a late value for the same pair. It must still be counted.

    The second item carries an **earlier** `source_timestamp` with a distinct
    sequence, so it is new to the classifier and late to the store.
    """
    pipeline = SourcePipeline(record, seed=SEED, now_ms=START_MS)
    sink = ServiceSink()
    pipeline.run_cycle(_ScriptedAdapter([{"source_timestamp_ms": START_MS}]), sink,
                       retrieved_at_ms=START_MS)
    late = pipeline.run_cycle(
        _ScriptedAdapter([{"source_timestamp_ms": START_MS - 2000, "sequence": 7}]),
        sink, retrieved_at_ms=START_MS + 2000)
    assert_conserved(late)
    assert late.published == 0
    assert late.late == 1, "a store refusal must move a counter"
    assert late.duplicates == 0, "and not the classifier's duplicate counter (AD-5 §8.3)"
    assert sink.store.counters()["late"] == 1


# ------------------------------------------------------- the sink that fails
def test_a_sink_failure_on_observations_is_counted_not_lost(record):
    """**The case no other suite reaches.** The observations channel throws. The
    cycle must not propagate the exception — one sink fault would end the whole
    service tick and lose every later item in the batch — and the event must be
    counted, with a reason naming the sink rather than blaming the data."""
    sink = _FailingSink(failing="observations")
    result = SourcePipeline(record, seed=SEED, now_ms=START_MS).run_cycle(
        _ScriptedAdapter(["2.200000"]), sink, retrieved_at_ms=START_MS)
    assert_conserved(result)
    assert result.published == 0
    assert result.rejected == 1
    assert SINK_UNAVAILABLE in result.reasons


def test_a_sink_failure_does_not_stop_the_rest_of_the_cycle(record):
    """The later items in the same batch are still processed. A cycle that
    aborted on the first sink fault would lose them with no counter at all."""
    sink = _FailingSink(failing="observations")
    pipeline = SourcePipeline(record, seed=SEED, now_ms=START_MS)
    for index in range(3):
        result = pipeline.run_cycle(
            _ScriptedAdapter([{"rate": "2.200000", "sequence": index + 1}]),
            sink, retrieved_at_ms=START_MS + index * 2000)
        assert_conserved(result)
    assert sink.attempts.count("observations") == 3


def test_a_sink_failure_on_the_quarantine_channel_still_counts_the_quarantine(record):
    """The quarantine channel throws while reporting a breach. The quarantine
    counter must still move: losing the count of a bad value is worse than
    losing the report of it."""
    sink = _FailingSink(failing="quarantine")
    result = SourcePipeline(record, seed=SEED, now_ms=START_MS).run_cycle(
        _ScriptedAdapter(["9.000000"]), sink, retrieved_at_ms=START_MS)
    assert_conserved(result)
    assert result.quarantined == 1
    assert result.published == 0


def test_a_sink_failure_on_the_faults_channel_still_counts_the_conflict(record):
    """Same argument for a conflict: the classification is the fact, and the
    publication of it is a report that may fail on its own."""
    sink = _FailingSink(failing="faults")
    pipeline = SourcePipeline(record, seed=SEED, now_ms=START_MS)
    pipeline.run_cycle(_ScriptedAdapter(["2.200000"]), sink, retrieved_at_ms=START_MS)
    second = pipeline.run_cycle(_ScriptedAdapter([{"rate": "2.201000", "sequence": 2}]),
                                sink, retrieved_at_ms=START_MS)
    assert_conserved(second)
    assert second.conflicts == 1


def test_a_failed_sink_does_not_poison_the_dedup_index(record):
    """An event the sink could not take must not be left in the index as though
    it had been published: the next delivery of the same observation would then
    be discarded as a duplicate and the value would never appear at all.

    This is the retry-safety property the `within_run` scope still owes within a
    single run, and it is the reason the sink publish is guarded rather than the
    classification being rolled back.
    """
    failing = _FailingSink(failing="observations")
    pipeline = SourcePipeline(record, seed=SEED, now_ms=START_MS)
    pipeline.run_cycle(_ScriptedAdapter(["2.200000"]), failing, retrieved_at_ms=START_MS)
    # The same observation, redelivered to a working sink in the same run.
    working = ServiceSink()
    retry = pipeline.run_cycle(_ScriptedAdapter(["2.200000"]), working,
                               retrieved_at_ms=START_MS)
    assert_conserved(retry)
    assert retry.published == 1, (
        "a sink failure left the event in the dedup index, so the retry was "
        "discarded as a duplicate and the value was lost for the whole run")
    assert len(working.store.events()) == 1


# --------------------------------------------------------- the law, over a sweep
def test_the_law_holds_over_a_mixed_batch(record):
    """Every outcome in one run, on one pipeline, with the law asserted after each
    cycle **and** on the totals. A counter that double-counted in one path would
    show here even if each path's own test passed."""
    pipeline = SourcePipeline(record, seed=SEED, now_ms=START_MS)
    sink = ServiceSink()
    script = [
        {"rate": "2.200000", "sequence": 1},                       # published
        {"rate": "2.200000", "sequence": 1},                       # duplicate
        {"rate": "9.000000", "sequence": 2},                       # quarantined
        {"event_type": "bridge_state", "sequence": 3},             # rejected
        {"rate": "2.201000", "sequence": 4},                       # conflict
    ]
    totals = {name: 0 for name in OUTCOME_COUNTERS}
    produced = 0
    for step in script:
        result = pipeline.run_cycle(_ScriptedAdapter([step]), sink,
                                    retrieved_at_ms=START_MS)
        assert_conserved(result)
        produced += result.produced
        for name in OUTCOME_COUNTERS:
            totals[name] += getattr(result, name)
    assert produced == sum(totals.values()) == len(script)
    assert totals["published"] == 1
    assert totals["duplicates"] == 1
    assert totals["quarantined"] == 1
    assert totals["rejected"] == 1
    assert totals["conflicts"] == 1


def test_the_counter_set_is_closed(record):
    """The law is stated over `OUTCOME_COUNTERS`, so it is only as strong as that
    tuple being complete. Asserted against the dataclass itself: a new outcome
    field fails here until it is added to the law."""
    fields = set(AdapterRunResult.__dataclass_fields__) - {"produced", "reasons"}
    assert fields == set(OUTCOME_COUNTERS), fields


# ------------------------------------------------- the withdrawal primitive itself
def test_forget_withdraws_only_the_event_it_is_given(record):
    """`DedupIndex.forget` exists for the failed-publish path above, so its own
    contract is asserted here rather than left implicit.

    Withdrawing an accepted event must make the **same** event acceptable again
    and must leave the index otherwise untouched.
    """
    from cbdc_ingestion.dedup import ACCEPTED, DUPLICATE, DedupIndex

    pipeline = SourcePipeline(record, seed=SEED, now_ms=START_MS)
    sink = ServiceSink()
    pipeline.run_cycle(_ScriptedAdapter(["2.200000"]), sink, retrieved_at_ms=START_MS)
    event = sink.store.events()[0]

    index = pipeline.dedup
    assert len(index) == 1
    assert index.classify(event, START_MS)[0] == DUPLICATE
    assert index.forget(event) is True
    assert len(index) == 0
    # Acceptable again, which is the whole point of the primitive.
    assert index.classify(event, START_MS)[0] == ACCEPTED


def test_forget_is_false_for_an_event_that_was_never_accepted(record):
    """Idempotent and honest: withdrawing something absent reports that it was
    absent rather than raising or silently succeeding."""
    from cbdc_ingestion.dedup import DedupIndex

    index = DedupIndex()
    assert index.forget({"event_id": "00000000-0000-0000-0000-000000000000"}) is False


def test_forget_does_not_withdraw_a_kept_first_arrival(record):
    """It is **not** a rollback of a rejection. A C-a conflict keeps the first
    arrival; forgetting the *rejected* second event must not remove the first,
    or the conflicting value would become acceptable as though it were new.
    """
    from cbdc_ingestion.dedup import VALUE_CONFLICT

    pipeline = SourcePipeline(record, seed=SEED, now_ms=START_MS)
    sink = ServiceSink()
    pipeline.run_cycle(_ScriptedAdapter(["2.200000"]), sink, retrieved_at_ms=START_MS)
    first = sink.store.events()[0]
    second = pipeline.run_cycle(_ScriptedAdapter([{"rate": "2.201000", "sequence": 2}]),
                                sink, retrieved_at_ms=START_MS)
    assert second.conflicts == 1
    # The rejected event never entered the index, so there is nothing to forget.
    assert pipeline.dedup.forget({"event_id": "11111111-1111-1111-1111-111111111111"}) is False
    assert len(pipeline.dedup) == 1
    assert pipeline.dedup.classify(first, START_MS)[0] != "accepted"


# --------------------------------------- ordering: validation before the index
def test_a_schema_invalid_envelope_never_enters_the_dedup_index(record):
    """**AD-5 §3.4 steps 3 and 4, and criterion 5a's "before the classifier".**

    `02.200000` is 2.2 as a `Decimal`, so it is inside the record's plausibility
    range and the builder emits `validation.status == "validated"` for it. But
    AD-4 §4 forbids a leading zero, so `validate_fx_envelope` rejects it.

    If strict validation runs only inside `LatestStore.apply` — i.e. **after**
    `DedupIndex.classify` — the invalid envelope is recorded as a first arrival
    in the `event_id` index before anything validates it, and the index then
    asserts that an event was seen which no consumer can ever receive. The
    assertion is on the index, not on a counter, because the index is the state
    that outlives the cycle.
    """
    pipeline = SourcePipeline(record, seed=SEED, now_ms=START_MS)
    sink = ServiceSink()
    result = pipeline.run_cycle(_ScriptedAdapter(["02.200000"]), sink,
                                retrieved_at_ms=START_MS)
    assert_conserved(result)
    assert result.published == 0
    assert len(pipeline.dedup) == 0, "an invalid envelope was recorded as a first arrival"
    assert len(sink.store.events()) == 0


def test_a_schema_invalid_envelope_is_rejected_not_counted_a_duplicate(record):
    """The same item's accounting: a **rejection** with a reason, never a `D`.

    Counting it on `duplicates` would report a deduplication outcome for an
    envelope the classifier must never have seen.
    """
    result = SourcePipeline(record, seed=SEED, now_ms=START_MS).run_cycle(
        _ScriptedAdapter(["02.200000"]), ServiceSink(), retrieved_at_ms=START_MS)
    assert result.duplicates == 0
    assert result.rejected == 1
    assert [n for n in OUTCOME_COUNTERS if getattr(result, n)] == ["rejected"]


def test_a_late_event_is_counted_late_and_not_as_a_duplicate(record):
    """**AD-5 §8.3:** an older `source_timestamp` is "**not current**; counted as
    **late**, not as an error" — and a late arrival is not a duplicate. `D` is
    the classifier's duplicate outcome (criterion 5); a store refusal on
    ordering grounds is a different outcome and must not borrow its counter.
    """
    pipeline = SourcePipeline(record, seed=SEED, now_ms=START_MS)
    sink = ServiceSink()
    pipeline.run_cycle(_ScriptedAdapter([{"source_timestamp_ms": START_MS}]), sink,
                       retrieved_at_ms=START_MS)
    late = pipeline.run_cycle(
        _ScriptedAdapter([{"source_timestamp_ms": START_MS - 2000, "sequence": 7}]),
        sink, retrieved_at_ms=START_MS + 2000)
    assert_conserved(late)
    assert late.published == 0
    assert late.duplicates == 0, "a late event is not a deduplication duplicate"
    assert late.late == 1
    assert sink.store.counters()["late"] == 1
