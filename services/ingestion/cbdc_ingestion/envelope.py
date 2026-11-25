"""Builds AD-4 v0.2 `fx_rate` event envelopes for synthetic observations.

Every envelope this module produces is synthetic, display-only and marked as
such on all four of AD-4 §3.2's markers, which the schema cross-checks:
`provenance_class: synthetic`, `transport: synthetic`, a `source_id` beginning
`synthetic.`, and a non-null `synthetic` block. There is no code path here that
can emit `real`, `derived` or `assumed`, no field for a URL or a Gate 3
reference, and no event type other than `fx_rate` (AD-4 §1, §3.2; AD-6 B-1).

`event_id` is a **UUIDv5** of the seed, the **pair**, the sequence and the source
timestamp (AD-1 §3, AD-12 row, as corrected), so a redelivery of the same event
keeps its identity (AD-4 §2) and a replay with the same seed, sequence and
injected clock reproduces it exactly (AD-1 §6 item 1).
"""
from __future__ import annotations

import uuid
from typing import Optional

from . import GENERATOR_VERSION, SCHEMA_VERSION, SOURCE_ID
from .canonical import payload_sha256
from .clock import format_timestamp

# A fixed, project-local namespace for synthetic observation event IDs. It is an
# identifier, not a secret, and it must never change: changing it would renumber
# every event a given seed produces.
EVENT_ID_NAMESPACE = uuid.UUID("3f1b8a52-6c4d-5e7a-9b21-0d4e6f8a1c93")

# AD-1 §3.2 `clock_tolerance_ms`, applied by ingestion to its own quarantine rule
# (AD-1 §3.4: a source timestamp more than 1 s after `retrieved_at` is quarantined).
CLOCK_TOLERANCE_MS = 1000

# The AD-4 §6 quarantine reason this component can raise. No other reason applies:
# plausibility bounds (`VALUE_OUT_OF_RANGE`, `VALUE_JUMP`) are AD-5's and are not
# set for this slice, and `REVIEW_REQUIRED` concerns announcements and extractions,
# neither of which this component produces.
FUTURE_SOURCE_TIMESTAMP = "FUTURE_SOURCE_TIMESTAMP"


def event_id_for(seed: int, pair_key: str, sequence: int, source_timestamp: str) -> str:
    """The UUIDv5 event ID of one generated observation (AD-1 §3, AD-12 row).

    The name is `seed|pair|sequence|source_timestamp`. **The pair is part of it,
    and must be**: without it, two events with different pairs and different rates
    could share an ID across a process restart, and under AD-1 §3.4 Express
    rejects an event whose `event_id` matches a current event with different
    content or another pair, so those pairs' values would stall and age out.

    Within one run the 500 ms stagger alone makes a cross-pair collision
    impossible, because `500i + 2000(n-1) = 500j + 2000(n-1)` holds only when
    `i == j`. A restart breaks that argument: it resets every pair's sequence to 1
    and re-bases the stagger on a new `start_ms`, so a restart offset of 500, 1000
    or 1500 ms (mod 2000) lines up one run's pair *i* with another's pair *j*, at
    equal sequences and equal timestamps. The offset is then constant, so the
    collision persists for the whole run rather than passing.

    Including the pair keeps replay reproducible: the ID still depends on nothing
    but the seed, the pair, the sequence and the injected clock, so the same seed
    and sequence reproduce the same ID, which `start_ms` or `instance_id` in the
    name would have destroyed. Checked by `tests/test_restart_identity.py`.
    """
    return str(uuid.uuid5(EVENT_ID_NAMESPACE,
                          f"{int(seed)}|{pair_key}|{int(sequence)}|{source_timestamp}"))


def fx_payload(base_currency: str, quote_currency: str, rate: str, rate_type: str = "mid") -> dict:
    """An AD-4 §4 `fx_rate` payload. `rate` is a decimal **string**, quote per base."""
    return {"base_currency": base_currency, "quote_currency": quote_currency,
            "rate": rate, "rate_type": rate_type}


def build_fx_event(*, seed: int, sequence: int, payload: dict, retrieved_at_ms: int,
                   source_timestamp_ms: Optional[int] = None, emitted_at_ms: Optional[int] = None,
                   case_id: str = "normal",
                   generator_version: str = GENERATOR_VERSION) -> dict:
    """One complete `fx_rate` envelope.

    `source_timestamp_ms` defaults to `retrieved_at_ms`: the synthetic generator is
    its own provider (AD-4 §5), so the moment it produces a value *is* the moment
    the value is observed. It is a separate argument because the quarantine rule
    below is only reachable when the two differ, and that path must be testable.

    `emitted_at_ms` defaults to `retrieved_at_ms` and must not precede it
    (AD-4 §5: `retrieved_at` <= `emitted_at`).

    A source timestamp more than `CLOCK_TOLERANCE_MS` after `retrieved_at` makes the
    envelope `quarantined` with reason `FUTURE_SOURCE_TIMESTAMP` (AD-4 §6, AD-1
    §3.4). The envelope is still well formed and still hashed; it is the store that
    withholds it, so a quarantined event never reaches a reader.
    """
    source_timestamp_ms = retrieved_at_ms if source_timestamp_ms is None else int(source_timestamp_ms)
    emitted_at_ms = retrieved_at_ms if emitted_at_ms is None else int(emitted_at_ms)
    if emitted_at_ms < retrieved_at_ms:
        raise ValueError("emitted_at must not precede retrieved_at (AD-4 §5)")

    source_timestamp = format_timestamp(source_timestamp_ms)
    quarantined = source_timestamp_ms > retrieved_at_ms + CLOCK_TOLERANCE_MS
    return {
        "schema_version": SCHEMA_VERSION,
        # The pair is read from the payload, so the ID and the payload can never
        # disagree about which pair the event is for.
        "event_id": event_id_for(seed, f"{payload['base_currency']}/{payload['quote_currency']}",
                                 sequence, source_timestamp),
        "event_type": "fx_rate",
        "usage": "display_only",
        "source": {"source_id": SOURCE_ID, "transport": "synthetic",
                   "source_url": None, "gate3_decision_ref": None},
        "provenance_class": "synthetic",
        "derived_from": [],
        "derivation": None,
        "timestamps": {
            "source_timestamp": source_timestamp,
            "source_timestamp_basis": "observed",
            "retrieved_at": format_timestamp(retrieved_at_ms),
            "emitted_at": format_timestamp(emitted_at_ms),
        },
        # AD-4 §2: opaque to every consumer. Ordering uses `source_timestamp` only
        # (AD-1 §3.4), so nothing may read meaning into this value.
        "source_sequence": str(int(sequence)),
        "payload": payload,
        "payload_sha256": payload_sha256("fx_rate", payload),
        "raw_sha256": None,
        "validation": ({"status": "quarantined", "reasons": [FUTURE_SOURCE_TIMESTAMP]} if quarantined
                       else {"status": "validated", "reasons": []}),
        "extraction": None,
        "review": None,
        "supersedes": None,
        "synthetic": {"generator_version": generator_version, "seed": int(seed), "case_id": case_id},
    }
