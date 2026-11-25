"""Tests for e2e/p3_safeguards.py (AD-6 T-6, T-7, T-8): each guard passes a clean case and is shown to catch a violation.
Run: pytest infra/scripts/tests/test_p3_safeguards.py
"""
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "e2e"))
sys.path.insert(0, str(REPO / "infra" / "scripts"))

import p3_safeguards as sg  # noqa: E402


# --- T-7 -----------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("status, path", [
    ("M", "src/envs/cbdc_env.py"), ("D", "data/knowledge/regulatory_facts.json"), ("M", "contracts/fixtures/app/transactions/201_waterfall_replay.json"),
    ("M", "contracts/test-vectors/decision_id.json"), ("M", "services/inference/cbdc_inference/app.py"), ("M", "tests/test_stage1d.py"),
    ("M", "run_stage1f_backtest.py"), ("M", "services/backend/src/routes/transactions.ts"), ("A", "src/new_module.py"),
    ("A", "contracts/fixtures/app/new.json"), ("T", "outputs/x.csv")])
def test_protected_path_violations_are_caught(status, path):
    assert sg.protected_problems([(status, path)])


@pytest.mark.parametrize("status, path", [
    ("A", "contracts/test-vectors/event_payload_hash.v1.json"),  # authorized Phase 3 addition
    ("A", "contracts/events/event-envelope.v1.schema.json"), ("M", "services/backend/src/app.ts"), ("M", "docs/PHASE2_STATUS.md"),
    ("A", "e2e/p3_safeguards.py"), ("M", "services/web/src/main.tsx"), ("A", "services/ingestion/cbdc_ingestion/x.py")])
def test_authorized_and_unprotected_changes_pass(status, path):
    assert sg.protected_problems([(status, path)]) == []


def test_an_addition_is_authorized_only_by_name():
    assert sg.protected_problems([("A", "contracts/test-vectors/other.json")])
    assert sg.protected_problems([("M", "contracts/test-vectors/event_payload_hash.v1.json")])  # the authorized file must not be altered either


def git(cwd, *a):
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *a], cwd=cwd, check=True, capture_output=True)


def test_changes_since_sees_commits_working_tree_and_untracked(tmp_path, monkeypatch):
    git(tmp_path, "init", "-q")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "a.py").write_text("1")
    (tmp_path / "keep.md").write_text("1")
    git(tmp_path, "add", "."), git(tmp_path, "commit", "-qm", "base")
    base = subprocess.run(["git", "rev-parse", "HEAD"], cwd=tmp_path, capture_output=True, text=True).stdout.strip()
    monkeypatch.setattr(sg, "REPO", tmp_path)
    assert sg.protected_problems(sg.changes_since(base)) == []
    (tmp_path / "src" / "a.py").write_text("2")               # uncommitted edit
    (tmp_path / "src" / "b.py").write_text("x")               # untracked addition
    problems = sg.protected_problems(sg.changes_since(base))
    assert any("src/a.py: modified" in p for p in problems) and any("src/b.py: added" in p for p in problems)
    git(tmp_path, "checkout", "--", "src/a.py"), (tmp_path / "src" / "b.py").unlink()
    (tmp_path / "keep.md").write_text("2"), git(tmp_path, "commit", "-qam", "docs")  # a committed unprotected edit
    assert sg.protected_problems(sg.changes_since(base)) == []
    (tmp_path / "src" / "a.py").unlink()                      # a deletion
    assert any("deleted" in p for p in sg.protected_problems(sg.changes_since(base)))
    with pytest.raises(subprocess.CalledProcessError):        # a baseline outside this history is refused, not ignored
        sg.changes_since("0" * 40)


def test_real_repository_is_clean_against_the_approved_baseline():
    assert sg.protected_problems(sg.changes_since(sg.BASELINE)) == []


# --- T-8 -----------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("line", [
    "Routing on live data is now available.", "Try Live Routing today", "live-routing mode", "the real-time optimal route", "Real time routing engine",
    "routing with real-time data", "LIVE ROUTING"])
def test_forbidden_phrases_are_caught(line):
    assert sg.text_problems("ui.tsx", f"<h1>{line}</h1>\n")


@pytest.mark.parametrize("line", [
    "Real-time monitoring with simulation-based routing", "Observations are shown for context. They do not affect routing.",
    'Status documents do not describe routing as "live routing".', 'The words "routing on live data" are never used.', "Live observations stream in.",
    'We do not describe Phase 3 routing as "live routing" or "routing on live data".', "This is not live routing.",
    'Never call it "real-time optimal route".', "Streaming pipeline exercised with synthetic events only; no live source integrated."])
def test_approved_wording_and_denials_pass(line):
    assert sg.text_problems("README.md", line) == []


@pytest.mark.parametrize("line", [
    "No downtime with live routing", "Not only live routing, but real-time optimal route too", "We do not hesitate to call it live routing",
    "Live routing is not a problem for us", "Not available elsewhere: live routing", 'Do not miss live routing. It is great.',
    "There is no limit to routing on live data", "This is not a demo: it is live routing", 'We do not describe it as "live routing" but we offer "live routing"',
    "never wait for routing with real-time data"])
def test_misleading_claims_with_no_or_not_are_still_caught(line):
    assert sg.text_problems("ui.tsx", line)


def test_line_number_and_file_are_reported():
    assert sg.text_problems("docs/x.md", "ok\nlive routing\n")[0].startswith("docs/x.md:2:")


def test_real_ui_and_status_files_are_clean_and_actually_scanned():
    files = sg.text_files()
    names = {f.relative_to(REPO).as_posix() for f in files}
    assert "docs/PHASE2_STATUS.md" in names and any(n.startswith("services/web/src/") and n.endswith(".tsx") for n in names)
    assert [p for f in files for p in sg.text_problems(f.name, f.read_text(encoding="utf-8", errors="replace"))] == []


# --- T-6 -----------------------------------------------------------------------------------------------------------

def make_tree(root: Path):
    for t, name in (("src", "a.py"), ("data/knowledge", "regulatory_facts.json"), ("outputs", "m.csv"), ("contracts/test-vectors", "v.json"), ("services/inference", "s.py")):
        (root / t).mkdir(parents=True, exist_ok=True)
        (root / t / name).write_text("original")


def test_hashes_are_stable_and_ignore_bytecode(tmp_path):
    make_tree(tmp_path)
    before = sg.hash_tree(tmp_path)
    assert len(before) == 5
    (tmp_path / "src" / "__pycache__").mkdir()
    (tmp_path / "src" / "__pycache__" / "a.cpython-310.pyc").write_bytes(b"x")
    assert sg.hash_diff(before, sg.hash_tree(tmp_path)) == []


@pytest.mark.parametrize("mutate, fragment", [
    (lambda r: (r / "data/knowledge/regulatory_facts.json").write_text("edited"), "regulatory_facts.json: content changed"),
    (lambda r: (r / "src/new.py").write_text("x"), "src/new.py: added"),
    (lambda r: (r / "outputs/m.csv").unlink(), "outputs/m.csv: removed"),
    (lambda r: (r / "services/inference/s.py").write_text("origina1"), "s.py: content changed")])
def test_a_change_to_an_artefact_is_detected(tmp_path, mutate, fragment):
    make_tree(tmp_path)
    before = sg.hash_tree(tmp_path)
    mutate(tmp_path)
    assert any(fragment in d for d in sg.hash_diff(before, sg.hash_tree(tmp_path)))


def test_hash_diff_is_empty_for_identical_snapshots():
    assert sg.hash_diff({"a": "1"}, {"a": "1"}) == []


def test_real_artefacts_are_hashed_including_the_knowledge_base():
    h = sg.hash_tree(REPO)
    assert any(p.endswith("data/knowledge/regulatory_facts.json") for p in h) and any(p.startswith("src/") for p in h) and len(h) > 100


def test_a_missing_listed_document_or_empty_ui_is_an_error_not_a_smaller_scope(monkeypatch):
    monkeypatch.setattr(sg, "STATUS_DOCS", sg.STATUS_DOCS + ("docs/DOES_NOT_EXIST.md",))
    with pytest.raises(FileNotFoundError, match="DOES_NOT_EXIST"):
        sg.text_files()
    assert sg.main(["text"]) == 1


def test_the_text_scope_is_exactly_the_approved_ten_documents_and_the_ui():
    assert len(sg.STATUS_DOCS) == 10 and sg.UI_DIR == "services/web/src"
    names = [f.relative_to(REPO).as_posix() for f in sg.text_files()]
    assert set(sg.STATUS_DOCS) <= set(names) and sum(n.startswith("services/web/src/") for n in names) == len(names) - 10
