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
    comp = r"(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})"
    if not re.fullmatch(rf"\s*{comp}(\s+{comp})*\s*", rng):
        raise ValueError(f"unsupported engines.node syntax: {rng!r}")
    for op, v in re.findall(comp, rng):
        v = ver(v + ".0" * (2 - v.count(".")))
        ok = {">=": version >= v, ">": version > v, "<=": version <= v, "<": version < v}.get(op, version == v)
        if not ok:
            return False
    return True


def test_satisfies_helper():
    assert satisfies((20, 20, 2), ">=20.6.0 <21")
    assert not satisfies((20, 5, 0), ">=20.6.0 <21")
    assert not satisfies((21, 0, 0), ">=20.6.0 <21")


@pytest.mark.parametrize("rng", ["^20.6.0", ">=20 || >=22", "20.x", ">=20.6.0 <21 junk", "~20.6.0", ">= 20.6.0", ""])
def test_unsupported_range_fails(rng):
    with pytest.raises(ValueError):
        satisfies((20, 20, 2), rng)


@pytest.mark.skipif(not PKG.exists(), reason="services/backend/package.json is not on this branch yet")
def test_nvmrc_satisfies_backend_engines():
    nvmrc = (REPO / ".nvmrc").read_text(encoding="utf-8").strip().lstrip("v")
    assert re.fullmatch(r"\d+\.\d+\.\d+", nvmrc), f".nvmrc must be an exact version, got {nvmrc!r}"
    rng = json.loads(PKG.read_text(encoding="utf-8"))["engines"]["node"]
    assert satisfies(ver(nvmrc), rng), f".nvmrc {nvmrc} outside backend engines.node {rng!r}"
