#!/usr/bin/env python3
"""Runtime security checks for a running Phase 2 Compose project (arch §8, M6). Standard library only.

Looks at the containers of one Compose project, found by the exact label
`com.docker.compose.project=<project>`, with the docker CLI:

  * only `web` has a host port binding, and it is on 127.0.0.1 and maps container port 80;
  * backend, inference, postgres and migrate publish nothing;
  * the development token file is mounted read-only (and a write inside the container fails);
  * no container is restarting in a loop;
  * the generated tokens and database password appear in no container log and in no extra file given
    with --scan (the smoke test's output);
  * the web port is not reachable on the machine's other address, and 4000 and 8000 are closed on loopback.

  python3 e2e/stack-security.py --project NAME --web-port 18080 --tokens-file F --env-file postgres.env [--scan FILE]

Secrets are read from files, are never printed, and a failure message never contains a value.
Exit code 0 only if every check passes.
"""
from __future__ import annotations

import argparse
import json
import re
import socket
import subprocess
import sys
from pathlib import Path

SERVICES = {"postgres", "migrate", "inference", "backend", "web"}
TOKEN_TARGET = "/app/dev-tokens.json"


# --- reading the project ------------------------------------------------------------------------

def docker(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", *args], capture_output=True, text=True)


def project_containers(project: str) -> dict[str, dict]:
    """{service: docker-inspect dict} for the project's containers."""
    ids = docker("ps", "-a", "-q", "--filter", f"label=com.docker.compose.project={project}").stdout.split()
    if not ids:
        return {}
    inspected = json.loads(docker("inspect", *ids).stdout)
    return {c["Config"]["Labels"]["com.docker.compose.service"]: c for c in inspected}


# --- checks (pure: they take inspect data and raise AssertionError) -----------------------------

def check_services_present(by_service: dict) -> None:
    missing = SERVICES - set(by_service)
    assert not missing, f"containers missing from the project: {sorted(missing)}"


def check_published_ports(by_service: dict, web_port: int) -> None:
    for name, c in by_service.items():
        bindings = (c["HostConfig"].get("PortBindings") or {})
        live = {p: b for p, b in (c["NetworkSettings"].get("Ports") or {}).items() if b}
        if name != "web":
            assert not bindings and not live, f"{name} must not publish a host port (found {sorted(set(bindings) | set(live))})"
            continue
        assert set(bindings) == {"80/tcp"}, f"web must publish only 80/tcp, found {sorted(bindings)}"
        entries = bindings["80/tcp"]
        assert len(entries) == 1, f"web must have one binding for 80/tcp, found {len(entries)}"
        assert entries[0].get("HostIp") == "127.0.0.1", f"web must bind 127.0.0.1, found {entries[0].get('HostIp')!r}"
        assert str(entries[0].get("HostPort")) == str(web_port), f"web host port is {entries[0].get('HostPort')!r}, expected {web_port}"


def check_token_mounts(by_service: dict) -> None:
    holders = []
    for name, c in by_service.items():
        for m in c.get("Mounts") or []:
            if m.get("Destination", "").endswith("dev-tokens.json"):
                holders.append(name)
                assert m.get("Destination") == TOKEN_TARGET, f"{name}: token file mounted at {m.get('Destination')!r}"
                assert m.get("RW") is False, f"{name}: the token file must be mounted read-only"
    assert holders == ["backend"], f"only the backend may hold the token file, found {holders}"


def check_no_restart_loops(by_service: dict) -> None:
    for name, c in by_service.items():
        assert c.get("RestartCount", 0) == 0, f"{name} restarted {c.get('RestartCount')} time(s)"


def check_no_secrets(label: str, text: str, needles: list[str]) -> None:
    found = sum(1 for n in needles if n and n in text)
    assert found == 0, f"{found} generated secret value(s) appear in {label}"


# --- checks that need the live stack ------------------------------------------------------------

def check_token_file_not_writable(container_id: str) -> None:
    r = docker("exec", container_id, "sh", "-c", f"echo x >> {TOKEN_TARGET}")
    assert r.returncode != 0, "a write to the mounted token file succeeded"


def refused(host: str, port: int) -> bool:
    s = socket.socket()
    s.settimeout(3)
    try:
        s.connect((host, port))
        return False
    except OSError:
        return True
    finally:
        s.close()


def primary_address() -> str | None:
    """The address this machine uses for outbound traffic. A UDP connect sends no packet."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 9))  # TEST-NET-1: never routed
        ip = s.getsockname()[0]
        return None if ip.startswith("127.") else ip
    except OSError:
        return None
    finally:
        s.close()


# --- runner -------------------------------------------------------------------------------------

class Report:
    def __init__(self):
        self.failures = []

    def check(self, name, fn):
        try:
            note = fn() or ""
            print(f"PASS  {name}" + (f"  ({note})" if note else ""), flush=True)
        except AssertionError as e:
            self.failures.append(name)
            print(f"FAIL  {name}: {e}", flush=True)
        except Exception as e:
            self.failures.append(name)
            print(f"FAIL  {name}: {type(e).__name__}: {e}", flush=True)


def read_needles(tokens_file: str, env_file: str) -> list[str]:
    tokens = json.loads(Path(tokens_file).read_text(encoding="utf-8"))
    needles = [v["token"] for v in tokens.values()]
    m = re.search(r"^POSTGRES_PASSWORD=(\S+)", Path(env_file).read_text(encoding="utf-8"), re.M)
    if m:
        needles.append(m.group(1))
    return [n for n in needles if len(n) >= 16]  # refuse to search for a trivially short value


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--project", required=True, help="the exact Compose project name")
    ap.add_argument("--web-port", type=int, required=True)
    ap.add_argument("--tokens-file", required=True)
    ap.add_argument("--env-file", required=True, help="postgres.env, for the generated password")
    ap.add_argument("--scan", action="append", default=[], help="extra file to scan for the secrets (repeatable)")
    args = ap.parse_args(argv)

    try:
        needles = read_needles(args.tokens_file, args.env_file)
    except (OSError, ValueError, KeyError, TypeError) as e:
        print(f"cannot read the tokens or env file ({type(e).__name__})", file=sys.stderr)
        return 2
    by_service = project_containers(args.project)
    r = Report()
    r.check("all five services have a container", lambda: check_services_present(by_service))
    if r.failures:
        return 1
    r.check("only web publishes a host port, on 127.0.0.1 -> 80", lambda: check_published_ports(by_service, args.web_port))
    r.check("the token file is mounted read-only, and only in the backend", lambda: check_token_mounts(by_service))
    r.check("a write to the mounted token file fails", lambda: check_token_file_not_writable(by_service["backend"]["Id"]))
    r.check("no container restarted", lambda: check_no_restart_loops(by_service))
    for name, c in sorted(by_service.items()):
        def scan_logs(c=c, name=name):
            p = docker("logs", c["Id"])
            check_no_secrets(f"the {name} log", p.stdout + p.stderr, needles)
        r.check(f"no generated secret in the {name} log", scan_logs)
    for path in args.scan:
        r.check(f"no generated secret in {Path(path).name}", lambda path=path: check_no_secrets(Path(path).name, Path(path).read_text(encoding="utf-8", errors="replace"), needles))

    def closed_ports():
        for port in (4000, 8000):
            assert refused("127.0.0.1", port), f"127.0.0.1:{port} accepts connections"
    r.check("backend and inference ports are closed on loopback", closed_ports)

    def not_on_other_address():
        ip = primary_address()
        if ip is None:
            return "skipped: no non-loopback address found"
        assert refused(ip, args.web_port), f"web is reachable on {ip}:{args.web_port}"
        return f"{args.web_port} refused on the other address"
    r.check("web is not reachable on the machine's other address", not_on_other_address)

    print(f"\n{'all checks passed' if not r.failures else str(len(r.failures)) + ' check(s) failed'}")
    return 1 if r.failures else 0


if __name__ == "__main__":
    sys.exit(main())
