"""The envelope builder and the strict validator (AD-4 v0.2, AD-1 §3.4).

The validator is the ingestion half of AD-4 §6's two-stage validation. These
tests take a known-good envelope and break one rule at a time, so each check is
shown to be load-bearing rather than decorative.
"""
from __future__ import annotations

import copy
import uuid

import pytest

from cbdc_ingestion.canonical import payload_sha256
from cbdc_ingestion.clock import format_timestamp, parse_timestamp
from cbdc_ingestion.envelope import (CLOCK_TOLERANCE_MS, FUTURE_SOURCE_TIMESTAMP, build_fx_event,
                                     event_id_for, fx_payload)
from cbdc_ingestion.validation import EnvelopeInvalid, validate_fx_envelope

from .conftest import SEED, START_MS


def good(**kwargs) -> dict:
    payload = fx_payload("USD", "INR", "1.234500")
    return build_fx_event(seed=SEED, sequence=1, payload=payload, retrieved_at_ms=START_MS, **kwargs)


def test_a_built_envelope_is_valid():
    assert validate_fx_envelope(good())


def test_the_timestamps_default_to_one_moment():
    """The generator is its own provider, so observation, retrieval and emission
    coincide (AD-4 §5). `retrieved_at <= emitted_at` holds trivially."""
    stamps = good()["timestamps"]
    assert stamps["source_timestamp"] == stamps["retrieved_at"] == stamps["emitted_at"]
    assert stamps["source_timestamp"] == format_timestamp(START_MS)
    assert stamps["source_timestamp_basis"] == "observed"


def test_emitted_at_may_follow_retrieved_at():
    event = good(emitted_at_ms=START_MS + 60)
    assert parse_timestamp(event["timestamps"]["emitted_at"]) == START_MS + 60
    validate_fx_envelope(event)


def test_emitted_at_may_not_precede_retrieved_at():
    with pytest.raises(ValueError):
        good(emitted_at_ms=START_MS - 1)


def test_the_payload_hash_is_the_ad4_hash():
    event = good()
    assert event["payload_sha256"] == payload_sha256("fx_rate", event["payload"])


def test_event_id_is_a_uuid5_of_seed_pair_sequence_and_source_timestamp():
    stamp = format_timestamp(START_MS)
    assert good()["event_id"] == event_id_for(SEED, "USD/INR", 1, stamp)
    assert uuid.UUID(good()["event_id"]).version == 5
    # Each of the four inputs changes the identity. The pair is one of them: without
    # it, a restart could give two pairs one ID (`tests/test_restart_identity.py`).
    assert event_id_for(SEED, "USD/INR", 1, stamp) != event_id_for(SEED, "USD/INR", 2, stamp)
    assert event_id_for(SEED, "USD/INR", 1, stamp) != event_id_for(SEED + 1, "USD/INR", 1, stamp)
    assert event_id_for(SEED, "USD/INR", 1, stamp) != event_id_for(SEED, "EUR/USD", 1, stamp)
    assert event_id_for(SEED, "USD/INR", 1, stamp) != \
        event_id_for(SEED, "USD/INR", 1, format_timestamp(START_MS + 1))


def test_a_redelivery_keeps_the_event_id():
    """AD-4 §2: "A redelivery keeps it." The same inputs rebuild the same identity."""
    assert good() == good()


# ------------------------------------------------------------------ quarantine
def test_a_future_source_timestamp_is_quarantined():
    """AD-1 §3.4: ingestion marks a source timestamp more than 1 s after
    `retrieved_at` as quarantined and withholds it (AD-4 §6)."""
    event = good(source_timestamp_ms=START_MS + CLOCK_TOLERANCE_MS + 1)
    assert event["validation"] == {"status": "quarantined", "reasons": [FUTURE_SOURCE_TIMESTAMP]}
    # It is still a well-formed envelope: it is withheld by the store, not malformed.
    validate_fx_envelope(event)


def test_exactly_the_tolerance_is_still_validated():
    event = good(source_timestamp_ms=START_MS + CLOCK_TOLERANCE_MS)
    assert event["validation"]["status"] == "validated"


def test_a_past_source_timestamp_is_not_quarantined():
    event = good(source_timestamp_ms=START_MS - 60_000)
    assert event["validation"]["status"] == "validated"


# ------------------------------------------------------------- validator teeth
@pytest.mark.parametrize("mutate, why", [
    (lambda e: e.update(schema_version="1.1"), "unknown envelope version"),
    (lambda e: e.update(event_type="bank_holiday"), "another event type"),
    (lambda e: e.update(usage="engine_input"), "usage other than display_only"),
    (lambda e: e.update(event_id="not-a-uuid"), "malformed event_id"),
    (lambda e: e.update(provenance_class="real"), "a non-synthetic class"),
    (lambda e: e["source"].update(transport="poll"), "a transport that is not synthetic"),
    (lambda e: e["source"].update(source_id="acme.fx"), "a source_id without the synthetic prefix"),
    (lambda e: e["source"].update(source_url="https://example.invalid/fx"), "a URL on a synthetic event"),
    (lambda e: e["source"].update(gate3_decision_ref="GATE3-001"), "a Gate 3 reference on a synthetic event"),
    (lambda e: e.update(synthetic=None), "a missing synthetic block"),
    (lambda e: e["synthetic"].update(seed=-1), "a negative seed"),
    (lambda e: e["synthetic"].update(case_id=""), "an empty case_id"),
    (lambda e: e.update(derived_from=[str(uuid.uuid4())]), "a derivation input"),
    (lambda e: e.update(derivation="inverted"), "a derivation method with no inputs"),
    (lambda e: e.update(raw_sha256="0" * 64), "raw provider bytes that cannot exist"),
    (lambda e: e.update(extraction={"tool": "t", "tool_version": "1", "status": "complete",
                                    "confidence": 1}), "an extraction block"),
    (lambda e: e.update(review={"reviewer_ref": "r", "reviewed_at": format_timestamp(START_MS)}),
     "a review block"),
    (lambda e: e.update(supersedes=str(uuid.uuid4())), "a superseded event"),
    (lambda e: e.update(source_sequence=1), "a non-string source_sequence"),
    (lambda e: e["timestamps"].update(source_timestamp="2025-11-25T00:00:00Z"), "a timestamp without milliseconds"),
    (lambda e: e["timestamps"].update(source_timestamp_basis="published"), "a basis other than observed"),
    (lambda e: e["timestamps"].update(emitted_at=format_timestamp(START_MS - 1)), "emitted before retrieved"),
    (lambda e: e["validation"].update(status="validated", reasons=[FUTURE_SOURCE_TIMESTAMP]),
     "a validated event with reasons"),
    (lambda e: e["validation"].update(status="quarantined", reasons=[]),
     "a quarantined event with no reason"),
    (lambda e: e["validation"].update(reasons=["NOPE"], status="quarantined"), "an unknown reason"),
    (lambda e: e["payload"].update(rate="0"), "a non-positive rate"),
    (lambda e: e["payload"].update(rate="1.2e3"), "an exponent in a rate"),
    (lambda e: e["payload"].update(rate=1.2345), "a JSON number rate"),
    (lambda e: e["payload"].update(rate_type="bid"), "a rate type outside the slice"),
    (lambda e: e["payload"].update(quote_currency="USD", base_currency="USD"), "identical currencies"),
    (lambda e: e["payload"].update(base_currency="INR", quote_currency="USD"), "a pair outside the allowlist"),
    (lambda e: e["payload"].update(base_currency="JPY"), "a currency outside the slice"),
    (lambda e: e.update(payload_sha256="0" * 64), "a hash that does not match the payload"),
    (lambda e: e.update(unexpected="x"), "an unknown envelope member"),
    (lambda e: e["source"].update(unexpected="x"), "an unknown source member"),
    (lambda e: e["payload"].update(unexpected="x"), "an unknown payload member"),
    (lambda e: e.pop("usage"), "a missing required member"),
])
def test_the_validator_rejects(mutate, why):
    original = good()
    event = copy.deepcopy(original)
    mutate(event)
    # A payload mutation would otherwise be caught by the hash check alone, which
    # would leave the rule under test unexercised. Re-hash first, where the
    # canonicalizer can (it refuses a JSON-number rate, which is itself the point
    # of that case), so the failure comes from the rule and not from the digest.
    if event.get("payload") != original["payload"]:
        try:
            event["payload_sha256"] = payload_sha256("fx_rate", event["payload"])
        except Exception:  # noqa: BLE001 - outside the P-9 subset; keep the old hash
            pass
    with pytest.raises(EnvelopeInvalid):
        validate_fx_envelope(event)


def test_the_validator_rejects_a_non_object():
    for value in (None, [], "x", 1):
        with pytest.raises(EnvelopeInvalid):
            validate_fx_envelope(value)
