"""The A-4 case catalogue and its wiring. **The interface Dev B and Dev D bind to.**

This module is the single declaration of what A-4 exercises, so a conformance
matrix, a harness and the demonstration all drive the **same** cases. It is
test-only: it lives under `services/ingestion/tests/`, which acceptance
criterion 11 proves cannot enter a runtime image.

**The stable surface, which dependent work may rely on:**

| Name | What it is |
|---|---|
| `TRANSPORT_CASES` | The scripted cases, one `TransportCase` each, keyed by `case_id` |
| `TransportCase` | `case_id`, `step`, `fault_class`, `reason`, `permanent`, `authority`, `note` |
| `case(case_id)` | One case by id; raises on an unknown id rather than returning `None` |
| `scripted_adapter(...)` | A started `SimulatedTransportFxAdapter` on a scripted transport |
| `pipeline_for(...)` | The **real** `SourcePipeline` over the shipped registry record |
| `clean_values(...)` | The wire items the unchanged D-24 generator would produce |

**Case ids are stable.** A case may gain assertions, but its id keeps its
meaning, so a matrix written against `A4-06` does not silently change subject.
Adding a case appends an id; it never renumbers one.

**Nothing here sleeps, and nothing here opens anything.** Every case runs on a
`ManualClock`, so the breaker's window and cooldown are exercised by advancing
time, and the whole catalogue runs in milliseconds.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .conftest import REPO_ROOT, SEED, START_MS

# `infra/testing/` holds the scaffold and the bridge, both outside every build
# context. The insertion is explicit and test-only; the production package never
# does this, which is why `cbdc_ingestion` cannot reach either of them.
_INFRA_TESTING = str((REPO_ROOT / "infra" / "testing").resolve())
if _INFRA_TESTING not in sys.path:
    sys.path.insert(0, _INFRA_TESTING)

from a4_demo.bridge import ScriptedTransport, source_values  # noqa: E402
from fake_provider import (  # noqa: E402
    CloseOnConnect,
    Deliver,
    FakeProvider,
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

from cbdc_ingestion.adapters.context import (  # noqa: E402
    AdapterContext,
    CancellationSignal,
    NullMetrics,
)
from cbdc_ingestion.adapters.faults import FaultClass  # noqa: E402
from cbdc_ingestion.adapters.registry import load_registry  # noqa: E402
from cbdc_ingestion.adapters.simulated_fx import SimulatedTransportFxAdapter  # noqa: E402
from cbdc_ingestion.adapters.simulation import SIMULATION_TIMING  # noqa: E402
from cbdc_ingestion.clock import ManualClock  # noqa: E402
from cbdc_ingestion.pipeline import SourcePipeline  # noqa: E402
from cbdc_ingestion.sink import ServiceSink  # noqa: E402

SYNTHETIC_FX_SOURCE_ID = "synthetic.fx"

# A rate far outside the record's declared range, for the quarantine case. The
# bounds are the generator's own (AD-8 §4.4, synthetic category), so a value this
# far out is a generator defect by construction, which is what the bound is for.
IMPLAUSIBLE_RATE = "9.990000"


@dataclass(frozen=True)
class TransportCase:
    """One A-4 case: a scripted step and the outcome it must produce.

    `fault_class` is `None` for a case that must **not** fault. `authority`
    records whether AD-5 §7.1 names the class or this slice chose it, so a
    reviewer can tell a contract requirement from a scoped decision without
    leaving the table.
    """

    case_id: str
    step: object
    fault_class: Optional[FaultClass]
    reason: str
    permanent: bool
    authority: str
    note: str = ""


def _clean(sequence: int = 1):
    return source_values(SEED, START_MS, sequence)


def clean_values(sequence: int = 1):
    """The wire items the unchanged generator would produce for `sequence`."""
    return _clean(sequence)


# --------------------------------------------------------------- the catalogue
# AD-5 §13 A-4: "every §7.1 class; `Retry-After` present, absent and invalid;
# the breaker opening, cooling down and probing; a redirect; an oversized body; a
# wrong content type; a truncated stream; a provider that closes immediately on
# connect". The scripted rows are here; the breaker, `Retry-After` and
# status-machine rows are driven by their own suites, which this module serves.
TRANSPORT_CASES = (
    # --- AD-5 §7.1's eight classes, each reached by a real scripted response --
    TransportCase("A4-01", CloseOnConnect(), FaultClass.TRANSIENT_NETWORK,
                  "closed_on_connect", False, "AD-5 §7.1",
                  "a provider that closes immediately on connect"),
    TransportCase("A4-02", TruncatedStream(values=_clean()), FaultClass.TRANSIENT_NETWORK,
                  "truncated_stream", False, "AD-5 §7.1",
                  "a body that ends mid-stream is a connection failure, not a shape one"),
    TransportCase("A4-03", StatusFault(500), FaultClass.PROVIDER_UNAVAILABLE,
                  "server_error", False, "AD-5 §7.1", ""),
    TransportCase("A4-04", StatusFault(503), FaultClass.PROVIDER_UNAVAILABLE,
                  "server_unavailable", False, "AD-5 §7.1", ""),
    TransportCase("A4-05", StatusFault(429, retry_after="1"), FaultClass.RATE_LIMITED,
                  "rate_limited", False, "AD-5 §7.1", "with a valid Retry-After"),
    TransportCase("A4-06", StatusFault(401), FaultClass.AUTH_FAILURE,
                  "unauthorized", True, "AD-5 §7.1", "permanent: no retry at all"),
    TransportCase("A4-07", StatusFault(403), FaultClass.AUTH_FAILURE,
                  "forbidden", True, "AD-5 §7.1", "permanent: no retry at all"),
    TransportCase("A4-08", WrongContentType(), FaultClass.CONTRACT_VIOLATION,
                  "wrong_content_type", True, "AD-5 §7.1", ""),
    TransportCase("A4-09", MalformedBody(), FaultClass.CONTRACT_VIOLATION,
                  "unparsable_body", True, "AD-5 §7.1", ""),
    TransportCase("A4-10", Redirect(), FaultClass.CONTRACT_VIOLATION,
                  "redirect_not_allowed", True, "AD-5 §7.1",
                  "refused and never followed: it would reach an unlisted host"),
    # --- §7.3's whole-response conditions §7.1 does not name a class for ------
    TransportCase("A4-11", OversizedBody(), FaultClass.CONTRACT_VIOLATION,
                  "response_body_too_large", True, "slice",
                  "checked while reading, not after"),
    TransportCase("A4-12", WrongProtocolVersion(values=_clean()),
                  FaultClass.CONTRACT_VIOLATION, "unknown_protocol_version", True, "slice", ""),
    TransportCase("A4-13", TooManyItems(values=_clean() + _clean(2)),
                  FaultClass.CONTRACT_VIOLATION, "too_many_items", True, "slice",
                  "more items than the subject allowlist permits"),
    TransportCase("A4-14", RepeatedSubject(values=[_clean()[0], dict(_clean(2)[0])]),
                  FaultClass.CONTRACT_VIOLATION, "duplicate_subject_in_response", True,
                  "slice", "two items for one subject in one response"),
    # --- an unlisted status is not a success ----------------------------------
    TransportCase("A4-15", StatusFault(418), FaultClass.CONTRACT_VIOLATION,
                  "unexpected_status_418", True, "slice",
                  "an unlisted status is a misconfiguration, not a retryable outage"),
    # --- the two item-level outcomes, which change no adapter state -----------
    TransportCase("A4-16", Deliver(values=[{k: v for k, v in _clean()[0].items()
                                            if k != "rate"}]),
                  FaultClass.ITEM_INVALID, "missing_rate", False, "AD-5 §7.1",
                  "one bad item does not discard a good response"),
    # --- the clean control ----------------------------------------------------
    TransportCase("A4-17", Deliver(values=_clean()), None, "", False, "AD-5 §7.1",
                  "the control: without it the fault assertions would also pass "
                  "on a path that produced nothing at all"),
    TransportCase("A4-18", Silence(), None, "", False, "AD-5 §9.2",
                  "a successful poll with no item: the silence criterion's input"),
)

CASES_BY_ID = {c.case_id: c for c in TRANSPORT_CASES}


def case(case_id: str) -> TransportCase:
    """One case by id, refusing an unknown id rather than returning `None`."""
    try:
        return CASES_BY_ID[case_id]
    except KeyError:
        raise KeyError(
            f"unknown A-4 case {case_id!r}; the catalogue holds "
            f"{sorted(CASES_BY_ID)}") from None


# ------------------------------------------------------------------- the wiring
def record():
    """The **shipped** registry record, so the exercise runs against the real
    admission rules, freshness profile and plausibility bounds."""
    return load_registry().record_for(SYNTHETIC_FX_SOURCE_ID)


def transport(script, *, repeating: bool = False) -> ScriptedTransport:
    provider = FakeProvider(list(script))
    if repeating:
        provider.repeating()
    return ScriptedTransport(provider)


def scripted_adapter(script, *, clock: Optional[ManualClock] = None,
                     repeating: bool = False, jitter=None, jitter_seed: int = 0,
                     start: bool = True, profile=SIMULATION_TIMING):
    """A `SimulatedTransportFxAdapter` on `script`, started by default.

    Returns `(adapter, context, transport)`. The context carries the manual
    clock, so every timing assertion advances time instead of waiting.
    """
    clock = clock or ManualClock(START_MS)
    scripted = transport(script, repeating=repeating)
    adapter = SimulatedTransportFxAdapter(
        SYNTHETIC_FX_SOURCE_ID, SEED, transport=scripted, profile=profile,
        jitter=jitter, jitter_seed=jitter_seed)
    context = AdapterContext(
        source_id=SYNTHETIC_FX_SOURCE_ID, clock=clock, sink=ServiceSink(),
        cancellation=CancellationSignal(), metrics=NullMetrics())
    if start:
        adapter.start(context)
    return adapter, context, scripted


def pipeline_for(*, now_ms: int = START_MS) -> tuple:
    """The real pipeline and sink over the shipped record.

    Deliberately the production objects: the unchanged `envelope.py`, the
    unchanged `validation.py`, the real dedup classifier, the real plausibility
    guard, the real internal status machine and the real sink. A mock here would
    make the A-4 evidence about the mock.
    """
    shipped = record()
    return SourcePipeline(shipped, seed=SEED, now_ms=now_ms), ServiceSink()


def repeating_delivery_adapter_factory():
    """The factory the **shared contract suite** uses (A-1).

    `test_registry.py::test_every_adapter_subclass_is_in_the_shared_contract_suite`
    requires every `Adapter` subclass in the package to be in `ADAPTERS`, and
    A-1 requires one shared suite rather than a private one. The script repeats
    a clean delivery so the suite can poll an unknown number of times, and the
    values are the generator's own, so the contract assertions see exactly the
    observations every other adapter produces.
    """
    scripted = transport([Deliver(values=_clean())], repeating=True)
    return SimulatedTransportFxAdapter(SYNTHETIC_FX_SOURCE_ID, SEED, transport=scripted)
