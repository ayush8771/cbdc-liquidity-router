"""Fail unless a pytest JUnit report ran tests and skipped none (phase3-observations: no silently skipped mandatory test).

Usage:  python infra/scripts/assert_junit_no_skips.py REPORT.xml [REPORT.xml ...]
Exit status 0 when every report has at least one test and no skipped, failed or errored test. Standard library only.
"""
from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def problems(path: Path) -> list[str]:
    try:
        root = ET.parse(path).getroot()
    except (OSError, ET.ParseError) as exc:
        return [f"{path}: unreadable report ({type(exc).__name__})"]
    suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
    total = sum(int(s.get("tests", 0)) for s in suites)
    out = []
    if total == 0:
        out.append(f"{path}: no test ran")
    for key in ("skipped", "failures", "errors"):
        n = sum(int(s.get(key, 0)) for s in suites)
        if n:
            out.append(f"{path}: {n} {key} of {total} tests")
    return out


def main(argv=None) -> int:
    paths = [Path(a) for a in (sys.argv[1:] if argv is None else argv)]
    if not paths:
        print("usage: assert_junit_no_skips.py REPORT.xml [...]", file=sys.stderr)
        return 2
    found = [p for path in paths for p in problems(path)]
    for p in found:
        print(f"FAIL {p}")
    if not found:
        print("no skipped, failed or errored test in " + ", ".join(str(p) for p in paths))
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
