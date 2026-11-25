"""Deterministic fault scenarios for the TEST-ONLY fake ingestion service (Dev D; AD-1 v0.5 section 3.1, 3.7 fault injection).

Pure functions: a scenario name, the current time and the time the scenario was set give exactly one response, so a test
can say what Express must have seen. Nothing here runs in a production image or in the default Compose stack.

  normal              four fresh, valid events (one per allowlisted pair), newest scheduled tick, age under 2 s
  extreme             four VALID events with extreme but legal rates (tiny, huge, integer, long)
  stale               four valid events aged 10 s: above stale_after_ms (6 s), below unavailable_after_ms (30 s)
  unavailable         four valid events aged 60 s: above unavailable_after_ms
  empty               a valid 200 with no events
  malformed_json      a 200 whose body is truncated JSON
  malformed_hash      a valid body in which the first event's payload_sha256 is wrong (only that event is refused)
  malformed_body      a 200 whose body carries an extra field (the whole response is refused)
  html_200            a 200 with Content-Type text/html
  http:STATUS[:SECS]  an error response: 302 (with Location), 401, 403, 404, 429 (Retry-After SECS if given), 500, 503, ...
  drop                the connection is closed without a response (a network error for the client)
  slow[:MS]           the normal body after MS milliseconds (default 1000, beyond the client's 400 ms deadline)
  outage_recovery:NORMAL_MS:OUTAGE_MS   normal for NORMAL_MS after the scenario is set, then HTTP 503 for OUTAGE_MS, then normal

Events are the real ones: they are built with the ingestion package's own builder (cbdc_ingestion.envelope), the same seed,
rate function, event ID derivation and RFC 8785 hash, so a "valid" event here is valid by construction and a fault is a
deliberate, named deviation from it. The timestamp of a pair's event is its newest scheduled tick (2 s per pair, staggered
500 ms, counted from the epoch) at or before `now - age`, so successive polls yield newer events until the next tick, and
the same clock always yields the same bytes.
"""
from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from typing import Optional

from cbdc_ingestion.clock import format_timestamp
from cbdc_ingestion.envelope import build_fx_event, fx_payload
from cbdc_ingestion.generator import PAIR_INTERVAL_MS, PAIR_STAGGER_MS, rate_for
from cbdc_ingestion.pairs import PAIRS

SEED = 20261126
INSTANCE_ID = str(uuid.uuid5(uuid.NAMESPACE_URL, "cbdc-p3-fault-ingestion"))
STALE_AGE_MS = 10_000        # AD-1 section 3.2 profile: stale_after_ms 6000 < 10 s < unavailable_after_ms 30000
UNAVAILABLE_AGE_MS = 60_000  # above unavailable_after_ms (30000)
DEFAULT_SLOW_MS = 1000       # beyond Express's 400 ms poll deadline (AD-1 section 3.1)
# Valid under AD-4's positive_decimal pattern and at most 40 characters (the client's limit), but extreme.
EXTREME_RATES = (
    "0.0000000000000000000000000000000000001",
    "999999999999999999999999999999.999999",
    "1",
    "0.5000000000000000000000000000001",
)
HTTP_ERROR_CODES = {400: "INVALID_REQUEST", 404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED", 500: "INTERNAL_ERROR", 503: "NOT_READY"}
SIMPLE = {"normal", "extreme", "stale", "unavailable", "empty", "malformed_json", "malformed_hash", "malformed_body", "html_200", "drop"}


class ScenarioError(ValueError):
    """An unknown or malformed scenario name."""


@dataclass(frozen=True)
class Scenario:
    kind: str
    status: int = 0
    retry_after: Optional[int] = None
    delay_ms: int = 0
    normal_ms: int = 0
    outage_ms: int = 0


@dataclass
class Response:
    status: int = 200
    content_type: str = "application/json"
    headers: dict = field(default_factory=dict)
    body: bytes = b""
    delay_ms: int = 0
    drop: bool = False


def parse(text: str) -> Scenario:
    text = (text or "").strip()
    head, *rest = text.split(":")
    if head in SIMPLE and not rest:
        return Scenario(head)
    try:
        if head == "http" and 1 <= len(rest) <= 2:
            status = int(rest[0])
            retry = int(rest[1]) if len(rest) == 2 else None
            if not 300 <= status <= 599 or (retry is not None and (status != 429 or not 0 <= retry <= 3600)):
                raise ValueError
            return Scenario("http", status=status, retry_after=retry)
        if head == "slow" and len(rest) <= 1:
            ms = int(rest[0]) if rest else DEFAULT_SLOW_MS
            if not 1 <= ms <= 60_000:
                raise ValueError
            return Scenario("slow", delay_ms=ms)
        if head == "outage_recovery" and len(rest) == 2:
            first, second = int(rest[0]), int(rest[1])
            if not (0 <= first <= 3_600_000 and 1 <= second <= 3_600_000):
                raise ValueError
            return Scenario("outage_recovery", normal_ms=first, outage_ms=second)
    except ValueError:
        pass
    raise ScenarioError(f"unknown or malformed scenario {text[:60]!r}")


def tick_for(pair_index: int, target_ms: int) -> tuple:
    """(sequence, scheduled ms) of the newest tick of one pair at or before target_ms; ticks count from the epoch."""
    offset = pair_index * PAIR_STAGGER_MS
    sequence = (target_ms - offset) // PAIR_INTERVAL_MS + 1
    return sequence, offset + (sequence - 1) * PAIR_INTERVAL_MS


def events_at(now_ms: int, age_ms: int = 0, rates: Optional[tuple] = None) -> list:
    out = []
    for index, pair in enumerate(PAIRS):
        sequence, moment = tick_for(index, now_ms - age_ms)
        rate = rates[index] if rates else rate_for(SEED, pair, sequence)
        out.append(build_fx_event(seed=SEED, sequence=sequence, payload=fx_payload(pair.base, pair.quote, rate),
                                  retrieved_at_ms=moment, case_id="fault"))
    return out


def body_for(now_ms: int, events: list) -> dict:
    return {"protocol_version": "1.0", "instance_id": INSTANCE_ID, "source_id": "synthetic.fx",
            "generated_at": format_timestamp(now_ms), "events": events}


def _json(status: int, doc, **kw) -> Response:
    return Response(status=status, body=json.dumps(doc, separators=(",", ":")).encode("utf-8"), **kw)


def error_response(status: int, retry_after: Optional[int] = None) -> Response:
    headers = {}
    if status == 429 and retry_after is not None:
        headers["Retry-After"] = str(retry_after)
    if 300 <= status < 400:
        headers["Location"] = "/elsewhere"
    code = HTTP_ERROR_CODES.get(status, "INTERNAL_ERROR" if status >= 500 else "INVALID_REQUEST")
    return _json(status, {"error": {"code": code, "message": "Request refused."}}, headers=headers)


def respond(scenario: Scenario, now_ms: int, set_at_ms: int = 0) -> Response:
    """The one response this scenario gives at `now_ms`; `set_at_ms` is when it was set (outage_recovery only)."""
    kind = scenario.kind
    if kind == "outage_recovery":
        into = now_ms - set_at_ms
        if scenario.normal_ms <= into < scenario.normal_ms + scenario.outage_ms:
            return error_response(503)
        return respond(Scenario("normal"), now_ms)
    if kind == "normal":
        return _json(200, body_for(now_ms, events_at(now_ms)))
    if kind == "extreme":
        return _json(200, body_for(now_ms, events_at(now_ms, rates=EXTREME_RATES)))
    if kind == "stale":
        return _json(200, body_for(now_ms, events_at(now_ms, STALE_AGE_MS)))
    if kind == "unavailable":
        return _json(200, body_for(now_ms, events_at(now_ms, UNAVAILABLE_AGE_MS)))
    if kind == "empty":
        return _json(200, body_for(now_ms, []))
    if kind == "malformed_json":
        text = json.dumps(body_for(now_ms, events_at(now_ms)), separators=(",", ":"))
        return Response(body=text[: len(text) // 2].encode("utf-8"))
    if kind == "malformed_hash":
        events = events_at(now_ms)
        events[0]["payload_sha256"] = "0" * 64
        return _json(200, body_for(now_ms, events))
    if kind == "malformed_body":
        doc = body_for(now_ms, events_at(now_ms))
        doc["unexpected"] = True
        return _json(200, doc)
    if kind == "html_200":
        return Response(content_type="text/html; charset=utf-8", body=b"<html><body>proxy notice</body></html>")
    if kind == "http":
        return error_response(scenario.status, scenario.retry_after)
    if kind == "slow":
        slow = respond(Scenario("normal"), now_ms)
        slow.delay_ms = scenario.delay_ms
        return slow
    if kind == "drop":
        return Response(drop=True)
    raise ScenarioError(f"no behaviour for {kind!r}")  # unreachable: parse() only builds the kinds above


LOOPBACK = re.compile(r"^(127\.\d+\.\d+\.\d+|::1)$")


def is_loopback(host: str) -> bool:
    return bool(LOOPBACK.match(host or ""))
