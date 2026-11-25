"""Canonical JSON (RFC 8785 subset) and the AD-4 `payload_sha256`.

AD-4 §2 defines `payload_sha256` as the SHA-256 of the RFC 8785 (JCS) form of
`{"event_type": ..., "payload": ...}`, lowercase hex.

This module implements the **restricted** canonicalizer approved as P-9 (AD-1
§3.7, Dev A technical approval, Dev B and Dev D approval): objects, arrays and
**ASCII** strings only, with no new dependency. It deliberately refuses
everything it cannot canonicalize byte-identically to a full RFC 8785
implementation, rather than guessing:

- **no numbers and no booleans.** AD-4 §4 requires every payload number to be a
  decimal *string*, precisely so that JSON number formatting (RFC 8785 §3.2.2's
  ECMAScript rules) cannot change a value or a hash. Refusing numbers here keeps
  that guarantee enforced instead of assumed.
- **no non-ASCII and no control characters.** RFC 8785 sorts object keys by
  UTF-16 code unit and escapes a fixed set of characters; restricting the input
  to printable ASCII makes code-point order, code-unit order and `str.encode`
  identical, so the hard parts cannot be got wrong silently.

`null` is permitted, because AD-4 writes absent values out as `null`.

`tests/test_payload_hash.py` checks this implementation against `rfc8785` on
every fixture when that package is importable, and against the committed
cross-language vectors `contracts/test-vectors/event_payload_hash.v1.json`
(AD-1 §3.7) always. The backend validates the same hash independently.
"""
from __future__ import annotations

import hashlib
from typing import Any

# RFC 8785 §3.2.2.2 two-character escapes, plus \u00XX for the other controls.
_ESCAPES = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f",
            "\n": "\\n", "\r": "\\r", "\t": "\\t"}


class CanonicalizationError(ValueError):
    """The value is outside the subset this canonicalizer guarantees (P-9)."""


def _string(value: str) -> str:
    if not all(0x20 <= ord(ch) <= 0x7E or ch in _ESCAPES for ch in value):
        raise CanonicalizationError(
            "only printable ASCII strings are canonicalized here (P-9 subset); "
            "a non-ASCII or control character needs a full RFC 8785 implementation")
    out = ['"']
    for ch in value:
        out.append(_ESCAPES.get(ch, ch))
    out.append('"')
    return "".join(out)


def canonicalize(value: Any) -> str:
    """The RFC 8785 serialisation of `value`, within the P-9 subset.

    Object keys are sorted ascending; there is no whitespace. A value outside the
    subset raises `CanonicalizationError`.
    """
    if value is None:
        return "null"
    if isinstance(value, str):
        return _string(value)
    if isinstance(value, dict):
        for key in value:
            if not isinstance(key, str):
                raise CanonicalizationError("object keys must be strings")
        members = [f"{_string(k)}:{canonicalize(value[k])}" for k in sorted(value)]
        return "{" + ",".join(members) + "}"
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonicalize(item) for item in value) + "]"
    # bool must be rejected before int: in Python, bool is a subclass of int.
    raise CanonicalizationError(
        f"{type(value).__name__} is outside the P-9 subset; AD-4 §4 requires numbers as decimal strings")


def payload_hash_document(event_type: str, payload: dict) -> dict:
    """The exact document AD-4 §2 hashes. Nothing else enters `payload_sha256`."""
    return {"event_type": event_type, "payload": payload}


def payload_canonical_string(event_type: str, payload: dict) -> str:
    return canonicalize(payload_hash_document(event_type, payload))


def payload_sha256(event_type: str, payload: dict) -> str:
    """AD-4 §2 `payload_sha256`: lowercase hex SHA-256 over the canonical UTF-8 bytes."""
    return hashlib.sha256(payload_canonical_string(event_type, payload).encode("utf-8")).hexdigest()
