"""Tests for infra/scripts/p3_stack.py (Dev D, the disposable D-24 full-stack harness).

Nothing here starts a container or builds an image. The docker-resolving test needs the docker CLI and is skipped without it,
unless CBDC_REQUIRE_DOCKER=1 (then a missing CLI fails). Run: pytest infra/scripts/tests/test_p3_stack.py
"""
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

import p3_stack as p3  # noqa: E402


@pytest.fixture
def state(tmp_path):
    return p3.prepare_config(tmp_path / "root", "0a1b2c3d", 18123, "abc123")


@pytest.fixture
def root(state):
    return Path(state["work"]).parent


# --- names, state, refusal --------------------------------------------------------------------------------

def test_names_are_run_specific_and_unmistakable():
    assert p3.project_name("0a1b2c3d") == "cbdc-p3s-0a1b2c3d"
    assert p3.image_tag("backend", "0a1b2c3d") == "cbdc-p3s-backend:0a1b2c3d"
    assert p3.PROJECT_RE.match("cbdc-p3s-0a1b2c3d")
    for foreign in ("cbdc-router", "cbdc-stack-1-1", "cbdc-p3-1-1", "cbdc-p3s-XYZ", "cbdc-p3s-0a1b2c3d-x", "", "cbdc-p3s-0a1b2c3"):
        assert not p3.PROJECT_RE.match(foreign), foreign
    assert len({p3.new_suffix() for _ in range(20)}) > 1


@pytest.mark.parametrize("project", ["cbdc-router", "cbdc-stack-1-1", "../cbdc-p3s-0a1b2c3d", "cbdc-p3s-0a1b2c3d/.."])
def test_a_project_this_harness_did_not_create_is_refused(root, project):
    with pytest.raises(p3.HarnessError, match="refusing project"):
        p3.load_state(root, project)


def test_state_round_trips_and_a_tampered_state_is_refused(root, state):
    assert p3.load_state(root, state["project"]) == state
    path = Path(state["work"]) / "state.json"
    for change in ({"project": "cbdc-router"}, {"suffix": "ffffffff"}, {"work": str(root)}, {"port": "80"}):
        path.write_text(json.dumps({**state, **change}), encoding="utf-8")
        with pytest.raises(p3.HarnessError):
            p3.load_state(root, state["project"])


def test_main_refuses_to_clean_up_or_smoke_a_foreign_project(root, capsys):
    for command in ("down", "smoke"):
        assert p3.main([command, "--project", "cbdc-router", "--root", str(root)]) == 2
        assert p3.main([command, "--project", "cbdc-p3s-deadbeef", "--root", str(root)]) == 2  # well formed but unknown
    assert "refusing project" in capsys.readouterr().err


# --- published port ---------------------------------------------------------------------------------------

def test_a_free_loopback_port_is_picked_and_is_really_free():
    port = p3.pick_port()
    assert 1024 <= port <= 65535 and p3.port_is_free(port)


def test_an_explicit_port_is_used_only_if_free_and_in_range():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as held:
        held.bind((p3.LOOPBACK, 0))
        held.listen(1)
        busy = held.getsockname()[1]
        with pytest.raises(p3.HarnessError, match="already in use"):
            p3.pick_port(busy)
        assert not p3.port_is_free(busy)
        assert p3.pick_port() != busy
    for bad in (0, 80, 70000):
        with pytest.raises(p3.HarnessError, match="outside"):
            p3.pick_port(bad)
    free = p3.pick_port()
    assert p3.pick_port(free) == free


# --- disposable configuration ----------------------------------------------------------------------------

def test_env_files_get_one_generated_password_and_no_placeholder(state):
    work = Path(state["work"])
    passwords = set()
    for name in ("postgres", "backend", "inference"):
        text = (work / "env" / f"{name}.env").read_text(encoding="utf-8")
        assert "CHANGE_ME" not in text, name
        example = (p3.ENV_EXAMPLES / f"{name}.env.example").read_text(encoding="utf-8")
        if "CHANGE_ME_LOCAL_ONLY" in example:  # inference.env.example carries no secret
            start = example.index("CHANGE_ME_LOCAL_ONLY")
            generated = text[start:start + 32]
            assert len(generated) == 32 and generated.isalnum()
            passwords.add(generated)
        else:
            assert text == example
    assert len(passwords) == 1, "the services must share the generated database password"
    # A second project gets a different password: nothing is derived from the name or reused.
    other = p3.prepare_config(Path(state["work"]).parent, "11223344", 18124)
    assert (Path(other["work"]) / "env" / "postgres.env").read_text() != (work / "env" / "postgres.env").read_text()


def test_dev_tokens_hold_only_hashes_and_the_smoke_file_the_matching_tokens(state):
    work = Path(state["work"])
    dev = json.loads((work / "dev-tokens.json").read_text(encoding="utf-8"))
    smoke = json.loads((work / "smoke-tokens.json").read_text(encoding="utf-8"))
    assert {u["role"] for u in dev["users"]} == {"analyst", "viewer"} == set(smoke)
    for u in dev["users"]:
        token = smoke[u["role"]]["token"]
        assert len(token) == 64 and smoke[u["role"]]["userId"] == u["userId"]
        assert u["tokenSha256"] == hashlib.sha256(token.encode()).hexdigest()
        assert token not in json.dumps(dev), "dev-tokens.json must never hold a raw token"
    assert smoke["analyst"]["token"] != smoke["viewer"]["token"]


def test_configuration_never_lands_in_the_checkout_and_a_run_directory_is_never_reused(tmp_path):
    with pytest.raises(p3.HarnessError, match="inside the repository"):
        p3.prepare_config(p3.REPO / "infra" / "p3-test-root", "0a1b2c3d", 18123)
    assert not (p3.REPO / "infra" / "p3-test-root").exists()
    assert not p3.is_inside(p3.default_root(), p3.REPO)
    p3.prepare_config(tmp_path, "0a1b2c3d", 18123)
    with pytest.raises(FileExistsError):
        p3.prepare_config(tmp_path, "0a1b2c3d", 18123)


def test_run_specific_images_cover_every_built_service_and_match_the_build_commands(state):
    import yaml
    override = yaml.safe_load((Path(state["work"]) / "images.yaml").read_text(encoding="utf-8"))
    assert set(override["services"]) == set(p3.SERVICES) == {"migrate", "seed", "inference", "backend", "web", "ingestion"}
    built = {cmd[cmd.index("-t") + 1] for cmd in p3.build_commands(state)}
    assert built == {svc["image"] for svc in override["services"].values()}
    assert all(t.startswith("cbdc-p3s-") and t.endswith(":" + state["suffix"]) for t in built)
    assert not any(t.endswith(":local") for t in built), "never overwrite the :local images of the default stack"


def test_builds_use_the_observations_flag_and_the_commit_and_never_the_local_tags(state):
    cmds = {c[c.index("-t") + 1].split(":")[0]: c for c in p3.build_commands(state)}
    assert "VITE_OBSERVATIONS=on" in cmds["cbdc-p3s-web"]
    assert "CBDC_GIT_COMMIT=abc123" in cmds["cbdc-p3s-inference"] and cmds["cbdc-p3s-inference"][-1] == "."
    assert cmds["cbdc-p3s-migrate"][cmds["cbdc-p3s-migrate"].index("--target") + 1] == "migrate"
    assert cmds["cbdc-p3s-seed"][cmds["cbdc-p3s-seed"].index("--target") + 1] == "build"
    for c in cmds.values():
        assert c[:2] == ["docker", "build"] and "--push" not in c and "--no-cache" not in c


# --- compose invocation -----------------------------------------------------------------------------------

def test_compose_is_scoped_to_the_project_the_overlay_and_the_run_images(state):
    args = p3.compose_args(state)
    assert args[:4] == ["docker", "compose", "-p", state["project"]]
    files = [args[i + 1] for i, a in enumerate(args) if a == "-f"]
    assert files == [str(p3.COMPOSE), str(p3.OVERLAY), str(Path(state["work"]) / "images.yaml")]
    profiles = [args[i + 1] for i, a in enumerate(args) if a == "--profile"]
    assert profiles == ["full", "observations"]
    seeded = p3.compose_args(state, "seed")
    assert [seeded[i + 1] for i, a in enumerate(seeded) if a == "--profile"] == ["full", "observations", "seed"]


def test_compose_env_points_at_the_disposable_config_and_ignores_ambient_compose_settings(state, monkeypatch):
    for k in ("COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES"):
        monkeypatch.setenv(k, "ambient")
    env = p3.compose_env(state)
    assert not any(k in env for k in ("COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES"))
    work = Path(state["work"])
    assert env["CBDC_ENV_DIR"] == str(work / "env") and env["CBDC_DEV_TOKENS_FILE"] == str(work / "dev-tokens.json")
    assert env["WEB_HOST_PORT"] == "18123" and env["CBDC_GIT_COMMIT"] == "abc123"


# --- health waiting ---------------------------------------------------------------------------------------

def _states(monkeypatch, sequence):
    calls = iter(sequence)
    current = {}

    def fake(_state, service):
        if service == "postgres":  # one round of the loop starts at postgres: advance the scripted state
            current.clear()
            current.update(next(calls))
        return current[service]

    monkeypatch.setattr(p3, "container_state", fake)


READY = {"postgres": "running|healthy|0", "inference": "running|healthy|0", "backend": "running|healthy|0",
         "web": "running|healthy|0", "ingestion": "running|healthy|0", "migrate": "exited||0"}


def test_wait_healthy_returns_only_when_every_service_is_healthy_and_migrate_finished(state, monkeypatch):
    starting = {**READY, "backend": "running|starting|0"}
    migrating = {**READY, "migrate": "running||0"}
    _states(monkeypatch, [starting, migrating, READY])
    slept = []
    p3.wait_healthy(state, timeout_s=100, poll_s=1, clock=lambda: 0, sleep=slept.append)
    assert len(slept) == 2


def test_wait_healthy_times_out_naming_the_unhealthy_services_without_secrets(state, monkeypatch):
    _states(monkeypatch, [{**READY, "web": "running|unhealthy|0"}] * 10)
    ticks = iter(range(0, 1000, 10))
    with pytest.raises(RuntimeError) as err:
        p3.wait_healthy(state, timeout_s=25, poll_s=0, clock=lambda: next(ticks), sleep=lambda _s: None)
    assert "web=running|unhealthy|0" in str(err.value) and state["project"] not in str(err.value)


# --- scoped cleanup ---------------------------------------------------------------------------------------

class Recorder:
    def __init__(self, ids="c1 c2", nets="n1", volume=True):
        self.calls, self.ids, self.nets, self.volume = [], ids, nets, volume

    def __call__(self, cmd, env=None, check=True, capture=False, timeout=None):
        self.calls.append(list(cmd))
        out = ""
        if cmd[:3] == ["docker", "ps", "-aq"]:
            out = self.ids
        if cmd[:3] == ["docker", "network", "ls"]:
            out = self.nets
        rc = 0 if not (cmd[:3] == ["docker", "volume", "inspect"] and not self.volume) else 1
        return SimpleNamespace(stdout=out, returncode=rc)


def test_cleanup_removes_only_this_projects_resources(state, root, monkeypatch, capsys):
    rec = Recorder()
    monkeypatch.setattr(p3, "run", rec)
    p = state["project"]
    p3.cleanup(state, root)
    flat = [" ".join(c) for c in rec.calls]
    assert not any(w in line for line in flat for w in ("prune", "system", " -a ", "--all")), flat
    assert flat[0].startswith(f"docker compose -p {p} ") and flat[0].endswith("down --volumes --remove-orphans")
    label = f"label=com.docker.compose.project={p}"
    assert ["docker", "ps", "-aq", "--filter", label] in rec.calls and ["docker", "network", "ls", "-q", "--filter", label] in rec.calls
    assert ["docker", "rm", "-f", "c1", "c2"] in rec.calls and ["docker", "network", "rm", "n1"] in rec.calls
    assert ["docker", "volume", "rm", f"{p}_pgdata"] in rec.calls
    images = [c for c in rec.calls if c[:3] == ["docker", "image", "rm"]]
    assert {c[3] for c in images} == {p3.image_tag(s, state["suffix"]) for s in p3.SERVICES}
    for c in rec.calls:  # every rm names ids or tags obtained from this project, never a pattern or a bare name
        if c[:2] in (["docker", "rm"], ["docker", "network"]) and "rm" in c[:3]:
            assert all(a in ("docker", "rm", "-f", "network", "c1", "c2", "n1") for a in c), c
    assert not Path(state["work"]).exists(), "the disposable configuration is deleted"
    assert f"removed project {p}" in capsys.readouterr().out


def test_cleanup_with_nothing_left_runs_no_blind_removal(state, root, monkeypatch):
    rec = Recorder(ids="", nets="", volume=False)
    monkeypatch.setattr(p3, "run", rec)
    p3.cleanup(state, root)
    assert not any(c[:2] == ["docker", "rm"] or c[:3] == ["docker", "network", "rm"] or c[:3] == ["docker", "volume", "rm"] for c in rec.calls)


def test_cleanup_refuses_a_foreign_project_and_never_deletes_outside_its_root(state, root, monkeypatch, tmp_path):
    rec = Recorder()
    monkeypatch.setattr(p3, "run", rec)
    with pytest.raises(p3.HarnessError):
        p3.cleanup({**state, "project": "cbdc-router"}, root)
    assert rec.calls == []
    elsewhere = tmp_path / "elsewhere" / state["project"]
    elsewhere.mkdir(parents=True)
    p3.cleanup({**state, "work": str(elsewhere)}, root)
    assert elsewhere.exists(), "a work directory outside --root is left alone"


# --- docker-resolved configuration ------------------------------------------------------------------------

def _docker_or_skip():
    if shutil.which("docker") is None:
        if os.environ.get("CBDC_REQUIRE_DOCKER") == "1":
            pytest.fail("the docker CLI is required (CBDC_REQUIRE_DOCKER=1)")
        pytest.skip("docker CLI not available")


def test_the_merged_project_publishes_only_the_web_port_on_loopback_and_uses_run_images(state):
    _docker_or_skip()
    out = subprocess.run(p3.compose_args(state, "seed") + ["config", "--format", "json"], cwd=p3.REPO, env=p3.compose_env(state),
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr[-500:]
    cfg = json.loads(out.stdout)
    assert cfg["name"] == state["project"]
    services = cfg["services"]
    assert set(services) == {"postgres", "migrate", "seed", "inference", "backend", "web", "ingestion"}
    published = {n: s["ports"] for n, s in services.items() if s.get("ports")}
    assert list(published) == ["web"]
    (port,) = published["web"]
    assert port["host_ip"] == p3.LOOPBACK and str(port["published"]) == str(state["port"]) and port["target"] == 80
    for name in p3.SERVICES:
        assert services[name]["image"] == p3.image_tag(name, state["suffix"]), name
    assert services["postgres"]["image"].startswith("postgres:"), "postgres stays the pinned pulled image"
    assert services["backend"]["environment"]["OBSERVATIONS_URL"] == "http://ingestion:8300"
    work = Path(state["work"])
    mounts = [v["source"] for n in ("backend", "seed") for v in services[n]["volumes"] if v["target"] == "/app/dev-tokens.json"]
    assert mounts and all(Path(m) == work / "dev-tokens.json" for m in mounts)
    assert cfg["volumes"]["pgdata"]["name"] == f"{state['project']}_pgdata"


# --- --fault: the test-only fake ingestion (Stage 2) --------------------------------------------------------------

def test_fault_runs_add_the_test_override_between_the_overlay_and_the_images(tmp_path):
    plain = p3.prepare_config(tmp_path / "a", "0a1b2c3d", 18123)
    faulty = p3.prepare_config(tmp_path / "b", "0a1b2c3d", 18123, fault=True)
    assert plain["fault"] is False and faulty["fault"] is True
    plain_files = [a for i, a in enumerate(p3.compose_args(plain)) if i and p3.compose_args(plain)[i - 1] == "-f"]
    fault_files = [a for i, a in enumerate(p3.compose_args(faulty)) if i and p3.compose_args(faulty)[i - 1] == "-f"]
    assert len(plain_files) == 3 and str(p3.FAULT_OVERLAY) not in plain_files, "a normal run never sees the fake"
    assert fault_files[:3] == plain_files[:2] + [str(p3.FAULT_OVERLAY)] and fault_files[3].endswith("images.yaml")


def test_fault_steering_needs_a_fault_stack_and_goes_through_compose_exec_only(tmp_path, monkeypatch):
    plain = p3.prepare_config(tmp_path / "a", "0a1b2c3d", 18123)
    with pytest.raises(p3.HarnessError, match="--fault"):
        p3.set_fault(plain, "normal")
    faulty = p3.prepare_config(tmp_path / "b", "11223344", 18124, fault=True)
    calls = []

    def fake_run(cmd, env=None, check=True, capture=False, timeout=None):
        calls.append(list(cmd))
        return SimpleNamespace(stdout='{"scenario":"http:503"}\n', returncode=0)

    monkeypatch.setattr(p3, "run", fake_run)
    assert p3.set_fault(faulty, "http:503") == '{"scenario":"http:503"}'
    (cmd,) = calls
    assert cmd[:4] == ["docker", "compose", "-p", faulty["project"]]
    assert cmd[-7:] == ["exec", "-T", "ingestion", "python", "/fault/ctl.py", "set", "http:503"]
    assert not any(a in cmd for a in ("-p8301", "8301", "--publish", "run"))
    monkeypatch.setattr(p3, "run", lambda *a, **k: SimpleNamespace(stdout="refused", returncode=1))
    with pytest.raises(RuntimeError, match="refused scenario"):
        p3.set_fault(faulty, "bogus")


def test_main_fault_refuses_foreign_projects(root, capsys):
    assert p3.main(["fault", "--project", "cbdc-router", "--scenario", "normal", "--root", str(root)]) == 2


# --- --no-observations: the plain Phase 2 stack, the "observations absent" baseline of AD-6 T-1 -----------------------

def test_a_plain_stack_has_no_overlay_no_fault_override_no_observations_profile_and_no_ingestion_image(tmp_path):
    plain = p3.prepare_config(tmp_path / "a", "0a1b2c3d", 18123, observations=False)
    args = p3.compose_args(plain)
    files = [args[i + 1] for i, a in enumerate(args) if a == "-f"]
    assert files == [str(p3.COMPOSE), str(Path(plain["work"]) / "images.yaml")]
    assert [args[i + 1] for i, a in enumerate(args) if a == "--profile"] == ["full"]
    import yaml
    override = yaml.safe_load((Path(plain["work"]) / "images.yaml").read_text(encoding="utf-8"))
    assert set(override["services"]) == {"migrate", "seed", "inference", "backend", "web"}, "no ingestion service exists to point at"
    built = {cmd[cmd.index("-t") + 1].split(":")[0] for cmd in p3.build_commands(plain)}
    assert built == {f"cbdc-p3s-{s}" for s in ("backend", "migrate", "seed", "web", "inference")}
    with_overlay = p3.prepare_config(tmp_path / "b", "11223344", 18124)
    assert "cbdc-p3s-ingestion" in {c[c.index("-t") + 1].split(":")[0] for c in p3.build_commands(with_overlay)}


def test_the_plain_stack_resolves_without_observations_and_publishes_only_web(tmp_path):
    if shutil.which("docker") is None:
        pytest.skip("docker CLI not available")
    plain = p3.prepare_config(tmp_path / "a", "0a1b2c3d", 18123, observations=False)
    out = subprocess.run(p3.compose_args(plain) + ["config", "--format", "json"], cwd=p3.REPO, env=p3.compose_env(plain),
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr[-500:]
    services = json.loads(out.stdout)["services"]
    assert set(services) == {"postgres", "migrate", "inference", "backend", "web"}
    assert "OBSERVATIONS_URL" not in services["backend"]["environment"], "observations must be absent, not merely idle"
    assert [n for n, s in services.items() if s.get("ports")] == ["web"]
