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
import re
import sys
from pathlib import Path

import pytest

from cbdc_ingestion.clock import ManualClock
from cbdc_ingestion.generator import FxGenerator

from .conftest import SEED, SERVICE_ROOT, START_MS

PACKAGE = SERVICE_ROOT / "cbdc_ingestion"
# **Recursive, deliberately.** A top-level glob would leave the whole `adapters/`
# subpackage unchecked — `base.py`, `registry.py`, `context.py`, `faults.py` and
# every adapter — which is precisely the code acceptance criterion 12 names ("the
# adapter package imports nothing from `src/`, `services/inference/` or any
# database client"). The boundary is only as wide as the file set it is asserted
# over, so the set is the package.
SOURCES = sorted(PACKAGE.rglob("*.py"))


def module_name(path: Path) -> str:
    """The importable name for a source file anywhere in the package."""
    relative = path.relative_to(PACKAGE.parent).with_suffix("")
    parts = [part for part in relative.parts if part != "__init__"]
    return ".".join(parts)

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
    """A floor, so a glob that silently stopped matching fails instead of
    vacuously passing. Raised past the top-level count, which is what caught the
    subpackage being excluded in the first place."""
    assert len(SOURCES) >= 20, SOURCES
    assert any(path.parent.name == "adapters" for path in SOURCES),         "the adapters subpackage must be inside the boundary check (criterion 12)"


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
        importlib.import_module(module_name(path))
    leaked = [name for name in sys.modules
              if name == "src" or name.startswith(("src.", "cbdc_inference", "torch"))]
    assert leaked == [], leaked


# Plain substrings: none of these has an innocent reading in this component.
SUSPICIOUS = ("https://", "http://localhost", "api_key", "apikey", "secret", "password",
              "bearer")

# `Authorization` needs a pattern rather than a substring. The **HTTP header** is
# forbidden; the English word is not, and `registry.py` legitimately cites "the
# Phase 3.3-A authorization" in a refusal message. The header only ever appears
# as a quoted string or a header line, so that is what is matched — a substring
# check here would flag the citation and, worse, would invite someone to delete
# the control rather than the citation.
HEADER_PATTERN = re.compile(r"""["']Authorization["']|Authorization\s*:""", re.IGNORECASE)

# `token` likewise: a credential token is forbidden, but the word appears in
# ordinary technical prose. Matched where it would name a value.
TOKEN_PATTERN = re.compile(r"""(access|auth|bearer|api|refresh|id)[_-]?token|token["']?\s*[:=]""",
                           re.IGNORECASE)


def test_no_source_names_an_external_host_or_a_credential():
    """There is no provider URL, token, key or password anywhere in the component.

    Asserted over the **whole** package, the `adapters/` subpackage included: a
    credential reaching the component would most plausibly arrive in an adapter,
    which is exactly where a top-level-only glob was not looking.
    """
    for path in SOURCES:
        code = code_only(path)
        for needle in SUSPICIOUS:
            assert needle not in code.lower(), f"{path.name} mentions {needle!r}"
        assert HEADER_PATTERN.search(code) is None, f"{path.name} names the Authorization header"
        assert TOKEN_PATTERN.search(code) is None, f"{path.name} names a token value"


def test_the_host_and_token_patterns_actually_match_what_they_claim():
    """The two patterns are narrower than a substring search, so they are tested
    against both a breach and the innocent text they must not flag. Without this
    a typo in either pattern would make the control above silently vacuous."""
    assert HEADER_PATTERN.search("headers = {'Authorization': 'x'}")
    assert HEADER_PATTERN.search("raw = 'Authorization: Bearer x'")
    assert HEADER_PATTERN.search("the Phase 3.3-A authorization §8 items 1 and 2") is None
    assert TOKEN_PATTERN.search("access_token = resolve()")
    assert TOKEN_PATTERN.search("a tokenized stream of values") is None


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


# Every way this package could write, delete or move a file. **Reading is not
# here**, deliberately: §7.4 puts the registry records inside the package and
# `adapters/registry.py` reads them at startup, which is the approved
# arrangement. The claim this control makes is that nothing is **written** — the
# store is in memory and a restart may lose it (AD-1 §3), and the container root
# filesystem is read-only (P-6).
WRITE_NEEDLES = ("write_text", "write_bytes", "os.remove", "os.rename", "os.replace",
                 "os.makedirs", "shutil", "mkdir", "unlink", "touch", "NamedTemporary",
                 "mkstemp", "mkdtemp")
# `open(...)` is permitted for reading only, so the mode is what is checked.
OPEN_FOR_WRITING = re.compile(r"""open\([^)]*["'][rwax+bt]*[wax+]""")


def test_the_component_writes_no_file():
    """No write, no delete, no rename, anywhere in the package."""
    for path in SOURCES:
        code = code_only(path)
        for needle in WRITE_NEEDLES:
            assert needle not in code, f"{path.name} writes to the filesystem: {needle}"
        assert OPEN_FOR_WRITING.search(code) is None, f"{path.name} opens a file for writing"


def test_the_write_pattern_actually_matches_a_write():
    """The mode-aware check is narrower than forbidding `open(` outright, so both
    sides are asserted: a write mode is caught and a read mode is allowed."""
    assert OPEN_FOR_WRITING.search("open(path, 'w')")
    assert OPEN_FOR_WRITING.search("open(path, 'ab')")
    assert OPEN_FOR_WRITING.search("open(path, 'r')") is None
    assert OPEN_FOR_WRITING.search("open(path, encoding='utf-8')") is None


def test_the_only_files_the_package_reads_are_its_own_registry_records():
    """Reading is authorized, but **only** the two registry files inside the
    package (§7.4). Asserted so an approved read cannot quietly become a read of
    a mounted path, a config file or a fixture — AD-1 §1 forbids mounting project
    files, and this is the control that would notice."""
    readers = [path for path in SOURCES if "read_text" in code_only(path)]
    assert [path.name for path in readers] == ["registry.py"], readers
    code = code_only(PACKAGE / "adapters" / "registry.py")
    assert "SOURCES_PATH" in code and "ALLOCATIONS_PATH" in code
