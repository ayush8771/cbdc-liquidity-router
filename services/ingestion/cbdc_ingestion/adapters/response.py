"""AD-5 §7.1's status classification and §7.3's whole-response rejection.

Two separate judgements, in this order:

1. **Did the response arrive, and may it be trusted as a whole?** A wrong
   content type, an unparsable or oversized body, an unknown protocol version, a
   redirect, more items than the allowlist permits, or two items for the same
   subject all discard the **entire** response and count the poll as failed
   (AD-5 §7.3).
2. **If it arrived and is trustworthy, which items are good?** One bad item is
   rejected or quarantined on its own — *"one bad item does not discard a good
   response, and one bad response does not discard a good item"* (AD-5 §7.1).
   Item-level work stays in the pipeline, which already does it; this module
   stops at handing over the raw items.

---

**Where the classification is AD-5's, and where it is this slice's.**

AD-5 §7.1 names the class for some conditions and not others, and pretending
otherwise would be inventing contract. `WHOLE_RESPONSE_CLASSES` states every
§7.3 condition with its class and **marks which of the two it is**:

- **AD-5 §7.1, verbatim:** an unexpected content type, an unparsable body and a
  redirect where none is allowed are `contract_violation`; 5xx and a stream
  closed by the provider are `provider_unavailable`; 429 is `rate_limited`;
  401/403 is `auth_failure`; DNS, reset and timeouts are `transient_network`.
- **This slice's documented choice**, because §7.3 lists the condition without
  naming a class: an oversized body, an unknown protocol version, too many items
  and two items for one subject are `contract_violation`. The reasoning is that
  each is a statement about the response's *shape*, which retrying cannot fix,
  and `contract_violation` is the shape class. **A later AD-5 revision may
  classify these differently; this table is where that change lands**, and
  `tests/test_a4_response.py` asserts the table covers every §7.3 condition so
  the choice cannot be made silently by omission.
"""
from __future__ import annotations

import json
from typing import Optional, Sequence

from .faults import AdapterFault, FaultClass
from .simulation import SIMULATION_TIMING, SimulatedTimingProfile
from .transport import (
    EXPECTED_CONTENT_TYPE,
    WIRE_PROTOCOL_VERSION,
    TransportResponse,
    read_body,
)

# AD-5 §7.3's conditions, each with its class and the authority for it.
# `("AD-5 §7.1", ...)` is the document's own wording; `("slice", ...)` is a
# documented choice this scope makes where §7.3 names no class.
WHOLE_RESPONSE_CLASSES = {
    "wrong_content_type": (FaultClass.CONTRACT_VIOLATION, "AD-5 §7.1"),
    "unparsable_body": (FaultClass.CONTRACT_VIOLATION, "AD-5 §7.1"),
    "redirect_not_allowed": (FaultClass.CONTRACT_VIOLATION, "AD-5 §7.1"),
    "response_body_too_large": (FaultClass.CONTRACT_VIOLATION, "slice"),
    "unknown_protocol_version": (FaultClass.CONTRACT_VIOLATION, "slice"),
    "too_many_items": (FaultClass.CONTRACT_VIOLATION, "slice"),
    "duplicate_subject_in_response": (FaultClass.CONTRACT_VIOLATION, "slice"),
    "truncated_stream": (FaultClass.TRANSIENT_NETWORK, "AD-5 §7.1"),
}

# AD-5 §7.1's status rows. Ranges rather than codes where the document gives a
# range, so an unlisted 5xx is not treated as a success.
STATUS_CLASSES = (
    (200, 200, None, "ok"),
    (301, 308, FaultClass.CONTRACT_VIOLATION, "redirect_not_allowed"),
    (401, 401, FaultClass.AUTH_FAILURE, "unauthorized"),
    (403, 403, FaultClass.AUTH_FAILURE, "forbidden"),
    (429, 429, FaultClass.RATE_LIMITED, "rate_limited"),
    (500, 500, FaultClass.PROVIDER_UNAVAILABLE, "server_error"),
    (502, 504, FaultClass.PROVIDER_UNAVAILABLE, "server_unavailable"),
)

# The required fields of one simulated wire item. A missing field is an **item**
# rejection, not a whole-response one: the response's shape is fine.
ITEM_FIELDS = ("base", "quote", "rate", "rate_type", "at_ms", "sequence")


def classify_status(status: int) -> tuple:
    """`(FaultClass | None, reason)` for one status code (AD-5 §7.1).

    An unlisted code is `contract_violation`: a provider answering 204 or 418 on
    an observation endpoint is misconfigured, and retrying a misconfiguration
    forever is what §7.1's permanent classes exist to prevent.
    """
    status = int(status)
    for low, high, fault_class, reason in STATUS_CLASSES:
        if low <= status <= high:
            return fault_class, reason
    return FaultClass.CONTRACT_VIOLATION, f"unexpected_status_{status}"


def _fault(reason: str, source_id: str) -> AdapterFault:
    fault_class, _authority = WHOLE_RESPONSE_CLASSES[reason]
    return AdapterFault(fault_class, reason, source_id=source_id)


def read_response(response: TransportResponse, *, source_id: str,
                  allowed_subjects: Optional[Sequence[tuple]] = None,
                  profile: SimulatedTimingProfile = SIMULATION_TIMING) -> tuple:
    """One response as `(items, retry_after)`, or an `AdapterFault`.

    `retry_after` is the raw header, handed back untouched so the **retry**
    policy decides what to do with it: parsing it here would put a timing
    decision in a parsing module, and AD-5 §7.2 puts the clamp in backoff.

    Raises for everything §7.3 discards as a whole. Order matters: a connection
    that never delivered cannot have a content type, and a body too large to
    read cannot be parsed.
    """
    # 1. The response never arrived (AD-5 §7.1 `transient_network`).
    if response.network_error:
        raise AdapterFault(FaultClass.TRANSIENT_NETWORK, response.network_error,
                           source_id=source_id)

    # 2. The status (AD-5 §7.1). A redirect is refused here and is **never
    #    followed**: following one would reach a host no allowlist named.
    fault_class, reason = classify_status(response.status)
    if fault_class is not None:
        raise AdapterFault(fault_class, reason, source_id=source_id)

    # 3. The content type, before the body is touched.
    if (response.content_type or "").split(";")[0].strip() != EXPECTED_CONTENT_TYPE:
        raise _fault("wrong_content_type", source_id)

    # 4. The body, size-checked **while reading**, and truncation detected.
    try:
        body = read_body(response, profile)
    except AdapterFault as fault:
        # `read_body` has no source_id; re-raise with this source's, so the
        # counter and the log field name the source (AD-1 §3.4).
        raise AdapterFault(fault.fault_class, fault.reason, source_id=source_id) from None

    # 5. Parsing, and the protocol version.
    try:
        document = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise _fault("unparsable_body", source_id) from None
    if not isinstance(document, dict):
        raise _fault("unparsable_body", source_id)
    if document.get("protocol_version") != WIRE_PROTOCOL_VERSION:
        raise _fault("unknown_protocol_version", source_id)
    items = document.get("items")
    if not isinstance(items, list) or any(not isinstance(i, dict) for i in items):
        raise _fault("unparsable_body", source_id)

    # 6. The allowlist's arithmetic, and one item per subject.
    if len(items) > profile.max_items_per_response:
        raise _fault("too_many_items", source_id)
    if allowed_subjects is not None and len(items) > len(tuple(allowed_subjects)):
        raise _fault("too_many_items", source_id)
    subjects = [(i.get("base"), i.get("quote"), i.get("rate_type")) for i in items]
    if len(set(subjects)) != len(subjects):
        raise _fault("duplicate_subject_in_response", source_id)

    return tuple(items), response.header("Retry-After")
