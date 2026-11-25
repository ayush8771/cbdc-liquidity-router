#!/usr/bin/env python3
"""Disposable D-24 full-stack harness (Dev D; AD-1 v0.5 section 3.6/3.7, scope v1.4 D-24). Standard library only.

Starts the Phase 2 stack plus the observations overlay as ONE uniquely named Compose project with disposable
configuration, so acceptance checks can run against real containers without touching anything that already exists.

  python infra/scripts/p3_stack.py up      [--root DIR] [--port N]   build, start, wait for health, seed (prints the project)
  python infra/scripts/p3_stack.py smoke   --project NAME [--root DIR]   e2e/api-smoke.py against the project's web port
  python infra/scripts/p3_stack.py down    --project NAME [--root DIR]   remove ONLY what that project created
  python infra/scripts/p3_stack.py run     [--root DIR] [--port N] [--keep]   up, smoke, then down (always, unless --keep)
  python infra/scripts/p3_stack.py fault   --project NAME --scenario S [--root DIR]   steer the fake ingestion (needs up --fault)

`up --fault` and `run --fault` swap the ingestion process for the test-only fake (infra/compose.observations-test.yaml); the
control interface is the container's own loopback, reached only through `docker compose exec`, so no control port is published.

What it guarantees:
  * Names. The project is cbdc-p3s-<8 hex>; images are cbdc-p3s-<service>:<8 hex>. `down` refuses any other project name,
    so it can never remove cbdc-router (the default stack) or anyone else's resources.
  * Configuration. Passwords and tokens are generated per run, written under --root (default: the system temp directory,
    never the checkout) and never printed. Env files come from infra/env/*.env.example; no secret enters the repository.
  * Network. The web service is published on 127.0.0.1 only, on a free port chosen at start-up (or --port, which must be free).
    Nothing else is published (the overlay's tests assert that).
  * Cleanup is scoped: `docker compose down -p <project>`, then containers and networks filtered by the project's Compose
    label, its one volume (<project>_pgdata), and its own image tags. Never prune, never a name pattern, never `docker system`.
Exit status: 0 on success, 1 on a failed check, 2 on unusable arguments or state.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
COMPOSE = REPO / "infra" / "compose.yaml"
OVERLAY = REPO / "infra" / "compose.observations.yaml"
FAULT_OVERLAY = REPO / "infra" / "compose.observations-test.yaml"  # TEST-ONLY: the fake ingestion (infra/testing/fault_ingestion/)
SMOKE = REPO / "e2e" / "api-smoke.py"
ENV_EXAMPLES = REPO / "infra" / "env"
PROJECT_RE = re.compile(r"^cbdc-p3s-[0-9a-f]{8}$")
SERVICES = ("migrate", "seed", "inference", "backend", "web", "ingestion")  # every service this harness builds
RUNNING = ("postgres", "inference", "backend", "web", "ingestion")  # must be running and healthy
LOOPBACK = "127.0.0.1"


class HarnessError(Exception):
    """An unusable argument or state (exit status 2)."""


def default_root() -> Path:
    return Path(tempfile.gettempdir()) / "cbdc-p3-stack"


def new_suffix() -> str:
    return secrets.token_hex(4)


def project_name(suffix: str) -> str:
    return f"cbdc-p3s-{suffix}"


def image_tag(service: str, suffix: str) -> str:
    return f"cbdc-p3s-{service}:{suffix}"


def port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((LOOPBACK, port))
        except OSError:
            return False
    return True


def pick_port(wanted: int | None = None) -> int:
    """A free loopback port. An explicit port must be free: it is never taken over."""
    if wanted is not None:
        if not 1024 <= wanted <= 65535:
            raise HarnessError(f"port {wanted} is outside 1024-65535")
        if not port_is_free(wanted):
            raise HarnessError(f"port {wanted} is already in use on {LOOPBACK}")
        return wanted
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((LOOPBACK, 0))
        return s.getsockname()[1]


def is_inside(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def prepare_config(root: Path, suffix: str, port: int, commit: str = "", fault: bool = False, load_users: int = 0, observations: bool = True) -> dict:
    """Writes the disposable configuration for one project and returns its state. Secrets are written, never returned."""
    root = Path(root)
    if is_inside(root, REPO):
        raise HarnessError(f"--root {root} is inside the repository: secrets must stay outside the checkout")
    project = project_name(suffix)
    work = root / project
    (work / "env").mkdir(parents=True, exist_ok=False)  # exist_ok=False: never reuse another run's directory
    password = secrets.token_hex(16)
    for name in ("postgres", "backend", "inference"):
        text = (ENV_EXAMPLES / f"{name}.env.example").read_text(encoding="utf-8")
        if name != "inference" and "CHANGE_ME_LOCAL_ONLY" not in text:  # inference.env.example carries no secret
            raise HarnessError(f"infra/env/{name}.env.example has no CHANGE_ME_LOCAL_ONLY placeholder")
        out = work / "env" / f"{name}.env"
        out.write_text(text.replace("CHANGE_ME_LOCAL_ONLY", password), encoding="utf-8", newline="\n")
        out.chmod(0o600)
    users = {"analyst": ("u-analyst-1", "analyst@example.test"), "viewer": ("u-viewer-1", "viewer@example.test")}
    for n in range(1, int(load_users) + 1):  # extra viewers, only for the global stream limit (20 streams need more than 2 users)
        users[f"load{n}"] = (f"u-load-{n}", f"load{n}@example.test")
    tokens = {role: secrets.token_hex(32) for role in users}
    (work / "dev-tokens.json").write_text(json.dumps({"users": [
        {"userId": uid, "email": email, "role": "viewer" if role.startswith("load") else role, "tokenSha256": hashlib.sha256(tokens[role].encode()).hexdigest()}
        for role, (uid, email) in users.items()]}), encoding="utf-8", newline="\n")
    (work / "dev-tokens.json").chmod(0o644)  # the container user must read the bind mount
    smoke = work / "smoke-tokens.json"
    smoke.write_text(json.dumps({role: {"userId": users[role][0], "token": tokens[role]} for role in users}), encoding="utf-8", newline="\n")
    smoke.chmod(0o600)
    images = work / "images.yaml"
    images.write_text("services:\n" + "".join(f"  {s}:\n    image: {image_tag(s, suffix)}\n" for s in SERVICES if observations or s != "ingestion"), encoding="utf-8", newline="\n")
    state = {"project": project, "suffix": suffix, "port": port, "work": str(work), "commit": commit, "fault": bool(fault), "users": len(users), "observations": bool(observations)}
    (work / "state.json").write_text(json.dumps(state), encoding="utf-8", newline="\n")
    return state


def load_state(root: Path, project: str) -> dict:
    """The state of an existing project; refuses any name this harness did not create and any tampered state."""
    if not PROJECT_RE.match(project or ""):
        raise HarnessError(f"refusing project {project!r}: only cbdc-p3s-<8 hex> projects made by this harness are handled")
    path = Path(root) / project / "state.json"
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise HarnessError(f"no state for {project} under {root} ({type(e).__name__})") from e
    ok = (state.get("project") == project and state.get("suffix") == project.rsplit("-", 1)[1]
          and Path(state.get("work", "")).resolve() == (Path(root) / project).resolve() and isinstance(state.get("port"), int))
    if not ok:
        raise HarnessError(f"the state file of {project} does not match it")
    return state


def compose_args(state: dict, *extra_profiles: str) -> list[str]:
    """`docker compose` for this project: base file, observations overlay, the run-specific images; full + observations."""
    work = Path(state["work"])
    plain = state.get("observations", True) is False  # the Phase 2 stack alone: the baseline for "observations absent" (AD-6 T-1)
    profiles = ["full", *([] if plain else ["observations"]), *extra_profiles]
    files = [COMPOSE] + ([] if plain else [OVERLAY] + ([FAULT_OVERLAY] if state.get("fault") else [])) + [work / "images.yaml"]  # images last: they win
    return ["docker", "compose", "-p", state["project"], *[a for f in files for a in ("-f", str(f))],
            *[a for p in profiles for a in ("--profile", p)]]


def compose_env(state: dict) -> dict:
    work = Path(state["work"])
    env = dict(os.environ)
    for k in ("COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES"):
        env.pop(k, None)  # the command line is the only source of files, project and profiles
    env.update(CBDC_ENV_DIR=str(work / "env"), CBDC_DEV_TOKENS_FILE=str(work / "dev-tokens.json"),
               WEB_HOST_PORT=str(state["port"]), CBDC_GIT_COMMIT=state.get("commit", ""))
    return env


def run(cmd: list[str], env: dict | None = None, check: bool = True, capture: bool = False, timeout: int | None = None):
    return subprocess.run(cmd, cwd=REPO, env=env, check=check, text=True, timeout=timeout,
                          stdout=subprocess.PIPE if capture else None, stderr=subprocess.STDOUT if capture else None)


def git_commit() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO, capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def build_commands(state: dict) -> list[list[str]]:
    sfx, commit = state["suffix"], state.get("commit", "")
    t = lambda s: image_tag(s, sfx)  # noqa: E731
    return [
        ["docker", "build", "-t", t("backend"), "services/backend"],
        ["docker", "build", "--target", "migrate", "-t", t("migrate"), "services/backend"],
        ["docker", "build", "--target", "build", "-t", t("seed"), "services/backend"],
        ["docker", "build", *[a for b in state.get("web_args", ["VITE_OBSERVATIONS=on"]) for a in ("--build-arg", b)], "-t", t("web"), "services/web"],
        ["docker", "build", "-f", "services/inference/Dockerfile", "--build-arg", f"CBDC_GIT_COMMIT={commit}", "-t", t("inference"), "."],
        ["docker", "build", "-t", t("ingestion"), "services/ingestion"],
    ][: None if state.get("observations", True) else -1]  # the plain stack builds no ingestion image


def container_state(state: dict, service: str) -> str:
    cid = run(compose_args(state) + ["ps", "-a", "-q", service], env=compose_env(state), capture=True).stdout.strip()
    if not cid:
        return "absent"
    return run(["docker", "inspect", "-f", "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.State.ExitCode}}", cid],
               capture=True).stdout.strip()


def wait_healthy(state: dict, timeout_s: int = 600, poll_s: float = 5.0, clock=time.monotonic, sleep=time.sleep) -> None:
    deadline = clock() + timeout_s
    while True:
        running = [s for s in RUNNING if state.get("observations", True) or s != "ingestion"]
        states = {s: container_state(state, s) for s in running}
        states["migrate"] = container_state(state, "migrate")
        ready = all(states[s] == "running|healthy|0" for s in running) and states["migrate"] == "exited||0"
        if ready:
            return
        if clock() >= deadline:
            raise RuntimeError("the stack did not become healthy in time: " + ", ".join(f"{k}={v}" for k, v in sorted(states.items())))
        sleep(poll_s)


def users_in_db(state: dict) -> str:
    query = "psql -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" -tA -c 'select count(*) from \"User\"'"
    return run(compose_args(state) + ["exec", "-T", "postgres", "sh", "-c", query], env=compose_env(state), capture=True).stdout.strip()


def seed(state: dict) -> None:
    env = compose_env(state)
    if users_in_db(state) != "0":
        raise RuntimeError("the disposable database was not empty before seeding")
    out = run(compose_args(state, "seed") + ["run", "--rm", "-T", "seed"], env=env, capture=True).stdout
    if not re.search(r"Seeded [0-9]+ development users", out):
        raise RuntimeError("the seed did not report its users")
    if users_in_db(state) != str(state.get("users", 2)):
        raise RuntimeError(f"expected {state.get('users', 2)} development users after seeding")


def up(root: Path, port: int | None = None, fault: bool = False, load_users: int = 0, observations: bool = True, web_args: list | None = None) -> dict:
    """`web_args`: web image build arguments, only for the browser acceptance (default: VITE_OBSERVATIONS=on, as before)."""
    suffix = new_suffix()
    state = prepare_config(root, suffix, pick_port(port), git_commit(), fault, load_users, observations)
    if web_args is not None:
        state["web_args"] = list(web_args)
        (Path(state["work"]) / "state.json").write_text(json.dumps(state), encoding="utf-8", newline="\n")
    print(f"project {state['project']} (port {state['port']}, root {Path(state['work']).parent})", flush=True)
    try:
        for cmd in build_commands(state):
            run(cmd)
        run(compose_args(state) + ["up", "-d", "--no-build"], env=compose_env(state))
        wait_healthy(state)
        seed(state)
    except BaseException:
        cleanup(state, root)
        raise
    return state


def set_fault(state: dict, scenario: str) -> str:
    """Steers the fake ingestion through `compose exec` (its control port is the container's loopback). Returns its JSON state."""
    if not state.get("fault"):
        raise HarnessError(f"{state['project']} was not started with --fault")
    out = run(compose_args(state) + ["exec", "-T", "ingestion", "python", "/fault/ctl.py", "set", scenario], env=compose_env(state),
              capture=True, check=False)
    if out.returncode != 0:
        raise RuntimeError(f"the fake ingestion refused scenario {scenario!r}: {out.stdout.strip()[:200]}")
    return out.stdout.strip()


def smoke(state: dict) -> int:
    return subprocess.run([sys.executable, str(SMOKE), "--base-url", f"http://{LOOPBACK}:{state['port']}",
                           "--tokens-file", str(Path(state["work"]) / "smoke-tokens.json")], cwd=REPO).returncode


def cleanup_commands(state: dict) -> list[list[str]]:
    """Every docker command cleanup may run: all scoped to this project's label, volume or image tags."""
    p = state["project"]
    return [compose_args(state, "seed") + ["down", "--volumes", "--remove-orphans"]] + [
        ["docker", "image", "rm", image_tag(s, state["suffix"])] for s in SERVICES]


def cleanup(state: dict, root: Path) -> None:
    """Removes only what this project created; never raises, so a failed run still cleans up."""
    p = state["project"]
    if not PROJECT_RE.match(p):
        raise HarnessError(f"refusing to clean up {p!r}")
    env = compose_env(state)
    label = f"label=com.docker.compose.project={p}"
    run(cleanup_commands(state)[0], env=env, check=False)
    ids = run(["docker", "ps", "-aq", "--filter", label], check=False, capture=True).stdout.split()
    if ids:
        run(["docker", "rm", "-f", *ids], check=False)
    nets = run(["docker", "network", "ls", "-q", "--filter", label], check=False, capture=True).stdout.split()
    if nets:
        run(["docker", "network", "rm", *nets], check=False)
    if run(["docker", "volume", "inspect", f"{p}_pgdata"], check=False, capture=True).returncode == 0:
        run(["docker", "volume", "rm", f"{p}_pgdata"], check=False)
    for cmd in cleanup_commands(state)[1:]:
        run(cmd, check=False, capture=True)
    work = Path(state["work"])
    if is_inside(work, Path(root)) and work.name == p:
        shutil.rmtree(work, ignore_errors=True)
    print(f"removed project {p}", flush=True)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("command", choices=["up", "smoke", "down", "run", "fault"])
    ap.add_argument("--root", type=Path, default=default_root(), help="where disposable configuration lives (outside the checkout)")
    ap.add_argument("--project", help="the project to act on (smoke, down)")
    ap.add_argument("--port", type=int, help="host port for the web service on 127.0.0.1 (default: any free port)")
    ap.add_argument("--fault", action="store_true", help="up, run: use the test-only fake ingestion")
    ap.add_argument("--scenario", help="fault: the scenario to set (infra/testing/fault_ingestion/scenarios.py)")
    ap.add_argument("--load-users", type=int, default=0, help="up, run: extra viewer users (for global stream-limit checks)")
    ap.add_argument("--no-observations", action="store_true", help="up, run: the plain Phase 2 stack, without the overlay (AD-6 T-1 baseline)")
    ap.add_argument("--keep", action="store_true", help="run: leave the stack up afterwards")
    args = ap.parse_args(argv)
    try:
        if args.command == "up":
            up(args.root, args.port, args.fault, args.load_users, not args.no_observations)
            return 0
        if args.command in ("smoke", "down", "fault"):
            state = load_state(args.root, args.project)
            if args.command == "fault":
                print(set_fault(state, args.scenario or ""))
                return 0
            if args.command == "smoke":
                return 1 if smoke(state) else 0
            cleanup(state, args.root)
            return 0
        state = up(args.root, args.port, args.fault, args.load_users, not args.no_observations)
        try:
            return 1 if smoke(state) else 0
        finally:
            if not args.keep:
                cleanup(state, args.root)
    except HarnessError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    except (RuntimeError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        print(f"FAIL {type(e).__name__}: {str(e)[:300]}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
