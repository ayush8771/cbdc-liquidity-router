"""Stage 1D - evaluation: PPO vs cheapest-feasible vs liquidity-aware
waterfall, on identical held-out transactions, using the SAME
CBDCLiquidityEnv.step() execution/reward for all three policies."""
import numpy as np
import pandas as pd
import torch

from ..envs.cbdc_env import CBDCLiquidityEnv
from ..envs.stage1d_raw_obs_wrapper import Stage1DRawObservationWrapper
from .baselines import cheapest_feasible_action, liquidity_aware_waterfall_action


def _make_eval_env(transactions_csv, structured_dir="data/structured", raw_dir="data/raw"):
    env = CBDCLiquidityEnv(structured_dir=structured_dir, raw_dir=raw_dir)
    tx_df = pd.read_csv(transactions_csv)
    env.requests_df = tx_df[["transaction_id", "sender_country", "receiver_country", "amount_usd", "simulation_date"]].reset_index(drop=True)
    env.max_steps = len(env.requests_df)
    return env


def _metrics_from_run(records):
    df = pd.DataFrame(records)
    total_amount = df["amount"].sum()
    return {
        "n_transactions": len(df),
        "mean_reward": float(df["reward"].mean()),
        "total_executed": float(df["executed_total"].sum()),
        "total_unrouted": float(df["unrouted"].sum()),
        "completion_rate": float((df["unrouted"] < 1e-6).mean()),
        "liquidity_utilization": float(df["executed_total"].sum() / total_amount) if total_amount > 0 else 0.0,
        "mean_bridges_used": float(df["bridges_used"].mean()),
        "mean_split_ratio": float(df["bridges_used"].apply(lambda n: 1.0 if n >= 2 else 0.0).mean()),
        "mean_latency_cost": float(df["latency_term"].mean()),
        "mean_risk_cost": float(df["risk_term"].mean()),
        "mean_cost_term": float(df["cost_term"].mean()),
    }


def run_baseline(env, name):
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
        records.append({
            "amount": amount, "reward": reward,
            "executed_total": info["executed_total"], "unrouted": info["unrouted"],
            "bridges_used": int(sum(1 for a in action if a > 1e-6)),
            "latency_term": info["reward_components"]["latency_term"],
            "risk_term": info["reward_components"]["risk_term"],
            "cost_term": info["reward_components"]["cost_term"],
        })
    return _metrics_from_run(records)


def run_ppo(wrapped_env, net, device="cpu"):
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
            records.append({
                "amount": amount, "reward": reward,
                "executed_total": info["executed_total"], "unrouted": info["unrouted"],
                "bridges_used": int(sum(1 for a in action_np if a > 1e-6)),
                "latency_term": info["reward_components"]["latency_term"],
                "risk_term": info["reward_components"]["risk_term"],
                "cost_term": info["reward_components"]["cost_term"],
            })
    return _metrics_from_run(records)


def evaluate_all(test_csv, net, device="cpu"):
    cheapest_env = _make_eval_env(test_csv)
    waterfall_env = _make_eval_env(test_csv)
    ppo_env = _make_eval_env(test_csv)
    ppo_wrapped = Stage1DRawObservationWrapper(ppo_env)

    return {
        "cheapest_feasible": run_baseline(cheapest_env, "cheapest_feasible"),
        "liquidity_waterfall": run_baseline(waterfall_env, "liquidity_waterfall"),
        "ppo": run_ppo(ppo_wrapped, net, device=device),
    }
