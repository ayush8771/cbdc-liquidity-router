"""infra/compose.observations.yaml invariants (AD-1 v0.5 section 3.6, P-6; scope v1.4 D-24, D-25).

Two layers, neither starts a container:
  * static: the overlay and the ingestion Dockerfile are parsed as text and YAML;
  * merged: `docker compose config --format json` resolves the base file alone and the base plus the overlay with
    disposable env files. Without the docker CLI these are skipped, unless CBDC_REQUIRE_DOCKER=1 (set by the
    phase3-observations workflow), which turns a missing CLI into a failure.
The default stack must stay exactly as it is: the base file is never edited, and resolves with no ingestion service,
no extra network and no observation setting.
"""
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parents[3]
BASE = REPO / "infra" / "compose.yaml"
OVERLAY = REPO / "infra" / "compose.observations.yaml"
DOCKERFILE = REPO / "services" / "ingestion" / "Dockerfile"
FULL = {"postgres", "migrate", "inference", "backend", "web"}  # what `--profile full` starts
PORT = "8300"  # Dev A's CBDC_INGESTION_PORT default (services/ingestion/cbdc_ingestion/settings.py)


@pytest.fixture(scope="module")
def overlay():
    return yaml.safe_load(OVERLAY.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def base():
    return yaml.safe_load(BASE.read_text(encoding="utf-8"))


# --- static: the overlay file --------------------------------------------------------------------------

def test_overlay_adds_only_ingestion_and_changes_only_backend_and_web(overlay):
    assert set(overlay["services"]) == {"ingestion", "backend", "web"}
    assert set(overlay) == {"services", "networks"}, "no top-level volumes, secrets or configs"


def test_overlay_never_publishes_a_port_or_adds_secrets_files_or_privileges(overlay):
    forbidden = ("ports", "env_file", "volumes", "secrets", "configs", "depends_on", "network_mode", "privileged", "devices", "extra_hosts")
    for name, svc in overlay["services"].items():
        for key in forbidden:
            assert key not in svc, f"{name}: the overlay must not set {key}"
    assert not re.search(r"(?i)(password|token|secret|BEGIN [A-Z ]*PRIVATE KEY)", "\n".join(l for l in OVERLAY.read_text(encoding="utf-8").splitlines() if not l.lstrip().startswith("#")))


def test_observations_network_is_internal_and_default_is_not_redefined(overlay):
    obs = overlay["networks"]["observations"]
    assert set(overlay["networks"]) == {"observations"} and obs["internal"] is True
    # The T-5 probe showed that `internal: true` alone leaves the bridge gateway reachable from inside the network.
    assert obs["driver_opts"] == {"com.docker.network.bridge.gateway_mode_ipv4": "isolated"}
    assert obs["enable_ipv6"] is False, "IPv6 is a decision, not a default: isolation is verified for IPv4 only"


def test_ingestion_is_on_observations_only_with_the_p6_controls(overlay):
    s = overlay["services"]["ingestion"]
    assert s["networks"] == ["observations"]
    assert s["profiles"] == ["observations"]
    assert s["read_only"] is True
    assert s["cap_drop"] == ["ALL"]
    assert "no-new-privileges:true" in s["security_opt"]
    assert str(s["user"]).split(":")[0] not in ("0", "root")
    assert s["pids_limit"] and s["mem_limit"], "process and memory limits are required"
    assert s["expose"] == [PORT]
    assert s["environment"]["CBDC_INGESTION_PORT"] == PORT
    # Dev A's default bind is 127.0.0.1, which no other container can reach: the backend polls over the network.
    assert s["environment"]["CBDC_INGESTION_HOST"] == "0.0.0.0"


def test_backend_lists_both_networks_because_naming_one_removes_the_default(overlay):
    assert sorted(overlay["services"]["backend"]["networks"]) == ["default", "observations"]


def test_overlay_images_have_their_own_tags(overlay, base):
    base_images = {n: s.get("image") for n, s in base["services"].items()}
    for name in ("backend", "web"):
        new = overlay["services"][name]["image"]
        assert new != base_images[name] and new.endswith(":local") and "observations" in new
    assert overlay["services"]["ingestion"]["image"] == "cbdc-ingestion:local"


def test_feature_flags_are_set_only_in_the_overlay(overlay, base):
    # An origin only (Dev B): Express appends /v1/latest. No path, query, fragment, credentials or trailing slash.
    assert overlay["services"]["backend"]["environment"]["OBSERVATIONS_URL"] == f"http://ingestion:{PORT}"
    assert overlay["services"]["web"]["build"]["args"] == {"VITE_OBSERVATIONS": "on"}
    assert "OBSERVATIONS" not in BASE.read_text(encoding="utf-8")


def test_the_base_file_defines_no_networks_and_no_ingestion(base):
    assert "networks" not in base and "ingestion" not in base["services"]
    assert all("networks" not in s for s in base["services"].values())


# --- static: the ingestion image -----------------------------------------------------------------------

def test_ingestion_dockerfile_is_pinned_non_root_and_copies_only_the_package():
    text = DOCKERFILE.read_text(encoding="utf-8")
    lines = [l.strip() for l in text.splitlines() if l.strip() and not l.strip().startswith("#")]
    assert re.match(r"FROM python:3\.10\.11-\S+@sha256:[0-9a-f]{64}$", lines[0])
    assert "USER cbdc" in lines and "useradd --system --uid 10001" in text
    assert [l for l in lines if l.startswith("COPY")] == ["COPY cbdc_ingestion/ /app/cbdc_ingestion/"]
    assert f"EXPOSE {PORT}" in lines and f"CBDC_INGESTION_PORT={PORT}" in text
    assert "CBDC_INGESTION_HOST=0.0.0.0" in text, "the image must listen on all interfaces of its internal network"
    assert any(l.startswith("HEALTHCHECK") for l in lines) or "HEALTHCHECK" in text
    assert "/healthz" in text and not re.search(r"(?i)\b(pip install|curl|wget|apt-get)\b", "\n".join(lines))
    assert (REPO / "services" / "ingestion" / ".dockerignore").read_text(encoding="utf-8").splitlines()[1] == "*"


# --- merged: docker compose config ---------------------------------------------------------------------

def _docker_ready():
    if shutil.which("docker") is None:
        return False
    return subprocess.run(["docker", "compose", "version"], capture_output=True).returncode == 0


@pytest.fixture(scope="module")
def resolver(tmp_path_factory):
    if not _docker_ready():
        if os.environ.get("CBDC_REQUIRE_DOCKER") == "1":
            pytest.fail("docker compose is required (CBDC_REQUIRE_DOCKER=1) but is not available")
        pytest.skip("docker compose is not available")
    d = tmp_path_factory.mktemp("compose-env")
    for n in ("postgres", "backend", "inference"):
        text = (REPO / "infra" / "env" / f"{n}.env.example").read_text(encoding="utf-8")
        (d / f"{n}.env").write_text(text.replace("CHANGE_ME_LOCAL_ONLY", "disposable-test-password"), encoding="utf-8")
    (d / "dev-tokens.json").write_text('{"users": []}', encoding="utf-8")
    env = dict(os.environ, CBDC_ENV_DIR=str(d), CBDC_DEV_TOKENS_FILE=str(d / "dev-tokens.json"))
    cache = {}

    def resolve(*files, profiles=("full",)):
        key = (files, profiles)
        if key not in cache:
            cmd = ["docker", "compose"]
            for f in files:
                cmd += ["-f", str(f)]
            for p in profiles:
                cmd += ["--profile", p]
            r = subprocess.run(cmd + ["config", "--format", "json"], capture_output=True, text=True, env=env)
            assert r.returncode == 0, r.stderr
            cache[key] = json.loads(r.stdout)
        return cache[key]

    return resolve


@pytest.fixture(scope="module")
def default_cfg(resolver):
    return resolver(BASE)


@pytest.fixture(scope="module")
def merged(resolver):
    return resolver(BASE, OVERLAY, profiles=("full", "observations"))


def test_default_stack_is_unchanged_by_the_overlay_existing(default_cfg):
    assert set(default_cfg["services"]) == FULL
    assert set(default_cfg["networks"]) == {"default"}
    for name, svc in default_cfg["services"].items():
        assert list(svc.get("networks", {"default": None})) == ["default"], name
        assert "OBSERVATIONS_URL" not in (svc.get("environment") or {}), name
        assert "VITE_OBSERVATIONS" not in ((svc.get("build") or {}).get("args") or {}), name
    assert default_cfg["services"]["backend"]["image"] == "cbdc-backend:local"
    assert default_cfg["services"]["web"]["image"] == "cbdc-web:local"


def test_overlay_without_its_profile_starts_no_ingestion(resolver):
    cfg = resolver(BASE, OVERLAY, profiles=("full",))
    assert set(cfg["services"]) == FULL


def test_merged_services_and_profiles(merged):
    assert set(merged["services"]) == FULL | {"ingestion"}


def test_merged_networks_isolate_ingestion(merged):
    assert merged["networks"]["observations"]["internal"] is True
    assert merged["networks"]["observations"]["driver_opts"]["com.docker.network.bridge.gateway_mode_ipv4"] == "isolated"
    assert merged["networks"]["observations"]["enable_ipv6"] is False
    assert "driver_opts" not in merged["networks"]["default"], "the Phase 2 network is untouched"
    assert not merged["networks"]["default"].get("enable_ipv6")
    assert merged["networks"]["default"].get("internal") is not True
    nets = {n: sorted(s.get("networks") or {}) for n, s in merged["services"].items()}
    assert nets["ingestion"] == ["observations"]
    assert nets["backend"] == ["default", "observations"]
    for name in FULL - {"backend"}:
        assert nets[name] == ["default"], name
    on_observations = {n for n, v in nets.items() if "observations" in v}
    assert on_observations == {"backend", "ingestion"}, "no other service may join the observations network"


def test_merged_publishes_only_web_on_loopback(merged):
    ports = {n: s["ports"] for n, s in merged["services"].items() if s.get("ports")}
    assert set(ports) == {"web"}
    assert all(p["host_ip"] == "127.0.0.1" and p["target"] == 80 for p in ports["web"])


def test_merged_ingestion_is_isolated(merged):
    s = merged["services"]["ingestion"]
    assert not s.get("ports") and not s.get("volumes") and not s.get("env_file") and not s.get("secrets")
    assert not s.get("depends_on") and not s.get("privileged") and s.get("network_mode") in (None, "")
    assert s["read_only"] is True and s["cap_drop"] == ["ALL"] and "no-new-privileges:true" in s["security_opt"]
    assert s["user"] == "10001:10001" and s["pids_limit"] > 0 and int(s["mem_limit"]) > 0
    assert s["image"] == "cbdc-ingestion:local" and s["profiles"] == ["observations"]
    assert s["environment"]["CBDC_INGESTION_HOST"] == "0.0.0.0" and s["environment"]["CBDC_INGESTION_PORT"] == PORT


def test_merged_backend_and_web_keep_their_phase2_settings(merged, default_cfg):
    for name in ("backend", "web"):
        a, b = default_cfg["services"][name], merged["services"][name]
        for key in ("profiles", "depends_on", "ports", "volumes", "env_file", "expose", "user", "read_only", "cap_drop"):
            assert a.get(key) == b.get(key), f"{name}.{key} changed"
    be = merged["services"]["backend"]["environment"]
    assert be["OBSERVATIONS_URL"] == f"http://ingestion:{PORT}"
    assert {k: v for k, v in be.items() if k != "OBSERVATIONS_URL"} == default_cfg["services"]["backend"]["environment"]
    assert merged["services"]["web"]["build"]["args"] == {"VITE_OBSERVATIONS": "on"}
    assert "ingestion" not in (merged["services"]["backend"].get("depends_on") or {})


def test_merged_untouched_services_are_identical_to_the_default(merged, default_cfg):
    for name in ("postgres", "migrate", "inference"):
        assert merged["services"][name] == default_cfg["services"][name], name


def test_merged_images_do_not_reuse_the_default_tags(merged, default_cfg):
    new = {merged["services"][n]["image"] for n in ("backend", "web", "ingestion")}
    old = {s["image"] for s in default_cfg["services"].values()}
    assert not new & old


def test_observations_url_is_a_bare_origin_naming_the_ingestion_service_and_port(overlay):
    from urllib.parse import urlsplit
    url = overlay["services"]["backend"]["environment"]["OBSERVATIONS_URL"]
    parts = urlsplit(url)
    assert (parts.scheme, parts.hostname, parts.port) == ("http", "ingestion", int(PORT))
    assert parts.path == "" and not parts.query and not parts.fragment and parts.username is None and parts.password is None
    assert url == f"{parts.scheme}://{parts.hostname}:{parts.port}", "no trailing slash"
    assert parts.hostname in overlay["services"], "the host is a service of this overlay, resolvable on the observations network"


def test_the_docker_engine_requirement_is_documented_where_a_reader_will_look():
    for path in (OVERLAY, REPO / "infra" / "README.md", REPO / ".github" / "workflows" / "phase3-observations.yml"):
        assert "28.0.0" in path.read_text(encoding="utf-8"), path.name
    readme = (REPO / "infra" / "README.md").read_text(encoding="utf-8")
    assert "Phase 3 observations overlay" in readme and "IPv6 is disabled" in readme and "AD-6 B-4 stays open" in readme
