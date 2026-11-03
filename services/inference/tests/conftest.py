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
