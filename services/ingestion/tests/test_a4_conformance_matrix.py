"""Phase 3.3-S A-4: the Dev B conformance matrix, bound to `TRANSPORT_CASES` by id.

**Written against `docs/PHASE3_A4_INTERFACE.md` at adapter commit eb68f9b8**, using
only the surface §2 declares stable: `TRANSPORT_CASES`, `TransportCase`, `case`,
`scripted_adapter`, `pipeline_for`, `clean_values`, the fake-provider step
vocabulary, and the adapter fields §3 lists (`state`, `snapshot()`,
`transport_calls`, `deferrals`, `breaker`, `backoff`, `next_attempt_ms`). No
private case fixture is added (§8): every scripted fault is a catalogue id, and
the only steps built here are compositions of the declared vocabulary.

**What this file adds to the A-4 suites, rather than repeats.** The adapter's
own suites assert what the adapter does with one fault. This matrix asserts, for
**every** catalogue id, what the **service** does with it through the real
`SourcePipeline`: the counter it lands in, exactly once; the internal status it
produces; that nothing is fabricated in its place; and that the conservation law
of acceptance criterion 14 holds. It then drives `Retry-After`, the breaker and a
mixed sequence end to end, and pins the AD-5 §7.1 partition the shipped path
depends on.

**What it deliberately does not assert.** Behaviour this review found to be
defective (see the Dev B review notes, not this file) is **not** encoded here in
either direction: asserting the current behaviour would bless a defect, and
asserting the intended behaviour would add a failing test or a skip, which this
task does not permit. Timing numbers are read from the profile, never
hard-coded (interface §3).
"""
from __future__ import annotations

import ast
import inspect
import sys

import pytest

from cbdc_ingestion.adapters import faults as faults_module
from cbdc_ingestion.adapters.faults import FaultClass
from cbdc_ingestion.adapters.retry import (
    RETRY_AFTER_ABSENT,
    RETRY_AFTER_CLAMPED,
    RETRY_AFTER_HONOURED,
    RETRY_AFTER_INVALID,
    no_jitter,
)
from cbdc_ingestion.adapters.simulated_fx import (
    DEFERRED_BACKOFF,
    DEFERRED_BREAKER_OPEN,
    SimulatedTransportFxAdapter,
)
from cbdc_ingestion.adapters.simulation import SIMULATION_TIMING as P
from cbdc_ingestion.status import OUTAGE_CONSECUTIVE_FAILURES

from .a4_support import (
    IMPLAUSIBLE_RATE,
    TRANSPORT_CASES,
    case,
    clean_values,
    pipeline_for,
    record,
    scripted_adapter,
)
from .conftest import SEED, START_MS

# The criterion 14 outcome counters, restated here rather than imported from
# another test module so this matrix does not depend on that module's layout.
OUTCOME_COUNTERS = ("published", "quarantined", "rejected", "duplicates",
                    "collisions", "conflicts", "late")

# A cycle that publishes must run past the last pair's scheduled moment, or the
# unchanged builder quarantines a future timestamp (asserted in
# `test_a4_integration.py`). Generous, and not a profile timing number.
SETTLE_MS = 10_000


# ------------------------------------------------------------------- the matrix
# The **expected** AD-5 §7.1 consequence of each catalogue id, written out
# independently of the catalogue so that the two are cross-checked rather than
# one being read back from the other. `None` means "must not fault".
#
#   (fault_class, permanent, adapter_state_after, internal_status_after)
#
# The five `slice` rows (A4-11 .. A4-15) record the slice's current choice,
# which the interface document asks Dev B to review. They are asserted as the
# behaviour *as implemented and declared*, and `SLICE_ROWS` pins that exactly
# those five are the ones AD-5 does not name, so an owner reclassification lands
# as a deliberate edit to this table rather than a silent drift.
EXPECTED = {
    "A4-01": (FaultClass.TRANSIENT_NETWORK, False, "degraded", "starting"),
    # Target A reclassification: a provider-closed stream is the provider
    # failing, not our side of the connection. Recoverable either way, so the
    # retry, the adapter state and the status are unchanged.
    "A4-02": (FaultClass.PROVIDER_UNAVAILABLE, False, "degraded", "starting"),
    "A4-03": (FaultClass.PROVIDER_UNAVAILABLE, False, "degraded", "starting"),
    "A4-04": (FaultClass.PROVIDER_UNAVAILABLE, False, "degraded", "starting"),
    "A4-05": (FaultClass.RATE_LIMITED, False, "degraded", "starting"),
    "A4-06": (FaultClass.AUTH_FAILURE, True, "failed_permanent", "down"),
    "A4-07": (FaultClass.AUTH_FAILURE, True, "failed_permanent", "down"),
    "A4-08": (FaultClass.CONTRACT_VIOLATION, True, "failed_permanent", "down"),
    "A4-09": (FaultClass.CONTRACT_VIOLATION, True, "failed_permanent", "down"),
    "A4-10": (FaultClass.CONTRACT_VIOLATION, True, "failed_permanent", "down"),
    "A4-11": (FaultClass.CONTRACT_VIOLATION, True, "failed_permanent", "down"),
    "A4-12": (FaultClass.CONTRACT_VIOLATION, True, "failed_permanent", "down"),
    "A4-13": (FaultClass.CONTRACT_VIOLATION, True, "failed_permanent", "down"),
    "A4-14": (FaultClass.CONTRACT_VIOLATION, True, "failed_permanent", "down"),
    "A4-15": (FaultClass.CONTRACT_VIOLATION, True, "failed_permanent", "down"),
    # An item fault changes no adapter state and no source status (§7.1).
    "A4-16": (FaultClass.ITEM_INVALID, False, "starting", "starting"),
    # Target A classification A4-19: an item for an undeclared subject is one
    # item's fault, non-permanent, and changes no adapter or source state.
    "A4-19": (FaultClass.ITEM_INVALID, False, "starting", "starting"),
    "A4-17": (None, False, "running", "ok"),
    "A4-18": (None, False, "starting", "starting"),
}
SLICE_ROWS = ("A4-11", "A4-12", "A4-13", "A4-14", "A4-15")
CASE_IDS = tuple(c.case_id for c in TRANSPORT_CASES)
WHOLE_RESPONSE_IDS = tuple(
    cid for cid in CASE_IDS
    if EXPECTED[cid][0] is not None and EXPECTED[cid][0] not in faults_module.ITEM_FAULTS)


def accounted(result) -> int:
    return sum(getattr(result, name) for name in OUTCOME_COUNTERS)


def run(pipeline, adapter, sink, context, *, advance_ms: int = 0):
    if advance_ms:
        context.clock.advance_ms(advance_ms)
    return pipeline.run_cycle(adapter, sink, retrieved_at_ms=context.clock.now_ms())


def settle_for(case_id: str) -> int:
    """Only the clean control publishes, so only it needs the settling advance;
    every other case runs at the start moment, inside the silence window, so the
    status asserted is the fault's and not the silence criterion's."""
    return SETTLE_MS if case_id == "A4-17" else 0


# --------------------------------------------------- the matrix is the catalogue
def test_the_matrix_binds_every_catalogue_id_and_nothing_else():
    """A new id fails here until it is classified in the matrix; a removed id
    fails here too. Bound by id, never by index (interface §2.1)."""
    assert set(EXPECTED) == set(CASE_IDS)


@pytest.mark.parametrize("case_id", CASE_IDS)
def test_the_catalogue_declares_what_the_matrix_expects(case_id):
    expected_class, expected_permanent, _, _ = EXPECTED[case_id]
    declared = case(case_id)
    assert declared.fault_class == expected_class
    assert declared.permanent == expected_permanent
    if expected_class is not None:
        assert declared.permanent == faults_module.is_permanent(expected_class)


def test_exactly_the_five_slice_rows_carry_the_slice_authority():
    """AD-5 §7.3 lists these conditions without naming a class. Pinned so that
    an owner reclassification is an explicit edit, never an omission."""
    assert tuple(c.case_id for c in TRANSPORT_CASES if c.authority == "slice") == SLICE_ROWS
    for case_id in SLICE_ROWS:
        assert case(case_id).fault_class is FaultClass.CONTRACT_VIOLATION


# ------------------------------------------- every id, through the real service
@pytest.mark.parametrize("case_id", CASE_IDS)
def test_each_case_lands_in_exactly_one_counter_through_the_pipeline(case_id):
    """Criterion 14 and AD-5 §7.5, per id: the fault is counted once, on the
    right counter, reported on the `faults` channel by its reason, and the
    conservation law over produced observations still holds."""
    expected_class, _, _, _ = EXPECTED[case_id]
    declared = case(case_id)
    pipeline, sink = pipeline_for()
    adapter, context, transport = scripted_adapter([declared.step])

    result = run(pipeline, adapter, sink, context, advance_ms=settle_for(case_id))

    assert transport.fetches == 1
    assert accounted(result) == result.produced, "criterion 14's law"
    faults_by_reason = sink.counters()["faults"]["by_reason"]
    if expected_class is None:
        assert result.faults == 0 and result.item_faults == 0
        assert sink.counters()["faults"]["total"] == 0
    elif expected_class in faults_module.ITEM_FAULTS:
        assert result.item_faults == 1 and result.faults == 0
        assert faults_by_reason == {declared.reason: 1}
    else:
        assert result.faults == 1 and result.item_faults == 0
        assert result.produced == 0, "a whole-response fault yields no observation"
        assert faults_by_reason == {declared.reason: 1}


@pytest.mark.parametrize("case_id", CASE_IDS)
def test_each_case_produces_the_adapter_and_status_states_its_class_requires(case_id):
    _, _, adapter_state, status_state = EXPECTED[case_id]
    pipeline, sink = pipeline_for()
    adapter, context, _ = scripted_adapter([case(case_id).step])

    run(pipeline, adapter, sink, context, advance_ms=settle_for(case_id))

    assert adapter.state == adapter_state
    assert pipeline.status.state == status_state
    failures = pipeline.status.snapshot()["consecutive_failures"]
    if case_id in WHOLE_RESPONSE_IDS and not case(case_id).permanent:
        assert failures == 1, "a recoverable whole-response fault is one failed poll"
    else:
        assert failures == 0


@pytest.mark.parametrize("case_id", WHOLE_RESPONSE_IDS + ("A4-16",))
def test_no_fault_case_fabricates_an_observation(case_id):
    """AD-5 §7.5: no last value carried forward, no interpolation, no substitute.
    Nothing reaches the store, and nothing is quarantined in its place either."""
    pipeline, sink = pipeline_for()
    adapter, context, _ = scripted_adapter([case(case_id).step])

    result = run(pipeline, adapter, sink, context, advance_ms=SETTLE_MS)

    assert result.published == 0
    assert sink.store.events() == []
    assert sink.counters()["quarantine"]["total"] == 0


@pytest.mark.parametrize("case_id", CASE_IDS)
def test_a_fault_is_never_counted_again_by_a_later_cycle(case_id):
    """Exactly-once across cycles, which is what the drain exists to guarantee.
    The second cycle runs at the same moment, so every gate defers and no new
    request is made; it must add nothing to any counter."""
    pipeline, sink = pipeline_for()
    adapter, context, transport = scripted_adapter([case(case_id).step])
    run(pipeline, adapter, sink, context, advance_ms=settle_for(case_id))
    totals = sink.counters()["faults"]["total"]

    second = run(pipeline, adapter, sink, context)

    assert transport.fetches == 1
    assert (second.faults, second.item_faults, second.produced) == (0, 0, 0)
    assert sink.counters()["faults"]["total"] == totals


@pytest.mark.parametrize("case_id", [cid for cid in CASE_IDS if case(cid).permanent])
def test_a_permanent_case_is_never_retried_and_stays_down_in_the_service(case_id):
    """AD-5 §7.1/§7.2 and A-7: no retry, at any later time, and `down` is left by
    an operator action only. Asserted on the transport's own call count."""
    pipeline, sink = pipeline_for()
    adapter, context, transport = scripted_adapter([case(case_id).step], repeating=True)
    run(pipeline, adapter, sink, context)

    for _ in range(5):
        run(pipeline, adapter, sink, context,
            advance_ms=P.breaker_cooldown_ms + P.backoff_ceiling_ms + P.retry_after_max_ms)

    assert transport.fetches == 1
    assert adapter.next_attempt_ms is None, "no wait is set for a permanent fault"
    assert pipeline.status.state == "down"
    assert sink.counters()["faults"]["total"] == 1


# ------------------------------------------------- Retry-After, end to end
def _clamped(ms: int) -> int:
    return min(max(ms, P.retry_after_min_ms), P.retry_after_max_ms)


def _first_fault(step):
    """One fault on a fresh adapter, with jitter at the interval's ceiling so the
    computed wait is exactly `cap_ms(1)`. Returns the adapter, its context, the
    transport, and the gate it set relative to now."""
    adapter, context, transport = scripted_adapter([step, case("A4-17").step],
                                                   jitter=no_jitter)
    adapter.produce()
    return adapter, context, transport, adapter.next_attempt_ms - context.clock.now_ms()


def test_retry_after_one_second_lies_inside_the_simulation_clamp():
    """Precondition for the honoured cases below, read from the profile rather
    than assumed (interface §3: the numbers may be retuned)."""
    assert P.retry_after_min_ms <= 1000 <= P.retry_after_max_ms


def test_a_rate_limit_with_a_valid_retry_after_gates_the_next_request():
    """A4-05 through the adapter's gate: the wait is the larger of the header and
    the computed backoff (§7.4), no request is made before it, and one is made
    at it."""
    adapter, context, transport, gate = _first_fault(case("A4-05").step)

    assert gate == max(_clamped(1000), adapter.backoff.cap_ms(1))
    assert adapter.snapshot()["deferrals"][DEFERRED_BACKOFF] == 0
    context.clock.advance_ms(gate - 1)
    adapter.produce()
    assert transport.fetches == 1
    assert adapter.deferrals[DEFERRED_BACKOFF] == 1
    context.clock.advance_ms(1)
    adapter.produce()
    assert transport.fetches == 2


@pytest.mark.parametrize("status", [503, 500])
def test_a_provider_unavailable_retry_after_overrides_the_computed_wait(status):
    """§7.2: for `provider_unavailable` the header **overrides**, clamped."""
    from fake_provider import StatusFault

    adapter, _, _, gate = _first_fault(StatusFault(status, retry_after="1"))
    assert adapter.last_decision.retry_after_reason == RETRY_AFTER_HONOURED
    assert gate == _clamped(1000)


@pytest.mark.parametrize("status", [429, 503])
def test_an_absent_retry_after_uses_the_computed_backoff(status):
    from fake_provider import StatusFault

    adapter, _, _, gate = _first_fault(StatusFault(status))
    assert adapter.last_decision.retry_after_reason == RETRY_AFTER_ABSENT
    assert gate == adapter.backoff.cap_ms(1)


@pytest.mark.parametrize("status", [429, 503])
@pytest.mark.parametrize("header", ["soon", "-1", "1.5", "Wed, 21 Oct 2026 07:28:00 GMT", "0x10"])
def test_an_invalid_retry_after_falls_back_to_the_computed_backoff(status, header):
    """§13 A-4 "invalid", including the HTTP-date form AD-5 §3.5 makes
    unreadable without a wall clock (interface §6). Never a guess."""
    from fake_provider import StatusFault

    adapter, _, _, gate = _first_fault(StatusFault(status, retry_after=header))
    assert adapter.last_decision.retry_after_reason == RETRY_AFTER_INVALID
    assert gate == adapter.backoff.cap_ms(1)


@pytest.mark.parametrize("status", [429, 503])
def test_a_retry_after_beyond_the_ceiling_is_clamped_not_honoured(status):
    from fake_provider import StatusFault

    seconds = P.retry_after_max_ms // 1000 + 60
    adapter, _, _, gate = _first_fault(StatusFault(status, retry_after=str(seconds)))
    assert adapter.last_decision.retry_after_reason == RETRY_AFTER_CLAMPED
    if status == 429:
        assert gate == max(P.retry_after_max_ms, adapter.backoff.cap_ms(1))
    else:
        assert gate == P.retry_after_max_ms


def test_a_zero_retry_after_never_shortens_a_rate_limited_wait():
    """§7.4: "a `rate_limited` fault never shortens the next wait". With the
    attempt counter high enough that the computed backoff exceeds the clamp's
    floor, a `Retry-After: 0` must still wait the full computed interval."""
    from fake_provider import StatusFault

    attempts = 1
    while P.backoff_base_ms << (attempts - 1) <= P.retry_after_min_ms:
        attempts += 1
    script = [StatusFault(503)] * (attempts - 1) + [StatusFault(429, retry_after="0")]
    adapter, context, transport = scripted_adapter(script, jitter=no_jitter)
    for _ in range(attempts):
        if adapter.next_attempt_ms is not None:
            context.clock.set_ms(max(adapter.next_attempt_ms,
                                     context.clock.now_ms() + P.min_request_interval_ms))
        adapter.produce()

    assert transport.fetches == attempts
    gate = adapter.next_attempt_ms - context.clock.now_ms()
    assert adapter.last_decision.retry_after_reason == RETRY_AFTER_CLAMPED
    assert gate == adapter.backoff.cap_ms(attempts) > P.retry_after_min_ms


# ------------------------------------------------- the breaker, through the service
def _fail_to_open(pipeline, adapter, sink, context):
    for _ in range(P.breaker_failure_threshold):
        run(pipeline, adapter, sink, context, advance_ms=P.min_request_interval_ms)
    assert adapter.breaker.state == "open"


def _deferred(context) -> int:
    return sum(v for k, v in context.metrics.snapshot()["counters"].items()
               if k.startswith("adapter_polls_deferred") and DEFERRED_BREAKER_OPEN in k)


def test_the_breaker_opens_cools_down_probes_and_closes_through_the_service():
    """§7.4's full cycle against the real pipeline: open at the threshold, no
    request and **no extra fault** during the cooldown (a deferral is counted
    as a deferral, not as a failure), one probe, and recovery to `ok`."""
    threshold = P.breaker_failure_threshold
    pipeline, sink = pipeline_for()
    adapter, context, transport = scripted_adapter(
        [case("A4-04").step] * threshold + [case("A4-17").step], jitter=lambda cap: 0)

    _fail_to_open(pipeline, adapter, sink, context)
    assert transport.fetches == threshold
    assert sink.counters()["faults"]["total"] == threshold
    if threshold >= OUTAGE_CONSECUTIVE_FAILURES:
        assert pipeline.status.state == "outage"

    refused = 0
    while context.clock.now_ms() + P.min_request_interval_ms < \
            START_MS + threshold * P.min_request_interval_ms + P.breaker_cooldown_ms:
        result = run(pipeline, adapter, sink, context, advance_ms=P.min_request_interval_ms)
        assert (result.faults, result.produced) == (0, 0)
        refused += 1
    assert refused >= 1
    assert transport.fetches == threshold, "the cooldown costs no request"
    assert _deferred(context) == refused, "every refused poll is counted"
    assert sink.counters()["faults"]["total"] == threshold, "a deferral is not a fault"

    result = run(pipeline, adapter, sink, context, advance_ms=SETTLE_MS)
    assert transport.fetches == threshold + 1
    assert result.published == len(clean_values())
    assert adapter.breaker.state == "closed"
    assert adapter.breaker.snapshot()["probes_admitted"] == 1
    assert pipeline.status.state == "ok"
    assert adapter.state == "running"
    assert adapter.backoff.attempt == 0, "one successful item resets the counter"


def test_a_failed_probe_reopens_and_a_later_probe_still_recovers():
    threshold = P.breaker_failure_threshold
    pipeline, sink = pipeline_for()
    adapter, context, transport = scripted_adapter(
        [case("A4-03").step] * (threshold + 1) + [case("A4-17").step], jitter=lambda cap: 0)
    _fail_to_open(pipeline, adapter, sink, context)

    probe = run(pipeline, adapter, sink, context, advance_ms=P.breaker_cooldown_ms)
    assert probe.faults == 1
    assert adapter.breaker.state == "open"
    assert adapter.breaker.snapshot()["opened_count"] == 2

    run(pipeline, adapter, sink, context, advance_ms=P.min_request_interval_ms)
    assert transport.fetches == threshold + 1, "a fresh cooldown, again costing nothing"

    result = run(pipeline, adapter, sink, context, advance_ms=SETTLE_MS)
    assert result.published == len(clean_values())
    assert adapter.breaker.state == "closed"
    assert pipeline.status.state == "ok"


def test_a_permanent_fault_does_not_leave_a_probe_to_be_admitted():
    """A breaker that is open because of a permanent fault must not turn into a
    retry once its cooldown elapses: `failed_permanent` outranks the breaker."""
    threshold = P.breaker_failure_threshold
    pipeline, sink = pipeline_for()
    script = [case("A4-03").step] * (threshold - 1) + [case("A4-06").step]
    adapter, context, transport = scripted_adapter(script + [case("A4-17").step],
                                                   jitter=lambda cap: 0)
    for _ in range(threshold):
        run(pipeline, adapter, sink, context, advance_ms=P.min_request_interval_ms)
    run(pipeline, adapter, sink, context, advance_ms=P.breaker_cooldown_ms + SETTLE_MS)

    assert transport.fetches == threshold
    assert adapter.state == "failed_permanent"
    assert pipeline.status.state == "down"


# ------------------------------------------------- no silent loss over a sequence
def test_a_mixed_sequence_accounts_for_every_delivered_item_and_every_fault():
    """Criterion 14 and AD-5 §7.5 over a run, not a cycle: every item a provider
    delivered is either produced (and then one outcome) or an item fault; every
    failed poll is one fault; the channels agree with the counters; and what was
    published is exactly the unchanged generator's series for the sequences that
    arrived, and nothing for the ones that did not."""
    from cbdc_ingestion.generator import rate_for
    from cbdc_ingestion.pairs import PAIRS
    from fake_provider import Deliver

    seq2 = clean_values(2)
    seq2_missing_rate = [seq2[0], {k: v for k, v in seq2[1].items() if k != "rate"},
                         seq2[2], seq2[3]]
    seq3 = clean_values(3)
    seq3_implausible = [dict(seq3[0], rate=IMPLAUSIBLE_RATE)] + seq3[1:]
    # A well-formed item for a subject the record does not list. §7.3's checks
    # pass it (one item, no repeated subject). Under Target A classification
    # A4-19 the adapter itself rejects it as a non-permanent `item_invalid`, so
    # it never reaches the service's admission: it is an **item fault**, not a
    # `rejected` outcome, and it is counted once by the cycle's drain and never
    # again by the next cycle's.
    unlisted = [dict(clean_values(1)[0], base="JPY", quote="USD")]
    script = [
        Deliver(values=clean_values(1)),
        Deliver(values=unlisted),
        case("A4-03").step,
        Deliver(values=seq2_missing_rate),
        case("A4-01").step,
        Deliver(values=seq3_implausible),
        case("A4-05").step,
        case("A4-18").step,
        Deliver(values=clean_values(4)),
    ]
    delivered = sum(len(s.values) for s in script if isinstance(s, Deliver))
    failed_polls = 3

    pipeline, sink = pipeline_for()
    adapter, context, transport = scripted_adapter(script, jitter=lambda cap: 0)
    results = []
    while transport.fetches < len(script):
        results.append(run(pipeline, adapter, sink, context, advance_ms=SETTLE_MS))

    total = {name: sum(getattr(r, name) for r in results)
             for name in OUTCOME_COUNTERS + ("produced", "faults", "item_faults")}
    assert all(accounted(r) == r.produced for r in results), "the law, cycle by cycle"
    assert total["produced"] + total["item_faults"] == delivered, "no item vanished"
    assert total["faults"] == failed_polls
    assert total["item_faults"] == 2, "the missing rate, and the unlisted subject (A4-19)"
    assert total["quarantined"] == 1
    assert total["rejected"] == 0, "A4-19 is refused by the adapter, before admission"

    channels = sink.counters()
    assert channels["quarantine"]["total"] == total["quarantined"]
    assert channels["faults"]["total"] == (total["faults"] + total["item_faults"]
                                           + total["rejected"] + total["collisions"]
                                           + total["conflicts"])

    for pair in PAIRS:
        stored = sink.store.latest_for(pair.key)
        assert stored is not None
        assert stored["payload"]["rate"] == rate_for(SEED, pair, 4)
        assert stored["usage"] == "display_only"


# ------------------------------------------------- routing non-interference
ROUTING_MODULE_PREFIXES = ("src", "services.inference", "inference", "backend")


def test_a_full_fault_run_loads_no_routing_or_engine_module():
    """AD-5 §7.5 "no routing effect" and §11: driving every catalogue id through
    the real pipeline imports nothing on the routing side. Checked on the live
    interpreter after the run, not on source text alone."""
    pipeline, sink = pipeline_for()
    for case_id in CASE_IDS:
        adapter, context, _ = scripted_adapter([case(case_id).step])
        run(pipeline, adapter, sink, context, advance_ms=settle_for(case_id))

    loaded = [m for m in sys.modules
              if any(m == p or m.startswith(p + ".") for p in ROUTING_MODULE_PREFIXES)]
    assert loaded == []


def test_the_a4_adapter_has_no_input_a_routing_event_could_reach():
    """AD-5 §11: "no adapter is driven by a routing event". The constructor is
    the adapter's whole input surface; it takes a source, a seed, a transport
    and simulation timing, and nothing else."""
    parameters = set(inspect.signature(SimulatedTransportFxAdapter.__init__).parameters)
    assert parameters == {"self", "source_id", "seed", "transport", "profile",
                          "jitter", "jitter_seed", "interval_ms"}


def test_this_matrix_imports_nothing_from_the_routing_side():
    tree = ast.parse(inspect.getsource(sys.modules[__name__]))
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names.add(node.module)
    assert not [n for n in names
                if any(n == p or n.startswith(p + ".") for p in ROUTING_MODULE_PREFIXES)]


# ------------------------------------------------- AD-5 classification preserved
# AD-5 §7.1's table, transcribed: the "Retry" column decides the partition.
AD5_PERMANENT = {"auth_failure", "contract_violation"}
AD5_RECOVERABLE = {"transient_network", "provider_unavailable", "rate_limited", "internal"}
AD5_ITEM = {"item_invalid", "item_implausible"}


def test_the_taxonomy_is_still_ad5s_eight_classes_partitioned_as_7_1_states():
    assert {c.value for c in FaultClass} == AD5_PERMANENT | AD5_RECOVERABLE | AD5_ITEM
    assert {c.value for c in faults_module.PERMANENT_FAULTS} == AD5_PERMANENT
    assert {c.value for c in faults_module.RECOVERABLE_FAULTS} == AD5_RECOVERABLE
    assert {c.value for c in faults_module.ITEM_FAULTS} == AD5_ITEM


def test_the_synthetic_reachable_set_is_unchanged_by_the_seam():
    """The service-default path still reaches only `internal` and the two item
    outcomes; the seam adds an adapter, not a new reachable class there."""
    assert {c.value for c in faults_module.SYNTHETIC_REACHABLE} == {"internal"} | AD5_ITEM


def test_the_shipped_record_still_selects_the_shipped_adapter():
    """Interface §4 item 3: no registry record selects the A-4 adapter."""
    assert record().adapter_id == "synthetic_fx"


def test_the_shipped_adapter_produces_no_drained_fault_on_a_clean_cycle():
    """The drain added to `base.py` must not change the shipped path: a clean
    cycle of the shipped adapter through the same pipeline counts no fault."""
    from cbdc_ingestion.adapters.context import AdapterContext, CancellationSignal, NullMetrics
    from cbdc_ingestion.clock import ManualClock
    from cbdc_ingestion.sink import ServiceSink

    from .adapter_cases import adapter_for_record

    pipeline, sink = pipeline_for()
    shipped = adapter_for_record(record())
    clock = ManualClock(START_MS)
    shipped.start(AdapterContext(source_id=shipped.source_id, clock=clock, sink=ServiceSink(),
                                 cancellation=CancellationSignal(), metrics=NullMetrics()))
    clock.advance_ms(SETTLE_MS)
    result = pipeline.run_cycle(shipped, sink, retrieved_at_ms=clock.now_ms())

    assert result.produced >= 1
    assert (result.faults, result.item_faults) == (0, 0)
    assert accounted(result) == result.produced
    assert shipped.drain_faults() == ()
