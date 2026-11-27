"""A reproducible A-4 demonstration, on the real ingestion pipeline. TEST-ONLY.

    python infra/testing/a4_demo/run_demo.py

It runs six scenarios against the **production** objects — the shipped registry
record, the unchanged `envelope.py`, the unchanged `validation.py`, the real
dedup classifier, the real plausibility guard, the real internal status machine
and the real sink — driven by a scripted in-process fake provider. It prints one
table per scenario and exits non-zero if any expectation fails, so it is a
demonstration **and** a check.

**It is deterministic.** Every clock is a `ManualClock`, the jitter source is
seeded, and the delivered values come from the unchanged generator's `rate_for`.
Two runs on two machines print the same numbers; `--json` emits them for a diff.

**What it is not.** No network, no real provider, no credential, no Docker and
no service process: it builds the pipeline in-process. It lives under `infra/`,
outside every build context, so nothing here can enter a runtime image, and
nothing in `services/ingestion/cbdc_ingestion/` imports it.

**Simulation parameters, not AD-8 defaults.** The timings come from
`SimulatedTimingProfile`, labelled `SIMULATION_ONLY`, because AD-8 §3.5's `poll`
column is unapproved. The header prints them so that no reader mistakes a
printed millisecond count for an approved production threshold.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
for path in (REPO_ROOT / "services" / "ingestion", REPO_ROOT / "infra" / "testing"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from a4_demo.bridge import ScriptedTransport, source_values  # noqa: E402
from fake_provider import (  # noqa: E402
    CloseOnConnect,
    Deliver,
    FakeProvider,
    MalformedBody,
    OversizedBody,
    Redirect,
    Silence,
    StatusFault,
    TruncatedStream,
)

from cbdc_ingestion.adapters.context import (  # noqa: E402
    AdapterContext,
    CancellationSignal,
    NullMetrics,
)
from cbdc_ingestion.adapters.registry import load_registry  # noqa: E402
from cbdc_ingestion.adapters.simulated_fx import SimulatedTransportFxAdapter  # noqa: E402
from cbdc_ingestion.adapters.simulation import SIMULATION_TIMING as P  # noqa: E402
from cbdc_ingestion.clock import ManualClock  # noqa: E402
from cbdc_ingestion.pairs import PAIRS  # noqa: E402
from cbdc_ingestion.pipeline import SourcePipeline  # noqa: E402
from cbdc_ingestion.sink import ServiceSink  # noqa: E402

SOURCE_ID = "synthetic.fx"
SEED = 20261125
START_MS = 1764028800000  # 2025-11-25T00:00:00.000Z
# A delivered observation carries the scheduled moment of its sequence, so a
# publishing cycle runs past the last pair's stagger; otherwise the unchanged
# builder quarantines it as a future timestamp, correctly.
SETTLE_MS = 10_000


def build(script, *, repeating: bool = False):
    """The real pipeline, sink, adapter and transport for one scenario."""
    record = load_registry().record_for(SOURCE_ID)
    provider = FakeProvider(list(script))
    if repeating:
        provider.repeating()
    transport = ScriptedTransport(provider)
    clock = ManualClock(START_MS)
    adapter = SimulatedTransportFxAdapter(SOURCE_ID, SEED, transport=transport,
                                          jitter_seed=20261127)
    context = AdapterContext(source_id=SOURCE_ID, clock=clock, sink=ServiceSink(),
                             cancellation=CancellationSignal(), metrics=NullMetrics())
    adapter.start(context)
    sink = ServiceSink()
    return SourcePipeline(record, seed=SEED, now_ms=START_MS), sink, adapter, context, transport


def run(pipeline, sink, adapter, context, cycles, *, advance_ms: int):
    """`cycles` service cycles, advancing the injected clock between them."""
    log = []
    for _ in range(cycles):
        context.clock.advance_ms(advance_ms)
        result = pipeline.run_cycle(adapter, sink, retrieved_at_ms=context.clock.now_ms())
        log.append({
            "at_ms": context.clock.now_ms() - START_MS,
            "produced": result.produced,
            "published": result.published,
            "quarantined": result.quarantined,
            "faults": result.faults,
            "item_faults": result.item_faults,
            "adapter_state": adapter.state,
            "source_status": pipeline.status.state,
            "published_status": pipeline.status.published,
            "breaker": adapter.breaker.state,
            "transport_calls": transport_calls(adapter),
            "reasons": list(result.reasons),
        })
    return log


def transport_calls(adapter) -> int:
    return adapter.transport_calls


# --------------------------------------------------------------------- scenarios
def scenario_clean():
    """The control. Without it, every fault scenario below would also 'pass' on a
    pipeline that published nothing at all."""
    script = [Deliver(values=source_values(SEED, START_MS, n)) for n in range(1, 4)]
    pipeline, sink, adapter, context, _ = build(script, repeating=True)
    log = run(pipeline, sink, adapter, context, 3, advance_ms=SETTLE_MS)
    return {
        "name": "clean",
        "claim": "a healthy source publishes every pair and the status is ok",
        "log": log,
        "checks": [
            ("every cycle published all four pairs",
             all(e["published"] == len(PAIRS) for e in log)),
            ("the source status is ok", log[-1]["source_status"] == "ok"),
            ("the adapter is running", log[-1]["adapter_state"] == "running"),
            ("no fault was counted", all(e["faults"] == 0 for e in log)),
        ],
    }


def scenario_recoverable_then_recovery():
    """A 503, honoured backoff, then recovery onto the same value series."""
    script = [StatusFault(503),
              Deliver(values=source_values(SEED, START_MS, 6))]
    pipeline, sink, adapter, context, _ = build(script, repeating=True)
    log = run(pipeline, sink, adapter, context, 2, advance_ms=SETTLE_MS)
    from cbdc_ingestion.generator import rate_for
    recovered = [sink.store.latest_for(p.key) for p in PAIRS]
    return {
        "name": "provider_unavailable_then_recovery",
        "claim": "a 503 degrades the adapter, backoff is set, and one good item recovers it",
        "log": log,
        "checks": [
            ("the 503 was counted as a fault", log[0]["faults"] == 1),
            ("the reason names the class", "server_unavailable" in log[0]["reasons"]),
            ("the adapter degraded", log[0]["adapter_state"] == "degraded"),
            ("one good item returned it to running",
             log[1]["adapter_state"] == "running"),
            ("the source status is ok again", log[1]["source_status"] == "ok"),
            ("the recovered values are the unchanged generator's own",
             all(v is not None and v["payload"]["rate"] == rate_for(SEED, p, 6)
                 for v, p in zip(recovered, PAIRS))),
        ],
    }


def scenario_permanent():
    """A 401. No retry, ever, and the internal status is `down`."""
    pipeline, sink, adapter, context, transport = build([StatusFault(401)], repeating=True)
    log = run(pipeline, sink, adapter, context, 4, advance_ms=60_000)
    return {
        "name": "auth_failure_is_permanent",
        "claim": "a permanent fault stops requesting for ever and down never self-heals",
        "log": log,
        "checks": [
            ("the adapter failed permanently",
             log[0]["adapter_state"] == "failed_permanent"),
            ("the internal status is down", log[0]["source_status"] == "down"),
            ("down is published as outage, never as a fourth value",
             log[0]["published_status"] == "outage"),
            ("exactly one request was ever made", transport.fetches == 1),
            ("no later cycle retried",
             all(e["transport_calls"] == 1 for e in log)),
            ("down did not self-heal", log[-1]["source_status"] == "down"),
        ],
    }


def scenario_breaker():
    """Repeated failures open the breaker, and the cooldown costs no requests."""
    pipeline, sink, adapter, context, transport = build([StatusFault(500)], repeating=True)
    log = run(pipeline, sink, adapter, context, P.breaker_failure_threshold,
              advance_ms=P.min_request_interval_ms + P.backoff_ceiling_ms)
    calls_when_opened = transport.fetches
    during = run(pipeline, sink, adapter, context, 10,
                 advance_ms=max(1, P.breaker_cooldown_ms // 40))
    return {
        "name": "circuit_breaker",
        "claim": "the breaker opens at the threshold and its cooldown makes no requests",
        "log": log + during,
        "checks": [
            ("the breaker opened", log[-1]["breaker"] == "open"),
            ("it opened at the threshold, not before",
             calls_when_opened == P.breaker_failure_threshold),
            ("the cooldown cost no requests",
             transport.fetches == calls_when_opened),
            ("the source reached outage", log[-1]["source_status"] == "outage"),
        ],
    }


def scenario_whole_response_rejections():
    """AD-5 §7.3: each response is discarded as a whole, with its own reason.

    **Each condition gets its own adapter, deliberately.** Most of these are
    permanent `contract_violation`s, so the first one sends its adapter to
    `failed_permanent` and — correctly — it never requests again. Scripting them
    one after another on a single adapter would therefore exercise only the
    first and silently skip the rest, which is exactly the kind of vacuous pass
    this demonstration exists to rule out.
    """
    steps = [MalformedBody(), Redirect(), OversizedBody(),
             TruncatedStream(values=source_values(SEED, START_MS, 2)),
             CloseOnConnect()]
    log, reasons = [], {}
    for step in steps:
        pipeline, sink, adapter, context, _ = build([step])
        log += run(pipeline, sink, adapter, context, 1,
                   advance_ms=P.backoff_ceiling_ms + P.min_request_interval_ms)
        for reason, count in sink.counters()["faults"]["by_reason"].items():
            reasons[reason] = reasons.get(reason, 0) + count
    return {
        "name": "whole_response_rejection",
        "claim": "a response that cannot be trusted as a whole publishes nothing "
                 "and is counted by reason",
        "log": log,
        "reasons": reasons,
        "checks": [
            ("nothing was published", all(e["published"] == 0 for e in log)),
            ("the malformed body was counted", reasons.get("unparsable_body") == 1),
            ("the redirect was refused, not followed",
             reasons.get("redirect_not_allowed") == 1),
            ("the oversized body was refused",
             reasons.get("response_body_too_large") == 1),
            ("the truncated stream was counted", reasons.get("truncated_stream") == 1),
            ("the immediate close was counted", reasons.get("closed_on_connect") == 1),
        ],
    }


def scenario_silence():
    """A source that answers successfully and says nothing still goes to outage."""
    pipeline, sink, adapter, context, _ = build([Silence()], repeating=True)
    window = pipeline.status.silence_window_ms
    first = run(pipeline, sink, adapter, context, 1, advance_ms=1)
    second = run(pipeline, sink, adapter, context, 1, advance_ms=window)
    return {
        "name": "silence_is_an_outage",
        "claim": "the silence criterion fires with no recorded failure at all",
        "log": first + second,
        "checks": [
            ("silence is not a failure", first[0]["faults"] == 0),
            ("the source is not yet in outage", first[0]["source_status"] == "starting"),
            ("the silence window drove it to outage",
             second[0]["source_status"] == "outage"),
            ("still with no failure counted", second[0]["faults"] == 0),
        ],
    }


SCENARIOS = (
    scenario_clean,
    scenario_recoverable_then_recovery,
    scenario_permanent,
    scenario_breaker,
    scenario_whole_response_rejections,
    scenario_silence,
)


# ------------------------------------------------------------------- the printing
def header() -> list:
    return [
        "A-4 synthetic fault handling -- in-process fake-provider seam",
        "",
        "  TEST-ONLY. No network, no real provider, no credential, no Docker.",
        "  All four capability gates remain CLOSED. `usage` is display_only on every",
        "  envelope and no observation reaches the routing engine.",
        "",
        f"  timing profile:        {P.label}  (NOT AD-8 s3.5; its poll column is unapproved)",
        f"  backoff:               base {P.backoff_base_ms} ms, ceiling {P.backoff_ceiling_ms} ms, full jitter (seeded)",
        f"  Retry-After clamp:     {P.retry_after_min_ms}-{P.retry_after_max_ms} ms",
        f"  breaker:               {P.breaker_failure_threshold} failures in {P.breaker_window_ms} ms, {P.breaker_cooldown_ms} ms cooldown",
        f"  response limits:       {P.max_response_bytes} bytes, {P.max_items_per_response} items",
        f"  outage (AD-8 synthetic, APPROVED): 3 consecutive failures or 3x interval",
        "",
    ]


def render(scenario: dict) -> list:
    lines = [f"-- {scenario['name']}", f"   claim: {scenario['claim']}", ""]
    columns = ("at_ms", "produced", "published", "quarantined", "faults",
               "adapter_state", "source_status", "breaker", "transport_calls")
    widths = {c: max(len(c), *(len(str(e[c])) for e in scenario["log"])) for c in columns}
    lines.append("   " + "  ".join(c.ljust(widths[c]) for c in columns))
    for entry in scenario["log"]:
        lines.append("   " + "  ".join(str(entry[c]).ljust(widths[c]) for c in columns))
    if scenario.get("reasons"):
        lines += ["", "   fault reasons: " + json.dumps(scenario["reasons"], sort_keys=True)]
    lines.append("")
    for claim, passed in scenario["checks"]:
        lines.append(f"   [{'PASS' if passed else 'FAIL'}] {claim}")
    lines.append("")
    return lines


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--json", action="store_true",
                        help="emit the scenarios as JSON, for a byte-exact diff")
    parser.add_argument("--only", metavar="NAME", default=None,
                        help="run one scenario by name")
    args = parser.parse_args(argv)

    results = []
    for build_scenario in SCENARIOS:
        scenario = build_scenario()
        if args.only and scenario["name"] != args.only:
            continue
        results.append(scenario)
    if not results:
        print(f"no scenario named {args.only!r}; "
              f"choose from {[s.__name__ for s in SCENARIOS]}", file=sys.stderr)
        return 2

    failures = [(s["name"], claim) for s in results for claim, passed in s["checks"]
                if not passed]

    if args.json:
        print(json.dumps({"profile": P.label, "scenarios": results},
                         indent=2, sort_keys=True, default=str))
    else:
        print("\n".join(header()))
        for scenario in results:
            print("\n".join(render(scenario)))
        total = sum(len(s["checks"]) for s in results)
        print(f"-- {total - len(failures)}/{total} checks passed "
              f"across {len(results)} scenarios")
        for name, claim in failures:
            print(f"   FAILED {name}: {claim}", file=sys.stderr)

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
