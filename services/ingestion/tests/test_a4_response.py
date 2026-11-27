"""A-4: whole-response rejection (AD-5 §7.3) and status classification (§7.1).

Two separate obligations, asserted apart: a response that cannot be trusted as a
whole is discarded entirely, and a status is mapped to the class that decides the
retry. The suite also asserts the **authority** of each classification, so a
choice this slice made where AD-5 names none cannot drift into looking like
contract.
"""
from __future__ import annotations

import json

import pytest

from cbdc_ingestion.adapters.faults import AdapterFault, FaultClass, is_permanent
from cbdc_ingestion.adapters.response import (
    STATUS_CLASSES,
    WHOLE_RESPONSE_CLASSES,
    classify_status,
    read_response,
)
from cbdc_ingestion.adapters.simulation import SIMULATION_TIMING as P
from cbdc_ingestion.adapters.transport import (
    EXPECTED_CONTENT_TYPE,
    WIRE_PROTOCOL_VERSION,
    TransportResponse,
    read_body,
)

from .a4_support import clean_values

SOURCE = "synthetic.fx"
SUBJECTS = tuple((i["base"], i["quote"], i["rate_type"]) for i in clean_values())


def body(values, *, version: int = WIRE_PROTOCOL_VERSION, chunk: int = 64) -> tuple:
    raw = json.dumps({"protocol_version": version, "items": list(values)}).encode("utf-8")
    return tuple(raw[i:i + chunk] for i in range(0, len(raw), chunk)) or (b"",)


# ------------------------------------------------- the table covers §7.3 in full
# AD-5 §7.3, enumerated from the document: "a wrong content type; a body that is
# not parsable; a body over the AD-8 size limit, checked while reading; an
# unknown payload protocol version; a redirect; more items than the subject
# allowlist permits; or two items for the same subject in one response" — plus
# the truncated stream A-4 names.
SEVEN_THREE_CONDITIONS = (
    "wrong_content_type", "unparsable_body", "response_body_too_large",
    "unknown_protocol_version", "redirect_not_allowed", "too_many_items",
    "duplicate_subject_in_response", "truncated_stream",
)


def test_every_7_3_condition_has_a_declared_class():
    """A condition missing from the table would be classified by accident at the
    call site, which is how an unapproved retry policy gets adopted silently."""
    assert set(WHOLE_RESPONSE_CLASSES) == set(SEVEN_THREE_CONDITIONS)


def test_each_entry_declares_whose_classification_it_is():
    """"AD-5 §7.1" means the document names the class; "slice" means this scope
    chose it. The distinction is the audit trail, so it is asserted."""
    for reason, (fault_class, authority) in WHOLE_RESPONSE_CLASSES.items():
        assert authority in ("AD-5 §7.1", "slice"), (reason, authority)
        assert isinstance(fault_class, FaultClass)


def test_the_conditions_ad5_names_are_attributed_to_ad5_and_not_to_the_slice():
    for reason in ("wrong_content_type", "unparsable_body", "redirect_not_allowed",
                   "truncated_stream"):
        assert WHOLE_RESPONSE_CLASSES[reason][1] == "AD-5 §7.1", reason


def test_a_truncated_stream_is_recoverable_while_a_shape_failure_is_not():
    """The split that matters for the retry: a connection that ended early may
    succeed next time, a malformed body will not."""
    assert not is_permanent(WHOLE_RESPONSE_CLASSES["truncated_stream"][0])
    for reason in ("wrong_content_type", "unparsable_body", "redirect_not_allowed",
                   "response_body_too_large", "unknown_protocol_version",
                   "too_many_items", "duplicate_subject_in_response"):
        assert is_permanent(WHOLE_RESPONSE_CLASSES[reason][0]), reason


# ------------------------------------------------------------ status classification
@pytest.mark.parametrize("status,fault_class,reason", [
    (200, None, "ok"),
    (301, FaultClass.CONTRACT_VIOLATION, "redirect_not_allowed"),
    (302, FaultClass.CONTRACT_VIOLATION, "redirect_not_allowed"),
    (308, FaultClass.CONTRACT_VIOLATION, "redirect_not_allowed"),
    (401, FaultClass.AUTH_FAILURE, "unauthorized"),
    (403, FaultClass.AUTH_FAILURE, "forbidden"),
    (429, FaultClass.RATE_LIMITED, "rate_limited"),
    (500, FaultClass.PROVIDER_UNAVAILABLE, "server_error"),
    (502, FaultClass.PROVIDER_UNAVAILABLE, "server_unavailable"),
    (503, FaultClass.PROVIDER_UNAVAILABLE, "server_unavailable"),
    (504, FaultClass.PROVIDER_UNAVAILABLE, "server_unavailable"),
])
def test_each_ad5_7_1_status_row_maps_to_its_class(status, fault_class, reason):
    assert classify_status(status) == (fault_class, reason)


@pytest.mark.parametrize("status", [204, 418, 451, 599])
def test_an_unlisted_status_is_a_contract_violation_not_a_success(status):
    """A provider answering 204 on an observation endpoint is misconfigured, and
    retrying a misconfiguration for ever is what the permanent classes prevent."""
    fault_class, reason = classify_status(status)
    assert fault_class is FaultClass.CONTRACT_VIOLATION
    assert reason == f"unexpected_status_{status}"
    assert is_permanent(fault_class)


def test_the_status_table_is_ordered_and_non_overlapping():
    ranges = [(low, high) for low, high, _, _ in STATUS_CLASSES]
    assert all(low <= high for low, high in ranges)
    assert ranges == sorted(ranges)
    for (_, prev_high), (next_low, _) in zip(ranges, ranges[1:]):
        assert prev_high < next_low, "two rows must not both claim a status"


# ----------------------------------------------------- the size limit, while reading
def test_an_oversized_body_is_refused_part_way_through_reading():
    """AD-5 §7.3's "checked **while reading** rather than after".

    The evidence is the transport's own consumption counter: the reader must have
    stopped within one chunk of the limit, not after pulling the whole body.
    """
    chunk = b"x" * 256
    chunks = tuple(chunk for _ in range(P.max_response_bytes // 256 + 20))
    response = TransportResponse(chunks=chunks)
    with pytest.raises(AdapterFault) as raised:
        read_body(response, P)
    assert raised.value.reason == "response_body_too_large"
    assert response.bytes_consumed <= P.max_response_bytes + len(chunk)
    assert response.chunks_consumed < len(chunks), "the whole body must not be pulled"


def test_a_body_exactly_at_the_limit_is_accepted():
    """The boundary, on the accepting side: a limit that refused its own value
    would make the declared maximum unusable."""
    response = TransportResponse(chunks=(b"y" * P.max_response_bytes,))
    assert read_body(response, P) == b"y" * P.max_response_bytes


def test_one_byte_over_the_limit_is_refused():
    response = TransportResponse(chunks=(b"y" * (P.max_response_bytes + 1),))
    with pytest.raises(AdapterFault, match="response_body_too_large"):
        read_body(response, P)


def test_a_truncated_body_is_refused_even_when_it_is_small_and_parsable():
    """Truncation is about the connection, so a well-formed prefix is still a
    fault — otherwise a stream cut after the first item would be read as a
    complete, shorter response."""
    response = TransportResponse(chunks=body(clean_values()), truncated=True)
    with pytest.raises(AdapterFault) as raised:
        read_body(response, P)
    assert raised.value.fault_class is FaultClass.TRANSIENT_NETWORK
    assert raised.value.reason == "truncated_stream"


# ------------------------------------------------------------------ read_response
def ok(values, **kwargs) -> TransportResponse:
    return TransportResponse(chunks=body(values), **kwargs)


def test_a_clean_response_yields_its_items_and_no_retry_after():
    items, retry_after = read_response(ok(clean_values()), source_id=SOURCE,
                                       allowed_subjects=SUBJECTS, profile=P)
    assert len(items) == len(clean_values())
    assert retry_after is None


def test_the_retry_after_header_is_handed_back_unparsed():
    """Parsing it here would put a timing decision in a parsing module; AD-5
    §7.2 puts the clamp in backoff, so the raw value travels."""
    response = TransportResponse(status=429, headers={"retry-after": "7"})
    with pytest.raises(AdapterFault) as raised:
        read_response(response, source_id=SOURCE, profile=P)
    assert raised.value.fault_class is FaultClass.RATE_LIMITED
    assert response.header("Retry-After") == "7", "read case-insensitively"


@pytest.mark.parametrize("content_type", ["text/html", "application/xml", "", "text/plain"])
def test_a_wrong_content_type_is_refused_before_the_body_is_touched(content_type):
    response = ok(clean_values(), content_type=content_type)
    with pytest.raises(AdapterFault, match="wrong_content_type"):
        read_response(response, source_id=SOURCE, profile=P)
    assert response.bytes_consumed == 0, "the body must not be read at all"


def test_a_content_type_with_a_charset_parameter_is_accepted():
    response = ok(clean_values(), content_type=f"{EXPECTED_CONTENT_TYPE}; charset=utf-8")
    items, _ = read_response(response, source_id=SOURCE, profile=P)
    assert items


@pytest.mark.parametrize("raw", [b"{not json", b"", b"\xff\xfe", b"[]", b"null", b"3"])
def test_an_unparsable_or_wrongly_shaped_body_is_refused(raw):
    with pytest.raises(AdapterFault, match="unparsable_body"):
        read_response(TransportResponse(chunks=(raw,)), source_id=SOURCE, profile=P)


@pytest.mark.parametrize("version", [0, 2, 999, None, "1"])
def test_an_unknown_protocol_version_is_refused(version):
    response = TransportResponse(chunks=body(clean_values(), version=version))
    with pytest.raises(AdapterFault, match="unknown_protocol_version"):
        read_response(response, source_id=SOURCE, profile=P)


def test_items_must_be_a_list_of_objects():
    raw = json.dumps({"protocol_version": WIRE_PROTOCOL_VERSION,
                      "items": ["not-an-object"]}).encode("utf-8")
    with pytest.raises(AdapterFault, match="unparsable_body"):
        read_response(TransportResponse(chunks=(raw,)), source_id=SOURCE, profile=P)


def test_more_items_than_the_allowlist_permits_is_refused():
    values = clean_values() + clean_values(2)
    with pytest.raises(AdapterFault, match="too_many_items"):
        read_response(ok(values), source_id=SOURCE, allowed_subjects=SUBJECTS, profile=P)


def test_more_items_than_the_profile_permits_is_refused_without_an_allowlist():
    values = [dict(clean_values()[0], base=f"C{n:02d}")
              for n in range(P.max_items_per_response + 1)]
    with pytest.raises(AdapterFault, match="too_many_items"):
        read_response(ok(values), source_id=SOURCE, profile=P)


def test_two_items_for_one_subject_in_one_response_is_refused():
    first = clean_values()[0]
    with pytest.raises(AdapterFault, match="duplicate_subject_in_response"):
        read_response(ok([first, dict(first, rate="2.300000")]), source_id=SOURCE,
                      allowed_subjects=SUBJECTS, profile=P)


def test_a_network_error_is_refused_before_anything_else_is_examined():
    """A response that never arrived has no status and no content type, so it
    must be judged first — otherwise a default 200 would make it look healthy."""
    response = TransportResponse(network_error="closed_on_connect", status=200)
    with pytest.raises(AdapterFault) as raised:
        read_response(response, source_id=SOURCE, profile=P)
    assert raised.value.fault_class is FaultClass.TRANSIENT_NETWORK
    assert raised.value.reason == "closed_on_connect"


def test_every_fault_carries_the_source_id_for_the_log_field():
    """AD-1 §3.4 permits the reason, the `source_id` and a well-formed
    `event_id` in a log line. A fault with an empty `source_id` would make the
    counter unattributable, which is why `read_body`'s is re-raised with it."""
    with pytest.raises(AdapterFault) as raised:
        read_response(TransportResponse(chunks=(b"x" * (P.max_response_bytes + 1),)),
                      source_id=SOURCE, profile=P)
    assert raised.value.source_id == SOURCE


def test_no_fault_reason_contains_provider_text_or_a_payload():
    """AD-5 §7.5: "no payload in a log line". Asserted over every reason the
    module can produce, so a future row cannot smuggle one in."""
    reasons = list(WHOLE_RESPONSE_CLASSES) + [r for _, _, _, r in STATUS_CLASSES]
    for reason in reasons:
        assert reason.replace("_", "").isalnum(), reason
        assert "://" not in reason and " " not in reason
