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
from pathlib import PurePosixPath


def route_task(worker, transaction, state, policy):
    return worker.route(transaction, state, policy)


def compare_task(worker, transaction, state, policies):
    """POST /v1/compare: every policy in ONE task on one state frame (§2.9)."""
    return worker.compare(transaction, state, policies)


def explain_task(worker, transaction, state, policy):
    """POST /v1/explain: recomputes the decision and explains it (§2.10)."""
    return worker.explain(transaction, state, policy)


def ping_task(worker):
    return {"pid": os.getpid(), "tasks_run": worker.tasks_run, "daily_state_sha256": worker.daily_state_sha256}


def metadata_task(worker):
    """Static engine metadata for /v1/version, read from the Phase 1 objects the worker loaded."""
    p = worker._p
    start = min(b[0] for b in p.split.SPLIT_BOUNDARIES.values())
    end = max(b[1] for b in p.split.SPLIT_BOUNDARIES.values())
    return {
        "knowledge_version": worker.knowledge.knowledge_version,
        # The six `decision_id` artefact fingerprints, computed by the worker, so the values
        # /v1/version reports are exactly the ones decision_id hashes (§2.2, §2.11). Note that
        # `knowledge_sha256` here is the Phase 2 SERVICE hash (CRLF->LF normalised), which on a
        # Windows CRLF checkout differs from Phase 1's raw-byte KnowledgeBase.sha256.
        "artefacts": dict(worker.artefacts),
        "daily_state_sha256": worker.daily_state_sha256,
        "scenarios_sha256": worker.scenarios_fingerprint(),
        "date_range": {"start": start.date().isoformat(), "end": end.date().isoformat()},
        "reward_weights": dict(worker.reward_weights),
        "torch": p.torch.__version__,
        # The checkpoint this worker actually verified and will serve, or None (§2.2, §7).
        "checkpoint": None if worker.checkpoint is None else {
            "checkpoint_id": worker.checkpoint.checkpoint_id,
            "sha256": worker.checkpoint.sha256,
            "approved_by": worker.checkpoint.approved_by,
            "approved_on": worker.checkpoint.approved_on,
            "source_run": str(PurePosixPath(worker.checkpoint.path).parent),
        },
        "ppo_enabled": bool(worker.ppo_enabled),
        # answered by the FastAPI process from startup metadata (contract §2): /v1/replay/calendar, /v1/scenarios
        "replay_calendar": worker.replay_calendar(),
        "scenarios": worker.scenario_list(),
    }


def network_task(worker):
    return worker.network()


def state_task(worker, corridor, state, include_history):
    return worker.state_view(corridor, state, include_history)


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
