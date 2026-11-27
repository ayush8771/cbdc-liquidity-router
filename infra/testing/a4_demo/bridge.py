"""The bridge: one fake-provider step becomes one `TransportResponse`.

**Why this exists as its own module, outside both sides.** The scaffold
`infra/testing/fake_provider/` must not import `cbdc_ingestion` — acceptance
criterion 11 asserts that, so the thing that injects faults cannot drift into the
component it tests. The production package must not import the scaffold either,
or a test-only script would be reachable from shipped code. So the two meet
**here**, in a third place that is test-only by location: `infra/` is outside the
ingestion build context, exactly as `infra/testing/fault_ingestion/` is, so
nothing in this file can enter a runtime image.

**One bridge, used by both the suite and the demonstration.** The A-4 tests and
`run_demo.py` import this same translation, so the demonstration cannot show a
behaviour the suite does not assert, and the suite cannot assert one the
demonstration would not reproduce.

**No network, in either direction.** This module imports `json` and the two
packages it bridges. It opens nothing, and `kind` is
`in_process_simulation`, which is the only kind `transport.assert_admissible`
admits.
"""
from __future__ import annotations

import json
from typing import Optional, Sequence

from cbdc_ingestion.adapters.transport import (
    EXPECTED_CONTENT_TYPE,
    WIRE_PROTOCOL_VERSION,
    TransportResponse,
)
from fake_provider import (
    CloseOnConnect,
    Deliver,
    Fault,
    MalformedBody,
    OversizedBody,
    Redirect,
    RepeatedSubject,
    Silence,
    StatusFault,
    TooManyItems,
    TruncatedStream,
    WrongContentType,
    WrongProtocolVersion,
)

TRANSPORT_KIND = "in_process_simulation"

# How a body is split when it is delivered normally. Small on purpose: an
# oversized case must cross the limit part-way through a sequence of chunks,
# which is the only way "checked while reading" can be observed.
DEFAULT_CHUNK_BYTES = 256


def encode(values: Sequence[dict], *, version: int = WIRE_PROTOCOL_VERSION,
           chunk_bytes: int = DEFAULT_CHUNK_BYTES) -> tuple:
    """`values` as the simulated wire document, split into chunks."""
    body = json.dumps({"protocol_version": version, "items": list(values)},
                      separators=(",", ":"), sort_keys=True).encode("utf-8")
    return tuple(body[i:i + chunk_bytes] for i in range(0, len(body), chunk_bytes)) or (b"",)


def to_response(step) -> TransportResponse:
    """One step as the response a transport would hand an adapter.

    An unknown step raises rather than defaulting to a healthy response: a case
    this bridge has not been taught must fail loudly, not pass as a success.
    """
    if isinstance(step, Deliver):
        return TransportResponse(chunks=encode(list(step.values)))

    if isinstance(step, Silence):
        return TransportResponse(chunks=encode([]))

    if isinstance(step, StatusFault):
        headers = {} if step.retry_after is None else {"Retry-After": step.retry_after}
        return TransportResponse(status=step.status, headers=headers, chunks=encode([]))

    if isinstance(step, Redirect):
        return TransportResponse(status=step.status, location=step.target, chunks=encode([]))

    if isinstance(step, WrongContentType):
        return TransportResponse(content_type=step.content_type, chunks=encode([]))

    if isinstance(step, MalformedBody):
        return TransportResponse(chunks=(step.text.encode("utf-8"),))

    if isinstance(step, OversizedBody):
        # Many small chunks, so the limit is crossed part-way and the reader can
        # be shown to have stopped early (AD-5 §7.3, "checked while reading").
        chunk = b"x" * step.chunk_bytes
        return TransportResponse(chunks=tuple(chunk for _ in range(step.chunks)))

    if isinstance(step, TruncatedStream):
        return TransportResponse(chunks=encode(list(step.values)), truncated=True)

    if isinstance(step, CloseOnConnect):
        return TransportResponse(network_error=step.reason)

    if isinstance(step, WrongProtocolVersion):
        return TransportResponse(chunks=encode(list(step.values), version=step.version))

    if isinstance(step, (RepeatedSubject, TooManyItems)):
        return TransportResponse(chunks=encode(list(step.values)))

    if isinstance(step, Fault):
        # The three AD-5 §7.1 *classes* the scaffold names directly, for a case
        # whose subject is the classification rather than the wire shape.
        mapped = {
            "recoverable": TransportResponse(status=503, chunks=encode([])),
            "permanent": TransportResponse(status=401, chunks=encode([])),
            "item": TransportResponse(chunks=encode([{"base": "EUR", "quote": "USD",
                                                      "rate_type": "mid"}])),
        }
        return mapped[step.fault_class]

    raise TypeError(
        f"this bridge has not been taught {type(step).__name__}; teach it rather than "
        "letting an untranslated step look like a healthy response")


class ScriptedTransport:
    """A pull-only transport over a `FakeProvider` script. **In process.**

    `kind` is the one admitted value. There is no connect, no send and no
    header-setting operation, so an adapter cannot push anything outward through
    it, and an exhausted script raises rather than quietly going silent.
    """

    kind = TRANSPORT_KIND

    def __init__(self, provider) -> None:
        self.provider = provider
        self.fetches = 0
        self.last_step = None

    def fetch(self) -> TransportResponse:
        self.fetches += 1
        step = self.provider.poll()
        self.last_step = step
        return to_response(step)


def source_values(seed: int, start_ms: int, sequence: int, *,
                  pairs: Optional[Sequence] = None) -> list:
    """The wire items the **D-24 generator** would produce for `sequence`.

    `rate_for` and the pair list are imported from the unchanged component, so a
    delivered value is bit-identical to what the generator and the 3.3-A adapter
    produce for the same `(seed, pair, sequence)`. A fault case therefore differs
    from a clean one in its **faults only**, never in its values — which is what
    lets the demonstration show recovery converging back onto the same series.
    """
    from cbdc_ingestion.generator import PAIR_INTERVAL_MS, PAIR_STAGGER_MS, rate_for
    from cbdc_ingestion.pairs import PAIRS, RATE_TYPE

    chosen = PAIRS if pairs is None else pairs
    items = []
    for index, pair in enumerate(chosen):
        items.append({
            "base": pair.base,
            "quote": pair.quote,
            "rate": rate_for(seed, pair, sequence),
            "rate_type": RATE_TYPE,
            "at_ms": start_ms + index * PAIR_STAGGER_MS + (sequence - 1) * PAIR_INTERVAL_MS,
            "sequence": sequence,
        })
    return items
