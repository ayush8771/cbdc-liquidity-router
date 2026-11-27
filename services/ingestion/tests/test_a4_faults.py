"""A-4: every AD-5 §7.1 fault class, reached through a real scripted response.

This is the suite that closes the gap `faults.py` recorded: *"the network
members are defined and unexercised in Phase 3.3-A … a synthetic source has no
transport, so `transient_network`, `provider_unavailable`, `rate_limited` and
`auth_failure` cannot arise here."* Each is now produced by a scripted provider
response and classified by the shipped code.

The catalogue lives in `a4_support.TRANSPORT_CASES` so that a conformance matrix,
a harness and the demonstration drive the same cases. This suite asserts the
**adapter-level** outcome of each; `test_a4_integration.py` asserts what the
service does with it.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

from cbdc_ingestion.adapters.faults import (
    ITEM_FAULTS,
    PERMANENT_FAULTS,
    RECOVERABLE_FAULTS,
    FaultClass,
)
from cbdc_ingestion.adapters.simulated_fx import ADAPTER_ID
from cbdc_ingestion.adapters.transport import (
    AUTHORIZED_TRANSPORT_KINDS,
    TransportRefused,
    assert_admissible,
)

from .a4_support import TRANSPORT_CASES, case, clean_values, scripted_adapter
from .conftest import SERVICE_ROOT

CASE_IDS = [c.case_id for c in TRANSPORT_CASES]


# ------------------------------------------------------------------ the catalogue
@pytest.mark.parametrize("a4_case", TRANSPORT_CASES, ids=CASE_IDS)
def test_each_case_produces_its_declared_class_and_reason(a4_case):
    adapter, context, transport = scripted_adapter([a4_case.step])
    items = adapter.produce()

    assert transport.fetches == 1, "every case must actually reach the transport"
    if a4_case.fault_class is None:
        assert adapter.last_fault is None, f"{a4_case.case_id} must not fault"
        return
    fault = adapter.last_fault
    assert fault is not None, f"{a4_case.case_id} produced no fault"
    assert fault.fault_class is a4_case.fault_class, a4_case.case_id
    assert fault.reason == a4_case.reason, a4_case.case_id
    assert fault.permanent is a4_case.permanent, a4_case.case_id
    assert fault.source_id == adapter.source_id
    assert items == (), "a faulted poll yields no observation"


@pytest.mark.parametrize("a4_case", TRANSPORT_CASES, ids=CASE_IDS)
def test_each_case_leaves_the_adapter_in_the_state_its_class_requires(a4_case):
    """AD-5 §3.3 and §7.1: permanent to `failed_permanent`, recoverable to
    `degraded`, and an **item** fault to no change at all."""
    adapter, context, _ = scripted_adapter([a4_case.step])
    before = adapter.state
    adapter.produce()

    if a4_case.fault_class is None:
        assert adapter.state in ("starting", "running")
    elif a4_case.fault_class in ITEM_FAULTS:
        assert adapter.state == before, "one bad item does not discard a good response"
    elif a4_case.fault_class in PERMANENT_FAULTS:
        assert adapter.state == "failed_permanent"
    else:
        assert a4_case.fault_class in RECOVERABLE_FAULTS
        assert adapter.state == "degraded"


@pytest.mark.parametrize("a4_case", TRANSPORT_CASES, ids=CASE_IDS)
def test_every_fault_is_queued_for_accounting_exactly_once(a4_case):
    """`produce()` swallows faults so one bad poll cannot end the service tick,
    so the drain is the only way a fault reaches a counter. Draining twice must
    not count it twice."""
    adapter, _, _ = scripted_adapter([a4_case.step])
    adapter.produce()
    drained = adapter.drain_faults()
    assert len(drained) == (0 if a4_case.fault_class is None else 1)
    assert adapter.drain_faults() == (), "a drained fault is not drainable again"


def test_the_catalogue_covers_every_fault_class_the_taxonomy_defines():
    """The headline A-4 obligation: *every* §7.1 class. `item_implausible` is
    excluded by design — it is the plausibility guard's verdict on a value the
    adapter delivered correctly, so it arises in the **pipeline**, and
    `test_a4_integration.py` exercises it there."""
    covered = {c.fault_class for c in TRANSPORT_CASES if c.fault_class is not None}
    expected = set(FaultClass) - {FaultClass.ITEM_IMPLAUSIBLE, FaultClass.INTERNAL}
    assert expected <= covered, f"unreached: {sorted(c.value for c in expected - covered)}"


def test_the_internal_class_is_reachable_through_a_defect_in_the_scaffold():
    """`internal` is "a defect in the adapter or the service" (AD-5 §7.1), so it
    cannot be scripted as a provider behaviour. A transport that raises is the
    honest way to reach it, and it must be classified rather than escaping."""
    class _BrokenTransport:
        kind = AUTHORIZED_TRANSPORT_KINDS[0]
        fetches = 0

        def fetch(self):
            raise RuntimeError("a defect, not a provider behaviour")

    adapter, _, _ = scripted_adapter([case("A4-17").step])
    adapter._transport = _BrokenTransport()
    assert adapter.produce() == ()
    assert adapter.last_fault.fault_class is FaultClass.INTERNAL
    assert adapter.last_fault.reason == "RuntimeError"
    assert adapter.state == "degraded", "internal is recoverable (AD-5 §7.1's last row)"


def test_every_case_id_is_unique_and_stable_in_shape():
    assert len(set(CASE_IDS)) == len(CASE_IDS)
    assert all(cid.startswith("A4-") and cid[3:].isdigit() for cid in CASE_IDS)


def test_an_unknown_case_id_raises_rather_than_returning_nothing():
    with pytest.raises(KeyError, match="unknown A-4 case"):
        case("A4-does-not-exist")


# ------------------------------------------------- permanent means no retry, ever
@pytest.mark.parametrize("case_id", ["A4-06", "A4-07", "A4-08", "A4-10"])
def test_a_permanent_fault_is_never_retried_and_sets_no_wait(case_id):
    """AD-5 §3.3: `failed_permanent` needs an operator action. The testable form
    is that no later poll makes a transport call, however much time passes."""
    adapter, context, transport = scripted_adapter([case(case_id).step], repeating=True)
    adapter.produce()
    assert adapter.state == "failed_permanent"
    calls = transport.fetches
    assert adapter.next_attempt_ms is None, "a permanent fault leaves no retry gate"

    for _ in range(5):
        context.clock.advance_ms(60_000)
        assert adapter.produce() == ()
    assert transport.fetches == calls, "a permanent fault must make no further request"
    assert adapter.state == "failed_permanent"


def test_a_recoverable_fault_sets_a_retry_gate_and_defers_until_it_passes():
    adapter, context, transport = scripted_adapter(
        [case("A4-04").step, case("A4-17").step], repeating=True,
        jitter=lambda cap: cap)
    adapter.produce()
    assert adapter.state == "degraded"
    gate = adapter.next_attempt_ms
    assert gate is not None and gate > context.clock.now_ms()

    calls = transport.fetches
    adapter.produce()
    assert transport.fetches == calls, "a poll before the gate makes no request"

    context.clock.set_ms(gate)
    assert adapter.produce(), "at the gate the poll goes out and delivers"
    assert adapter.state == "running"
    assert adapter.next_attempt_ms is None, "a success clears the gate"


def test_the_self_imposed_ceiling_is_a_separate_gate_from_the_backoff():
    """AD-5 §7.4's "self-imposed ceiling strictly below the provider's limit".

    Asserted on a clean script, where there is no backoff at all, so the only
    thing that can stop a second immediate poll is the ceiling. The profile
    keeps the ceiling below the backoff base precisely so the two gates can be
    told apart.
    """
    from cbdc_ingestion.adapters.simulated_fx import DEFERRED_CEILING
    from cbdc_ingestion.adapters.simulation import SIMULATION_TIMING as profile

    adapter, context, transport = scripted_adapter([case("A4-17").step], repeating=True)
    assert adapter.produce()
    calls = transport.fetches

    adapter.produce()
    assert transport.fetches == calls, "a second poll in the same millisecond is refused"
    assert adapter.deferrals[DEFERRED_CEILING] == 1

    context.clock.advance_ms(profile.min_request_interval_ms)
    assert adapter.produce()
    assert transport.fetches == calls + 1
    assert profile.min_request_interval_ms < profile.backoff_base_ms, (
        "the ceiling must not dominate the first backoff step")


# ------------------------------------------------------------ the transport guard
def test_only_the_in_process_simulation_kind_is_admitted():
    assert AUTHORIZED_TRANSPORT_KINDS == ("in_process_simulation",)


@pytest.mark.parametrize("kind", [None, "", "poll", "websocket", "https", 1, object()])
def test_a_transport_of_any_other_kind_is_refused_at_attachment(kind):
    """Refusing an undeclared kind rather than allowing it: a transport that
    forgot to declare itself must not be treated as harmless."""
    class _Other:
        def fetch(self):
            return None

    offered = _Other()
    offered.kind = kind
    with pytest.raises(TransportRefused, match="not admitted"):
        assert_admissible(offered)


def test_a_transport_without_a_fetch_is_refused():
    class _NoFetch:
        kind = "in_process_simulation"

    with pytest.raises(TransportRefused, match="callable fetch"):
        assert_admissible(_NoFetch())


def test_an_adapter_with_no_transport_fails_permanently_rather_than_idling():
    """A source configured without its provider must not look like a healthy,
    quiet source — AD-5 §9.1 keeps status and freshness apart for this reason."""
    from cbdc_ingestion.adapters.simulated_fx import SimulatedTransportFxAdapter
    from cbdc_ingestion.clock import ManualClock
    from cbdc_ingestion.adapters.context import (
        AdapterContext, CancellationSignal, NullMetrics)
    from cbdc_ingestion.sink import ServiceSink
    from .conftest import SEED, START_MS

    adapter = SimulatedTransportFxAdapter("synthetic.fx", SEED)
    context = AdapterContext(source_id="synthetic.fx", clock=ManualClock(START_MS),
                             sink=ServiceSink(), cancellation=CancellationSignal(),
                             metrics=NullMetrics())
    adapter.start(context)
    assert adapter.state == "failed_permanent"
    assert adapter.last_fault.reason == "no_transport_attached"


# ------------------------------------------- the seam still carries no network
A4_MODULES = ("transport.py", "response.py", "retry.py", "simulation.py",
              "simulated_fx.py")
TRANSPORT_MODULES = frozenset({
    "socket", "ssl", "http", "urllib", "urllib3", "requests", "httpx", "aiohttp",
    "websockets", "websocket", "asyncio", "selectors", "select", "ftplib", "smtplib",
    "poplib", "imaplib", "telnetlib", "xmlrpc", "socketserver", "subprocess", "paramiko",
})


@pytest.mark.parametrize("name", A4_MODULES)
def test_the_a4_modules_import_no_network_module_and_name_no_host(name):
    """The seam is shaped like a transport and is **not** one.

    Asserted against `ast` import nodes rather than the prose, exactly as
    acceptance criterion 11 guards the scaffold, so the docstrings that promise
    no network neither satisfy nor trip the check. §8 item 2's "no outbound
    network access from ingestion" is unchanged by this work.
    """
    path = Path(SERVICE_ROOT) / "cbdc_ingestion" / "adapters" / name
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots = [alias.name.split(".")[0] for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            roots = [(node.module or "").split(".")[0]] if node.level == 0 else []
        else:
            continue
        for root in roots:
            assert root not in TRANSPORT_MODULES, f"{name} imports {root}"
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            assert "://" not in node.value, f"{name} names a URL"


def test_the_adapter_id_is_distinct_from_the_shipped_one():
    """So no registry record can select it by accident: `sources.json` names
    `synthetic_fx`, and `check_description` makes a mismatch a startup failure."""
    from cbdc_ingestion.adapters.registry import load_registry

    assert ADAPTER_ID == "simulated_transport_fx"
    for record in load_registry().records:
        assert record.adapter_id != ADAPTER_ID, (
            "no shipped record may select the A-4 adapter; the service default "
            "stays the D-24 generator")


def test_the_delivered_values_are_the_unchanged_generators_own():
    """A fault case must differ from a clean one in its **faults only**. If the
    simulation invented its own rates, nothing it showed about recovery would
    say anything about the real series."""
    from cbdc_ingestion.generator import rate_for
    from cbdc_ingestion.pairs import PAIRS
    from .conftest import SEED

    for index, item in enumerate(clean_values(3)):
        assert item["rate"] == rate_for(SEED, PAIRS[index], 3)
