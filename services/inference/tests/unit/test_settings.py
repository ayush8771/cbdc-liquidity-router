from pathlib import Path

import pytest
from pydantic import ValidationError

from cbdc_inference.settings import APPROVED_CHECKPOINTS_PATH, Settings


def test_defaults_match_api_contract_section_8(default_settings):
    s = default_settings
    assert s.repo_root == Path(".")
    assert s.ppo_checkpoint_id is None
    assert s.device == "cpu"
    assert s.engine_workers == 2
    assert s.engine_task_timeout_s == 10.0
    assert s.engine_max_queue == 32
    assert s.enable_cognee is False


def test_environment_overrides(monkeypatch, tmp_path):
    monkeypatch.setenv("CBDC_REPO_ROOT", str(tmp_path))
    monkeypatch.setenv("CBDC_PPO_CHECKPOINT_ID", "ckpt-a")
    monkeypatch.setenv("CBDC_DEVICE", "cuda")
    monkeypatch.setenv("CBDC_ENGINE_WORKERS", "4")
    monkeypatch.setenv("CBDC_ENGINE_TASK_TIMEOUT_S", "2.5")
    monkeypatch.setenv("CBDC_ENGINE_MAX_QUEUE", "8")
    monkeypatch.setenv("CBDC_ENABLE_COGNEE", "true")
    s = Settings()
    assert s.repo_root_resolved == tmp_path.resolve()
    assert (s.ppo_checkpoint_id, s.device, s.engine_workers) == ("ckpt-a", "cuda", 4)
    assert (s.engine_task_timeout_s, s.engine_max_queue, s.enable_cognee) == (2.5, 8, True)


def test_blank_checkpoint_id_means_unset(monkeypatch):
    monkeypatch.setenv("CBDC_PPO_CHECKPOINT_ID", "   ")
    assert Settings().ppo_checkpoint_id is None


@pytest.mark.parametrize("name,value", [
    ("CBDC_DEVICE", "mps"),
    ("CBDC_ENGINE_WORKERS", "0"),
    ("CBDC_ENGINE_TASK_TIMEOUT_S", "-1"),
    ("CBDC_ENGINE_MAX_QUEUE", "0"),
    ("CBDC_ENABLE_COGNEE", "maybe"),
])
def test_invalid_values_are_rejected(monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(ValidationError):
        Settings()


def test_settings_are_immutable(default_settings):
    with pytest.raises(ValidationError):
        default_settings.device = "cuda"


def test_registry_path_is_inside_the_service(default_settings):
    assert default_settings.approved_checkpoints_path == APPROVED_CHECKPOINTS_PATH
    assert APPROVED_CHECKPOINTS_PATH.parts[-3:] == ("inference", "config", "approved_checkpoints.json")
