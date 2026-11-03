"""Engine-side network / state / calendar / scenarios, checked against Phase 1 sources directly."""
import csv
import importlib
from pathlib import Path

import pytest

from cbdc_inference.engine import ReplayState, ScenarioState
from cbdc_inference.engine import errors as E

REPO_ROOT = Path(__file__).resolve().parents[4]
DATE = "2024-06-14"


def _csv_rows():
    with open(REPO_ROOT / "data/structured/bridge_network.csv", newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


# ------------------------------------------------------------------ network
def test_network_is_bridge_network_csv_unmodified(worker):
    net = worker.network()
    rows = _csv_rows()
    assert [c["corridor"] for c in net["corridors"]] == ["USA->IND", "GBR->PHL", "ARE->MEX"]
    for c in net["corridors"]:
        csv_venues = [r for r in rows if (r["source_node"], r["target_node"]) == (c["sender_country"],
                                                                                    c["receiver_country"])]
        assert c["corridor"] == f"{c['sender_country']}->{c['receiver_country']}"
        assert [v["slot"] for v in c["venues"]] == list(range(len(csv_venues)))
        for v, r in zip(c["venues"], csv_venues):  # slot order = CSV order (as the env's mask uses it)
            assert v == {"slot": v["slot"], "bridge_uid": r["bridge_uid"], "fee_pct": float(r["latency_fee_pct"]),
                         "baseline_capacity_usd": float(r["liquidity_capacity"]),
                         "data_source_tag": r["data_source_tag"]}
    assert sum(len(c["venues"]) for c in net["corridors"]) == len(rows)
    are_mex0 = net["corridors"][2]["venues"][0]
    assert are_mex0["data_source_tag"] == "synthetic_no_real_anchor"  # passed through, not relabelled


def test_network_cap_comes_from_knowledge_base(worker):
    net = worker.network()
    assert net["max_single_transfer_usd"] == 500000.0
    assert net["max_single_transfer_provenance"] == "project_assumption"


# ------------------------------------------------------------------ state
def test_replay_state_equals_phase1_lookups(worker, p1):
    v = worker.state_view("GBR->PHL", ReplayState(DATE))
    assert v["state"] == {"mode": "historical_replay", "date": DATE, "split": "test", "scenario_id": None}
    assert v["corridor"] == "GBR->PHL"
    # Phase 1's proxy is NaN for every validation/test month; the env then uses the static placeholder.
    proxy = p1.risk_proxy.corridor_risk_proxy("GBR", "PHL", DATE)
    assert proxy != proxy  # NaN on this date (measured: all 21 test months, all 24 validation months)
    static_risk = worker.corridors[("GBR", "PHL")][0]["risk"]
    assert v["corridor_risk"] == static_risk == 0.0
    assert v["baseline_cost_pct"] == p1.cost_baseline.lagged_real_cost_baseline_pct("GBR", "PHL", DATE)
    assert [w["code"] for w in v["warnings"]] == ["RISK_FALLBACK_USED"]
    for venue in v["venues"]:
        liq, cong = p1.dbs.get_dynamic_state(venue["bridge_uid"], DATE)
        assert (venue["liquidity_usd"], venue["congestion"]) == (liq, cong)
        assert venue["values_provenance"] == "synthetic_simulation"
        assert "history" not in venue


def test_state_matches_route_inputs(worker):
    """The bridge monitor shows exactly what routing executes against."""
    from cbdc_inference.engine import Transaction
    for state in (ReplayState(DATE), ScenarioState(DATE, "cheapest_venue_outage")):
        v = worker.state_view("GBR->PHL", state)
        r = worker.route(Transaction("GBR", "PHL", 1000.0), state)
        assert [(a.bridge_uid, a.liquidity_usd, a.congestion, a.risk, a.fee_pct) for a in r.allocations] == \
            [(x["bridge_uid"], x["liquidity_usd"], x["congestion"], v["corridor_risk"], x["fee_pct"])
             for x in v["venues"]]
        assert v["baseline_cost_pct"] == r.baseline_cost_pct


def test_scenario_state_uses_perturbed_frame(worker, p1):
    replay = worker.state_view("GBR->PHL", ReplayState(DATE))
    outage = worker.state_view("GBR->PHL", ScenarioState(DATE, "cheapest_venue_outage"))
    assert outage["state"]["scenario_id"] == "cheapest_venue_outage"
    assert {v["values_provenance"] for v in outage["venues"]} == {"synthetic_scenario"}
    by_uid = {v["bridge_uid"]: v for v in replay["venues"]}
    for v in outage["venues"]:
        factor = 0.1 if v["bridge_uid"] == "GBR->PHL#1" else 1.0  # fee-cheapest venue at 10%
        assert v["liquidity_usd"] == pytest.approx(by_uid[v["bridge_uid"]]["liquidity_usd"] * factor, rel=1e-12)
        assert v["congestion"] == by_uid[v["bridge_uid"]]["congestion"]
    assert outage["corridor_risk"] == replay["corridor_risk"]  # scenarios don't touch risk


def test_history_is_30_raw_days_oldest_first(worker):
    for state in (ReplayState(DATE), ScenarioState(DATE, "congestion_x2")):
        v = worker.state_view("USA->IND", state, include_history=True)
        for venue in v["venues"]:
            h = venue["history"]
            assert len(h["dates"]) == len(h["liquidity_usd"]) == len(h["congestion"]) == 30
            assert h["dates"][0] == "2024-05-16" and h["dates"][-1] == DATE
            assert h["dates"] == sorted(h["dates"])
            assert (h["liquidity_usd"][-1], h["congestion"][-1]) == (venue["liquidity_usd"], venue["congestion"])


def test_state_warnings(worker, p1):
    v = worker.state_view("ARE->MEX", ReplayState(DATE))
    assert "SYNTHETIC_COST_ANCHOR" in {w["code"] for w in v["warnings"]}
    # a train month where the proxy exists: real risk, no fallback warning
    train_date = "2016-07-07"
    proxy = p1.risk_proxy.corridor_risk_proxy("GBR", "PHL", train_date)
    assert proxy == proxy
    t = worker.state_view("GBR->PHL", ReplayState(train_date))
    assert t["corridor_risk"] == proxy and t["warnings"] == [] and t["state"]["split"] == "train"


def test_route_reports_the_same_risk_fallback(worker):
    from cbdc_inference.engine import Transaction
    r = worker.route(Transaction("GBR", "PHL", 1000.0), ReplayState(DATE))
    assert "RISK_FALLBACK_USED" in {w.code for w in r.warnings} and r.risk_term == 0.0


@pytest.mark.parametrize("corridor,state,exc", [
    ("GBR-PHL", ReplayState(DATE), E.ValidationFailed),
    ("USA->PHL", ReplayState(DATE), E.UnsupportedCorridor),
    ("GBR->PHL", ReplayState("2025-10-01"), E.DateOutOfRange),
    ("GBR->PHL", ReplayState("2022-01-10"), E.DateInGapBuffer),
    ("GBR->PHL", ReplayState("14-06-2024"), E.ValidationFailed),
    ("GBR->PHL", ScenarioState(DATE, "nope"), E.UnknownScenario),
    ("GBR->PHL", {"mode": "explicit"}, E.ValidationFailed),
])
def test_state_errors(worker, corridor, state, exc):
    with pytest.raises(exc):
        worker.state_view(corridor, state)


def test_state_lookup_leaves_shared_state_intact(worker, p1):
    worker.state_view("GBR->PHL", ScenarioState(DATE, "liquidity_minus50"), include_history=True)
    assert p1.dbs._daily_df_cache[p1.dbs.DAILY_PARQUET_PATH] is worker.baseline_frame
    worker.check_integrity()


# ------------------------------------------------------------------ calendar and scenarios
def test_calendar_matches_validate_simulation_date_on_every_day(worker, p1):
    cal = worker.replay_calendar()
    windowing = importlib.import_module("src.models.stage1c_windowing")
    pd = p1.pd
    assert (cal["start"], cal["end"], cal["gap_buffer_days"]) == ("2011-01-01", "2025-09-30", 30)
    assert cal["splits"] == {"train": {"start": "2011-01-01", "end": "2021-12-31"},
                             "validation": {"start": "2022-01-01", "end": "2023-12-31"},
                             "test": {"start": "2024-01-01", "end": "2025-09-30"}}
    excluded = set()
    for r in cal["excluded_ranges"]:
        excluded |= {d.date().isoformat() for d in pd.date_range(r["start"], r["end"])}
    for day in pd.date_range(cal["start"], cal["end"]):
        try:
            windowing.validate_simulation_date(day)
            ok = True
        except windowing.InvalidSimulationDateError:
            ok = False
        assert ok == (day.date().isoformat() not in excluded), day
    assert cal["excluded_ranges"][0] == {"start": "2011-01-01", "end": "2011-01-31"}
    assert cal["excluded_ranges"][-1] == {"start": "2025-08-31", "end": "2025-09-30"}


def test_scenarios_are_stage1f_definitions(worker, p1):
    out = worker.scenario_list()
    assert [s["scenario_id"] for s in out["scenarios"]] == list(p1.scenarios.SCENARIOS)
    for s in out["scenarios"]:
        src = p1.scenarios.SCENARIOS[s["scenario_id"]]
        assert (s["description"], s["liquidity_multiplier"], s["congestion_multiplier"],
                s["cheapest_venue_liquidity_multiplier"]) == \
            (src.description, src.liquidity_multiplier, src.congestion_multiplier,
             src.cheapest_venue_liquidity_multiplier)
    assert "Not calibrated" in out["note"]
