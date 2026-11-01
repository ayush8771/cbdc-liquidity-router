"""Stage 1F tests: scenarios, data injection, statistics, leakage guards and the
backtest harness (regression against Stage 1D results). Evaluation only; no training.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)

from src.backtesting import analysis as A
from src.backtesting.evaluation import evaluate_scenario, reward_with_weights
from src.backtesting.leakage import (HOLDOUTS, LeakageError, build_evaluation_set, check_checkpoint_selection)
from src.backtesting.scenarios import (CHEAPEST_PARQUET_IDS, SCENARIOS, Scenario, injected_daily_state, perturb)
from src.backtesting.statistics import equivalence, holm, two_level_bootstrap, wilcoxon_and_sign
from src.envs import dynamic_bridge_state as dbs

MULTISEED = Path("outputs/experiments/stage1d_entropy_multiseed_20261101_180551")
CKPT = ("seed42_entropy000", MULTISEED / "seed42" / "entropy000" / "ppo_checkpoint.pt")
PRIOR_HOLDOUT_RUN = Path("outputs/experiments/stage1d_holdout_eval_20261101_225445/per_transaction.csv")


def _raises(fn, exc, contains=None):
    try:
        fn()
    except exc as e:
        assert contains is None or contains in str(e), f"{e!r} lacks {contains!r}"
        return
    raise AssertionError(f"expected {exc.__name__}")


def _sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


# --- Scenarios and injection ---------------------------------------------------

def test_cheapest_venue_ids_follow_fee_order():
    assert CHEAPEST_PARQUET_IDS == ["ARE->MEX#1", "GBR->PHL#1", "USA->IND#1"]


def test_perturb_applies_multipliers_and_never_mutates_input():
    base = dbs.load_daily_series()
    snapshot = base.copy(deep=True)
    s = perturb(base, SCENARIOS["combined_stress"])
    assert base.equals(snapshot)
    m = base.merge(s, on=["bridge_id", "date"], suffixes=("", "_s"))
    assert np.allclose(m["liquidity_level_s"], 0.7 * m["liquidity_level"])
    assert np.allclose(m["congestion_level_s"], 1.5 * m["congestion_level"])
    out = perturb(base, SCENARIOS["cheapest_venue_outage"]).merge(base, on=["bridge_id", "date"], suffixes=("_s", ""))
    cheap = out["bridge_id"].isin(CHEAPEST_PARQUET_IDS)
    assert np.allclose(out.loc[cheap, "liquidity_level_s"], 0.1 * out.loc[cheap, "liquidity_level"])
    assert np.allclose(out.loc[~cheap, "liquidity_level_s"], out.loc[~cheap, "liquidity_level"])
    assert perturb(base, SCENARIOS["baseline"])[["liquidity_level", "congestion_level"]].equals(
        base[["liquidity_level", "congestion_level"]])


def test_perturb_rejects_invalid_scenarios():
    base = dbs.load_daily_series()
    _raises(lambda: perturb(base, Scenario("bad", "x", liquidity_multiplier=-1.0)), ValueError, "invalid multiplier")
    _raises(lambda: perturb(base, Scenario("bad", "x", congestion_multiplier=float("nan"))), ValueError)
    _raises(lambda: perturb(base, "baseline"), TypeError)


def test_injection_changes_state_lookup_and_always_restores():
    base = dbs.load_daily_series()
    key = dbs.DAILY_PARQUET_PATH
    before = dbs._daily_df_cache.get(key)
    liq0 = dbs.get_dynamic_state("USA->IND#1", "2024-06-03")[0]
    with injected_daily_state(perturb(base, SCENARIOS["liquidity_minus50"])):
        assert np.isclose(dbs.get_dynamic_state("USA->IND#1", "2024-06-03")[0], 0.5 * liq0)
    assert dbs._daily_df_cache.get(key) is before
    try:
        with injected_daily_state(perturb(base, SCENARIOS["liquidity_minus30"])):
            raise KeyError("boom")
    except KeyError:
        pass
    assert dbs._daily_df_cache.get(key) is before
    assert dbs.get_dynamic_state("USA->IND#1", "2024-06-03")[0] == liq0


# --- Statistics ------------------------------------------------------------------

def test_bootstrap_constant_difference_and_determinism():
    diff = pd.DataFrame(np.full((40, 3), 0.25), columns=["a", "b", "c"])
    cl = pd.Series(np.repeat(np.arange(10), 4))
    r = two_level_bootstrap(diff, cl, n_boot=500, seed=3)
    assert r["estimate"] == 0.25 and np.allclose(r["ci95"], [0.25, 0.25]) and r["p_bootstrap"] == 0.0
    assert r["n_clusters"] == 10 and r["n_checkpoints"] == 3
    assert two_level_bootstrap(diff, cl, n_boot=500, seed=3) == r


def test_bootstrap_zero_and_noisy_differences():
    rng = np.random.default_rng(0)
    zero = pd.DataFrame(np.zeros((20, 2)))
    assert two_level_bootstrap(zero, pd.Series(range(20)), n_boot=200)["p_bootstrap"] == 1.0
    noisy = pd.DataFrame(rng.normal(0.0, 1.0, (400, 6)))
    r = two_level_bootstrap(noisy, pd.Series(np.repeat(np.arange(100), 4)), n_boot=2000, seed=1)
    assert r["ci95"][0] < 0 < r["ci95"][1] and r["p_bootstrap"] > 0.05
    shifted = noisy + 1.0
    r2 = two_level_bootstrap(shifted, pd.Series(np.repeat(np.arange(100), 4)), n_boot=2000, seed=1)
    assert r2["ci95"][0] > 0 and r2["p_bootstrap"] < 0.01


def test_bootstrap_input_validation():
    _raises(lambda: two_level_bootstrap(pd.DataFrame([[np.nan]]), pd.Series([0])), ValueError, "NaN")
    _raises(lambda: two_level_bootstrap(pd.DataFrame([[1.0]], index=[5]), pd.Series([0], index=[6])), ValueError, "index")


def test_holm_wilcoxon_and_equivalence():
    h = holm({"a": 0.01, "b": 0.04, "c": 0.03})
    assert np.isclose(h["a"]["p_holm"], 0.03) and np.isclose(h["c"]["p_holm"], 0.06) and np.isclose(h["b"]["p_holm"], 0.06)
    assert h["a"]["reject"] and not h["b"]["reject"]
    assert wilcoxon_and_sign(np.zeros(5)) == {"n": 5, "positive": 0, "negative": 0, "zero": 5, "wilcoxon_p": 1.0,
                                              "wilcoxon_stat": None}
    assert wilcoxon_and_sign(np.arange(1, 21, dtype=float))["wilcoxon_p"] < 0.001
    assert equivalence([-0.001, 0.002], 0.005) == "practically_negligible"
    assert equivalence([0.01, 0.02], 0.005) == "positive"
    assert equivalence([-0.02, -0.01], 0.005) == "negative"
    assert equivalence([-0.02, 0.01], 0.005) == "inconclusive"


def test_paired_matrix_broadcasts_deterministic_policies():
    rows = []
    for tx, date in ((1, "d1"), (2, "d1"), (3, "d2")):
        rows.append({"scenario": "s", "policy": "liquidity_waterfall", "checkpoint": "-", "transaction_id": tx,
                     "simulation_date": date, "reward": 1.0})
        for ck, v in (("c1", 1.5), ("c2", 0.5)):
            rows.append({"scenario": "s", "policy": "ppo_projected", "checkpoint": ck, "transaction_id": tx,
                         "simulation_date": date, "reward": v + tx})
    diff, clusters = A.paired_matrix(pd.DataFrame(rows), "s", "reward", "ppo_projected", "liquidity_waterfall")
    assert list(diff.columns) == ["c1", "c2"] and diff.loc[1, "c1"] == 1.5 and diff.loc[3, "c2"] == 2.5
    assert clusters.tolist() == ["d1", "d1", "d2"]


def test_reward_with_unit_weights_equals_env_reward_when_unrouted_agrees():
    df = pd.DataFrame({"cost_term": [2.0, 1.5], "latency_term": [1.0, 0.5], "risk_term": [0.0, 0.1],
                       "amount_unrouted": [0.0, 50.0], "amount": [1000.0, 1000.0]})
    env_reward = df["cost_term"] - df["latency_term"] - df["risk_term"] - df["amount_unrouted"] / df["amount"]
    assert np.allclose(reward_with_weights(df), env_reward)
    assert np.allclose(reward_with_weights(df, lam_unrouted=10.0), env_reward - 9 * df["amount_unrouted"] / df["amount"])


# --- Leakage guards ----------------------------------------------------------------

def test_real_evaluation_set_passes_guards():
    ev, rep = build_evaluation_set()
    assert rep["rows_loaded"] == 1500 and rep["rows_excluded_duplicate_of_examined_test_split"] == 2
    assert rep["rows_evaluated"] == len(ev) == 1500 - 2 - rep["rows_removed_exact_duplicates_within_or_across_holdouts"]
    assert rep["rows_duplicating_train"] == 0 and rep["rows_duplicating_validation"] == 0
    assert not ev.duplicated(subset=["sender_country", "receiver_country", "simulation_date", "amount_usd"]).any()
    assert ev["simulation_date"].min() >= "2024-01-01" and ev["simulation_date"].max() <= "2025-09-30"
    assert check_checkpoint_selection(MULTISEED / "experiment_config.json")["test_split_used"] is False


def _copy_inputs(tmp):
    for p in HOLDOUTS + ["data/processed/stage1d_transactions_train.csv", "data/processed/stage1d_transactions_validation.csv",
                         "data/processed/stage1d_transactions_test.csv"]:
        dst = Path(tmp) / p
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(p, dst)


def test_guard_rejects_train_window_dates_and_train_duplicates():
    with tempfile.TemporaryDirectory() as tmp:
        _copy_inputs(tmp)
        h = Path(tmp) / HOLDOUTS[0]
        df = pd.read_csv(h)
        df.loc[0, "simulation_date"] = "2015-06-15"  # train window
        df.to_csv(h, index=False)
        _raises(lambda: build_evaluation_set(root=tmp), LeakageError, "out-of-time")
    with tempfile.TemporaryDirectory() as tmp:
        _copy_inputs(tmp)
        tr = pd.read_csv(Path(tmp) / "data/processed/stage1d_transactions_train.csv")
        h = Path(tmp) / HOLDOUTS[1]
        df = pd.read_csv(h)
        row = df.iloc[[0]].copy()
        tr = pd.concat([tr, row[tr.columns.intersection(row.columns)]], ignore_index=True)  # plant a holdout row in train
        tr.to_csv(Path(tmp) / "data/processed/stage1d_transactions_train.csv", index=False)
        _raises(lambda: build_evaluation_set(root=tmp), LeakageError, "duplicate train")


def test_guard_rejects_checkpoints_not_selected_on_validation():
    with tempfile.TemporaryDirectory() as tmp:
        cfg = json.loads((MULTISEED / "experiment_config.json").read_text(encoding="utf-8"))
        cfg["test_split_used"] = True
        p = Path(tmp) / "c.json"
        p.write_text(json.dumps(cfg), encoding="utf-8")
        _raises(lambda: check_checkpoint_selection(p), LeakageError, "validation only")


# --- Harness ---------------------------------------------------------------------

def _small_eval():
    ev, _ = build_evaluation_set()
    return ev[ev["source"] == "stage1d_transactions_holdout_seed20261102"].head(8).reset_index(drop=True)


def test_harness_reproduces_stage1d_holdout_results_on_baseline():
    if not PRIOR_HOLDOUT_RUN.exists():
        return
    ev = _small_eval()
    parquet_sha = _sha(dbs.DAILY_PARQUET_PATH)
    out = evaluate_scenario(ev, SCENARIOS["baseline"], dbs.load_daily_series(), [CKPT], device="cpu")
    assert _sha(dbs.DAILY_PARQUET_PATH) == parquet_sha
    assert set(out["policy"]) == set(A.POLICIES) and len(out) == 4 * len(ev)
    prev = pd.read_csv(PRIOR_HOLDOUT_RUN)
    for pol, ck, tol in (("ppo_original", CKPT[0], 1e-5), ("ppo_projected", CKPT[0], 1e-5),
                         ("liquidity_waterfall", None, 1e-12)):
        a = out[out.policy == pol].set_index("transaction_id").sort_index()
        b = prev[(prev.policy == pol) & ((prev.checkpoint == ck) if ck else True)]
        b = b.drop_duplicates("transaction_id").set_index("transaction_id").loc[a.index]
        assert np.allclose(a["reward"], b["reward"], atol=tol, rtol=0), pol
        assert (a["amount_completed"].values == b["amount_completed"].values).all(), pol
    assert (out["regime_scenario"] == out["regime_original"]).all()


def test_stress_scenario_is_consistent_and_uses_stressed_capacity():
    ev = _small_eval()
    base = dbs.load_daily_series()
    out = evaluate_scenario(ev, SCENARIOS["liquidity_minus50"], base, [CKPT], device="cpu")
    wf = out[out.policy == "liquidity_waterfall"]
    # waterfall never requests more than (stressed) liquidity -> env unrouted == 0, amount-based may be > 0
    assert (wf["env_unrouted"] <= 1e-6 * wf["amount"]).all()
    proj = out[out.policy == "ppo_projected"]
    assert ((proj["action_sum"] - 1).abs() < 1e-9).sum() + (proj["regime_scenario"] == "exceeds_combined").sum() >= len(proj)
    assert (out["executed"] <= out["amount"] * (1 + 1e-6)).all()
    assert dbs._daily_df_cache.get(dbs.DAILY_PARQUET_PATH) is base  # injection restored
    base_cap = evaluate_scenario(ev, SCENARIOS["baseline"], base, [CKPT], device="cpu")
    assert (out.groupby("transaction_id")["combined_capacity_share"].first().values
            <= base_cap.groupby("transaction_id")["combined_capacity_share"].first().values + 1e-12).all()


def test_backtesting_does_not_import_training_loop_or_cognee():
    code = (f"import sys; sys.path.insert(0, r'{ROOT}'); import src.backtesting.evaluation, src.backtesting.analysis, "
            "src.backtesting.leakage; print(sorted(m for m in sys.modules if m in ('cognee','src.training.ppo_train',"
            "'src.memory.cognee_adapter')))")
    out = subprocess.check_output([sys.executable, "-c", code], text=True, cwd=ROOT).strip().splitlines()[-1]
    assert out == "[]", out


if __name__ == "__main__":
    tests = [v for k, v in dict(globals()).items() if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {t.__name__}: {type(e).__name__}: {e}")
    print(f"{len(tests) - failed} passed, {failed} failed out of {len(tests)}")
    sys.exit(1 if failed else 0)
