"""A-4 harness tests (AD-5 s13 A-4). Run: python -m pytest infra/testing/fake_provider/tests -p no:cacheprovider"""
from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

import pytest

PKG = Path(__file__).resolve().parents[1]
REPO = PKG.parents[2]
sys.path.insert(0, str(PKG.parent))

from fake_provider.harness import (Backoff, Breaker, ManualClock, Outcome, SimResponse,  # noqa: E402
                                   classify, load_cases, log_line, parse_retry_after, run_script)
from fake_provider.provider import Deliver, Fault, Silence  # noqa: E402

LIMITS, CASES, EXPECT = load_cases()
DOWN = Deliver((SimResponse("A4-5XX-01", status=503, content_type="text/plain"),))
UP = Deliver((CASES[0],))


@pytest.mark.parametrize("case", CASES, ids=lambda c: c.case_id)
def test_every_case_classifies_as_declared(case):
    assert classify(case, LIMITS).result == EXPECT[case.case_id]


def test_case_ids_are_unique_and_cover_the_a4_list():
    ids = [c.case_id for c in CASES]
    assert len(ids) == len(set(ids))
    reasons = {classify(c, LIMITS).reason for c in CASES}
    assert {"redirect", "oversized", "wrong_content_type", "truncated", "closed_on_connect", "malformed"} <= reasons


def test_oversized_body_is_abandoned_while_reading_not_after():
    big = next(c for c in CASES if c.case_id == "A4-BIG-01")
    out = classify(big, LIMITS)
    assert out.reason == "oversized" and out.bytes_read < len(big.body)


def test_retry_after_present_absent_and_invalid():
    by = {c.case_id: classify(c, LIMITS) for c in CASES}
    assert by["A4-RL-01"].retry_after_s == 7
    assert by["A4-RL-02"].retry_after_s is None and by["A4-RL-03"].retry_after_s is None
    assert parse_retry_after("0") == 1 and parse_retry_after("999") == 30  # clamped
    assert parse_retry_after("-5") is None and parse_retry_after("") is None


def test_backoff_is_seeded_and_retry_after_overrides():
    a, b = Backoff(1), Backoff(1)
    o = Outcome("x", "provider_unavailable", "r")
    assert [a.next_wait(o) for _ in range(5)] == [b.next_wait(o) for _ in range(5)]
    assert Backoff(1).next_wait(Outcome("x", "rate_limited", "r", retry_after_s=9)) == 9.0


def test_rate_limited_never_shortens_the_next_wait():
    b = Backoff(3)
    long = b.next_wait(Outcome("x", "rate_limited", "r", retry_after_s=20))
    assert b.next_wait(Outcome("x", "rate_limited", "r", retry_after_s=2)) >= long


def test_breaker_opens_cools_down_probes_and_recovers():
    clock = ManualClock()
    br = Breaker("s", clock)
    for _ in range(3):
        assert br.allow()
        br.record(False)
    assert br.state == "open" and not br.allow()
    clock.advance(10)
    assert br.allow() and br.state == "half_open"
    br.record(False)  # a failed probe reopens it
    assert br.state == "open" and not br.allow()
    clock.advance(10)
    assert br.allow()
    br.record(True)
    assert br.state == "closed" and br.history == ["closed", "open", "half_open", "open", "half_open", "closed"]


def test_breaker_is_per_source():
    clock = ManualClock()
    a, b = Breaker("a", clock), Breaker("b", clock)
    for _ in range(3):
        a.record(False)
    assert a.state == "open" and b.state == "closed" and b.allow()


def test_failures_outside_the_window_do_not_open_it():
    clock = ManualClock()
    br = Breaker("s", clock)
    for _ in range(5):
        br.record(False)
        clock.advance(31)
    assert br.state == "closed"


def test_script_run_opens_and_recovers_and_is_reproducible():
    hist: list = []
    t1 = run_script([DOWN] * 4 + [UP, UP], history=hist)
    assert t1 == run_script([DOWN] * 4 + [UP, UP])
    assert {"open", "half_open", "closed"} <= set(hist[0])
    assert t1[-1][1] == "accepted"


def test_silence_and_item_faults_never_trip_the_breaker():
    hist: list = []
    run_script([Silence()] * 5 + [Fault("item", "bad_value")] * 5 + [UP], history=hist)
    assert hist[0] == ["closed"]


def test_permanent_faults_stop_without_retry():
    for step in (Fault("permanent", "x"), Deliver((CASES[5],)), Deliver((CASES[6],))):  # fault, 401, redirect
        t = run_script([step, UP, UP])
        assert t[-1][1] == "failed_permanent" and not any(r == "accepted" for _, r, _ in t)


def test_log_lines_carry_codes_only():
    lines: list = []
    leaky = SimResponse("A4-X", status=302, body=b"SECRET-BODY", location="/secret-place", retry_after="7")
    run_script([Deliver((leaky,))], log=lines.append)
    text = "\n".join(lines)
    assert "SECRET" not in text and "secret-place" not in text and "redirect" in text
    assert re.fullmatch(r"source=\S+ case=\S+ result=\S+ reason=\S+ breaker=\S+", log_line("s", Outcome("c", "r", "x"), "closed"))


def test_fixture_provenance_is_hand_written_with_no_provider_origin():
    origin = json.loads((PKG / "fixtures" / "a4_cases.v1.origin.json").read_text(encoding="utf-8"))
    assert origin["origin"] in ("hand-written", "synthetic") and re.fullmatch(r"\d{4}-\d{2}-\d{2}", origin["created"])
    assert set(origin) <= {"origin", "created", "note"}  # hand-written: no seed fields


def test_every_fixture_has_an_origin_record():
    for f in (PKG / "fixtures").glob("*.json"):
        if not f.name.endswith(".origin.json"):
            assert f.with_name(f.stem + ".origin.json").is_file(), f.name


FORBIDDEN = {"socket", "http", "urllib", "ssl", "requests", "httpx", "aiohttp", "asyncio", "subprocess",
             "cbdc_ingestion", "cbdc_inference", "src", "services"}


def test_import_boundary_and_no_urls_in_the_package():
    for path in PKG.glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for n in ast.walk(tree):
            roots = ([a.name.split(".")[0] for a in n.names] if isinstance(n, ast.Import)
                     else [(n.module or "").split(".")[0]] if isinstance(n, ast.ImportFrom) and n.level == 0 else [])
            assert not FORBIDDEN & set(roots), f"{path.name} imports {roots}"
            if isinstance(n, ast.Constant) and isinstance(n.value, str):
                assert ":" + "//" not in n.value, path.name


def test_the_fixture_stays_outside_the_ingestion_build_context():
    ctx = (REPO / "services" / "ingestion").resolve()
    assert ctx not in PKG.resolve().parents and PKG.resolve() != ctx


def test_demo_command_runs_and_passes(capsys):
    from fake_provider.demo import main  # in-process: the scaffold may not import subprocess
    assert main() == 0
    out = capsys.readouterr().out
    assert "RESULT: OK" in out and "FAIL" not in out
