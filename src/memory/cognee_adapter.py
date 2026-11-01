"""Stage 1E step 2 - Cognee adapter (semantic retrieval for explanations ONLY).

Role and boundaries
-------------------
* StaticMemoryProvider (deterministic, knowledge-file based) stays the ONLY
  authority for feasibility. CogneeExplanationProvider.check_transaction and
  get_context delegate to it unchanged; Cognee output can only ever be added
  to explain() as `semantic_context`, never alter a decision.
* Cognee is never imported by the environment, PPO training, CNN or
  evaluation code. It is imported lazily, only when an adapter method that
  needs it is called.
* Retrieval is grounded: retrieved text is mapped back to known fact_ids in
  the knowledge base; text that cites no known fact is reported as ungrounded.

Configuration (environment variables; Cognee's own names, applied explicitly)
------------------------------------------------------------------------------
    LLM_PROVIDER          default "openai"     (e.g. "openai", "ollama", "anthropic", "custom")
    LLM_MODEL             default Cognee's      (e.g. "openai/gpt-5-mini", "llama3.1:8b")
    LLM_ENDPOINT          optional              (e.g. "http://localhost:11434/v1" for Ollama)
    LLM_API_KEY           required unless LLM_PROVIDER is "ollama"; for Ollama a placeholder
                          ("ollama") is used when unset, because Cognee rejects an empty key
    LLM_INSTRUCTOR_MODE   optional; for Ollama defaults to "json_schema_mode" (schema-constrained
                          output - Cognee's own Ollama default "json_mode" fails schema validation
                          with small local models)
    EMBEDDING_PROVIDER    default "openai"     (e.g. "openai", "ollama", "fastembed")
    EMBEDDING_MODEL       default Cognee's
    EMBEDDING_ENDPOINT    optional
    EMBEDDING_DIMENSIONS  optional integer
    EMBEDDING_API_KEY     optional; falls back to LLM_API_KEY for hosted providers
    CBDC_COGNEE_ROOT      default "<repo>/.cognee" (git-ignored); holds system/ and data/
    CBDC_COGNEE_TELEMETRY set to "1" to allow Cognee telemetry (disabled by default)
    CBDC_COGNEE_DLL_DIR   optional (Windows); a directory appended to PATH before Cognee is
                          imported, e.g. one containing OpenSSL 3 libssl-3-x64.dll /
                          libcrypto-3-x64.dll needed by the graph DB's json extension
                          ("C:\\Program Files\\Git\\mingw64\\bin"). PATH (not only
                          os.add_dll_directory) is required because Cognee opens the graph
                          database in a worker subprocess.

API keys are never written to logs, manifests or explanation output.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .knowledge import Fact, KnowledgeBase
from .provider import StaticMemoryProvider

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_COGNEE_ROOT = REPO_ROOT / ".cognee"
DATASET_PREFIX = "cbdc_knowledge"
LOCAL_PROVIDERS = {"ollama", "fastembed"}  # no real API key needed
OLLAMA_PLACEHOLDER_API_KEY = "ollama"  # Cognee requires a non-empty key even for Ollama; Ollama ignores it
OLLAMA_DEFAULT_INSTRUCTOR_MODE = "json_schema_mode"
# Accepted overrides for an OpenAI-compatible endpoint (values of instructor.Mode in instructor 1.15.1).
INSTRUCTOR_MODES = {"json_mode", "json_schema_mode", "tool_call", "markdown_json_mode"}
FACT_ID_PATTERN = re.compile(r"fact_id:\s*([A-Za-z0-9_.\-]+)")


class CogneeConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class CogneeSettings:
    llm_provider: str = "openai"
    llm_model: Optional[str] = None
    llm_endpoint: Optional[str] = None
    llm_api_key: Optional[str] = field(default=None, repr=False)
    llm_api_key_placeholder: bool = False
    llm_instructor_mode: Optional[str] = None
    embedding_provider: str = "openai"
    embedding_model: Optional[str] = None
    embedding_endpoint: Optional[str] = None
    embedding_dimensions: Optional[int] = None
    embedding_api_key: Optional[str] = field(default=None, repr=False)
    root: Path = DEFAULT_COGNEE_ROOT
    telemetry: bool = False
    dll_dir: Optional[Path] = None

    @classmethod
    def from_env(cls, env=None) -> "CogneeSettings":
        env = os.environ if env is None else env
        get = lambda k: (env.get(k) or "").strip() or None  # noqa: E731
        dims = get("EMBEDDING_DIMENSIONS")
        if dims is not None:
            try:
                dims = int(dims)
            except ValueError as e:
                raise CogneeConfigError(f"EMBEDDING_DIMENSIONS must be an integer, got {dims!r}") from e
            if dims <= 0:
                raise CogneeConfigError("EMBEDDING_DIMENSIONS must be positive")
        llm_provider = (get("LLM_PROVIDER") or "openai").lower()
        llm_key = get("LLM_API_KEY")
        placeholder = False
        if llm_key is None and llm_provider == "ollama":
            llm_key, placeholder = OLLAMA_PLACEHOLDER_API_KEY, True
        mode = (get("LLM_INSTRUCTOR_MODE") or "").lower() or None
        if mode is None and llm_provider == "ollama":
            mode = OLLAMA_DEFAULT_INSTRUCTOR_MODE
        if mode is not None and mode not in INSTRUCTOR_MODES:
            raise CogneeConfigError(f"LLM_INSTRUCTOR_MODE must be one of {sorted(INSTRUCTOR_MODES)}, got {mode!r}")
        dll_dir = get("CBDC_COGNEE_DLL_DIR")
        emb_provider = (get("EMBEDDING_PROVIDER") or "openai").lower()
        return cls(
            llm_provider=llm_provider,
            llm_model=get("LLM_MODEL"), llm_endpoint=get("LLM_ENDPOINT"), llm_api_key=llm_key,
            llm_api_key_placeholder=placeholder, llm_instructor_mode=mode,
            embedding_provider=emb_provider, embedding_model=get("EMBEDDING_MODEL"),
            embedding_endpoint=get("EMBEDDING_ENDPOINT"), embedding_dimensions=dims,
            embedding_api_key=get("EMBEDDING_API_KEY") or (
                None if emb_provider in LOCAL_PROVIDERS or placeholder else llm_key),
            root=Path(get("CBDC_COGNEE_ROOT") or DEFAULT_COGNEE_ROOT).resolve(),
            telemetry=get("CBDC_COGNEE_TELEMETRY") == "1",
            dll_dir=None if dll_dir is None else Path(dll_dir).resolve(),
        )

    def validate(self) -> None:
        if self.llm_provider not in LOCAL_PROVIDERS and not self.llm_api_key:
            raise CogneeConfigError(f"LLM_API_KEY is required for LLM_PROVIDER={self.llm_provider!r}")
        if self.embedding_provider not in LOCAL_PROVIDERS and not self.embedding_api_key:
            raise CogneeConfigError(
                f"EMBEDDING_API_KEY (or LLM_API_KEY) is required for EMBEDDING_PROVIDER={self.embedding_provider!r}")
        if self.dll_dir is not None and not self.dll_dir.is_dir():
            raise CogneeConfigError(f"CBDC_COGNEE_DLL_DIR is not an existing directory: {self.dll_dir}")

    @property
    def system_root(self) -> Path:
        return self.root / "system"

    @property
    def data_root(self) -> Path:
        return self.root / "data"

    def public_dict(self) -> dict:
        """Non-secret settings for manifests/provenance (keys reported only as present/absent)."""
        return {
            "llm_provider": self.llm_provider, "llm_model": self.llm_model, "llm_endpoint": self.llm_endpoint,
            "llm_api_key_set": bool(self.llm_api_key), "llm_api_key_placeholder": self.llm_api_key_placeholder,
            "llm_instructor_mode": self.llm_instructor_mode,
            "embedding_provider": self.embedding_provider, "embedding_model": self.embedding_model,
            "embedding_endpoint": self.embedding_endpoint, "embedding_dimensions": self.embedding_dimensions,
            "embedding_api_key_set": bool(self.embedding_api_key),
            "root": str(self.root), "telemetry": self.telemetry,
            "dll_dir": None if self.dll_dir is None else str(self.dll_dir),
        }


def append_to_path(path_value: str, directory) -> str:
    """Append `directory` to a PATH string (os.pathsep-separated) unless already present
    (case-insensitive on Windows). Appending, not prepending, so it never shadows existing DLLs."""
    directory = str(directory)
    parts = [p for p in (path_value or "").split(os.pathsep) if p]
    norm = (lambda p: os.path.normcase(os.path.normpath(p)))
    if any(norm(p) == norm(directory) for p in parts):
        return path_value
    return os.pathsep.join(parts + [directory])


def flatten_search_results(raw_results) -> list:
    """Normalise Cognee search output into one dict per retrieved item.

    Cognee 1.4.2 returns, per dataset, either a SearchResult object or a dict
    with `search_result` = list of chunk dicts (each with a clean `text` field
    plus id/document metadata). Strings and other payloads are kept as text.
    """
    items = []
    for r in raw_results or []:
        if isinstance(r, dict) and "search_result" in r:
            payload, dataset = r["search_result"], r.get("dataset_name")
        elif hasattr(r, "search_result"):
            payload, dataset = r.search_result, getattr(r, "dataset_name", None)
        else:
            payload, dataset = r, None
        for chunk in (payload if isinstance(payload, list) else [payload]):
            if isinstance(chunk, dict) and isinstance(chunk.get("text"), str):
                items.append({"text": chunk["text"], "chunk_id": chunk.get("id"),
                              "document_id": chunk.get("document_id"), "chunk_index": chunk.get("chunk_index"),
                              "dataset_name": dataset, "text_source": "chunk.text"})
            elif isinstance(chunk, str):
                items.append({"text": chunk, "chunk_id": None, "document_id": None, "chunk_index": None,
                              "dataset_name": dataset, "text_source": "string"})
            else:
                items.append({"text": json.dumps(chunk, default=str), "chunk_id": None, "document_id": None,
                              "chunk_index": None, "dataset_name": dataset, "text_source": "serialized"})
    return items


def fact_to_document(fact: Fact) -> str:
    """Deterministic text rendering of one fact; `fact_id:` lets retrieval be mapped back."""
    scope = f"{fact.sender} -> {fact.receiver}".replace("*", "any country")
    eff_from = fact.effective_from.strftime("%Y-%m-%d") if fact.effective_from is not None else "unbounded"
    eff_to = fact.effective_to.strftime("%Y-%m-%d") if fact.effective_to is not None else "unbounded"
    if fact.rule_type == "max_single_transfer_usd":
        rule = f"A single cross-border transfer must not exceed {fact.value:,.2f} USD."
    else:
        rule = f"Transfers on the corridor {fact.sender} -> {fact.receiver} are restricted."
    return "\n".join([
        f"fact_id: {fact.fact_id}",
        f"rule_type: {fact.rule_type}",
        f"rule: {rule}",
        f"corridor scope: {scope}",
        f"effective: {eff_from} to {eff_to}",
        f"provenance: {fact.provenance_tag} (verified: {str(fact.verified).lower()})",
        f"source: {fact.source}",
    ] + ([f"notes: {fact.notes}"] if fact.notes else []))


def dataset_name_for(knowledge: KnowledgeBase) -> str:
    """Content-addressed dataset name, so a changed knowledge file never mixes with stale data."""
    digest = (knowledge.sha256 or "nohash")[:12]
    return f"{DATASET_PREFIX}_{digest}"


def _run(make_coro):
    """Run a coroutine factory synchronously. The coroutine is created only after
    confirming no event loop is running, so a refused call leaks nothing."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(make_coro())
    raise RuntimeError("CogneeAdapter sync methods cannot run inside an active event loop; use the async_* methods.")


class CogneeAdapter:
    """Thin, lazily-imported wrapper around Cognee for ingestion and retrieval."""

    def __init__(self, knowledge: KnowledgeBase, settings: Optional[CogneeSettings] = None, cognee_module=None):
        self.knowledge = knowledge
        self.settings = settings if settings is not None else CogneeSettings.from_env()
        self._cognee = cognee_module  # injected in tests; otherwise imported lazily
        self._configured = False
        self.dataset_name = dataset_name_for(knowledge)

    # -- setup -------------------------------------------------------------------
    def _module(self):
        if self._cognee is None:
            self.settings.validate()
            self._prepare_environment()
            import cognee  # noqa: PLC0415 - deliberate lazy import
            self._cognee = cognee
        if not self._configured:
            self._apply_config(self._cognee)
            self._configured = True
        return self._cognee

    def _prepare_environment(self, environ=None):
        """Must run BEFORE `import cognee`: its settings read these at import time.
        `environ` defaults to os.environ (injectable for tests)."""
        env = os.environ if environ is None else environ
        s = self.settings
        s.system_root.mkdir(parents=True, exist_ok=True)
        s.data_root.mkdir(parents=True, exist_ok=True)
        env["SYSTEM_ROOT_DIRECTORY"] = str(s.system_root)
        env["DATA_ROOT_DIRECTORY"] = str(s.data_root)
        if not s.telemetry:
            env["TELEMETRY_DISABLED"] = "1"
        if s.llm_instructor_mode:
            env["LLM_INSTRUCTOR_MODE"] = s.llm_instructor_mode
        if s.llm_api_key_placeholder and not env.get("LLM_API_KEY"):
            # Cognee's LLMConfig validator reads os.environ at construction (inside the first
            # config setter) and rejects LLM_MODEL/LLM_ENDPOINT without LLM_API_KEY, so the
            # Ollama placeholder must be in the environment, not only passed via set_llm_api_key.
            env["LLM_API_KEY"] = OLLAMA_PLACEHOLDER_API_KEY
        if s.dll_dir is not None:
            # PATH is inherited by Cognee's graph-DB worker subprocess; os.add_dll_directory is not.
            env["PATH"] = append_to_path(env.get("PATH", ""), s.dll_dir)
            if environ is None and hasattr(os, "add_dll_directory"):
                self._dll_handle = os.add_dll_directory(str(s.dll_dir))  # keep handle alive

    def _apply_config(self, cognee):
        s = self.settings
        cfg = cognee.config
        cfg.system_root_directory(str(s.system_root))
        cfg.data_root_directory(str(s.data_root))
        cfg.set_llm_provider(s.llm_provider)
        if s.llm_model:
            cfg.set_llm_model(s.llm_model)
        if s.llm_endpoint:
            cfg.set_llm_endpoint(s.llm_endpoint)
        if s.llm_api_key:
            cfg.set_llm_api_key(s.llm_api_key)
        if s.llm_instructor_mode:
            cfg.set_llm_config({"llm_instructor_mode": s.llm_instructor_mode})
        cfg.set_embedding_provider(s.embedding_provider)
        if s.embedding_model:
            cfg.set_embedding_model(s.embedding_model)
        if s.embedding_endpoint:
            cfg.set_embedding_endpoint(s.embedding_endpoint)
        if s.embedding_dimensions:
            cfg.set_embedding_dimensions(s.embedding_dimensions)
        if s.embedding_api_key:
            cfg.set_embedding_api_key(s.embedding_api_key)

    # -- ingestion ---------------------------------------------------------------
    def documents(self) -> list:
        return [fact_to_document(f) for f in self.knowledge.facts]

    async def async_ingest(self) -> dict:
        cognee = self._module()
        docs = self.documents()
        if not docs:
            raise ValueError("knowledge base has no facts to ingest")
        await cognee.add(docs, dataset_name=self.dataset_name)
        await cognee.cognify(datasets=[self.dataset_name])
        manifest = {
            "dataset_name": self.dataset_name,
            "knowledge_version": self.knowledge.knowledge_version,
            "knowledge_sha256": self.knowledge.sha256,
            "knowledge_path": self.knowledge.source_path,
            "fact_ids": [f.fact_id for f in self.knowledge.facts],
            "ingested_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "settings": self.settings.public_dict(),
        }
        self.settings.root.mkdir(parents=True, exist_ok=True)
        (self.settings.root / f"manifest_{self.dataset_name}.json").write_text(
            json.dumps(manifest, indent=2), encoding="utf-8")
        return manifest

    def ingest(self) -> dict:
        return _run(self.async_ingest)

    # -- retrieval ---------------------------------------------------------------
    async def async_retrieve(self, query: str, top_k: int = 5, search_type: str = "CHUNKS") -> dict:
        cognee = self._module()
        query_type = getattr(cognee.SearchType, search_type)
        raw = await cognee.search(query_text=query, query_type=query_type,
                                  datasets=[self.dataset_name], top_k=top_k)
        return self.ground(query, raw, search_type)

    def retrieve(self, query: str, top_k: int = 5, search_type: str = "CHUNKS") -> dict:
        return _run(lambda: self.async_retrieve(query, top_k=top_k, search_type=search_type))

    def ground(self, query: str, raw_results, search_type: str) -> dict:
        """Map retrieved text back to knowledge-base facts. Unknown fact_ids are
        reported, never trusted."""
        items = []
        for it in flatten_search_results(raw_results):
            cited = list(dict.fromkeys(FACT_ID_PATTERN.findall(it["text"])))
            items.append({
                **it,
                "text": it["text"][:2000],
                "fact_ids": [i for i in cited if i in self.knowledge.by_id],
                "unknown_fact_ids": [i for i in cited if i not in self.knowledge.by_id],
            })
        grounded = sorted({i for it in items for i in it["fact_ids"]})
        return {
            "query": query, "search_type": search_type, "dataset_name": self.dataset_name,
            "knowledge_sha256": self.knowledge.sha256, "results": items,
            "grounded_fact_ids": grounded,
            "grounded_facts": [self.knowledge.by_id[i].to_dict() for i in grounded],
            "ungrounded_result_count": sum(1 for it in items if not it["fact_ids"]),
        }


class CogneeExplanationProvider:
    """MemoryProvider whose decisions come ONLY from StaticMemoryProvider.

    explain() = the static explanation, plus best-effort `semantic_context`
    retrieved via Cognee. A Cognee failure never changes or blocks the
    decision; it is recorded as `semantic_context.error`.
    """

    def __init__(self, static: Optional[StaticMemoryProvider] = None, adapter: Optional[CogneeAdapter] = None,
                 top_k: int = 5):
        self.static = static if static is not None else StaticMemoryProvider()
        self.adapter = adapter if adapter is not None else CogneeAdapter(self.static.knowledge)
        if self.adapter.knowledge.sha256 != self.static.knowledge.sha256:
            raise ValueError("adapter and static provider must use the same knowledge base")
        self.top_k = top_k

    def check_transaction(self, sender, receiver, amount, simulation_date=None):
        return self.static.check_transaction(sender, receiver, amount, simulation_date)

    def get_context(self, sender, receiver, simulation_date=None):
        return self.static.get_context(sender, receiver, simulation_date)

    @staticmethod
    def build_query(sender, receiver, amount, simulation_date=None) -> str:
        when = f" on {simulation_date}" if simulation_date is not None else ""
        return (f"Which rules, transfer limits or corridor restrictions apply to a {float(amount):,.2f} USD "
                f"cross-border transfer from {sender} to {receiver}{when}?")

    def explain(self, sender, receiver, amount, simulation_date=None) -> dict:
        out = self.static.explain(sender, receiver, amount, simulation_date)
        out["provider"] = type(self).__name__
        out["decision_source"] = "StaticMemoryProvider"
        query = self.build_query(sender, receiver, amount, simulation_date)
        try:
            out["semantic_context"] = self.adapter.retrieve(query, top_k=self.top_k)
        except Exception as e:  # noqa: BLE001 - retrieval is advisory only
            out["semantic_context"] = {"query": query, "error": f"{type(e).__name__}: {e}"}
        return out
