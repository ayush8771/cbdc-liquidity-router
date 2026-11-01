"""Stage 1D - inference-time capped-simplex projection of an allocation.

Experimental, post-hoc wrapper for evaluation only. It does NOT change the
PPO model, its training, the environment, or the reward. Given an
allocation `action` (fractions of `amount` per slot) and per-slot available
liquidity, it returns the Euclidean projection of the action onto

    { x : 0 <= x_i <= cap_i  (feasible slots),  x_i = 0 (infeasible),  sum x = 1 }

with cap_i = liquidity_i / amount. The liquidity values are the same
dynamic-state values already present in the policy's observation and used
by env.step() execution, so no extra information is introduced.

If combined capacity is below 1 (amount exceeds combined liquidity) the set
is empty; the projection then returns x_i = cap_i (fill every feasible slot),
which is the closest achievable completion.

Input handling: NaN in `action` or in a feasible slot's cap raises
ValueError (no silent NaN allocation). Caps are clipped to [0, 1]; since a
non-negative allocation summing to 1 has x_i <= 1 anyway, a cap of 1 (or
+inf, or any value >= 1) means "no binding limit", so clipping does not
change the projection. Negative caps are treated as 0. Infinite action
values raise ValueError.
"""
import numpy as np


def project_capped_simplex(action, caps, mask, tol=1e-12, max_iter=200):
    """Euclidean projection of `action` onto the capped simplex.

    Args:
        action: (K,) allocation fractions.
        caps: (K,) upper bounds (liquidity / amount); ignored where mask is False.
        mask: (K,) bool, feasible slots.
    Returns:
        (K,) float64 projected allocation; zeros if no feasible slot.
    """
    action = np.asarray(action, dtype=np.float64)
    caps = np.asarray(caps, dtype=np.float64)
    mask = np.asarray(mask, dtype=bool)
    out = np.zeros_like(action)
    if not mask.any():
        return out

    a = action[mask]
    if not np.all(np.isfinite(a)):
        raise ValueError("action contains NaN or infinite values on feasible slots")
    if np.any(np.isnan(caps[mask])):
        raise ValueError("caps contain NaN on feasible slots")
    u = np.clip(caps[mask], 0.0, 1.0)  # +inf / >=1 -> 1 (non-binding); negative -> 0
    if u.sum() <= 1.0:
        out[mask] = u
        return out

    # x(tau) = clip(a - tau, 0, u) is non-increasing in tau; find sum x(tau) = 1 by bisection.
    lo, hi = a.min() - u.max() - 1.0, a.max()  # sum(x(lo)) = sum(u) > 1, sum(x(hi)) = 0
    for _ in range(max_iter):
        tau = 0.5 * (lo + hi)
        s = np.clip(a - tau, 0.0, u).sum()
        if abs(s - 1.0) <= tol:
            break
        if s > 1.0:
            lo = tau
        else:
            hi = tau
    x = np.clip(a - tau, 0.0, u)
    # Remove residual bisection error on slots with headroom, keeping caps exact.
    resid = 1.0 - x.sum()
    free = (x > 0) & (x < u) if resid < 0 else (x < u)
    if free.any() and abs(resid) > 0:
        x[free] += resid / free.sum()
        x = np.clip(x, 0.0, u)
    out[mask] = x
    return out
