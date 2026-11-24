"""Request-scoped state never leaks into shared Phase 1 state (arch §6.2, §6.4).

In-process checks of one worker. The multi-process EnginePool tests
(timeouts, backpressure, pool rebuild) come with the pool itself.
"""
import multiprocessing as mp
import random
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import pytest

from cbdc_inference.engine import (EngineWorker, ExplicitHistory, ExplicitState, ExplicitVenue, ReplayState,
                                   ScenarioState, Transaction, init_worker, run_route)
from cbdc_inference.engine import errors as E

REPO_ROOT = Path(__file__).resolve().parents[4]
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
         (Transaction("ARE", "MEX", 90000.0), ScenarioState("2016-07-07", "congestion_x2"), "waterfall")]


def _cache_entry(p1):
    return p1.dbs._daily_df_cache.get(p1.dbs.DAILY_PARQUET_PATH)


def test_interleaved_requests_equal_serial_reference(worker, p1):
    reference = [worker.route(*c) for c in CASES]
    order = list(range(len(CASES))) * 6
    random.Random(7).shuffle(order)
    for i in order:
        assert worker.route(*CASES[i]) == reference[i]
    assert _cache_entry(p1) is worker.baseline_frame
    worker.check_integrity()


def test_scenarios_change_the_result_but_not_the_baseline(worker):
    replay = worker.route(*CASES[0])
    outage = worker.route(*CASES[1])
    assert outage.allocations[1].liquidity_usd != replay.allocations[1].liquidity_usd  # GBR->PHL#1 is fee-cheapest
    assert worker.route(*CASES[0]) == replay


def test_exception_inside_state_block_restores_cache(worker, p1, monkeypatch):
    reference = worker.route(*CASES[1])

    def boom(*a, **k):
        raise RuntimeError("injected failure")

    monkeypatch.setattr(p1.baselines, "liquidity_aware_waterfall_action", boom)
    with pytest.raises(RuntimeError, match="injected failure"):
        worker.route(*CASES[1])
    assert _cache_entry(p1) is worker.baseline_frame
    assert worker.healthy
    monkeypatch.undo()
    assert worker.route(*CASES[1]) == reference


def test_replaced_shared_cache_fails_closed(p1, monkeypatch):
    w = EngineWorker(REPO_ROOT)
    key = p1.risk_proxy.MACRO_RISK_PARQUET_PATH
    real = p1.baselines.cheapest_feasible_action

    def corrupting(*a, **k):
        monkeypatch.setitem(p1.risk_proxy._macro_risk_cache, key, w._macro_risk.copy())
        return real(*a, **k)

    monkeypatch.setattr(p1.baselines, "cheapest_feasible_action", corrupting)
    with pytest.raises(E.EngineIntegrityError) as ei:
        w.route(*CASES[3])
    assert ei.value.code == "INTERNAL_ERROR" and w.healthy is False
    with pytest.raises(E.EngineNotReady):
        w.route(*CASES[0])


def test_mutated_baseline_frame_fails_closed(p1, monkeypatch):
    key = p1.dbs.DAILY_PARQUET_PATH
    private = p1.dbs._daily_df_cache[key].copy()
    monkeypatch.setitem(p1.dbs._daily_df_cache, key, private)  # restored at teardown
    w = EngineWorker(REPO_ROOT)
    assert w.baseline_frame is private
    real = p1.baselines.liquidity_aware_waterfall_action

    def mutating(*a, **k):
        private.loc[0, "liquidity_level"] = private.loc[0, "liquidity_level"] + 1.0
        return real(*a, **k)

    monkeypatch.setattr(p1.baselines, "liquidity_aware_waterfall_action", mutating)
    with pytest.raises(E.EngineIntegrityError, match="integrity"):
        w.route(*CASES[0])
    assert w.healthy is False


def test_route_runs_in_a_spawned_worker_process(worker):
    """The pool will use spawn on every platform (arch §6.2); results must match in-process ones."""
    ctx = mp.get_context("spawn")
    with ProcessPoolExecutor(max_workers=1, mp_context=ctx, initializer=init_worker,
                             initargs=(str(REPO_ROOT),)) as pool:
        remote = [pool.submit(run_route, *c).result(timeout=120) for c in CASES]
    assert remote == [worker.route(*c) for c in CASES]
