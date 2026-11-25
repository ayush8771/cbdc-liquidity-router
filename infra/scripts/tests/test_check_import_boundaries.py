"""Tests for infra/scripts/check_import_boundaries.py (AD-6 T-4, including deliberate violations that must fail)."""
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
REPO = SCRIPTS.parents[1]
sys.path.insert(0, str(SCRIPTS))

import check_import_boundaries as cib  # noqa: E402


def put(root, rel, text=""):
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


@pytest.fixture
def tree(tmp_path):
    put(tmp_path, "src/engine.py", "import numpy\n")
    put(tmp_path, "services/inference/cbdc_inference/app.py", "from src import engine\n")
    put(tmp_path, "services/ingestion/cbdc_ingestion/service.py", "from . import clock\nimport http.server\n")
    put(tmp_path, "services/backend/src/routes/route.ts", 'import { map } from "../mappers/map.js";\n')
    put(tmp_path, "services/backend/src/mappers/map.ts", "export const map = 1;\n")
    put(tmp_path, "services/backend/src/inferenceClient/client.ts", "export const c = 1;\n")
    put(tmp_path, "services/backend/src/observations/poller.ts", 'import { log } from "../logger.js";\n')
    put(tmp_path, "services/backend/src/logger.ts", "export const log = 1;\n")
    put(tmp_path, "services/backend/src/app.ts", 'import "./routes/route.js";\nimport "./observations/poller.js";\n')
    return tmp_path


def problems(root):
    return cib.check(root)[0]


def test_repository_respects_the_import_rules():
    found, _ = cib.check(REPO)
    assert found == []


def test_clean_tree_passes_and_composition_in_app_ts_is_allowed(tree):
    assert cib.check(tree) == ([], [])


def test_missing_observation_module_is_noted_not_silently_passed(tmp_path):
    put(tmp_path, "services/backend/src/routes/route.ts", "export const a = 1;\n")
    found, notes = cib.check(tmp_path)
    assert found == [] and any("does not exist yet" in n for n in notes)


@pytest.mark.parametrize("rel,text,fragment", [
    ("src/engine.py", "import cbdc_ingestion\n", "engine imports the ingestion"),
    ("services/inference/cbdc_inference/app.py", "from cbdc_ingestion.service import IngestionService\n", "engine imports the ingestion"),
    ("services/ingestion/cbdc_ingestion/service.py", "from src.envs import cbdc_env\n", "ingestion imports the engine"),
    ("services/ingestion/cbdc_ingestion/service.py", "import cbdc_inference\n", "ingestion imports the engine"),
    ("services/backend/src/routes/route.ts", 'import { p } from "../observations/poller.js";\n', "routing side imports the observation module"),
    ("services/backend/src/mappers/map.ts", 'export { p } from "../observations/poller";\n', "routing side imports the observation module"),
    ("services/backend/src/inferenceClient/client.ts", 'const p = await import("../observations/poller.js");\n', "routing side imports the observation module"),
    ("services/backend/src/routes/route.ts", 'import {\n  a,\n  b,\n} from "../observations/poller.js";\n', "routing side imports the observation module"),
    ("services/backend/src/observations/poller.ts", 'import { map } from "../mappers/map.js";\n', "observation module imports the routing side"),
    ("services/backend/src/observations/poller.ts", 'import "../inferenceClient/client.js";\n', "observation module imports the routing side"),
])
def test_deliberate_violation_is_reported(tree, rel, text, fragment):
    put(tree, rel, text)
    found = problems(tree)
    assert any(fragment in p and rel in p for p in found), found


def test_main_exit_status(tree, capsys):
    assert cib.main(["--root", str(tree)]) == 0
    put(tree, "src/engine.py", "import cbdc_ingestion\n")
    assert cib.main(["--root", str(tree)]) == 1
    assert "FAIL" in capsys.readouterr().out


def test_bare_package_and_virtualenv_files_are_ignored(tree):
    put(tree, "services/backend/src/routes/route.ts", 'import express from "express";\nimport { x } from "observations";\n')
    put(tree, "src/.venv/lib/x.py", "import cbdc_ingestion\n")
    assert problems(tree) == []


# --- hardening: Python detection, TypeScript bypass guards, missing-module enforcement ---------------------------

@pytest.mark.parametrize("text", [
    "from services.ingestion.cbdc_ingestion import service\n",
    "import services.ingestion.cbdc_ingestion.store\n",
    "from services import ingestion\n",
    'import importlib\nm = importlib.import_module("cbdc_ingestion.service")\n',
    'mod = __import__("cbdc_ingestion")\n',
    'import sys\nsys.path.insert(0, "services/ingestion")\n',
    'p = "services\\\\ingestion\\\\cbdc_ingestion"\n',
])
def test_engine_reaching_the_ingestion_component_in_any_form_is_reported(tree, text):
    put(tree, "src/engine.py", text)
    assert any("src/engine.py" in p and "ingestion" in p for p in problems(tree)), problems(tree)


def test_ingestion_loading_the_engine_dynamically_is_reported(tree):
    put(tree, "services/ingestion/cbdc_ingestion/service.py", 'import importlib\nimportlib.import_module("src.envs.cbdc_env")\n')
    assert any("ingestion imports the engine" in p for p in problems(tree))


def test_run_time_built_python_import_is_not_a_false_positive(tree):
    """Negative control: the engine's worker loads modules by a name built at run time; that cannot be judged."""
    put(tree, "src/engine.py", "import importlib\nm = importlib.import_module\nm(name)\nlabel = 'data ingestion step'\n")
    assert problems(tree) == []


@pytest.mark.parametrize("cfg,fragment", [
    ('{"compilerOptions": {"paths": {"@o/*": ["src/observations/*"]}}}', "compilerOptions.paths"),
    ('{"compilerOptions": {"baseUrl": "src"}}', "compilerOptions.baseUrl"),
    ('{"compilerOptions": {"rootDirs": ["src", "gen"]}}', "compilerOptions.rootDirs"),
    ('{ // comment\n "compilerOptions": {"paths": {}},\n}', "compilerOptions.paths"),
])
def test_tsconfig_alias_settings_are_reported(tree, cfg, fragment):
    put(tree, "services/backend/tsconfig.json", cfg)
    assert any(fragment in p for p in problems(tree)), problems(tree)


def test_tsconfig_with_comments_and_urls_but_no_alias_is_accepted(tree):
    put(tree, "services/backend/tsconfig.json", '{\n  "$schema": "https://json.schemastore.org/tsconfig", // c\n  /* b */\n  "compilerOptions": {"strict": true,},\n}')
    assert problems(tree) == []


def test_package_imports_field_is_reported(tree):
    put(tree, "services/backend/package.json", '{"imports": {"#obs": "./src/observations/index.ts"}}')
    assert any("`imports` field" in p for p in problems(tree))


@pytest.mark.parametrize("rel,text", [
    ("services/backend/src/routes/route.ts", 'import { p } from "@/observations/poller";\n'),
    ("services/backend/src/mappers/map.ts", 'import { p } from "#observations/poller";\n'),
    ("services/backend/src/observations/poller.ts", 'import { m } from "~/mappers/map";\n'),
])
def test_alias_looking_specifiers_are_reported(tree, rel, text):
    put(tree, rel, text)
    assert any("alias-looking" in p and rel in p for p in problems(tree)), problems(tree)


@pytest.mark.parametrize("rel,text", [
    ("services/backend/src/routes/route.ts", "const m = await import(name);\n"),
    ("services/backend/src/inferenceClient/client.ts", "const m = require(path);\n"),
    ("services/backend/src/observations/poller.ts", "const m = await import(`../routes/${x}`);\n"),
])
def test_non_literal_dynamic_imports_are_reported(tree, rel, text):
    put(tree, rel, text)
    assert any("non-literal" in p and rel in p for p in problems(tree)), problems(tree)


@pytest.mark.parametrize("rel", [
    "services/backend/src/observation/poller.ts",
    "services/backend/src/stream/observationStream.ts",
    "services/backend/src/lib/Observations.ts",
])
def test_observation_code_outside_the_checked_folder_is_reported(tree, rel):
    put(tree, rel, "export const a = 1;\n")
    assert any(rel in p and "not covered" in p for p in problems(tree)), problems(tree)


def test_require_flag_fails_without_the_observation_module_and_passes_with_it(tmp_path, tree):
    bare = tmp_path / "bare"
    put(bare, "services/backend/src/routes/route.ts", "export const a = 1;\n")
    found, _ = cib.check(bare, require_observation_module=True)
    assert any("is required and does not exist" in p for p in found)
    assert cib.main(["--root", str(bare), "--require-observation-module"]) == 1
    assert cib.check(tree, require_observation_module=True) == ([], [])
    assert cib.main(["--root", str(tree), "--require-observation-module"]) == 0
