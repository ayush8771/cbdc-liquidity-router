"""Tests for infra/scripts/assert_junit_no_skips.py."""
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

import assert_junit_no_skips as ajs  # noqa: E402


def report(tmp_path, **attrs):
    a = {"tests": "3", "skipped": "0", "failures": "0", "errors": "0", **attrs}
    p = tmp_path / "r.xml"
    p.write_text("<testsuites><testsuite " + " ".join(f'{k}="{v}"' for k, v in a.items()) + "/></testsuites>", encoding="utf-8")
    return str(p)


def test_clean_report_passes(tmp_path):
    assert ajs.main([report(tmp_path)]) == 0


def test_skipped_failed_errored_and_empty_reports_fail(tmp_path):
    for attrs in ({"skipped": "1"}, {"failures": "1"}, {"errors": "1"}, {"tests": "0"}):
        assert ajs.main([report(tmp_path, **attrs)]) == 1, attrs


def test_missing_report_and_no_argument_fail(tmp_path):
    assert ajs.main([str(tmp_path / "missing.xml")]) == 1
    assert ajs.main([]) == 2
