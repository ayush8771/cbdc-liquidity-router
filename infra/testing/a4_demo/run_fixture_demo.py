"""Fixture-driven A-4 demonstration: `python infra/testing/a4_demo/run_fixture_demo.py`.

Runs the hand-written cases through the production classifier, backoff and
breaker. In-process, no network; exits non-zero on any mismatch.
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
for path in (REPO_ROOT / "services" / "ingestion", REPO_ROOT / "infra" / "testing"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from a4_demo.fixture_cases import load_cases, run_breaker, run_case  # noqa: E402


def main() -> int:
    cases = {c.case_id: c for c in load_cases()}
    bad = 0
    for case in cases.values():
        out = run_case(case)
        ok = out["result"] == case.expect
        bad += not ok
        wait = f" wait={out['retry'].wait_ms}ms" if out["retry"] and out["retry"].retry else ""
        print(f"{'PASS' if ok else 'FAIL'} {case.case_id:12} {out['result']:20} {out['reason']}{wait}")
    visited = run_breaker(cases["A4-5XX-01"], cases["A4-OK-01"])
    ok = visited == ["closed", "closed", "closed", "open", "open", "closed"]
    bad += not ok
    print(f"{'PASS' if ok else 'FAIL'} breaker states {visited}")
    print(f"RESULT: {'FAILED' if bad else 'OK'} ({bad} failing)")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
