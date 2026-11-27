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
| Deduplication and conflict classification (AD5-Q1, AD5-Q8) | **Implemented**, in `dedup.py`: C-b, then D, then C-a, over an `event_id`-keyed index |
| Plausibility bounds (authorization §5.5) | **Implemented**, in `plausibility.py`: a breach **quarantines**, never rejects and never clamps |
| The internal status machine (AD-5 §9.2) | **Implemented**, in `status.py`, **in process only** — a metric label and a log field, never a wire body |

**Where the plausibility check sits, and why there.** It runs on the
**normalized value, before the envelope is built**. A quarantined observation is
counted by reason on the sink's `quarantine` channel and never reaches
`observations`, so it is never served and never becomes the ordering watermark.
The alternative — building the envelope and then rewriting its `validation`
block — would mean this module editing an envelope `envelope.py` produced, which
is the second AD-4 implementation AD-5 §3.1 forbids.

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
from .dedup import (
    DEDUP_WINDOW_MS,
    DUPLICATE,
    IDENTITY_COLLISION,
    VALUE_CONFLICT,
    DedupIndex,
)
from .envelope import build_fx_event, fx_payload
from .plausibility import PlausibilityGuard
from .sink import ServiceSink
from .status import SourceStatus
from .validation import EnvelopeInvalid, validate_fx_envelope

# The reason code the `source_id` refusal carries. Named so that a log line and
# a metric label say which unresolved item stopped the path, not merely that
# something did.
SOURCE_ID_UNRESOLVED = "adapter_source_id_not_representable_in_envelope"

# The reason code a **failing sink** carries. It names the sink, not the data:
# the observation was admitted, bounded, built, validated and classified, and
# only the publication failed, so blaming the item would misreport the fault.
#
# **Why this is handled at all.** `ServiceSink.publish` cannot raise on the
# shipped path — the channel names are fixed and `LatestStore.apply` returns a
# bool. But the sink is an **interface**, AD-2 and AD-3 are drafts, and the
# in-memory implementation is this slice's choice and not a template (§8 item
# 5). An unguarded publish would let one sink fault end the whole service tick
# and lose every later item in the batch **with no counter moved at all** —
# exactly the silent loss AD-5 §3.7 and acceptance criterion 14 forbid.
SINK_UNAVAILABLE = "sink_unavailable"

# The reason code a **schema-invalid envelope** carries. AD-5 §3.4 puts
# validation at step 3 and deduplication at step 4, and acceptance criterion 5a
# requires an invalid envelope to be "rejected at **validation, before** the
# classifier sees it".
#
# `LatestStore.apply` validates with this same function, but it is the **sink**,
# which AD-5 §3.4 reaches only at step 5 — so relying on it alone put validation
# after classification. A normalized value can be a decimal string the
# plausibility guard parses and the builder accepts while AD-4 §4 forbids its
# spelling (`02.200000`, a leading zero), so the envelope reaching the index
# invalid is a real path and not a hypothetical one. It is **item-level**: one
# badly spelled value does not discard the response or fail the adapter.
ENVELOPE_SCHEMA_INVALID = "envelope_schema_invalid"


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


class SourcePipeline:
    """The per-source service-side state: dedup index, bounds and status.

    One instance per `source_id`, matching the one-adapter-per-source rule
    (AD-5 §3.1). It holds counters, four decimal strings and the dedup index's
    bounded entries — **never a payload and never an envelope**.
    """

    def __init__(self, record: SourceRecord, *, seed: int, now_ms: int = 0) -> None:
        self.record = record
        self.seed = int(seed)
        self.dedup = DedupIndex(window_ms=DEDUP_WINDOW_MS)
        self.plausibility = PlausibilityGuard(record.plausibility)
        self.status = SourceStatus(
            record.source_id,
            expected_interval_ms=record.freshness_profile.expected_interval_ms,
            now_ms=now_ms)

    def run_cycle(self, adapter: Adapter, sink: ServiceSink, *,
                  retrieved_at_ms: Optional[int] = None) -> AdapterRunResult:
        """One production cycle: produce, admit, bound-check, build, classify, publish.

        **No accounting is lost** (acceptance criterion 14): every observation
        ends as exactly one of published, quarantined, rejected, duplicate,
        conflict or a recorded fault — **never both and never neither**.

        Ordering of the steps is not arbitrary:

        1. **admit** against the record, so an unlisted type or subject never
           reaches a bound or an index;
        2. **plausibility**, on the normalized value, so a quarantined value
           never becomes an envelope that must then be withheld;
        3. **build**, by the unchanged `envelope.py`;
        4. **validate** strictly, by the unchanged `validation.py` — AD-5 §3.4
           step 3, and **before** the classifier (criterion 5a). The store
           validates again at step 5 and neither side trusts the other's
           verdict (AD-4 §6), but the sink is reached too late to keep an
           invalid envelope out of the `event_id` index;
        5. **classify** (C-b, D, C-a), which needs the built envelope because
           `event_id` and `payload_sha256` are its fields;
        6. **publish** only what came out `accepted`.
        """
        record, result = self.record, AdapterRunResult()
        observations: Sequence[NormalizedObservation] = adapter.produce()
        if retrieved_at_ms is None:
            retrieved_at_ms = adapter._context.now_ms() if adapter._context else 0

        # --- the faults `produce()` classified but could not raise (A-4) -----
        # `produce()` swallows faults on purpose, so that one bad poll does not
        # end the service tick. Before A-4 that also meant a transport fault
        # reached **no** counter and **no** status criterion, so a source could
        # fail every poll and stay `ok`. Draining here closes that: the fault is
        # counted by reason, reported on the `faults` channel, and fed to the
        # internal status machine, where the consecutive-failure criterion can
        # finally fire from a transport fault (AD-5 §7.5, §9.2).
        self._account_drained(adapter, sink, result, now_ms=retrieved_at_ms)

        for observation in observations:
            result.produced += 1
            try:
                admit(record, observation)
            except AdapterFault as fault:
                self._fault(adapter, sink, result, fault, now_ms=retrieved_at_ms)
                continue

            # --- plausibility: a quarantine, never a rejection or a clamp ----
            reason = self.plausibility.check(
                observation.event_type, observation.subject, observation.payload["rate"])
            if reason is not None:
                self._report(sink, "quarantine", reason)
                result.quarantined += 1
                result.reasons.append(reason)
                continue

            try:
                event = build_envelope(record, observation, seed=self.seed,
                                       retrieved_at_ms=retrieved_at_ms)
            except AdapterFault as fault:
                self._fault(adapter, sink, result, fault, now_ms=retrieved_at_ms)
                continue

            # --- strict validation, before the classifier (AD-5 §3.4 step 3)
            try:
                validate_fx_envelope(event)
            except EnvelopeInvalid:
                # The reason names the breach class, not the payload: AD-1 §3.4
                # permits counters by reason and nothing more.
                self._fault(adapter, sink, result,
                            AdapterFault(FaultClass.ITEM_INVALID, ENVELOPE_SCHEMA_INVALID,
                                         source_id=record.source_id),
                            now_ms=retrieved_at_ms)
                continue

            # The builder's own AD-4 §6 verdict, e.g. FUTURE_SOURCE_TIMESTAMP.
            if event["validation"]["status"] != "validated":
                self._report(sink, "quarantine", ",".join(event["validation"]["reasons"]))
                result.quarantined += 1
                continue

            outcome, detail = self.dedup.classify(event, retrieved_at_ms)
            if outcome == IDENTITY_COLLISION:
                # C-b: rejected and counted; the first is kept (AD-2 R-8).
                result.collisions += 1
                result.reasons.append("identity_collision:" + ",".join(detail))
                self._report(sink, "faults", "identity_collision")
                continue
            if outcome == DUPLICATE:
                # D: discarded, not rejected and not quarantined.
                result.duplicates += 1
                continue
            if outcome == VALUE_CONFLICT:
                # C-a: the first is kept; this one does not become current.
                result.conflicts += 1
                result.reasons.append("value_conflict")
                self._report(sink, "faults", "value_conflict")
                continue

            try:
                became_current = sink.publish("observations", event)
            except Exception:  # noqa: BLE001 - any sink defect, counted not raised
                # Criterion 14's "never neither": the event is counted, the
                # reason names the sink, and the classification is **withdrawn**
                # so a redelivery in the same run is not discarded as a
                # duplicate of something no consumer received.
                self.dedup.forget(event)
                result.rejected += 1
                result.reasons.append(SINK_UNAVAILABLE)
                self.status.record_failure(retrieved_at_ms)
                continue

            if became_current:
                result.published += 1
                self.status.record_success(retrieved_at_ms)
            else:
                # The store withheld it by its own AD-1 §3.4 ordering rule.
                # Counted as **late**, which is what AD-5 §8.3 calls it: "not
                # current; counted as late, not as an error". It is **not** a
                # `D`: `result.duplicates` is the classifier's duplicate outcome
                # (criterion 5), and borrowing it here reported a deduplication
                # verdict for an event the classifier had accepted.
                #
                # Lateness is the only refusal still reachable here. The three
                # other `apply` refusals are now unreachable from this path: the
                # invalid case is rejected above by the same validator, the
                # quarantined case is diverted above, and the store's duplicate
                # case needs an identical envelope already current, which
                # `classify` would have returned as `D`. A store whose current
                # value came from another writer could still refuse as a
                # duplicate; `apply` returns a bool and D-24's store is
                # unchanged by rule, so this path cannot distinguish that case,
                # and it is counted as withheld-and-not-current either way.
                result.late += 1
                result.reasons.append("late")

        # The item faults `_fault` recorded during the loop above are already
        # accounted — it counts, reports and feeds the status machine inline —
        # so they are drained and discarded here rather than being left for the
        # next cycle's drain to count a second time. Exactly-once, in both
        # directions. Guarded the same way as the drain above, because a test
        # double may be a duck-typed adapter without the method.
        if getattr(adapter, "drain_faults", None) is not None:
            adapter.drain_faults()

        # The silence criterion, which no failure reports (AD-5 §9.2).
        self.status.tick(retrieved_at_ms)
        return result

    def _account_drained(self, adapter: Adapter, sink: ServiceSink,
                         result: AdapterRunResult, *, now_ms: int) -> None:
        """Counts, reports and statuses the faults drained from the adapter.

        **An item fault changes no adapter state and no source status**: one bad
        item does not discard a good response (AD-5 §7.1), so it is counted and
        reported and nothing else. A non-item fault is a failed poll, and it
        reaches `SourceStatus` — permanently for `auth_failure` and
        `contract_violation`, which send it to `down`, and towards the
        consecutive-failure criterion otherwise.
        """
        drained = getattr(adapter, "drain_faults", None)
        if drained is None:  # an adapter predating the drain; nothing to do
            return
        for fault in drained():
            self._report(sink, "faults", fault.reason)
            result.reasons.append(fault.reason)
            if fault.item_level:
                result.item_faults += 1
                continue
            result.faults += 1
            self.status.record_failure(now_ms, permanent=fault.permanent)

    def _report(self, sink: ServiceSink, channel: str, reason: str) -> bool:
        """Publishes a **reason code** to the quarantine or faults channel.

        Best effort, and deliberately so. The counter in `AdapterRunResult` is
        the accounting; this is the *report* of it. If the reporting channel
        itself fails, losing the count of a bad value would be worse than losing
        the report, so the failure is swallowed here and the caller's counter
        still moves. An unknown channel name is a programming error and still
        raises — that one is not a sink fault.
        """
        if channel not in ("quarantine", "faults"):
            raise ValueError(f"_report covers the reason channels only, not {channel!r}")
        try:
            sink.publish(channel, reason)
            return True
        except Exception:  # noqa: BLE001 - the count is what must survive
            return False

    def _fault(self, adapter: Adapter, sink: ServiceSink,
               result: AdapterRunResult, fault: AdapterFault,
               *, now_ms: int = 0) -> None:
        """Records one fault, and lets the adapter's own classifier decide.

        An **item** fault changes no adapter state: one bad item does not
        discard a good response. A **permanent** one sends the adapter to
        `failed_permanent` and the internal status to `down`, which no
        successful item and no passage of time can clear.
        """
        adapter._record_fault(fault)
        self._report(sink, "faults", fault.reason)
        result.rejected += 1
        result.reasons.append(fault.reason)
        if not fault.item_level:
            self.status.record_failure(now_ms, permanent=fault.permanent)


def run_cycle(adapter: Adapter, record: SourceRecord, sink: ServiceSink, *,
              seed: int, retrieved_at_ms: Optional[int] = None) -> AdapterRunResult:
    """One cycle on a throwaway pipeline, for callers holding no state.

    It builds a fresh `SourcePipeline` per call, so **its dedup index and its
    plausibility baseline start empty every time**. That makes it unsuitable for
    a running service, which must carry both across cycles; `service.py` holds a
    `SourcePipeline` per source instead. Kept for single-cycle tests.
    """
    return SourcePipeline(record, seed=seed).run_cycle(
        adapter, sink, retrieved_at_ms=retrieved_at_ms)
