"""git_commit precedence: CBDC_GIT_COMMIT, then git, then "unknown" (Milestone 3, Docker builds)."""
import subprocess
from pathlib import Path

import pytest

from cbdc_inference.api import metadata

SHA40 = "0123456789abcdef0123456789abcdef01234567"


class FakeRun:
    """Stands in for subprocess.run; records calls."""

    def __init__(self, stdout="", returncode=0, raises=None):
        self.stdout, self.returncode, self.raises, self.calls = stdout, returncode, raises, []

    def __call__(self, args, **kwargs):
        self.calls.append(args)
        if self.raises is not None:
            raise self.raises
        return subprocess.CompletedProcess(args, self.returncode, stdout=self.stdout, stderr="")


@pytest.fixture
def fake_git(monkeypatch):
    def install(**kwargs):
        run = FakeRun(**kwargs)
        monkeypatch.setattr(metadata.subprocess, "run", run)
        return run
    return install


@pytest.mark.parametrize("value, expected", [
    (SHA40, SHA40),
    ("603b3df", "603b3df"),
    ("  603B3DF\n", "603b3df"),
    (SHA40.upper(), SHA40),
])
def test_valid_env_commit_wins_and_git_is_not_called(fake_git, value, expected):
    run = fake_git(stdout="aaaaaaa\n")
    assert metadata.git_commit(Path("."), {"CBDC_GIT_COMMIT": value}) == expected
    assert run.calls == []


@pytest.mark.parametrize("value", ["", "   ", "abc", "unknown", "603b3dg", "a" * 41, "603b3df; rm -rf /", "HEAD"])
def test_invalid_env_commit_is_ignored_and_git_is_used(fake_git, value):
    run = fake_git(stdout="1a2b3c4\n")
    assert metadata.git_commit(Path("."), {"CBDC_GIT_COMMIT": value}) == "1a2b3c4"
    assert len(run.calls) == 1


def test_git_is_used_when_env_is_unset(fake_git, tmp_path):
    run = fake_git(stdout="1a2b3c4\n")
    assert metadata.git_commit(tmp_path, {}) == "1a2b3c4"
    assert run.calls == [["git", "-C", str(tmp_path), "rev-parse", "--short", "HEAD"]]


@pytest.mark.parametrize("kwargs", [
    {"raises": FileNotFoundError("git")},             # git not installed (Docker image)
    {"raises": subprocess.TimeoutExpired("git", 5)},
    {"returncode": 128, "stdout": ""},                 # not a git checkout (no .git)
    {"returncode": 0, "stdout": "  \n"},
])
def test_unknown_when_neither_env_nor_git(fake_git, kwargs):
    fake_git(**kwargs)
    assert metadata.git_commit(Path("."), {}) == "unknown"
    assert metadata.git_commit(Path("."), {"CBDC_GIT_COMMIT": "not-a-sha"}) == "unknown"


def test_reads_process_environment_by_default(fake_git, monkeypatch):
    run = fake_git(stdout="1a2b3c4\n")
    monkeypatch.setenv("CBDC_GIT_COMMIT", "deadbeef")
    assert metadata.git_commit(Path(".")) == "deadbeef"
    assert metadata.static_metadata(Path("."))["git_commit"] == "deadbeef"
    # platform.machine() may itself shell out (`ver` on Windows); only git matters here.
    assert [c for c in run.calls if c and c[0] == "git"] == []
