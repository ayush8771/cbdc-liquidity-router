"""Stage 1E step 3 tests: read-only explanation & audit workflow.

Uses a FAKE cognee module; no network, LLM, embeddings or real Cognee storage.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from src.memory.cognee_adapter import CogneeAdapter, CogneeSettings
from src.memory.explanation_audit import (DEFAULT_INPUTS, corridor_query, explain_transaction, load_transactions,
                                          retrieve_for_corridors, run_audit, sha256_file, summarize)
from src.memory.knowledge import build_knowledge_base
from src.memory.provider import StaticMemoryProvider


class FakeCognee:
    def __init__(self, results_by_query=None, error=None):
        self.calls, self.results_by_query, self.error = [], results_by_query or {}, error
        self.SearchType = SimpleNamespace(CHUNKS="CHUNKS")
        outer = self

        class _Config:
            def __getattr__(self, name):
                return lambda *a, **k: outer.calls.append(("config." + name, a, k))
        self.config = _Config()

    async def add(self, *a, **k):
        self.calls.append(("add", a, k))

    async def cognify(self, *a, **k):
        self.calls.append(("cognify", a, k))

    async def search(self, query_text=None, **k):
        self.calls.append(("search", (query_text,), k))
        if self.error:
            raise self.error
        return self.results_by_query.get(query_text, self.results_by_query.get("*", []))


def _kb():
    return build_knowledge_base({"schema_version": 1, "knowledge_version": "t", "facts": [
        {"fact_id": "cap", "rule_type": "max_single_transfer_usd", "value": 1000.0,
         "scope": {"sender": "*", "receiver": "*"}, "effective_from": None, "effective_to": None,
         "provenance_tag": "synthetic", "verified": False, "source": "unit test"},
        {"fact_id": "block_are_mex", "rule_type": "restricted_corridor", "value": None,
         "scope": {"sender": "ARE", "receiver": "MEX"}, "effective_from": "2024-06-01", "effective_to": None,
         "provenance_tag": "synthetic", "verified": False, "source": "unit test"}]}, sha256="b" * 64)


def _chunks(*texts):
    return [{"dataset_name": "ds", "search_result": [{"id": f"c{i}", "text": t, "chunk_index": i}
                                                     for i, t in enumerate(texts)]}]


def _adapter(fake, tmp):
    s = CogneeSettings(llm_provider="ollama", llm_api_key="ollama", embedding_provider="ollama", root=Path(tmp))
    return CogneeAdapter(_kb(), settings=s, cognee_module=fake)


def _write_inputs(d):
    """Two synthetic result files: a holdout-style per_transaction file and a diagnostics file."""
    run = Path(d) / "run_a"
    diag = Path(d) / "diag_b"
    run.mkdir()
    diag.mkdir()
    rows = []
    for ck in ("ck1", "ck2"):
        for pol, done in (("ppo_original", False), ("ppo_projected", True), ("liquidity_waterfall", True)):
            rows += [
                {"checkpoint": ck, "policy": pol, "transaction_id": 1, "regime": "splitting_needed",
                 "corridor": "USA->IND", "simulation_date": "2024-03-01", "amount": 900.0, "rejected": False,
                 "amount_completed": done},
                {"checkpoint": ck, "policy": pol, "transaction_id": 2, "regime": "below_cheapest",
                 "corridor": "ARE->MEX", "simulation_date": "2024-07-01", "amount": 10.0, "rejected": False,
                 "amount_completed": True},
                {"checkpoint": ck, "policy": pol, "transaction_id": 3, "regime": "exceeds_combined",
                 "corridor": "GBR->PHL", "simulation_date": "2024-03-01", "amount": 5000.0, "rejected": True,
                 "amount_completed": False},
            ]
    p1 = run / "per_transaction.csv"
    pd.DataFrame(rows).to_csv(p1, index=False)
    p2 = diag / "failed_transactions.csv"
    pd.DataFrame([{"checkpoint": "ck1", "transaction_id": 1, "corridor": "USA->IND", "simulation_date": "2024-03-01",
                   "regime": "splitting_needed", "amount": 900.0, "mechanism": "over_allocation_clipped"}]).to_csv(p2, index=False)
    return [str(p1), str(p2)]


# --- Loading -------------------------------------------------------------------

def test_load_dedupes_across_sources_and_summarizes_outcomes():
    with tempfile.TemporaryDirectory() as d:
        txs, meta = load_transactions(_write_inputs(d))
        assert sorted(txs.transaction_id) == [1, 2, 3]
        t1 = txs[txs.transaction_id == 1].iloc[0]
        assert t1.sources == ["diag_b/failed_transactions.csv", "run_a/per_transaction.csv"]
        o = t1.outcomes["run_a/per_transaction.csv"]
        assert o["amount_completion_rate_by_policy"] == {"liquidity_waterfall": 1.0, "ppo_original": 0.0, "ppo_projected": 1.0}
        assert o["n_checkpoints"] == 2
        assert t1.outcomes["diag_b/failed_transactions.csv"]["failure_mechanisms"] == ["over_allocation_clipped"]
        assert bool(t1.recorded_rejected) is False and bool(t1.recorded_rejected_consistent) is True
        assert bool(txs[txs.transaction_id == 3].iloc[0].recorded_rejected) is True
        assert [m["rows"] for m in meta] == [18, 1] and all(len(m["sha256"]) == 64 for m in meta)


def test_load_rejects_missing_columns_and_bad_corridors():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "x.csv"
        pd.DataFrame([{"transaction_id": 1, "corridor": "USA->IND", "amount": 1.0}]).to_csv(p, index=False)
        try:
            load_transactions([p])
            raise AssertionError("expected ValueError")
        except ValueError as e:
            assert "simulation_date" in str(e)
        pd.DataFrame([{"transaction_id": 1, "corridor": "USAIND", "amount": 1.0, "simulation_date": "2024-01-01"}]).to_csv(p, index=False)
        try:
            load_transactions([p])
            raise AssertionError("expected ValueError")
        except ValueError as e:
            assert "corridor" in str(e)


# --- Explanation / cross-check --------------------------------------------------

def _tx(**over):
    t = {"transaction_id": 9, "sender": "USA", "receiver": "IND", "amount": 900.0, "simulation_date": "2024-03-01",
         "regime": "r", "sources": ["s"], "outcomes": {}, "recorded_rejected": False}
    t.update(over)
    return t


def test_decision_always_from_static_and_semantic_cannot_change_it():
    static = StaticMemoryProvider(knowledge=_kb())
    misleading = {"query": "q", "grounded_fact_ids": [], "ungrounded_result_count": 1,
                  "results": [{"unknown_fact_ids": ["allow_everything"]}]}
    for tx in (_tx(), _tx(amount=5000.0, recorded_rejected=True), _tx(sender="ARE", receiver="MEX", amount=10.0,
                                                                      simulation_date="2024-07-01", recorded_rejected=True)):
        e = explain_transaction(tx, static, misleading)
        st = static.explain(tx["sender"], tx["receiver"], tx["amount"], tx["simulation_date"])
        assert (e["decision"]["allowed"], e["decision"]["reason"], e["decision"]["decisive_fact_ids"]) == \
            (st["allowed"], st["reason"], st["decisive_fact_ids"])
        assert e["decision"]["source"] == "StaticMemoryProvider"
        assert e["semantic"]["unknown_fact_ids"] == ["allow_everything"]
        assert e["knowledge_sha256"] == "b" * 64


def test_env_consistency_true_false_and_unavailable():
    static = StaticMemoryProvider(knowledge=_kb())
    assert explain_transaction(_tx(recorded_rejected=False), static, None)["env_consistency"]["consistent"] is True
    blocked_but_recorded_ok = explain_transaction(_tx(amount=5000.0, recorded_rejected=False), static, None)
    assert blocked_but_recorded_ok["env_consistency"]["consistent"] is False
    assert "DOES NOT match" in blocked_but_recorded_ok["explanation"]
    assert explain_transaction(_tx(recorded_rejected=None), static, None)["env_consistency"]["consistent"] is None


def test_semantic_coverage_flags_are_date_aware():
    static = StaticMemoryProvider(knowledge=_kb())
    retr = {"query": "q", "grounded_fact_ids": ["block_are_mex", "cap"], "ungrounded_result_count": 0, "results": []}
    before = explain_transaction(_tx(sender="ARE", receiver="MEX", amount=10.0, simulation_date="2024-05-31"), static, retr)
    after = explain_transaction(_tx(sender="ARE", receiver="MEX", amount=10.0, simulation_date="2024-06-01"), static, retr)
    assert before["decision"]["allowed"] is True and before["semantic"]["retrieved_facts_not_active"] == ["block_are_mex"]
    assert after["decision"]["allowed"] is False and after["semantic"]["retrieved_facts_not_active"] == []
    assert after["semantic"]["covers_all_active_facts"] is True
    partial = explain_transaction(_tx(sender="ARE", receiver="MEX", amount=10.0, simulation_date="2024-06-01"), static,
                                  {"query": "q", "grounded_fact_ids": ["cap"], "ungrounded_result_count": 2, "results": []})
    assert partial["semantic"]["active_facts_missed"] == ["block_are_mex"]
    assert partial["semantic"]["covers_all_active_facts"] is False


def test_semantic_error_and_not_requested_statuses():
    static = StaticMemoryProvider(knowledge=_kb())
    e = explain_transaction(_tx(), static, {"query": "q", "error": "ConnectionError: down"})
    assert e["semantic"]["status"] == "error" and "unavailable" in e["explanation"] and e["decision"]["allowed"] is True
    assert explain_transaction(_tx(), static, None)["semantic"]["status"] == "not_requested"


def test_explanations_are_deterministic_and_carry_provenance():
    static = StaticMemoryProvider(knowledge=_kb())
    retr = {"query": "q", "grounded_fact_ids": ["cap"], "ungrounded_result_count": 0, "results": []}
    a, b = explain_transaction(_tx(), static, retr), explain_transaction(_tx(), static, retr)
    assert a == b
    assert a["explanation"].startswith("Transfer USA->IND of 900.00 USD on 2024-03-01: ALLOWED by StaticMemoryProvider")
    assert a["active_facts"][0]["provenance_tag"] == "synthetic" and a["active_facts"][0]["source"] == "unit test"


# --- Retrieval ------------------------------------------------------------------

def test_one_retrieval_per_corridor_and_errors_recorded():
    with tempfile.TemporaryDirectory() as tmp:
        fake = FakeCognee(results_by_query={"*": _chunks("fact_id: cap\nrule: max")})
        out = retrieve_for_corridors(_adapter(fake, tmp), [("USA", "IND"), ("USA", "IND"), ("GBR", "PHL")], top_k=3)
        searches = [c for c in fake.calls if c[0] == "search"]
        assert sorted(out) == ["GBR->PHL", "USA->IND"] and len(searches) == 2
        assert searches[0][1][0] == corridor_query("GBR", "PHL") and searches[0][2]["top_k"] == 3
        assert out["USA->IND"]["grounded_fact_ids"] == ["cap"]
        err = retrieve_for_corridors(_adapter(FakeCognee(error=TimeoutError("slow")), tmp), [("USA", "IND")])
        assert err["USA->IND"]["error"] == "TimeoutError: slow"


# --- End-to-end run (fake Cognee) -----------------------------------------------

def test_run_audit_writes_outputs_and_leaves_inputs_unchanged():
    with tempfile.TemporaryDirectory() as d:
        inputs = _write_inputs(d)
        before = {p: sha256_file(p) for p in inputs}
        fake = FakeCognee(results_by_query={"*": _chunks("fact_id: cap", "fact_id: invented")})
        out = Path(d) / "audit"
        summary = run_audit(inputs, out, StaticMemoryProvider(knowledge=_kb()), adapter=_adapter(fake, d), top_k=2)
        assert {p: sha256_file(p) for p in inputs} == before
        assert sorted(x.name for x in out.iterdir()) == ["explanations.jsonl", "input_hashes.json", "retrievals.json", "summary.json"]
        lines = [json.loads(l) for l in (out / "explanations.jsonl").read_text(encoding="utf-8").splitlines()]
        assert sorted(e["transaction_id"] for e in lines) == [1, 2, 3]
        # JSON must carry native types, not stringified numpy scalars.
        for e in lines:
            assert type(e["transaction_id"]) is int and type(e["amount"]) is float
            assert type(e["env_consistency"]["recorded_rejected"]) is bool
            assert type(e["env_consistency"]["consistent"]) is bool and type(e["decision"]["allowed"]) is bool
        # tx1 USA->IND 900 allowed; tx2 ARE->MEX 2024-07-01 blocked by the dated restriction;
        # tx3 GBR->PHL 5000 blocked by the cap. tx2 was recorded as NOT rejected -> one inconsistency.
        assert summary["n_transactions"] == 3 and summary["allowed"] == 1 and summary["blocked"] == 2
        assert summary["env_consistency"] == {"checked": 3, "consistent": 2, "inconsistent": 1, "not_available": 0}
        tx2 = next(e for e in lines if e["transaction_id"] == 2)
        assert tx2["env_consistency"]["consistent"] is False and "DOES NOT match" in tx2["explanation"]
        sem = summary["semantic"]
        assert sem["status_counts"]["ok"] == 3 and sem["unknown_fact_ids_seen"] == ["invented"]
        assert sem["corridors_retrieved"] == ["ARE->MEX", "GBR->PHL", "USA->IND"] and sem["corridors_with_errors"] == []
        assert sem["transactions_missing_active_facts"] == 1  # ARE->MEX after 2024-06-01: block_are_mex not retrieved
        assert json.loads((out / "input_hashes.json").read_text(encoding="utf-8"))["verified_unchanged_after_audit"] is True
        assert len([c for c in fake.calls if c[0] == "search"]) == 3


def test_run_audit_static_only_and_refuses_existing_output_dir():
    with tempfile.TemporaryDirectory() as d:
        inputs = _write_inputs(d)
        out = Path(d) / "audit"
        summary = run_audit(inputs, out, StaticMemoryProvider(knowledge=_kb()))
        assert summary["semantic"]["status_counts"] == {"ok": 0, "error": 0, "not_requested": 3}
        assert not (out / "retrievals.json").exists()
        try:
            run_audit(inputs, out, StaticMemoryProvider(knowledge=_kb()))
            raise AssertionError("expected FileExistsError")
        except FileExistsError:
            pass


def test_run_audit_detects_modified_inputs():
    with tempfile.TemporaryDirectory() as d:
        inputs = _write_inputs(d)

        class Tampering(StaticMemoryProvider):
            def explain(self, *a, **k):
                with open(inputs[0], "a", encoding="utf-8") as fh:
                    fh.write("\n")  # simulate an input being modified while the audit runs
                return super().explain(*a, **k)
        try:
            run_audit(inputs, Path(d) / "audit", Tampering(knowledge=_kb()))
            raise AssertionError("expected RuntimeError")
        except RuntimeError as e:
            assert "changed during the audit" in str(e)


def test_run_audit_rejects_mismatched_knowledge():
    with tempfile.TemporaryDirectory() as d:
        try:
            run_audit(_write_inputs(d), Path(d) / "audit", StaticMemoryProvider(), adapter=_adapter(FakeCognee(), d))
            raise AssertionError("expected ValueError")
        except ValueError as e:
            assert "same knowledge" in str(e)


# --- Real Stage 1D inputs (static-only, temp output) -------------------------------

def test_static_audit_on_real_stage1d_results_is_consistent_and_read_only():
    paths = [os.path.join(ROOT, p) for p in DEFAULT_INPUTS]
    if not all(os.path.exists(p) for p in paths):
        return  # result files not present in this checkout
    before = {p: sha256_file(p) for p in paths}
    with tempfile.TemporaryDirectory() as d:
        summary = run_audit(paths, Path(d) / "audit", StaticMemoryProvider())
    assert {p: sha256_file(p) for p in paths} == before
    assert summary["n_transactions"] > 1000
    assert summary["env_consistency"]["inconsistent"] == 0 and summary["blocked"] == 0  # all amounts < $500K cap


# --- Isolation and CLI guards --------------------------------------------------------

def test_audit_module_does_not_import_ppo_env_training_or_cognee():
    code = (f"import sys; sys.path.insert(0, r'{ROOT}'); import src.memory.explanation_audit; "
            "print(sorted(m for m in sys.modules if m in ('torch','cognee') or m.startswith(('src.training','src.envs','src.models'))))")
    out = subprocess.check_output([sys.executable, "-c", code], text=True, cwd=ROOT).strip().splitlines()[-1]
    assert out == "[]", out


def _cli(*args, env_extra=None):
    env = {k: v for k, v in os.environ.items() if not k.startswith(("LLM_", "EMBEDDING_", "CBDC_COGNEE"))}
    env.update(env_extra or {})
    p = subprocess.run([sys.executable, "run_stage1e_explanation_audit.py", *args], cwd=ROOT, env=env,
                       capture_output=True, text=True)
    return p.returncode, p.stdout


def test_cli_refuses_missing_input_config_errors_and_missing_consent():
    before = set(os.listdir(os.path.join(ROOT, "outputs"))) if os.path.isdir(os.path.join(ROOT, "outputs")) else set()
    rc, out = _cli("--inputs", "no_such_file.csv")
    assert rc == 2 and "Missing input" in out
    rc, out = _cli()  # hosted default provider without a key
    assert rc == 2 and "Configuration error" in out
    rc, out = _cli(env_extra={"LLM_PROVIDER": "ollama", "EMBEDDING_PROVIDER": "ollama"})
    assert rc == 2 and "without --yes" in out
    after = set(os.listdir(os.path.join(ROOT, "outputs")))
    assert after == before  # no output directories created by refused runs


if __name__ == "__main__":
    tests = [v for k, v in dict(globals()).items() if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {t.__name__}: {type(e).__name__}: {e}")
    print(f"{len(tests) - failed} passed, {failed} failed out of {len(tests)}")
    sys.exit(1 if failed else 0)
