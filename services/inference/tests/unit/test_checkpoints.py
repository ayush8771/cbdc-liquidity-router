import hashlib
import json

import pytest

from cbdc_inference.checkpoints import (REASON_NOT_APPROVED, REASON_NOT_CONFIGURED, RegistryError,
                                        load_registry, resolve_gate)
from cbdc_inference.settings import APPROVED_CHECKPOINTS_PATH


def _entry(**over):
    e = {"checkpoint_id": "ckpt-a", "path": "outputs/experiments/run/seed/cfg/ppo_checkpoint.pt",
         "sha256": "0" * 64, "approved_by": "owner", "approved_on": "2026-11-03",
         "evidence": "docs/STAGE1F_RESULTS.md", "notes": "Experimental."}
    e.update(over)
    return e


def _write(tmp_path, entries):
    p = tmp_path / "approved_checkpoints.json"
    p.write_text(json.dumps({"approved": entries}), encoding="utf-8")
    return p


def test_shipped_registry_is_empty():
    """Contract §7: the file ships with "approved": [] — no checkpoint is approved yet."""
    assert json.loads(APPROVED_CHECKPOINTS_PATH.read_text(encoding="utf-8")) == {"approved": []}
    assert load_registry(APPROVED_CHECKPOINTS_PATH) == []


def test_unset_id_disables_ppo(tmp_path):
    gate = resolve_gate(None, APPROVED_CHECKPOINTS_PATH, tmp_path)
    assert (gate.status, gate.reason, gate.enabled) == ("disabled", REASON_NOT_CONFIGURED, False)


def test_id_not_in_shipped_registry_disables_ppo(tmp_path):
    gate = resolve_gate("anything", APPROVED_CHECKPOINTS_PATH, tmp_path)
    assert (gate.status, gate.reason, gate.enabled) == ("disabled", REASON_NOT_APPROVED, False)


def test_matching_hash_enables(tmp_path):
    ckpt = tmp_path / "outputs/experiments/run/seed/cfg/ppo_checkpoint.pt"
    ckpt.parent.mkdir(parents=True)
    ckpt.write_bytes(b"weights")
    reg = _write(tmp_path, [_entry(sha256=hashlib.sha256(b"weights").hexdigest())])
    gate = resolve_gate("ckpt-a", reg, tmp_path)
    assert gate.enabled and gate.checkpoint.checkpoint_id == "ckpt-a"


def test_hash_mismatch_is_error(tmp_path):
    ckpt = tmp_path / "outputs/experiments/run/seed/cfg/ppo_checkpoint.pt"
    ckpt.parent.mkdir(parents=True)
    ckpt.write_bytes(b"tampered")
    reg = _write(tmp_path, [_entry(sha256=hashlib.sha256(b"weights").hexdigest())])
    gate = resolve_gate("ckpt-a", reg, tmp_path)
    assert (gate.status, gate.enabled) == ("error", False)


def test_missing_checkpoint_file_is_error(tmp_path):
    gate = resolve_gate("ckpt-a", _write(tmp_path, [_entry()]), tmp_path)
    assert (gate.status, gate.enabled) == ("error", False)


@pytest.mark.parametrize("bad", [
    _entry(sha256="ABC"),
    _entry(path="/abs/ppo.pt"),
    _entry(path="../outside/ppo.pt"),
    _entry(path="outputs\\experiments\\ppo.pt"),
    {k: v for k, v in _entry().items() if k != "approved_by"},
])
def test_malformed_entries_rejected(tmp_path, bad):
    with pytest.raises(RegistryError):
        load_registry(_write(tmp_path, [bad]))


def test_duplicate_ids_rejected(tmp_path):
    with pytest.raises(RegistryError):
        load_registry(_write(tmp_path, [_entry(), _entry()]))


def test_invalid_registry_fails_closed(tmp_path):
    p = tmp_path / "approved_checkpoints.json"
    p.write_text("{not json", encoding="utf-8")
    gate = resolve_gate("ckpt-a", p, tmp_path)
    assert (gate.status, gate.enabled) == ("error", False)
