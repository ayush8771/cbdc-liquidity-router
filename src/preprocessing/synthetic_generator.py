"""Daily synthetic liquidity/congestion generator (Stage 1B Specification
v3 §3/§6, and FINAL Approved Specification §2A/§2C).

OU + jump-diffusion, daily timestep. Real-conditioned via lagged
quarterly corridor_friction/corridor_baseline_speed_log1p and lagged
monthly macro_risk_proxy, where those are available. All six
hyperparameters are configurable (Specification v2 §4 / v3 §3) - base
values below are explicitly PLACEHOLDERS, not calibrated.

Reproducibility: every (bridge_id, date) draw is seeded deterministically
via a hash of (master_seed, bridge_id, date) so generation order/
parallelization never changes the output (Specification v2 §12/v3).
"""
import hashlib
import numpy as np
import pandas as pd

DEFAULT_HYPERPARAMS = {
    "beta_friction": -0.2,
    "beta_risk": 1.0,
    "sigma_base": 0.02,          # 2% of capacity/day
    "sigma_congestion": 0.10,    # log1p-hour units
    "lambda_jump": 0.05,         # arrivals/day
    "jump_size_mean_pct": 0.10,  # 10% of baseline
}


def _sub_seed(master_seed, bridge_id, date):
    key = f"{master_seed}|{bridge_id}|{date.isoformat()}"
    digest = hashlib.sha256(key.encode()).hexdigest()
    return int(digest[:8], 16)


def generate_daily_series(
    bridge_id,
    base_capacity,
    date_range,
    quarterly_friction,     # dict: (year, quarter) -> corridor_friction (already lagged by caller)
    quarterly_speed_log1p,  # dict: (year, quarter) -> corridor_baseline_speed_log1p (already lagged)
    monthly_macro_risk,     # dict: (year, month) -> macro_risk_proxy (already lagged)
    friction_mean,
    friction_std,
    risk_mean,
    risk_std,
    master_seed=42,
    hyperparams=None,
    data_source_tag="real_rpw_derived",
):
    """Returns a DataFrame with one row per (bridge_id, date).

    friction_mean/friction_std/risk_mean/risk_std are REQUIRED, not
    computed internally. Per the train-only-normalization fix
    (Specification v3 follow-up review), these must be fitted ONCE from
    the training period only (see normalization.py) and passed in frozen
    - computing them here from whatever quarterly_friction/monthly_macro_risk
    dicts happen to be passed in would silently leak validation/test
    distribution information into every period's z-score, including
    training periods generated in the same call. This function no longer
    has any path that computes normalization statistics itself.
    """
    hp = dict(DEFAULT_HYPERPARAMS)
    if hyperparams:
        hp.update(hyperparams)

    rows = []
    liquidity = base_capacity
    congestion = 0.0

    for date in date_range:
        q = (date.year, (date.month - 1) // 3 + 1)
        m = (date.year, date.month)

        friction = quarterly_friction.get(q)
        z_friction = 0.0 if friction is None else (friction - friction_mean) / (friction_std or 1.0)
        mu_liquidity = base_capacity * (1 + hp["beta_friction"] * z_friction)

        risk = monthly_macro_risk.get(m)
        z_risk = 0.0 if (risk is None or pd.isna(risk)) else (risk - risk_mean) / (risk_std or 1.0)
        sigma_liquidity = hp["sigma_base"] * base_capacity * (1 + hp["beta_risk"] * z_risk)
        sigma_liquidity = max(sigma_liquidity, 0.0)

        speed_log1p = quarterly_speed_log1p.get(q)
        mu_congestion = speed_log1p if speed_log1p is not None else 0.0

        seed = _sub_seed(master_seed, bridge_id, date)
        rng = np.random.default_rng(seed)

        theta = 0.1  # mean-reversion speed, fixed (not in the configurable-6 set)
        liquidity = liquidity + theta * (mu_liquidity - liquidity) + rng.normal(0, sigma_liquidity)
        if rng.random() < hp["lambda_jump"]:
            jump = rng.exponential(hp["jump_size_mean_pct"] * base_capacity)
            liquidity -= jump
        liquidity = max(liquidity, 0.0)

        congestion = congestion + theta * (mu_congestion - congestion) + rng.normal(0, hp["sigma_congestion"])
        if rng.random() < hp["lambda_jump"]:
            congestion += rng.exponential(hp["jump_size_mean_pct"] * max(mu_congestion, 0.1))
        congestion = max(congestion, 0.0)

        rows.append({
            "bridge_id": bridge_id,
            "date": date,
            "liquidity_level": liquidity,
            "congestion_level": congestion,
            "conditioning_quarter": f"{q[0]}_{q[1]}Q",
            "mu_liquidity_used": mu_liquidity,
            "sigma_liquidity_used": sigma_liquidity,
            "mu_congestion_used": mu_congestion,
            "sigma_congestion_used": hp["sigma_congestion"],
            "data_source_tag": data_source_tag,
        })

    return pd.DataFrame(rows)
