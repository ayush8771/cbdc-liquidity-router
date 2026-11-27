"""The A-4 demonstration is kept honest by the suite that shares its bridge.

A demonstration nobody runs rots, and a demonstration that cannot fail proves
nothing. So the CLI is **executed here**: every scenario runs, every check must
pass, and the exit code must be 0. It is called in process rather than through a
subprocess, so it needs no interpreter path and no Docker and stays inside the
`ingestion-unit` job with no workflow change.

Because the demonstration and the A-4 suites import the **same** bridge
(`infra/testing/a4_demo/bridge.py`), the demonstration cannot show a behaviour
the suite does not assert, and the suite cannot assert one the demonstration
would not reproduce.
"""
from __future__ import annotations

import json

import pytest

from .a4_support import _INFRA_TESTING  # noqa: F401 - puts infra/testing on sys.path

from a4_demo import run_demo  # noqa: E402


def test_the_demonstration_runs_and_every_check_passes():
    assert run_demo.main([]) == 0


def test_the_demonstration_exercises_every_scenario_it_declares():
    assert len(run_demo.SCENARIOS) >= 6
    names = {s()["name"] for s in run_demo.SCENARIOS}
    assert names == {
        "clean",
        "provider_unavailable_then_recovery",
        "auth_failure_is_permanent",
        "circuit_breaker",
        "whole_response_rejection",
        "silence_is_an_outage",
    }


def test_every_scenario_carries_at_least_one_check():
    """A scenario with no check would print a table and assert nothing."""
    for build in run_demo.SCENARIOS:
        scenario = build()
        assert scenario["checks"], scenario["name"]
        assert scenario["claim"], scenario["name"]
        assert scenario["log"], scenario["name"]


def test_the_json_form_is_deterministic_and_machine_readable(capsys):
    """Determinism is the claim that makes the demonstration evidence rather
    than an anecdote, so it is asserted by running it twice."""
    assert run_demo.main(["--json"]) == 0
    first = capsys.readouterr().out
    assert run_demo.main(["--json"]) == 0
    second = capsys.readouterr().out

    assert first == second, "two runs must produce identical output"
    document = json.loads(first)
    assert document["profile"] == "SIMULATION_ONLY"
    assert len(document["scenarios"]) == len(run_demo.SCENARIOS)


def test_an_unknown_scenario_name_fails_rather_than_passing_vacuously():
    assert run_demo.main(["--only", "does-not-exist"]) == 2


def test_one_named_scenario_can_be_run_alone():
    assert run_demo.main(["--only", "clean"]) == 0


def test_the_header_states_the_profile_is_not_ad8(capsys):
    """A printed millisecond count must never be mistaken for an approved
    production threshold, so the header says so and the test holds it there."""
    run_demo.main([])
    out = capsys.readouterr().out
    assert "SIMULATION_ONLY" in out
    assert "unapproved" in out
    assert "gates remain CLOSED" in out


def test_a_failing_check_would_be_reported_and_change_the_exit_code(monkeypatch):
    """The demonstration's own failure path, so a green run means something.

    A scenario is replaced with one carrying a failing check; `main` must report
    it and return 1. Without this, every PASS above would also appear if the
    checks were never evaluated.
    """
    def _broken():
        return {"name": "broken", "claim": "deliberately false",
                "log": [{c: 0 for c in ("at_ms", "produced", "published", "quarantined",
                                        "faults", "item_faults", "adapter_state",
                                        "source_status", "published_status", "breaker",
                                        "transport_calls", "reasons")}],
                "checks": [("this check is meant to fail", False)]}

    monkeypatch.setattr(run_demo, "SCENARIOS", (_broken,))
    assert run_demo.main([]) == 1


def test_the_demonstration_opens_no_socket():
    """It is a demonstration of fault handling, not of networking. Asserted the
    same way acceptance criterion 11 asserts the scaffold: against import nodes
    of the module's own source, not its prose."""
    import ast
    from pathlib import Path

    forbidden = {"socket", "ssl", "http", "urllib", "requests", "httpx", "aiohttp",
                 "websockets", "asyncio", "socketserver", "subprocess"}
    for name in ("run_demo.py", "bridge.py", "__init__.py"):
        path = Path(_INFRA_TESTING) / "a4_demo" / name
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                roots = [a.name.split(".")[0] for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                roots = [(node.module or "").split(".")[0]] if node.level == 0 else []
            else:
                continue
            assert forbidden.isdisjoint(roots), f"{name} imports {set(roots) & forbidden}"


def test_the_demo_directory_is_outside_the_ingestion_build_context():
    """Belt and braces with `test_image_packaging.py`: the CLI must not be
    packageable, whatever the Dockerfile later says."""
    from pathlib import Path

    from .conftest import SERVICE_ROOT

    demo = Path(_INFRA_TESTING) / "a4_demo"
    assert demo.is_dir()
    assert Path(SERVICE_ROOT).resolve() not in demo.resolve().parents


@pytest.mark.parametrize("scenario_name", [
    "clean", "provider_unavailable_then_recovery", "auth_failure_is_permanent",
    "circuit_breaker", "whole_response_rejection", "silence_is_an_outage",
])
def test_each_scenario_passes_on_its_own(scenario_name):
    """So a failure names the scenario rather than only the whole run."""
    assert run_demo.main(["--only", scenario_name]) == 0
