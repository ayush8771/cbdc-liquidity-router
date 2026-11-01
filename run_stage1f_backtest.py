"""Stage 1F - comprehensive backtest (evaluation only; no training or tuning).

Run from the repository root:
    python run_stage1f_backtest.py                      # full run (all scenarios)
    python run_stage1f_backtest.py --scenarios baseline --limit 50   # quick smoke run

Writes a NEW outputs/backtests/stage1f_backtest_<timestamp>/ directory:
  analysis_plan.json      written and hashed BEFORE any evaluation (pre-registration)
  leakage_report.json     evaluation-set construction + leakage guards
  per_transaction.parquet one row per scenario x policy x checkpoint x transaction
  metrics_*.csv           per-checkpoint and across-checkpoint aggregates
  statistics.json         paired comparisons (two-level cluster bootstrap, Holm)
  reward_sensitivity.csv  evaluation-time reward-weight sensitivity
  provenance.json         git, code/data/checkpoint hashes, devices, timings
  REPORT.md               factual tables generated from the above
"""
from __future__ import annotations

import argparse
import hashlib
import json
import platform
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import pandas as pd
import torch

from src.backtesting import analysis as A
from src.backtesting.evaluation import evaluate_scenario
from src.backtesting.leakage import HOLDOUTS, build_evaluation_set, check_checkpoint_selection
from src.backtesting.scenarios import SCENARIOS
from src.envs.dynamic_bridge_state import DAILY_PARQUET_PATH, load_daily_series

MULTISEED = Path("outputs/experiments/stage1d_entropy_multiseed_20261101_180551")
CHECKPOINTS = [(f"seed{s}_{c}", MULTISEED / f"seed{s}" / c / "ppo_checkpoint.pt")
               for s in (42, 123, 2026) for c in ("entropy000", "entropy005")]
CODE = ["run_stage1f_backtest.py", "src/backtesting/scenarios.py", "src/backtesting/evaluation.py",
        "src/backtesting/analysis.py", "src/backtesting/statistics.py", "src/backtesting/leakage.py",
        "src/training/capacity_projection.py", "src/envs/cbdc_env.py", "src/envs/reward.py",
        "src/models/ppo_actor_critic.py", "src/training/baselines.py"]
DATA = [DAILY_PARQUET_PATH, "data/processed/normalization_stats.json", *HOLDOUTS,
        "data/processed/stage1d_transactions_train.csv", "data/processed/stage1d_transactions_validation.csv",
        "data/processed/stage1d_transactions_test.csv", "data/structured/bridge_network.csv"]

PLAN = {
    "stage": "1F", "purpose": "evaluation only; no training, no tuning, no model/environment/reward change",
    "evaluation_set": "union of the three Stage 1D synthetic holdouts (never used for training or selection); "
                      "exact duplicates of examined test-split rows excluded; exact duplicate rows within or across holdouts kept once",
    "checkpoints": "six multi-seed checkpoints (seeds 42/123/2026 x ENTROPY_COEF 0.0/0.005), selected on validation",
    "policies": list(A.POLICIES),
    "scenarios": {k: v.__dict__ for k, v in SCENARIOS.items()},
    "metrics": ["amount_completion_rate", "env_completion_rate", "total_amount_unrouted", "unrouted_share",
                "mean_reward_env", "mean_reward_amount (cost - latency - risk - amount_unrouted/amount)",
                "mean_cost_term", "mean_latency_term", "liquidity_utilization", "mean_bridges_used", "mean_decision_ms"],
    "primary_hypotheses_baseline_scenario": {
        "H1": "ppo_projected - liquidity_waterfall, mean_reward_env",
        "H2": "ppo_projected - ppo_original, amount completion",
        "H3": "ppo_original - liquidity_waterfall, mean_reward_env",
        "H4": "ppo_projected - liquidity_waterfall, amount completion",
    },
    "inference": "two-level cluster bootstrap (checkpoints x simulation-date clusters), percentile 95% CI, "
                 "two-sided bootstrap p; Holm-Bonferroni within each family (primary = H1-H4 on baseline; "
                 "each stress scenario = its own family); Wilcoxon/sign on seed-averaged diffs as secondary",
    "n_boot": 10000, "n_boot_secondary": 2000, "bootstrap_seed": 1,
    "equivalence_margins": {"reward_env": 0.005, "reward_amount": 0.005, "completed": 0.01},
    "equivalence_margin_disclosure": "Margins were chosen after Stage 1D holdout results were seen "
                                     "(observed projected-minus-waterfall spread -0.0033..+0.0051); they are fixed here "
                                     "before any Stage 1F evaluation.",
    "stress_primary_metric": "reward_amount (amount-based unrouted term), because the environment's unrouted "
                             "accounting omits never-requested amounts, which matters when liquidity is short",
    "reward_weight_grid": {"lambda_latency": [0.5, 1.0, 2.0], "lambda_unrouted": [1.0, 5.0, 10.0], "lambda_risk": 1.0},
}
SPECS_PRIMARY = [("H1", "reward", "ppo_projected", "liquidity_waterfall"),
                 ("H2", "completed", "ppo_projected", "ppo_original"),
                 ("H3", "reward", "ppo_original", "liquidity_waterfall"),
                 ("H4", "completed", "ppo_projected", "liquidity_waterfall")]
SPECS_STRESS = [("projected_vs_waterfall_reward_amount", "reward_amount", "ppo_projected", "liquidity_waterfall"),
                ("projected_vs_waterfall_completion", "completed", "ppo_projected", "liquidity_waterfall"),
                ("projected_vs_original_completion", "completed", "ppo_projected", "ppo_original"),
                ("original_vs_waterfall_reward_amount", "reward_amount", "ppo_original", "liquidity_waterfall")]
MARGINS = {"reward": 0.005, "reward_amount": 0.005, "reward_w": 0.005, "completed": 0.01}


def _sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def _git(*args):
    try:
        return subprocess.check_output(["git", *args], text=True).strip()
    except Exception:
        return None


def _save(path, obj):
    Path(path).write_text(json.dumps(obj, indent=2, default=str), encoding="utf-8")


def _fmt(x, nd=4):
    return "n/a" if x is None else f"{x:.{nd}f}"


def write_report(out, leak, overall, stats, sens, by_regime):
    L = ["# Stage 1F backtest report (generated)", "",
         f"Evaluation set: {leak['rows_evaluated']} transactions ({leak['rows_by_source']}); "
         f"{leak['rows_excluded_duplicate_of_examined_test_split']} test-split duplicates excluded, "
         f"{leak['rows_removed_exact_duplicates_within_or_across_holdouts']} exact-duplicate rows (within or across holdouts) removed.", "",
         "## Overall (mean +/- SD across checkpoints; deterministic baselines have SD 0)", "",
         "| scenario | policy | completion | unrouted share | reward (env) | reward (amount) | cost | latency | utilization | bridges | ms/decision |",
         "|---|---|---|---|---|---|---|---|---|---|---|"]
    for _, r in overall.iterrows():
        L.append(f"| {r.scenario} | {r.policy} | {r.amount_completion_rate_mean:.4f} | {r.unrouted_share_mean:.4f} | "
                 f"{r.mean_reward_env_mean:.4f} ± {r.mean_reward_env_sd:.4f} | {r.mean_reward_amount_mean:.4f} | "
                 f"{r.mean_cost_term_mean:.4f} | {r.mean_latency_term_mean:.4f} | {r.liquidity_utilization_mean:.4f} | "
                 f"{r.mean_bridges_used_mean:.2f} | {r.mean_decision_ms_mean:.3f} |")
    L += ["", "## Paired comparisons (estimate, 95% two-level cluster-bootstrap CI, Holm-adjusted p)", "",
          "| scenario | test | metric | estimate | 95% CI | p (Holm) | checkpoints +/- | equivalence |", "|---|---|---|---|---|---|---|---|"]
    for scen, fam in stats.items():
        for name, c in fam.items():
            if c.get("n_transactions", 0) == 0:
                continue
            L.append(f"| {scen} | {name} | {c['metric']} | {c['estimate']:+.5f} | [{c['ci95'][0]:+.5f}, {c['ci95'][1]:+.5f}] | "
                     f"{_fmt(c.get('p_holm'), 4)} | {c['checkpoints_positive']}/{c['checkpoints_negative']} | {c['equivalence']} |")
    L += ["", "## Regime breakdown (scenario regime labels; completion / reward-amount, mean across checkpoints)", "",
          "| scenario | regime | n | ppo_original | ppo_projected | liquidity_waterfall | cheapest_feasible |", "|---|---|---|---|---|---|---|"]
    for (scen, reg), g in by_regime.groupby(["scenario", "regime_scenario"]):
        cell = {r.policy: f"{r.amount_completion_rate_mean:.3f} / {r.mean_reward_amount_mean:.3f}" for _, r in g.iterrows()}
        L.append(f"| {scen} | {reg} | {int(g['n'].iloc[0])} | " + " | ".join(cell.get(p, "-") for p in A.POLICIES) + " |")
    L += ["", "## Reward-weight sensitivity (evaluation-time; projected - waterfall, amount-based reward)", "",
          "| scenario | λ_latency | λ_unrouted | best policy | estimate | 95% CI | equivalence |", "|---|---|---|---|---|---|---|"]
    for r in sens:
        L.append(f"| {r['scenario']} | {r['lambda_latency']} | {r['lambda_unrouted']} | {r['best_policy']} | "
                 f"{r['projected_minus_waterfall']:+.5f} | [{r['ci95_low']:+.5f}, {r['ci95_high']:+.5f}] | {r['equivalence']} |")
    (out / "REPORT.md").write_text("\n".join(L) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description="Stage 1F backtest")
    ap.add_argument("--scenarios", nargs="+", default=list(SCENARIOS))
    ap.add_argument("--limit", type=int, default=None, help="evaluate only the first N transactions (smoke runs)")
    ap.add_argument("--n-boot", type=int, default=PLAN["n_boot"])
    ap.add_argument("--out-root", default="outputs/backtests", help="parent directory for the new run folder")
    args = ap.parse_args()
    unknown = [s for s in args.scenarios if s not in SCENARIOS]
    if unknown:
        print(f"Unknown scenario(s): {unknown}")
        return 2

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out = Path(args.out_root) / f"stage1f_backtest_{ts}"
    out.mkdir(parents=True, exist_ok=False)
    plan = {**PLAN, "scenarios_run": args.scenarios, "limit": args.limit, "n_boot": args.n_boot}
    _save(out / "analysis_plan.json", plan)
    plan_sha = _sha(out / "analysis_plan.json")

    data_before = {p: _sha(p) for p in DATA}
    eval_df, leak = build_evaluation_set()
    leak["checkpoint_selection"] = check_checkpoint_selection(MULTISEED / "experiment_config.json")
    if args.limit:
        eval_df = eval_df.head(args.limit)
        leak["limit_applied"] = args.limit
    _save(out / "leakage_report.json", leak)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    base = load_daily_series()
    frames, timings = [], {}
    for name in args.scenarios:
        t0 = time.time()
        print(f"[{datetime.now():%H:%M:%S}] scenario {name} ...", flush=True)
        frames.append(evaluate_scenario(eval_df, SCENARIOS[name], base, CHECKPOINTS, device=device))
        timings[name] = round(time.time() - t0, 1)
        print(f"  done in {timings[name]}s", flush=True)
    df = A.add_derived(pd.concat(frames, ignore_index=True))
    df.to_parquet(out / "per_transaction.parquet", index=False)

    pc = A.per_checkpoint_metrics(df)
    overall = A.across_checkpoints(pc)
    pc_reg = A.per_checkpoint_metrics(df, extra_keys=("regime_scenario",))
    by_regime = A.across_checkpoints(pc_reg, keys=("scenario", "policy", "regime_scenario"))
    pc_cor = A.per_checkpoint_metrics(df, extra_keys=("corridor",))
    by_corridor = A.across_checkpoints(pc_cor, keys=("scenario", "policy", "corridor"))
    pc.to_csv(out / "metrics_per_checkpoint.csv", index=False)
    overall.to_csv(out / "metrics_overall.csv", index=False)
    by_regime.to_csv(out / "metrics_by_regime.csv", index=False)
    by_corridor.to_csv(out / "metrics_by_corridor.csv", index=False)

    seed = PLAN["bootstrap_seed"]
    stats = {}
    if "baseline" in args.scenarios:
        stats["baseline"] = A.comparison_family(df, "baseline", SPECS_PRIMARY, args.n_boot, seed, MARGINS)
    for name in args.scenarios:
        stats[f"{name}__stress_family"] = A.comparison_family(df, name, SPECS_STRESS, PLAN["n_boot_secondary"], seed, MARGINS)
    regime_stats = {}
    for name in args.scenarios:
        d = df[df["scenario"] == name]
        for reg in sorted(d["regime_scenario"].dropna().unique()):
            mask = d["regime_scenario"] == reg
            regime_stats[f"{name}|{reg}"] = A.compare(df, name, "reward_amount", "ppo_projected", "liquidity_waterfall",
                                                      PLAN["n_boot_secondary"], seed, MARGINS, mask=mask)
    _save(out / "statistics.json", {"families": stats, "regime_projected_vs_waterfall_reward_amount": regime_stats})

    grid = [(l, u) for l in PLAN["reward_weight_grid"]["lambda_latency"] for u in PLAN["reward_weight_grid"]["lambda_unrouted"]]
    sens = [r for name in args.scenarios for r in A.lambda_sensitivity(df, name, grid, PLAN["n_boot_secondary"], seed, 0.005)]
    pd.DataFrame(sens).to_csv(out / "reward_sensitivity.csv", index=False)

    data_after = {p: _sha(p) for p in DATA}
    if data_after != data_before:
        raise RuntimeError("input data changed during the backtest")
    status = _git("status", "--porcelain")
    _save(out / "provenance.json", {
        "started_at": ts, "analysis_plan_sha256": plan_sha, "git_head": _git("rev-parse", "HEAD"),
        "git_dirty": bool(status), "git_dirty_files": status.splitlines() if status else [],
        "code_sha256": {f: _sha(f) for f in CODE}, "code_git_blob": {f: _git("hash-object", f) for f in CODE},
        "data_sha256": data_before, "data_verified_unchanged": True,
        "checkpoints": [{"label": l, "path": str(p), "sha256": _sha(p)} for l, p in CHECKPOINTS],
        "device": device, "gpu": torch.cuda.get_device_name(0) if device == "cuda" else None,
        "python": platform.python_version(), "torch": torch.__version__, "pandas": pd.__version__,
        "scenario_seconds": timings, "rows": len(df),
        "training_performed": False, "tuning_performed": False,
        "numeric_note": "PPO inference is batched; vs per-transaction Stage 1D inference rewards differ by <=~1e-6.",
    })
    write_report(out, leak, overall, {k: v for k, v in stats.items()}, sens, by_regime)
    print(f"\nOutputs: {out.resolve()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
