"""EnginePool (arch §6.2, §6.4): spawned workers, one task each, bounded queue,
timeout, crash / integrity recovery. Results must equal the in-process engine."""
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from cbdc_inference.engine import (ExplicitHistory, ExplicitState, ExplicitVenue, ReplayState, ScenarioState,
                                   Transaction)
from cbdc_inference.engine import errors as E
from cbdc_inference.engine import tasks
from cbdc_inference.engine.pool import EnginePool
from cbdc_inference.settings import Settings

REPO_ROOT = Path(__file__).resolve().parents[4]
TIMEOUT_S = 4.0  # shorter than the 10 s default so the suite stays fast; default checked separately
DATE = "2024-06-14"
CASES = [(Transaction("GBR", "PHL", 300000.0), ReplayState(DATE), "waterfall"),
         (Transaction("GBR", "PHL", 300000.0), ScenarioState(DATE, "cheapest_venue_outage"), "waterfall"),
         (Transaction("GBR", "PHL", 300000.0), ScenarioState(DATE, "liquidity_minus50"), "cheapest_feasible"),
         (Transaction("USA", "IND", 250000.0), ReplayState("2023-03-01"), "cheapest_feasible"),
         (Transaction("GBR", "PHL", 300000.0), ExplicitState(DATE, tuple(
             ExplicitVenue(u, l, c, ExplicitHistory(tuple([l] * 30), tuple([c] * 30)))
             for u, l, c in (("GBR->PHL#0", 90000.0, 0.4), ("GBR->PHL#1", 20000.0, 0.8),
                             ("GBR->PHL#2", 400000.0, 0.1)))), "waterfall"),
         (Transaction("GBR", "PHL", 300000.0), ExplicitState(DATE, tuple(
             ExplicitVenue(u, 250000.0, 0.5) for u in ("GBR->PHL#2", "GBR->PHL#0", "GBR->PHL#1"))),
          "cheapest_feasible"),
         (Transaction("ARE", "MEX", 90000.0), ScenarioState("2016-07-07", "congestion_x2"), "waterfall"),
         (Transaction("GBR", "PHL", 600000.0), ReplayState(DATE), "waterfall")]  # regulatory rejection


@pytest.fixture(scope="module")
def pool(phase1_unchanged):
    p = EnginePool(REPO_ROOT, workers=2, task_timeout_s=TIMEOUT_S, max_queue=32).start()
    yield p
    p.close()


@pytest.fixture(scope="module")
def reference(worker):
    return [worker.route(*c) for c in CASES]


@pytest.fixture(autouse=True)
def _healthy_between_tests(request):
    yield
    if "pool" in request.fixturenames:
        assert request.getfixturevalue("pool").wait_until_healthy(180), "pool did not recover"


def _busy_count(pool):
    return sum(1 for s in pool.health()["slots"] if s["busy"])


def _wait(cond, timeout=30.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return True
        time.sleep(0.02)
    return False


# ------------------------------------------------------------------ configuration
def test_defaults_come_from_settings():
    p = EnginePool.from_settings(Settings())
    assert (p.workers, p.task_timeout_s, p.max_queue) == (2, 10.0, 32)
    # The deadline settings of §5/§8 are covered in detail in test_deadlines.py.
    assert (p.request_deadline_s, p.min_start_budget_s, p.startup_timeout_s) == (12.0, 1.0, 180.0)


def test_invalid_configuration_rejected():
    with pytest.raises(ValueError):
        EnginePool(REPO_ROOT, workers=0)


def test_missing_artefacts_fail_startup(tmp_path):
    p = EnginePool(tmp_path, workers=1, startup_timeout_s=60)
    with pytest.raises(E.EngineNotReady):
        p.start()
    assert p.health()["engine_workers"] == "error"
    with pytest.raises(E.EngineNotReady):
        p.submit(tasks.ping_task)
    p.close()


# ------------------------------------------------------------------ normal operation
def test_health_reports_contract_block(pool):
    h = pool.health()
    assert h["engine_workers"] == "ok"
    assert set(h["engine_pool"]) == {"workers", "ready_workers", "queued", "max_queue", "rebuilds_since_start"}
    assert (h["engine_pool"]["workers"], h["engine_pool"]["max_queue"]) == (2, 32)
    assert h["engine_pool"]["ready_workers"] == 2  # both warmed up (§2.1)
    assert len({s["pid"] for s in h["slots"]}) == 2


def test_workers_are_separate_spawned_processes(pool):
    import os
    pids = {pool.ping(30)["pid"] for _ in range(6)}
    assert os.getpid() not in pids
    assert pids <= {s["pid"] for s in pool.health()["slots"]}


def test_concurrent_mixed_requests_equal_serial_reference(pool, reference):
    order = [i % len(CASES) for i in range(30)]
    with ThreadPoolExecutor(max_workers=12) as clients:
        results = list(clients.map(lambda i: pool.route(*CASES[i], wait_s=120), order))
    assert results == [reference[i] for i in order]
    for r in pool.submit(tasks.ping_task).result(30), pool.submit(tasks.ping_task).result(30):
        assert r["daily_state_sha256"] == reference[0].daily_state_sha256


def test_route_async(pool, reference):
    import asyncio

    async def go():
        return await asyncio.gather(*(pool.route_async(*c) for c in CASES))
    assert asyncio.run(go()) == reference


def test_each_worker_runs_one_task_at_a_time(pool):
    t0 = time.monotonic()
    futures = [pool.submit(tasks.fault_sleep, 1.0) for _ in range(4)]
    out = [f.result(60) for f in futures]
    elapsed = time.monotonic() - t0
    assert elapsed >= 1.9, elapsed  # 4 one-second tasks on 2 workers need two rounds
    pids = [o["pid"] for o in out]
    assert sorted(pids.count(p) for p in set(pids)) == [2, 2]


def test_engine_errors_pass_through_with_codes(pool):
    with pytest.raises(E.PolicyDisabled) as ei:
        pool.route(Transaction("GBR", "PHL", 1000.0), ReplayState(DATE), "ppo_projected", wait_s=60)
    assert (ei.value.code, ei.value.http_status, ei.value.details) == ("POLICY_DISABLED", 409, {"field": "policy"})
    before = pool.health()["engine_pool"]["rebuilds_since_start"]
    with pytest.raises(E.DateInGapBuffer):
        pool.route(Transaction("GBR", "PHL", 1000.0), ReplayState("2022-01-10"), wait_s=60)
    assert pool.health()["engine_pool"]["rebuilds_since_start"] == before  # validation errors never rebuild


# ------------------------------------------------------------------ backpressure
def test_queue_overflow_returns_engine_busy(pool):
    blockers = [pool.submit(tasks.fault_sleep, 2.5) for _ in range(2)]
    assert _wait(lambda: _busy_count(pool) == 2), "workers did not pick up the blocking tasks"
    queued = [pool.submit(tasks.ping_task) for _ in range(32)]
    assert pool.health()["engine_pool"]["queued"] == 32
    with pytest.raises(E.EngineBusy) as ei:
        pool.submit(tasks.ping_task)
    assert (ei.value.code, ei.value.http_status) == ("ENGINE_BUSY", 503)
    for f in blockers + queued:
        f.result(120)
    assert pool.health()["engine_pool"]["queued"] == 0
    pool.submit(tasks.ping_task).result(30)  # accepted again once drained


# ------------------------------------------------------------------ failures and recovery
def _rebuilds(pool):
    return pool.health()["engine_pool"]["rebuilds_since_start"]


def test_timeout_kills_and_rebuilds_only_that_worker(pool, reference):
    before = _rebuilds(pool)
    t0 = time.monotonic()
    slow = pool.submit(tasks.fault_sleep, 60)
    with pytest.raises(E.EngineTimeout) as ei:
        slow.result(60)
    assert TIMEOUT_S <= time.monotonic() - t0 < TIMEOUT_S + 10
    assert (ei.value.code, ei.value.http_status) == ("ENGINE_TIMEOUT", 504)
    assert _rebuilds(pool) == before + 1
    # the other worker keeps serving while the timed-out one is rebuilt
    assert pool.route(*CASES[1], wait_s=60) == reference[1]
    assert pool.wait_until_healthy(180)
    assert pool.route(*CASES[0], wait_s=60) == reference[0]


def test_health_reports_rebuilding_then_ok(pool):
    seen = set()
    stop = threading.Event()

    def watch():
        while not stop.is_set():
            seen.add(pool.health()["engine_workers"])
            time.sleep(0.02)
    t = threading.Thread(target=watch)
    t.start()
    try:
        with pytest.raises(E.EngineWorkerCrashed):
            pool.submit(tasks.fault_crash).result(60)
        assert pool.wait_until_healthy(180)
    finally:
        stop.set()
        t.join()
    assert {"rebuilding", "ok"} <= seen


def test_crash_returns_internal_error_and_recovers(pool, reference):
    before = _rebuilds(pool)
    with pytest.raises(E.EngineWorkerCrashed) as ei:
        pool.submit(tasks.fault_crash, 7).result(60)
    assert ei.value.code == "INTERNAL_ERROR" and ei.value.details == {"exitcode": 7}
    assert _rebuilds(pool) == before + 1
    assert pool.wait_until_healthy(180)
    assert [pool.route(*c, wait_s=60) for c in CASES] == reference


def test_failed_state_restoration_fails_closed_and_rebuilds(pool, reference):
    before = _rebuilds(pool)
    with pytest.raises(E.EngineIntegrityError) as ei:
        pool.submit(tasks.fault_corrupt_shared_state).result(60)
    assert ei.value.code == "INTERNAL_ERROR"
    assert "daily-state cache entry is not BASELINE_FRAME" in ei.value.details["problems"]
    assert _rebuilds(pool) == before + 1
    assert pool.wait_until_healthy(180)
    results = [pool.route(*c, wait_s=60) for c in CASES for _ in range(2)]  # both workers, fresh state
    assert results == [r for r in reference for _ in range(2)]


def test_unexpected_exception_does_not_rebuild(pool, reference):
    before = _rebuilds(pool)
    with pytest.raises(E.EngineError) as ei:
        pool.submit(tasks.fault_raise).result(60)
    assert type(ei.value) is E.EngineError and ei.value.code == "INTERNAL_ERROR"
    assert ei.value.message == "Unexpected internal error."  # no traceback or detail leaks
    assert _rebuilds(pool) == before
    assert pool.route(*CASES[2], wait_s=60) == reference[2]


def test_close_fails_queued_jobs():
    p = EnginePool(REPO_ROOT, workers=1, task_timeout_s=TIMEOUT_S, max_queue=4).start()
    blocker = p.submit(tasks.fault_sleep, 1.0)
    assert _wait(lambda: _busy_count(p) == 1)
    waiting = [p.submit(tasks.ping_task) for _ in range(3)]
    p.close()
    blocker.result(30)
    for f in waiting:
        with pytest.raises(E.EngineNotReady):
            f.result(30)
    with pytest.raises(E.EngineNotReady):
        p.submit(tasks.ping_task)
