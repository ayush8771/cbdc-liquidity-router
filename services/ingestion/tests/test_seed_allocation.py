"""Acceptance criterion 8: the §6.1 seed safeguards, **and the D-24 exemption
asserted as a test rather than assumed**.

Three clauses, all on the **registry-selected** path:

1. an overlapping `(seed, pair)` is **refused** (AD-12 §3.1 mitigation 3);
2. a registry-selected record absent from the allocation file is **refused**
   (mitigation 1), and active allocations use **disjoint** subject sets
   (mitigation 2);
3. **one active generator configuration per `source_id`** — authorized for
   **Phase 3.3-A only**, by the owner's grant of **AD4P2-Q2** of 27 November
   2026, as a **registry configuration rule**. It changes **no derivation and no
   envelope field**; the approved C-1 derivation stands unchanged, and **AD-4
   Part 2 is not approved as a document**.

A positive control starts cleanly.

**The exemption is the other half of the evidence.** The env-configured D-24
generator starts with **no registry record and no allocation entry**, exactly as
it does today. An unscoped refusal would refuse to start the approved slice, so
the tests below assert the exemption directly; the existing D-24 ingestion suite
passing unchanged (criterion 18) is the second half.

**A limitation, stated and not papered over** (§12 item 8): the check is
**in-process and local**. It reads the allocation file and the records the
service is starting, and it **cannot** detect a second container started
independently against the same consumer.
"""
from __future__ import annotations

import copy
import json

import pytest

from cbdc_ingestion.adapters.registry import (
    ALLOCATIONS_PATH,
    SOURCES_PATH,
    RegistryInvalid,
    check_allocations,
    check_source_id_uniqueness,
    load_registry,
    parse_allocation,
    parse_record,
)
from cbdc_ingestion.service import IngestionService
from cbdc_ingestion.settings import DEFAULT_SEED, from_environment

from .conftest import SEED, START_MS

SHIPPED_SOURCES = json.loads(SOURCES_PATH.read_text(encoding="utf-8"))
SHIPPED_ALLOCATIONS = json.loads(ALLOCATIONS_PATH.read_text(encoding="utf-8"))


def a_record(**overrides) -> dict:
    raw = copy.deepcopy(SHIPPED_SOURCES["sources"][0])
    raw.update(overrides)
    return raw


def an_allocation(**overrides) -> dict:
    raw = copy.deepcopy(SHIPPED_ALLOCATIONS["allocations"][0])
    raw.update(overrides)
    return raw


# ------------------------------------------------------------- positive control
def test_the_shipped_registry_and_allocations_load_cleanly():
    registry = load_registry()
    assert registry.allocations
    for record in registry.active_records():
        assert registry.allocation_for(record.source_id) is not None, (
            f"{record.source_id} is registry-selected and needs a recorded allocation")


def test_the_allocation_file_is_read_only_at_runtime():
    """AD-12 §3.1 mitigation 1: never written by the process.

    The container has a read-only root filesystem, no volume and no published
    port, so a runtime-written ledger is impossible; a reviewed file in source
    control is the only form the record can take, and changing one is a
    reviewed commit. Asserted as "no code writes it", which is checkable here.
    """
    from cbdc_ingestion.adapters import registry as registry_module

    text = open(registry_module.__file__, encoding="utf-8").read()
    for forbidden in ("write_text", "open(", ".write(", "json.dump"):
        assert forbidden not in text, (
            f"{forbidden!r} in registry.py: the allocation file is read-only at runtime")


# ---------------------------------------------------- clause 1: the (seed, pair) refusal
def test_an_overlapping_seed_and_pair_is_refused():
    first = parse_allocation(an_allocation())
    second = parse_allocation(an_allocation(
        source_id="synthetic.fx.adapter_two",
        # The same seed and an overlapping pair, in the same period: exactly the
        # C-1 collision inputs.
        subjects=[["EUR", "USD", "mid"]],
    ))
    with pytest.raises(RegistryInvalid, match="overlap|disjoint"):
        check_allocations([], [first, second])


def test_the_same_seed_on_disjoint_pairs_is_permitted():
    """Mitigation 3 refuses an overlap, not a shared seed as such."""
    first = parse_allocation(an_allocation(subjects=[["EUR", "USD", "mid"]]))
    second = parse_allocation(an_allocation(
        source_id="synthetic.fx.adapter_two", subjects=[["USD", "INR", "mid"]]))
    check_allocations([], [first, second])


def test_an_overlap_in_a_disjoint_period_is_permitted():
    """The refusal binds allocations active **for the same period**."""
    first = parse_allocation(an_allocation(period="2026-01-01/2026-06-30"))
    second = parse_allocation(an_allocation(
        source_id="synthetic.fx.adapter_two", period="2026-07-01/2026-12-31"))
    check_allocations([], [first, second])


def test_an_inactive_allocation_does_not_collide():
    first = parse_allocation(an_allocation())
    second = parse_allocation(an_allocation(
        source_id="synthetic.fx.adapter_two", active=False))
    check_allocations([], [first, second])


# -------------------------------- clause 2: a missing entry, and disjoint subjects
def test_a_registry_selected_source_with_no_allocation_entry_is_refused():
    record = parse_record(a_record())
    with pytest.raises(RegistryInvalid, match="seed allocation"):
        check_allocations([record], [])


def test_a_registry_selected_source_with_only_an_inactive_entry_is_refused():
    record = parse_record(a_record())
    allocation = parse_allocation(an_allocation(active=False))
    with pytest.raises(RegistryInvalid, match="seed allocation"):
        check_allocations([record], [allocation])


def test_an_allocation_whose_subjects_differ_from_the_record_is_refused():
    record = parse_record(a_record())
    allocation = parse_allocation(an_allocation(subjects=[["EUR", "USD", "mid"]]))
    with pytest.raises(RegistryInvalid, match="subject set"):
        check_allocations([record], [allocation])


def test_two_sources_sharing_a_pair_are_refused():
    """Mitigation 2: sources registered together use disjoint pair sets."""
    first = parse_allocation(an_allocation(seed=1, subjects=[["EUR", "USD", "mid"]]))
    second = parse_allocation(an_allocation(
        seed=2, source_id="synthetic.fx.adapter_two", subjects=[["EUR", "USD", "mid"]]))
    with pytest.raises(RegistryInvalid, match="disjoint"):
        check_allocations([], [first, second])


def test_a_non_startable_record_needs_no_allocation():
    """Only an `active` record starts an adapter (AD-5 §2.4)."""
    record = parse_record(a_record(status="proposed"))
    check_allocations([record], [])


# -------------------- clause 3: one active generator configuration per source_id
def test_two_active_records_sharing_a_source_id_are_refused():
    """AD-4 Part 2 §3.4 item 3, **granted for Phase 3.3-A only** (§13.3).

    A registry configuration rule on the registry-selected synthetic adapter
    path. Its benefit is **dedup-state separation, not collision prevention**:
    `source_id` is absent from the C-1 derivation, so two `source_id`s do not
    prevent the `event_id` collision — they separate `observation_key`'s first
    component, so the streams stop overwriting each other's dedup state.
    """
    first = parse_record(a_record())
    second = parse_record(a_record(display_name="A second configuration"))
    with pytest.raises(RegistryInvalid, match="one active generator configuration"):
        check_source_id_uniqueness([first, second])


def test_a_second_configuration_under_a_second_source_id_is_permitted():
    first = parse_record(a_record())
    second = parse_record(a_record(source_id="synthetic.fx.adapter_two"))
    check_source_id_uniqueness([first, second])


def test_a_suspended_duplicate_does_not_count_as_a_second_active_configuration():
    first = parse_record(a_record())
    second = parse_record(a_record(status="suspended"))
    check_source_id_uniqueness([first, second])


# --------------------------------------------- the D-24 exemption, as a test
def test_the_shared_source_id_record_is_not_the_d24_generator():
    """Option B: the record shares `synthetic.fx` but does not register D-24.

    The owner's decision of 27 November 2026 permits both configurations to use
    `synthetic.fx` **provided they are mutually exclusive**. The record is the
    adapter's; the generator stays env-configured, unregistered and exempt. The
    two are told apart by their **seed**, which is a C-1 derivation input, and
    not by their `source_id`, which is not one.
    """
    from cbdc_ingestion import SOURCE_ID

    registry = load_registry()
    record = registry.record_for(SOURCE_ID)
    assert record is not None, "the adapter record uses the shared source_id"
    assert record.adapter_id == "synthetic_fx", (
        "the record selects the adapter, not the env-configured generator")
    allocation = registry.allocation_for(SOURCE_ID)
    assert allocation is not None and allocation.seed != DEFAULT_SEED


def test_the_d24_generator_seed_holds_no_allocation():
    """The generator needs no allocation entry, and must not have one.

    An entry for `CBDC_INGESTION_SEED`'s default would imply the generator is
    registry-selected, which it is not: it is exempt, and an unscoped refusal
    would refuse to start the approved slice.
    """
    registry = load_registry()
    assert all(a.seed != DEFAULT_SEED for a in registry.allocations)


def test_the_d24_generator_starts_with_no_record_and_no_allocation(clock):
    """The assertion that the safeguards cannot refuse the approved slice.

    The service is constructed and started exactly as today, on the
    env-configured seed, and it produces its events. Nothing in the registry or
    the allocation file is consulted.
    """
    settings = from_environment({})
    assert settings.seed == DEFAULT_SEED
    service = IngestionService(settings.seed, clock=clock, start_ms=START_MS)
    service.start(run_loop=False)
    try:
        assert service.ready
        clock.advance_ms(2500)
        assert service.tick() == 4, "all four pairs are due, exactly as on the D-24 path"
    finally:
        service.stop()


def test_the_default_service_path_consults_no_registry(monkeypatch):
    """The exemption is structural: the default path never calls into registry.py.

    Asserted by making a load fail loudly. If `service.py`'s default path
    touched the registry, this test would raise instead of ticking.
    """
    from cbdc_ingestion.adapters import registry as registry_module
    from cbdc_ingestion.clock import ManualClock

    def _refuse(*args, **kwargs):
        raise AssertionError("the D-24 default path must not load the registry (§6.1)")

    monkeypatch.setattr(registry_module, "load_registry", _refuse)
    clock = ManualClock(START_MS)
    service = IngestionService(SEED, clock=clock, start_ms=START_MS)
    service.start(run_loop=False)
    try:
        clock.advance_ms(2500)
        assert service.tick() == 4
    finally:
        service.stop()


# ------------------------------------------------------------- allocation shape
def test_an_allocation_with_an_unknown_field_is_refused():
    with pytest.raises(RegistryInvalid, match="unknown allocation field"):
        parse_allocation(an_allocation(provider="someone"))


@pytest.mark.parametrize("bad", [
    {"seed": -1}, {"seed": "20261127"}, {"seed": True},
    {"period": ""}, {"active": "yes"}, {"subjects": []},
])
def test_a_malformed_allocation_is_refused(bad):
    with pytest.raises(RegistryInvalid):
        parse_allocation(an_allocation(**bad))


def test_the_local_scope_of_the_check_is_recorded():
    """§12 item 8: in-process and local, and stated rather than papered over."""
    from cbdc_ingestion.adapters import registry as registry_module

    assert "cannot" in (check_allocations.__doc__ or "")
    assert "in-process and local" in (check_allocations.__doc__ or "").lower().replace(
        "**", "")
    assert registry_module.__doc__
