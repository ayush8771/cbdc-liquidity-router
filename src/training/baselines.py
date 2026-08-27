"""Stage 1D - baseline routing policies.

Both baselines use the SAME dynamic_bridge_state.py lookup and the SAME
min(requested, liquidity) execution rule as the PPO-driven environment -
implemented as pure action-producing functions fed into the real
CBDCLiquidityEnv.step(), not a parallel/hidden execution path.
"""
import numpy as np

from ..envs.dynamic_bridge_state import get_dynamic_state
from ..models.stage1c_windowing import MAX_SLOTS


def cheapest_feasible_action(bridges, mask):
    """Routes 100% of the amount to the single lowest-fee feasible
    bridge. Returns a (MAX_SLOTS,) allocation vector summing to 1 over
    feasible slots (or all-zero if none feasible)."""
    action = np.zeros(MAX_SLOTS, dtype=np.float32)
    feasible_idxs = [i for i in range(len(bridges)) if mask[i]]
    if not feasible_idxs:
        return action
    cheapest_i = min(feasible_idxs, key=lambda i: bridges[i]["fee"])
    action[cheapest_i] = 1.0
    return action


def liquidity_aware_waterfall_action(bridges, mask, amount, simulation_date):
    """Sorts feasible bridges by fee ascending, fills each up to its
    CURRENT dynamic liquidity_level (via the same dynamic_bridge_state
    lookup PPO/execution use) until amount is exhausted or bridges run
    out. Returns an allocation vector (fractions of `amount`, summing to
    <=1; any remainder is intentionally left unrouted, matching the
    approved no-redistribution execution rule)."""
    action = np.zeros(MAX_SLOTS, dtype=np.float32)
    feasible_idxs = [i for i in range(len(bridges)) if mask[i]]
    if not feasible_idxs or amount <= 0:
        return action

    feasible_idxs.sort(key=lambda i: bridges[i]["fee"])

    remaining = amount
    for i in feasible_idxs:
        if remaining <= 0:
            break
        bridge_uid = bridges[i]["bridge_id"]
        liquidity, _congestion = get_dynamic_state(bridge_uid, simulation_date)
        fill = min(remaining, liquidity)
        action[i] = fill / amount
        remaining -= fill

    return action
