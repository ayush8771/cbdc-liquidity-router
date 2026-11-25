#!/usr/bin/env python3
"""The required Phase 3 acceptance gate (Dev D; docs/PHASE3_D24_ACCEPTANCE.md section 6). Standard library plus PyYAML.

phase3-observations.yml is path-filtered, so for an unrelated pull request it creates no check, and a required check that is never
reported blocks the merge forever. This gate runs on every pull request into the platform branch and reports ONE check, `phase3-acceptance`:

  not required   no changed file matches the trusted path list: pass at once (an unrelated pull request is never blocked).
  required       a changed file matches, or anything is uncertain (fail closed): the phase3-observations run of the SAME commit must have
                 concluded success, and each of the four acceptance jobs must have ended `success` (not skipped, not missing).

Trust. The workflow runs this file from the BASE commit of the pull request (it falls back to the head copy only when the base has none, the
bootstrap case), and the path list is read from the base commit's phase3-observations.yml. A pull request therefore cannot shrink the filter or
edit this logic to excuse itself: a filter that lost a base pattern, or any change to the gate's own files, makes acceptance required.

Fail closed: an unreadable list, a failed diff, a missing or all-zero base, a workflow_dispatch, or an unsupported pattern means required.
A run of another commit, or an older run of this one that a newer run replaced, never counts. Waiting is bounded; a run that never starts fails.

  python phase3_acceptance_gate.py --repo OWNER/NAME --event-name pull_request --event-path FILE --sha SHA   (GITHUB_TOKEN in the environment)
Exit status: 0 pass or not required, 1 anything else.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

WORKFLOW = ".github/workflows/phase3-observations.yml"
WORKFLOW_NAME = "phase3-observations"
# Changing any of these always makes acceptance required, whatever the filter says.
GATE_FILES = (WORKFLOW, ".github/workflows/phase3-acceptance-gate.yml", "infra/scripts/phase3_acceptance_gate.py",
              "infra/scripts/tests/test_phase3_acceptance_gate.py")
# The four acceptance jobs of phase3-observations.yml, by their exact display names. Each must end `success`.
REQUIRED_JOBS = (
    "AD-6 T-7 protected paths, T-8 wording, and the harnesses' own tests",
    "AD-6 T-7 Phase 1 and 2 suites passed on this commit (existing workflows)",
    "AD-6 T-1, T-2, T-6 and real SSE, limits, faults and shutdown (real stacks)",
    "Browser acceptance, panel on, off and preview (real stacks)",
)
PENDING_STATES = {"queued", "in_progress", "waiting", "pending", "requested"}
ZERO_SHA = "0" * 40
SHA = re.compile(r"[0-9a-f]{40}")


class GateError(Exception):
    """Anything that stops the gate from knowing: the caller treats it as 'acceptance required' or as a failure, never as a pass."""


# --- which changes need acceptance -----------------------------------------------------------------------------------

def pattern_regex(pattern: str) -> re.Pattern:
    """GitHub path-filter semantics: `*` matches within one path segment, `**` across segments, `?` one character that is not `/`."""
    if not pattern or pattern.startswith("!"):
        raise GateError(f"unsupported path pattern {pattern!r}")
    out, i = [], 0
    while i < len(pattern):
        if pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out) + r"\Z")


def paths_from_workflow(text: str) -> list:
    """The union of `on.push.paths` and `on.pull_request.paths`. Missing, empty or malformed is an error: no list means no basis to say 'unrelated'."""
    import yaml  # PyYAML, installed by the workflow
    try:
        data = yaml.safe_load(text)
        on = data.get(True, data.get("on"))
        patterns = []
        for event in ("push", "pull_request"):
            paths = on[event]["paths"]
            if not isinstance(paths, list) or not paths or not all(isinstance(p, str) and p for p in paths):
                raise GateError(f"{event}.paths is not a non-empty list of strings")
            patterns += paths
    except GateError:
        raise
    except Exception as e:  # noqa: BLE001 - any parse problem is 'cannot know'
        raise GateError(f"the trusted path list cannot be read ({type(e).__name__})") from e
    return sorted(set(patterns))


def matches(path: str, patterns) -> bool:
    return any(pattern_regex(p).match(path) for p in patterns)


def decide(event_name: str, base: str, base_workflow: str | None, head_workflow: str | None, changed) -> tuple:
    """(required, reason). `base_workflow` and `head_workflow` are the texts of phase3-observations.yml at the base and head commits; None if unreadable."""
    if event_name == "workflow_dispatch":
        return True, "a manual run always requires acceptance"
    if not SHA.fullmatch(base or "") or base == ZERO_SHA:
        return True, "no trusted base commit to compare with"
    try:
        trusted = paths_from_workflow(base_workflow or "")
    except GateError as e:
        return True, f"fail closed: {e}"
    try:
        head_paths = paths_from_workflow(head_workflow or "")
    except GateError as e:
        return True, f"fail closed: the head's path list is unreadable ({e})"
    removed = sorted(set(trusted) - set(head_paths))
    if removed:
        return True, f"filter tampering: the head removed {len(removed)} path pattern(s) the base has, e.g. {removed[0]}"
    try:
        for f in changed:
            if f in GATE_FILES:
                return True, f"the gate itself changed: {f}"
            if matches(f, trusted):
                return True, f"acceptance path changed: {f}"
    except GateError as e:
        return True, f"fail closed: {e}"
    return False, f"none of {len(changed)} changed file(s) matches the {len(trusted)} trusted patterns"


# --- is this commit's acceptance green --------------------------------------------------------------------------------

def evaluate(runs: list, jobs_of, head: str) -> tuple:
    """(state, messages), state in pass | fail | pending. `runs` are workflow runs; `jobs_of(run)` returns that run's jobs.
    Only runs named phase3-observations with exactly this head SHA count; the newest of them decides."""
    mine = [r for r in runs if r.get("name") == WORKFLOW_NAME and r.get("head_sha") == head]
    if not mine:
        return "pending", [f"no {WORKFLOW_NAME} run for {head[:7]} yet"]
    run = max(mine, key=lambda r: (r.get("created_at", ""), r.get("run_attempt", 1), r.get("id", 0)))
    jobs = {j["name"]: j for j in jobs_of(run)}
    failures, pending = [], []
    for name in REQUIRED_JOBS:
        j = jobs.get(name)
        if j is None:
            (pending if run["status"] != "completed" else failures).append(f"job missing: {name}")
        elif j.get("status") != "completed":
            pending.append(f"{name}: {j.get('status')}")
        elif j.get("conclusion") != "success":
            failures.append(f"{name}: {j.get('conclusion')}")  # skipped, failure, cancelled, timed_out ...
    if run["status"] == "completed" and run.get("conclusion") != "success":
        failures.append(f"the {WORKFLOW_NAME} run concluded {run.get('conclusion')}")
    if failures:
        return "fail", failures
    if run["status"] != "completed" or pending:
        return "pending", pending or [f"the {WORKFLOW_NAME} run is {run['status']}"]
    return "pass", [f"{WORKFLOW_NAME} run {run['id']} succeeded with all {len(REQUIRED_JOBS)} acceptance jobs"]


def wait(get_runs, jobs_of, head: str, timeout: float, poll: float, grace: float, clock=time.monotonic, sleep=time.sleep) -> int:
    start = clock()
    while True:
        state, msgs = evaluate(get_runs(), jobs_of, head)
        if state != "pending":
            for m in msgs:
                print(m if state == "pass" else f"::error::{m}")
            return 0 if state == "pass" else 1
        waited = clock() - start
        if waited >= timeout:
            print("::error::timed out waiting for: " + "; ".join(msgs))
            return 1
        if waited >= grace and any(m.startswith(f"no {WORKFLOW_NAME} run") for m in msgs):
            print(f"::error::{WORKFLOW_NAME} never started for this commit, so acceptance cannot be shown (the filter should have started it)")
            return 1
        sleep(poll)


# --- GitHub and git ----------------------------------------------------------------------------------------------------

def api(url: str, token: str) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def git(*args: str) -> str:
    out = subprocess.run(["git", *args], capture_output=True, text=True)
    if out.returncode != 0:
        raise GateError(f"git {args[0]} failed")
    return out.stdout


def changed_files(base: str, head: str) -> list:
    """Files changed on the head since its merge base with the base. Renames are split so both ends are seen. A failed diff raises."""
    return [p for p in git("diff", "--name-only", "--no-renames", "-z", f"{base}...{head}").split("\0") if p]


def show(commit: str, path: str) -> str | None:
    try:
        return git("show", f"{commit}:{path}")
    except GateError:
        return None


def resolve(event_name: str, payload: dict, sha: str) -> tuple:
    """(head, base) from the event."""
    if event_name == "pull_request":
        pr = payload.get("pull_request") or {}
        return (pr.get("head") or {}).get("sha", ""), (pr.get("base") or {}).get("sha", "")
    if event_name == "push":
        return payload.get("after") or sha, payload.get("before", "")
    return sha, ""


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--repo", required=True)
    ap.add_argument("--event-name", required=True)
    ap.add_argument("--event-path", required=True)
    ap.add_argument("--sha", required=True)
    ap.add_argument("--timeout", type=float, default=7500)  # the longest needs-chain of phase3-observations.yml is 125 minutes (a test pins it)
    ap.add_argument("--poll", type=float, default=30)
    ap.add_argument("--grace", type=float, default=900)
    args = ap.parse_args(argv)
    token = os.environ.get("GITHUB_TOKEN", "")
    try:
        payload = json.load(open(args.event_path, encoding="utf-8"))
    except (OSError, ValueError):
        payload = {}
    head, base = resolve(args.event_name, payload, args.sha)
    if not token or not re.fullmatch(r"[\w.-]+/[\w.-]+", args.repo) or not SHA.fullmatch(head):
        print("::error::the gate needs GITHUB_TOKEN, --repo OWNER/NAME and a 40-character head commit")
        return 1
    try:
        changed = changed_files(base, head) if args.event_name != "workflow_dispatch" and SHA.fullmatch(base) and base != ZERO_SHA else []
        diff_error = ""
    except GateError as e:
        changed, diff_error = [], str(e)
    required, reason = decide(args.event_name, base if not diff_error else "", show(base, WORKFLOW) if base else None, show(head, WORKFLOW), changed)
    if diff_error:
        required, reason = True, f"fail closed: the changed files could not be listed ({diff_error})"
    print(f"{'REQUIRED' if required else 'NOT REQUIRED'}: {reason}")
    if not required:
        return 0
    return wait(lambda: api(f"https://api.github.com/repos/{args.repo}/actions/runs?head_sha={head}&per_page=100", token)["workflow_runs"],
                lambda run: api(f"https://api.github.com/repos/{args.repo}/actions/runs/{run['id']}/jobs?per_page=100&filter=latest", token)["jobs"],
                head, args.timeout, args.poll, args.grace)


if __name__ == "__main__":
    sys.exit(main())
