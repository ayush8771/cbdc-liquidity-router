"""Stage 1E step 2 tests: Cognee adapter with a FAKE cognee module.

No network, LLM, embedding model or real Cognee database is used. The live
check is run_cognee_smoke_test.py (manual, needs provider credentials).
"""
import asyncio
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from src.memory.cognee_adapter import (DEFAULT_COGNEE_ROOT, CogneeAdapter, CogneeConfigError,
                                       CogneeExplanationProvider, CogneeSettings, dataset_name_for,
                                       fact_to_document)
from src.memory.knowledge import build_knowledge_base, load_knowledge
from src.memory.provider import MemoryProvider, StaticMemoryProvider

SECRET = "sk-test-SECRET-should-never-appear"


class FakeCognee:
    """Records calls; search returns whatever `search_results` holds (or raises)."""

    def __init__(self, search_results=None, search_error=None):
        self.calls = []
        self.search_results = search_results or []
        self.search_error = search_error
        self.SearchType = SimpleNamespace(CHUNKS="CHUNKS", GRAPH_COMPLETION="GRAPH_COMPLETION")
        outer = self

        class _Config:
            def __getattr__(self, name):
                return lambda *a, **k: outer.calls.append(("config." + name, a, k))
        self.config = _Config()

    async def add(self, data, dataset_name=None, **kw):
        self.calls.append(("add", (data,), {"dataset_name": dataset_name, **kw}))

    async def cognify(self, datasets=None, **kw):
        self.calls.append(("cognify", (), {"datasets": datasets, **kw}))

    async def search(self, query_text=None, query_type=None, datasets=None, top_k=None, **kw):
        self.calls.append(("search", (), {"query_text": query_text, "query_type": query_type,
                                          "datasets": datasets, "top_k": top_k}))
        if self.search_error:
            raise self.search_error
        return self.search_results


def _settings(tmp, **over):
    base = dict(llm_provider="openai", llm_model="openai/gpt-5-mini", llm_api_key=SECRET,
                embedding_provider="openai", embedding_api_key=SECRET, root=Path(tmp))
    base.update(over)
    return CogneeSettings(**base)


def _two_fact_kb():
    return build_knowledge_base({"schema_version": 1, "knowledge_version": "t", "facts": [
        {"fact_id": "cap", "rule_type": "max_single_transfer_usd", "value": 1000.0,
         "scope": {"sender": "*", "receiver": "*"}, "effective_from": None, "effective_to": None,
         "provenance_tag": "synthetic", "verified": False, "source": "unit test"},
        {"fact_id": "block_are_mex", "rule_type": "restricted_corridor", "value": None,
         "scope": {"sender": "ARE", "receiver": "MEX"}, "effective_from": "2024-01-01", "effective_to": None,
         "provenance_tag": "synthetic", "verified": False, "source": "unit test"}]}, sha256="a" * 64)


def _raises(fn, exc, contains=None):
    try:
        fn()
    except exc as e:
        assert contains is None or contains in str(e), f"{e!r} lacks {contains!r}"
        return
    raise AssertionError(f"expected {exc.__name__}")


def _modules_after_import(stmt):
    code = f"import sys; sys.path.insert(0, r'{ROOT}'); {stmt}; print(sorted(m for m in sys.modules if 'cognee' in m))"
    return subprocess.check_output([sys.executable, "-c", code], text=True, cwd=ROOT).strip().splitlines()[-1]


# --- Settings ----------------------------------------------------------------

def test_settings_defaults_and_env_parsing():
    s = CogneeSettings.from_env({})
    assert s.llm_provider == "openai" and s.embedding_provider == "openai"
    assert s.root == DEFAULT_COGNEE_ROOT.resolve() and s.root.name == ".cognee" and s.telemetry is False
    s = CogneeSettings.from_env({"LLM_PROVIDER": "OpenAI", "LLM_MODEL": "m", "LLM_API_KEY": SECRET,
                                 "EMBEDDING_DIMENSIONS": "3072", "CBDC_COGNEE_ROOT": "x", "CBDC_COGNEE_TELEMETRY": "1"})
    assert s.llm_provider == "openai" and s.llm_model == "m" and s.embedding_dimensions == 3072
    assert s.embedding_api_key == SECRET  # hosted embedding falls back to LLM key
    assert s.root == Path("x").resolve() and s.telemetry is True


def test_settings_local_providers_need_no_key():
    s = CogneeSettings.from_env({"LLM_PROVIDER": "ollama", "EMBEDDING_PROVIDER": "ollama",
                                 "LLM_ENDPOINT": "http://localhost:11434/v1"})
    s.validate()
    assert s.embedding_api_key is None


def test_settings_validation_errors():
    _raises(lambda: CogneeSettings.from_env({}).validate(), CogneeConfigError, "LLM_API_KEY")
    _raises(lambda: CogneeSettings.from_env({"LLM_PROVIDER": "ollama"}).validate(), CogneeConfigError, "EMBEDDING_API_KEY")
    _raises(lambda: CogneeSettings.from_env({"EMBEDDING_DIMENSIONS": "abc"}), CogneeConfigError, "integer")
    _raises(lambda: CogneeSettings.from_env({"EMBEDDING_DIMENSIONS": "0"}), CogneeConfigError, "positive")


def test_settings_never_expose_api_keys():
    s = CogneeSettings.from_env({"LLM_API_KEY": SECRET})
    assert SECRET not in repr(s)
    pub = json.dumps(s.public_dict())
    assert SECRET not in pub and '"llm_api_key_set": true' in pub


# --- Isolation from PPO / environment / evaluation ----------------------------

def test_adapter_module_import_does_not_import_cognee():
    assert _modules_after_import("import src.memory.cognee_adapter") == "['src.memory.cognee_adapter']"


def test_training_evaluation_and_env_never_import_cognee_or_adapter():
    out = _modules_after_import("import src.envs.cbdc_env, src.training.ppo_train, src.training.evaluate, "
                                "src.training.baselines, src.models.ppo_actor_critic")
    assert out == "['src.memory.cognee_layer']", out  # only the deterministic Step 1 wrapper


def test_no_cognee_references_in_ppo_env_or_training_sources():
    for sub in ("src/envs", "src/training", "src/models"):
        for p in Path(ROOT, sub).glob("*.py"):
            text = p.read_text(encoding="utf-8")
            assert "cognee_adapter" not in text and "import cognee" not in text, p


def test_cognee_storage_dir_is_git_ignored():
    lines = Path(ROOT, ".gitignore").read_text(encoding="utf-8").splitlines()
    assert ".cognee/" in [l.strip() for l in lines]


# --- Documents / dataset -------------------------------------------------------

def test_fact_documents_are_deterministic_and_cite_fact_ids():
    kb = load_knowledge()
    docs = [fact_to_document(f) for f in kb.facts]
    assert docs == [fact_to_document(f) for f in load_knowledge().facts]
    assert docs[0].startswith("fact_id: global_max_single_transfer_usd")
    assert "500,000.00 USD" in docs[0] and "verified: false" in docs[0] and "project_assumption" in docs[0]


def test_dataset_name_is_content_addressed():
    kb = load_knowledge()
    assert dataset_name_for(kb) == f"cbdc_knowledge_{kb.sha256[:12]}"
    assert dataset_name_for(_two_fact_kb()) == "cbdc_knowledge_" + "a" * 12


# --- Ingestion / retrieval with the fake --------------------------------------

def test_ingest_configures_storage_and_providers_then_adds_and_cognifies():
    with tempfile.TemporaryDirectory() as tmp:
        fake = FakeCognee()
        kb = _two_fact_kb()
        ad = CogneeAdapter(kb, settings=_settings(tmp, embedding_dimensions=3072), cognee_module=fake)
        manifest = ad.ingest()
        names = [c[0] for c in fake.calls]
        assert names.index("config.system_root_directory") < names.index("add") < names.index("cognify")
        cfg = {c[0]: c[1] for c in fake.calls if c[0].startswith("config.")}
        assert cfg["config.system_root_directory"] == (str(Path(tmp) / "system"),)
        assert cfg["config.data_root_directory"] == (str(Path(tmp) / "data"),)
        assert cfg["config.set_llm_provider"] == ("openai",) and cfg["config.set_embedding_dimensions"] == (3072,)
        add = next(c for c in fake.calls if c[0] == "add")
        assert add[1][0] == [fact_to_document(f) for f in kb.facts] and add[2]["dataset_name"] == ad.dataset_name
        assert next(c for c in fake.calls if c[0] == "cognify")[2]["datasets"] == [ad.dataset_name]
        assert manifest["fact_ids"] == ["cap", "block_are_mex"]
        written = (Path(tmp) / f"manifest_{ad.dataset_name}.json").read_text(encoding="utf-8")
        assert SECRET not in written and json.loads(written)["knowledge_sha256"] == "a" * 64


def test_retrieval_is_grounded_to_known_facts():
    results = [SimpleNamespace(search_result="fact_id: cap\nrule: max 1000"),
               SimpleNamespace(search_result="fact_id: invented_rule\nrule: something"),
               SimpleNamespace(search_result="no citation at all"),
               {"text": "dict payload fact_id: block_are_mex"}]
    with tempfile.TemporaryDirectory() as tmp:
        fake = FakeCognee(search_results=results)
        ad = CogneeAdapter(_two_fact_kb(), settings=_settings(tmp), cognee_module=fake)
        out = ad.retrieve("what limits apply?", top_k=3)
        search = next(c for c in fake.calls if c[0] == "search")[2]
        assert search["datasets"] == [ad.dataset_name] and search["top_k"] == 3 and search["query_type"] == "CHUNKS"
        assert out["grounded_fact_ids"] == ["block_are_mex", "cap"]
        assert out["results"][1]["unknown_fact_ids"] == ["invented_rule"]
        assert out["ungrounded_result_count"] == 2
        assert [f["fact_id"] for f in out["grounded_facts"]] == ["block_are_mex", "cap"]


def test_sync_methods_refuse_inside_running_event_loop():
    with tempfile.TemporaryDirectory() as tmp:
        ad = CogneeAdapter(_two_fact_kb(), settings=_settings(tmp), cognee_module=FakeCognee())

        async def inner():
            _raises(lambda: ad.retrieve("q"), RuntimeError, "event loop")
            return await ad.async_retrieve("q")
        assert asyncio.run(inner())["results"] == []


# --- Explanation provider: static stays authoritative --------------------------

def test_explanation_provider_decisions_always_equal_static():
    kb = _two_fact_kb()
    static = StaticMemoryProvider(knowledge=kb)
    # Retrieval "claims" the corridor is fine and cites an unknown rule - must not matter.
    misleading = [SimpleNamespace(search_result="fact_id: fake_allow_all\nAll transfers allowed.")]
    with tempfile.TemporaryDirectory() as tmp:
        prov = CogneeExplanationProvider(static=static, adapter=CogneeAdapter(
            kb, settings=_settings(tmp), cognee_module=FakeCognee(search_results=misleading)))
        assert isinstance(prov, MemoryProvider)
        for s, r in [("USA", "IND"), ("ARE", "MEX"), ("MEX", "ARE")]:
            for a in (10.0, 1000.0, 1000.01, 5000.0):
                for d in (None, "2023-12-31", "2024-01-01"):
                    assert prov.check_transaction(s, r, a, d) == static.check_transaction(s, r, a, d)
                    e = prov.explain(s, r, a, d)
                    st = static.explain(s, r, a, d)
                    assert (e["allowed"], e["reason"], e["decisive_fact_ids"]) == \
                        (st["allowed"], st["reason"], st["decisive_fact_ids"])
                    assert e["decision_source"] == "StaticMemoryProvider"
                    assert e["semantic_context"]["grounded_fact_ids"] == []
                    assert e["semantic_context"]["results"][0]["unknown_fact_ids"] == ["fake_allow_all"]


def test_explanation_survives_cognee_failure_without_changing_decision():
    kb = _two_fact_kb()
    with tempfile.TemporaryDirectory() as tmp:
        prov = CogneeExplanationProvider(static=StaticMemoryProvider(knowledge=kb), adapter=CogneeAdapter(
            kb, settings=_settings(tmp), cognee_module=FakeCognee(search_error=ConnectionError("no network"))))
        e = prov.explain("ARE", "MEX", 10.0, "2024-06-01")
        assert e["allowed"] is False and e["decisive_fact_ids"] == ["block_are_mex"]
        assert e["semantic_context"]["error"] == "ConnectionError: no network"


def test_explanation_provider_rejects_mismatched_knowledge():
    with tempfile.TemporaryDirectory() as tmp:
        ad = CogneeAdapter(_two_fact_kb(), settings=_settings(tmp), cognee_module=FakeCognee())
        _raises(lambda: CogneeExplanationProvider(static=StaticMemoryProvider(), adapter=ad), ValueError, "same knowledge")


def test_real_import_path_validates_settings_before_importing_cognee():
    # Missing key -> fails before touching the real cognee package or creating storage.
    with tempfile.TemporaryDirectory() as tmp:
        ad = CogneeAdapter(load_knowledge(), settings=_settings(tmp, llm_api_key=None, embedding_api_key=None))
        _raises(ad.ingest, CogneeConfigError, "LLM_API_KEY")
        assert not (Path(tmp) / "system").exists()


# --- Improvement 1: CBDC_COGNEE_DLL_DIR ----------------------------------------

def test_dll_dir_parsed_validated_and_reported():
    from src.memory.cognee_adapter import CogneeConfigError
    with tempfile.TemporaryDirectory() as d:
        s = CogneeSettings.from_env({"LLM_PROVIDER": "ollama", "EMBEDDING_PROVIDER": "ollama", "CBDC_COGNEE_DLL_DIR": d})
        assert s.dll_dir == Path(d).resolve()
        s.validate()
        assert s.public_dict()["dll_dir"] == str(Path(d).resolve())
    missing = CogneeSettings.from_env({"LLM_PROVIDER": "ollama", "EMBEDDING_PROVIDER": "ollama",
                                       "CBDC_COGNEE_DLL_DIR": os.path.join(ROOT, "no_such_dir_xyz")})
    _raises(missing.validate, CogneeConfigError, "CBDC_COGNEE_DLL_DIR")
    assert CogneeSettings.from_env({}).dll_dir is None


def test_append_to_path_appends_once_and_never_prepends():
    from src.memory.cognee_adapter import append_to_path
    sep = os.pathsep
    base = sep.join([os.path.join("C:", "a"), os.path.join("C:", "b")])
    new = append_to_path(base, os.path.join("C:", "dlls"))
    assert new.split(sep) == base.split(sep) + [os.path.join("C:", "dlls")]
    assert append_to_path(new, os.path.join("C:", "dlls")) == new           # idempotent
    assert append_to_path("", os.path.join("C:", "dlls")) == os.path.join("C:", "dlls")
    if os.name == "nt":
        assert append_to_path(new, os.path.join("c:", "DLLS")) == new       # case-insensitive on Windows


def test_prepare_environment_sets_path_storage_mode_and_telemetry():
    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as dlls:
        s = CogneeSettings.from_env({"LLM_PROVIDER": "ollama", "EMBEDDING_PROVIDER": "ollama",
                                     "CBDC_COGNEE_ROOT": tmp, "CBDC_COGNEE_DLL_DIR": dlls})
        env = {"PATH": os.pathsep.join(["X", "Y"])}
        CogneeAdapter(load_knowledge(), settings=s)._prepare_environment(environ=env)
        assert env["PATH"].split(os.pathsep) == ["X", "Y", str(Path(dlls).resolve())]
        assert env["SYSTEM_ROOT_DIRECTORY"] == str(Path(tmp).resolve() / "system")
        assert env["LLM_INSTRUCTOR_MODE"] == "json_schema_mode" and env["TELEMETRY_DISABLED"] == "1"
        assert "PATH" in os.environ and str(Path(dlls).resolve()) not in os.environ["PATH"]  # real env untouched


def test_no_dll_dir_leaves_path_unchanged():
    with tempfile.TemporaryDirectory() as tmp:
        env = {"PATH": "X"}
        CogneeAdapter(load_knowledge(), settings=_settings(tmp))._prepare_environment(environ=env)
        assert env["PATH"] == "X" and "LLM_INSTRUCTOR_MODE" not in env


# --- Improvement 2: Ollama defaults ---------------------------------------------

def test_ollama_defaults_placeholder_key_and_json_schema_mode():
    s = CogneeSettings.from_env({"LLM_PROVIDER": "ollama", "EMBEDDING_PROVIDER": "ollama"})
    assert s.llm_api_key == "ollama" and s.llm_api_key_placeholder is True
    assert s.llm_instructor_mode == "json_schema_mode"
    s.validate()
    pub = s.public_dict()
    assert pub["llm_api_key_placeholder"] is True and pub["llm_instructor_mode"] == "json_schema_mode"


def test_ollama_explicit_key_and_mode_are_respected():
    s = CogneeSettings.from_env({"LLM_PROVIDER": "ollama", "LLM_API_KEY": "real-key",
                                 "LLM_INSTRUCTOR_MODE": "JSON_MODE", "EMBEDDING_PROVIDER": "ollama"})
    assert s.llm_api_key == "real-key" and s.llm_api_key_placeholder is False
    assert s.llm_instructor_mode == "json_mode"


def test_non_ollama_providers_get_no_ollama_defaults():
    s = CogneeSettings.from_env({"LLM_API_KEY": SECRET})
    assert s.llm_instructor_mode is None and s.llm_api_key_placeholder is False
    _raises(lambda: CogneeSettings.from_env({}).validate(), CogneeConfigError, "LLM_API_KEY")


def test_placeholder_key_is_never_used_for_hosted_embeddings():
    # Ollama LLM + hosted embeddings: the "ollama" placeholder must not be sent to e.g. OpenAI.
    s = CogneeSettings.from_env({"LLM_PROVIDER": "ollama", "EMBEDDING_PROVIDER": "openai"})
    assert s.embedding_api_key is None
    _raises(s.validate, CogneeConfigError, "EMBEDDING_API_KEY")


def test_invalid_instructor_mode_rejected_and_allowed_modes_exist_in_instructor():
    import instructor
    from src.memory.cognee_adapter import INSTRUCTOR_MODES
    _raises(lambda: CogneeSettings.from_env({"LLM_PROVIDER": "ollama", "LLM_INSTRUCTOR_MODE": "magic"}),
            CogneeConfigError, "LLM_INSTRUCTOR_MODE")
    assert INSTRUCTOR_MODES <= {m.value for m in instructor.Mode}


def test_ollama_placeholder_key_exported_to_environment_before_import():
    # Cognee's LLMConfig validator reads os.environ and rejects LLM_MODEL/LLM_ENDPOINT without LLM_API_KEY.
    with tempfile.TemporaryDirectory() as tmp:
        s = CogneeSettings.from_env({"LLM_PROVIDER": "ollama", "LLM_MODEL": "llama3.1:8b",
                                     "LLM_ENDPOINT": "http://localhost:11434/v1", "EMBEDDING_PROVIDER": "ollama",
                                     "CBDC_COGNEE_ROOT": tmp})
        env = {"LLM_MODEL": "llama3.1:8b", "LLM_ENDPOINT": "http://localhost:11434/v1"}
        real_before = os.environ.get("LLM_API_KEY")
        CogneeAdapter(load_knowledge(), settings=s)._prepare_environment(environ=env)
        assert env["LLM_API_KEY"] == "ollama"
        assert all(env.get(k) for k in ("LLM_MODEL", "LLM_ENDPOINT", "LLM_API_KEY"))  # Cognee's all-or-none rule
        assert os.environ.get("LLM_API_KEY") == real_before  # injected env only; real environment untouched


def test_real_or_existing_llm_key_is_never_overwritten_and_hosted_exports_nothing():
    with tempfile.TemporaryDirectory() as tmp:
        # User-supplied key: no placeholder, nothing exported by the adapter.
        s = CogneeSettings.from_env({"LLM_PROVIDER": "ollama", "LLM_API_KEY": "real-key",
                                     "EMBEDDING_PROVIDER": "ollama", "CBDC_COGNEE_ROOT": tmp})
        env = {"LLM_API_KEY": "real-key"}
        CogneeAdapter(load_knowledge(), settings=s)._prepare_environment(environ=env)
        assert env["LLM_API_KEY"] == "real-key"
        # Placeholder settings but a key already present in the target environment: keep it.
        s2 = CogneeSettings.from_env({"LLM_PROVIDER": "ollama", "EMBEDDING_PROVIDER": "ollama", "CBDC_COGNEE_ROOT": tmp})
        env2 = {"LLM_API_KEY": "preexisting"}
        CogneeAdapter(load_knowledge(), settings=s2)._prepare_environment(environ=env2)
        assert env2["LLM_API_KEY"] == "preexisting"
        # Hosted provider: adapter never writes an API key into the environment.
        env3 = {}
        CogneeAdapter(load_knowledge(), settings=_settings(tmp))._prepare_environment(environ=env3)
        assert "LLM_API_KEY" not in env3


def test_instructor_mode_and_key_applied_to_cognee_config():
    with tempfile.TemporaryDirectory() as tmp:
        fake = FakeCognee()
        s = CogneeSettings.from_env({"LLM_PROVIDER": "ollama", "EMBEDDING_PROVIDER": "ollama", "CBDC_COGNEE_ROOT": tmp})
        CogneeAdapter(_two_fact_kb(), settings=s, cognee_module=fake).ingest()
        cfg = {c[0]: c[1] for c in fake.calls if c[0].startswith("config.")}
        assert cfg["config.set_llm_config"] == ({"llm_instructor_mode": "json_schema_mode"},)
        assert cfg["config.set_llm_api_key"] == ("ollama",) and cfg["config.set_llm_provider"] == ("ollama",)
        manifest = json.loads((Path(tmp).resolve() / f"manifest_{dataset_name_for(_two_fact_kb())}.json")
                              .read_text(encoding="utf-8"))
        assert manifest["settings"]["llm_api_key_placeholder"] is True


# --- Improvement 3: clean chunk text ----------------------------------------------

# Shape observed from live Cognee 1.4.2 CHUNKS search (smoke test, 2026-11-02).
LIVE_SHAPE = {"dataset_id": "1967bb66-d577-5cdc-95e7-4be297fb166f", "dataset_name": "cbdc_knowledge_x",
              "dataset_tenant_id": None,
              "search_result": [{"id": "2dfd30b6", "type": "IndexSchema", "feedback_weight": 0.5,
                                 "text": "fact_id: cap\nrule_type: max_single_transfer_usd\nrule: max 1000",
                                 "document_id": "b500b229", "document_name": "text_f4c9", "chunk_index": 0},
                                {"id": "3eef", "text": "fact_id: block_are_mex\nrule: restricted",
                                 "document_id": "c600", "chunk_index": 1}]}


def test_flatten_extracts_clean_chunk_text_and_metadata():
    from src.memory.cognee_adapter import flatten_search_results
    items = flatten_search_results([LIVE_SHAPE])
    assert [i["text"] for i in items] == [c["text"] for c in LIVE_SHAPE["search_result"]]
    assert items[0]["chunk_id"] == "2dfd30b6" and items[0]["document_id"] == "b500b229"
    assert items[1]["chunk_index"] == 1 and all(i["dataset_name"] == "cbdc_knowledge_x" for i in items)
    assert all(i["text_source"] == "chunk.text" for i in items)
    assert all("dataset_id" not in i["text"] and "feedback_weight" not in i["text"] for i in items)


def test_flatten_handles_searchresult_objects_strings_and_unknown_payloads():
    from src.memory.cognee_adapter import flatten_search_results
    obj = SimpleNamespace(search_result=[{"text": "fact_id: cap"}], dataset_name="ds")
    items = flatten_search_results([obj, "plain fact_id: cap", {"no_text": 1}, SimpleNamespace(search_result=None)])
    assert [i["text_source"] for i in items] == ["chunk.text", "string", "serialized", "serialized"]
    assert items[0]["dataset_name"] == "ds" and items[1]["text"] == "plain fact_id: cap"
    assert flatten_search_results(None) == [] and flatten_search_results([]) == []


def test_grounding_uses_clean_chunk_text_from_live_shape():
    with tempfile.TemporaryDirectory() as tmp:
        ad = CogneeAdapter(_two_fact_kb(), settings=_settings(tmp), cognee_module=FakeCognee(search_results=[LIVE_SHAPE]))
        out = ad.retrieve("limits?")
        assert len(out["results"]) == 2 and out["results"][0]["text"].startswith("fact_id: cap")
        assert out["results"][0]["fact_ids"] == ["cap"] and out["results"][1]["fact_ids"] == ["block_are_mex"]
        assert out["grounded_fact_ids"] == ["block_are_mex", "cap"] and out["ungrounded_result_count"] == 0


def test_explanation_decisions_unchanged_with_live_shape_results():
    kb = _two_fact_kb()
    static = StaticMemoryProvider(knowledge=kb)
    with tempfile.TemporaryDirectory() as tmp:
        prov = CogneeExplanationProvider(static=static, adapter=CogneeAdapter(
            kb, settings=_settings(tmp), cognee_module=FakeCognee(search_results=[LIVE_SHAPE])))
        for s, r, a, d in [("USA", "IND", 10.0, None), ("ARE", "MEX", 10.0, "2024-06-01"), ("GBR", "PHL", 5000.0, None)]:
            assert prov.check_transaction(s, r, a, d) == static.check_transaction(s, r, a, d)
            e, st = prov.explain(s, r, a, d), static.explain(s, r, a, d)
            assert (e["allowed"], e["reason"], e["decisive_fact_ids"]) == (st["allowed"], st["reason"], st["decisive_fact_ids"])


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
