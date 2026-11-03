import hashlib
from pathlib import Path

import pytest

from cbdc_inference.settings import Settings, get_settings

CBDC_ENV_VARS = ("CBDC_REPO_ROOT", "CBDC_PPO_CHECKPOINT_ID", "CBDC_DEVICE", "CBDC_ENGINE_WORKERS",
                 "CBDC_ENGINE_TASK_TIMEOUT_S", "CBDC_ENGINE_MAX_QUEUE", "CBDC_ENABLE_COGNEE")

SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = SERVICE_ROOT.parents[1]
PHASE1_WATCHED = ("src", "data/structured", "data/processed", "data/knowledge")


@pytest.fixture(autouse=True)
def clean_cbdc_env(monkeypatch):
    """Every test starts from contract defaults, whatever the developer's shell has set."""
    for name in CBDC_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def default_settings() -> Settings:
    return Settings()


@pytest.fixture
def repo_settings() -> Settings:
    """Contract defaults, but pointing at this repository regardless of the current directory."""
    return Settings(repo_root=REPO_ROOT)


FAKE_ENGINE_METADATA = {
    "knowledge_version": "kv-test", "knowledge_sha256": "a" * 64, "daily_state_sha256": "b" * 64,
    "date_range": {"start": "2011-01-01", "end": "2025-09-30"},
    "reward_weights": {"lambda_latency": 1.0, "lambda_risk": 1.0, "lambda_unrouted": 1.0, "status": "placeholder"},
    "torch": "2.13.0+cpu",
    "replay_calendar": {"start": "2011-01-01", "end": "2025-09-30", "splits": {}, "gap_buffer_days": 30,
                        "excluded_ranges": [], "note": "fake"},
    "scenarios": {"scenarios": [], "note": "fake"},
}


class FakePool:
    """Stand-in for EnginePool in API tests: no processes, health set directly."""

    def __init__(self, slot_states=("ready", "ready"), engine_workers="ok", rebuilds=0, queued=0,
                 metadata=FAKE_ENGINE_METADATA, submit_error=None, results=None):
        self.slot_states, self.engine_workers = list(slot_states), engine_workers
        self.rebuilds, self.queued, self.metadata, self.submit_error = rebuilds, queued, metadata, submit_error
        self.results = results or {}  # task function name -> return value, or an exception to raise from the task
        self.calls = []
        self.started = self.closed = False

    def start(self, wait=True):
        self.started = True
        return self

    def close(self):
        self.closed = True

    def submit(self, fn, *args):
        from concurrent.futures import Future
        if self.submit_error is not None:
            raise self.submit_error
        self.calls.append((fn.__name__, args))
        f = Future()
        if fn.__name__ == "metadata_task":
            f.set_result(self.metadata)
            return f
        outcome = self.results.get(fn.__name__)
        if callable(outcome) and not isinstance(outcome, BaseException):
            try:  # e.g. an in-process EngineWorker method, so tests use real engine output
                outcome = outcome(*args)
            except BaseException as exc:  # noqa: BLE001
                outcome = exc
        if isinstance(outcome, BaseException):
            f.set_exception(outcome)
        else:
            f.set_result(outcome)
        return f

    def health(self):
        return {"engine_workers": self.engine_workers,
                "engine_pool": {"workers": len(self.slot_states), "queued": self.queued, "max_queue": 32,
                                "rebuilds_since_start": self.rebuilds},
                "slots": [{"index": i, "state": s, "busy": False, "pid": None} for i, s in enumerate(self.slot_states)]}


@pytest.fixture
def fake_pool_factory():
    """Returns make(**FakePool kwargs) -> (pool, factory_for_create_app)."""
    def make(**kw):
        pool = FakePool(**kw)
        return pool, (lambda settings: pool)
    return make


def _phase1_hashes() -> dict:
    out = {}
    for rel in PHASE1_WATCHED:
        for f in sorted((REPO_ROOT / rel).rglob("*")):
            if f.is_file() and "__pycache__" not in f.parts:
                out[str(f.relative_to(REPO_ROOT))] = hashlib.sha256(f.read_bytes()).hexdigest()
    return out


@pytest.fixture(scope="session")
def phase1_unchanged():
    """Contract §9: no Phase 1 file changes. Hashes src/ and the read data folders before and after."""
    before = _phase1_hashes()
    yield
    after = _phase1_hashes()
    changed = sorted(k for k in before.keys() | after.keys() if before.get(k) != after.get(k))
    assert not changed, f"Phase 1 files changed during the engine tests: {changed}"


@pytest.fixture(scope="session")
def worker(phase1_unchanged):
    """One in-process EngineWorker for the session (constructing it chdirs to the repo root)."""
    from cbdc_inference.engine import EngineWorker
    return EngineWorker(REPO_ROOT)


@pytest.fixture(scope="session")
def p1(worker):
    """The Phase 1 modules the worker imported (same objects, so same process-wide caches)."""
    return worker._p
