"""Parity (arch §5.1, contract §9): route() must reproduce Phase 1's evaluation path exactly.

References are Phase 1's own code:
  * src.training.evaluate.run_baseline on the full split (aggregate metrics, exact dict equality);
  * run_baseline on a one-row env per transaction (per-row reward/executed/unrouted, exact);
  * src.backtesting.evaluation.evaluate_scenario with no checkpoints (per-row, all six Stage 1F scenarios).
"""
import importlib
from pathlib import Path

import pandas as pd
import pytest

from cbdc_inference.engine import ReplayState, ScenarioState, Transaction

REPO_ROOT = Path(__file__).resolve().parents[4]
VALIDATION_CSV = REPO_ROOT / "data/processed/stage1d_transactions_validation.csv"
HOLDOUT_CSV = REPO_ROOT / "data/processed/stage1d_transactions_holdout_seed20261102.csv"

PHASE1_NAME = {"waterfall": "liquidity_waterfall", "cheapest_feasible": "cheapest_feasible"}
SPLITS = [pytest.param(VALIDATION_CSV, id="validation"), pytest.param(HOLDOUT_CSV, id="holdout_seed20261102")]
POLICIES = ["waterfall", "cheapest_feasible"]


def _route_rows(worker, df, policy, state_for=lambda d: ReplayState(d)):
    out = []
    for row in df.itertuples(index=False):
        tx = Transaction(row.sender_country, row.receiver_country, float(row.amount_usd))
        out.append(worker.route(tx, state_for(row.simulation_date), policy))
    return out


def _as_record(r, regime):
    """The record shape run_baseline builds, from a RouteResult."""
    return {"amount": r.amount_usd, "reward": r.reward_env, "executed_total": r.executed_usd,
            "unrouted": r.unrouted_env_usd, "action": list(r.action), "latency_term": r.latency_term,
            "risk_term": r.risk_term, "cost_term": r.cost_term, "regime": regime}


@pytest.fixture(scope="module")
def evaluate(p1):
    return importlib.import_module("src.training.evaluate")


@pytest.mark.parametrize("csv", SPLITS)
@pytest.mark.parametrize("policy", POLICIES)
def test_aggregate_metrics_equal_run_baseline(worker, p1, evaluate, csv, policy):
    env, regimes = evaluate._make_eval_env(str(csv))
    reference = evaluate.run_baseline(env, PHASE1_NAME[policy], regimes)

    df = pd.read_csv(csv)
    results = _route_rows(worker, df, policy)
    ours = p1.metrics.compute_metrics([_as_record(r, g) for r, g in zip(results, regimes)])
    assert ours == reference


@pytest.mark.parametrize("csv", SPLITS)
@pytest.mark.parametrize("policy", POLICIES)
def test_per_transaction_equal_run_baseline(worker, p1, evaluate, csv, policy):
    df = pd.read_csv(csv)
    ref_env, _ = evaluate._make_eval_env(str(csv))
    full = ref_env.requests_df
    results = _route_rows(worker, df, policy)
    mismatches = []
    for i, r in enumerate(results):
        ref_env.requests_df = full.iloc[[i]].reset_index(drop=True)
        ref_env.max_steps = 1
        ref = evaluate.run_baseline(ref_env, PHASE1_NAME[policy])
        # the action run_baseline feeds to env.step(), from the same Phase 1 function and mask
        ref_env.current_step = 0
        req = ref_env._current_request()
        mask, bridges, _ = ref_env.get_feasibility_mask(req)
        if policy == "waterfall":
            action = p1.baselines.liquidity_aware_waterfall_action(bridges, mask, float(req["amount_usd"]),
                                                                    req["simulation_date"])
        else:
            action = p1.baselines.cheapest_feasible_action(bridges, mask)
        got = (r.reward_env, r.executed_usd, r.unrouted_env_usd, r.action)
        want = (ref["mean_reward"], ref["total_executed"], ref["total_unrouted"], tuple(float(a) for a in action))
        if got != want:
            mismatches.append((int(df.transaction_id.iloc[i]), got, want))
    assert not mismatches, mismatches[:5]
    assert len(results) == len(df)


def test_regime_labels_match_dataset(worker):
    """The validation CSV's regime column was relabelled with true_regime_for_row (Stage 1D)."""
    df = pd.read_csv(VALIDATION_CSV)
    results = _route_rows(worker, df, "waterfall")
    assert [r.regime for r in results] == df["regime"].tolist()


@pytest.fixture(scope="module")
def backtest_eval(p1):
    return importlib.import_module("src.backtesting.evaluation")


@pytest.mark.parametrize("scenario_id", ["baseline", "liquidity_minus30", "liquidity_minus50",
                                         "cheapest_venue_outage", "congestion_x2", "combined_stress"])
def test_scenario_mode_equals_stage1f_harness(worker, p1, backtest_eval, scenario_id):
    df = pd.read_csv(VALIDATION_CSV)
    scenario = p1.scenarios.SCENARIOS[scenario_id]
    ref = backtest_eval.evaluate_scenario(df, scenario, worker.baseline_frame, checkpoints=[])
    worker.check_integrity()  # the harness itself must leave the shared cache restored
    for policy in POLICIES:
        sub = ref[ref.policy == PHASE1_NAME[policy]].reset_index(drop=True)
        results = _route_rows(worker, df, policy, lambda d: ScenarioState(d, scenario_id))
        got = [(r.reward_env, r.executed_usd, r.unrouted_env_usd, r.unrouted_amount_based_usd, r.completed,
                r.regime, r.cost_term, r.latency_term, r.risk_term) for r in results]
        want = [(row.reward, row.executed, row.env_unrouted, row.amount_unrouted, bool(row.amount_completed),
                 row.regime_scenario, row.cost_term, row.latency_term, row.risk_term)
                for row in sub.itertuples(index=False)]
        assert got == want, f"{policy} under {scenario_id}"
