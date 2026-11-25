#!/usr/bin/env python3
"""AD-6 T-6, T-7 and T-8 (Dev D; docs/PHASE3_AD6_ENGINE_BOUNDARY.md section 8).

  T-6 "Phase 1 artefacts and knowledge hashes are identical before and after an event soak."
      Host files (src, data, outputs, contracts/test-vectors, services/inference) and the same trees inside the running inference
      container are hashed, a real observation soak runs (p3_stream_probe phases soak and faults, on a disposable stack), and both are hashed again.
  T-7 "Contract fixtures, decision_id vectors and the Phase 1 and 2 suites pass unmodified."
      Protected paths are compared with the approved Phase 2 baseline (the merge commit of PR #14, the integrated Phase 2). Modifying, deleting
      or renaming a baseline file there fails. Adding a file there fails unless it is in AUTHORIZED_ADDITIONS. The suites themselves are run by CI.
  T-8 "Text check on the UI and status documents for the forbidden phrases." (AD-6 section 6, D-15; scope 1.3 and 6)

Approved text versus choices made here (confirmed against AD-6 v0.2, scope v1.4, AD-1 v0.5; recorded for Stage 7 CI):
  - AD-6 names no soak duration, no event rate and no file list for T-6; it says only "before and after an event soak". The 120 s default
    here is a choice, not an approved figure. Stage 7 CI must state the duration and the run mode (AD-13 owns the test strategy); the
    5 minute probe soak (--soak-seconds 300, the p3_stream_probe default) is the proposed CI value, pending that approval.
  - AD-6 T-8 says "the UI and status documents" and gives no list; section 6 and scope 1.3 name the phrases. STATUS_DOCS below is this
    harness's reading (README, CLAUDE.md, status/handover documents and component READMEs; the UI is services/web/src). Stage 7 must
    confirm the list; it deliberately excludes the Phase 3 design documents, which quote the phrases in order to forbid them.
  - AD-6 T-7 names "Contract fixtures, decision_id vectors and the Phase 1 and 2 suites". Stage 7 CI must run, unmodified: python -m pytest tests/
    (Phase 1, last recorded 193 passed), the Phase 2 inference and backend suites and the contract-fixture checks (infra/scripts check_contracts.py
    and its tests, the decision_id vector tests), plus this guard's `protected` command. This script checks only that those files are unchanged.

  T-6 also sends the T-1 requests before and after the soak and requires the same decision_id and engine responses.

  python e2e/p3_safeguards.py protected [--baseline REV]       T-7, static
  python e2e/p3_safeguards.py text                             T-8, static
  python e2e/p3_safeguards.py soak --up [--soak-seconds 120]   T-6, real stack (or --project P from p3_stack.py up --fault --load-users 7)
Exit status: 0 when every check passed, 1 on any failure, 2 on unusable arguments.
"""
from __future__ import annotations

import argparse
import hashlib
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

# --- T-7 ---------------------------------------------------------------------------------------------------------
BASELINE = "28da68f"  # Merge pull request #14 (phase2-platform): Phase 2 integrated into main, all CI checks passed.
PROTECTED = ("src/", "data/", "outputs/", "tests/", "contracts/fixtures/", "contracts/test-vectors/", "contracts/openapi/",
             "services/inference/", "services/backend/src/routes/", "services/backend/src/mappers/", "services/backend/src/inferenceClient/",
             "requirements.txt", "requirements-lock.txt")
PROTECTED_ROOT_PY = re.compile(r"^[^/]+\.py$")  # the Phase 1 run_*.py and analysis scripts at the repository root
# Phase 3 additions inside protected paths that an approved document authorizes. Anything else added there is a violation.
AUTHORIZED_ADDITIONS = {"contracts/test-vectors/event_payload_hash.v1.json"}  # AD-4 section 10 payload hash vectors


def is_protected(path: str) -> bool:
    return path.startswith(PROTECTED) or bool(PROTECTED_ROOT_PY.match(path))


def protected_problems(changes: list, allowed=AUTHORIZED_ADDITIONS) -> list:
    """`changes` is [(status, path)] against the baseline, status one of A, M, D, R, T, U (untracked counts as A)."""
    out = []
    for status, path in changes:
        if not is_protected(path):
            continue
        if status == "A" and path in allowed:
            continue
        out.append(f"{path}: {'added, not authorized' if status == 'A' else {'M': 'modified', 'D': 'deleted'}.get(status, 'changed (' + status + ')')}")
    return out


def git(*args) -> str:
    return subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True, check=True).stdout


def changes_since(baseline: str) -> list:
    """Committed and uncommitted changes against the baseline, plus untracked files. Renames are split so both ends are seen."""
    git("merge-base", "--is-ancestor", baseline, "HEAD")  # the baseline must be in this history
    rows = [line.split("\t") for line in git("diff", "--name-status", "--no-renames", baseline).splitlines() if line]
    out = [(r[0][0], r[1]) for r in rows]
    out += [("A", p) for p in git("ls-files", "-o", "--exclude-standard").splitlines() if p]
    return out


# --- T-8 ---------------------------------------------------------------------------------------------------------
UI_DIR = "services/web/src"
# The 10 documents approved for T-8 (Stage 7). The UI is every .ts, .tsx, .md, .html, .json and .css file under services/web/src.
STATUS_DOCS = ("README.md", "CLAUDE.md", "docs/PHASE2_STATUS.md", "docs/PROJECT_HANDOVER.md", "docs/PHASE3_MILESTONE_3_1_PLAN.md",
               "infra/README.md", "contracts/README.md", "services/backend/README.md", "services/web/README.md", "services/ingestion/README.md")
PHRASES = re.compile(r"live[\s-]+routing|routing\s+(?:on|with|using)\s+(?:live|real[\s-]?time)\s+data|real[\s-]?time\s+(?:optimal\s+)?rout(?:e|es|ing)\b"
                     r"|live\s+route\s+optimi[sz]ation|real[\s-]?time\s+optimal", re.I)
# Only an explicit prohibition or disclaimer excuses a phrase. A bare "no" or "not" elsewhere on the line does not.
Q = "\"'`“‘"
CLOSE_Q = "\"'`”’"
VERB = (r"(?:(?:do|does|did|must|should|will|shall|may|can)\s+not|don't|doesn't|never|(?:is|are)\s+(?:not|never)|(?:is|are)n't)\s+"
        r"(?:be\s+|been\s+)?(?:describ|call|claim|us|say|label|market|present|refer|state|word|name)\w*")
# verb ... as "phrase", "phrase" or "phrase": the phrase is quoted and the quote follows nothing but the verb and earlier quoted phrases
PRE_QUOTED = re.compile(VERB + rf"[^{Q}.;]{{0,60}}(?:[{Q}][^{Q}]{{0,40}}[{CLOSE_Q}]\s*(?:,|or|and)?\s*(?:or\s+|and\s+)?[^{Q}.;]{{0,10}})*[{Q}]\s*$", re.I)
PRE_IS_NOT = re.compile(r"(?:is|are)\s+not\s+(?:a\s+|an\s+)?$", re.I)          # "This is not live routing."
POST_NEVER = re.compile(rf"^[{CLOSE_Q}]\s*(?:(?:,|or|and)\s*[{Q}][^{Q}]{{0,40}}[{CLOSE_Q}]\s*)*(?:is|are)\s+(?:never|not)\s+(?:used|described|claimed)", re.I)  # '"live routing" is never used'


def disclaimed(line: str, m) -> bool:
    prefix = re.split(r"[.;]", line[:m.start()])[-1]
    return bool(PRE_QUOTED.search(prefix) or PRE_IS_NOT.search(prefix) or POST_NEVER.match(line[m.end():]))


TEXT_SUFFIXES = {".ts", ".tsx", ".md", ".html", ".json", ".css"}


def text_problems(name: str, text: str) -> list:
    out = []
    for n, line in enumerate(text.splitlines(), 1):
        if any(not disclaimed(line, m) for m in PHRASES.finditer(line)):
            out.append(f"{name}:{n}: {line.strip()[:100]}")
    return out


def text_files() -> list:
    """The UI sources and the listed documents. A listed document that is missing is an error: a silent skip would shrink the scope."""
    missing = [d for d in STATUS_DOCS if not (REPO / d).is_file()]
    ui = [p for p in (REPO / UI_DIR).rglob("*") if p.is_file() and p.suffix in TEXT_SUFFIXES]
    if missing or not ui:
        raise FileNotFoundError(f"T-8 scope is incomplete: missing documents {missing}, {len(ui)} UI files under {UI_DIR}")
    return ui + [REPO / d for d in STATUS_DOCS]


# --- T-6 ---------------------------------------------------------------------------------------------------------
HASHED = ("src", "data", "outputs", "contracts/test-vectors", "services/inference")
CONTAINER_HASHED = ("src", "data/structured", "data/processed", "data/knowledge", "contracts/test-vectors", "services/inference")
SKIP = {"__pycache__", ".pytest_cache", ".venv", "node_modules"}


def hash_tree(root: Path, trees=HASHED) -> dict:
    out = {}
    for t in trees:
        for p in sorted((root / t).rglob("*")):
            rel = p.relative_to(root).as_posix()
            if p.is_file() and not SKIP & set(p.relative_to(root).parts) and p.suffix != ".pyc":
                out[rel] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


def hash_diff(before: dict, after: dict) -> list:
    return ([f"{p}: removed" for p in sorted(before.keys() - after.keys())] + [f"{p}: added" for p in sorted(after.keys() - before.keys())]
            + [f"{p}: content changed" for p in sorted(p for p in before.keys() & after.keys() if before[p] != after[p])])


def container_hashes(ctx) -> dict:
    roots = " ".join(f"/repo/{t}" for t in CONTAINER_HASHED)
    cmd = f"find {roots} -type f ! -name '*.pyc' ! -path '*/__pycache__/*' | sort | xargs sha256sum"
    out = ctx.compose("exec", "-T", "inference", "sh", "-c", cmd, timeout=300)
    if out.returncode != 0:
        raise RuntimeError(f"hashing inside the inference container failed: {out.stdout.strip()[:200]}")
    pairs = (line.split(None, 1) for line in out.stdout.splitlines() if line.strip())
    return {path.strip(): digest for digest, path in pairs}


def run_soak(args) -> int:
    sys.path.insert(0, str(REPO / "e2e"))
    import p3_stream_probe as sp  # noqa: E402  (also puts infra/scripts on sys.path)
    p3 = sp.p3
    state = p3.up(args.root, None, True, 7) if args.up else p3.load_state(args.root, args.project)
    try:
        ctx = sp.make_ctx(state)
        import p3_noninterference as ni  # noqa: E402  (the T-1 requests and the decision and stored-response comparison)
        baseline = ni.collect(ctx, "before the soak")
        host_before, box_before = hash_tree(REPO), container_hashes(ctx)
        ctx.check(len(host_before) > 100 and len(box_before) > 100, "T-6: files were hashed (the measurement sees the artefacts)",
                  f"{len(host_before)} host files, {len(box_before)} container files")
        ctx.check(any(p.endswith("regulatory_facts.json") for p in host_before) and any(p.endswith("regulatory_facts.json") for p in box_before),
                  "T-6: the knowledge base is among the hashed files, on the host and in the container")
        rc = sp.run_phases(ctx, ["soak", "faults"], args.soak_seconds, 0)
        ni.compare_with(ctx, baseline, ni.collect(ctx, "after the soak"), "T-6 after the soak")  # routing is unchanged by the soak
        d_host, d_box = hash_diff(host_before, hash_tree(REPO)), hash_diff(box_before, container_hashes(ctx))
        ctx.check(not d_host, "T-6: the host Phase 1 artefact and knowledge hashes are identical after the soak", "; ".join(d_host[:3]))
        ctx.check(not d_box, "T-6: the same hashes inside the inference container are identical after the soak", "; ".join(d_box[:3]))
        print(f"\nT-6 totals: {ctx.passed} passed, {len(ctx.failed)} failed", flush=True)
        return 1 if rc or ctx.failed else 0
    finally:
        if args.up and not args.keep:
            p3.cleanup(state, args.root)


def report(title: str, problems: list, ok_detail: str) -> int:
    for p in problems:
        print(f"FAIL {title}: {p}")
    if not problems:
        print(f"PASS {title}: {ok_detail}")
    return 1 if problems else 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("cmd", choices=("protected", "text", "soak"))
    ap.add_argument("--baseline", default=BASELINE)
    ap.add_argument("--project")
    ap.add_argument("--up", action="store_true")
    ap.add_argument("--root", type=Path)
    ap.add_argument("--soak-seconds", type=int, default=120)
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args(argv)
    if args.cmd == "protected":
        ch = changes_since(args.baseline)
        return report("T-7", protected_problems(ch), f"{len(ch)} changes since {args.baseline}; none in a protected path except authorized additions")
    if args.cmd == "text":
        try:
            files = text_files()
        except FileNotFoundError as e:
            print(f"FAIL T-8: {e}")
            return 1
        problems = [p for f in files for p in text_problems(f.relative_to(REPO).as_posix(), f.read_text(encoding="utf-8", errors="replace"))]
        return report("T-8", problems, f"{len(files)} UI and status files, no forbidden phrase")
    if bool(args.up) == bool(args.project) or args.soak_seconds < 5:
        print("choose exactly one of --up/--project; --soak-seconds is at least 5", file=sys.stderr)
        return 2
    sys.path.insert(0, str(REPO / "infra" / "scripts"))
    import p3_stack as p3  # noqa: E402
    args.root = args.root or p3.default_root()
    try:
        return run_soak(args)
    except p3.HarnessError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
