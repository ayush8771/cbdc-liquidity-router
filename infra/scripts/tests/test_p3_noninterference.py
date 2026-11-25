"""Tests for e2e/p3_noninterference.py (Dev D): the judgement logic, and that it is able to fail.

The real evidence (the engine, PostgreSQL and the inference access log of disposable stacks) comes from running the script itself; these
tests prove that the comparisons and the counters would notice a difference, which is what makes a clean run meaningful.
Run: pytest infra/scripts/tests/test_p3_noninterference.py
"""
import copy
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
REPO = SCRIPTS.parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(REPO / "e2e"))

import p3_noninterference as ni  # noqa: E402

DECISION = {"decisionId": "sha256:abc", "policy": "waterfall", "allocations": [{"venue": "A", "amountUsd": 150000.0, "fee": 0.0012345678901234}],
            "metrics": {"completionRatio": 1.0, "rewardEnv": -0.123456789012345}, "flags": [True, None, "x"]}


# --- diff: exact, structural, and able to fail ------------------------------------------------------------------

def test_identical_documents_have_no_differences():
    assert ni.diff(DECISION, copy.deepcopy(DECISION)) == []


@pytest.mark.parametrize("change, fragment", [
    (lambda d: d["allocations"][0].update(amountUsd=150000.00000001), "$.allocations[0].amountUsd"),
    (lambda d: d["metrics"].update(rewardEnv=-0.123456789012346), "$.metrics.rewardEnv"),
    (lambda d: d.update(decisionId="sha256:abd"), "$.decisionId"),
    (lambda d: d["allocations"].append({}), "length 1 != 2"),
    (lambda d: d.update(extra=1), "missing on one side"),
    (lambda d: d["metrics"].update(completionRatio=1), "float 1.0 != int 1"),
    (lambda d: d["flags"].__setitem__(1, 0), "$.flags[1]"),
])
def test_any_difference_is_found_with_its_path(change, fragment):
    other = copy.deepcopy(DECISION)
    change(other)
    found = ni.diff(DECISION, other)
    assert found and any(fragment in f for f in found), found


# --- counters ---------------------------------------------------------------------------------------------------

def test_row_counts_are_parsed_and_malformed_output_is_refused():
    assert ni.parse_counts("3|3|1|1|6\n") == {"TransactionRequest": 3, "RoutingDecision": 3, "Comparison": 1, "Explanation": 1, "AuditLog": 6}
    for bad in ("", "1|2|3", "a|b|c|d|e", "1|2|3|4|5|6", "ERROR: relation does not exist"):
        with pytest.raises(ValueError):
            ni.parse_counts(bad)


UVICORN = """INFO:     Started server process [1]
INFO:     172.20.0.4:41234 - "GET /v1/healthz HTTP/1.1" 200 OK
INFO:     172.20.0.4:41236 - "GET /v1/version HTTP/1.1" 200 OK
INFO:     172.20.0.4:41238 - "POST /v1/route HTTP/1.1" 200 OK
INFO:     172.20.0.4:41240 - "POST /v1/route HTTP/1.1" 422 Unprocessable Entity
INFO:     172.20.0.4:41242 - "POST /v1/compare HTTP/1.1" 200 OK
INFO:     172.20.0.4:41244 - "POST /v1/explain HTTP/1.1" 200 OK
INFO:     172.20.0.4:41246 - "GET /v1/state?date=2024-06-14 HTTP/1.1" 200 OK
"""


def test_the_inference_access_log_is_read_by_endpoint():
    assert ni.parse_inference_log(UVICORN) == {"route": 2, "compare": 1, "explain": 1, "other": 1}
    assert ni.parse_inference_log("") == {"route": 0, "compare": 0, "explain": 0, "other": 0}
    assert ni.parse_inference_log('"POST /v1/routes/extra HTTP/1.1" 200')["route"] == 0, "only the exact endpoint is an engine call"


def test_a_positive_control_that_sees_nothing_fails():
    before = {"TransactionRequest": 5, "route": 2, "AuditLog": 9}
    assert ni.control_problems(before, dict(before), {"TransactionRequest": 1, "route": 1}) != [], "a blind measurement must not pass"
    after = {"TransactionRequest": 6, "route": 3, "AuditLog": 9}
    assert ni.control_problems(before, after, {"TransactionRequest": 1, "route": 1}) == []
    assert any("AuditLog" in p for p in ni.control_problems(before, after, {"AuditLog": 3}))


def test_the_quiet_check_notices_one_extra_row_or_one_extra_call():
    before = {t: 4 for t in ni.TABLES} | {c: 7 for c in ni.CALLS}
    assert ni.quiet_problems(before, dict(before), ni.TABLES + ni.CALLS) == []
    for key in ni.TABLES + ni.CALLS:
        after = dict(before)
        after[key] += 1
        assert ni.quiet_problems(before, after, ni.TABLES + ni.CALLS) == [f"{key}: {before[key]} -> {after[key]}"]
    assert ni.quiet_problems(before, {**before, "AuditLog": 3}, ni.TABLES), "a decrease is a change too"


def test_the_requests_come_from_the_contract_fixtures_and_a_different_one_differs():
    a, b, c = (ni.load_fixture(n) for n in (ni.TX_FIXTURE, ni.OTHER_TX_FIXTURE, ni.CMP_FIXTURE))
    assert a["senderCountry"] == "GBR" and "policy" not in a and b["policy"] == "cheapestFeasible" and "policies" in c
    assert ni.diff(a, b), "the sensitivity control must really be a different request"


def test_arguments_are_validated():
    assert ni.main([]) == 2
    assert ni.main(["--up", "--project", "cbdc-p3s-00000000"]) == 2
    assert ni.main(["--project", "cbdc-p3s-00000000"]) == 2  # needs --absent-project too
    assert ni.main(["--up", "--burst-seconds", "5"]) == 2
    assert ni.main(["--project", "cbdc-router", "--absent-project", "cbdc-router"]) == 2  # refused by p3_stack.load_state
