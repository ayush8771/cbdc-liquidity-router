"""Shared fixtures. No network, no file writing, no real sleeping.

Every timing test drives a `ManualClock`, so the suite is deterministic and runs
in well under a second: the generator's 2 s interval and 500 ms stagger are
checked by advancing the clock, never by waiting (AD-1 §3.7, "threshold and
timer tests use fake clocks").
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from cbdc_ingestion.clock import ManualClock
from cbdc_ingestion.generator import FxGenerator
from cbdc_ingestion.service import IngestionService

SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = SERVICE_ROOT.parents[1]
CONTRACTS = REPO_ROOT / "contracts"

# A fixed, readable start moment for every timestamp in the suite.
START_MS = 1764028800000  # 2025-11-25T00:00:00.000Z
SEED = 20261125


@pytest.fixture
def clock() -> ManualClock:
    return ManualClock(START_MS)


@pytest.fixture
def generator(clock: ManualClock) -> FxGenerator:
    return FxGenerator(SEED, clock, start_ms=START_MS)


@pytest.fixture
def service(clock: ManualClock) -> IngestionService:
    """A started service on the manual clock. Its generator thread is running, so
    `ready` is true, but it produces nothing until the clock is advanced and
    `tick()` is called, which keeps the tests free of races."""
    svc = IngestionService(SEED, clock=clock, start_ms=START_MS)
    svc.start(run_loop=False)
    try:
        yield svc
    finally:
        svc.stop()


@pytest.fixture(scope="session")
def envelope_schema() -> dict:
    return json.loads((CONTRACTS / "events" / "event-envelope.v1.schema.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def latest_schema() -> dict:
    return json.loads((CONTRACTS / "events" / "ingestion-latest.v1.schema.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def hash_vectors() -> dict:
    return json.loads((CONTRACTS / "test-vectors" / "event_payload_hash.v1.json").read_text(encoding="utf-8"))
