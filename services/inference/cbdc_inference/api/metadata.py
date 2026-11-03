"""Startup metadata for /v1/health and /v1/version, computed in the FastAPI process
WITHOUT importing Phase 1 (arch §5.1): file checks, file hashes and git commit.

Values that need Phase 1 objects (knowledge version, daily-state fingerprint,
reward weights, torch version) come from an engine worker via `metadata_task`.
"""
from __future__ import annotations

import hashlib
import json
import platform
import subprocess
import sys
from pathlib import Path
from typing import Optional

STRUCTURED_FILES = ("data/structured/countries.csv", "data/structured/bridge_network.csv",
                    "data/structured/transaction_requests.csv")
DAILY_STATE_FILE = "data/processed/synthetic_liquidity_congestion_daily.parquet"
KNOWLEDGE_FILE = "data/knowledge/regulatory_facts.json"
BRIDGE_NETWORK_FILE = "data/structured/bridge_network.csv"
NORMALIZATION_STATS_FILE = "data/processed/normalization_stats.json"


def sha256_file(path: Path) -> str:
    """Raw file bytes. Cross-platform normalisation is undecided (contract README C5)."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def artefact_checks(repo_root: Path) -> dict:
    """The /v1/health `structured_data`, `daily_state` and `knowledge_base` checks (ok | error)."""
    structured = all((repo_root / f).is_file() for f in STRUCTURED_FILES)
    daily = (repo_root / DAILY_STATE_FILE).is_file()
    try:
        kb = json.loads((repo_root / KNOWLEDGE_FILE).read_text(encoding="utf-8"))
        knowledge = isinstance(kb, dict) and isinstance(kb.get("facts"), list)
    except (OSError, ValueError):
        knowledge = False
    return {"structured_data": "ok" if structured else "error", "daily_state": "ok" if daily else "error",
            "knowledge_base": "ok" if knowledge else "error"}


def git_commit(repo_root: Path) -> str:
    """Short commit of the checkout. Docker images have no .git (arch §4.2); how the build
    supplies the commit there is not specified yet, so this reports "unknown"."""
    try:
        out = subprocess.run(["git", "-C", str(repo_root), "rev-parse", "--short", "HEAD"],
                             capture_output=True, text=True, timeout=5)
        commit = out.stdout.strip()
        if out.returncode == 0 and commit:
            return commit
    except (OSError, subprocess.SubprocessError):
        pass
    return "unknown"


def platform_tag() -> str:
    system = {"win32": "windows", "linux": "linux", "darwin": "macos"}.get(sys.platform, sys.platform)
    machine = platform.machine().lower()
    machine = {"amd64": "x86_64", "x64": "x86_64"}.get(machine, machine)
    return f"{system}-{machine}"


def lock_file_for(platform_name: str, torch_version: Optional[str]) -> str:
    """The lock this runtime corresponds to (arch §7.2). Dev D has not generated the locks yet."""
    accel = "cpu"
    if torch_version and "+" in torch_version and torch_version.split("+", 1)[1].startswith("cu"):
        accel = torch_version.split("+", 1)[1]
    return f"services/inference/requirements/{platform_name}-{accel}.txt"


def static_metadata(repo_root: Path) -> dict:
    data = {}
    for key, rel in (("bridge_network_sha256", BRIDGE_NETWORK_FILE),
                     ("normalization_stats_sha256", NORMALIZATION_STATS_FILE)):
        try:
            data[key] = sha256_file(repo_root / rel)
        except OSError:
            data[key] = None
    return {"git_commit": git_commit(repo_root), "platform": platform_tag(),
            "python": platform.python_version(), "data": data}
