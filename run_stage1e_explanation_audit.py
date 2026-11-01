"""Stage 1E step 3 - read-only semantic explanation & audit of Stage 1D results.

Run from the repository root:

    # With Cognee semantic retrieval (same provider env vars as run_cognee_smoke_test.py):
    python run_stage1e_explanation_audit.py --yes

    # Static-only (no Cognee, no provider needed):
    python run_stage1e_explanation_audit.py --static-only

Reads the authoritative Stage 1D result files (src/memory/explanation_audit.py
DEFAULT_INPUTS, or --inputs) WITHOUT modifying them, and writes, into a new
outputs/memory_audit/stage1e_explanation_audit_<timestamp>/ directory:
  explanations.jsonl  one deterministic explanation per unique transaction
  retrievals.json     Cognee retrieval per corridor (grounded to fact_ids)
  summary.json        counts: decisions, env consistency, retrieval coverage
  input_hashes.json   SHA-256 of every input, verified unchanged afterwards
  provenance.json     git HEAD/dirty files, code + knowledge hashes, settings

Decisions come only from StaticMemoryProvider. No PPO training, evaluation,
environment, dataset or checkpoint code is imported or run.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from src.memory.explanation_audit import DEFAULT_INPUTS, run_audit
from src.memory.knowledge import load_knowledge
from src.memory.provider import StaticMemoryProvider

CODE_FILES = ["run_stage1e_explanation_audit.py", "src/memory/explanation_audit.py", "src/memory/cognee_adapter.py",
              "src/memory/provider.py", "src/memory/knowledge.py"]


def _git(*args):
    try:
        return subprocess.check_output(["git", *args], text=True).strip()
    except Exception:
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description="Read-only Stage 1E explanation & audit of Stage 1D results")
    ap.add_argument("--inputs", nargs="+", default=DEFAULT_INPUTS)
    ap.add_argument("--top-k", type=int, default=5)
    ap.add_argument("--static-only", action="store_true", help="skip Cognee retrieval")
    ap.add_argument("--skip-ingest", action="store_true", help="assume the knowledge dataset is already in Cognee")
    ap.add_argument("--yes", action="store_true", help="confirm knowledge text/queries may go to the configured provider")
    args = ap.parse_args()

    for p in args.inputs:
        if not Path(p).is_file():
            print(f"Missing input: {p}")
            return 2

    kb = load_knowledge()
    static = StaticMemoryProvider(knowledge=kb)
    adapter, settings_public, manifest = None, None, None
    if not args.static_only:
        from src.memory.cognee_adapter import CogneeAdapter, CogneeConfigError, CogneeSettings
        try:
            settings = CogneeSettings.from_env()
            settings.validate()
        except CogneeConfigError as e:
            print(f"Configuration error: {e} (use --static-only to run without Cognee)")
            return 2
        if not args.yes:
            print("Refusing to use Cognee without --yes (knowledge text and queries go to the configured provider).")
            return 2
        settings_public = settings.public_dict()
        adapter = CogneeAdapter(kb, settings=settings)
        if not args.skip_ingest:
            manifest = adapter.ingest()

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = Path("outputs/memory_audit") / f"stage1e_explanation_audit_{ts}"
    status = _git("status", "--porcelain")
    provenance = {
        "workflow": "stage1e_explanation_audit", "started_at": ts, "mode": "static_only" if adapter is None else "cognee",
        "inputs": list(args.inputs), "top_k": args.top_k,
        "knowledge": {"path": kb.source_path, "version": kb.knowledge_version, "sha256": kb.sha256,
                      "fact_ids": [f.fact_id for f in kb.facts]},
        "decision_authority": "StaticMemoryProvider",
        "cognee_settings": settings_public, "cognee_ingest_manifest": manifest,
        "cognee_dataset": None if adapter is None else adapter.dataset_name,
        "git_head": _git("rev-parse", "HEAD"), "git_dirty": bool(status),
        "git_dirty_files": status.splitlines() if status else [],
        "code_sha256": {f: hashlib.sha256(Path(f).read_bytes()).hexdigest() for f in CODE_FILES},
        "code_git_blob": {f: _git("hash-object", f) for f in CODE_FILES},
        "python": platform.python_version(),
        "ppo_training_or_evaluation_run": False,
    }

    summary = run_audit(args.inputs, out_dir, static, adapter=adapter, top_k=args.top_k)
    (out_dir / "provenance.json").write_text(json.dumps(provenance, indent=2, default=str), encoding="utf-8")

    print(json.dumps(summary, indent=2, default=str))
    print(f"\nOutputs: {out_dir.resolve()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
