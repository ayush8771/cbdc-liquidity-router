"""State specifications (API contract §2.4): parsing from JSON-like dicts and
corridor-independent validation of explicit values. Pure Python: no Phase 1,
no FastAPI, so the API layer can use it too.

Corridor-dependent checks (venue set, frame building) are in worker.py.
"""
from __future__ import annotations

import math
from typing import Any

from .errors import InvalidStateValue, ValidationFailed
from .types import ExplicitHistory, ExplicitState, ExplicitVenue, ReplayState, ScenarioState

HISTORY_DAYS = 30
LAST_VALUE_REL_TOL = 1e-9

_ALLOWED = {
    "historical_replay": {"mode", "date"},
    "scenario": {"mode", "date", "scenario_id"},
    "explicit": {"mode", "reference_date", "venues"},
}
_VENUE_KEYS = {"bridge_uid", "liquidity_usd", "congestion", "history"}
_HISTORY_KEYS = {"liquidity_usd", "congestion"}
# Named so the error says why, rather than just "unknown field" (§2.4: these can't be set).
_NOT_SETTABLE = {"fee", "fee_pct", "risk", "corridor_risk", "baseline_cost_pct", "data_source_tag"}


def _reject_unknown(obj: dict, allowed: set, path: str) -> None:
    for key in obj:
        if key not in allowed:
            if key in _NOT_SETTABLE:
                msg = f"Unknown field; {key} cannot be set in explicit mode."
            else:
                msg = "Unknown field."
            raise ValidationFailed(msg, {"field": f"{path}.{key}"})


def _require(obj: dict, key: str, path: str) -> Any:
    if key not in obj:
        raise ValidationFailed("Field required.", {"field": f"{path}.{key}"})
    return obj[key]


def _string(value, path: str) -> str:
    if not isinstance(value, str):
        raise ValidationFailed("Must be a string.", {"field": path})
    return value


def state_from_dict(raw: Any, path: str = "state"):
    """Builds a StateSpec dataclass. Unknown fields anywhere inside `state` are rejected
    with VALIDATION_ERROR (§2.4), so a caller can't believe it set a value with no effect."""
    if not isinstance(raw, dict):
        raise ValidationFailed("state must be an object.", {"field": path})
    mode = _require(raw, "mode", path)
    if mode not in _ALLOWED:
        raise ValidationFailed("mode must be historical_replay, scenario or explicit.", {"field": f"{path}.mode"})
    _reject_unknown(raw, _ALLOWED[mode], path)
    if mode == "historical_replay":
        return ReplayState(_string(_require(raw, "date", path), f"{path}.date"))
    if mode == "scenario":
        return ScenarioState(_string(_require(raw, "date", path), f"{path}.date"),
                             _string(_require(raw, "scenario_id", path), f"{path}.scenario_id"))
    venues = _require(raw, "venues", path)
    if not isinstance(venues, list):
        raise ValidationFailed("venues must be a list.", {"field": f"{path}.venues"})
    parsed = []
    for i, v in enumerate(venues):
        vpath = f"{path}.venues[{i}]"
        if not isinstance(v, dict):
            raise ValidationFailed("Each venue must be an object.", {"field": vpath})
        _reject_unknown(v, _VENUE_KEYS, vpath)
        history = v.get("history")
        if history is not None:
            if not isinstance(history, dict):
                raise ValidationFailed("history must be an object or null.", {"field": f"{vpath}.history"})
            _reject_unknown(history, _HISTORY_KEYS, f"{vpath}.history")
            for ch in ("liquidity_usd", "congestion"):
                if not isinstance(_require(history, ch, f"{vpath}.history"), list):
                    raise ValidationFailed("Must be a list of numbers.", {"field": f"{vpath}.history.{ch}"})
            history = ExplicitHistory(tuple(history["liquidity_usd"]), tuple(history["congestion"]))
        parsed.append(ExplicitVenue(_string(_require(v, "bridge_uid", vpath), f"{vpath}.bridge_uid"),
                                    _require(v, "liquidity_usd", vpath), _require(v, "congestion", vpath), history))
    return ExplicitState(_string(_require(raw, "reference_date", path), f"{path}.reference_date"), tuple(parsed))


def _number(value, path: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValidationFailed("Must be a number.", {"field": path})
    value = float(value)
    if not math.isfinite(value) or value < 0:
        raise InvalidStateValue("Must be finite and >= 0.", {"field": path})
    return value


def validate_explicit_values(state: ExplicitState, path: str = "state") -> ExplicitState:
    """Value rules of §2.4 that don't depend on the corridor. Returns a normalised copy
    (all numbers as floats)."""
    out = []
    for i, v in enumerate(state.venues):
        vpath = f"{path}.venues[{i}]"
        liq = _number(v.liquidity_usd, f"{vpath}.liquidity_usd")
        cong = _number(v.congestion, f"{vpath}.congestion")
        history = None
        if v.history is not None:
            channels = {}
            for ch, current in (("liquidity_usd", liq), ("congestion", cong)):
                hpath = f"{vpath}.history.{ch}"
                values = getattr(v.history, ch)
                if not isinstance(values, (list, tuple)):
                    raise ValidationFailed("Must be a list of numbers.", {"field": hpath})
                if len(values) != HISTORY_DAYS:
                    raise InvalidStateValue(f"history needs exactly {HISTORY_DAYS} values, oldest first; got {len(values)}.",
                                            {"field": hpath})
                nums = tuple(_number(x, f"{hpath}[{j}]") for j, x in enumerate(values))
                last = nums[-1]
                if abs(last - current) > LAST_VALUE_REL_TOL * max(abs(last), abs(current)):
                    raise InvalidStateValue("The last history value must equal the current value.", {"field": hpath})
                channels[ch] = nums
            history = ExplicitHistory(channels["liquidity_usd"], channels["congestion"])
        out.append(ExplicitVenue(v.bridge_uid, liq, cong, history))
    return ExplicitState(state.reference_date, tuple(out))
