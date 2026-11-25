#!/usr/bin/env python3
"""Real-browser acceptance of the observation panel (AD-1 v0.5 section 6 items 2, 8, 9; AD-6 T-2, T-3, T-10), Dev D.

Builds one disposable stack per web build flavour with infra/scripts/p3_stack.py, runs e2e/p3/observations.spec.ts (config e2e/playwright.p3.config.ts) against it
with the tests of that flavour (selected by tag, never skipped), and always removes the stacks:

  on       observations stack, fake ingestion, web built with VITE_OBSERVATIONS=on
  off      observations stack, fake ingestion (so the stream route exists), web built with VITE_OBSERVATIONS=off
  preview  plain Phase 2 stack; the web Dockerfile has no VITE_API_MODE build argument, so a bundle built with
           VITE_API_MODE=preview VITE_OBSERVATIONS=on is made in a throwaway Node container from the unmodified services/web
           sources and copied into the stack's nginx (test-only; no production file changes)

  python e2e/p3_browser_acceptance.py [--flavours on,off,preview] [--soak-seconds 300] [--root DIR] [--keep]
Exit status: 0 when every Playwright run passed, 1 otherwise, 2 on unusable arguments.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "infra" / "scripts"))
import p3_stack as p3  # noqa: E402

# flavour -> (fault, observations, web build args)
FLAVOURS = {
    "on": (True, True, ["VITE_OBSERVATIONS=on"]),
    "off": (True, True, ["VITE_OBSERVATIONS=off"]),
    "preview": (False, False, ["VITE_OBSERVATIONS=off"]),  # the image is replaced by install_preview_bundle()
}
NODE_IMAGE = "node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0"  # as services/web/Dockerfile


def install_preview_bundle(state: dict, root: Path) -> None:
    out = Path(state["work"]) / "preview-dist"
    out.mkdir()
    p3.run(["docker", "run", "--rm", "-v", f"{REPO / 'services' / 'web'}:/src:ro", "-v", f"{out}:/out", "-e", "VITE_API_MODE=preview", "-e", "VITE_OBSERVATIONS=on",
            NODE_IMAGE, "sh", "-c", "cp -r /src/. /app && cd /app && npm ci --no-audit --no-fund --loglevel=error && npm run build && cp -r dist/. /out/"], timeout=900)
    web = p3.run(p3.compose_args(state) + ["ps", "-q", "web"], env=p3.compose_env(state), capture=True).stdout.strip()
    if not web or not (out / "index.html").is_file():
        raise p3.HarnessError("the preview bundle was not built or the web container was not found")
    p3.run(["docker", "exec", web, "sh", "-c", "rm -rf /usr/share/nginx/html/*"])
    p3.run(["docker", "cp", f"{out}/.", f"{web}:/usr/share/nginx/html/"])


def run_flavour(name: str, root: Path, soak: int, keep: bool, out_dir: Path) -> int:
    fault, observations, web_args = FLAVOURS[name]
    state = p3.up(root, None, fault, 0, observations, web_args)
    try:
        if name == "preview":
            install_preview_bundle(state, root)
        env = dict(os.environ, E2E_BASE_URL=f"http://127.0.0.1:{state['port']}", E2E_TOKENS_FILE=str(Path(state["work"]) / "smoke-tokens.json"),
                   E2E_STACK_PROJECT=state["project"], E2E_STACK_ROOT=str(root), E2E_SOAK_SECONDS=str(soak), E2E_OUTPUT_DIR=str(out_dir / name),
                   E2E_PYTHON=sys.executable, E2E_P3_STACK=str(REPO / "infra" / "scripts" / "p3_stack.py"))
        npx = shutil.which("npx") or "npx"
        print(f"\n===== browser acceptance: {name} (project {state['project']}, port {state['port']})", flush=True)
        return subprocess.run([npx, "playwright", "test", "-c", "playwright.p3.config.ts", "observations.spec.ts", "--grep", f"@{name}\\b"], cwd=REPO / "e2e", env=env).returncode
    finally:
        if not keep:
            p3.cleanup(state, root)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--flavours", default=",".join(FLAVOURS))
    ap.add_argument("--soak-seconds", type=int, default=300)
    ap.add_argument("--root", type=Path, default=p3.default_root())
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args(argv)
    names = [n for n in args.flavours.split(",") if n]
    if not names or any(n not in FLAVOURS for n in names) or args.soak_seconds < 10:
        print("--flavours takes a subset of " + ",".join(FLAVOURS) + "; --soak-seconds is at least 10", file=sys.stderr)
        return 2
    out_dir = args.root / "browser-output"  # outside the checkout; removed at the end (failure snapshots can hold form values)
    try:
        results = {}
        for name in names:
            try:
                results[name] = run_flavour(name, args.root, args.soak_seconds, args.keep, out_dir)
            except p3.HarnessError as e:
                print(f"error: {e}", file=sys.stderr)
                results[name] = 2
        print("\n" + ", ".join(f"{n}: {'passed' if rc == 0 else f'FAILED ({rc})'}" for n, rc in results.items()))
        return 0 if all(rc == 0 for rc in results.values()) else 1
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
