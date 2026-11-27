"""The hand-written A-4 fixture cases, judged by the **production** classifier, backoff and breaker.

Nothing is reimplemented here: `a4_demo.fixture_cases` feeds each case to
`adapters.response.read_response` and `adapters.retry`. These tests pin the
fixture's declared class to what the authoritative code decides, so the fixture
cannot drift from it, plus its provenance and the demo entry point.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

from .conftest import REPO_ROOT

_INFRA_TESTING = str(REPO_ROOT / "infra" / "testing")
if _INFRA_TESTING not in sys.path:
    sys.path.insert(0, _INFRA_TESTING)

from a4_demo.fixture_cases import FIXTURE, load_cases, run_breaker, run_case, to_response  # noqa: E402
from cbdc_ingestion.adapters.faults import FaultClass, is_permanent  # noqa: E402
from cbdc_ingestion.adapters.retry import BackoffPolicy  # noqa: E402
from cbdc_ingestion.adapters.simulation import SIMULATION_TIMING as P  # noqa: E402

CASES = load_cases()
BY_ID = {c.case_id: c for c in CASES}


def test_case_ids_are_unique_and_cover_the_a4_conditions():
    assert len(BY_ID) == len(CASES)
    reasons = {run_case(c)["reason"] for c in CASES}
    assert {"redirect_not_allowed", "response_body_too_large", "wrong_content_type",
            "truncated_stream", "closed_on_connect", "unparsable_body"} <= reasons


@pytest.mark.parametrize("case", CASES, ids=lambda c: c.case_id)
def test_the_fixture_agrees_with_the_authoritative_classifier(case):
    assert run_case(case)["result"] == case.expect


def test_a_permanent_class_gets_no_retry_and_a_recoverable_one_does():
    for case in CASES:
        out = run_case(case)
        if out["result"] == "accepted":
            assert out["retry"] is None
        else:
            assert out["retry"].retry is (not is_permanent(FaultClass(out["result"])))


def test_the_oversized_body_is_abandoned_while_reading():
    out = run_case(BY_ID["A4-BIG-01"])
    assert out["bytes_consumed"] < out["bytes_total"]


def test_retry_after_present_absent_and_invalid_through_the_real_policy():
    waits = {i: run_case(BY_ID[i], BackoffPolicy(seed=1))["retry"]
             for i in ("A4-RL-01", "A4-RL-02", "A4-RL-03")}
    assert waits["A4-RL-01"].wait_ms == P.retry_after_max_ms  # 7 s clamped to the profile ceiling
    assert waits["A4-RL-01"].retry_after_reason == "retry_after_clamped"
    assert waits["A4-RL-02"].retry_after_reason == "retry_after_absent"
    assert waits["A4-RL-03"].retry_after_reason == "retry_after_invalid"


def test_runs_are_reproducible():
    first = [run_case(c, BackoffPolicy(seed=5))["retry"] for c in CASES]
    assert first == [run_case(c, BackoffPolicy(seed=5))["retry"] for c in CASES]


def test_repeated_failures_open_cool_down_probe_and_recover():
    assert run_breaker(BY_ID["A4-5XX-01"], BY_ID["A4-OK-01"]) == \
        ["closed", "closed", "closed", "open", "open", "closed"]


def test_a_response_is_built_fresh_each_time():
    assert to_response(BY_ID["A4-OK-01"]) is not to_response(BY_ID["A4-OK-01"])


def test_fixture_provenance_is_hand_written():
    origin = json.loads(FIXTURE.with_name("a4_cases.v1.origin.json").read_text(encoding="utf-8"))
    assert origin["origin"] == "hand-written" and re.fullmatch(r"\d{4}-\d{2}-\d{2}", origin["created"])
    assert set(origin) <= {"origin", "created", "note"}


def test_no_fixture_in_the_scaffold_lacks_an_origin_record():
    for f in FIXTURE.parent.glob("*.json"):
        if not f.name.endswith(".origin.json"):
            assert f.with_name(f.stem + ".origin.json").is_file(), f.name


def test_the_fixture_demo_entry_point_passes(capsys):
    from a4_demo.run_fixture_demo import main
    assert main() == 0
    out = capsys.readouterr().out
    assert "RESULT: OK" in out and "FAIL" not in out
