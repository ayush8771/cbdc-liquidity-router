"""The root .nvmrc must satisfy the backend's package.json engines.node range."""
import json
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
PKG = REPO / "services" / "backend" / "package.json"


def ver(s):
    return tuple(int(x) for x in s.split("."))


def satisfies(version, rng):
    # Supports only space-separated comparators (>=, >, <=, <, =) as used in engines; fails loudly otherwise.
    for op, v in re.findall(r"(>=|<=|>|<|=)?\s*(\d+(?:\.\d+){0,2})", rng):
        v = ver(v + ".0" * (2 - v.count(".")))
        ok = {">=": version >= v, ">": version > v, "<=": version <= v, "<": version < v}.get(op, version == v)
        if not ok:
            return False
    return True


def test_satisfies_helper():
    assert satisfies((20, 20, 2), ">=20.6.0 <21")
    assert not satisfies((20, 5, 0), ">=20.6.0 <21")
    assert not satisfies((21, 0, 0), ">=20.6.0 <21")


@pytest.mark.skipif(not PKG.exists(), reason="services/backend/package.json is not on this branch yet")
def test_nvmrc_satisfies_backend_engines():
    nvmrc = (REPO / ".nvmrc").read_text(encoding="utf-8").strip().lstrip("v")
    assert re.fullmatch(r"\d+\.\d+\.\d+", nvmrc), f".nvmrc must be an exact version, got {nvmrc!r}"
    rng = json.loads(PKG.read_text(encoding="utf-8"))["engines"]["node"]
    assert satisfies(ver(nvmrc), rng), f".nvmrc {nvmrc} outside backend engines.node {rng!r}"
