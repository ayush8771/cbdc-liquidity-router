"""AD-6 B-3 import rules, checked statically (AD-6 test T-4; AD-1 v0.5 section 3.7).

  Python  the engine (`src/`, `services/inference/`) never imports the ingestion component, and the ingestion package
          never imports `src`, `cbdc_inference` or `services`. Detected: `import` and `from ... import` of
          `cbdc_ingestion` or `services.ingestion`, `importlib.import_module("...")` and `__import__("...")` with a
          literal name, and any string literal in the engine that names `cbdc_ingestion` or `services/ingestion`
          (a `sys.path` edit or a path built to load it). A name built at run time cannot be judged and is not flagged.
  Express the routing side (`services/backend/src/routes`, `mappers`, `inferenceClient`) never imports the
          observation module (`services/backend/src/observations`), and the observation module never imports the
          routing side. `app.ts` and `server.ts` may compose both. Relative imports are resolved; anything that would
          let an import bypass that resolution is itself a failure: a tsconfig `paths` or `baseUrl`, a package.json
          `imports` field, an alias-looking specifier (`@/`, `~/`, `#`), and a non-literal `import()` or `require()` in
          the checked folders.
  Stray   observation code anywhere under `services/backend/src` outside `observations/` is a failure, because the
          rules would not cover it. `--require-observation-module` also fails when `observations/` does not exist;
          the phase3-observations workflow turns it on when Dev B's module lands. Without it the missing folder is
          only noted, and the output says which direction was not checked.

Usage:  python infra/scripts/check_import_boundaries.py [--root REPO_ROOT] [--require-observation-module]
Exit status 0 when no rule is broken, 1 otherwise. Standard library only.
"""
from __future__ import annotations

import argparse
import ast
import json
import posixpath
import re
import sys
from pathlib import Path

SKIP_DIRS = {".venv", "venv", "node_modules", "__pycache__", ".git", "dist", "build"}
ENGINE_DIRS = ("src", "services/inference")
INGESTION_PACKAGE = "services/ingestion/cbdc_ingestion"
INGESTION_FORBIDDEN_ROOTS = {"src", "cbdc_inference", "services"}
INGESTION_NAMES = ("cbdc_ingestion", "services/ingestion", "services\\ingestion")
BACKEND = "services/backend"
BACKEND_SRC = f"{BACKEND}/src"
ROUTING_DIRS = tuple(f"{BACKEND_SRC}/{d}" for d in ("routes", "mappers", "inferenceClient"))
OBSERVATION_DIR = f"{BACKEND_SRC}/observations"
TS_SUFFIXES = (".ts", ".tsx", ".mts", ".cts")

TS_IMPORT = re.compile(
    r"""(?:\b(?:import|export)\b[^;'"]*?\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']""",
    re.S,
)
TS_DYNAMIC_NON_LITERAL = re.compile(r"""\b(?:import|require)\s*\(\s*(?!["'\s])""")
ALIAS_SPECIFIER = re.compile(r"^(?:@/|~/|#)")


def files(root: Path, rel: str, suffixes: tuple[str, ...]):
    base = root / rel
    if not base.is_dir():
        return
    for p in sorted(base.rglob("*")):
        if p.is_file() and p.suffix in suffixes and not (set(p.relative_to(base).parts[:-1]) & SKIP_DIRS):
            yield p


def parse_python(path: Path):
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def imported_modules(tree) -> list[str]:
    """Modules named by import statements and by literal `import_module` / `__import__` calls."""
    out = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out += [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            out.append(node.module)
            if node.module == "services":
                out += [f"services.{a.name}" for a in node.names]
        elif isinstance(node, ast.Call) and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
            fn = node.func
            name = fn.attr if isinstance(fn, ast.Attribute) else getattr(fn, "id", "")
            if name in ("import_module", "__import__"):
                out.append(node.args[0].value)
    return out


def names_ingestion(module: str) -> bool:
    parts = module.split(".")
    return parts[0] == "cbdc_ingestion" or parts[:2] == ["services", "ingestion"]


def string_literals(tree):
    return [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)]


def inside(rel: str, folder: str) -> bool:
    return rel == folder or rel.startswith(folder + "/")


def ts_specifiers(path: Path) -> list[str]:
    return TS_IMPORT.findall(path.read_text(encoding="utf-8"))


def ts_target(root: Path, path: Path, spec: str) -> str:
    here = path.parent.relative_to(root).as_posix()
    return re.sub(r"\.(?:js|ts|tsx|mjs|cjs)$", "", posixpath.normpath(posixpath.join(here, spec)))


def strip_json_comments(text: str) -> str:
    """tsconfig.json allows comments and trailing commas."""
    text = re.sub(r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*.*?\*/', lambda m: m.group(0) if m.group(0).startswith('"') else "", text, flags=re.S)
    return re.sub(r",(\s*[}\]])", r"\1", text)


def alias_config_problems(root: Path) -> list[str]:
    out = []
    for cfg in sorted((root / BACKEND).glob("tsconfig*.json")):
        try:
            options = json.loads(strip_json_comments(cfg.read_text(encoding="utf-8"))).get("compilerOptions", {})
        except ValueError:
            out.append(f"{cfg.relative_to(root).as_posix()}: unreadable, so import aliases cannot be ruled out")
            continue
        for key in ("paths", "baseUrl", "rootDirs"):
            if key in options:
                out.append(f"{cfg.relative_to(root).as_posix()}: compilerOptions.{key} would let an import bypass the relative-path check")
    pkg = root / BACKEND / "package.json"
    if pkg.is_file():
        try:
            if "imports" in json.loads(pkg.read_text(encoding="utf-8")):
                out.append(f"{pkg.relative_to(root).as_posix()}: an `imports` field would let an import bypass the relative-path check")
        except ValueError:
            out.append(f"{pkg.relative_to(root).as_posix()}: unreadable, so import aliases cannot be ruled out")
    return out


def check(root: Path, require_observation_module: bool = False) -> tuple[list[str], list[str]]:
    root = Path(root)
    problems, notes = [], []
    rel = lambda p: p.relative_to(root).as_posix()  # noqa: E731

    for folder in ENGINE_DIRS:
        for p in files(root, folder, (".py",)):
            tree = parse_python(p)
            for mod in imported_modules(tree):
                if names_ingestion(mod):
                    problems.append(f"{rel(p)}: the engine imports the ingestion component ({mod})")
            for text in string_literals(tree):
                if any(n in text for n in INGESTION_NAMES):
                    problems.append(f"{rel(p)}: the engine names the ingestion component in a string ({text[:60]!r})")
    for p in files(root, INGESTION_PACKAGE, (".py",)):
        for mod in imported_modules(parse_python(p)):
            if mod.split(".")[0] in INGESTION_FORBIDDEN_ROOTS:
                problems.append(f"{rel(p)}: ingestion imports the engine or a service ({mod})")

    problems += alias_config_problems(root)
    observation_exists = (root / OBSERVATION_DIR).is_dir()
    if not observation_exists:
        if require_observation_module:
            problems.append(f"{OBSERVATION_DIR} is required and does not exist")
        else:
            notes.append(f"{OBSERVATION_DIR} does not exist yet: the observation-to-routing direction was not checked")
    for p in files(root, BACKEND_SRC, TS_SUFFIXES):
        r = rel(p)
        if not inside(r, OBSERVATION_DIR) and "observ" in r.lower():
            problems.append(f"{r}: observation code outside {OBSERVATION_DIR}/ is not covered by the import rules")

    for folder in ROUTING_DIRS + (OBSERVATION_DIR,):
        in_observation = folder == OBSERVATION_DIR
        for p in files(root, folder, TS_SUFFIXES):
            text = p.read_text(encoding="utf-8")
            if TS_DYNAMIC_NON_LITERAL.search(text):
                problems.append(f"{rel(p)}: a non-literal import() or require() cannot be checked")
            for spec in ts_specifiers(p):
                if ALIAS_SPECIFIER.match(spec):
                    problems.append(f"{rel(p)}: the alias-looking import {spec!r} cannot be checked")
                    continue
                if not spec.startswith("."):
                    continue
                target = ts_target(root, p, spec)
                if in_observation and any(inside(target, d) for d in ROUTING_DIRS):
                    problems.append(f"{rel(p)}: the observation module imports the routing side ({target})")
                if not in_observation and inside(target, OBSERVATION_DIR):
                    problems.append(f"{rel(p)}: the routing side imports the observation module ({target})")
    return problems, notes


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2], help="repository root")
    parser.add_argument("--require-observation-module", action="store_true",
                        help="fail when services/backend/src/observations/ does not exist")
    args = parser.parse_args(argv)
    problems, notes = check(args.root, args.require_observation_module)
    for n in notes:
        print(f"NOTE {n}")
    for p in problems:
        print(f"FAIL {p}")
    if problems:
        print(f"{len(problems)} import rule violation(s)")
        return 1
    print("AD-6 B-3 import rules hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
