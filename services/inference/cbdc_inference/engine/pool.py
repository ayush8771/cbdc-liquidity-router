"""EnginePool: isolated engine worker processes (arch §6.2, §6.4).

Design
------
* N worker slots (CBDC_ENGINE_WORKERS, default 2). Each slot owns ONE process
  started with the **spawn** context on every platform, plus one parent-side
  thread that feeds it. A slot sends its process one task and waits for the
  reply before taking the next, so each process handles one request at a time
  and processes share no memory.
* One bounded FIFO queue (CBDC_ENGINE_MAX_QUEUE, default 32) holds tasks that
  are waiting for a free worker. When it is full, `submit` raises ENGINE_BUSY
  immediately; nothing queues without limit.
* Per-task timeout (CBDC_ENGINE_TASK_TIMEOUT_S, default 10 s), measured from the
  moment the task is handed to a worker (time waiting in the queue is not
  counted). On timeout the task fails with ENGINE_TIMEOUT and that worker
  process is terminated and rebuilt.
* A worker is also rebuilt when its process crashes (no reply) or when it
  reports a failed integrity check (shared Phase 1 state not restored). Either
  way the task gets an INTERNAL_ERROR with no result. Other slots keep serving.
* Health (`health()`) reports `engine_workers` = ok | rebuilding | error and the
  contract's `engine_pool` block {workers, queued, max_queue, rebuilds_since_start}.

Why not `concurrent.futures.ProcessPoolExecutor`: a running task cannot be
cancelled (arch §6.2 step 6), and terminating one of its processes needs private
API and breaks the whole executor. One process per slot lets a timeout kill only
the stuck worker, measured from when its task started.

This module imports no FastAPI and no Phase 1 code (Phase 1 is loaded inside
the child processes by EngineWorker).
"""
from __future__ import annotations

import asyncio
import logging
import multiprocessing as mp
import os
import queue
import threading
import time
import traceback
from concurrent.futures import Future
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

from .errors import (EngineBusy, EngineError, EngineIntegrityError, EngineNotReady, EngineTimeout,
                     EngineWorkerCrashed, rebuild_error)
from .tasks import ping_task, route_task

logger = logging.getLogger(__name__)

_CTX = mp.get_context("spawn")


# ---------------------------------------------------------------------- child process
def _child_main(conn, repo_root: str) -> None:
    """Engine worker process: initialise once, then serve tasks one at a time."""
    try:
        from .worker import EngineWorker
        worker = EngineWorker(repo_root)
    except EngineError as e:
        conn.send(("init_error", type(e).__name__, e.message, e.details))
        return
    except Exception as e:  # noqa: BLE001
        conn.send(("init_error", "EngineNotReady", f"engine worker failed to initialise: {e!r}", {}))
        return
    conn.send(("ready", {"pid": os.getpid()}))

    while True:
        try:
            item = conn.recv()
        except (EOFError, OSError):
            return
        if item is None:
            return
        fn, args = item
        try:
            result = fn(worker, *args)
            worker.check_integrity()  # fail closed after every task, not only route()
            reply = ("ok", result)
        except EngineError as e:
            reply = ("err", type(e).__name__, e.message, e.details)
        except Exception:  # noqa: BLE001 - never let an unexpected error kill the loop silently
            traceback.print_exc()
            try:
                worker.check_integrity()
                reply = ("err", "EngineError", "Unexpected internal error.", {})
            except EngineIntegrityError as ie:
                reply = ("err", "EngineIntegrityError", ie.message, ie.details)
        try:
            conn.send(reply)
        except Exception:  # noqa: BLE001 - e.g. an unpicklable result
            traceback.print_exc()
            conn.send(("err", "EngineError", "Unexpected internal error.", {}))


# ---------------------------------------------------------------------- parent side
@dataclass
class _Job:
    fn: Callable
    args: tuple
    future: Future = field(default_factory=Future)


class _Slot:
    STARTING, READY, REBUILDING, ERROR, STOPPED = "starting", "ready", "rebuilding", "error", "stopped"

    def __init__(self, pool: "EnginePool", index: int):
        self.pool, self.index = pool, index
        self.state = self.STARTING
        self.busy = False
        self.pid: Optional[int] = None
        self.last_error: Optional[str] = None
        self.proc = None
        self.conn = None
        self.first_attempt_done = threading.Event()
        self.thread = threading.Thread(target=self._run, name=f"engine-slot-{index}", daemon=True)

    # -- process lifecycle
    def _spawn(self) -> None:
        parent, child = _CTX.Pipe(duplex=True)
        proc = _CTX.Process(target=_child_main, args=(child, str(self.pool.repo_root)),
                            name=f"cbdc-engine-{self.index}", daemon=True)
        proc.start()
        child.close()
        try:
            if not parent.poll(self.pool.startup_timeout_s):
                raise EngineNotReady(f"engine worker {self.index} did not become ready in time")
            msg = parent.recv()
        except (EOFError, OSError):
            msg = ("init_error", "EngineNotReady", "engine worker exited during initialisation", {})
        except EngineError:
            self._kill(proc, parent)
            raise
        if msg[0] != "ready":
            self._kill(proc, parent)
            raise rebuild_error(msg[1], msg[2], msg[3])
        self.proc, self.conn, self.pid = proc, parent, msg[1]["pid"]

    @staticmethod
    def _kill(proc, conn) -> None:
        try:
            if proc is not None and proc.is_alive():
                proc.terminate()
                proc.join(5)
                if proc.is_alive():
                    proc.kill()
                    proc.join(5)
        finally:
            if conn is not None:
                conn.close()

    def _start_with_retry(self, rebuilding: bool) -> bool:
        delay = 1.0
        while not self.pool._stop.is_set():
            self.state = self.REBUILDING if rebuilding else self.STARTING
            try:
                self._spawn()
                self.state, self.last_error = self.READY, None
                return True
            except EngineError as e:
                self.state, self.last_error = self.ERROR, e.message
                logger.error("engine worker %d failed to start: %s", self.index, e.message)
            finally:
                self.first_attempt_done.set()
            self.pool._stop.wait(delay)
            delay = min(delay * 2, 30.0)
        return False

    def _mark_rebuilding(self) -> None:
        """Called BEFORE the failed task's future is resolved, so callers never see the
        error while health still says ok."""
        self.state = self.REBUILDING
        with self.pool._lock:
            self.pool._rebuilds += 1

    def _rebuild(self, reason: str) -> bool:
        logger.warning("rebuilding engine worker %d (pid %s): %s", self.index, self.pid, reason)
        self._kill(self.proc, self.conn)
        self.proc = self.conn = self.pid = None
        return self._start_with_retry(rebuilding=True)

    # -- task loop
    def _run(self) -> None:
        if not self._start_with_retry(rebuilding=False):
            self.state = self.STOPPED
            return
        while not self.pool._stop.is_set():
            try:
                job = self.pool._queue.get(timeout=0.2)
            except queue.Empty:
                continue
            if not job.future.set_running_or_notify_cancel():
                continue  # caller gave up while it was queued
            self.busy = True
            try:
                rebuild_reason = self._execute(job)
            finally:
                self.busy = False
            if rebuild_reason and not self._rebuild(rebuild_reason):
                break
        self.state = self.STOPPED
        self._shutdown_process()

    def _execute(self, job: _Job) -> Optional[str]:
        """Runs one job. Returns a reason string if the worker must be rebuilt."""
        timeout = self.pool.task_timeout_s
        try:
            self.conn.send((job.fn, job.args))
            if not self.conn.poll(timeout):
                self._mark_rebuilding()
                job.future.set_exception(EngineTimeout(
                    f"engine task exceeded {timeout:g} s", {"timeout_s": timeout}))
                return "task timeout"
            msg = self.conn.recv()
        except (EOFError, OSError, BrokenPipeError):
            if self.proc is not None:
                self.proc.join(5)  # collect the exit code of the dead process
            code = self.proc.exitcode if self.proc is not None else None
            self._mark_rebuilding()
            job.future.set_exception(EngineWorkerCrashed("engine worker process crashed; no result returned",
                                                         {"exitcode": code}))
            return f"worker crashed (exitcode {code})"
        if msg[0] == "ok":
            job.future.set_result(msg[1])
            return None
        error = rebuild_error(msg[1], msg[2], msg[3])
        if isinstance(error, EngineIntegrityError):
            self._mark_rebuilding()
            job.future.set_exception(error)
            return "integrity check failed"
        job.future.set_exception(error)
        return None

    def _shutdown_process(self) -> None:
        if self.conn is not None:
            try:
                self.conn.send(None)
            except Exception:  # noqa: BLE001
                pass
        if self.proc is not None:
            self.proc.join(2)
        self._kill(self.proc, self.conn)
        self.proc = self.conn = None


class EnginePool:
    def __init__(self, repo_root, workers: int = 2, task_timeout_s: float = 10.0, max_queue: int = 32,
                 startup_timeout_s: float = 180.0):
        if workers < 1 or max_queue < 1 or task_timeout_s <= 0:
            raise ValueError("workers and max_queue must be >= 1 and task_timeout_s > 0")
        self.repo_root = Path(repo_root).expanduser().resolve()
        self.workers, self.task_timeout_s, self.max_queue = workers, float(task_timeout_s), max_queue
        self.startup_timeout_s = float(startup_timeout_s)
        self._queue: "queue.Queue[_Job]" = queue.Queue(maxsize=max_queue)
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._rebuilds = 0
        self._slots: list = []
        self._started = False

    @classmethod
    def from_settings(cls, settings, **overrides) -> "EnginePool":
        kw = dict(repo_root=settings.repo_root_resolved, workers=settings.engine_workers,
                  task_timeout_s=settings.engine_task_timeout_s, max_queue=settings.engine_max_queue)
        kw.update(overrides)
        return cls(**kw)

    # -- lifecycle
    def start(self, wait: bool = True) -> "EnginePool":
        if self._started:
            return self
        self._started = True
        self._slots = [_Slot(self, i) for i in range(self.workers)]
        for s in self._slots:
            s.thread.start()
        if wait:
            for s in self._slots:
                s.first_attempt_done.wait()
            if not any(s.state == _Slot.READY for s in self._slots):
                errors = sorted({s.last_error for s in self._slots if s.last_error})
                raise EngineNotReady("no engine worker could start", {"errors": errors})
        return self

    def close(self) -> None:
        self._stop.set()
        for s in self._slots:
            s.thread.join(15)
        while True:  # fail anything still queued
            try:
                job = self._queue.get_nowait()
            except queue.Empty:
                break
            if job.future.set_running_or_notify_cancel():
                job.future.set_exception(EngineNotReady("engine pool is shutting down"))

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.close()

    # -- submission
    def submit(self, fn: Callable, *args: Any) -> Future:
        if not self._started or self._stop.is_set():
            raise EngineNotReady("engine pool is not running")
        if all(s.state in (_Slot.ERROR, _Slot.STOPPED) for s in self._slots):
            raise EngineNotReady("no engine worker is available")
        job = _Job(fn, args)
        try:
            self._queue.put_nowait(job)
        except queue.Full:
            raise EngineBusy(f"engine queue is full ({self.max_queue} waiting)",
                             {"max_queue": self.max_queue}) from None
        return job.future

    def route(self, transaction, state, policy=None, wait_s: Optional[float] = None):
        """Blocking route via a worker. Raises the engine error the worker raised."""
        return self.submit(route_task, transaction, state, policy).result(timeout=wait_s)

    async def route_async(self, transaction, state, policy=None):
        return await asyncio.wrap_future(self.submit(route_task, transaction, state, policy))

    def ping(self, wait_s: Optional[float] = None):
        return self.submit(ping_task).result(timeout=wait_s)

    # -- observability
    def health(self) -> dict:
        states = [s.state for s in self._slots]
        if not self._started or self._stop.is_set():
            status = "error"
        elif _Slot.ERROR in states or _Slot.STOPPED in states:
            status = "error"
        elif _Slot.REBUILDING in states or _Slot.STARTING in states:
            status = "rebuilding"
        else:
            status = "ok"
        with self._lock:
            rebuilds = self._rebuilds
        return {
            "engine_workers": status,
            "engine_pool": {"workers": self.workers, "queued": self._queue.qsize(), "max_queue": self.max_queue,
                            "rebuilds_since_start": rebuilds},
            "slots": [{"index": s.index, "state": s.state, "busy": s.busy, "pid": s.pid} for s in self._slots],
        }

    def wait_until_healthy(self, timeout_s: float = 180.0) -> bool:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if self.health()["engine_workers"] == "ok":
                return True
            time.sleep(0.1)
        return False
