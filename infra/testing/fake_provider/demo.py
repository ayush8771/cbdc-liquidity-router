"""A-4 demonstration: `python infra/testing/fake_provider/demo.py` (in-process; no network)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fake_provider.harness import SimResponse, classify, load_cases, run_script  # noqa: E402
from fake_provider.provider import Deliver, Fault  # noqa: E402


def main() -> int:
    limits, cases, expect = load_cases()
    bad = 0
    print("== case catalogue ==")
    for case in cases:
        out = classify(case, limits)
        ok = out.result == expect[case.case_id]
        bad += not ok
        print(f"{'PASS' if ok else 'FAIL'} {case.case_id:12} -> {out.result:20} {out.reason}"
              + (f" retry_after={out.retry_after_s}s" if out.retry_after_s else ""))
    print("== breaker: 3 outages, cooldown, failed probe, recovery ==")
    down = Deliver((SimResponse("A4-5XX-01", status=503, content_type="text/plain"),))
    up = Deliver((cases[0],))
    lines: list = []
    hist: list = []
    run_script([down, down, down, down, up, up], log=lines.append, history=hist)
    print("\n".join(lines))
    for want in ("open", "half_open", "closed"):
        hit = want in hist[0]
        bad += not hit
        print(f"{'PASS' if hit else 'FAIL'} breaker reached {want}")
    print("== permanent fault never retries ==")
    t2 = run_script([Fault("permanent", "auth"), Deliver()])
    ok = t2[-1][1] == "failed_permanent"
    bad += not ok
    print(f"{'PASS' if ok else 'FAIL'} {t2[-1][1]}")
    print(f"RESULT: {'FAILED' if bad else 'OK'} ({bad} failing)")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
