"""A-4 in-process fault-injection harness (AD-5 section 13 A-4, AD-12 section 4). TEST-ONLY.

Simulates a provider's misbehaviour as plain data (`SimResponse`) and drives a
harness-local reference of AD-5 sections 7.1-7.4: response classification,
backoff with `Retry-After`, and the per-source circuit breaker. Standard library
only; no socket, no HTTP, no clock but the injected one, no import of
`cbdc_ingestion`.

**Limit, stated plainly:** this exercises the *rules* against simulated
responses, not any adapter or real transport. TLS, DNS, real redirects, slow
reads and connection resets are not modelled. Thresholds are harness parameters,
provisional until AD-8's values apply. The adapter has no breaker yet; see README.
"""
from __future__ import annotations

import json
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from .provider import Deliver, FakeProvider, Fault, Silence

FIXTURE = Path(__file__).parent / "fixtures" / "a4_cases.v1.json"
DEFAULT_LIMITS = {"max_body_bytes": 4096, "chunk_bytes": 1024}
# AD-5 section 7.1 classes, mapped to the scaffold's vocabulary.
KIND = {"transient_network": "recoverable", "provider_unavailable": "recoverable",
        "rate_limited": "recoverable", "internal": "recoverable",
        "auth_failure": "permanent", "contract_violation": "permanent"}
RETRY_AFTER_MIN_S, RETRY_AFTER_MAX_S = 1, 30  # AD-1 section 3.1 slice clamp


class ManualClock:
    def __init__(self, start_s: float = 0.0) -> None:
        self.now = start_s

    def advance(self, seconds: float) -> None:
        self.now += seconds


@dataclass(frozen=True)
class SimResponse:
    case_id: str
    status: int = 200
    content_type: str = "application/json"
    body: bytes = b""
    declared_length: Optional[int] = None
    retry_after: Optional[str] = None
    location: Optional[str] = None
    close_on_connect: bool = False


@dataclass(frozen=True)
class Outcome:
    case_id: str
    result: str  # "accepted" or an AD-5 fault class
    reason: str
    retry_after_s: Optional[int] = None
    bytes_read: int = 0


def load_cases(path: Path = FIXTURE) -> tuple[dict, list, dict]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    cases, expect = [], {}
    for c in raw["cases"]:
        body = c.get("body", "").encode()
        if "body_repeat" in c:
            body = c["body_repeat"]["unit"].encode() * c["body_repeat"]["count"]
        cases.append(SimResponse(c["case_id"], c.get("status", 200), c.get("content_type", ""), body,
                                 c.get("declared_length"), c.get("retry_after"), c.get("location"),
                                 c.get("close_on_connect", False)))
        expect[c["case_id"]] = c["expect"]
    return raw["limits"], cases, expect


def parse_retry_after(value: Optional[str]) -> Optional[int]:
    """Whole seconds, clamped; absent or invalid gives None (the computed backoff then applies)."""
    if value is None or not value.isascii() or not value.isdigit():
        return None
    return max(RETRY_AFTER_MIN_S, min(RETRY_AFTER_MAX_S, int(value)))


def classify(resp: SimResponse, limits: dict) -> Outcome:
    """AD-5 sections 7.1 and 7.3. The body is read in chunks and abandoned at the limit."""
    cid = resp.case_id
    if resp.close_on_connect:
        return Outcome(cid, "transient_network", "closed_on_connect")
    if resp.status in (401, 403):
        return Outcome(cid, "auth_failure", "status_auth")
    if resp.status == 429:
        return Outcome(cid, "rate_limited", "status_429", parse_retry_after(resp.retry_after))
    if resp.status >= 500:
        return Outcome(cid, "provider_unavailable", "status_5xx")
    if 300 <= resp.status < 400:
        return Outcome(cid, "contract_violation", "redirect")
    if resp.status != 200:
        return Outcome(cid, "contract_violation", "status_unexpected")
    if resp.content_type.split(";")[0].strip().lower() != "application/json":
        return Outcome(cid, "contract_violation", "wrong_content_type")
    read, chunk, cap = 0, limits["chunk_bytes"], limits["max_body_bytes"]
    while read < len(resp.body):
        read += min(chunk, len(resp.body) - read)
        if read > cap:  # abandoned mid-read: the rest is never consumed
            return Outcome(cid, "contract_violation", "oversized", bytes_read=read)
    if resp.declared_length is not None and read < resp.declared_length:
        return Outcome(cid, "transient_network", "truncated", bytes_read=read)
    try:
        doc = json.loads(resp.body)
        if not isinstance(doc, dict) or not isinstance(doc.get("items"), list):
            raise ValueError
    except ValueError:
        return Outcome(cid, "contract_violation", "malformed", bytes_read=read)
    return Outcome(cid, "accepted", "ok", bytes_read=read)


class Backoff:
    """AD-5 section 7.2: full jitter from a seeded RNG; a valid Retry-After overrides, clamped."""

    def __init__(self, seed: int, base_s: float = 1.0, ceiling_s: float = 30.0) -> None:
        self._rng = random.Random(seed)
        self.base, self.ceiling, self.attempt, self._last = base_s, ceiling_s, 0, 0.0

    def next_wait(self, outcome: Outcome) -> float:
        self.attempt += 1
        wait = self._rng.uniform(0, min(self.base * 2 ** (self.attempt - 1), self.ceiling))
        if outcome.retry_after_s is not None:
            wait = float(outcome.retry_after_s)
        if outcome.result == "rate_limited":
            wait = max(wait, self._last)  # a rate_limited fault never shortens the next wait
        self._last = wait
        return wait

    def reset(self) -> None:
        self.attempt, self._last = 0, 0.0


class Breaker:
    """AD-5 section 7.4, per source: open after `threshold` failures in `window_s`,
    cool down, then admit exactly one probe (success closes it, failure reopens it)."""

    def __init__(self, source_id: str, clock: ManualClock, threshold: int = 3,
                 window_s: float = 30.0, cooldown_s: float = 10.0) -> None:
        self.source_id, self.clock = source_id, clock
        self.threshold, self.window_s, self.cooldown_s = threshold, window_s, cooldown_s
        self.state, self._failures, self._opened_at = "closed", [], 0.0
        self.history = ["closed"]  # every state the breaker has entered, in order

    def _set(self, state: str) -> None:
        self.state = state
        self.history.append(state)

    def allow(self) -> bool:
        if self.state == "open" and self.clock.now - self._opened_at >= self.cooldown_s:
            self._set("half_open")
            return True  # the one probe
        return self.state == "closed"

    def record(self, ok: bool) -> None:
        if ok:
            self._failures = []
            if self.state != "closed":
                self._set("closed")
            return
        now = self.clock.now
        self._failures = [t for t in self._failures if now - t < self.window_s] + [now]
        if self.state == "half_open" or len(self._failures) >= self.threshold:
            self._opened_at = now
            self._set("open")


def log_line(source_id: str, outcome: Outcome, breaker_state: str) -> str:
    """AD-1 section 3.4: reason code and ids only; never a body, header or location."""
    return (f"source={source_id} case={outcome.case_id} result={outcome.result} "
            f"reason={outcome.reason} breaker={breaker_state}")


def run_script(script: list, source_id: str = "fake.a4", seed: int = 20261127,
               limits: Optional[dict] = None, log: Optional[Callable[[str], None]] = None,
               history: Optional[list] = None) -> list:
    """Drives a `FakeProvider` script through the breaker and returns a trace of
    `(clock_s, result, breaker_state)`.

    A `Deliver` holding a `SimResponse` is classified; any other `Deliver` is a
    success. A `Fault` is taken at its scripted class (an `item` fault is
    recorded but never trips the breaker). `Silence` is a poll with no failure
    and no success. A permanent fault ends the run with `failed_permanent`.
    """
    limits = limits or DEFAULT_LIMITS
    clock, provider = ManualClock(), FakeProvider(script)
    breaker, backoff, trace = Breaker(source_id, clock), Backoff(seed), []
    if history is not None:
        history.append(breaker.history)  # the live list, filled as the run proceeds
    while not provider.exhausted:
        if not breaker.allow():  # a skipped poll consumes no script step
            trace.append((clock.now, "skipped", breaker.state))
            clock.advance(2.0)
            continue
        step = provider.poll()
        if isinstance(step, Silence):
            trace.append((clock.now, "silence", breaker.state))
            clock.advance(1.0)
            continue
        if isinstance(step, Fault):
            if step.fault_class == "item":
                outcome = Outcome(step.reason, "accepted", "item_rejected")
            else:
                result = "auth_failure" if step.fault_class == "permanent" else "provider_unavailable"
                outcome = Outcome(step.reason, result, step.reason)
        else:
            resp = next((v for v in step.values if isinstance(v, SimResponse)), None)
            outcome = classify(resp, limits) if resp else Outcome("deliver", "accepted", "ok")
        ok = outcome.result == "accepted"
        breaker.record(ok)
        if log:
            log(log_line(source_id, outcome, breaker.state))
        trace.append((clock.now, outcome.result, breaker.state))
        if ok:
            backoff.reset()
            clock.advance(1.0)
        elif KIND[outcome.result] == "permanent":
            trace.append((clock.now, "failed_permanent", breaker.state))
            break  # AD-5 section 3.3: a permanent fault never retries
        else:
            clock.advance(backoff.next_wait(outcome))
    return trace
