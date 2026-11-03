"""Task functions executed inside engine worker processes.

Each task is a module-level function `fn(worker, *args)` so it can be sent by
reference to a spawned process. The API layer only ever submits `route_task`
and `ping_task`.

The `fault_*` functions exist for the pool's fault-injection tests (arch §6.4)
and are never reachable from the HTTP API.
"""
from __future__ import annotations

import os
import time


def route_task(worker, transaction, state, policy):
    return worker.route(transaction, state, policy)


def ping_task(worker):
    return {"pid": os.getpid(), "tasks_run": worker.tasks_run, "daily_state_sha256": worker.daily_state_sha256}


# ---------------------------------------------------------------- fault injection (tests only)
def fault_sleep(worker, seconds: float):
    time.sleep(seconds)
    return {"pid": os.getpid(), "slept": seconds}


def fault_crash(worker, exit_code: int = 3):
    os._exit(exit_code)  # simulates a hard crash: no reply, no cleanup


def fault_corrupt_shared_state(worker):
    """Replaces the shared daily-state cache entry outside any injected-state block."""
    dbs = worker._p.dbs
    dbs._daily_df_cache[dbs.DAILY_PARQUET_PATH] = worker.baseline_frame.copy()
    return "corrupted"


def fault_raise(worker, message: str = "injected failure"):
    raise RuntimeError(message)
