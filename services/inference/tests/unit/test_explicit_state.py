"""Explicit synthetic states (contract §2.4, arch §9.1): parsing, validation, routing semantics, isolation."""
import math

import pytest

from cbdc_inference.engine import (ExplicitHistory, ExplicitState, ExplicitVenue, ReplayState, Transaction,
                                   state_from_dict)
from cbdc_inference.engine import errors as E

DATE = "2024-06-14"
GBR_PHL = ("GBR->PHL#0", "GBR->PHL#1", "GBR->PHL#2")
TX = Transaction("GBR", "PHL", 300000.0)


def _replay_venues(worker, date=DATE, uids=GBR_PHL, with_history=False):
    """The replay values for a date, as an explicit state would supply them."""
    view = worker.state_view("->".join(uids[0].split("#")[0].split("->")), ReplayState(date),
                             include_history=with_history)
    out = []
    for v in view["venues"]:
        h = None
        if with_history:
            h = ExplicitHistory(tuple(v["history"]["liquidity_usd"]), tuple(v["history"]["congestion"]))
        out.append(ExplicitVenue(v["bridge_uid"], v["liquidity_usd"], v["congestion"], h))
    return out


# ------------------------------------------------------------------ parsing (unknown fields, types)
def _explicit_dict(**venue_extra):
    venues = [{"bridge_uid": u, "liquidity_usd": 100000.0, "congestion": 0.3, "history": None} for u in GBR_PHL]
    venues[0].update(venue_extra)
    return {"mode": "explicit", "reference_date": DATE, "venues": venues}


def test_parse_all_modes():
    assert state_from_dict({"mode": "historical_replay", "date": DATE}) == ReplayState(DATE)
    s = state_from_dict(_explicit_dict())
    assert isinstance(s, ExplicitState) and s.mode == "explicit" and len(s.venues) == 3
    assert s.venues[0].history is None


@pytest.mark.parametrize("key", ["risk", "fee", "fee_pct", "baseline_cost_pct", "data_source_tag", "colour"])
def test_venue_fields_that_cannot_be_set_are_rejected(key):
    with pytest.raises(E.ValidationFailed) as ei:
        state_from_dict(_explicit_dict(**{key: 0.1}))
    assert ei.value.code == "VALIDATION_ERROR" and ei.value.details == {"field": f"state.venues[0].{key}"}


@pytest.mark.parametrize("raw,field", [
    ({"mode": "explicit", "reference_date": DATE, "venues": [], "scenario_id": "baseline"}, "state.scenario_id"),
    ({"mode": "historical_replay", "date": DATE, "venues": []}, "state.venues"),
    ({"mode": "explicit", "venues": []}, "state.reference_date"),
    ({"mode": "explicit", "reference_date": DATE}, "state.venues"),
    ({"mode": "explicit", "reference_date": DATE, "venues": {}}, "state.venues"),
    ({"mode": "live", "date": DATE}, "state.mode"),
    ({"date": DATE}, "state.mode"),
])
def test_state_shape_errors(raw, field):
    with pytest.raises(E.ValidationFailed) as ei:
        state_from_dict(raw)
    assert ei.value.details["field"] == field


def test_history_unknown_key_rejected():
    raw = _explicit_dict(history={"liquidity_usd": [1.0] * 30, "congestion": [0.1] * 30, "risk": [0.0] * 30})
    with pytest.raises(E.ValidationFailed) as ei:
        state_from_dict(raw)
    assert ei.value.details == {"field": "state.venues[0].history.risk"}


def test_no_risk_field_exists_on_the_dataclass():
    with pytest.raises(TypeError):
        ExplicitVenue("GBR->PHL#0", 1.0, 0.1, None, risk=0.5)  # noqa


# ------------------------------------------------------------------ value validation (§2.4)
def _state(worker, **override):
    venues = _replay_venues(worker)
    venues[1] = ExplicitVenue(venues[1].bridge_uid, override.get("liq", venues[1].liquidity_usd),
                              override.get("cong", venues[1].congestion), override.get("history"))
    return ExplicitState(DATE, tuple(venues))


@pytest.mark.parametrize("override,exc", [
    ({"liq": -1.0}, E.InvalidStateValue), ({"liq": math.nan}, E.InvalidStateValue),
    ({"liq": math.inf}, E.InvalidStateValue), ({"cong": -0.01}, E.InvalidStateValue),
    ({"cong": math.nan}, E.InvalidStateValue), ({"liq": "1000"}, E.ValidationFailed),
    ({"liq": True}, E.ValidationFailed),
])
def test_current_value_rules(worker, override, exc):
    with pytest.raises(exc) as ei:
        worker.route(TX, _state(worker, **override))
    assert ei.value.details["field"].startswith("state.venues[1].")


@pytest.mark.parametrize("liq_hist,cong_hist", [
    ([100.0] * 29 + [999.0], [0.1] * 29 + [0.1]),     # last != current
    ([100.0] * 30, [0.1] * 29 + [0.2]),
    ([-1.0] + [100.0] * 29, [0.1] * 30),              # negative inside history
    ([math.nan] + [100.0] * 29, [0.1] * 30),
])
def test_history_value_rules(worker, liq_hist, cong_hist):
    """The VALUE rules return INVALID_STATE_VALUE (§2.4)."""
    state = _state(worker, liq=100.0, cong=0.1, history=ExplicitHistory(tuple(liq_hist), tuple(cong_hist)))
    with pytest.raises(E.InvalidStateValue) as ei:
        worker.route(TX, state)
    assert ei.value.details["field"].startswith("state.venues[1].history.")


@pytest.mark.parametrize("liq_hist,cong_hist", [
    ([100.0] * 29, [0.1] * 29),
    ([100.0] * 31, [0.1] * 31),
])
def test_history_wrong_length_is_a_validation_error(worker, liq_hist, cong_hist):
    """A wrong LENGTH is a schema rule (minItems/maxItems 30), so it is VALIDATION_ERROR, not
    INVALID_STATE_VALUE (§2.4, owner decision)."""
    state = _state(worker, liq=100.0, cong=0.1, history=ExplicitHistory(tuple(liq_hist), tuple(cong_hist)))
    with pytest.raises(E.ValidationFailed) as ei:
        worker.route(TX, state)
    assert ei.value.code == "VALIDATION_ERROR"
    assert ei.value.details["field"].startswith("state.venues[1].history.")


def test_last_value_tolerance_is_relative_1e9(worker):
    ok = ExplicitHistory(tuple([100.0] * 29 + [100.0 * (1 + 5e-10)]), tuple([0.1] * 30))
    worker.route(TX, _state(worker, liq=100.0, cong=0.1, history=ok))  # within 1e-9 relative
    bad = ExplicitHistory(tuple([100.0] * 29 + [100.0 * (1 + 5e-9)]), tuple([0.1] * 30))
    with pytest.raises(E.InvalidStateValue):
        worker.route(TX, _state(worker, liq=100.0, cong=0.1, history=bad))


@pytest.mark.parametrize("uids", [GBR_PHL[:2], GBR_PHL + ("GBR->PHL#3",), (GBR_PHL[0], GBR_PHL[0], GBR_PHL[2]),
                                  ("USA->IND#0", "USA->IND#1", "USA->IND#2")])
def test_venue_set_must_match_corridor_exactly(worker, uids):
    venues = tuple(ExplicitVenue(u, 1000.0, 0.1) for u in uids)
    with pytest.raises(E.StateVenueMismatch) as ei:
        worker.route(TX, ExplicitState(DATE, venues))
    assert ei.value.code == "STATE_VENUE_MISMATCH" and ei.value.http_status == 422


def test_venue_order_does_not_matter(worker):
    venues = _replay_venues(worker)
    a = worker.route(TX, ExplicitState(DATE, tuple(venues)))
    b = worker.route(TX, ExplicitState(DATE, tuple(reversed(venues))))
    assert a == b


@pytest.mark.parametrize("date,exc", [("2025-10-01", E.DateOutOfRange), ("2022-01-10", E.DateInGapBuffer),
                                      ("2024/06/14", E.ValidationFailed)])
def test_reference_date_rules(worker, date, exc):
    with pytest.raises(exc) as ei:
        worker.route(TX, ExplicitState(date, tuple(_replay_venues(worker))))
    assert ei.value.details["field"] == "state.reference_date"


# ------------------------------------------------------------------ routing semantics
@pytest.mark.parametrize("policy", ["waterfall", "cheapest_feasible"])
@pytest.mark.parametrize("amount", [1000.0, 150000.0, 300000.0, 700000.0])
def test_explicit_equal_to_replay_gives_identical_results(worker, policy, amount):
    """Contract §9: an explicit state equal to the replay values gives results identical to replay."""
    tx = Transaction("GBR", "PHL", amount)
    replay = worker.route(tx, ReplayState(DATE), policy)
    explicit = worker.route(tx, ExplicitState(DATE, tuple(_replay_venues(worker))), policy)
    assert explicit.state_frame_sha256 == replay.daily_state_sha256  # same values -> same fingerprint
    # `decision_id` identifies the decision's INPUTS, not its outputs (§2.11), and an explicit
    # state is a different input from a replay state even when its values coincide, so the two
    # IDs differ by design while every routing output is identical.
    differ = {"state_mode", "values_provenance", "decision_id"}
    for name in replay.__dataclass_fields__:
        if name not in differ:
            assert getattr(explicit, name) == getattr(replay, name), name
    assert (explicit.state_mode, explicit.values_provenance) == ("explicit", "user_supplied_synthetic")
    assert explicit.scenario_id is None and explicit.state_date == DATE
    assert explicit.decision_id != replay.decision_id


def test_explicit_with_full_history_equal_to_replay_is_identical(worker):
    replay = worker.route(TX, ReplayState(DATE))
    explicit = worker.route(TX, ExplicitState(DATE, tuple(_replay_venues(worker, with_history=True))))
    assert explicit.state_frame_sha256 == replay.daily_state_sha256
    assert explicit.allocations == replay.allocations and explicit.reward_env == replay.reward_env


def test_overriding_one_venue_changes_only_that_venue(worker):
    venues = _replay_venues(worker)
    base = worker.route(TX, ExplicitState(DATE, tuple(venues)))
    venues[1] = ExplicitVenue(venues[1].bridge_uid, 5000.0, 0.9)  # the fee-cheapest venue, nearly empty
    changed = worker.route(TX, ExplicitState(DATE, tuple(venues)))
    b, c = {a.slot: a for a in base.allocations}, {a.slot: a for a in changed.allocations}
    assert (c[1].liquidity_usd, c[1].congestion) == (5000.0, 0.9)
    for slot in (0, 2):
        assert (c[slot].liquidity_usd, c[slot].congestion, c[slot].fee_pct) == \
            (b[slot].liquidity_usd, b[slot].congestion, b[slot].fee_pct)
    assert c[1].amount_executed_usd == 5000.0
    assert changed.state_frame_sha256 != base.state_frame_sha256


def test_fees_venues_risk_and_cost_come_from_phase1(worker, p1):
    venues = [ExplicitVenue(u, 50000.0 * (i + 1), 0.2 * (i + 1)) for i, u in enumerate(GBR_PHL)]
    r = worker.route(TX, ExplicitState(DATE, tuple(venues)))
    net = {v["bridge_uid"]: v for v in worker.network()["corridors"][1]["venues"]}
    for a in r.allocations:
        assert (a.fee_pct, a.data_source_tag, a.slot) == \
            (net[a.bridge_uid]["fee_pct"], net[a.bridge_uid]["data_source_tag"], net[a.bridge_uid]["slot"])
    replay = worker.route(TX, ReplayState(DATE))
    assert {a.risk for a in r.allocations} == {a.risk for a in replay.allocations}  # risk at reference_date
    assert r.baseline_cost_pct == replay.baseline_cost_pct == \
        p1.cost_baseline.lagged_real_cost_baseline_pct("GBR", "PHL", DATE)
    assert r.split == "test"


def test_risk_and_cost_follow_the_reference_date(worker, p1):
    train_date = "2016-07-07"  # a month where the Phase 1 risk proxy exists
    venues = [ExplicitVenue(u, 100000.0, 0.3) for u in GBR_PHL]
    r = worker.route(TX, ExplicitState(train_date, tuple(venues)))
    assert {a.risk for a in r.allocations} == {p1.risk_proxy.corridor_risk_proxy("GBR", "PHL", train_date)}
    assert r.baseline_cost_pct == p1.cost_baseline.lagged_real_cost_baseline_pct("GBR", "PHL", train_date)
    assert r.split == "train"


def test_regime_reflects_supplied_liquidity(worker):
    def venues(liqs):
        return tuple(ExplicitVenue(u, l, 0.2) for u, l in zip(GBR_PHL, liqs))
    tx = Transaction("GBR", "PHL", 200000.0)
    # GBR->PHL#1 is fee-cheapest
    assert worker.route(tx, ExplicitState(DATE, venues([100000.0, 400000.0, 100000.0]))).regime == "below_cheapest"
    assert worker.route(tx, ExplicitState(DATE, venues([50000.0, 50000.0, 50000.0]))).regime == "exceeds_combined"
    assert worker.route(tx, ExplicitState(DATE, venues([300000.0, 100000.0, 50000.0]))).regime == "splitting_needed"
    assert worker.route(tx, ExplicitState(DATE, venues([300000.0, 190000.0, 50000.0]))).regime == "near_boundary"


def test_baselines_do_not_need_history(worker):
    venues = [ExplicitVenue(u, 100000.0, 0.3) for u in GBR_PHL]
    for policy in ("waterfall", "cheapest_feasible"):
        r = worker.route(TX, ExplicitState(DATE, tuple(venues)), policy)
        assert r.allowed and r.executed_usd > 0


def test_regulatory_rejection_in_explicit_mode(worker):
    r = worker.route(Transaction("GBR", "PHL", 600000.0), ExplicitState(DATE, tuple(_replay_venues(worker))))
    assert r.allowed is False and r.allocations == () and r.values_provenance == "user_supplied_synthetic"


# ------------------------------------------------------------------ ppo_projected and explicit states
def test_ppo_disabled_takes_precedence_today(worker):
    with pytest.raises(E.PolicyDisabled):
        worker.route(TX, ExplicitState(DATE, tuple(_replay_venues(worker))), "ppo_projected")


def test_ppo_needs_history_on_every_venue(worker, monkeypatch):
    """The state rule is checked before any attempt to load weights (§2.4)."""
    monkeypatch.setattr(worker, "ppo_enabled", True)
    partial = _replay_venues(worker, with_history=True)
    partial[2] = ExplicitVenue(partial[2].bridge_uid, partial[2].liquidity_usd, partial[2].congestion, None)
    with pytest.raises(E.PolicyUnavailableForState) as ei:
        worker.route(TX, ExplicitState(DATE, tuple(partial)), "ppo_projected")
    assert (ei.value.code, ei.value.http_status) == ("POLICY_UNAVAILABLE_FOR_STATE", 422)
    # Full history passes the state rule, so the request reaches the checkpoint gate. No
    # checkpoint is approved in this repository, so loading fails closed with POLICY_DISABLED
    # rather than serving unverified weights (§7).
    with pytest.raises(E.PolicyDisabled, match="no approved checkpoint"):
        worker.route(TX, ExplicitState(DATE, tuple(_replay_venues(worker, with_history=True))), "ppo_projected")


# ------------------------------------------------------------------ isolation
def test_explicit_state_never_touches_shared_state(worker, p1):
    before = worker.daily_state_sha256
    venues = [ExplicitVenue(u, 1.0, 5.0, ExplicitHistory(tuple([1.0] * 30), tuple([5.0] * 30))) for u in GBR_PHL]
    worker.route(TX, ExplicitState(DATE, tuple(venues)))
    assert p1.dbs._daily_df_cache[p1.dbs.DAILY_PARQUET_PATH] is worker.baseline_frame
    worker.check_integrity()
    assert worker.daily_state_sha256 == before
    replay = worker.route(TX, ReplayState(DATE))
    assert replay.allocations[1].liquidity_usd != 1.0  # replay unaffected afterwards


def test_history_overrides_exactly_30_days(worker):
    """The window written is reference_date-29 .. reference_date; the day before is untouched."""
    venues = [ExplicitVenue(u, 7.0, 0.7, ExplicitHistory(tuple([7.0] * 30), tuple([0.7] * 30))) for u in GBR_PHL]
    state = ExplicitState(DATE, tuple(venues))
    frame = worker._explicit_frame(state)
    sub = frame[frame["bridge_id"] == "GBR->PHL#1"].set_index("date")
    import pandas as pd
    ref = pd.Timestamp(DATE)
    assert (sub.loc[ref - pd.Timedelta(days=29):ref, "liquidity_level"] == 7.0).all()
    assert sub.loc[ref - pd.Timedelta(days=30), "liquidity_level"] != 7.0
    assert sub.loc[ref + pd.Timedelta(days=1), "liquidity_level"] != 7.0
    assert frame is not worker.baseline_frame


def test_without_history_only_reference_date_changes(worker):
    venues = [ExplicitVenue(u, 7.0, 0.7) for u in GBR_PHL]
    frame = worker._explicit_frame(ExplicitState(DATE, tuple(venues)))
    diff = (frame["liquidity_level"] != worker.baseline_frame["liquidity_level"]) | \
           (frame["congestion_level"] != worker.baseline_frame["congestion_level"])
    changed = frame[diff]
    assert sorted(changed["bridge_id"]) == ["GBR->PHL", "GBR->PHL#1", "GBR->PHL#2"]
    assert set(changed["date"].dt.date.astype(str)) == {DATE}
