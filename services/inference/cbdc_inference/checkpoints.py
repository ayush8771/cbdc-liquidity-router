"""Checkpoint approval registry and the ppo_projected gate (API contract §7, arch D2–D4).

`ppo_projected` is enabled only when CBDC_PPO_CHECKPOINT_ID names an entry in
config/approved_checkpoints.json AND the file at that entry's path has exactly
the recorded SHA-256. Raw PPO is never served (D3), so there is no gate for it.

This module only decides the gate. Loading the weights happens inside engine
workers, which must re-verify the hash themselves (contract §7).
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Optional

logger = logging.getLogger(__name__)

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
REQUIRED_FIELDS = ("checkpoint_id", "path", "sha256", "approved_by", "approved_on", "evidence")
REASON_NOT_CONFIGURED = "no approved checkpoint configured"
REASON_NOT_APPROVED = "configured checkpoint is not in the approval registry"


class RegistryError(ValueError):
    """The approval registry file is malformed."""


@dataclass(frozen=True)
class ApprovedCheckpoint:
    checkpoint_id: str
    path: str
    sha256: str
    approved_by: str
    approved_on: str
    evidence: str
    notes: str = ""


@dataclass(frozen=True)
class CheckpointGate:
    """status: 'ok' | 'disabled' | 'error' (the /v1/health `ppo_checkpoint` values)."""
    status: str
    reason: Optional[str] = None
    checkpoint: Optional[ApprovedCheckpoint] = None

    @property
    def enabled(self) -> bool:
        return self.status == "ok"


def load_registry(path: Path) -> list[ApprovedCheckpoint]:
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RegistryError(f"cannot read approval registry {path}: {exc}") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("approved"), list):
        raise RegistryError('approval registry must be an object with an "approved" list')

    entries, seen = [], set()
    for i, raw in enumerate(payload["approved"]):
        if not isinstance(raw, dict):
            raise RegistryError(f"approved[{i}] must be an object")
        missing = [k for k in REQUIRED_FIELDS if not isinstance(raw.get(k), str) or not raw[k]]
        if missing:
            raise RegistryError(f"approved[{i}] missing or empty fields: {missing}")
        if not _SHA256_RE.match(raw["sha256"]):
            raise RegistryError(f"approved[{i}].sha256 must be 64 lower-case hex characters")
        p = PurePosixPath(raw["path"])
        if p.is_absolute() or "\\" in raw["path"] or ".." in p.parts:
            raise RegistryError(f"approved[{i}].path must be a repo-relative POSIX path without '..'")
        if raw["checkpoint_id"] in seen:
            raise RegistryError(f"duplicate checkpoint_id {raw['checkpoint_id']!r}")
        seen.add(raw["checkpoint_id"])
        entries.append(ApprovedCheckpoint(**{k: raw[k] for k in REQUIRED_FIELDS}, notes=str(raw.get("notes", ""))))
    return entries


def sha256_file(path: Path, chunk_size: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(chunk_size), b""):
            h.update(block)
    return h.hexdigest()


def resolve_gate(checkpoint_id: Optional[str], registry_path: Path, repo_root: Path) -> CheckpointGate:
    """Never raises: any problem disables ppo_projected (fail closed)."""
    if not checkpoint_id:
        return CheckpointGate("disabled", REASON_NOT_CONFIGURED)
    try:
        registry = load_registry(registry_path)
    except RegistryError as exc:
        logger.error("ppo_projected disabled: %s", exc)
        return CheckpointGate("error", "approval registry is invalid")

    entry = next((e for e in registry if e.checkpoint_id == checkpoint_id), None)
    if entry is None:
        logger.warning("ppo_projected disabled: %r is not in the approval registry", checkpoint_id)
        return CheckpointGate("disabled", REASON_NOT_APPROVED)

    file_path = Path(repo_root) / entry.path
    try:
        actual = sha256_file(file_path)
    except OSError as exc:
        logger.error("ppo_projected disabled: cannot read checkpoint %s: %s", entry.checkpoint_id, exc)
        return CheckpointGate("error", "approved checkpoint file is unreadable")
    if actual != entry.sha256:
        logger.error("ppo_projected disabled: SHA-256 mismatch for %s", entry.checkpoint_id)
        return CheckpointGate("error", "approved checkpoint SHA-256 mismatch")
    return CheckpointGate("ok", None, entry)
