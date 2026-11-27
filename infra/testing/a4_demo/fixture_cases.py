"""Fixture-driven A-4 cases, run through the **authoritative** production code.

The cases live as data in `fake_provider/fixtures/a4_cases.v1.json`
(hand-written; origin record beside it). This module, which sits in the
test-only `a4_demo` root like `bridge.py`, turns each into a `TransportResponse`
and runs it through `adapters.response.read_response`, `adapters.retry` and
nothing of its own: classification, Retry-After, backoff and the breaker are
never reimplemented here. `fake_provider` stays free of production imports.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from cbdc_ingestion.adapters.faults import AdapterFault
from cbdc_ingestion.adapters.response import read_response
from cbdc_ingestion.adapters.retry import BackoffPolicy, CircuitBreaker
from cbdc_ingestion.adapters.transport import TransportResponse

FIXTURE = Path(__file__).resolve().parents[1] / "fake_provider" / "fixtures" / "a4_cases.v1.json"
SOURCE_ID = "fixture.a4"


@dataclass(frozen=True)
class FixtureCase:
    case_id: str
    expect: str  # a FaultClass value, or "accepted"
    raw: dict


def load_cases(path: Path = FIXTURE) -> tuple:
    doc = json.loads(path.read_text(encoding="utf-8"))
    return tuple(FixtureCase(c["case_id"], c["expect"], c) for c in doc["cases"])


def to_response(case: FixtureCase) -> TransportResponse:
    """A fresh response each call (a response's consumption counters are mutable)."""
    c = case.raw
    body = c.get("body", "").encode()
    if "body_repeat" in c:
        body = c["body_repeat"]["unit"].encode() * c["body_repeat"]["count"]
    size = c.get("chunk_bytes", 256)
    chunks = tuple(body[i:i + size] for i in range(0, len(body), size))
    headers = {"Retry-After": c["retry_after"]} if "retry_after" in c else {}
    return TransportResponse(status=c.get("status", 200), content_type=c.get("content_type", ""),
                             chunks=chunks, headers=headers, truncated=c.get("truncated", False),
                             network_error=c.get("network_error"), location=c.get("location"))


def run_case(case: FixtureCase, policy: Optional[BackoffPolicy] = None) -> dict:
    """`{result, reason, retry}`: the production verdict for one case."""
    response = to_response(case)
    try:
        _items, retry_after = read_response(response, source_id=SOURCE_ID)
    except AdapterFault as fault:
        decision = (policy or BackoffPolicy(seed=0)).next_decision(
            fault.fault_class, retry_after=response.header("Retry-After"))
        return {"result": fault.fault_class.value, "reason": fault.reason, "retry": decision,
                "bytes_consumed": response.bytes_consumed, "bytes_total": sum(map(len, response.chunks))}
    return {"result": "accepted", "reason": "ok", "retry": None,
            "bytes_consumed": response.bytes_consumed, "bytes_total": sum(map(len, response.chunks))}


def run_breaker(failing: FixtureCase, healthy: FixtureCase, profile=None) -> list:
    """Repeated failures, opening, cooldown, a failed probe, then recovery; returns the states visited."""
    breaker = CircuitBreaker(SOURCE_ID, *([profile] if profile else []))
    p, now, visited = breaker.profile, 0, [breaker.state]

    def poll(case):
        nonlocal now
        assert breaker.allow(now), f"breaker refused at {now} ms in {breaker.state}"
        ok = run_case(case)["result"] == "accepted"
        (breaker.record_success if ok else breaker.record_failure)(now)
        visited.append(breaker.state)

    for _ in range(p.breaker_failure_threshold):
        poll(failing)
        now += 1
    assert not breaker.allow(now), "open breaker admitted a request inside the cooldown"
    now += p.breaker_cooldown_ms
    poll(failing)  # the probe fails: reopened
    now += p.breaker_cooldown_ms
    poll(healthy)  # the probe succeeds: closed
    return visited
