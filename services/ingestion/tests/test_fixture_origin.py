"""Acceptance criterion 9: fixture provenance (authorization §6.2, AD-12 §3.4).

Every fixture **this scope adds** carries an origin record. The check owns only
`services/ingestion/tests/fixtures/` and `contracts/events/registry/fixtures/`;
it **skips** every other path, and a test asserts that it skips them rather than
passing them silently. That matters most for `contracts/events/fixtures/` and
`contracts/test-vectors/` (the T-7 protected hash vectors), which are never
touched, re-labelled or moved.

Format: a sibling `<name>.origin.json`, or a per-directory `_origin.json`
manifest, holding exactly `origin`, `created`, an optional `note` and, **only
when `origin` is `synthetic`**, `seed`, `generator_version` and `case_id`.
`origin` is `synthetic` or `hand-written` and nothing else, so a fixture
recorded from a provider has no legal value to declare.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from .conftest import CONTRACTS, SERVICE_ROOT

OWNED_ROOTS = (SERVICE_ROOT / "tests" / "fixtures", CONTRACTS / "events" / "registry" / "fixtures")
NOT_OWNED = (CONTRACTS / "events" / "fixtures", CONTRACTS / "test-vectors")
MANIFEST = "_origin.json"
SYNTHETIC_FIELDS = {"seed", "generator_version", "case_id"}
COMMON = {"origin", "created", "note"}
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

SKIPPED = "skipped"


def owned(path: Path, roots=OWNED_ROOTS) -> bool:
    resolved = path.resolve()
    return any(root.resolve() in resolved.parents for root in roots)


def is_record(path: Path) -> bool:
    return path.name == MANIFEST or path.name.endswith(".origin.json")


def record_for(fixture: Path):
    sibling = fixture.with_name(fixture.stem + ".origin.json")
    for candidate in (sibling, fixture.with_name(MANIFEST)):
        if candidate.is_file():
            return candidate
    return None


def record_problems(raw) -> list:
    if not isinstance(raw, dict):
        return ["the origin record is not an object"]
    problems = []
    origin = raw.get("origin")
    if origin not in ("synthetic", "hand-written"):
        return [f"origin {origin!r} is not 'synthetic' or 'hand-written'"]
    required = COMMON - {"note"}
    allowed = set(COMMON)
    if origin == "synthetic":
        required |= SYNTHETIC_FIELDS
        allowed |= SYNTHETIC_FIELDS
    for name in sorted(required - raw.keys()):
        problems.append(f"missing field {name!r} for origin {origin!r}")
    for name in sorted(raw.keys() - allowed):
        problems.append(f"field {name!r} is not allowed for origin {origin!r}")
    if origin == "synthetic":
        if not isinstance(raw.get("seed"), int) or isinstance(raw.get("seed"), bool):
            problems.append("seed must be an integer")
        for name in ("generator_version", "case_id"):
            if name in raw and (not isinstance(raw[name], str) or not raw[name]):
                problems.append(f"{name} must be a non-empty string")
    if "created" in raw and not (isinstance(raw["created"], str) and DATE.match(raw["created"])):
        problems.append("created must be a YYYY-MM-DD date")
    if "note" in raw and not isinstance(raw["note"], str):
        problems.append("note must be a string")
    return problems


def check(fixture: Path, roots=OWNED_ROOTS):
    """`SKIPPED` for a path the check does not own, else the list of problems."""
    if not owned(fixture, roots):
        return SKIPPED
    record = record_for(fixture)
    if record is None:
        return ["no origin record"]
    try:
        raw = json.loads(record.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ["the origin record is unreadable or not JSON"]
    return record_problems(raw)


def scan(roots=OWNED_ROOTS) -> dict:
    found = {}
    for root in roots:
        if root.is_dir():
            for path in sorted(root.rglob("*")):
                if path.is_file() and not is_record(path):
                    found[path] = check(path, roots)
    return found


def synthetic(**over) -> dict:
    record = {"origin": "synthetic", "seed": 20261127, "generator_version": "0.1.0",
              "case_id": "normal", "created": "2026-11-27"}
    record.update(over)
    return record


def write(directory: Path, name: str, record, *, manifest: bool = False) -> Path:
    fixture = directory / name
    fixture.write_text("{}", encoding="utf-8")
    if record is not None:
        target = directory / (MANIFEST if manifest else fixture.stem + ".origin.json")
        target.write_text(json.dumps(record), encoding="utf-8")
    return fixture


# ------------------------------------------------------------ the shipped fixtures
def test_every_fixture_this_scope_adds_has_a_valid_origin_record():
    found = scan()
    assert found, "the check must see at least the fixtures this scope adds"
    assert {p: r for p, r in found.items() if r} == {}


def test_the_shipped_determinism_fixture_is_covered_and_synthetic():
    fixture = SERVICE_ROOT / "tests" / "fixtures" / "adapter_determinism.v1.json"
    assert scan().get(fixture) == []
    assert json.loads(record_for(fixture).read_text(encoding="utf-8"))["origin"] == "synthetic"


# ------------------------------------------------------------------ both sides
@pytest.fixture
def roots(tmp_path):
    root = tmp_path / "fixtures"
    root.mkdir()
    return (root,)


def test_a_synthetic_record_and_a_hand_written_record_both_pass(roots):
    root = roots[0]
    assert check(write(root, "a.json", synthetic()), roots) == []
    assert check(write(root, "b.json", {"origin": "hand-written", "created": "2026-11-27"}), roots) == []


def test_a_directory_manifest_covers_its_fixtures(roots):
    root = roots[0]
    assert check(write(root, "m.json", synthetic(), manifest=True), roots) == []


def test_a_missing_record_fails(roots):
    assert check(write(roots[0], "none.json", None), roots) == ["no origin record"]


@pytest.mark.parametrize("origin", ["recorded", "provider", "live", "real", "Synthetic", "", None, 1])
def test_an_unknown_origin_fails(roots, origin):
    assert check(write(roots[0], "x.json", synthetic(origin=origin)), roots)


@pytest.mark.parametrize("missing", sorted(SYNTHETIC_FIELDS))
def test_a_synthetic_record_missing_a_required_field_fails(roots, missing):
    record = synthetic()
    del record[missing]
    problems = check(write(roots[0], "x.json", record), roots)
    assert any(missing in p for p in problems)


@pytest.mark.parametrize("extra", sorted(SYNTHETIC_FIELDS))
def test_a_hand_written_record_carrying_a_synthetic_field_fails(roots, extra):
    record = {"origin": "hand-written", "created": "2026-11-27", extra: 1 if extra == "seed" else "x"}
    problems = check(write(roots[0], "x.json", record), roots)
    assert any(extra in p for p in problems)


def test_an_unknown_field_and_a_malformed_value_fail(roots):
    root = roots[0]
    assert check(write(root, "a.json", synthetic(provider="x")), roots)
    assert check(write(root, "b.json", synthetic(seed="20261127")), roots)
    assert check(write(root, "c.json", synthetic(seed=True)), roots)
    assert check(write(root, "d.json", synthetic(created="27/11/2026")), roots)
    assert check(write(root, "e.json", synthetic(case_id="")), roots)


def test_an_unreadable_record_fails(roots):
    fixture = write(roots[0], "x.json", None)
    (roots[0] / "x.origin.json").write_text("not json", encoding="utf-8")
    assert check(fixture, roots)


# --------------------------------------------- paths it does not own are skipped
def test_the_protected_corpora_exist_and_carry_no_origin_records():
    for root in NOT_OWNED:
        files = [p for p in root.rglob("*") if p.is_file()]
        assert files, f"{root} should hold fixtures for this assertion to mean anything"
        assert not any(is_record(p) for p in files), "existing fixtures are never re-labelled"


@pytest.mark.parametrize("root", NOT_OWNED, ids=lambda p: p.name)
def test_a_path_the_check_does_not_own_is_skipped_not_passed(root):
    for path in (p for p in root.rglob("*") if p.is_file()):
        assert check(path) == SKIPPED, f"{path} must be skipped, not silently passed"
    assert not set(scan()) & {p for p in root.rglob("*")}


def test_the_hash_vectors_are_not_owned_by_the_check():
    vectors = CONTRACTS / "test-vectors" / "event_payload_hash.v1.json"
    assert vectors.is_file() and check(vectors) == SKIPPED
    assert not (vectors.with_name(vectors.stem + ".origin.json")).exists()
