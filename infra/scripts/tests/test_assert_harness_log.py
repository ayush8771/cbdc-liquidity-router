"""Tests for infra/scripts/assert_harness_log.py and infra/scripts/wait_for_workflows.py (Stage 7 CI guards): each must be able to fail."""
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

import assert_harness_log as hl  # noqa: E402
import wait_for_workflows as wf  # noqa: E402

CLEAN = "PASS a: ok\nPASS b\n\n65 passed, 0 failed, 0 skipped\n"


def run(tmp_path, text, *extra):
    f = tmp_path / "x.log"
    f.write_text(text, encoding="utf-8")
    return hl.main([str(f), *extra])


def test_a_clean_log_passes(tmp_path):
    assert run(tmp_path, CLEAN) == 0
    assert run(tmp_path, "  8 passed (6.7m)\n") == 0  # Playwright's summary


@pytest.mark.parametrize("text", [
    "PASS a\nFAIL b: broken\n65 passed, 1 failed, 0 skipped\n",
    "PASS a\nSKIP c: no docker\n65 passed, 0 failed, 1 skipped\n",
    "  7 passed\n  1 did not run\n", "  7 passed\n  1 flaky\n", "  1 failed\n  2 passed\n",
    "", "starting...\ncrashed\n", "0 passed, 0 failed, 0 skipped\n"])
def test_failures_skips_unrun_and_empty_runs_fail(tmp_path, text):
    assert run(tmp_path, text) == 1


def test_a_required_check_that_never_ran_fails(tmp_path):
    assert run(tmp_path, CLEAN, "--require", "^PASS a: ok") == 0
    assert run(tmp_path, CLEAN, "--require", "^PASS T-6: hashes") == 1


def test_a_missing_log_fails(tmp_path):
    assert hl.main([str(tmp_path / "nope.log")]) == 1


# --- wait_for_workflows -----------------------------------------------------------------------------------------------

def runs(**states):
    return [{"name": n, "status": "completed" if c else "in_progress", "conclusion": c} for n, c in states.items()]


def test_all_required_success_passes_and_absent_optional_is_noted_not_claimed():
    finished, failures, pending, notes = wf.judge(runs(tests="success", **{"phase2-docker": "success"}))
    assert finished and not failures and not pending
    assert any("phase2-stack: did not run" in n for n in notes)


def test_a_failed_workflow_fails_even_when_optional():
    _, failures, _, _ = wf.judge(runs(tests="success", **{"phase2-docker": "success", "phase2-stack": "failure"}))
    assert failures == ["phase2-stack: failure"]
    _, failures, _, _ = wf.judge(runs(tests="cancelled", **{"phase2-docker": "success"}))
    assert failures == ["tests: cancelled"]


def test_a_required_workflow_that_is_missing_or_running_is_pending():
    finished, failures, pending, _ = wf.judge(runs(tests="success"))
    assert not finished and pending == ["phase2-docker: not found yet"]
    finished, _, pending, _ = wf.judge(runs(tests=None, **{"phase2-docker": "success"}))
    assert not finished and pending == ["tests: in_progress"]


def test_the_newest_run_of_a_workflow_wins():
    newest_first = [{"name": "tests", "status": "completed", "conclusion": "success"}, {"name": "tests", "status": "completed", "conclusion": "failure"},
                    {"name": "phase2-docker", "status": "completed", "conclusion": "success"}]
    assert wf.judge(newest_first)[1] == []


def test_wait_polls_until_done_fails_fast_and_times_out():
    seq = iter([runs(tests=None), runs(tests="success"), runs(tests="success", **{"phase2-docker": "success"})])
    t = [0.0]
    assert wf.wait(lambda: next(seq), 100, 10, clock=lambda: t[0], sleep=lambda s: t.__setitem__(0, t[0] + s)) == 0 and t[0] == 20
    assert wf.wait(lambda: runs(tests="failure"), 100, 10, clock=lambda: 0.0, sleep=lambda s: pytest.fail("a failure must not wait")) == 1
    t = [0.0]
    assert wf.wait(lambda: runs(tests=None), 25, 10, clock=lambda: t[0], sleep=lambda s: t.__setitem__(0, t[0] + s)) == 1 and t[0] == 30


def test_a_required_workflow_that_never_appears_fails_after_the_grace_not_the_full_timeout():
    t = [0.0]
    only_tests = lambda: runs(tests="success")  # noqa: E731  phase2-docker never starts
    code = wf.wait(only_tests, 4200, 30, clock=lambda: t[0], sleep=lambda s: t.__setitem__(0, t[0] + s), grace=900)
    assert code == 1 and 900 <= t[0] < 1000, t[0]
    # a running workflow is still waited for up to the timeout: the grace applies only to one that is absent
    t = [0.0]
    code = wf.wait(lambda: runs(tests="success", **{"phase2-docker": None}), 2000, 30, clock=lambda: t[0], sleep=lambda s: t.__setitem__(0, t[0] + s), grace=900)
    assert code == 1 and t[0] >= 2000


def test_arguments_are_validated(monkeypatch):
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    assert wf.main(["--repo", "a/b", "--sha", "0" * 40]) == 2
    monkeypatch.setenv("GITHUB_TOKEN", "x")
    assert wf.main(["--repo", "a b; rm", "--sha", "0" * 40]) == 2
    assert wf.main(["--repo", "a/b", "--sha", "main"]) == 2
