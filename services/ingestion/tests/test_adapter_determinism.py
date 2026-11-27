"""Acceptance criterion 4 (A-3): determinism across process restarts, on the adapter path.

A fixed seed and an injected clock reproduce identical payloads, `payload_sha256`
values and `event_id`s, **across process restarts**. "Across restarts" is
exercised two ways: a fresh adapter in the same process, and a fresh Python
interpreter with a different `PYTHONHASHSEED`, so a dependence on dict or set
ordering, on interpreter state or on the wall clock cannot hide.

The expected values are pinned in `fixtures/adapter_determinism.v1.json`, a
fixture whose provenance is recorded beside it (criterion 9). The existing
`test_restart_identity.py` is unchanged and still covers the D-24 path.
"""
from __future__ import annotations

import inspect
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from cbdc_ingestion.adapters.context import AdapterContext, CancellationSignal
from cbdc_ingestion.adapters.registry import load_registry
from cbdc_ingestion.adapters.synthetic_fx import SyntheticFxAdapter
from cbdc_ingestion.clock import ManualClock
from cbdc_ingestion.pipeline import build_envelope

from .conftest import SERVICE_ROOT, START_MS

FIXTURE = Path(__file__).parent / "fixtures" / "adapter_determinism.v1.json"
SOURCE_ID = "synthetic.fx"
STEP_MS = 500
STEPS = 12  # 0..5500 ms: three observations per pair


def adapter_events(*, start_ms: int = START_MS, seed: int = None, steps: int = STEPS) -> list:
    """Envelopes the adapter path produces, built by the service-side builder."""
    registry = load_registry()
    record = registry.record_for(SOURCE_ID)
    seed = registry.allocation_for(SOURCE_ID).seed if seed is None else seed
    clock = ManualClock(start_ms)
    adapter = SyntheticFxAdapter.for_record(record, seed)
    adapter.start(AdapterContext(source_id=SOURCE_ID, clock=clock, sink=None,
                                 cancellation=CancellationSignal()))
    events = []
    for _ in range(steps):
        for obs in adapter.produce():
            events.append(build_envelope(record, obs, seed=seed, retrieved_at_ms=clock.now_ms()))
        clock.advance_ms(STEP_MS)
    adapter.stop()
    return events


def project(events: list) -> list:
    return [{
        "pair": f"{e['payload']['base_currency']}/{e['payload']['quote_currency']}",
        "source_timestamp": e["timestamps"]["source_timestamp"],
        "rate": e["payload"]["rate"],
        "event_id": e["event_id"],
        "payload_sha256": e["payload_sha256"],
    } for e in events]


@pytest.fixture(scope="module")
def pinned() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_the_fixture_is_the_allocated_seed_and_the_shipped_start(pinned):
    assert pinned["seed"] == load_registry().allocation_for(SOURCE_ID).seed
    assert pinned["start_ms"] == START_MS and len(pinned["events"]) == 12


def test_the_adapter_reproduces_the_pinned_payloads_hashes_and_ids(pinned):
    assert project(adapter_events()) == pinned["events"]


def test_two_fresh_adapters_agree_exactly():
    assert project(adapter_events()) == project(adapter_events())


def test_the_wall_clock_plays_no_part(pinned, monkeypatch):
    import time
    monkeypatch.setattr(time, "time", lambda: 0.0)
    monkeypatch.setattr(time, "time_ns", lambda: 0)
    assert project(adapter_events()) == pinned["events"]


def test_a_different_seed_changes_rates_ids_and_hashes_but_not_the_schedule(pinned):
    other = project(adapter_events(seed=pinned["seed"] + 1))
    assert [e["source_timestamp"] for e in other] == [e["source_timestamp"] for e in pinned["events"]]
    for a, b in zip(other, pinned["events"]):
        assert a["event_id"] != b["event_id"] and a["payload_sha256"] != b["payload_sha256"]


def test_hashes_are_the_sha256_of_the_canonical_payload(pinned):
    from cbdc_ingestion.canonical import payload_sha256
    for e in adapter_events():
        assert e["payload_sha256"] == payload_sha256(e["event_type"], e["payload"])


@pytest.mark.parametrize("hashseed", ["0", "1", "4242"])
def test_a_fresh_interpreter_reproduces_the_pinned_values(pinned, hashseed):
    """A real process restart, under a different string-hash randomization each time."""
    code = "\n".join([
        "import json, sys; sys.path.insert(0, %r)" % str(SERVICE_ROOT),
        "from cbdc_ingestion.adapters.context import AdapterContext, CancellationSignal",
        "from cbdc_ingestion.adapters.registry import load_registry",
        "from cbdc_ingestion.adapters.synthetic_fx import SyntheticFxAdapter",
        "from cbdc_ingestion.clock import ManualClock",
        "from cbdc_ingestion.pipeline import build_envelope",
        "START_MS, SOURCE_ID, STEP_MS, STEPS = %d, %r, %d, %d" % (START_MS, SOURCE_ID, STEP_MS, STEPS),
        inspect.getsource(adapter_events), inspect.getsource(project),
        "print(json.dumps(project(adapter_events())))",
    ])
    env = {**os.environ, "PYTHONHASHSEED": hashseed}
    out = subprocess.run([sys.executable, "-c", code], cwd=SERVICE_ROOT, env=env,
                         capture_output=True, text=True, timeout=60, check=True)
    assert json.loads(out.stdout) == pinned["events"]
