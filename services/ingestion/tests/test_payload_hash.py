"""`payload_sha256` against the shared cross-language vectors (AD-1 §3.7, P-9).

`contracts/test-vectors/event_payload_hash.v1.json` is the shared fixture file:
the backend's TypeScript implementation must reproduce the same canonical strings
and digests, so these tests check the committed strings rather than only
re-deriving them. Where `rfc8785` is importable, the restricted canonicalizer is
also compared against it on every vector, which is what makes the P-9 subset
safe to use in place of a full implementation.
"""
from __future__ import annotations

import hashlib

import pytest

from cbdc_ingestion.canonical import (CanonicalizationError, canonicalize, payload_canonical_string,
                                      payload_sha256)

# The value AD-4 §10 prints. Hard-coded here as well as in the vector file, so a
# mistaken regeneration of that file cannot quietly redefine the documented hash.
AD4_SECTION10_SHA256 = "22fe8747cb6a035235c3ad84c45c5214d271941c784a5a2e4cc0c8c048798ca4"


def test_ad4_section10_hash_is_reproduced():
    payload = {"base_currency": "USD", "quote_currency": "INR", "rate": "1.2345", "rate_type": "mid"}
    assert payload_sha256("fx_rate", payload) == AD4_SECTION10_SHA256


def test_every_vector_matches_its_committed_canonical_string_and_digest(hash_vectors):
    assert hash_vectors["vectors"], "the vector file must not be empty"
    for vector in hash_vectors["vectors"]:
        text = payload_canonical_string(vector["event_type"], vector["payload"])
        assert text == vector["canonical"], vector["name"]
        assert payload_sha256(vector["event_type"], vector["payload"]) == vector["sha256"], vector["name"]
        # The digest in the file is of the canonical string in the file, so a hand
        # edit of one without the other is caught.
        assert hashlib.sha256(vector["canonical"].encode("utf-8")).hexdigest() == vector["sha256"]


def test_member_order_does_not_change_the_hash(hash_vectors):
    by_name = {v["name"]: v for v in hash_vectors["vectors"]}
    reordered = by_name["reordered_keys_same_hash"]
    assert reordered["sha256"] == by_name[reordered["same_hash_as"]]["sha256"]
    assert reordered["canonical"] == by_name[reordered["same_hash_as"]]["canonical"]


def test_a_trailing_zero_rate_hashes_differently(hash_vectors):
    by_name = {v["name"]: v for v in hash_vectors["vectors"]}
    trailing = by_name["trailing_zero_rate_differs"]
    assert trailing["sha256"] != by_name[trailing["differs_from"]]["sha256"]


def test_altered_payloads_do_not_match_the_original_hash(hash_vectors):
    by_name = {v["name"]: v for v in hash_vectors["vectors"]}
    assert hash_vectors["must_not_match"], "the altered-payload cases must not be empty"
    for case in hash_vectors["must_not_match"]:
        original = by_name[case["must_not_equal_sha256_of"]]["sha256"]
        computed = payload_sha256(case["event_type"], case["payload"])
        assert computed == case["sha256"], case["name"]
        assert computed != original, case["name"]


def test_generated_vectors_cover_all_four_pairs(hash_vectors):
    generated = [v for v in hash_vectors["vectors"] if v["name"].startswith("generated_")]
    pairs = {(v["payload"]["base_currency"], v["payload"]["quote_currency"]) for v in generated}
    assert pairs == {("AED", "MXN"), ("EUR", "USD"), ("GBP", "PHP"), ("USD", "INR")}


def test_matches_rfc8785_on_every_vector(hash_vectors):
    """The restricted canonicalizer against a full RFC 8785 implementation.

    Skipped where `rfc8785` is not installed: the component must not depend on it
    (AD-1 §3.7), so the committed vectors above are the always-available check.
    """
    rfc8785 = pytest.importorskip("rfc8785")
    cases = hash_vectors["vectors"] + hash_vectors["must_not_match"]
    for case in cases:
        document = {"event_type": case["event_type"], "payload": case["payload"]}
        assert payload_canonical_string(case["event_type"], case["payload"]) == \
            rfc8785.dumps(document).decode("utf-8"), case["name"]


# ------------------------------------------------------------------ the subset
def test_the_subset_refuses_what_it_cannot_guarantee():
    """P-9's subset is enforced, not assumed: anything outside it raises.

    Numbers and booleans are refused because AD-4 §4 carries every number as a
    decimal string precisely so that JSON number formatting cannot change a hash;
    non-ASCII is refused because RFC 8785's escaping and UTF-16 key ordering are
    where a hand-written canonicalizer would silently differ.
    """
    for value in (1, 1.5, True, False, {"n": 1}, ["x", 2], "café", {"kéy": "v"}, "\x01"):
        with pytest.raises(CanonicalizationError):
            canonicalize(value)


def test_the_subset_canonicalizes_what_it_accepts():
    assert canonicalize(None) == "null"
    assert canonicalize({}) == "{}"
    assert canonicalize([]) == "[]"
    assert canonicalize({"b": "2", "a": None}) == '{"a":null,"b":"2"}'
    assert canonicalize({"a": ["x", {"c": "d"}]}) == '{"a":["x",{"c":"d"}]}'
    assert canonicalize('he said "hi"\n\\') == '"he said \\"hi\\"\\n\\\\"'
