"""Acceptance criterion 2 (A-2): a malformed, inconsistent or incomplete record
fails **at startup**, not at first use.

Every negative case below is asserted **individually**, which criterion 2
requires explicitly: a test that mutated three fields at once and checked that
the load failed would pass even if two of the three checks had been deleted.

The positive control — a synthetic record with `endpoint` null, `credential_ref`
null and `egress_allowlist` empty — **starts cleanly**, so the suite also shows
that the refusals are not refusing everything.

Criterion 10's Gate 3 assertion lives here too: it is a **negative registry and
startup assertion only**. No real source exists, none may exist before Gate 3,
and all four capability gates are CLOSED (authorization §8 item 1).
"""
from __future__ import annotations

import copy
import json

import pytest

from cbdc_ingestion.adapters import registry as registry_module
from cbdc_ingestion.adapters.base import Adapter
from cbdc_ingestion.adapters.registry import (
    RegistryInvalid,
    SOURCES_PATH,
    check_description,
    load_registry,
    parse_record,
    selected_records,
)

from .adapter_cases import ADAPTERS

SHIPPED = json.loads(SOURCES_PATH.read_text(encoding="utf-8"))


def a_record() -> dict:
    """A deep copy of the one shipped synthetic record: the positive control."""
    return copy.deepcopy(SHIPPED["sources"][0])


# -------------------------------------------------------------- positive control
def test_the_shipped_registry_loads_cleanly():
    registry = load_registry()
    assert registry.records, "the shipped registry must hold at least one record"
    for record in registry.records:
        assert record.provenance_class == "synthetic", (
            "Phase 3.3-A ships synthetic records only (authorization §8 item 1)")


def test_the_positive_control_starts_cleanly():
    record = parse_record(a_record())
    assert record.endpoint is None
    assert record.credential_ref is None
    assert record.egress_allowlist == ()
    assert record.startable


def test_no_record_selects_the_adapter_path_by_default():
    """Authorization §7.2: the D-24 generator stays the default."""
    assert selected_records(load_registry()) == ()


# ------------------------------------------- §6.1's three synthetic-only assertions
def test_a_synthetic_record_with_an_endpoint_fails_at_startup():
    raw = a_record()
    raw["endpoint"] = "https://example.invalid/fx"
    with pytest.raises(RegistryInvalid, match="endpoint"):
        parse_record(raw)


def test_a_synthetic_record_with_a_credential_ref_fails_at_startup():
    raw = a_record()
    raw["credential_ref"] = "some-key-name"
    with pytest.raises(RegistryInvalid, match="credential_ref"):
        parse_record(raw)


def test_a_synthetic_record_with_a_non_empty_egress_allowlist_fails_at_startup():
    raw = a_record()
    raw["egress_allowlist"] = ["example.invalid"]
    with pytest.raises(RegistryInvalid, match="egress_allowlist"):
        parse_record(raw)


def test_the_three_synthetic_assertions_are_independent():
    """Each is raised on its own, so one passing cannot mask another."""
    raised = []
    for field, value in (("endpoint", "https://example.invalid/fx"),
                         ("credential_ref", "k"), ("egress_allowlist", ["h"])):
        raw = a_record()
        raw[field] = value
        with pytest.raises(RegistryInvalid) as info:
            parse_record(raw)
        raised.append(str(info.value))
    assert len({*raised}) == 3, "each assertion must fail with its own reason"


# ------------------------------------------------------- criterion 2's named cases
def test_a_synthetic_prefix_with_a_non_synthetic_class_fails():
    raw = a_record()
    raw["provenance_class"] = "assumed"
    with pytest.raises(RegistryInvalid, match="synthetic"):
        parse_record(raw)


def test_a_non_synthetic_prefix_with_the_synthetic_class_fails():
    """The check binds in both directions (AD-4 §3.2)."""
    raw = a_record()
    raw["source_id"] = "fx.adapter"
    with pytest.raises(RegistryInvalid, match="prefix"):
        parse_record(raw)


def test_a_transport_mismatch_fails():
    raw = a_record()
    raw["transport"] = "websocket"
    with pytest.raises(RegistryInvalid, match="transport"):
        parse_record(raw)


@pytest.mark.parametrize("transport", ["websocket", "poll", "scheduled", "manual"])
def test_only_the_synthetic_transport_is_authorized_in_this_scope(transport):
    """Authorization §8 items 1 and 2: no real provider, no outbound network."""
    raw = a_record()
    raw["transport"] = transport
    raw["provenance_class"] = "real"
    raw["source_id"] = "provider.fx"
    raw["provider_id"] = "p"
    raw["gate3_decision_ref"] = {"ref": "gate3/none", "status": "active"}
    if transport in ("poll", "scheduled"):
        raw["schedule"] = "PT2S"
    with pytest.raises(RegistryInvalid):
        parse_record(raw)


def test_a_freshness_profile_breaking_the_ordering_invariant_fails():
    raw = a_record()
    raw["freshness_profile"]["unavailable_after_ms"] = 1000  # below stale_after_ms
    with pytest.raises(RegistryInvalid, match="unavailable_after_ms"):
        parse_record(raw)


def test_a_freshness_profile_with_an_unknown_field_fails():
    raw = a_record()
    raw["freshness_profile"]["live_after_ms"] = 1
    with pytest.raises(RegistryInvalid, match="unknown freshness_profile field"):
        parse_record(raw)


def test_an_unknown_registry_field_fails():
    raw = a_record()
    raw["provider_url"] = "https://example.invalid"
    with pytest.raises(RegistryInvalid, match="unknown registry field"):
        parse_record(raw)


@pytest.mark.parametrize("field", ["source_id", "transport", "provenance_class",
                                   "freshness_profile", "status", "adapter_id", "dedup"])
def test_an_incomplete_record_fails(field):
    raw = a_record()
    del raw[field]
    with pytest.raises(RegistryInvalid):
        parse_record(raw)


def test_a_plausibility_bound_given_as_a_float_fails():
    """AD-5 §4: bounds are decimal strings; a float loses the producer's digits."""
    raw = a_record()
    raw["plausibility"]["ranges"]["fx_rate:EUR/USD/mid"]["min"] = 2.19
    with pytest.raises(RegistryInvalid, match="decimal string"):
        parse_record(raw)


def test_restart_safe_dedup_cannot_be_declared_in_this_scope():
    """Authorization §8 item 4: it is excluded, so the registry cannot claim it."""
    raw = a_record()
    raw["dedup"] = "across_runs"
    with pytest.raises(RegistryInvalid, match="within_run"):
        parse_record(raw)


# ------------------------------------------------------- criterion 10: Gate 3
def a_real_record() -> dict:
    """A `real` record, used **only** to assert that it cannot start.

    No provider is named, no endpoint resolves and nothing is contacted: this is
    a negative registry assertion over a literal, which authorization §8 item 1
    permits and Gate 3 does not govern.
    """
    raw = a_record()
    raw.update(source_id="provider.fx", provenance_class="real", transport="poll",
               provider_id="unnamed", schedule="PT2S", endpoint="https://example.invalid/fx",
               gate3_decision_ref={"ref": "gate3/decision/none", "status": "active"})
    return raw


@pytest.mark.parametrize("gate3", [
    None,
    {"ref": "gate3/decision/none", "status": "inactive"},
    {"ref": "gate3/decision/none", "status": "withdrawn"},
])
def test_a_real_source_without_an_active_gate3_decision_does_not_start(gate3):
    raw = a_real_record()
    raw["gate3_decision_ref"] = gate3
    with pytest.raises(RegistryInvalid, match="Gate 3|active"):
        parse_record(raw)


def test_a_real_source_is_refused_in_this_scope_even_with_an_active_decision():
    """Belt and braces: the transport authorization refuses it regardless."""
    with pytest.raises(RegistryInvalid):
        parse_record(a_real_record())


# ------------------------------------------- criterion 1: describe() against the record
def test_a_description_mismatch_is_a_startup_failure():
    from .adapter_cases import adapter_for_record

    registry = load_registry()
    record = registry.record_for("synthetic.fx.adapter")
    adapter = adapter_for_record(record)
    check_description(record, adapter.describe())  # the matching case passes

    mismatched = adapter.describe().__class__(
        adapter_id="not_the_selected_adapter",
        transports=("synthetic",),
        event_types=("fx_rate",),
        subjects=record.subjects,
        emits_timestamp_basis=record.timestamp_basis,
    )
    with pytest.raises(RegistryInvalid, match="adapter"):
        check_description(record, mismatched)


def test_a_timestamp_basis_mismatch_is_a_startup_failure():
    from .adapter_cases import adapter_for_record

    registry = load_registry()
    record = registry.record_for("synthetic.fx.adapter")
    description = adapter_for_record(record).describe()
    mismatched = description.__class__(
        adapter_id=description.adapter_id, transports=description.transports,
        event_types=description.event_types, subjects=description.subjects,
        emits_timestamp_basis="published",
    )
    with pytest.raises(RegistryInvalid, match="timestamp_basis"):
        check_description(record, mismatched)


# --------------------------------------------------- the contract suite is complete
def test_every_adapter_subclass_is_in_the_shared_contract_suite():
    """A-1: an adapter cannot be added without joining the one shared suite."""
    import cbdc_ingestion.adapters.synthetic_fx  # noqa: F401 - registers the subclass

    # Compared by class, not by factory: the suite's entries are callables, and
    # one of them is a function that builds the adapter from the registry.
    covered = {type(factory()) for _, factory in ADAPTERS}
    shipped = {cls for cls in _all_subclasses(Adapter)
               if cls.__module__.startswith("cbdc_ingestion.")}
    assert shipped <= covered, (
        f"adapter(s) outside the shared contract suite: "
        f"{sorted(c.__name__ for c in shipped - covered)}")


def _all_subclasses(cls) -> set:
    found = set()
    for sub in cls.__subclasses__():
        found.add(sub)
        found |= _all_subclasses(sub)
    return found


def test_the_registry_module_imports_nothing_outside_ingestion():
    """Criterion 12: no `src/`, no inference client, no database client."""
    source = registry_module.__file__
    text = open(source, encoding="utf-8").read()
    # Whole import statements, not bare substrings: "socket" occurs inside the
    # legitimate transport name "websocket".
    for forbidden in ("import src", "from src", "services.inference", "import psycopg",
                      "import sqlalchemy", "import requests", "import httpx",
                      "import urllib", "import socket"):
        assert forbidden not in text, f"{forbidden!r} must not appear in registry.py"
