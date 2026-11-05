"""Request deadlines, the minimum start budget and worker recycling (contract §5, §8, §9.1 A-3).

The two limits are independent:
  * the **request deadline** (`CBDC_ENGINE_REQUEST_DEADLINE_S`, 12 s) is the caller's budget.
    Expiry while QUEUED -> `503 ENGINE_BUSY`, and the task never runs, so a retry is safe.
    Expiry while RUNNING -> `504 ENGINE_TIMEOUT`, and the worker is **not** killed for it.
  * the **worker execution timeout** (`CBDC_ENGINE_TASK_TIMEOUT_S`, 10 s) is never shortened to
    the time left on the request deadline. Passing it recycles only that worker.
"""
import time
from pathlib import Path

import pytest

from cbdc_inference.engine import ReplayState, Transaction
from cbdc_inference.engine import errors as E
from cbdc_inference.engine import tasks
from cbdc_inference.engine.pool import EnginePool
from cbdc_inference.settings import Settings

REPO_ROOT = Path(__file__).resolve().parents[4]
DATE = "2024-06-14"
CASE = (Transaction("GBR", "PHL", 300000.0), ReplayState(DATE), "waterfall")
EXEC_TIMEOUT_S = 4.0  # shorter than the 10 s default so the suite stays fast


def _busy_count(pool):
    return sum(1 for s in pool.health()["slots"] if s["busy"])


def _wait(cond, timeout=30.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return True
        time.sleep(0.02)
    return False


# ------------------------------------------------------------------ configuration (§8)
def test_contract_defaults():
    """§8: 10 s execution timeout, 12 s request deadline, 1 s minimum start budget, 180 s startup."""
    p = EnginePool.from_settings(Settings())
    assert (p.task_timeout_s, p.request_deadline_s) == (10.0, 12.0)
    assert (p.min_start_budget_s, p.startup_timeout_s) == (1.0, 180.0)


@pytest.mark.parametrize("budget", [12.0, 20.0])
def test_startup_refused_when_the_budget_is_not_below_the_deadline(budget):
    """§8: the service refuses to start unless 0 <= budget < deadline, because a budget at or
    above the deadline would reject every queued request."""
    with pytest.raises(ValueError):
        Settings(engine_min_start_budget_s=budget, engine_request_deadline_s=12.0)
    with pytest.raises(ValueError):
        EnginePool(REPO_ROOT, min_start_budget_s=budget, request_deadline_s=12.0)


def test_a_zero_budget_is_allowed_and_disables_the_rule():
    assert Settings(engine_min_start_budget_s=0.0).engine_min_start_budget_s == 0.0
    assert EnginePool(REPO_ROOT, min_start_budget_s=0.0).min_start_budget_s == 0.0


# ------------------------------------------------------------------ queued expiry (A-3)
@pytest.fixture(scope="module")
def pool(phase1_unchanged):
    p = EnginePool(REPO_ROOT, workers=1, task_timeout_s=EXEC_TIMEOUT_S, max_queue=32).start()
    yield p
    p.close()


@pytest.fixture(autouse=True)
def _healthy_between_tests(request):
    yield
    if "pool" in request.fixturenames:
        assert request.getfixturevalue("pool").wait_until_healthy(180), "pool did not recover"


def test_deadline_expiring_while_queued_is_engine_busy_and_never_runs(pool):
    """A-3: the task is removed without running, so a retry is safe.

    `tasks_run` counts the routing tasks the worker actually executed, so an unchanged counter
    across an expired `route_task` proves it never ran.
    """
    before = pool.ping(30)["tasks_run"]
    blocker = pool.submit(tasks.fault_sleep, 3.0)
    assert _wait(lambda: _busy_count(pool) == 1), "the worker did not pick up the blocking task"
    # The deadline is above the 1 s start budget, so it is not an under-budget refusal: it is
    # genuinely longer than the budget at submission and still expires before the only worker
    # frees up, three seconds later.
    queued = pool.submit(tasks.route_task, *CASE, deadline_s=1.5)
    with pytest.raises(E.EngineBusy) as ei:
        queued.result(30)
    assert (ei.value.code, ei.value.http_status) == ("ENGINE_BUSY", 503)
    assert ei.value.details == {"deadline_expired_while": "queued"}
    blocker.result(60)
    assert pool.ping(30)["tasks_run"] == before, "the expired task must never have executed"


def test_under_the_minimum_start_budget_the_task_is_not_dispatched(pool):
    """§5 A2: a worker takes a queued task only if at least the budget is left on the deadline.
    A task dispatched with almost no time left would be certain to time out while holding a
    worker, so it gets ENGINE_BUSY instead and never runs."""
    before = pool.ping(30)["tasks_run"]
    # The deadline has NOT expired, but less than the 1 s budget remains.
    with pytest.raises(E.EngineBusy) as ei:
        pool.submit(tasks.route_task, *CASE, deadline_s=0.4).result(30)
    assert ei.value.details == {"deadline_expired_while": "queued"}
    assert pool.ping(30)["tasks_run"] == before, "an under-budget task must never be dispatched"


def test_a_zero_budget_dispatches_a_task_with_almost_no_time_left():
    """With a budget of 0 the behaviour is exactly the plain queued-expiry rule (§5)."""
    p = EnginePool(REPO_ROOT, workers=1, task_timeout_s=EXEC_TIMEOUT_S, min_start_budget_s=0.0).start()
    try:
        assert p.wait_until_healthy(240)
        before = p.ping(60)["tasks_run"]
        # 0.9 s is below the default 1 s budget but above zero, so the task IS dispatched.
        assert p.submit(tasks.route_task, *CASE, deadline_s=0.9).result(30).executed_usd > 0
        assert p.ping(60)["tasks_run"] == before + 1
    finally:
        p.close()


# ------------------------------------------------------------------ running expiry (A-3)
def test_deadline_expiring_while_running_times_out_without_killing_the_worker(pool):
    """A-3: the request gets 504 ENGINE_TIMEOUT, but the worker is NOT killed for the caller's
    deadline: the task runs on, its result is discarded, and the worker takes the next task."""
    before_rebuilds = pool.health()["engine_pool"]["rebuilds_since_start"]
    pid_before = pool.ping(30)["pid"]
    # The task runs for 2 s, inside the 4 s execution timeout, but its deadline is 0.5 s, so the
    # deadline expires while it is RUNNING.
    slow = pool.submit(tasks.fault_sleep, 2.0, deadline_s=1.2)
    with pytest.raises(E.EngineTimeout) as ei:
        slow.result(30)
    assert (ei.value.code, ei.value.http_status) == ("ENGINE_TIMEOUT", 504)
    assert ei.value.details == {"deadline_expired_while": "running"}
    # No recycling, and the same process is still serving.
    assert pool.health()["engine_pool"]["rebuilds_since_start"] == before_rebuilds
    assert pool.ping(60)["pid"] == pid_before
    assert pool.route(*CASE, wait_s=60).executed_usd > 0


def test_the_execution_timeout_is_not_shortened_to_the_request_deadline(pool):
    """§5: the worker's 10 s execution timeout is counted from when the task starts and is
    never shortened. A task whose caller already gave up keeps running until the EXECUTION
    timeout, and only then is its worker recycled."""
    before = pool.health()["engine_pool"]["rebuilds_since_start"]
    # Runs far past both limits, but the caller's deadline expires first. The deadline must stay
    # ABOVE the 1 s minimum start budget, or the task would be refused before it ever started.
    slow = pool.submit(tasks.fault_sleep, 60, deadline_s=1.5)
    with pytest.raises(E.EngineTimeout):
        slow.result(30)
    # The caller's expiry did not recycle anything...
    assert pool.health()["engine_pool"]["rebuilds_since_start"] == before
    # ...but passing the execution timeout does recycle that one worker.
    assert _wait(lambda: pool.health()["engine_pool"]["rebuilds_since_start"] == before + 1, timeout=60)
    assert pool.wait_until_healthy(180)


def test_execution_timeout_recycles_only_that_worker():
    """A-3: a task past the execution timeout terminates and replaces ITS worker; the others
    keep serving."""
    p = EnginePool(REPO_ROOT, workers=2, task_timeout_s=EXEC_TIMEOUT_S).start()
    try:
        assert p.wait_until_healthy(180)
        pids_before = {s["pid"] for s in p.health()["slots"]}
        with pytest.raises(E.EngineTimeout):
            p.submit(tasks.fault_sleep, 60).result(60)
        # Another worker answers while the stuck one is replaced.
        assert p.route(*CASE, wait_s=120).executed_usd > 0
        assert p.wait_until_healthy(180)
        pids_after = {s["pid"] for s in p.health()["slots"]}
        assert len(pids_after - pids_before) == 1, "exactly one worker should have been replaced"
        assert len(pids_after & pids_before) == 1, "the other worker should have been kept"
    finally:
        p.close()


# ------------------------------------------------------------------ readiness (A-4, A-6)
def test_ready_workers_counts_only_warmed_up_workers():
    """A-6: `ready_workers` is the number of workers that can take a task. Before any has
    warmed up it is 0 and the pool is not ready (A-4)."""
    p = EnginePool(REPO_ROOT, workers=2)
    block = p.health()
    assert block["engine_pool"]["workers"] == 2
    assert block["engine_pool"]["ready_workers"] == 0  # not started yet
    p.start(wait=False)
    try:
        assert _wait(lambda: p.health()["engine_pool"]["ready_workers"] == 2, timeout=240)
        assert p.health()["engine_workers"] == "ok"
    finally:
        p.close()
