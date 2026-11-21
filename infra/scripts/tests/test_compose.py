"""infra/compose.yaml security and ordering invariants (arch §4, §7, §8).

Static: the source file is parsed with PyYAML. No Docker, no env files and no network are needed.
Each test takes the parsed document as `compose`, so a test can also be run on a modified copy.
"""
import re
from pathlib import Path

import pytest
import yaml

COMPOSE = Path(__file__).resolve().parents[3] / "infra" / "compose.yaml"
FULL = {"postgres", "migrate", "inference", "backend", "web"}  # the services that `--profile full` starts


@pytest.fixture
def compose():
    return yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))


def services(c):
    return c["services"]


def deps(svc):
    """depends_on as {service: condition}. The short list form has no condition."""
    d = svc.get("depends_on") or {}
    if isinstance(d, list):
        return {name: None for name in d}
    return {name: (v or {}).get("condition") for name, v in d.items()}


_PORT = re.compile(
    r"^(?:(?P<ip>\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]):)?"
    r"(?:(?P<host>\$\{[^}]*\}|\d+(?:-\d+)?):)?"
    r"(?P<container>\d+)(?:/\w+)?$"
)


def published(svc):
    """[(host_ip, container_port)] for every published port, in short or long syntax."""
    out = []
    for p in svc.get("ports") or []:
        if isinstance(p, dict):
            out.append((p.get("host_ip"), str(p.get("target"))))
            continue
        m = _PORT.match(str(p))
        assert m, f"unrecognised ports syntax: {p!r}"
        out.append((m["ip"], m["container"]))
    return out


def env(svc):
    e = svc.get("environment") or {}
    if isinstance(e, list):
        e = dict(item.split("=", 1) if "=" in item else (item, None) for item in e)
    return e


def token_mounts(c):
    """[(service, volume)] for every mount whose target is the dev-tokens file."""
    found = []
    for name, svc in services(c).items():
        for v in svc.get("volumes") or []:
            parts = str(v).split(":")
            target = v.get("target", "") if isinstance(v, dict) else (parts[1] if len(parts) > 1 else "")
            if target.endswith("dev-tokens.json"):
                found.append((name, v))
    return found


# --- exposure ---------------------------------------------------------------------------------

def test_only_web_publishes_a_host_port(compose):
    for name, svc in services(compose).items():
        if name == "web":
            assert svc.get("ports"), "web must be reachable"
        else:
            assert not svc.get("ports"), f"{name} must not publish a host port"


def test_web_is_loopback_only_and_maps_to_container_port_80(compose):
    ports = published(services(compose)["web"])
    assert ports, "web publishes no port"
    for ip, container in ports:
        assert ip == "127.0.0.1", f"web must bind 127.0.0.1, found {ip!r}"
        assert container == "80"


def test_backend_inference_and_postgres_stay_private(compose):
    for name in ("backend", "inference", "postgres"):
        assert published(services(compose)[name]) == []


def test_no_service_weakens_network_or_host_isolation(compose):
    for name, svc in services(compose).items():
        assert svc.get("network_mode") != "host", name
        assert not svc.get("privileged"), name
        for v in svc.get("volumes") or []:
            assert "docker.sock" not in str(v), name


# --- profiles ---------------------------------------------------------------------------------

def test_every_service_needs_an_explicit_profile(compose):
    for name, svc in services(compose).items():
        assert svc.get("profiles"), f"{name} would start without any --profile"


def test_full_profile_is_the_normal_stack_and_excludes_seed(compose):
    in_full = {n for n, s in services(compose).items() if "full" in (s.get("profiles") or [])}
    assert in_full == FULL
    seed = services(compose)["seed"]
    assert seed["profiles"] == ["seed"]


def test_no_normal_service_depends_on_seed(compose):
    for name, svc in services(compose).items():
        if name != "seed":
            assert "seed" not in deps(svc), name


# --- token file -------------------------------------------------------------------------------

def test_token_mounts_are_read_only(compose):
    mounts = token_mounts(compose)
    assert {n for n, _ in mounts} >= {"backend", "seed"}
    for name, v in mounts:
        ro = v.get("read_only") is True if isinstance(v, dict) else str(v).endswith(":ro")
        assert ro, f"{name}: the token file must be mounted read-only"


def test_a_missing_token_file_cannot_become_a_directory(compose):
    for name, v in token_mounts(compose):
        assert isinstance(v, dict), f"{name}: use the long syntax to set create_host_path"
        assert v.get("type") == "bind"
        assert (v.get("bind") or {}).get("create_host_path") is False, name


def test_env_files_come_from_the_external_directory(compose):
    for name, svc in services(compose).items():
        files = svc.get("env_file") or []
        files = [files] if isinstance(files, (str, dict)) else files
        for f in files:
            path = f["path"] if isinstance(f, dict) else f
            assert "${CBDC_ENV_DIR" in path, f"{name}: env_file must use CBDC_ENV_DIR, found {path!r}"


# --- images and startup order -----------------------------------------------------------------

def test_postgres_image_is_digest_pinned(compose):
    assert re.search(r"@sha256:[0-9a-f]{64}$", services(compose)["postgres"]["image"])


def test_migrate_waits_for_postgres_to_be_healthy(compose):
    assert deps(services(compose)["migrate"]).get("postgres") == "service_healthy"


def test_backend_waits_for_migration_and_a_healthy_inference(compose):
    d = deps(services(compose)["backend"])
    assert d.get("migrate") == "service_completed_successfully"
    assert d.get("inference") == "service_healthy"


def test_web_waits_for_a_healthy_backend(compose):
    assert deps(services(compose)["web"]).get("backend") == "service_healthy"


def test_seed_waits_for_migration(compose):
    assert deps(services(compose)["seed"]).get("migrate") == "service_completed_successfully"


# --- credentials ------------------------------------------------------------------------------

_SENSITIVE = re.compile(r"PASSWORD|PASSWD|SECRET|TOKEN|DATABASE_URL|API_KEY|PRIVATE", re.I)


def _literal_values(svc):
    yield from env(svc).items()
    yield from ((svc.get("build") or {}).get("args") or {}).items()


def test_no_credential_variable_has_a_literal_value(compose):
    for name, svc in services(compose).items():
        for key, value in _literal_values(svc):
            if _SENSITIVE.search(key) and not re.search(r"_(FILE|PATH)$", key) and value not in (None, ""):
                assert str(value).startswith("${"), f"{name}: {key} must come from the environment"


def test_compose_file_embeds_no_credentials_or_tokens():
    lines = COMPOSE.read_text(encoding="utf-8").splitlines()
    text = "\n".join(line for line in lines if not line.lstrip().startswith("#"))
    text = re.sub(r"@sha256:[0-9a-f]{64}", "", text)  # a pinned image digest is not a secret
    assert not re.search(r"[0-9a-fA-F]{32,}", text), "a long hex string (token, hash or key)"
    assert not re.search(r"\b[a-z][a-z0-9+.-]*://[^\s/@:]+:[^\s/@]+@", text), "a URL with credentials"
    assert not re.search(r"(?i)\bbearer\s+\S+", text)
    assert "CHANGE_ME" not in text
