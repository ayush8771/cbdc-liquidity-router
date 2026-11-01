"""Stage 1D - evaluation/diagnostic metrics.

Pure functions operating on evaluation records, kept separate from
evaluate.py's env-execution loop so they can be unit tested with hand-
crafted inputs, independent of the environment/CNN/PPO.

None of this module changes execution, reward, or training behavior -
it only computes diagnostics from records already produced by the
(unmodified) env.step() path.
"""
import numpy as np
import pandas as pd

# Fraction of `amount` below which unrouted is treated as "effectively
# routed" for completion_rate purposes. Chosen because amounts range from
# roughly $1 to ~$495,000 in the generated datasets (see
# transaction_generator.py) - a fixed absolute USD threshold (the
# previous 1e-6 constant) is meaningless across that range (e.g. $1e-6 is
# a stricter bar for a $495,000 transaction than for a $1 one, and a
# trivially strict bar in general given float rounding in execution
# math). A RELATIVE tolerance scales with the transaction itself.
RELATIVE_UNROUTED_TOLERANCE = 1e-4  # 0.01% of the transaction amount

# Minimum allocation share (of `amount`) for a bridge to count as
# "meaningfully used" in bridges_used / multi_bridge_rate / entropy -
# distinguishes a real allocation from float noise around zero.
MEANINGFUL_ALLOCATION_THRESHOLD = 1e-6


def is_completed(unrouted, amount, relative_tolerance=RELATIVE_UNROUTED_TOLERANCE):
    """True if unrouted is within `relative_tolerance` of `amount` (i.e.
    unrouted <= relative_tolerance * amount). For amount<=0 (should not
    occur in real data), falls back to an absolute check against 0."""
    if amount <= 0:
        return abs(unrouted) < 1e-9
    return unrouted <= relative_tolerance * amount


def bridges_used(action, threshold=MEANINGFUL_ALLOCATION_THRESHOLD):
    """Count of allocation slots with a share > threshold."""
    return int(sum(1 for a in action if a > threshold))


def is_multi_bridge(action, threshold=MEANINGFUL_ALLOCATION_THRESHOLD):
    """True if >=2 slots have a MEANINGFUL allocation share (not just
    any nonzero float noise)."""
    return bridges_used(action, threshold) >= 2


def largest_allocation(action):
    """Largest single-slot share of the action vector. 0.0 for an
    all-zero (fully unrouted/rejected) action."""
    if len(action) == 0:
        return 0.0
    return float(max(action))


def allocation_entropy(action, threshold=MEANINGFUL_ALLOCATION_THRESHOLD, base=2.0):
    """Shannon entropy (in bits, base=2 by default) of the allocation
    split, CONDITIONAL on the action's nonzero mass - i.e. computed over
    action[action>threshold] renormalized to sum to 1, not over the raw
    6-slot vector (which would conflate "how evenly split" with "how much
    was routed at all" - those are the job of multi_bridge_rate /
    liquidity_utilization respectively, not entropy).

    Returns 0.0 for an all-zero action (nothing routed - no split to
    measure) and 0.0 for a single-slot action (one bridge = zero entropy
    by definition, not undefined)."""
    action = np.asarray(action, dtype=float)
    used = action[action > threshold]
    if len(used) == 0:
        return 0.0
    p = used / used.sum()
    if len(p) == 1:
        return 0.0
    return float(-np.sum(p * np.log(p)) / np.log(base))


def compute_metrics(records):
    """records: list of dicts, each with at minimum:
        amount, reward, executed_total, unrouted, action (list[float]),
        latency_term, risk_term, cost_term
    and optionally: regime (str)

    Returns the full metrics dict, including per-regime breakdowns when
    `regime` is present in the records (never defaulted to 'unknown' -
    if a record lacks a regime key entirely, it is simply excluded from
    the per-regime breakdown, not mislabeled).
    """
    df = pd.DataFrame(records)
    total_amount = df["amount"].sum()

    completed = df.apply(lambda r: is_completed(r["unrouted"], r["amount"]), axis=1)
    bridges_used_col = df["action"].apply(bridges_used)
    multi_bridge_col = df["action"].apply(is_multi_bridge)
    largest_alloc_col = df["action"].apply(largest_allocation)
    entropy_col = df["action"].apply(allocation_entropy)

    metrics = {
        "n_transactions": len(df),
        "mean_reward": float(df["reward"].mean()),
        "total_executed": float(df["executed_total"].sum()),
        "total_unrouted": float(df["unrouted"].sum()),
        "completion_rate": float(completed.mean()),
        "completion_rate_tolerance": f"unrouted <= {RELATIVE_UNROUTED_TOLERANCE:.0e} * amount (relative, not absolute USD)",
        "liquidity_utilization": float(df["executed_total"].sum() / total_amount) if total_amount > 0 else 0.0,
        "mean_bridges_used": float(bridges_used_col.mean()),
        "multi_bridge_rate": float(multi_bridge_col.mean()),
        "mean_largest_allocation": float(largest_alloc_col.mean()),
        "mean_allocation_entropy": float(entropy_col.mean()),
        "mean_latency_cost": float(df["latency_term"].mean()),
        "mean_risk_cost": float(df["risk_term"].mean()),
        "mean_cost_term": float(df["cost_term"].mean()),
    }

    if "regime" in df.columns and df["regime"].notna().any():
        by_regime = {}
        for regime_value, sub in df.groupby("regime"):
            sub_completed = sub.apply(lambda r: is_completed(r["unrouted"], r["amount"]), axis=1)
            sub_multi = sub["action"].apply(is_multi_bridge)
            by_regime[regime_value] = {
                "n_transactions": len(sub),
                "mean_reward": float(sub["reward"].mean()),
                "completion_rate": float(sub_completed.mean()),
                "multi_bridge_rate": float(sub_multi.mean()),
                "mean_bridges_used": float(sub["action"].apply(bridges_used).mean()),
            }
        metrics["by_regime"] = by_regime

    return metrics