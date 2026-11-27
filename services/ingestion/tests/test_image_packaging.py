"""Acceptance criterion 11: test-only code cannot enter the image — asserted statically.

The claim is **packaging exclusion**, and the evidence matches it: this parses
`services/ingestion/Dockerfile`, resolves every `COPY`/`ADD` source against the
declared build context (`services/ingestion/`) and its `.dockerignore`, and
asserts that no copied path can resolve to `infra/testing/fake_provider/` or to
`services/ingestion/tests/`. The first lies outside the build context entirely;
the second is named by no `COPY` and is excluded by the allow-list.

**It needs no Docker build, daemon or image listing.** It also does **not**
claim to have inspected a built image (authorization §12 item 10): a path that
entered by another route — a changed build context, a new stage, `COPY --from`
— is only caught here because those constructs are themselves refused below.
The negative controls prove each refusal fires.

The `.dockerignore` matcher is a deliberate subset of Docker's: ordered
patterns, `!` negation, `*`, `?`, `**`, and a parent match covering its
children. A pattern outside that subset raises rather than being guessed at.
"""
from __future__ import annotations

import ast
import glob
import posixpath
import re
import shlex
from pathlib import Path

import pytest

from .conftest import REPO_ROOT, SERVICE_ROOT

CONTEXT = SERVICE_ROOT
FAKE_PROVIDER = REPO_ROOT / "infra" / "testing" / "fake_provider"
TESTS_DIR = SERVICE_ROOT / "tests"


# --------------------------------------------------------------- the Dockerfile
def instructions(text: str):
    """(keyword, argument string) per instruction, joining `\\` continuations."""
    logical, buffer = [], ""
    for line in text.splitlines():
        stripped = line.strip()
        if not buffer and (not stripped or stripped.startswith("#")):
            continue
        if stripped.startswith("#"):
            continue
        if stripped.endswith("\\"):
            buffer += stripped[:-1] + " "
            continue
        logical.append(buffer + stripped)
        buffer = ""
    if buffer:
        logical.append(buffer)
    for item in logical:
        keyword, _, rest = item.partition(" ")
        yield keyword.upper(), rest.strip()


def copy_sources(text: str):
    """(sources, flags) per COPY/ADD. Raises on forms this check cannot read."""
    for keyword, rest in instructions(text):
        if keyword not in ("COPY", "ADD"):
            continue
        flags = []
        while rest.startswith("--"):
            flag, _, rest = rest.partition(" ")
            flags.append(flag.strip())
            rest = rest.strip()
        if rest.startswith("["):
            import json
            parts = json.loads(rest)
        else:
            parts = shlex.split(rest)
        if len(parts) < 2:
            raise ValueError(f"unreadable {keyword}: {rest!r}")
        if any(p.startswith("<<") for p in parts):
            raise ValueError("heredoc COPY is outside what this check reads")
        yield tuple(parts[:-1]), tuple(flags)


# --------------------------------------------------------------- .dockerignore
def _regex(pattern: str):
    out, i = "", 0
    while i < len(pattern):
        c = pattern[i]
        if pattern.startswith("**/", i):
            out += "(?:.*/)?"
            i += 3
            continue
        if pattern.startswith("**", i):
            out += ".*"
            i += 2
            continue
        if c == "*":
            out += "[^/]*"
        elif c == "?":
            out += "[^/]"
        elif c in "[]\\":
            raise ValueError(f".dockerignore pattern {pattern!r} is outside the supported subset")
        else:
            out += re.escape(c)
        i += 1
    return re.compile("^" + out + "$")


def parse_ignore(text: str):
    rules = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        negate = line.startswith("!")
        pattern = posixpath.normpath(line[1:] if negate else line).lstrip("/")
        rules.append((negate, _regex(pattern)))
    return rules


def ignored(rel: str, rules) -> bool:
    """Docker's rule: the last matching pattern decides; a parent match covers children."""
    parts = rel.split("/")
    prefixes = ["/".join(parts[: n + 1]) for n in range(len(parts))]
    verdict = False
    for negate, regex in rules:
        if any(regex.match(prefix) for prefix in prefixes):
            verdict = not negate
    return verdict


# ------------------------------------------------------------------- the check
def _within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def violations(dockerfile: str, dockerignore: str, context: Path = CONTEXT,
               fake_provider: Path = FAKE_PROVIDER, tests_dir: Path = TESTS_DIR) -> list:
    context, fake_provider, tests_dir = (Path(p).resolve() for p in (context, fake_provider, tests_dir))
    rules = parse_ignore(dockerignore)
    found = []
    stages = sum(1 for k, _ in instructions(dockerfile) if k == "FROM")
    if stages != 1:
        found.append(f"{stages} build stages; this check reads exactly one")
    for sources, flags in copy_sources(dockerfile):
        if any(f.startswith(("--from", "--link")) for f in flags):
            found.append(f"{sources}: a COPY from another stage or image is not covered by this check")
            continue
        for source in sources:
            if re.match(r"^[a-z]+://", source):
                found.append(f"{source}: a remote ADD source")
                continue
            resolved = (context / source.lstrip("/")).resolve()
            if not _within(resolved, context):
                found.append(f"{source}: resolves outside the build context ({resolved})")
                continue
            if _within(resolved, fake_provider) or _within(fake_provider, resolved):
                found.append(f"{source}: can resolve to infra/testing/fake_provider/")
            if _within(resolved, tests_dir):
                found.append(f"{source}: names services/ingestion/tests/")  # refused even if ignored
            rel = "" if resolved == context else resolved.relative_to(context).as_posix()
            if rel and ignored(rel, rules):
                continue  # the source itself is excluded, so nothing under it is sent
            for match in map(Path, glob.glob(str(resolved), recursive=True) or [str(resolved)]):
                files = [p for p in match.rglob("*") if p.is_file()] if match.is_dir() else [match]
                for file in files:
                    frel = file.resolve().relative_to(context).as_posix() if _within(file.resolve(), context) else ""
                    if frel and _within(file.resolve(), tests_dir) and not ignored(frel, rules):
                        found.append(f"{source}: copies services/ingestion/tests/ ({frel})")
                        break
    return sorted(set(found))


DOCKERFILE = (CONTEXT / "Dockerfile").read_text(encoding="utf-8")
DOCKERIGNORE = (CONTEXT / ".dockerignore").read_text(encoding="utf-8")


# --------------------------------------------------------- the shipped arrangement
def test_the_shipped_dockerfile_copies_no_test_only_path():
    assert violations(DOCKERFILE, DOCKERIGNORE) == []


def test_the_shipped_dockerfile_has_the_one_expected_copy():
    assert [s for s, _ in copy_sources(DOCKERFILE)] == [("cbdc_ingestion/",)]


def test_the_fake_provider_exists_and_is_outside_the_build_context():
    """The §7.1 scaffold, asserted on both halves.

    `not _within(...)` alone is **vacuously true for a path that does not
    exist**, so on its own it proved nothing about the deliverable. Existence is
    asserted first now, exactly as the tests directory's is below.
    """
    assert FAKE_PROVIDER.is_dir(), (
        f"the section 7.1 test-only fake provider scaffold is missing: {FAKE_PROVIDER}")
    assert (FAKE_PROVIDER / "provider.py").is_file()
    assert not _within(FAKE_PROVIDER.resolve(), CONTEXT.resolve())


# Every way the scaffold could acquire a transport. Checked against `ast` import
# nodes, never the file's text, so the prose that says "no socket, no HTTP"
# neither satisfies nor trips the check.
TRANSPORT_MODULES = frozenset({
    "socket", "ssl", "http", "urllib", "urllib3", "requests", "httpx", "aiohttp",
    "websockets", "websocket", "asyncio", "selectors", "select", "ftplib", "smtplib",
    "poplib", "imaplib", "telnetlib", "xmlrpc", "socketserver", "subprocess", "paramiko",
})
# It must couple itself neither to the component it exists to test nor to Phase 1.
FORBIDDEN_PACKAGES = frozenset({"cbdc_ingestion", "cbdc_inference", "src", "services"})


def test_the_fake_provider_keeps_a_4_unexercised_by_having_no_transport():
    """No network of any kind, so the scaffold cannot exercise A-4 as it stands."""
    modules = sorted(FAKE_PROVIDER.rglob("*.py"))
    assert modules, "no Python module in the scaffold to check"
    for path in modules:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                roots = [alias.name.split(".")[0] for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                roots = [(node.module or "").split(".")[0]] if node.level == 0 else []
            else:
                continue
            for root in roots:
                assert root not in TRANSPORT_MODULES, f"{path.name} imports {root}"
                assert root not in FORBIDDEN_PACKAGES, f"{path.name} imports {root}"
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                assert "://" not in node.value, f"{path.name} names a URL"


def test_the_transport_check_actually_catches_a_transport():
    """Both sides, so the check above cannot pass by matching nothing."""
    offending = ast.parse("import socket\n")
    roots = [a.name.split(".")[0] for n in ast.walk(offending)
             if isinstance(n, ast.Import) for a in n.names]
    assert any(r in TRANSPORT_MODULES for r in roots)
    clean = ast.parse("from dataclasses import dataclass\n")
    roots = [(n.module or "").split(".")[0] for n in ast.walk(clean)
             if isinstance(n, ast.ImportFrom)]
    assert not any(r in TRANSPORT_MODULES or r in FORBIDDEN_PACKAGES for r in roots)


# The only roots that may import the scaffold. Both are test-only and both are
# proven excluded from the image: `services/ingestion/tests/` by the
# `.dockerignore` allow-list asserted below, and `infra/` by lying outside the
# build context entirely.
IMPORT_ROOTS = (
    SERVICE_ROOT / "tests",
    REPO_ROOT / "infra" / "testing",
)
NEEDLES = ("import fake_provider", "from fake_provider", "testing.fake_provider")


def _first_party_python():
    """Every first-party Python file, excluding build and environment trees."""
    pruned = {"__pycache__", "node_modules", "venv", ".venv", "dist", "build", ".git"}
    found = []
    for root in ("services", "infra", "src", "tests"):
        base = REPO_ROOT / root
        if base.is_dir():
            found += [p for p in base.rglob("*.py") if pruned.isdisjoint(p.parts)]
    return found


def test_the_fake_provider_is_imported_only_from_declared_test_only_roots():
    """**A-4 is now exercised, so the claim changes shape — it does not weaken.**

    Through Phase 3.3-A this test asserted that *nothing* imported the scaffold,
    which was the practical meaning of "A-4 unexercised". A-4 is exercised now,
    so the suite necessarily imports it, and an assertion that nothing does
    would have to be deleted. Deleting it would lose the property it was
    protecting: that a test-only fault injector cannot become reachable from
    shipped code.

    So the property is restated **tighter** rather than dropped. The scaffold may
    be imported from two declared test-only roots and from nowhere else — in
    particular from no file under `services/ingestion/cbdc_ingestion/`, which is
    the only tree the image copies. An import from anywhere else fails here, and
    `test_the_production_package_imports_neither_the_scaffold_nor_the_bridge`
    asserts the shipped tree directly as well, so the guarantee does not rest on
    this list staying correct.
    """
    this_file = Path(__file__).resolve()
    roots = tuple(r.resolve() for r in IMPORT_ROOTS)
    offenders = []
    for path in _first_party_python():
        resolved = path.resolve()
        if resolved == this_file or _within(resolved, FAKE_PROVIDER.resolve()):
            continue  # this module names the needles; the package imports itself
        if any(_within(resolved, root) for root in roots):
            continue
        text = path.read_text(encoding="utf-8")
        for needle in NEEDLES:
            if needle in text:
                offenders.append(f"{path}: {needle}")
    assert offenders == [], (
        "the test-only fake provider is imported outside the declared test-only "
        f"roots {[str(r) for r in roots]}: {offenders}")


def test_the_production_package_imports_neither_the_scaffold_nor_the_bridge():
    """Asserted against the **shipped tree itself**, not against a root list.

    `cbdc_ingestion/` is the one directory the Dockerfile copies, so this is the
    assertion that matters for packaging: whatever the roots above say, no file
    that enters the image may name the scaffold or the A-4 bridge. Checked
    against `ast` import nodes as well as text, so a dynamic `importlib` string
    is caught by the text pass and a real import by the node pass.
    """
    package = SERVICE_ROOT / "cbdc_ingestion"
    modules = [p for p in package.rglob("*.py") if "__pycache__" not in p.parts]
    assert modules, "no shipped module to check"
    for path in modules:
        text = path.read_text(encoding="utf-8")
        for needle in NEEDLES + ("a4_demo", "import tests", "from tests"):
            assert needle not in text, f"{path} names test-only code: {needle}"
        for node in ast.walk(ast.parse(text)):
            if isinstance(node, ast.Import):
                roots = [alias.name.split(".")[0] for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                roots = [(node.module or "").split(".")[0]] if node.level == 0 else []
            else:
                continue
            for root in roots:
                assert root not in ("fake_provider", "a4_demo", "tests"), \
                    f"{path} imports {root}"


def test_a_4_is_actually_exercised_by_the_suite():
    """The other half of the change: the scaffold is no longer inert.

    A-4's catalogue drives real faults through the real pipeline, so at least one
    module under the test root must import the scaffold. Without this, the two
    tests above would also pass if the A-4 exercise were quietly removed — which
    is exactly the regression that would return the 3.3-S exit to unmet while
    the suite stayed green.
    """
    tests_root = (SERVICE_ROOT / "tests").resolve()
    importers = [p for p in tests_root.rglob("*.py")
                 if p.resolve() != Path(__file__).resolve()
                 and any(n in p.read_text(encoding="utf-8") for n in NEEDLES)]
    assert importers, "no suite drives a fault through the fake provider"


def test_the_bridge_is_outside_the_build_context_too():
    """The A-4 bridge is test-only by **location**, like the scaffold."""
    bridge = REPO_ROOT / "infra" / "testing" / "a4_demo"
    assert bridge.is_dir() and (bridge / "bridge.py").is_file()
    assert not _within(bridge.resolve(), CONTEXT.resolve())
    assert violations(DOCKERFILE, DOCKERIGNORE, fake_provider=bridge) == []


def test_the_tests_directory_is_inside_the_context_but_excluded_by_the_allow_list():
    assert TESTS_DIR.is_dir() and _within(TESTS_DIR.resolve(), CONTEXT.resolve())
    rules = parse_ignore(DOCKERIGNORE)
    assert ignored("tests", rules) and ignored("tests/test_shutdown.py", rules)
    assert not ignored("cbdc_ingestion/service.py", rules)
    assert not ignored("cbdc_ingestion/registry/sources.json", rules), "the registry must ship"


def test_the_matcher_agrees_with_the_shipped_allow_list_on_real_files():
    rules = parse_ignore(DOCKERIGNORE)
    shipped = {p.relative_to(CONTEXT).as_posix() for p in CONTEXT.rglob("*")
               if p.is_file() and "__pycache__" not in p.parts and not ignored(
                   p.relative_to(CONTEXT).as_posix(), rules)}
    assert shipped and all(s.startswith("cbdc_ingestion/") for s in shipped)
    assert not any(s.startswith("tests/") for s in shipped)


# ----------------------------------------------------------- negative controls
@pytest.mark.parametrize("copy_line,expected", [
    ("COPY tests/ /app/tests/", "tests"),
    ("COPY tests/test_shutdown.py /app/", "tests"),
    ("COPY ../../infra/testing/fake_provider/ /app/fp/", "outside the build context"),
    ("COPY ../../infra /app/infra", "outside the build context"),
    ("ADD ../../infra/testing/fake_provider /fp", "outside the build context"),
    ("COPY --from=builder /src /app", "another stage"),
    ("ADD https://example.invalid/x.tar /app/", "remote ADD"),
    ('COPY ["tests/", "/app/tests/"]', "tests"),
])
def test_a_dockerfile_that_copies_an_excluded_path_fails(copy_line, expected):
    found = violations(DOCKERFILE + "\n" + copy_line + "\n", DOCKERIGNORE)
    assert found and any(expected in v for v in found), found


def test_copying_the_whole_context_is_only_safe_because_of_the_allow_list():
    dockerfile = DOCKERFILE + "\nCOPY . /app/all/\n"
    assert violations(dockerfile, DOCKERIGNORE) == []
    permissive = "**/__pycache__\n"
    assert any("tests" in v for v in violations(dockerfile, permissive))


def test_dropping_the_allow_list_alone_does_not_hide_a_named_tests_copy():
    assert violations(DOCKERFILE + "\nCOPY tests/ /t/\n", "") != []


def test_a_second_build_stage_is_refused():
    assert any("build stages" in v for v in
               violations(DOCKERFILE + "\nFROM scratch\nCOPY --from=0 /app /app\n", DOCKERIGNORE))


def test_a_pattern_outside_the_supported_subset_raises_rather_than_guessing():
    with pytest.raises(ValueError):
        parse_ignore("[ab]*\n")


def test_a_fake_provider_inside_a_widened_context_is_caught():
    """If the context ever grew to cover infra/, a COPY of it must still fail."""
    found = violations("FROM x\nCOPY infra/ /app/infra/\n", "", context=REPO_ROOT)
    assert any("fake_provider" in v for v in found)
