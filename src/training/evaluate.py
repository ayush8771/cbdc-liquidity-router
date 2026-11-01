"""Stage 1D - evaluation: PPO vs cheapest-feasible vs liquidity-aware
waterfall, on identical held-out transactions, using the SAME
CBDCLiquidityEnv.step() execution/reward for all three policies."""
import numpy as np
import pandas as pd
import torch

from ..envs.cbdc_env import CBDCLiquidityEnv
from ..envs.stage1d_raw_obs_wrapper import Stage1DRawObservationWrapper
from .baselines import cheapest_feasible_action, liquidity_aware_waterfall_action
from .metrics import compute_metrics


def _make_eval_env(transactions_csv, structured_dir="data/structured", raw_dir="data/raw"):
    """Returns (env, regimes). `regimes` is the CSV's `regime` column
    (list, one per row, in the same order as env.requests_df) if present,
    else None - kept SEPARATE from env.requests_df (the env itself only
    needs the columns it actually consumes; regime is a diagnostic label,
    not environment state, so it is never fed into env.step()/reward)."""
    env = CBDCLiquidityEnv(structured_dir=structured_dir, raw_dir=raw_dir)
    tx_df = pd.read_csv(transactions_csv)
    env.requests_df = tx_df[["transaction_id", "sender_country", "receiver_country", "amount_usd", "simulation_date"]].reset_index(drop=True)
    env.max_steps = len(env.requests_df)
    regimes = tx_df["regime"].tolist() if "regime" in tx_df.columns else None
    return env, regimes


def run_baseline(env, name, regimes=None):
    records = []
    for i in range(env.max_steps):
        env.current_step = i
        req = env._current_request()
        amount = float(req["amount_usd"])
        simulation_date = req["simulation_date"]
        mask, bridges, _ = env.get_feasibility_mask(req)

        if name == "cheapest_feasible":
            action = cheapest_feasible_action(bridges, mask)
        elif name == "liquidity_waterfall":
            action = liquidity_aware_waterfall_action(bridges, mask, amount, simulation_date)
        else:
            raise ValueError(name)

        env.current_step = i
        obs, reward, term, trunc, info = env.step(action)
        record = {
            "amount": amount, "reward": reward,
            "executed_total": info["executed_total"], "unrouted": info["unrouted"],
            "action": list(action),
            "latency_term": info["reward_components"]["latency_term"],
            "risk_term": info["reward_components"]["risk_term"],
            "cost_term": info["reward_components"]["cost_term"],
        }
        if regimes is not None:
            record["regime"] = regimes[i]
        records.append(record)
    return compute_metrics(records)


def run_ppo(wrapped_env, net, device="cpu", regimes=None):
    base_env = wrapped_env.env.unwrapped
    device = torch.device(device)
    records = []
    with torch.no_grad():
        for i in range(base_env.max_steps):
            base_env.current_step = i
            req = base_env._current_request()
            amount = float(req["amount_usd"])
            mask, bridges, _ = base_env.get_feasibility_mask(req)
            obs = wrapped_env._wrap_obs(base_env._get_observation(req))
            raw_features = torch.tensor(obs["raw_features"], dtype=torch.float32, device=device).unsqueeze(0)
            windows = torch.tensor(obs["windows"], dtype=torch.float32, device=device).unsqueeze(0)
            mask_t = torch.tensor(mask, dtype=torch.bool, device=device).unsqueeze(0)

            action, _, _ = net.act(raw_features, windows, mask_t, deterministic=True)
            action_np = action.squeeze(0).cpu().numpy()
            base_env.current_step = i
            obs2, reward, term, trunc, info = base_env.step(action_np)
            record = {
                "amount": amount, "reward": reward,
                "executed_total": info["executed_total"], "unrouted": info["unrouted"],
                "action": list(action_np),
                "latency_term": info["reward_components"]["latency_term"],
                "risk_term": info["reward_components"]["risk_term"],
                "cost_term": info["reward_components"]["cost_term"],
            }
            if regimes is not None:
                record["regime"] = regimes[i]
            records.append(record)
    return compute_metrics(records)


def evaluate_all(test_csv, net, device="cpu"):
    cheapest_env, cheapest_regimes = _make_eval_env(test_csv)
    waterfall_env, waterfall_regimes = _make_eval_env(test_csv)
    ppo_env, ppo_regimes = _make_eval_env(test_csv)
    ppo_wrapped = Stage1DRawObservationWrapper(ppo_env)

    return {
        "cheapest_feasible": run_baseline(cheapest_env, "cheapest_feasible", regimes=cheapest_regimes),
        "liquidity_waterfall": run_baseline(waterfall_env, "liquidity_waterfall", regimes=waterfall_regimes),
        "ppo": run_ppo(ppo_wrapped, net, device=device, regimes=ppo_regimes),
    }