"""Stage 1E - LIVE Cognee smoke test (manual; not part of pytest).

Run from the repository root, with provider settings in the environment:

    # Hosted (sends knowledge-base text and queries to the provider):
    $env:LLM_API_KEY = "..."           # PowerShell; optionally LLM_PROVIDER / LLM_MODEL / EMBEDDING_*
    python run_cognee_smoke_test.py --yes

    # Local Ollama (knowledge text and queries stay on the machine):
    $env:LLM_PROVIDER="ollama"; $env:LLM_MODEL="llama3.1:8b"; $env:LLM_ENDPOINT="http://localhost:11434/v1"
    $env:EMBEDDING_PROVIDER="ollama"; $env:EMBEDDING_MODEL="nomic-embed-text:latest"
    $env:EMBEDDING_ENDPOINT="http://localhost:11434/api/embed"; $env:EMBEDDING_DIMENSIONS="768"
    $env:LITELLM_LOCAL_MODEL_COST_MAP="True"
    # Windows: directory containing OpenSSL 3 (libssl-3-x64.dll, libcrypto-3-x64.dll) for the graph DB:
    $env:CBDC_COGNEE_DLL_DIR="C:\Program Files\Git\mingw64\bin"
    python run_cognee_smoke_test.py --yes

    For Ollama the adapter defaults LLM_API_KEY to a placeholder and
    LLM_INSTRUCTOR_MODE to "json_schema_mode"; either can be overridden.

What it does: ingests data/knowledge/regulatory_facts.json into Cognee
(storage under .cognee/, git-ignored), runs one retrieval, and checks that:
  * the seed fact `global_max_single_transfer_usd` is retrieved and grounded;
  * CogneeExplanationProvider decisions equal StaticMemoryProvider decisions.
It never touches PPO, the environment, datasets or checkpoints. It writes
only under .cognee/ (Cognee storage plus a smoke-result JSON).

Requires --yes, because with a hosted provider the knowledge text is sent to
that provider. Exits non-zero on any failed check.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone

from src.memory.cognee_adapter import CogneeAdapter, CogneeConfigError, CogneeExplanationProvider, CogneeSettings
from src.memory.knowledge import load_knowledge
from src.memory.provider import StaticMemoryProvider

EXPECTED_FACT = "global_max_single_transfer_usd"
CASES = [("USA", "IND", 250000.0), ("GBR", "PHL", 495000.0), ("ARE", "MEX", 600000.0)]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--yes", action="store_true", help="confirm ingestion/queries may go to the configured provider")
    ap.add_argument("--top-k", type=int, default=5)
    args = ap.parse_args()

    try:
        settings = CogneeSettings.from_env()
        print("settings:", json.dumps(settings.public_dict(), indent=2))
        settings.validate()
    except CogneeConfigError as e:
        print(f"Configuration error: {e}")
        return 2
    if not args.yes:
        print("Refusing to run without --yes (knowledge text and queries go to the configured provider).")
        return 2

    kb = load_knowledge()
    static = StaticMemoryProvider(knowledge=kb)
    adapter = CogneeAdapter(kb, settings=settings)
    manifest = adapter.ingest()
    print("ingested:", json.dumps({k: manifest[k] for k in ("dataset_name", "knowledge_sha256", "fact_ids")}))

    retrieval = adapter.retrieve("What is the maximum amount allowed for a single cross-border transfer?",
                                 top_k=args.top_k)
    checks = {"seed_fact_retrieved_and_grounded": EXPECTED_FACT in retrieval["grounded_fact_ids"]}

    provider = CogneeExplanationProvider(static=static, adapter=adapter, top_k=args.top_k)
    explanations = []
    for s, r, a in CASES:
        e = provider.explain(s, r, a)
        st = static.explain(s, r, a)
        same = (e["allowed"], e["reason"], e["decisive_fact_ids"]) == (st["allowed"], st["reason"], st["decisive_fact_ids"])
        checks[f"decision_equals_static_{s}_{r}_{a:.0f}"] = same and \
            provider.check_transaction(s, r, a) == static.check_transaction(s, r, a)
        checks[f"semantic_context_ok_{s}_{r}_{a:.0f}"] = "error" not in e["semantic_context"]
        explanations.append({"case": [s, r, a], "allowed": e["allowed"], "reason": e["reason"],
                             "semantic_context": e["semantic_context"]})

    result = {"run_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
              "settings": settings.public_dict(), "manifest": manifest, "retrieval": retrieval,
              "explanations": explanations, "checks": checks, "passed": all(checks.values())}
    out = settings.root / f"smoke_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    out.write_text(json.dumps(result, indent=2, default=str), encoding="utf-8")

    for name, ok in checks.items():
        print(("PASS " if ok else "FAIL ") + name)
    print(f"result written to {out}")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
