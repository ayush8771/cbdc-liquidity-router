"""Compile the inference service's hashed dependency locks (arch §7.2).

Input:  services/inference/requirements/service.in   (owned by Dev A; never edited here)
Output: services/inference/requirements/<target>.txt (owned by Dev D; generated, never hand-edited)

Only the Linux CPU lock is defined so far. It is what the Docker image and Linux
CI install:

    pip install --require-hashes --no-deps -r services/inference/requirements/linux-x86_64-cpu.txt

How the lock stays reproducible and CPU-only:
  * uv resolves for the target platform from any host (`--python-platform`,
    `--python-version 3.10.11`), so a Windows machine can produce the Linux lock.
  * torch's CPU build comes from `--find-links https://download.pytorch.org/whl/cpu/torch/`,
    a page that lists torch files only (with SHA-256 hashes), plus a generated
    constraint `torch==<version>+cpu`. Every other package comes from PyPI.
    This deliberately differs from arch §7.2's `--extra-index-url`: the PyTorch
    index also mirrors common packages (certifi, idna, numpy, packaging, ...),
    often at old versions, and with an extra index uv either took those stale
    copies (default "first-index" strategy) or chose between the two indexes
    inconsistently from run to run ("unsafe-best-match"). Both were observed
    on 2026-11-20 with uv 0.9.5. PyPI's CUDA torch (which pulls nvidia-* and
    triton) can't satisfy the +cpu constraint, so it can't be chosen.
  * `--generate-hashes` pins the SHA-256 of every allowed file, and pip's
    `--require-hashes` refuses anything else. uv 0.9.5 does not record hashes
    for --find-links files, so this script adds torch's hash itself: the
    SHA-256 that the find-links page publishes for the one wheel the target
    installs (cp310, the target's platform tag). The build fails if there is
    not exactly one such wheel.
  * The uv version is pinned (UV_VERSION). A different uv refuses to run unless
    --allow-other-uv is given, because resolver changes can alter the output.
  * After compiling, the lock is checked: torch must be the +cpu build, there
    must be no nvidia-*/triton/cognee package, every requirement must be pinned
    with == and carry at least one hash, and the only sources recorded must be
    PyPI and the torch find-links page.

Usage, from the repository root. Either uv 0.9.5 on the host:
    python infra/scripts/compile_locks.py            # (re)write the locks
    python infra/scripts/compile_locks.py --check    # compile to a temp file and fail on drift
    python infra/scripts/compile_locks.py --verify-only   # only check the committed locks
    python infra/scripts/compile_locks.py --dry-run  # print the uv commands; needs no uv, no network
or, with nothing installed on the host, the pinned uv image (PowerShell; use
$(pwd) and / on Linux):
    docker run --rm -v "${PWD}:/repo:ro" `
      -v "${PWD}\\services\\inference\\requirements:/repo/services/inference/requirements" `
      -w /repo -e UV_NO_CACHE=1 -e PYTHONDONTWRITEBYTECODE=1 `
      ghcr.io/astral-sh/uv:0.9.5-python3.10-bookworm-slim@sha256:943dbc60b63651da8ab6c90086a41d469c9d690db1e5a74f89ababcee064cfa1 `
      python infra/scripts/compile_locks.py

Note on --check: transitive dependencies are not pinned in service.in, so a new
upstream release can make --check report drift. That is the intended signal:
regenerate, review the diff and commit it deliberately.
"""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
REQ_DIR = REPO / "services" / "inference" / "requirements"
SERVICE_IN = REQ_DIR / "service.in"

UV_VERSION = "0.9.5"
PYTHON_VERSION = "3.10.11"
TORCH_VERSION = "2.13.0"
PYPI_INDEX = "https://pypi.org/simple"
TORCH_CPU_FIND_LINKS = "https://download.pytorch.org/whl/cpu/torch/"
CONSTRAINT_LABEL = "(generated torch constraint, see compile_locks.py)"

# Packages that must never be in a core CPU lock.
FORBIDDEN_PREFIXES = ("nvidia-", "triton", "cognee")


@dataclass(frozen=True)
class Target:
    name: str
    python_platform: str
    find_links: tuple[str, ...]
    torch_local_version: str  # required local version label of torch, e.g. "cpu"
    torch_wheel_platform: str  # platform tag of the one torch wheel installed, e.g. "manylinux_2_28_x86_64"

    @property
    def output(self) -> Path:
        return REQ_DIR / f"{self.name}.txt"


TARGETS = {
    # python:3.10.11-slim-bookworm has glibc 2.36, so manylinux_2_28 wheels install.
    "linux-x86_64-cpu": Target(
        name="linux-x86_64-cpu",
        python_platform="x86_64-manylinux_2_28",
        find_links=(TORCH_CPU_FIND_LINKS,),
        torch_local_version="cpu",
        torch_wheel_platform="manylinux_2_28_x86_64",
    ),
}


def torch_wheel_name(target: Target) -> str:
    return f"torch-{TORCH_VERSION}+{target.torch_local_version}-cp310-cp310-{target.torch_wheel_platform}.whl"


def torch_hash_from_page(html: str, target: Target) -> str:
    """The SHA-256 the find-links page publishes for the target's torch wheel (exactly one)."""
    name = re.escape(torch_wheel_name(target).replace("+", "%2B"))
    found = set(re.findall(rf'href="[^"]*/{name}#sha256=([0-9a-f]{{64}})"', html))
    if len(found) != 1:
        raise RuntimeError(f"expected one sha256 for {torch_wheel_name(target)} on the find-links page, found {len(found)}")
    return found.pop()


def add_torch_hash(text: str, sha256: str) -> str:
    """Add the hash to the lock's unhashed `torch==...` line (uv emits none for find-links files)."""
    lines = text.split("\n")
    index = [i for i, line in enumerate(lines) if line.startswith("torch==")]
    if len(index) != 1:
        raise RuntimeError("expected exactly one torch line in the lock")
    i = index[0]
    if lines[i].endswith("\\"):
        return text  # uv already recorded hashes; verify_lock checks them
    lines[i : i + 1] = [f"{lines[i]} \\", f"    --hash=sha256:{sha256}"]
    return "\n".join(lines)


def fetch(url: str) -> str:
    from urllib.request import urlopen

    with urlopen(url, timeout=60) as response:  # noqa: S310 (fixed https URL)
        return response.read().decode("utf-8")


def torch_constraint(target: Target) -> str:
    return f"torch=={TORCH_VERSION}+{target.torch_local_version}\n"


def uv_command(uv: str, target: Target, output: Path, constraint_file: Path) -> list[str]:
    cmd = [
        uv, "pip", "compile", str(SERVICE_IN.relative_to(REPO)).replace("\\", "/"),
        "--output-file", str(output),
        "--python-version", PYTHON_VERSION,
        "--python-platform", target.python_platform,
        "--index-url", PYPI_INDEX,
        "--generate-hashes",
        "--emit-index-url",
        "--emit-find-links",
        "--no-strip-extras",
        "--quiet",
        "--constraint", str(constraint_file),
        "--custom-compile-command", f"python infra/scripts/compile_locks.py --target {target.name}",
    ]
    for url in target.find_links:
        cmd += ["--find-links", url]
    return cmd


_REQ_LINE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?==(\S+?)(\s*;.*?)?\s*\\?$")
_SOURCE_LINE = re.compile(r"^--(index-url|extra-index-url|find-links|trusted-host)\s+(\S+)$")


def parse_lock(text: str) -> dict[str, tuple[str, int]]:
    """Return {normalised name: (version, number of hashes)} for a uv/pip-compile lock."""
    packages: dict[str, tuple[str, int]] = {}
    current: str | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("--"):
            if line.startswith("--hash=") and current is not None:
                version, n = packages[current]
                packages[current] = (version, n + 1)
            continue
        match = _REQ_LINE.match(line)
        if match is None:
            raise ValueError(f"unexpected lock line (not pinned with ==?): {line!r}")
        current = re.sub(r"[-_.]+", "-", match.group(1)).lower()
        packages[current] = (match.group(3), 0)
    return packages


def lock_sources(text: str) -> list[tuple[str, str]]:
    """The (option, url) source lines a lock records, e.g. ("index-url", "https://pypi.org/simple")."""
    return [m.groups() for m in (_SOURCE_LINE.match(l.strip()) for l in text.splitlines()) if m]


def verify_lock(text: str, target: Target) -> list[str]:
    """Problems with a compiled lock; empty when it is acceptable."""
    try:
        packages = parse_lock(text)
    except ValueError as error:
        return [str(error)]
    problems = []
    torch = packages.get("torch")
    expected = f"{TORCH_VERSION}+{target.torch_local_version}"
    if torch is None:
        problems.append("torch is missing from the lock")
    elif torch[0] != expected:
        problems.append(f"torch must be {expected}, found {torch[0]}")
    for name in sorted(packages):
        if name.startswith(FORBIDDEN_PREFIXES):
            problems.append(f"forbidden package in a core CPU lock: {name}")
        if packages[name][1] == 0:
            problems.append(f"no --hash for {name}")
    allowed = {("index-url", PYPI_INDEX)} | {("find-links", url) for url in target.find_links}
    sources = set(lock_sources(text))
    for option, url in sorted(sources - allowed):
        problems.append(f"unexpected package source --{option} {url}")
    for option, url in sorted(allowed - sources):
        problems.append(f"lock does not record --{option} {url}")
    return problems


def find_uv(explicit: str | None) -> str:
    if explicit:
        return explicit
    local = REPO / "infra" / ".venv" / ("Scripts/uv.exe" if sys.platform == "win32" else "bin/uv")
    if local.exists():
        return str(local)
    found = shutil.which("uv")
    if found:
        return found
    sys.exit(
        f"uv not found. Install uv {UV_VERSION} into infra/.venv, or use the Docker command in this script's docstring."
    )


def check_uv_version(uv: str, allow_other: bool) -> None:
    out = subprocess.run([uv, "--version"], capture_output=True, text=True, check=True).stdout.strip()
    version = out.split()[1] if len(out.split()) > 1 else out
    if version != UV_VERSION and not allow_other:
        sys.exit(f"uv {UV_VERSION} is required for reproducible locks, found {out!r} (or pass --allow-other-uv)")


def compile_target(uv: str, target: Target, output: Path) -> None:
    # The torch constraint is generated, not committed, so service.in stays the only input.
    # uv always writes to a fresh temporary file: like pip-tools, `uv pip compile`
    # treats an existing --output-file as version preferences, which would carry
    # old pins forward and make the result depend on the previous lock.
    with tempfile.TemporaryDirectory() as tmp:
        constraint = Path(tmp) / "torch-constraint.txt"
        constraint.write_text(torch_constraint(target), encoding="utf-8")
        fresh = Path(tmp) / "lock.txt"
        subprocess.run(uv_command(uv, target, fresh, constraint), cwd=REPO, check=True)
        # Replace the random temporary path in uv's "# via -c ..." annotations so
        # repeated compiles are byte-identical (needed by --check).
        text = fresh.read_text(encoding="utf-8").replace(str(constraint), CONSTRAINT_LABEL)
    sha256 = torch_hash_from_page(fetch(target.find_links[0]), target)
    output.write_text(add_torch_hash(text, sha256), encoding="utf-8", newline="\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--target", choices=sorted(TARGETS), action="append", help="default: all targets")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="compile to a temporary file and fail if it differs")
    mode.add_argument("--verify-only", action="store_true", help="only verify the committed lock files")
    mode.add_argument("--dry-run", action="store_true", help="print the uv commands, run nothing")
    parser.add_argument("--uv", help="path to the uv executable")
    parser.add_argument("--allow-other-uv", action="store_true")
    args = parser.parse_args(argv)
    targets = [TARGETS[name] for name in (args.target or sorted(TARGETS))]

    if not args.verify_only and not SERVICE_IN.is_file():
        sys.exit(f"{SERVICE_IN.relative_to(REPO)} not found: no lock is generated without the inference inputs.")
    if args.dry_run:
        # Nothing is run: no uv, no network, no file written. The torch constraint and the
        # output are temporary files in a real run; placeholders stand in for their paths.
        for target in targets:
            cmd = uv_command(args.uv or "uv", target, Path("<temporary lock file>"), Path("<generated torch constraint>"))
            print(" ".join(f'"{part}"' if " " in part else part for part in cmd))
        return 0

    if not args.verify_only:
        uv = find_uv(args.uv)
        check_uv_version(uv, args.allow_other_uv)

    failed = False
    for target in targets:
        if args.verify_only:
            text = target.output.read_text(encoding="utf-8")
        elif args.check:
            with tempfile.TemporaryDirectory() as tmp:
                fresh = Path(tmp) / target.output.name
                compile_target(uv, target, fresh)
                text = fresh.read_text(encoding="utf-8")
            committed = target.output.read_text(encoding="utf-8") if target.output.exists() else ""
            if text.replace("\r\n", "\n") != committed.replace("\r\n", "\n"):
                print(f"DRIFT: {target.output.relative_to(REPO)} differs from a fresh compile")
                failed = True
        else:
            compile_target(uv, target, target.output)
            text = target.output.read_text(encoding="utf-8")
        problems = verify_lock(text, target)
        for problem in problems:
            print(f"{target.name}: {problem}")
        failed = failed or bool(problems)
        if not problems:
            print(f"{target.name}: OK ({len(parse_lock(text))} packages, torch {TORCH_VERSION}+{target.torch_local_version})")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
