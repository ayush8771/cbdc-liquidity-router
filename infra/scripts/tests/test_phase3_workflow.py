"""Static checks of .github/workflows/phase3-observations.yml (P-10): syntax, triggers, and the no-skip and no-secret guards.

Parsed with PyYAML; no network. PyYAML reads the key `on` as the boolean True (YAML 1.1), which is handled here.
"""
import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = ROOT / ".github" / "workflows" / "phase3-observations.yml"
TEXT = WORKFLOW.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def wf():
    return yaml.safe_load(TEXT)


def steps(job):
    return job["steps"]


def run_text(job):
    return "\n".join(s.get("run", "") for s in steps(job))


def test_jobs_and_runner(wf):
    assert wf["name"] == "phase3-observations"
    assert set(wf["jobs"]) == {"contracts", "ingestion-unit", "compose-invariants", "backend-observations", "web-observations",
                                "nginx-sse", "runtime", "guards", "regression-gate", "acceptance-stack", "acceptance-browser"}
    for name, job in wf["jobs"].items():
        assert job["runs-on"] == "ubuntu-24.04", name
        assert job["timeout-minutes"] <= (90 if name.startswith(("acceptance", "regression")) else 20), name
    assert set(wf["jobs"]["runtime"]["needs"]) == {"contracts", "ingestion-unit", "compose-invariants"}


def test_triggers_are_path_filtered_and_safe(wf):
    on = wf[True]
    assert "pull_request_target" not in on and "workflow_run" not in on
    for event in ("push", "pull_request"):
        paths = on[event]["paths"]
        assert ".github/workflows/phase3-observations.yml" in paths
        for needed in ("services/ingestion/**", "services/backend/**", "services/web/**", "infra/compose.observations.yaml",
                       "infra/testing/**", "contracts/events/**", "contracts/test-vectors/**"):
            assert needed in paths, (event, needed)
    assert on["push"]["branches"] == ["main", "feature/phase3-platform"]
    assert wf["permissions"] == {"contents": "read"}


def test_no_secrets_and_no_pull_request_text_in_commands():
    assert "secrets." not in TEXT
    assert not re.search(r"\$\{\{\s*github\.(head_ref|event\.pull_request|event\.head_commit|actor)", TEXT)
    assert "pull_request_target" not in TEXT


def test_every_pytest_step_is_followed_by_the_no_skip_check(wf):
    for name in ("contracts", "ingestion-unit", "compose-invariants"):
        job = wf["jobs"][name]
        pytest_steps = [s for s in steps(job) if "pytest" in s.get("run", "") and "pip install" not in s.get("run", "")]
        assert pytest_steps, name
        for s in pytest_steps:
            assert "--junitxml" in s["run"], (name, s["name"])
        assert "assert_junit_no_skips.py" in run_text(job), name


def test_docker_is_required_not_optional_in_the_compose_job(wf):
    pytest_step = next(s for s in steps(wf["jobs"]["compose-invariants"]) if "pytest" in s.get("run", "") and "pip" not in s["run"])
    assert pytest_step["env"]["CBDC_REQUIRE_DOCKER"] == "1"
    assert "test_compose_observations.py" in pytest_step["run"] and "test_compose.py" in pytest_step["run"]


def test_contracts_job_runs_every_phase3_check(wf):
    text = run_text(wf["jobs"]["contracts"])
    for needed in ("check_event_contracts.py", "check_import_boundaries.py", "test_check_event_contracts.py",
                   "test_check_import_boundaries.py"):
        assert needed in text, needed


def test_ingestion_job_installs_the_optional_cross_checks_so_they_run(wf):
    text = run_text(wf["jobs"]["ingestion-unit"])
    assert "pytest==9.1.1" in text and "rfc8785==0.1.4" in text and "jsonschema==4.23.0" in text and "referencing==" in text


def test_runtime_job_starts_only_ingestion_and_always_cleans_up(wf):
    job = wf["jobs"]["runtime"]
    text = run_text(job)
    assert "up -d --no-build --wait" in text and re.search(r"up -d --no-build --wait[^\n]*\bingestion\b\s*$", text, re.M)
    assert "probe_ingestion_isolation.py" in text and "--instance ingestion-latest" in text and "--expect-events 4" in text
    last = steps(job)[-1]
    assert last["if"] == "always()" and "down --volumes --remove-orphans" in last["run"]
    assert '-p "$P3_PROJECT"' in last["run"], "cleanup must be scoped to this run's project"
    assert "docker system prune" not in text and "docker volume rm" not in text and "docker container prune" not in text
    for line in text.splitlines():
        if re.search(r"docker (rm|network rm|kill|stop)", line) and "P3_PROJECT" not in line:
            raise AssertionError(f"cleanup must name this run's project: {line.strip()}")


def test_phase2_workflows_are_not_referenced_or_weakened():
    for f in (ROOT / ".github" / "workflows").glob("phase2-*.yml"):
        assert "phase3-observations" not in f.read_text(encoding="utf-8"), f.name


def test_runtime_probe_gets_real_targets_and_controls_run_first(wf):
    job = wf["jobs"]["runtime"]
    names = [s.get("name", "") for s in steps(job)]
    controls = next(i for i, n in enumerate(names) if "positive controls" in n)
    probe = next(i for i, n in enumerate(names) if "T-5" in n)
    assert controls < probe, "the sentinels and controls must exist before the probe"
    text = run_text(job)
    for needed in ("PROBE_BLOCKED=", "PROBE_GATEWAY=", "tcp_check.py", "--network-alias", "inference", "postgres"):
        assert needed in text, needed
    # The gateway comes from Docker's network configuration, never from an assumed address.
    assert "docker network inspect --format '{{range .IPAM.Config}}{{.Gateway}}" in text
    assert not re.search(r"\.1[\"' ]|\.1:", text.replace("127.0.0.1", "")), "no assumed .1 gateway"
    # A script read from stdin needs -i with `docker run` (compose exec -T forwards stdin by itself).
    for line in text.splitlines():
        if "docker run" in line and "python -" in line and "< infra" in line:
            assert " -i " in line, line


def test_nginx_job_is_bounded_independent_and_cleans_up_by_project(wf):
    job = wf["jobs"]["nginx-sse"]
    assert "needs" not in job, "the proxy checks need nothing from PR #15, Dev B or Dev C"
    text = run_text(job)
    assert re.search(r"timeout \d+ python infra/testing/nginx_sse/run_checks\.py", text)
    last = steps(job)[-1]
    assert last["if"] == "always()"
    for line in last["run"].splitlines():
        if re.search(r"docker (rm|network rm)", line):
            assert "P3_PROJECT" in line, line
    assert "contracts" not in job.get("needs", [])


def test_the_stub_is_not_in_the_workflow_images_or_dockerfiles():
    assert "stub_backend" not in TEXT.replace("infra/testing/nginx_sse/", "").replace("stub backend", "")
    for dockerfile in (ROOT / "services").glob("*/Dockerfile"):
        assert "infra/testing" not in dockerfile.read_text(encoding="utf-8")


def test_web_job_is_explicit_about_its_dependencies_and_cannot_pass_empty(wf):
    job = wf["jobs"]["web-observations"]
    assert "needs" not in job and job["defaults"]["run"]["working-directory"] == "services/web"
    names = [s.get("name", s.get("uses", "")) for s in steps(job)]
    node = next(s for s in steps(job) if str(s.get("uses", "")).startswith("actions/setup-node@"))
    assert node["with"]["node-version-file"] == ".nvmrc" and node["with"]["cache-dependency-path"] == "services/web/package-lock.json"
    text = run_text(job)
    assert "npm ci" in text and "npm install" not in text, "the lockfile only"
    assert "npm run lint" in text and "tsc --noEmit" in text
    assert "vitest run test/observations" in text and "--reporter=junit" in text and "--outputFile.junit=" in text
    assert "assert_junit_no_skips.py" in text, "an empty or skipped observation suite must fail"
    assert text.index("vitest run") < text.index("assert_junit_no_skips.py")
    build = next(s for s in steps(job) if "npm run build" in s.get("run", ""))
    assert build["env"]["VITE_OBSERVATIONS"] == "on" and "/api/rt/v1/observations/stream" in build["run"]
    assert "ingestion" not in text.lower() or "PR #15" not in text


def test_web_job_does_not_repeat_or_replace_the_phase2_web_tests(wf):
    text = run_text(wf["jobs"]["web-observations"])
    assert "npm test" not in text and "vitest run test/observations" in text
    assert not re.search(r"vitest run\s*$", text, re.M), "only the observation folder, never the whole suite"
    p2 = (ROOT / ".github" / "workflows" / "phase2-docker.yml").read_text(encoding="utf-8")
    assert "cbdc-web-test" in p2, "the Phase 2 web test stage must still be run by phase2-docker.yml"


def test_a_peer_on_the_observations_network_must_reach_ingestion_before_the_probe(wf):
    job = wf["jobs"]["runtime"]
    names = [s.get("name", "") for s in steps(job)]
    peer = next(i for i, n in enumerate(names) if "peer on the observations network" in n)
    probe = next(i for i, n in enumerate(names) if "T-5" in n)
    assert peer < probe
    run = steps(job)[peer]["run"]
    assert "docker run --rm -i --network" in run and '"${P3_PROJECT}_observations"' in run and "ingestion:8300" in run and "tcp_check.py" in run


def test_sigterm_step_has_a_control_and_runs_after_the_live_checks(wf):
    job = wf["jobs"]["runtime"]
    names = [s.get("name", "") for s in steps(job)]
    sig = next(i for i, n in enumerate(names) if "SIGTERM" in n)
    live = next(i for i, n in enumerate(names) if "live /v1/latest" in n)
    assert live < sig, "stopping the service must come after the checks that need it running"
    run = steps(job)[sig]["run"]
    assert "SIG_IGN" in run and '"137"' in run and "4500" in run, "the control must ignore SIGTERM and be killed only at the end of the grace period"
    assert '"$code" = "0"' in run and "-lt 5000" in run
    assert "P3_PROJECT" in run and "sigterm-control" in steps(job)[-1]["run"], "the control container is removed by the project-scoped cleanup"


def test_runtime_job_requires_isolated_gateway_mode_and_probes_where_the_gateway_would_be(wf):
    text = run_text(wf["jobs"]["runtime"])
    assert 'gateway_mode_ipv4"}}' in text or "gateway_mode_ipv4" in text
    assert '"isolated"' in text and "must use isolated gateway mode" in text
    # An empty gateway is accepted only when isolated mode is really set, never silently.
    assert 'O_MODE" = "isolated"' in text and "ipaddress.ip_network" in text


def test_runtime_job_checks_the_engine_version_and_that_ipv6_is_off(wf):
    text = run_text(wf["jobs"]["runtime"])
    assert "sort -V" in text and "28.0.0" in text and "older than 28.0.0" in text
    assert "{{.EnableIPv6}}" in text and "IPv6 must be disabled" in text and "IPv4 subnets only" in text
    assert text.index("sort -V") < text.index("up -d --no-build --wait"), "the engine is checked before the network is created"


def test_import_boundaries_are_mandatory_for_the_observation_module(wf):
    step = next(s for s in steps(wf["jobs"]["contracts"]) if "check_import_boundaries.py" in s.get("run", "") and "pytest" not in s["run"])
    assert "--require-observation-module" in step["run"], "a tree without the observation module must fail, not skip"
    assert "continue-on-error" not in TEXT


def test_backend_job_runs_the_supported_toolchain_and_cannot_pass_empty(wf):
    job = wf["jobs"]["backend-observations"]
    assert job["needs"] == ["contracts"] and set(wf["jobs"]) >= set(job["needs"]), "needs must name real job ids"
    node = next(s for s in steps(job) if str(s.get("uses", "")).startswith("actions/setup-node@"))
    assert node["with"]["node-version-file"] == ".nvmrc" and node["with"]["cache-dependency-path"] == "services/backend/package-lock.json"
    text = run_text(job)
    assert "npm ci" in text and "npm install" not in text, "the lockfile only"
    assert "npm run typecheck" in text
    # The same runner as `npm test` (tsx + node:test), restricted to the observation files, with a JUnit report.
    assert "node --import tsx --test" in text and "--test-reporter=junit" in text and "test/unit/observation*.test.ts" in text
    assert "--experimental-strip-types" not in text and "--experimental-transform-types" not in text
    assert "sharedContracts" not in TEXT, "the shared-fixture tests are a Dev B/C follow-up and are not referenced yet"
    assert text.index("--test-reporter=junit") < text.index("assert_junit_no_skips.py") < text.index("dump_frames.ts")


def test_backend_job_checks_real_frames_with_the_shared_checker(wf):
    text = run_text(wf["jobs"]["backend-observations"])
    assert "node --import tsx ../../infra/testing/observations/dump_frames.ts" in text
    assert re.search(r'check_event_contracts\.py --frames "\$RUNNER_TEMP/frames\.json"', text)
    dump = (ROOT / "infra" / "testing" / "observations" / "dump_frames.ts").read_text(encoding="utf-8")
    assert "createStreamHub" in dump and "createObservationStore" in dump, "frames must come from the real hub and store"


def test_existing_mandatory_phase3_checks_are_still_wired(wf):
    jobs = wf["jobs"]
    assert "check_event_contracts.py" in run_text(jobs["contracts"]) and "ingestion" in run_text(jobs["ingestion-unit"])
    assert "probe_ingestion_isolation.py" in run_text(jobs["runtime"])
    assert set(jobs["runtime"]["needs"]) == {"contracts", "ingestion-unit", "compose-invariants"}


# --- D-24 final acceptance jobs (Stage 7) ---------------------------------------------------------------------------------

def test_acceptance_jobs_depend_on_the_cheap_checks_and_are_bounded(wf):
    jobs = wf["jobs"]
    assert set(jobs["acceptance-stack"]["needs"]) == {"contracts", "backend-observations", "web-observations"}
    assert set(jobs["acceptance-browser"]["needs"]) == {"contracts", "web-observations"}
    assert jobs["regression-gate"]["needs"] == ["guards"]
    for name in ("acceptance-stack", "acceptance-browser"):
        for s in steps(jobs[name]):
            if "timeout " in s.get("run", "") and "tee" in s["run"]:
                assert re.search(r"timeout \d{3,4} python", s["run"]), (name, s["name"])  # every harness run is bounded
    assert "continue-on-error" not in TEXT


def test_t6_uses_the_approved_300_second_soak_and_the_stack_harnesses(wf):
    text = run_text(wf["jobs"]["acceptance-stack"])
    assert "p3_safeguards.py soak" in text and "--soak-seconds 300" in text
    assert "p3_noninterference.py --project" in text and "--absent-project" in text and "--burst-seconds 60" in text
    assert "p3_stream_probe.py --project" in text and "--only auth,quiet,limits,restart,sigterm" in text, "soak and faults run inside the T-6 step, not twice"
    assert text.index("p3_safeguards.py soak") < text.index("p3_noninterference.py") < text.index("p3_stream_probe.py"), "the restart and shutdown phases are last"
    assert "up --root" in text and "--fault --load-users 7" in text and "--no-observations" in text
    assert text.count("p3_stack.py up") == 2, "two stacks in all: observations and plain"


def test_acceptance_logs_are_checked_for_failures_skips_and_missing_checks(wf):
    for name in ("acceptance-stack", "acceptance-browser"):
        job = wf["jobs"][name]
        step = next(s for s in steps(job) if "assert_harness_log.py" in s.get("run", ""))
        assert "always()" in step["if"], name
        assert step["run"].count("--require") >= 3, name
    stack = run_text(wf["jobs"]["acceptance-stack"])
    # The probe is split in two runs (T-6 soak and faults, then the rest). Frame coverage of every message type and freshness
    # state is only computed when a run includes soak and faults, so the log must prove that run did it.
    assert "PASS frames cover every message type and freshness state" in stack
    t6 = next(s for s in steps(wf["jobs"]["acceptance-stack"]) if "p3_safeguards.py soak" in s.get("run", ""))
    assert "--soak-seconds 300" in t6["run"]
    for needed in ("T-6: the host Phase 1 artefact", "T-6: the same hashes inside the inference container", "T-6 after the soak", "T-2: zero calls",
                   "sigterm: the backend exits 0", "faults: recovery"):
        assert needed in stack, needed
    assert "on: passed, off: passed, preview: passed" in run_text(wf["jobs"]["acceptance-browser"]), "all three flavours are required"


def test_acceptance_cleanup_is_scoped_always_runs_and_keeps_diagnostics(wf):
    for name in ("acceptance-stack", "acceptance-browser"):
        job = wf["jobs"][name]
        cleanup = next(s for s in steps(job) if s.get("name") == "Remove what this run created")
        assert "always()" in cleanup["if"], name
        assert "p3_stack.py down" in cleanup["run"] and "cbdc-p3s-*" in cleanup["run"] and "$P3_ROOT" in cleanup["run"], name
        assert not re.search(r"docker (system|volume|image|container) prune|docker rm -f \$\(docker ps", cleanup["run"]), "no unscoped docker cleanup"
        upload = next(s for s in steps(job) if str(s.get("uses", "")).startswith("actions/upload-artifact@"))
        assert "always()" in upload["if"] and upload["with"]["retention-days"] <= 7, name
        assert any("Container logs" in s.get("name", "") for s in steps(job)), name


def test_t7_and_t8_guards_run_with_full_history_and_the_gate_reads_the_existing_workflows(wf):
    guards = wf["jobs"]["guards"]
    assert steps(guards)[0]["with"]["fetch-depth"] == 0, "the baseline commit must be present"
    text = run_text(guards)
    assert "p3_safeguards.py protected" in text and "p3_safeguards.py text" in text and "assert_junit_no_skips.py" in text
    gate = wf["jobs"]["regression-gate"]
    assert gate["permissions"] == {"contents": "read", "actions": "read"}
    gtext = run_text(gate)
    assert "--grace 900" in gtext and "--timeout 4200" in gtext and 4200 < gate["timeout-minutes"] * 60, "the wait is bounded inside the job timeout"
    assert "wait_for_workflows.py" in gtext and "GITHUB_EVENT_PATH" in gtext and "github.event.pull_request" not in TEXT
    assert wf["permissions"] == {"contents": "read"}, "write access is never granted"


def test_the_script_defaults_match_the_workflow_wiring():
    import sys
    sys.path.insert(0, str(ROOT / "infra" / "scripts"))
    sys.path.insert(0, str(ROOT / "e2e"))
    import p3_safeguards as sg
    import wait_for_workflows as wfw
    assert sg.BASELINE == "28da68f" and len(sg.STATUS_DOCS) == 10 and sg.UI_DIR == "services/web/src"
    assert set(wfw.REQUIRED) == {"tests", "phase2-docker"} and set(wfw.OPTIONAL) == {"phase2-integration", "phase2-stack"}
    for name in wfw.REQUIRED + wfw.OPTIONAL:
        assert any(re.search(rf"^name: {name}$", f.read_text(encoding="utf-8"), re.M) for f in (ROOT / ".github" / "workflows").glob("*.yml")), name


def test_acceptance_workflow_paths_cover_the_protected_and_text_scopes(wf):
    for event in ("push", "pull_request"):
        paths = wf[True][event]["paths"]
        for needed in ("e2e/**", "src/**", "data/**", "tests/**", "contracts/fixtures/**", "services/inference/**", "README.md", "docs/PHASE2_STATUS.md",
                       "docs/PHASE3_D24_ACCEPTANCE.md"):
            assert needed in paths, (event, needed)


def test_every_test_file_the_workflow_names_exists():
    for path in re.findall(r"infra/scripts/tests/(test_\w+\.py)", TEXT):
        assert (ROOT / "infra" / "scripts" / "tests" / path).is_file(), path


def test_phase3_browser_spec_is_outside_the_phase2_playwright_discovery(wf):
    """The first CI run failed phase2-stack because e2e/tests/observations.spec.ts was collected by its `npm test`."""
    base = (ROOT / "e2e" / "playwright.config.ts").read_text(encoding="utf-8")
    p3 = (ROOT / "e2e" / "playwright.p3.config.ts").read_text(encoding="utf-8")
    assert 'testDir: "./tests"' in base and 'testDir: "./p3"' in p3 and "./playwright.config" in p3
    assert not list((ROOT / "e2e" / "tests").glob("observations*")), "the Phase 3 spec must not be in the Phase 2 test folder"
    assert (ROOT / "e2e" / "p3" / "observations.spec.ts").is_file()
    runner = (ROOT / "e2e" / "p3_browser_acceptance.py").read_text(encoding="utf-8")
    assert '"-c", "playwright.p3.config.ts"' in runner and "e2e/p3/observations.spec.ts" in runner
    assert "observations.spec" not in (ROOT / ".github" / "workflows" / "phase2-stack.yml").read_text(encoding="utf-8"), "Phase 2 workflows are untouched"
    assert "e2e/p3/observations.spec.ts" in run_text(wf["jobs"]["acceptance-browser"]) + TEXT
