"""Stage 1F - aggregation and paired comparisons over backtest rows."""
from __future__ import annotations

import numpy as np
import pandas as pd

from .evaluation import DETERMINISTIC_POLICIES, reward_with_weights
from .statistics import equivalence, holm, two_level_bootstrap, wilcoxon_and_sign

POLICIES = ("ppo_original", "ppo_projected", "liquidity_waterfall", "cheapest_feasible")


def add_derived(df: pd.DataFrame) -> pd.DataFrame:
    return df.assign(reward_amount=reward_with_weights(df), completed=df["amount_completed"].astype(float))


def per_checkpoint_metrics(df: pd.DataFrame, extra_keys=()) -> pd.DataFrame:
    keys = ["scenario", "policy", "checkpoint", *extra_keys]

    def agg(g):
        return pd.Series({
            "n": len(g),
            "amount_completion_rate": g["amount_completed"].mean(),
            "env_completion_rate": g["env_completed"].mean(),
            "total_amount_unrouted": g["amount_unrouted"].sum(),
            "unrouted_share": g["amount_unrouted"].sum() / g["amount"].sum(),
            "mean_reward_env": g["reward"].mean(),
            "mean_reward_amount": g["reward_amount"].mean(),
            "mean_cost_term": g["cost_term"].mean(),
            "mean_latency_term": g["latency_term"].mean(),
            "liquidity_utilization": g["executed"].clip(upper=g["amount"]).sum() / g["amount"].sum(),
            "mean_bridges_used": g["bridges_used"].mean(),
            "mean_decision_ms": g["decision_ms"].mean(),
        })
    return df.groupby(keys).apply(agg, include_groups=False).reset_index()


def across_checkpoints(pc: pd.DataFrame, keys=("scenario", "policy")) -> pd.DataFrame:
    metrics = [c for c in pc.columns if c not in (*keys, "checkpoint", "n")]
    g = pc.groupby(list(keys))
    out = g[metrics].mean().add_suffix("_mean").join(g[metrics].std(ddof=1).fillna(0.0).add_suffix("_sd"))
    out = out.join(g["n"].first()).join(g["checkpoint"].nunique().rename("n_checkpoints"))
    return out.reset_index()


def paired_matrix(df: pd.DataFrame, scenario: str, metric: str, pol_a: str, pol_b: str, mask=None):
    """Rows = transactions, columns = checkpoints; value = metric(pol_a) - metric(pol_b).
    Deterministic policies (one row per transaction) are broadcast across checkpoints."""
    d = df[df["scenario"] == scenario]
    if mask is not None:
        d = d[mask.reindex(d.index, fill_value=False)]
    piv = {p: d[d["policy"] == p].pivot(index="transaction_id", columns="checkpoint", values=metric) for p in (pol_a, pol_b)}
    ckpts = sorted((set(piv[pol_a].columns) | set(piv[pol_b].columns)) - {"-"}) or ["-"]
    for p in (pol_a, pol_b):
        if p in DETERMINISTIC_POLICIES and ckpts != ["-"]:
            piv[p] = pd.DataFrame({c: piv[p]["-"] for c in ckpts})
    a, b = piv[pol_a][ckpts], piv[pol_b][ckpts]
    a, b = a.align(b, join="inner", axis=0)
    dates = d.drop_duplicates("transaction_id").set_index("transaction_id")["simulation_date"].reindex(a.index)
    return a - b, dates


def compare(df, scenario, metric, pol_a, pol_b, n_boot, seed, margin, mask=None) -> dict:
    diff, clusters = paired_matrix(df, scenario, metric, pol_a, pol_b, mask)
    if diff.empty:
        return {"comparison": f"{pol_a} - {pol_b}", "metric": metric, "n_transactions": 0}
    bs = two_level_bootstrap(diff, clusters, n_boot=n_boot, seed=seed)
    per_ckpt = diff.mean(axis=0)
    out = {"comparison": f"{pol_a} - {pol_b}", "metric": metric, **bs,
           "per_checkpoint_mean": {k: float(v) for k, v in per_ckpt.items()},
           "checkpoints_positive": int((per_ckpt > 0).sum()), "checkpoints_negative": int((per_ckpt < 0).sum()),
           "seed_averaged": wilcoxon_and_sign(diff.mean(axis=1).to_numpy())}
    out["equivalence"] = equivalence(bs["ci95"], margin.get(metric, 0.0)) if isinstance(margin, dict) else equivalence(bs["ci95"], margin)
    return out


def comparison_family(df, scenario, specs, n_boot, seed, margins, mask=None) -> dict:
    """specs: list of (name, metric, pol_a, pol_b). Holm-adjusted within the family."""
    res = {name: compare(df, scenario, metric, a, b, n_boot, seed, margins, mask) for name, metric, a, b in specs}
    pv = {k: v["p_bootstrap"] for k, v in res.items() if "p_bootstrap" in v}
    for k, adj in holm(pv).items():
        res[k]["p_holm"], res[k]["reject_holm_0.05"] = adj["p_holm"], adj["reject"]
    return res


def lambda_sensitivity(df, scenario, grid, n_boot, seed, margin) -> list:
    out = []
    d = df[df["scenario"] == scenario]
    for lam_l, lam_u in grid:
        w = d.assign(reward_w=reward_with_weights(d, lam_latency=lam_l, lam_unrouted=lam_u))
        means = w.groupby(["policy", "checkpoint"])["reward_w"].mean().groupby("policy").mean()
        c = compare(w, scenario, "reward_w", "ppo_projected", "liquidity_waterfall", n_boot, seed, margin)
        out.append({"scenario": scenario, "lambda_latency": lam_l, "lambda_unrouted": lam_u,
                    **{f"mean_reward_{p}": float(means.get(p, np.nan)) for p in POLICIES},
                    "best_policy": str(means.idxmax()),
                    "projected_minus_waterfall": c["estimate"], "ci95_low": c["ci95"][0], "ci95_high": c["ci95"][1],
                    "equivalence": c["equivalence"]})
    return out
