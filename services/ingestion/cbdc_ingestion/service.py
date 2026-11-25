"""The ingestion service: lifecycle, the generator loop and the response body.

One `IngestionService` owns a seeded `FxGenerator`, a bounded `LatestStore` and
the background thread that moves events from one to the other. It is separate
from the HTTP layer (`http_api.py`) so that every rule can be tested without a
socket, and so that the HTTP layer holds no state of its own.

Lifecycle (AD-1 §3.1): `starting` before the loop runs, `running` once it does,
then `stopping` and `stopped`. `GET /v1/latest` answers `503 NOT_READY` unless
the state is `running`. `running` says nothing about whether any event exists
yet: before the first one the endpoint answers `200` with `events: []`, which
AD-1 §3.1 requires in place of `204` or `404`.

`instance_id` is a fresh UUID at each start (AD-1 §3.1) and is **diagnostic
only**: AD-1 §3.4 says consumers order by `source_timestamp` and that an
ingestion restart needs no reset, so nothing may key state on it.
"""
from __future__ import annotations

import logging
import threading
import uuid
from typing import Optional

from . import PROTOCOL_VERSION, SOURCE_ID
from .clock import Clock, SystemClock, format_timestamp
from .generator import FxGenerator
from .store import LatestStore

logger = logging.getLogger(__name__)

# How long the loop sleeps when nothing is due. Short enough that the 500 ms
# stagger is honoured, long enough that an idle process is not a busy loop.
LOOP_TICK_S = 0.05

# One log line at most per this many seconds, per reason (AD-1 §3.4's
# "rate-limited logs"). A fault that repeats every tick must not fill a disk.
LOG_INTERVAL_MS = 10_000

STATES = ("starting", "running", "stopping", "stopped")


class IngestionService:
    """The component's state and its generator thread."""

    def __init__(self, seed: int, *, clock: Optional[Clock] = None, case_id: str = "normal",
                 start_ms: Optional[int] = None) -> None:
        self.clock: Clock = clock or SystemClock()
        self.instance_id = str(uuid.uuid4())
        self.store = LatestStore()
        self.generator = FxGenerator(seed, self.clock, start_ms=start_ms, case_id=case_id)
        self._state = "starting"
        self._state_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._last_log_ms: dict = {}

    # ---------------------------------------------------------------- lifecycle
    @property
    def state(self) -> str:
        with self._state_lock:
            return self._state

    def _set_state(self, value: str) -> None:
        assert value in STATES
        with self._state_lock:
            self._state = value

    @property
    def ready(self) -> bool:
        """Whether `GET /v1/latest` may answer 200 (AD-1 §3.1)."""
        return self.state == "running"

    def start(self, run_loop: bool = True) -> "IngestionService":
        """Marks the service running and starts the generator thread. Idempotent.

        `run_loop=False` marks it running **without** the background thread, so a
        caller drives time itself with `tick(now_ms)` on a `ManualClock`. The tests
        use it: a background loop ticking against the same manual clock would race
        with the test's own ticks and make the empty state unobservable.
        """
        if self._thread is not None or self.state == "running":
            return self
        if not run_loop:
            self._set_state("running")
            return self
        self._thread = threading.Thread(target=self._loop, name="fx-generator", daemon=True)
        self._set_state("running")
        self._thread.start()
        logger.info("ingestion started: instance_id=%s source_id=%s seed=%d (synthetic, display-only)",
                    self.instance_id, SOURCE_ID, self.generator.seed)
        return self

    def stop(self, timeout_s: float = 2.0) -> None:
        """Stops the generator thread and leaves the service unready. Idempotent."""
        if self.state in ("stopping", "stopped") and self._thread is None:
            return
        self._set_state("stopping")
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=timeout_s)
        self._set_state("stopped")
        logger.info("ingestion stopped: %s", self.store.counters())

    def __enter__(self) -> "IngestionService":
        return self.start()

    def __exit__(self, *exc) -> None:
        self.stop()

    # ------------------------------------------------------------------ the loop
    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception:  # noqa: BLE001 - the loop must outlive one bad tick
                # No payload and no envelope is logged: only the traceback of a defect
                # in this component, which has no external input to leak.
                logger.exception("generator tick failed; continuing")
            self._stop.wait(LOOP_TICK_S)

    def tick(self, now_ms: Optional[int] = None) -> int:
        """Applies every event due now. Returns how many became current.

        Called by the loop, and directly by tests with a `ManualClock`, so no test
        of the acceptance or ordering rules needs a real wait.
        """
        applied = 0
        for event in self.generator.due(now_ms):
            if self.store.apply(event):
                applied += 1
            else:
                self._log_withheld(event)
        return applied

    def _log_withheld(self, event: dict) -> None:
        """Rate-limited diagnostics for an event that did not become current.

        AD-1 §3.4 allows the reason and, when the event is well formed, the
        `event_id`. Nothing else: no payload, no rate, no timestamps.
        """
        status = event.get("validation", {}).get("status")
        reasons = event.get("validation", {}).get("reasons") or []
        reason = ",".join(reasons) if status == "quarantined" else "not_current"
        now_ms = self.clock.now_ms()
        if now_ms - self._last_log_ms.get(reason, -LOG_INTERVAL_MS) < LOG_INTERVAL_MS:
            return
        self._last_log_ms[reason] = now_ms
        event_id = event.get("event_id") if isinstance(event.get("event_id"), str) else None
        logger.warning("event withheld: reason=%s event_id=%s", reason, event_id)

    # --------------------------------------------------------------- the payload
    def latest_response(self) -> dict:
        """The `GET /v1/latest` 200 body (AD-1 §3.1). A closed shape, all fields required."""
        return {
            "protocol_version": PROTOCOL_VERSION,
            "instance_id": self.instance_id,
            "source_id": SOURCE_ID,
            "generated_at": format_timestamp(self.clock.now_ms()),
            "events": self.store.events(),
        }
