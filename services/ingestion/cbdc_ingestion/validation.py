"""Strict validation of a generated envelope, before it can be served.

AD-4 §6: "Validation runs at ingestion and again at the first downstream trust
boundary." This module is the ingestion half. Express re-validates independently
(AD-1 §3.4), and neither side trusts the other's verdict.

It is a hand-written validator rather than a JSON Schema run, because the
component must stay standard-library-only (AD-1 §3.7's "no new dependency"
condition). It implements the subset of
`contracts/events/event-envelope.v1.schema.json` that a synthetic `fx_rate`
event can reach, and it is **closed**: an unknown key at any level is a failure,
exactly as the schema's `additionalProperties: false` is.
`tests/test_schema_conformance.py` cross-checks it against the committed schema
with `jsonschema` whenever that package is importable, so the two cannot drift
apart unnoticed.

A failure here is a **programming error in this component**, not untrusted
input: there is no external input. It therefore raises rather than returning a
status, so a malformed event can never be served.
"""
from __future__ import annotations

import re
from typing import Any

from . import SCHEMA_VERSION, SOURCE_ID
from .canonical import payload_sha256
from .clock import parse_timestamp
from .pairs import CURRENCIES, RATE_TYPE, is_allowed

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
TIMESTAMP_RE = re.compile(
    r"^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$")
# AD-4 §4: a positive decimal string. No exponent, no leading `+`, no leading zero.
POSITIVE_DECIMAL_RE = re.compile(r"^(0\.[0-9]*[1-9][0-9]*|[1-9][0-9]*(\.[0-9]+)?)$")

ENVELOPE_KEYS = frozenset({
    "schema_version", "event_id", "event_type", "usage", "source", "provenance_class", "derived_from",
    "derivation", "timestamps", "source_sequence", "payload", "payload_sha256", "raw_sha256",
    "validation", "extraction", "review", "supersedes", "synthetic"})
SOURCE_KEYS = frozenset({"source_id", "transport", "source_url", "gate3_decision_ref"})
TIMESTAMP_KEYS = frozenset({"source_timestamp", "source_timestamp_basis", "retrieved_at", "emitted_at"})
VALIDATION_KEYS = frozenset({"status", "reasons"})
SYNTHETIC_KEYS = frozenset({"generator_version", "seed", "case_id"})
PAYLOAD_KEYS = frozenset({"base_currency", "quote_currency", "rate", "rate_type"})
QUARANTINE_REASONS = frozenset({"FUTURE_SOURCE_TIMESTAMP", "VALUE_OUT_OF_RANGE", "VALUE_JUMP", "REVIEW_REQUIRED"})
MAX_SAFE_SEED = 2 ** 53 - 1


class EnvelopeInvalid(ValueError):
    """The envelope breaks AD-4 v0.2 or the AD-1 §3.4 slice restrictions."""


def _fail(reason: str) -> None:
    raise EnvelopeInvalid(reason)


def _exact_keys(node: Any, allowed: frozenset, where: str) -> None:
    if not isinstance(node, dict):
        _fail(f"{where} must be an object")
    missing = allowed - set(node)
    unknown = set(node) - allowed
    if missing:
        _fail(f"{where} is missing {sorted(missing)}")
    if unknown:
        _fail(f"{where} has unknown members {sorted(unknown)} (the schema is closed)")


def validate_fx_envelope(event: Any) -> dict:
    """Returns `event` unchanged if it is a valid synthetic `fx_rate` envelope.

    Raises `EnvelopeInvalid` otherwise. Checks, in order: structure and closure;
    the display-only and synthetic markers (AD-4 §3.2, all four of them); the
    absence of derivation, extraction, review and supersession; timestamp shape
    and ordering; the `fx_rate` payload, its codes and the pair allowlist; and the
    `payload_sha256`, recomputed rather than trusted.
    """
    _exact_keys(event, ENVELOPE_KEYS, "envelope")

    if event["schema_version"] != SCHEMA_VERSION:
        _fail(f"schema_version must be {SCHEMA_VERSION!r}")
    if event["event_type"] != "fx_rate":
        _fail("this component emits fx_rate events only (AD-4 §1)")
    if event["usage"] != "display_only":
        _fail("usage must be display_only (AD-4 §2, AD-6 B-1)")
    if not isinstance(event["event_id"], str) or not UUID_RE.match(event["event_id"]):
        _fail("event_id must be a UUID")

    # --- the four synthetic markers, which must all agree (AD-4 §3.2) ---
    if event["provenance_class"] != "synthetic":
        _fail("provenance_class must be synthetic")
    _exact_keys(event["source"], SOURCE_KEYS, "source")
    source = event["source"]
    if source["source_id"] != SOURCE_ID:
        _fail(f"source_id must be {SOURCE_ID!r}")
    if not source["source_id"].startswith("synthetic."):
        _fail("a synthetic event needs a source_id beginning 'synthetic.'")
    if source["transport"] != "synthetic":
        _fail("transport must be synthetic")
    if source["source_url"] is not None:
        _fail("a synthetic event has no source_url")
    if source["gate3_decision_ref"] is not None:
        _fail("a synthetic event has no Gate 3 reference")

    _exact_keys(event["synthetic"], SYNTHETIC_KEYS, "synthetic")
    block = event["synthetic"]
    if not isinstance(block["generator_version"], str) or not 1 <= len(block["generator_version"]) <= 200:
        _fail("synthetic.generator_version must be a non-empty string of at most 200 characters")
    if (not isinstance(block["seed"], int) or isinstance(block["seed"], bool)
            or not 0 <= block["seed"] <= MAX_SAFE_SEED):
        _fail("synthetic.seed must be an integer in [0, 2^53 - 1]")
    if not isinstance(block["case_id"], str) or not 1 <= len(block["case_id"]) <= 200:
        _fail("synthetic.case_id must be a non-empty string of at most 200 characters")

    # --- nothing is derived, extracted, reviewed or superseded in this slice ---
    if event["derived_from"] != []:
        _fail("a generated event derives from nothing (AD-4 §3.1)")
    if event["derivation"] is not None:
        _fail("derivation must be null when derived_from is empty")
    if event["extraction"] is not None:
        _fail("this component extracts nothing")
    if event["review"] is not None:
        _fail("this component has no review queue (AD-1 §3.4)")
    if event["supersedes"] is not None:
        _fail("this component never supersedes an event")
    if event["raw_sha256"] is not None:
        _fail("there are no raw provider bytes to hash")
    if not (event["source_sequence"] is None
            or (isinstance(event["source_sequence"], str) and 1 <= len(event["source_sequence"]) <= 100)):
        _fail("source_sequence must be null or a string of 1 to 100 characters")

    # --- timestamps (AD-4 §5) ---
    _exact_keys(event["timestamps"], TIMESTAMP_KEYS, "timestamps")
    stamps = event["timestamps"]
    for field in ("source_timestamp", "retrieved_at", "emitted_at"):
        value = stamps[field]
        if not isinstance(value, str) or not TIMESTAMP_RE.match(value):
            _fail(f"timestamps.{field} must be a UTC RFC 3339 timestamp with exactly three fractional digits")
    # The generator is its own provider, so it always states when it observed the value.
    if stamps["source_timestamp_basis"] != "observed":
        _fail("source_timestamp_basis must be 'observed' for the synthetic generator")
    if parse_timestamp(stamps["retrieved_at"]) > parse_timestamp(stamps["emitted_at"]):
        _fail("retrieved_at must not follow emitted_at (AD-4 §5)")

    # --- validation status (AD-4 §6) ---
    _exact_keys(event["validation"], VALIDATION_KEYS, "validation")
    status, reasons = event["validation"]["status"], event["validation"]["reasons"]
    if status not in ("validated", "quarantined"):
        _fail("validation.status must be 'validated' or 'quarantined'")
    if not isinstance(reasons, list) or len(set(map(str, reasons))) != len(reasons):
        _fail("validation.reasons must be an array of unique reasons")
    if any(r not in QUARANTINE_REASONS for r in reasons):
        _fail("validation.reasons holds an unknown reason")
    if status == "validated" and reasons:
        _fail("a validated event carries no reasons")
    if status == "quarantined" and not reasons:
        _fail("a quarantined event states at least one reason")

    # --- payload (AD-4 §4) and the slice allowlist (AD-1 §3.4) ---
    _exact_keys(event["payload"], PAYLOAD_KEYS, "payload")
    payload = event["payload"]
    base, quote = payload["base_currency"], payload["quote_currency"]
    for field, value in (("base_currency", base), ("quote_currency", quote)):
        if not isinstance(value, str) or not re.fullmatch(r"[A-Z]{3}", value):
            _fail(f"payload.{field} must be a three-letter upper-case code")
        if value not in CURRENCIES:
            _fail(f"payload.{field} {value!r} is not a currency of this slice")
    if base == quote:
        _fail("an fx_rate names two different currencies (AD-4 §6)")
    if not is_allowed(base, quote):
        _fail(f"{base}/{quote} is outside the pair allowlist (AD-1 §3.4)")
    if payload["rate_type"] != RATE_TYPE:
        _fail(f"rate_type must be {RATE_TYPE!r} in this slice")
    if not isinstance(payload["rate"], str) or not POSITIVE_DECIMAL_RE.match(payload["rate"]):
        _fail("payload.rate must be a positive decimal string (AD-4 §4)")
    if len(payload["rate"]) > 40:
        _fail("payload.rate is longer than 40 characters")

    # --- the hash is recomputed, never trusted (AD-4 §2) ---
    if not isinstance(event["payload_sha256"], str) or not SHA256_RE.match(event["payload_sha256"]):
        _fail("payload_sha256 must be lowercase hex SHA-256")
    if event["payload_sha256"] != payload_sha256("fx_rate", payload):
        _fail("payload_sha256 does not match the payload")
    return event
