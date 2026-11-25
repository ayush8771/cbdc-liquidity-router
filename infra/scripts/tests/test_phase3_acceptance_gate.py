"""Tests for the required Phase 3 acceptance gate (infra/scripts/phase3_acceptance_gate.py and .github/workflows/phase3-acceptance-gate.yml).

Every guarantee has a control that must fail: an unrelated change passes, a relevant change requires acceptance, a tampered filter, a failed diff or a
missing base still require it, and a missing run, a skipped job, a failed job and a stale run never pass.
Run: pytest infra/scripts/tests/test_phase3_acceptance_gate.py
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "infra" / "scripts"))
sys.path.insert(0, str(ROOT / "e2e"))

import phase3_acceptance_gate as g  # noqa: E402

OBS = (ROOT / ".github" / "workflows" / "phase3-observations.yml").read_text(encoding="utf-8")
GATE = (ROOT / ".github" / "workflows" / "phase3-acceptance-gate.yml").read_text(encoding="utf-8")
BASE = "a" * 40
HEAD = "b" * 40


def workflow_text(paths, push_paths=None):
    return yaml.safe_dump({"name": "phase3-observations", True: {"push": {"paths": push_paths or paths}, "pull_request": {"paths": paths}}})


TRUSTED = workflow_text(["src/**", "services/web/**", "*.py", "requirements.txt", "README.md", ".github/workflows/phase3-observations.yml"])


# --- which changes need acceptance -----------------------------------------------------------------------------------------

@pytest.mark.parametrize("changed", [["docs/PHASE2_API_CONTRACT.md"], ["notes/a.py"], ["services/other/a.ts", "LICENSE"], []])
def test_an_unrelated_change_does_not_require_acceptance(changed):
    required, reason = g.decide("pull_request", BASE, TRUSTED, TRUSTED, changed)
    assert required is False and "none of" in reason


@pytest.mark.parametrize("path", ["src/envs/cbdc_env.py", "services/web/src/a.tsx", "run_stage1f_backtest.py", "requirements.txt", "README.md"])
def test_a_relevant_change_requires_acceptance(path):
    assert g.decide("pull_request", BASE, TRUSTED, TRUSTED, ["docs/x.md", path])[0] is True


def test_the_root_python_pattern_matches_only_the_root():
    assert g.matches("run_x.py", ["*.py"]) and not g.matches("services/x/run_x.py", ["*.py"]) and g.matches("a/b/c.ts", ["a/**"])


@pytest.mark.parametrize("path", g.GATE_FILES)
def test_a_change_to_the_gate_itself_always_requires_acceptance(path):
    bare = workflow_text(["src/**"])  # a trusted list that does not name the gate files
    assert g.decide("pull_request", BASE, bare, bare, [path])[0] is True


def test_a_head_that_shrinks_the_filter_cannot_excuse_itself():
    shrunk = workflow_text(["services/web/**", "*.py", "requirements.txt", "README.md", ".github/workflows/phase3-observations.yml"])  # src/** removed
    required, reason = g.decide("pull_request", BASE, TRUSTED, shrunk, ["src/envs/cbdc_env.py"])
    assert required is True and "tampering" in reason
    # the same shrunken list as the TRUSTED one would have let it pass: the base is what counts
    assert g.decide("pull_request", BASE, shrunk, shrunk, ["src/envs/cbdc_env.py"])[0] is False
    # a head that only adds patterns is not tampering
    wider = workflow_text(["src/**", "services/web/**", "*.py", "requirements.txt", "README.md", ".github/workflows/phase3-observations.yml", "extra/**"])
    assert g.decide("pull_request", BASE, TRUSTED, wider, ["docs/x.md"])[0] is False


@pytest.mark.parametrize("base_text", [None, "", "not: [valid", "name: x\non:\n  push: {}\n", workflow_text([]), workflow_text(["!src/**"]),
                                      yaml.safe_dump({"on": {"pull_request": {"paths": ["src/**"]}}})])
def test_an_unreadable_or_unsupported_trusted_list_fails_closed(base_text):
    required, reason = g.decide("pull_request", BASE, base_text, base_text if base_text else TRUSTED, ["docs/x.md"])
    assert required is True and ("fail closed" in reason or "tampering" in reason), reason
    assert g.decide("pull_request", BASE, base_text, TRUSTED, ["docs/x.md"])[0] is True  # and never a pass, whatever the head says


def test_an_unreadable_head_list_a_missing_base_and_a_manual_run_all_require_acceptance():
    assert g.decide("pull_request", BASE, TRUSTED, None, ["docs/x.md"])[0] is True
    for base in ("", "0" * 40, "main", None):
        assert g.decide("push", base, TRUSTED, TRUSTED, ["docs/x.md"])[0] is True
    assert g.decide("workflow_dispatch", BASE, TRUSTED, TRUSTED, [])[0] is True


# --- real git: the diff, and a failed diff ----------------------------------------------------------------------------------

def run_git(cwd, *a):
    return subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *a], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture
def repo(tmp_path, monkeypatch):
    run_git(tmp_path, "init", "-q")
    (tmp_path / ".github" / "workflows").mkdir(parents=True)
    (tmp_path / ".github" / "workflows" / "phase3-observations.yml").write_text(TRUSTED, encoding="utf-8")
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "a.md").write_text("1")
    run_git(tmp_path, "add", "."), run_git(tmp_path, "commit", "-qm", "base")
    monkeypatch.chdir(tmp_path)
    return tmp_path, run_git(tmp_path, "rev-parse", "HEAD")


def commit_change(root, relpath, text="x"):
    p = root / relpath
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
    run_git(root, "add", "."), run_git(root, "commit", "-qm", "change")
    return run_git(root, "rev-parse", "HEAD")


def test_changed_files_sees_the_pull_request_and_splits_renames(repo):
    root, base = repo
    run_git(root, "mv", "docs/a.md", "src_moved.md")
    run_git(root, "commit", "-qm", "rename")
    head = run_git(root, "rev-parse", "HEAD")
    assert sorted(g.changed_files(base, head)) == ["docs/a.md", "src_moved.md"]


def test_a_failed_diff_raises_and_main_then_requires_acceptance(repo, monkeypatch, capsys, tmp_path):
    root, base = repo
    head = commit_change(root, "docs/b.md")
    with pytest.raises(g.GateError):
        g.changed_files("f" * 40, head)  # a base that is not in the history
    event = tmp_path / "event.json"
    event.write_text(json.dumps({"pull_request": {"base": {"sha": "f" * 40}, "head": {"sha": head}}}))
    monkeypatch.setenv("GITHUB_TOKEN", "x")
    monkeypatch.setattr(g, "api", lambda url, token: {"workflow_runs": [], "jobs": []})
    code = g.main(["--repo", "o/r", "--event-name", "pull_request", "--event-path", str(event), "--sha", head, "--timeout", "5", "--poll", "0.01", "--grace", "0"])
    out = capsys.readouterr().out
    assert code == 1 and "REQUIRED: fail closed" in out and "never started" in out


def test_main_passes_at_once_for_an_unrelated_change_without_asking_github(repo, monkeypatch, capsys, tmp_path):
    root, base = repo
    head = commit_change(root, "docs/b.md")
    event = tmp_path / "event.json"
    event.write_text(json.dumps({"pull_request": {"base": {"sha": base}, "head": {"sha": head}}}))
    monkeypatch.setenv("GITHUB_TOKEN", "x")
    monkeypatch.setattr(g, "api", lambda *a: pytest.fail("an unrelated change must not query GitHub"))
    assert g.main(["--repo", "o/r", "--event-name", "pull_request", "--event-path", str(event), "--sha", head]) == 0
    assert "NOT REQUIRED" in capsys.readouterr().out


def test_main_requires_and_fails_for_a_relevant_change_with_no_run(repo, monkeypatch, capsys, tmp_path):
    root, base = repo
    head = commit_change(root, "src/new.py")
    event = tmp_path / "event.json"
    event.write_text(json.dumps({"pull_request": {"base": {"sha": base}, "head": {"sha": head}}}))
    monkeypatch.setenv("GITHUB_TOKEN", "x")
    monkeypatch.setattr(g, "api", lambda url, token: {"workflow_runs": [], "jobs": []})
    assert g.main(["--repo", "o/r", "--event-name", "pull_request", "--event-path", str(event), "--sha", head, "--timeout", "5", "--poll", "0.01", "--grace", "0"]) == 1
    assert "REQUIRED: acceptance path changed: src/new.py" in capsys.readouterr().out


def test_main_rejects_a_missing_token_or_head(monkeypatch, tmp_path):
    event = tmp_path / "e.json"
    event.write_text("{}")
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    assert g.main(["--repo", "o/r", "--event-name", "pull_request", "--event-path", str(event), "--sha", HEAD]) == 1
    monkeypatch.setenv("GITHUB_TOKEN", "x")
    assert g.main(["--repo", "o/r", "--event-name", "pull_request", "--event-path", str(event), "--sha", HEAD]) == 1  # a pull_request event without a head


# --- is this commit's acceptance green --------------------------------------------------------------------------------------

def run(rid=1, sha=HEAD, status="completed", conclusion="success", created="2026-11-26T10:00:00Z", name=g.WORKFLOW_NAME, attempt=1):
    return {"id": rid, "name": name, "head_sha": sha, "status": status, "conclusion": conclusion, "created_at": created, "run_attempt": attempt}


def jobs(**override):
    out = {n: {"name": n, "status": "completed", "conclusion": "success"} for n in g.REQUIRED_JOBS}
    for n, v in override.items():
        i = g.REQUIRED_JOBS[int(n[1:])]
        if v is None:
            del out[i]
        else:
            out[i] = {"name": i, "status": v[0], "conclusion": v[1]}
    return list(out.values())


def ev(runs, by_run=None, head=HEAD):
    return g.evaluate(runs, lambda r: (by_run or {}).get(r["id"], jobs()), head)[0]


def test_a_complete_green_run_of_this_commit_passes():
    assert ev([run()]) == "pass"
    assert g.evaluate([run()], lambda r: jobs() + [{"name": "extra", "status": "completed", "conclusion": "failure"}], HEAD)[0] == "pass"  # other jobs are not ours


def test_a_missing_workflow_run_is_pending_never_a_pass():
    assert ev([]) == "pending"
    assert ev([run(name="phase2-stack")]) == "pending"  # another workflow does not count


def test_a_run_of_another_commit_is_stale_and_never_counts():
    assert ev([run(sha="c" * 40)]) == "pending"
    assert ev([run(sha="c" * 40, conclusion="failure"), run(rid=2)]) == "pass"  # only this commit's run decides


@pytest.mark.parametrize("label, override", [("skipped", {"j0": ("completed", "skipped")}), ("failed", {"j1": ("completed", "failure")}),
                                              ("cancelled", {"j2": ("completed", "cancelled")}), ("timed out", {"j3": ("completed", "timed_out")}),
                                              ("missing", {"j2": None}), ("neutral", {"j0": ("completed", "neutral")})])
def test_a_skipped_failed_or_missing_acceptance_job_fails(label, override):
    assert ev([run()], {1: jobs(**override)}) == "fail", label


def test_a_failed_job_fails_at_once_while_the_run_is_still_going_and_a_running_job_waits():
    assert ev([run(status="in_progress", conclusion=None)], {1: jobs(j2=("completed", "failure"))}) == "fail"
    assert ev([run(status="in_progress", conclusion=None)], {1: jobs(j2=("in_progress", None))}) == "pending"
    assert ev([run(status="in_progress", conclusion=None)], {1: jobs(j2=None)}) == "pending"  # not started yet, not a failure
    assert ev([run(status="queued", conclusion=None)], {1: jobs(j0=("queued", None))}) == "pending"


def test_a_run_that_did_not_succeed_fails_even_if_the_four_jobs_did():
    assert ev([run(conclusion="failure")]) == "fail"
    assert ev([run(conclusion="cancelled")]) == "fail"


def test_the_newest_run_of_the_commit_decides_not_an_older_success():
    old_ok = run(rid=1, created="2026-11-26T10:00:00Z")
    new_running = run(rid=2, status="in_progress", conclusion=None, created="2026-11-26T10:30:00Z")
    new_failed = run(rid=3, conclusion="failure", created="2026-11-26T10:40:00Z")
    by = {2: jobs(j0=("in_progress", None)), 3: jobs(j0=("completed", "failure"))}
    assert ev([old_ok, new_running], by) == "pending", "an older success must not hide a newer run that has not finished"
    assert ev([new_failed, old_ok], by) == "fail", "listing order is irrelevant: the newest by creation time wins"


# --- waiting is bounded and fails closed ----------------------------------------------------------------------------------

def clock():
    t = [0.0]
    return (lambda: t[0]), (lambda s: t.__setitem__(0, t[0] + s)), t


def test_wait_passes_when_the_run_goes_green_and_polls_until_then():
    now, sleep, t = clock()
    states = iter([[], [run(status="in_progress", conclusion=None)], [run()]])
    code = g.wait(lambda: next(states), lambda r: jobs(), HEAD, 1000, 30, 900, clock=now, sleep=sleep)
    assert code == 0 and t[0] == 60


def test_wait_fails_after_the_grace_when_no_run_ever_starts():
    now, sleep, t = clock()
    assert g.wait(lambda: [], lambda r: jobs(), HEAD, 7500, 30, 900, clock=now, sleep=sleep) == 1
    assert 900 <= t[0] < 1000, "it must not wait the full timeout for a run that does not exist"


def test_wait_fails_on_the_timeout_for_a_run_that_never_finishes_and_at_once_on_failure():
    now, sleep, t = clock()
    stuck = [run(status="in_progress", conclusion=None)]
    assert g.wait(lambda: stuck, lambda r: jobs(j0=("in_progress", None)), HEAD, 300, 30, 900, clock=now, sleep=sleep) == 1 and t[0] >= 300
    now, sleep, t = clock()
    assert g.wait(lambda: [run(conclusion="failure")], lambda r: jobs(j0=("completed", "failure")), HEAD, 300, 30, 900, clock=now, sleep=sleep) == 1 and t[0] == 0


# --- the workflows: wiring, trust and budget ----------------------------------------------------------------------------------

@pytest.fixture(scope="module")
def gate_wf():
    return yaml.safe_load(GATE)


@pytest.fixture(scope="module")
def obs_wf():
    return yaml.safe_load(OBS)


def test_the_gate_always_runs_on_the_platform_branch_and_cannot_be_path_skipped(gate_wf):
    on = gate_wf[True]
    assert set(on) == {"pull_request", "push", "workflow_dispatch"} and "pull_request_target" not in GATE and "workflow_run" not in on
    for event in ("pull_request", "push"):
        assert on[event] == {"branches": ["feature/phase3-platform"]}, "no `paths` or `paths-ignore`: an unrelated pull request still gets the check"
    assert not any("paths" in str(v) for v in on.values())


def test_the_gate_job_is_named_exactly_what_branch_protection_requires(gate_wf):
    assert list(gate_wf["jobs"]) == ["phase3-acceptance"] and gate_wf["jobs"]["phase3-acceptance"]["name"] == "phase3-acceptance"
    assert gate_wf["permissions"] == {"contents": "read", "actions": "read"}
    assert "secrets." not in GATE and "continue-on-error" not in GATE
    assert "github.event.pull_request" not in GATE and "github.head_ref" not in GATE, "no pull-request text in a command"


def test_the_gate_runs_the_base_commits_logic_and_only_bootstraps_from_the_head(gate_wf):
    text = "\n".join(s.get("run", "") for s in gate_wf["jobs"]["phase3-acceptance"]["steps"])
    assert 'git show "$base:$script"' in text and "git cat-file -e" in text and "bootstrap only" in text
    assert text.index('git show "$base:$script"') < text.index('python "$RUNNER_TEMP/phase3_acceptance_gate.py"'), "it runs the extracted base copy, not the checkout's"
    checkout = gate_wf["jobs"]["phase3-acceptance"]["steps"][0]
    assert checkout["with"]["fetch-depth"] == 0, "the base commit must be present"


def test_the_gate_timeout_covers_the_longest_acceptance_chain(gate_wf, obs_wf):
    jobs_ = obs_wf["jobs"]

    def chain(n):
        return jobs_[n]["timeout-minutes"] + max([chain(m) for m in jobs_[n].get("needs", [])] or [0])

    longest = max(chain(n) for n in jobs_)  # every job of the workflow, not only the four
    assert longest == 125, "the budget below is derived from this; update both together"
    text = "\n".join(s.get("run", "") for s in gate_wf["jobs"]["phase3-acceptance"]["steps"])
    script_minutes = int(text.split("--timeout ")[1].split()[0]) / 60
    assert script_minutes >= longest and gate_wf["jobs"]["phase3-acceptance"]["timeout-minutes"] >= script_minutes + 5
    assert int(text.split("--grace ")[1].split()[0]) <= 900


def test_the_required_jobs_are_exactly_the_four_acceptance_jobs_of_the_observations_workflow(obs_wf):
    names = {j["name"] for j in obs_wf["jobs"].values()}
    assert set(g.REQUIRED_JOBS) <= names and len(g.REQUIRED_JOBS) == 4 == len(set(g.REQUIRED_JOBS))
    ids = {j["name"]: k for k, j in obs_wf["jobs"].items()}
    assert {ids[n] for n in g.REQUIRED_JOBS} == {"guards", "regression-gate", "acceptance-stack", "acceptance-browser"}
    assert all("if" not in obs_wf["jobs"][ids[n]] for n in g.REQUIRED_JOBS), "no job-level condition can skip an acceptance job"


def test_the_observations_workflow_triggers_cover_every_protected_path_and_the_gate_itself(obs_wf):
    import p3_safeguards as sg
    for event in ("push", "pull_request"):
        patterns = obs_wf[True][event]["paths"]
        for prefix in sg.PROTECTED:
            sample = prefix + "x" if prefix.endswith("/") else prefix
            assert g.matches(sample, patterns), (event, sample)
        assert g.matches("run_stage1f_backtest.py", patterns) and g.matches("requirements-lock.txt", patterns), "the root Phase 1 scripts and requirements"
        for f in g.GATE_FILES:
            assert g.matches(f, patterns), (event, f)
    assert obs_wf[True]["push"]["paths"] == obs_wf[True]["pull_request"]["paths"]


def test_the_gate_files_exist():
    for f in g.GATE_FILES:
        assert (ROOT / f).is_file(), f
