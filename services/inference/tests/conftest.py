import pytest

from cbdc_inference.settings import Settings, get_settings

CBDC_ENV_VARS = ("CBDC_REPO_ROOT", "CBDC_PPO_CHECKPOINT_ID", "CBDC_DEVICE", "CBDC_ENGINE_WORKERS",
                 "CBDC_ENGINE_TASK_TIMEOUT_S", "CBDC_ENGINE_MAX_QUEUE", "CBDC_ENABLE_COGNEE")


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
