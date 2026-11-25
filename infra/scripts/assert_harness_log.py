#!/usr/bin/env python3
"""Fails when a harness log shows a failure, a skip, a test that did not run, or no passing result at all (Dev D, Stage 7 CI).

The Phase 3 acceptance harnesses (e2e/p3_*.py) and Playwright print results as text rather than JUnit. This applies the same
no-unexpected-skip rule that assert_junit_no_skips.py applies to pytest: a mandatory check that is skipped, never ran or failed fails the job.

  python infra/scripts/assert_harness_log.py LOG [LOG ...] [--require REGEX ...]
A log fails on: a line starting `FAIL ` or `SKIP `, a count `N failed|skipped|did not run|flaky|interrupted` with N > 0, or no `N passed` with N > 0.
--require REGEX (repeatable, matched against all logs together) must match at least once, for example the runner's own "on: passed" summary.
Exit status 0 when every log is clean, 1 otherwise. Standard library only.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

BAD_LINE = re.compile(r"^(?:FAIL|SKIP) .*$", re.M)
BAD_COUNT = re.compile(r"\b([1-9]\d*) (failed|skipped|did not run|flaky|interrupted)\b")
PASSED = re.compile(r"\b([1-9]\d*) passed\b")


def problems(text: str) -> list:
    out = [m.group(0)[:160] for m in BAD_LINE.finditer(text)]
    out += [f"{m.group(1)} {m.group(2)}" for m in BAD_COUNT.finditer(text)]
    if not PASSED.search(text):
        out.append("no passing result found (an empty or crashed run)")
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("logs", nargs="+", type=Path)
    ap.add_argument("--require", action="append", default=[])
    args = ap.parse_args(argv)
    bad, texts = 0, []
    for log in args.logs:
        if not log.is_file():
            print(f"::error::{log.name}: the log does not exist")
            bad += 1
            continue
        text = log.read_text(encoding="utf-8", errors="replace")
        texts.append(text)
        found = problems(text)
        for f in found:
            print(f"::error::{log.name}: {f}")
        bad += bool(found)
    joined = "\n".join(texts)
    for r in args.require:
        if not re.search(r, joined, re.M):
            print(f"::error::required text not found in any log: {r}")
            bad += 1
    print(f"{len(args.logs)} log(s) checked, {bad} problem(s)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
