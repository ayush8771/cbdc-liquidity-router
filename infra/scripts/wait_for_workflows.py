#!/usr/bin/env python3
"""Waits for the existing Phase 1/Phase 2 workflows on a commit and requires them to have passed (AD-6 T-7, Dev D, Stage 7 CI).

T-7 says the Phase 1 and 2 suites pass unmodified. Those suites already run in tests.yml and the phase2-* workflows, so this does
not run them again: it reads their result for the same commit through the GitHub REST API (the default GITHUB_TOKEN, `actions: read`).

  REQUIRED  workflows that run on every pull request and push; absent after the wait is a failure.
  OPTIONAL  workflows with a path filter; if one ran for the commit it must have passed, and if it did not run nothing is claimed.
What ran and what did not is printed, so the evidence says what was and was not covered.

  python infra/scripts/wait_for_workflows.py --repo OWNER/NAME --sha SHA [--timeout 3600] [--poll 30]   (token in GITHUB_TOKEN)
Exit status 0 when everything that ran passed, 1 otherwise, 2 on unusable arguments. Standard library only.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.request

REQUIRED = ("tests", "phase2-docker")
OPTIONAL = ("phase2-integration", "phase2-stack")


def judge(runs: list, required=REQUIRED, optional=OPTIONAL) -> tuple:
    """(finished, failures, pending, notes) from workflow runs [{name, status, conclusion}] of one commit. The newest run of a name wins."""
    latest = {}
    for r in runs:
        latest.setdefault(r["name"], r)  # the API lists newest first
    failures, pending, notes = [], [], []
    for name in required + optional:
        r = latest.get(name)
        if r is None:
            if name in required:
                pending.append(f"{name}: not found yet")
            else:
                notes.append(f"{name}: did not run for this commit (path filter); nothing is claimed for it")
        elif r["status"] != "completed":
            pending.append(f"{name}: {r['status']}")
        elif r["conclusion"] != "success":
            failures.append(f"{name}: {r['conclusion']}")
        else:
            notes.append(f"{name}: success")
    return not pending, failures, pending, notes


def wait(get_runs, timeout: float, poll: float, clock=time.monotonic, sleep=time.sleep, grace: float = 900) -> int:
    """`grace`: a REQUIRED workflow that has not appeared at all after this many seconds never will (path filter, rename), so fail then."""
    start = clock()
    end = start + timeout
    while True:
        finished, failures, pending, notes = judge(get_runs())
        if failures or finished:  # a failure ends the wait at once
            for n in notes:
                print(f"INFO {n}")
            for f in failures:
                print(f"::error::{f}")
            return 1 if failures else 0
        if clock() >= end:
            print("::error::timed out waiting for: " + "; ".join(pending))
            return 1
        absent = [p for p in pending if p.endswith("not found yet")]
        if absent and clock() - start >= grace:
            print("::error::a required workflow never started for this commit: " + "; ".join(absent))
            return 1
        sleep(poll)


def fetch(repo: str, sha: str, token: str) -> list:
    req = urllib.request.Request(f"https://api.github.com/repos/{repo}/actions/runs?head_sha={sha}&per_page=100",
                                 headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["workflow_runs"]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--repo", required=True)
    ap.add_argument("--sha", required=True)
    ap.add_argument("--timeout", type=float, default=3600)
    ap.add_argument("--poll", type=float, default=30)
    ap.add_argument("--grace", type=float, default=900, help="seconds to wait for a required workflow to appear at all")
    args = ap.parse_args(argv)
    token = os.environ.get("GITHUB_TOKEN", "")
    if not token or not re.fullmatch(r"[\w.-]+/[\w.-]+", args.repo) or not re.fullmatch(r"[0-9a-f]{40}", args.sha):
        print("GITHUB_TOKEN, --repo OWNER/NAME and a 40-character --sha are required", file=sys.stderr)
        return 2
    return wait(lambda: fetch(args.repo, args.sha, token), args.timeout, args.poll, grace=args.grace)


if __name__ == "__main__":
    sys.exit(main())
