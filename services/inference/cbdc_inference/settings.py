"""Environment-based settings for the inference service (API contract §8).

Only the variables the contract defines for the inference service are read, all
with the `CBDC_` prefix. No `.env` file is loaded; set variables in the shell or
in Compose. No checkpoint path or ID is hard-coded here (arch D4).
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal, Optional

from pydantic import Field, PositiveFloat, PositiveInt, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

SERVICE_ROOT = Path(__file__).resolve().parents[1]  # services/inference/
APPROVED_CHECKPOINTS_PATH = SERVICE_ROOT / "config" / "approved_checkpoints.json"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CBDC_", extra="ignore", frozen=True)

    repo_root: Path = Field(default=Path("."), description="Repository root; engine workers chdir here.")
    ppo_checkpoint_id: Optional[str] = Field(default=None, description="Approval-registry entry; unset disables ppo_projected.")
    device: Literal["cpu", "cuda"] = "cpu"
    engine_workers: PositiveInt = 2
    engine_task_timeout_s: PositiveFloat = 10.0
    engine_max_queue: PositiveInt = 32
    enable_cognee: bool = False

    @field_validator("ppo_checkpoint_id", mode="before")
    @classmethod
    def _blank_is_unset(cls, v):
        if isinstance(v, str) and not v.strip():
            return None
        return v.strip() if isinstance(v, str) else v

    @property
    def repo_root_resolved(self) -> Path:
        return self.repo_root.expanduser().resolve()

    @property
    def approved_checkpoints_path(self) -> Path:
        return APPROVED_CHECKPOINTS_PATH


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide settings, read once from the environment."""
    return Settings()
