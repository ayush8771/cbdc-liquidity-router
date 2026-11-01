"""Stage 1F - paired statistics for policy comparisons.

Design (fixed in the analysis plan before evaluation):
  * Unit of comparison: per-transaction paired difference between two policies,
    computed per checkpoint (seed x entropy coefficient).
  * Uncertainty: two-level cluster bootstrap - resample checkpoints (model
    uncertainty) AND simulation-date clusters (transactions on the same date
    share bridge state, so they are not independent). Percentile 95% CI and a
    two-sided bootstrap p-value.
  * Secondary: Wilcoxon signed-rank and sign counts on seed-averaged per-transaction
    differences (these assume independent transactions, so they are optimistic).
  * Multiple comparisons: Holm-Bonferroni over the pre-registered primary tests.
  * Practical equivalence: a difference is "practically negligible" if its 95% CI
    lies entirely within +/- the pre-registered margin.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def two_level_bootstrap(diff: pd.DataFrame, clusters: pd.Series, n_boot: int = 10000, seed: int = 0) -> dict:
    """diff: rows = transactions, columns = checkpoints (paired differences).
    clusters: cluster label per transaction (same index as diff).
    Returns point estimate, 95% percentile CI and two-sided bootstrap p-value for the mean."""
    if diff.isna().any().any():
        raise ValueError("diff contains NaN")
    if not diff.index.equals(clusters.index):
        raise ValueError("diff and clusters must share an index")
    codes, uniq = pd.factorize(clusters, sort=True)
    n_cl, k = len(uniq), diff.shape[1]
    sums = np.zeros((n_cl, k))
    np.add.at(sums, codes, diff.to_numpy(dtype=float))
    counts = np.bincount(codes, minlength=n_cl).astype(float)
    rng = np.random.default_rng(seed)
    w = rng.multinomial(n_cl, np.full(n_cl, 1.0 / n_cl), size=n_boot).astype(float)  # cluster weights
    v = rng.multinomial(k, np.full(k, 1.0 / k), size=n_boot).astype(float)          # checkpoint weights
    num = np.einsum("bc,ck,bk->b", w, sums, v)
    den = (w @ counts) * v.sum(axis=1)
    boots = num / den
    point = float(diff.to_numpy(dtype=float).mean())
    lo, hi = np.percentile(boots, [2.5, 97.5])
    p = float(min(1.0, 2 * min((boots <= 0).mean(), (boots >= 0).mean())))
    if np.allclose(boots, 0) and point == 0:
        p = 1.0
    return {"estimate": point, "ci95": [float(lo), float(hi)], "p_bootstrap": p, "n_boot": n_boot,
            "n_transactions": int(diff.shape[0]), "n_clusters": int(n_cl), "n_checkpoints": int(k)}


def wilcoxon_and_sign(per_tx_diff: np.ndarray) -> dict:
    d = np.asarray(per_tx_diff, dtype=float)
    pos, neg = int((d > 0).sum()), int((d < 0).sum())
    out = {"n": int(d.size), "positive": pos, "negative": neg, "zero": int(d.size - pos - neg)}
    if pos + neg == 0:
        out.update({"wilcoxon_p": 1.0, "wilcoxon_stat": None})
        return out
    from scipy.stats import wilcoxon  # scipy ships with scikit-learn (requirements.txt)
    res = wilcoxon(d[d != 0])
    out.update({"wilcoxon_p": float(res.pvalue), "wilcoxon_stat": float(res.statistic)})
    return out


def holm(pvalues: dict, alpha: float = 0.05) -> dict:
    """Holm-Bonferroni step-down. Returns {name: {"p": p, "p_holm": adjusted, "reject": bool}}."""
    items = sorted(pvalues.items(), key=lambda kv: kv[1])
    m, running, out = len(items), 0.0, {}
    for i, (name, p) in enumerate(items):
        adj = min(1.0, max(running, (m - i) * p))
        running = adj
        out[name] = {"p": float(p), "p_holm": float(adj), "reject": bool(adj < alpha)}
    return out


def equivalence(ci95, margin: float) -> str:
    lo, hi = ci95
    if -margin < lo and hi < margin:
        return "practically_negligible"
    if lo > 0:
        return "positive"
    if hi < 0:
        return "negative"
    return "inconclusive"
