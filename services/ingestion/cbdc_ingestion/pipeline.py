"""The service-side steps around an adapter (AD-5 §3.4).

An adapter returns `NormalizedObservation`s — values, codes and timestamps. The
**service** does everything else, and does it here: admission against the
registry record, envelope construction, canonical hashing, schema validation and
publication to the sink. An adapter that did any of this would be a second
implementation of AD-4, and two implementations eventually disagree
(AD-5 §3.1, §3.4).

**What is implemented here, and what is deliberately absent.**

| AD-5 §3.4 step | Here |
|---|---|
| Admission: the type and subject the record permits | **Implemented** |
| Envelope construction and canonical hashing | **Delegated to the unchanged `envelope.py`**, which is untouched by rule (authorization §7.3) |
| Schema validation | **Delegated to the unchanged `validation.py`**, through `LatestStore.apply` |
| Publication to the sink | **Implemented** |
| Deduplication and conflict classification (AD5-Q1, AD5-Q8) | **Not here.** `dedup.py` is its own authorized file with its own acceptance criteria (5, 5a), and is **not yet written** |
| The internal status machine (AD-5 §9.2) | **Not here.** `status.py`, acceptance criterion 6, **not yet written** |
| Plausibility bounds (authorization §5.5) | **Not here.** Acceptance criterion 16, **not yet written** |

Until those three exist, this pipeline is **not** the complete §3.4 path, and it
says so rather than appearing to be one.

---

**`source_id`: resolved by the owner's Option B decision, 27 November 2026.**

`envelope.py` writes a constant `source.source_id` of `synthetic.fx` and is in
authorization §7.3's **untouched by rule** list. The owner decided that the
D-24 generator and the registry-selected synthetic FX adapter **may both use
`source_id = synthetic.fx`, provided they are mutually exclusive**: only one
generator configuration may be active for that `source_id` at any time, the
generator remains the default, and the adapter is activated **only** through
explicit registry selection.

So `build_envelope` no longer refuses the shipped record — it **checks
agreement**, and the envelope's `source.source_id` can never contradict the
record that selected it. The exclusivity itself is enforced in `service.py`:
selecting a record **replaces** the generator rather than running beside it,
and two selected records sharing a `source_id` is a startup failure.

**The decision applies to Phase 3.3-A only.** It authorizes **no** envelope,
schema, backend, frontend or `event_id` derivation change. `source_id` is
absent from the C-1 derivation and from `payload_sha256`, so nothing about
event identity moves. All four capability gates remain **closed**.
"""
from __future__ import annotations

from typing import Optional, Sequence

from . import SOURCE_ID
from .adapters.base import Adapter, AdapterRunResult, NormalizedObservation
from .adapters.faults import AdapterFault, FaultClass
from .adapters.registry import SourceRecord
from .envelope import build_fx_event, fx_payload
from .sink import ServiceSink

# The reason code the `source_id` refusal carries. Named so that a log line and
# a metric label say which unresolved item stopped the path, not merely that
# something did.
SOURCE_ID_UNRESOLVED = "adapter_source_id_not_representable_in_envelope"


def admit(record: SourceRecord, observation: NormalizedObservation) -> None:
    """Admission against the record (AD-5 §3.4, §2.2).

    A source emitting an unlisted type or an unlisted subject is **rejected**,
    not quietly widened: the registry is the single authority for what a source
    is, and a source that could emit anything would make it decorative.
    """
    if observation.event_type not in record.event_types:
        raise AdapterFault(FaultClass.ITEM_INVALID, "event_type_not_permitted",
                           source_id=record.source_id)
    if record.subjects != "open" and tuple(observation.subject) not in record.subjects:
        raise AdapterFault(FaultClass.ITEM_INVALID, "subject_not_permitted",
                           source_id=record.source_id)
    if observation.source_timestamp_basis != record.timestamp_basis:
        raise AdapterFault(FaultClass.ITEM_INVALID, "timestamp_basis_mismatch",
                           source_id=record.source_id)
    if observation.source_timestamp_ms is None:
        # AD-1 §3.4 rejects a null source timestamp outright, and that approved
        # rule is unchanged. AD-5 §8.4's sources-without-a-timestamp path is not
        # in this scope.
        raise AdapterFault(FaultClass.ITEM_INVALID, "null_source_timestamp",
                           source_id=record.source_id)


def build_envelope(record: SourceRecord, observation: NormalizedObservation,
                   *, seed: int, retrieved_at_ms: int) -> dict:
    """One AD-4 envelope for `observation`, built by the **unchanged** builder.

    The record's `source_id` must be the one `envelope.py` writes. Under the
    owner's Option B decision that is `synthetic.fx` for the adapter too, so
    this is now an **agreement check** rather than the former blanket refusal:
    the envelope's `source.source_id` can never contradict the record that
    selected it. A record naming anything else is still a **permanent**
    `contract_violation` — a configuration fault, which must not be retried —
    because `envelope.py` is unchanged and cannot write another value.
    """
    if record.source_id != SOURCE_ID:
        raise AdapterFault(
            FaultClass.CONTRACT_VIOLATION, SOURCE_ID_UNRESOLVED, source_id=record.source_id)
    payload = fx_payload(
        observation.payload["base_currency"], observation.payload["quote_currency"],
        observation.payload["rate"], observation.payload["rate_type"])
    return build_fx_event(
        seed=seed, sequence=observation.sequence, payload=payload,
        retrieved_at_ms=retrieved_at_ms,
        source_timestamp_ms=observation.source_timestamp_ms)


def run_cycle(adapter: Adapter, record: SourceRecord, sink: ServiceSink, *,
              seed: int, retrieved_at_ms: Optional[int] = None) -> AdapterRunResult:
    """One production cycle: produce, admit, build, publish, count.

    **No accounting is lost** (acceptance criterion 14): every observation ends
    as exactly one of published, quarantined, rejected or a recorded fault —
    never both and never neither.

    **No deduplication or conflict classification happens here.** `dedup.py` is
    not yet written, so a redelivery on this path is handled only by the
    existing store's ordering and duplicate rules, which are AD-1 §3.4's and not
    AD-5 §8.2's. That difference is stated, not hidden.
    """
    result = AdapterRunResult()
    observations: Sequence[NormalizedObservation] = adapter.produce()
    if retrieved_at_ms is None:
        retrieved_at_ms = adapter._context.now_ms() if adapter._context else 0
    for observation in observations:
        result.produced += 1
        try:
            admit(record, observation)
            event = build_envelope(record, observation, seed=seed,
                                   retrieved_at_ms=retrieved_at_ms)
        except AdapterFault as fault:
            # The adapter's own classifier decides what this does to its state:
            # an item fault changes none, a permanent one stops it for good.
            adapter._record_fault(fault)
            sink.publish("faults", fault.reason)
            result.rejected += 1
            result.reasons.append(fault.reason)
            continue
        if event["validation"]["status"] != "validated":
            sink.publish("quarantine", ",".join(event["validation"]["reasons"]))
            result.quarantined += 1
            continue
        if sink.publish("observations", event):
            result.published += 1
        else:
            # Counted, never silent (AD-5 §3.7). The store's own counters say
            # which rule withheld it; this one says that one was withheld.
            result.duplicates += 1
    return result
