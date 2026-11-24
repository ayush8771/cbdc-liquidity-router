"""The ppo_projected gate: approval registry, per-worker re-verification and reporting.

Contract §7, §2.2, §2.8 and arch D2-D4. No checkpoint is approved in this repository, so
`ppo_projected` is disabled; these tests drive the gate with temporary registries instead.

Two rules are load-bearing and both fail **closed**:
  * `ppo_projected` is served only when `CBDC_PPO_CHECKPOINT_ID` names a registry entry AND the
    file at its `path` has exactly that `sha256`;
  * **each engine worker re-verifies the hash itself** before loading any weights, so a file
    swapped after start-up is never served.
Raw PPO is never exposed: only the projected policy exists (D3).
"""
import json

import pytest
from fastapi.testclient import TestClient

from cbdc_inference.api.app import create_app
from cbdc_inference.checkpoints import ApprovedCheckpoint, resolve_gate, sha256_file
from cbdc_inference.engine import ReplayState, Transaction
from cbdc_inference.engine import errors as E
from cbdc_inference.engine.types import POLICIES
from cbdc_inference.settings import Settings

DATE = "2024-06-14"
TX = Transaction("GBR", "PHL", 300000.0)
CHECKPOINT_REL = "outputs/experiments/fake-run/seed42/config/ppo_checkpoint.pt"


def _registry(tmp_path, repo_root, sha256, rel=CHECKPOINT_REL) -> tuple:
    """Writes a one-entry approval registry and returns (path, entry)."""
    entry = {"checkpoint_id": "ckpt-test-1", "path": rel, "sha256": sha256,
             "approved_by": "owner", "approved_on": "2026-11-05", "evidence": "docs/STAGE1F_RESULTS.md",
             "notes": "Experimental. Served only with capacity projection."}
    path = tmp_path / "approved_checkpoints.json"
    path.write_text(json.dumps({"approved": [entry]}), encoding="utf-8")
    return path, entry


@pytest.fixture
def fake_checkpoint(tmp_path):
    """A file standing in for a checkpoint, with its real hash."""
    target = tmp_path / "repo" / CHECKPOINT_REL
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b"not-a-real-torch-checkpoint")
    return tmp_path / "repo", sha256_file(target)


# ------------------------------------------------------------------ only the projected policy exists
def test_raw_ppo_is_not_a_policy():
    """D3: raw PPO is never served, so there is no policy name for it."""
    assert POLICIES == ("waterfall", "cheapest_feasible", "ppo_projected")
    assert "ppo_original" not in POLICIES


def test_ppo_original_is_a_validation_error(worker):
    with pytest.raises(E.ValidationFailed):
        worker.route(TX, ReplayState(DATE), "ppo_original")


# ------------------------------------------------------------------ the gate (§7)
def test_gate_enabled_only_with_a_matching_hash(tmp_path, fake_checkpoint):
    repo_root, sha = fake_checkpoint
    registry, entry = _registry(tmp_path, repo_root, sha)
    gate = resolve_gate("ckpt-test-1", registry, repo_root)
    assert gate.status == "ok" and gate.enabled
    assert gate.checkpoint.checkpoint_id == entry["checkpoint_id"]


def test_gate_reports_error_on_a_hash_mismatch(tmp_path, fake_checkpoint):
    """§7: a mismatch is an error, and /v1/health reports ppo_checkpoint: "error"."""
    repo_root, _sha = fake_checkpoint
    registry, _ = _registry(tmp_path, repo_root, "0" * 64)
    gate = resolve_gate("ckpt-test-1", registry, repo_root)
    assert gate.status == "error" and not gate.enabled


# ------------------------------------------------------------------ per-worker re-verification (§7)
def test_worker_rejects_a_checkpoint_whose_hash_does_not_match(worker, monkeypatch, fake_checkpoint):
    """Each worker verifies the hash itself, so a registry entry it cannot confirm disables
    ppo_projected rather than serving unverified weights."""
    repo_root, _sha = fake_checkpoint
    monkeypatch.setattr(worker, "repo_root", repo_root)
    wrong = ApprovedCheckpoint("ckpt-test-1", CHECKPOINT_REL, "0" * 64, "owner", "2026-11-05", "evidence")
    assert worker._verify_checkpoint(wrong) is None


def test_worker_accepts_a_checkpoint_whose_hash_matches(worker, monkeypatch, fake_checkpoint):
    repo_root, sha = fake_checkpoint
    monkeypatch.setattr(worker, "repo_root", repo_root)
    right = ApprovedCheckpoint("ckpt-test-1", CHECKPOINT_REL, sha, "owner", "2026-11-05", "evidence")
    assert worker._verify_checkpoint(right) is right


def test_worker_rejects_a_missing_checkpoint_file(worker):
    absent = ApprovedCheckpoint("ckpt-missing", "outputs/experiments/none/ppo_checkpoint.pt", "0" * 64,
                                "owner", "2026-11-05", "evidence")
    assert worker._verify_checkpoint(absent) is None


def test_loading_fails_closed_if_the_file_changes_after_start(worker, monkeypatch, fake_checkpoint, tmp_path):
    """The hash is re-checked at LOAD time too, so a file swapped after the worker started is
    never served."""
    repo_root, sha = fake_checkpoint
    monkeypatch.setattr(worker, "repo_root", repo_root)
    entry = ApprovedCheckpoint("ckpt-test-1", CHECKPOINT_REL, sha, "owner", "2026-11-05", "evidence")
    monkeypatch.setattr(worker, "checkpoint", entry)
    monkeypatch.setattr(worker, "_ppo_policy", None)
    (repo_root / CHECKPOINT_REL).write_bytes(b"tampered-after-approval")
    with pytest.raises(E.PolicyDisabled, match="SHA-256 mismatch"):
        worker._load_ppo()


def test_no_checkpoint_disables_the_load(worker, monkeypatch):
    monkeypatch.setattr(worker, "checkpoint", None)
    monkeypatch.setattr(worker, "_ppo_policy", None)
    with pytest.raises(E.PolicyDisabled, match="no approved checkpoint"):
        worker._load_ppo()


# ------------------------------------------------------------------ requests and reporting
def test_ppo_projected_is_policy_disabled_in_this_repository(worker):
    """§4: `ppo_projected` requested with no approved checkpoint enabled is a 409."""
    assert worker.ppo_enabled is False
    with pytest.raises(E.PolicyDisabled) as ei:
        worker.route(TX, ReplayState(DATE), "ppo_projected")
    assert (ei.value.code, ei.value.http_status) == ("POLICY_DISABLED", 409)


def test_version_reports_a_disabled_ppo_with_a_reason(repo_settings, fake_pool_factory):
    _, factory = fake_pool_factory()
    with TestClient(create_app(repo_settings, pool_factory=factory)) as c:
        v = c.get("/v1/version").json()
    assert v["checkpoint"] is None
    ppo = [p for p in v["policies"] if p["policy"] == "ppo_projected"][0]
    assert ppo == {"policy": "ppo_projected", "status": "experimental", "enabled": False,
                   "disabled_reason": "no approved checkpoint configured"}


def test_version_reports_the_checkpoint_when_one_is_enabled(repo_settings, fake_pool_factory):
    """§2.2: `checkpoint` carries the id, hash, approver, date and `source_run`, which is the
    directory containing the checkpoint file."""
    from tests.conftest import FAKE_ENGINE_METADATA
    checkpoint = {"checkpoint_id": "ckpt-test-1", "sha256": "a" * 64, "approved_by": "owner",
                  "approved_on": "2026-11-05", "source_run": "outputs/experiments/fake-run/seed42/config"}
    metadata = {**FAKE_ENGINE_METADATA, "checkpoint": checkpoint, "ppo_enabled": True}
    _, factory = fake_pool_factory(metadata=metadata)
    with TestClient(create_app(repo_settings, pool_factory=factory)) as c:
        v = c.get("/v1/version").json()
    assert v["checkpoint"] == checkpoint
    ppo = [p for p in v["policies"] if p["policy"] == "ppo_projected"][0]
    assert ppo == {"policy": "ppo_projected", "status": "experimental", "enabled": True}
    assert "disabled_reason" not in ppo  # only a disabled policy carries a reason


def test_health_reports_the_checkpoint_status(repo_settings, fake_pool_factory):
    """§2.1: a `disabled` checkpoint does NOT make the service degraded."""
    _, factory = fake_pool_factory()
    with TestClient(create_app(repo_settings, pool_factory=factory)) as c:
        b = c.get("/v1/health").json()
    assert b["checks"]["ppo_checkpoint"] == "disabled"
    assert (b["status"], b["ready"]) == ("ok", True)


def test_settings_does_not_hard_code_a_checkpoint():
    """arch D4 / §7: no checkpoint path or ID appears in source code."""
    assert Settings().ppo_checkpoint_id is None
    assert Settings(ppo_checkpoint_id="   ").ppo_checkpoint_id is None  # blank is unset
