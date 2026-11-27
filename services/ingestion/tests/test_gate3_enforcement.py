"""Acceptance criterion 10 (A-11), the **startup** half: the adapter does not start.

**This suite deliberately does not re-test `parse_record`.** The registry half
of criterion 10 — a Gate 3 reference absent, inactive or withdrawn is refused —
lives in `test_registry.py`, whose own docstring claims it, and it is
parametrized over all three statuses there. Duplicating it would mean two
suites asserting one rule and, eventually, one of them being updated.

What is **not** asserted anywhere else, and is asserted here, is the other half
of the criterion's sentence: that **the service does not start** and that it
**records the reason**. Those are properties of `service.py` and so Dev A's.

**No real source exists and none may exist before Gate 3** (§8 item 1), and all
four capability gates are CLOSED. The records below are written into a temporary
file and loaded through the service's own `registry_path`; nothing is added to
the shipped registry, nothing contacts anything, and no provider is named — the
`endpoint` is an `.invalid` host, which by RFC 2606 can never resolve.

**Criterion 10a stays deferred and is not claimed here.** The Unavailable
*display* for a withdrawn source's stored values needs the observation store and
frontend behaviour, both excluded (§8 item 7).
"""
from __future__ import annotations

import copy
import json

import pytest

from cbdc_ingestion.adapters.registry import (
    ALLOCATIONS_PATH,
    SOURCES_PATH,
    RegistryInvalid,
)
from cbdc_ingestion.clock import ManualClock
from cbdc_ingestion.service import IngestionService

from .conftest import SEED, START_MS

SHIPPED_SOURCES = json.loads(SOURCES_PATH.read_text(encoding="utf-8"))
SHIPPED_ALLOCATIONS = json.loads(ALLOCATIONS_PATH.read_text(encoding="utf-8"))

REAL_SOURCE_ID = "fx.unnamed_provider"


def a_real_record(gate3) -> dict:
    """A `real` record carrying `gate3`. Never shipped, never reachable at runtime.

    Derived from the shipped synthetic record so its field set is complete and
    this fixture cannot drift from the schema; every field a real source must
    differ in is then overridden explicitly.
    """
    record = copy.deepcopy(SHIPPED_SOURCES["sources"][0])
    record.update(
        source_id=REAL_SOURCE_ID,
        display_name="Unnamed provider (test only, never contacted)",
        provider_id="unnamed",
        provenance_class="real",
        transport="poll",
        endpoint="https://example.invalid/fx",
        schedule="PT2S",
        gate3_decision_ref=gate3,
    )
    return record


def write_registry(tmp_path, records, allocations=None):
    """Writes a registry and an allocation file, and returns both paths."""
    sources_path = tmp_path / "sources.json"
    allocations_path = tmp_path / "seed_allocations.json"
    sources_path.write_text(json.dumps({"registry_version": "1.0", "sources": records}),
                            encoding="utf-8")
    doc = copy.deepcopy(SHIPPED_ALLOCATIONS)
    if allocations is not None:
        doc["allocations"] = allocations
    allocations_path.write_text(json.dumps(doc), encoding="utf-8")
    return sources_path, allocations_path


def service_for(tmp_path, records, sources, allocations=None) -> IngestionService:
    sources_path, allocations_path = write_registry(tmp_path, records, allocations)
    return IngestionService(SEED, clock=ManualClock(START_MS), start_ms=START_MS,
                            sources=sources, registry_path=sources_path,
                            allocations_path=allocations_path)


# ------------------------------------------- the service refuses to start, by reason
@pytest.mark.parametrize("gate3,label", [
    (None, "absent"),
    ({"ref": "gate3/decision/none", "status": "inactive"}, "inactive"),
    ({"ref": "gate3/decision/none", "status": "withdrawn"}, "withdrawn"),
])
def test_the_service_does_not_start_when_a_gate3_decision_is_not_active(
        tmp_path, gate3, label):
    """**The startup assertion.** `start()` raises `RegistryInvalid`, the service
    never reaches `running`, and no adapter is held.

    The three statuses are separate rows because a check that only looked for a
    missing key would pass `absent` and admit `withdrawn` — which is the worse
    of the three, since a withdrawn decision means permission was taken away.
    """
    service = service_for(tmp_path, [a_real_record(gate3)], [REAL_SOURCE_ID])
    with pytest.raises(RegistryInvalid) as caught:
        service.start(run_loop=False)
    assert service.state != "running"
    assert service.ready is False
    assert service._adapters == []
    assert service._pipelines == []
    # The reason is recorded, and it names the source and the gate — not merely
    # that something failed (AD-1 §3.4: a reason code, never a payload).
    message = str(caught.value)
    assert REAL_SOURCE_ID in message
    assert "Gate 3" in message or "gate3" in message, message


def test_the_recorded_reason_is_the_gate_not_the_transport(tmp_path):
    """A real record fails **both** Gate 3 and the §8 transport authorization.
    The reported reason must be Gate 3: it is the more fundamental refusal and
    the one criterion 10 names. `registry.py` orders the two checks for exactly
    this, so the ordering is asserted rather than assumed."""
    service = service_for(tmp_path, [a_real_record(None)], [REAL_SOURCE_ID])
    with pytest.raises(RegistryInvalid) as caught:
        service.start(run_loop=False)
    message = str(caught.value)
    assert "Gate 3" in message
    assert "not authorized in Phase 3.3-A" not in message, message


def test_an_active_decision_is_still_refused_in_this_scope(tmp_path):
    """Belt and braces at the startup boundary: even **with** an active decision a
    real source does not start, because no real transport is authorized
    (§8 items 1 and 2). An implementation that only checked the gate would start
    a provider adapter the moment a decision reference appeared."""
    service = service_for(
        tmp_path, [a_real_record({"ref": "gate3/decision/x", "status": "active"})],
        [REAL_SOURCE_ID])
    with pytest.raises(RegistryInvalid):
        service.start(run_loop=False)
    assert service.state != "running"
    assert service._adapters == []


def test_a_gate3_reference_on_a_synthetic_source_is_refused(tmp_path):
    """The converse, which keeps the gate meaningful: a synthetic source carrying
    a Gate 3 reference does not start either. A synthetic source has nothing to
    be approved, so a reference on one would be a label with no decision behind
    it — and would make a later audit of 'which sources passed Gate 3' wrong."""
    record = copy.deepcopy(SHIPPED_SOURCES["sources"][0])
    record["gate3_decision_ref"] = {"ref": "gate3/decision/x", "status": "active"}
    service = service_for(tmp_path, [record], [record["source_id"]])
    with pytest.raises(RegistryInvalid):
        service.start(run_loop=False)
    assert service._adapters == []


# -------------------------------------------------------------- positive controls
def test_the_shipped_synthetic_source_starts_cleanly_on_the_adapter_path(tmp_path):
    """The control. Without it, a service that refused every source would pass
    every negative case above. The shipped record has `gate3_decision_ref` null,
    which is correct for a synthetic source, and it starts."""
    record = copy.deepcopy(SHIPPED_SOURCES["sources"][0])
    service = service_for(tmp_path, [record], [record["source_id"]])
    service.start(run_loop=False)
    try:
        assert service.state == "running"
        assert len(service._adapters) == 1
        assert len(service._pipelines) == 1
    finally:
        service.stop()


def test_the_default_path_loads_no_registry_and_is_unaffected(service):
    """**D-24 is untouched.** With no source named, the registry is never loaded,
    so a Gate 3 refusal cannot reach the approved slice. The `service` fixture is
    the shipped default: it starts, is ready, and holds no adapter."""
    assert service.state == "running"
    assert service.ready is True
    assert service.sources == ()
    assert service._adapters == []
    assert service._pipelines == []


def test_a_gate3_refusal_cannot_stop_the_default_generator(tmp_path):
    """The refusal is scoped to the registry-selected path. A broken registry
    file on disk must not prevent the default D-24 service from starting, because
    the default never reads it."""
    write_registry(tmp_path, [a_real_record(None)])
    default = IngestionService(SEED, clock=ManualClock(START_MS), start_ms=START_MS,
                               registry_path=tmp_path / "sources.json",
                               allocations_path=tmp_path / "seed_allocations.json")
    default.start(run_loop=False)
    try:
        assert default.ready is True
    finally:
        default.stop()
