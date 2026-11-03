"""Folder layout (arch §4) and module boundaries (arch §5.1), checked statically."""
import ast
from pathlib import Path

SERVICE = Path(__file__).resolve().parents[2]
PKG = SERVICE / "cbdc_inference"

EXPECTED = [
    "pyproject.toml", "README.md", ".gitignore",
    "config/approved_checkpoints.json",
    "requirements/service.in", "requirements/cognee.in",
    "cbdc_inference/__init__.py", "cbdc_inference/settings.py", "cbdc_inference/checkpoints.py",
    "cbdc_inference/api/__init__.py", "cbdc_inference/api/app.py", "cbdc_inference/api/errors.py",
    "cbdc_inference/api/routers/__init__.py",
    "cbdc_inference/engine/__init__.py",
    "tests/conftest.py",
]


def _imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module.split(".")[0])
    return names


def test_expected_files_exist():
    missing = [p for p in EXPECTED if not (SERVICE / p).is_file()]
    assert not missing, missing


def test_test_suite_folders_exist():
    for d in ("unit", "api", "parity", "concurrency"):
        assert (SERVICE / "tests" / d).is_dir(), d


def test_api_layer_never_imports_phase1_or_torch():
    for f in (PKG / "api").rglob("*.py"):
        bad = _imports(f) & {"src", "torch", "gymnasium", "pandas"}
        assert not bad, f"{f.relative_to(SERVICE)} imports {bad}"


def test_engine_layer_never_imports_fastapi():
    for f in (PKG / "engine").rglob("*.py"):
        bad = _imports(f) & {"fastapi", "starlette", "uvicorn"}
        assert not bad, f"{f.relative_to(SERVICE)} imports {bad}"


def test_shared_modules_import_neither():
    for name in ("settings.py", "checkpoints.py", "__init__.py"):
        bad = _imports(PKG / name) & {"src", "torch", "fastapi", "starlette"}
        assert not bad, f"{name} imports {bad}"


def test_no_checkpoint_path_hard_coded_in_package():
    """Arch D4 / contract §7: no checkpoint path or ID in source code."""
    for f in PKG.rglob("*.py"):
        text = f.read_text(encoding="utf-8")
        assert ".pt\"" not in text and ".pt'" not in text, f
        assert "outputs/experiments/" not in text, f
