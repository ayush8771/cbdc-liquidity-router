"""The boundary controls this component owns (AD-6 B-1, B-3; AD-1 §1, §2).

AD-6 B-3 requires that the ingestion component and the engine do not import each
other, and AD-6 B-1 that `usage` is `display_only` in every envelope with no
bridge-state event type. AD-1 §1 adds that ingestion must not contact any
external host, inference or PostgreSQL, mount project files, or hold a secret.

These are source-level and behavioural checks over this component only. They are
**not** AD-6 T-5: that test runs from inside each container and belongs with the
Compose overlay (Dev D), and it is claimed for the ingestion side only in this
slice (AD-1 §6 item 5, D-25). The import rules for the backend's own modules
(B-3's Express half) are Dev B's.
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

import pytest

from cbdc_ingestion.clock import ManualClock
from cbdc_ingestion.generator import FxGenerator

from .conftest import SEED, SERVICE_ROOT, START_MS

PACKAGE = SERVICE_ROOT / "cbdc_ingestion"
SOURCES = sorted(PACKAGE.glob("*.py"))

# Modules a component that talks to nothing has no business importing. `http.server`
# is the one network module it does use: it *serves* a private endpoint and never
# opens an outbound connection (AD-1 §3.1).
FORBIDDEN_IMPORTS = {
    "socket", "ssl", "http.client", "urllib", "urllib.request", "requests", "httpx", "aiohttp",
    "websockets", "psycopg", "psycopg2", "asyncpg", "sqlalchemy", "torch", "pandas", "numpy",
    "fastapi", "uvicorn", "subprocess", "dotenv", "boto3",
}
# Phase 1 and the other Phase 2 services. Not importable from here, by AD-6 B-3.
FORBIDDEN_PREFIXES = ("src.", "cbdc_inference", "services.")


def code_only(path: Path) -> str:
    """The module's executable code, with comments and every docstring removed.

    Docstrings in this component legitimately quote AD-4's `source_url` field, the
    local endpoint and the word "secret" (as in "holds no secret"), so a text
    search over the raw file would flag the documentation rather than the code.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        body = node.body
        if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) \
                and isinstance(body[0].value.value, str):
            node.body = body[1:] or [ast.Pass()]
    return ast.unparse(ast.fix_missing_locations(tree))


def imported_names(path: Path) -> set:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module)
    return names


def test_there_are_sources_to_check():
    assert len(SOURCES) >= 8, SOURCES


@pytest.mark.parametrize("path", SOURCES, ids=lambda p: p.name)
def test_no_module_imports_a_client_a_database_or_phase_1(path: Path):
    for name in imported_names(path):
        root = name.split(".")[0]
        assert name not in FORBIDDEN_IMPORTS and root not in FORBIDDEN_IMPORTS, \
            f"{path.name} imports {name}"
        assert not name.startswith(FORBIDDEN_PREFIXES), f"{path.name} imports {name} (AD-6 B-3)"


def test_the_package_imports_nothing_from_phase_1_or_inference_at_runtime():
    """Importing every module must not pull in a Phase 1 or inference module."""
    import importlib

    for path in SOURCES:
        if path.name == "__main__.py":
            continue  # it would run the server
        importlib.import_module(f"cbdc_ingestion.{path.stem}" if path.stem != "__init__"
                                else "cbdc_ingestion")
    leaked = [name for name in sys.modules
              if name == "src" or name.startswith(("src.", "cbdc_inference", "torch"))]
    assert leaked == [], leaked


def test_no_source_names_an_external_host_or_a_credential():
    """There is no provider URL, token, key or password anywhere in the component."""
    suspicious = ("https://", "http://localhost", "api_key", "apikey", "secret", "password",
                  "token", "Authorization", "Bearer")
    for path in SOURCES:
        code = code_only(path)
        for needle in suspicious:
            assert needle.lower() not in code.lower(), f"{path.name} mentions {needle!r}"


def test_every_event_is_display_only_with_no_bridge_state_field(envelope_schema):
    """AD-6 B-1: `usage` is display_only and no bridge-state event type exists."""
    generator = FxGenerator(SEED, ManualClock(START_MS), start_ms=START_MS)
    events = [e for ms in range(0, 8000, 250) for e in generator.due(START_MS + ms)]
    assert events
    for event in events:
        assert event["usage"] == "display_only"
        assert event["event_type"] == "fx_rate"
        assert set(event["payload"]) == {"base_currency", "quote_currency", "rate", "rate_type"}
        # Nothing that could be read as bridge state, an allocation or a routing result.
        for forbidden in ("liquidity", "congestion", "bridge", "allocation", "fee", "risk",
                          "decision_id", "policy", "reward"):
            assert forbidden not in str(event).lower(), forbidden
    # The envelope schema defines no bridge-state event type either (AD-4 §1).
    assert envelope_schema["properties"]["event_type"]["enum"] == [
        "fx_rate", "economic_indicator", "announcement", "bank_holiday"]
    assert envelope_schema["properties"]["usage"]["const"] == "display_only"


def test_the_component_writes_no_file():
    """`open` for writing appears nowhere: the store is in memory and a restart
    may lose it (AD-1 §3), and the container root filesystem is read-only (P-6)."""
    for path in SOURCES:
        code = code_only(path)
        for needle in ("open(", "write_text", "Path(", "os.remove", "shutil"):
            assert needle not in code, f"{path.name} touches the filesystem: {needle}"
