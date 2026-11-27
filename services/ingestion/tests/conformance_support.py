"""Helpers for the AD-5 conformance fixtures. Fixture checks only — nothing here classifies.

`leaf_diff` and `observation_key` / `idempotency_key` verify **properties of the
fixtures** (which paths differ; whether two envelopes share an AD-5 §8.1 key).
They never produce a C-b / D / C-a outcome, never compare §8.2b fields, and are
not a substitute for `dedup.py`. The outcome is asserted only against the real
classifier, in `test_idempotency_conformance.py`.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts" / "events"

# AD-5 §6.3 subject fields per event type. announcement has none (§6.3).
SUBJECT_FIELDS = {
    "fx_rate": ("base_currency", "quote_currency", "rate_type"),
    "economic_indicator": ("indicator_code", "country", "period"),
    "bank_holiday": ("country", "date"),
    "announcement": (),
}


def flatten(node, prefix: str = "") -> dict:
    """Dotted leaf paths. A dict contributes its own path (so `{}`/None swaps show) plus its leaves; lists are leaves."""
    out = {}
    if isinstance(node, dict):
        if prefix:
            out[prefix] = "<object>"
        for k, v in node.items():
            out.update(flatten(v, f"{prefix}.{k}" if prefix else k))
    else:
        out[prefix] = node
    return out


def leaf_diff(a: dict, b: dict) -> set:
    fa, fb = flatten(a), flatten(b)
    return {p for p in fa.keys() | fb.keys() if fa.get(p, "<absent>") != fb.get(p, "<absent>")}


def observation_key(e: dict) -> tuple:
    """AD-5 §8.1 observation_key. Null-timestamp substitution (§8.1) is out of 3.3-A scope and not modelled."""
    subject = tuple(e["payload"].get(f) for f in SUBJECT_FIELDS[e["event_type"]])
    return (e["source"]["source_id"], e["event_type"], subject, e["timestamps"]["source_timestamp"])


def idempotency_key(e: dict) -> tuple:
    return (observation_key(e), e["payload_sha256"])


def _load(name: str) -> dict:
    return json.loads((CONTRACTS / name).read_text(encoding="utf-8"))


def envelope_validator():
    jsonschema = pytest.importorskip("jsonschema")  # installed by CI's ingestion-unit job
    return jsonschema.Draft202012Validator(_load("event-envelope.v1.schema.json"))


def wrapper_validator():
    """ingestion-latest.v1, resolving its `$ref` to the envelope schema by `$id`."""
    jsonschema = pytest.importorskip("jsonschema")
    referencing = pytest.importorskip("referencing")
    envelope = _load("event-envelope.v1.schema.json")
    registry = referencing.Registry().with_resource(envelope["$id"], referencing.Resource.from_contents(envelope))
    return jsonschema.Draft202012Validator(_load("ingestion-latest.v1.schema.json"), registry=registry)


def schema_errors(validator, instance) -> list:
    return sorted((e.message for e in validator.iter_errors(instance)))
