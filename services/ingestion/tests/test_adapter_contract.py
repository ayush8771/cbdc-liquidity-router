"""Acceptance criterion 1 (A-1): the shared adapter contract suite.

**Every** adapter passes this one suite, driven by AD-5 §3.2's operations and
§3.3's lifecycle. New adapters are added to `ADAPTERS` in
`tests/adapter_cases.py`, so an adapter cannot be shipped with a suite of its
own that quietly tests less.

The `describe()`-against-the-registry check lives in
`test_registry.py::test_a_description_mismatch_is_a_startup_failure`, because it
needs a record; here the description's own shape is checked.
"""
from __future__ import annotations

import pytest

from cbdc_ingestion.adapters.base import (
    ADAPTER_STATES,
    ALLOWED_TRANSITIONS,
    AUTHORIZED_TRANSPORTS,
    Adapter,
    AdapterDescription,
    AdapterStateError,
    NormalizedObservation,
)
from cbdc_ingestion.adapters.context import (
    CONTEXT_FIELDS,
    FORBIDDEN_CONTEXT_FIELDS,
    AdapterContext,
    CredentialRefused,
    no_credentials,
)
from cbdc_ingestion.adapters.faults import AdapterFault, FaultClass

from .adapter_cases import ADAPTERS, make_context

ADAPTER_IDS = [name for name, _ in ADAPTERS]


@pytest.fixture(params=[factory for _, factory in ADAPTERS], ids=ADAPTER_IDS)
def adapter(request):
    return request.param()


def test_there_is_at_least_one_adapter_to_check():
    assert ADAPTERS, "the shared contract suite must cover at least one adapter"


# ----------------------------------------------------------------- describe()
def test_describe_is_static_and_well_formed(adapter: Adapter):
    first, second = adapter.describe(), adapter.describe()
    assert first == second, "describe() is static: it describes the code, not the configuration"
    assert isinstance(first, AdapterDescription)
    assert first.event_types and first.subjects
    assert first.production_mode in ("poll", "subscribe")


def test_every_adapter_in_this_scope_is_synthetic_only(adapter: Adapter):
    """Authorization §8 items 1 and 2: no real provider, no outbound network."""
    assert tuple(adapter.describe().transports) == AUTHORIZED_TRANSPORTS


def test_describe_does_not_depend_on_having_started(adapter: Adapter):
    before = adapter.describe()
    adapter.start(make_context(adapter))
    assert adapter.describe() == before


# ------------------------------------------------------------------ lifecycle
def test_a_new_adapter_is_created(adapter: Adapter):
    assert adapter.state == "created"


def test_start_then_produce_reaches_running(adapter: Adapter):
    context = make_context(adapter)
    adapter.start(context)
    assert adapter.state in ("starting", "running")
    context.clock.advance_ms(10_000)
    items = adapter.produce()
    assert items, "an adapter that produced nothing cannot be checked for running"
    assert adapter.state == "running"


def test_start_is_idempotent(adapter: Adapter):
    context = make_context(adapter)
    assert adapter.start(context) == adapter.start(context)


def test_the_state_machine_matches_ad5_3_3():
    assert set(ALLOWED_TRANSITIONS) == set(ADAPTER_STATES)
    # failed_permanent never returns to running or degraded: it has no automatic
    # transition out at all (AD-5 §3.3, §7.1).
    assert ALLOWED_TRANSITIONS["failed_permanent"] == frozenset({"stopping", "stopped"})
    assert "running" not in ALLOWED_TRANSITIONS["failed_permanent"]
    assert "degraded" not in ALLOWED_TRANSITIONS["failed_permanent"]


def test_failed_permanent_never_restarts(adapter: Adapter):
    context = make_context(adapter)
    adapter.start(context)
    adapter._record_fault(AdapterFault(FaultClass.AUTH_FAILURE, "unreachable_in_this_scope"))
    assert adapter.state == "failed_permanent"
    context.clock.advance_ms(60_000)
    assert adapter.produce() == ()
    assert adapter.state == "failed_permanent"


def test_a_recoverable_fault_degrades_and_one_item_recovers(adapter: Adapter):
    context = make_context(adapter)
    adapter.start(context)
    context.clock.advance_ms(10_000)
    adapter.produce()
    assert adapter.state == "running"
    adapter._record_fault(AdapterFault(FaultClass.INTERNAL, "injected"))
    assert adapter.state == "degraded"
    context.clock.advance_ms(10_000)
    assert adapter.produce()
    assert adapter.state == "running", "one successful item leaves degraded (AD-5 §3.3)"


def test_an_item_fault_changes_no_adapter_state(adapter: Adapter):
    context = make_context(adapter)
    adapter.start(context)
    context.clock.advance_ms(10_000)
    adapter.produce()
    before = adapter.state
    adapter._record_fault(AdapterFault(FaultClass.ITEM_INVALID, "one_bad_item"))
    assert adapter.state == before, "one bad item does not discard a good response (AD-5 §7.1)"


def test_a_stopped_adapter_is_not_restarted_in_process(adapter: Adapter):
    context = make_context(adapter)
    adapter.start(context)
    adapter.stop()
    with pytest.raises(AdapterStateError):
        adapter.start(context)


# ------------------------------------------------------------------- produce()
def test_produce_before_start_is_an_error(adapter: Adapter):
    with pytest.raises(AdapterStateError):
        adapter.produce()


def test_produce_returns_normalized_observations_not_envelopes(adapter: Adapter):
    context = make_context(adapter)
    adapter.start(context)
    context.clock.advance_ms(10_000)
    for item in adapter.produce():
        assert isinstance(item, NormalizedObservation)
        # Identity and hashing are the service's, never the adapter's (AD-5 §3.1).
        assert not hasattr(item, "event_id")
        assert not hasattr(item, "payload_sha256")
        assert "event_id" not in item.payload and "payload_sha256" not in item.payload


def test_produce_emits_only_declared_types_and_subjects(adapter: Adapter):
    context = make_context(adapter)
    adapter.start(context)
    description = adapter.describe()
    context.clock.advance_ms(10_000)
    for item in adapter.produce():
        assert item.event_type in description.event_types
        assert item.subject in description.subjects
        assert item.source_timestamp_basis == description.emits_timestamp_basis


def test_produce_is_empty_once_cancelled(adapter: Adapter):
    context = make_context(adapter)
    adapter.start(context)
    context.cancellation.cancel()
    context.clock.advance_ms(10_000)
    assert adapter.produce() == ()


# -------------------------------------------------------------------- health()
def test_health_is_advisory_and_carries_no_payload(adapter: Adapter):
    adapter.start(make_context(adapter))
    health = adapter.health()
    assert set(health) == {"source_id", "state", "reason"}
    assert health["state"] in ADAPTER_STATES


# ------------------------------------------------------------- the unidirectional rule
FORBIDDEN_OPERATIONS = (
    "publish", "accept", "ingest", "route", "decide", "submit", "write", "store",
    "on_observation", "on_route", "set_user", "handle_form",
)


def test_an_adapter_has_no_inbound_operation(adapter: Adapter):
    """AD-5 §3.2: nothing accepts an observation, a routing request or a user."""
    for name in FORBIDDEN_OPERATIONS:
        assert not hasattr(adapter, name), f"{name!r} would make the adapter bidirectional"


def test_the_context_carries_exactly_what_ad5_3_2_allows(adapter: Adapter):
    context = make_context(adapter)
    fields = tuple(AdapterContext.__dataclass_fields__)
    assert fields == CONTEXT_FIELDS
    assert not (set(fields) & FORBIDDEN_CONTEXT_FIELDS)
    for forbidden in ("db", "database", "connection", "inference", "engine", "writer"):
        assert not hasattr(context, forbidden), forbidden


def test_no_credential_resolves_in_this_scope():
    """Authorization §8 item 3: no credential exists and none resolves."""
    assert AdapterContext.__dataclass_fields__["resolve_credential"].default is no_credentials
    with pytest.raises(CredentialRefused):
        no_credentials("anything")
