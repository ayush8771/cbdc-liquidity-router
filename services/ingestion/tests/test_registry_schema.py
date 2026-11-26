"""Acceptance criterion 3: registry schema conformance.

Every shipped record validates against
`contracts/events/registry/source-record.v1.schema.json`, **and a deliberately
invalid record fails** — so the schema is **exercised, not merely present**
(authorization §7.4).

**Why this is a test and not a workflow step.** Settled by owner direction
(DB-2): the `ingestion-unit` job is the validation route, and no workflow
changes. `infra/scripts/check_event_contracts.py` and `check_contracts.py` are
**not** extended to cover `contracts/events/registry/`; they are Dev D's (P-8).
So this suite, under the existing no-skip check, is the **only** automated use
of that schema.

**The schema is not in the runtime image, by construction.** It lies outside the
ingestion build context, so the running service cannot load it. The runtime
validates records with `adapters/registry.py`. This suite is what keeps the two
from drifting apart — the same arrangement `test_schema_conformance.py` already
uses for the envelope.
"""
from __future__ import annotations

import copy
import json

import pytest

from cbdc_ingestion.adapters.registry import RegistryInvalid, SOURCES_PATH, parse_record

from .conftest import CONTRACTS

SCHEMA_PATH = CONTRACTS / "events" / "registry" / "source-record.v1.schema.json"
SHIPPED = json.loads(SOURCES_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def record_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def validator(schema: dict):
    """A `jsonschema` validator, or a skip.

    `jsonschema` is an **optional** cross-check: the component's runtime
    dependency set is the standard library only (`pyproject.toml`). CI installs
    it, so this does not skip there, and `assert_junit_no_skips.py` holds that
    true.
    """
    jsonschema = pytest.importorskip("jsonschema")
    return jsonschema.Draft202012Validator(schema)


def a_record() -> dict:
    return copy.deepcopy(SHIPPED["sources"][0])


# ------------------------------------------------- the schema itself is well formed
def test_the_schema_is_a_valid_2020_12_schema(record_schema):
    jsonschema = pytest.importorskip("jsonschema")
    jsonschema.Draft202012Validator.check_schema(record_schema)


def test_the_schema_is_closed_and_marked_draft(record_schema):
    assert record_schema["additionalProperties"] is False, (
        "an open record schema would let an unreviewed field in silently")
    assert "DRAFT" in record_schema["description"]


# ------------------------------------------------------------- every shipped record
def test_every_shipped_record_validates_against_the_schema(record_schema):
    check = validator(record_schema)
    assert SHIPPED["sources"], "the registry ships at least one record"
    for raw in SHIPPED["sources"]:
        errors = sorted(check.iter_errors(raw), key=lambda e: e.json_path)
        assert not errors, (
            f"{raw.get('source_id')}: "
            + "; ".join(f"{e.json_path}: {e.message}" for e in errors))


def test_the_shipped_registry_file_has_a_closed_envelope():
    assert set(SHIPPED) <= {"registry_version", "note", "sources"}
    assert isinstance(SHIPPED["sources"], list)


# -------------------------------------- a deliberately invalid record must fail
@pytest.mark.parametrize("mutation, expected_path", [
    ({"endpoint": "https://example.invalid/fx"}, "endpoint"),
    ({"credential_ref": "a-key-name"}, "credential_ref"),
    ({"egress_allowlist": ["example.invalid"]}, "egress_allowlist"),
    ({"transport": "websocket"}, "transport"),
    ({"source_id": "fx.adapter"}, "source_id"),
    ({"dedup": "across_runs"}, "dedup"),
    ({"status": "retired"}, "status"),
    ({"event_types": []}, "event_types"),
    ({"unexpected_field": 1}, "unexpected_field"),
])
def test_a_deliberately_invalid_record_fails_the_schema(record_schema, mutation, expected_path):
    """The schema is exercised: each mutation is rejected on its own."""
    check = validator(record_schema)
    raw = a_record()
    raw.update(mutation)
    assert list(check.iter_errors(raw)), f"the schema accepted an invalid {expected_path}"


def test_a_plausibility_bound_given_as_a_number_fails_the_schema(record_schema):
    """AD-5 §4: bounds are decimal strings. The schema and the runtime agree."""
    check = validator(record_schema)
    raw = a_record()
    raw["plausibility"]["ranges"]["fx_rate:EUR/USD/mid"]["min"] = 2.19
    assert list(check.iter_errors(raw))


# ------------------------------------- the schema and the runtime validator agree
@pytest.mark.parametrize("mutation", [
    {"endpoint": "https://example.invalid/fx"},
    {"credential_ref": "a-key-name"},
    {"egress_allowlist": ["example.invalid"]},
    {"transport": "websocket"},
    {"source_id": "fx.adapter"},
    {"dedup": "across_runs"},
    {"unexpected_field": 1},
])
def test_the_runtime_validator_refuses_what_the_schema_refuses(record_schema, mutation):
    """Both must give the same verdict, or the image and the review disagree.

    The runtime is the authority at run time (§7.4); the schema is the authority
    at review time. A record either passes both or fails both.
    """
    check = validator(record_schema)
    raw = a_record()
    raw.update(mutation)
    assert list(check.iter_errors(raw)), "precondition: the schema rejects this record"
    with pytest.raises(RegistryInvalid):
        parse_record(raw)


def test_both_accept_the_shipped_record(record_schema):
    """The positive control on both sides, so neither is refusing everything."""
    check = validator(record_schema)
    raw = a_record()
    assert not list(check.iter_errors(raw))
    assert parse_record(raw).source_id == raw["source_id"]


def test_the_schema_requires_every_field_the_runtime_requires(record_schema):
    from cbdc_ingestion.adapters.registry import RECORD_FIELDS

    assert set(record_schema["required"]) == set(RECORD_FIELDS), (
        "the schema's required set and the runtime's RECORD_FIELDS must not drift")
    assert set(record_schema["properties"]) == set(RECORD_FIELDS)
