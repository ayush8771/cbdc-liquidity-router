"""Stage 1F - backtest evaluation harness.

For one scenario, evaluates on every transaction, from the same per-transaction
environment state:
  ppo_original        deterministic PPO action (normalized Dirichlet concentration)
  ppo_projected       same action, capped-simplex projection onto current liquidity
  liquidity_waterfall existing baseline
  cheapest_feasible   existing baseline
All actions go through the unchanged CBDCLiquidityEnv.step(). Observations
(raw features + CNN windows) are built once per transaction per scenario and
reused across checkpoints. No training, no gradient, no environment/reward/PPO
change. Unrouted value is reported both as the environment computes it
(requested - executed) and amount-based (amount - executed).
"""
from __future__ import annotations

import time

import numpy as np
import pandas as pd
import torch

from ..envs.cbdc_env import CBDCLiquidityEnv
from ..envs.stage1d_raw_obs_wrapper import Stage1DRawObservationWrapper
from ..models.ppo_actor_critic import PPOActorCritic
from ..training.baselines import cheapest_feasible_action, liquidity_aware_waterfall_action
from ..training.capacity_projection import project_capped_simplex
from ..training.metrics import RELATIVE_UNROUTED_TOLERANCE, bridges_used, largest_allocation
from ..training.transaction_generator import true_regime_for_row
from .scenarios import injected_daily_state, perturb

REQUEST_COLUMNS = ["transaction_id", "sender_country", "receiver_country", "amount_usd", "simulation_date"]
DETERMINISTIC_POLICIES = ("liquidity_waterfall", "cheapest_feasible")
PPO_POLICIES = ("ppo_original", "ppo_projected")


def _step(env, i, action, amount):
    env.current_step = i
    _, reward, _, _, info = env.step(np.asarray(action, dtype=np.float64))
    rc = info["reward_components"]
    executed = float(info["executed_total"])
    amount_unrouted = max(amount - executed, 0.0)
    a = [float(x) for x in action]
    return {
        "reward": float(reward), "cost_term": float(rc["cost_term"]), "latency_term": float(rc["latency_term"]),
        "risk_term": float(rc["risk_term"]), "env_unrouted_term": float(rc["unrouted_term"]),
        "executed": executed, "env_unrouted": float(info["unrouted"]), "amount_unrouted": amount_unrouted,
        "amount_completed": amount_unrouted <= RELATIVE_UNROUTED_TOLERANCE * amount,
        "env_completed": float(info["unrouted"]) <= RELATIVE_UNROUTED_TOLERANCE * amount,
        "action_sum": float(sum(a)), "bridges_used": int(bridges_used(a)), "largest_share": float(largest_allocation(a)),
    }


def _load_net(path, device):
    net = PPOActorCritic().to(device)
    net.load_state_dict(torch.load(path, map_location=device, weights_only=True))
    net.eval()
    return net


def evaluate_scenario(eval_df: pd.DataFrame, scenario, base_daily_df: pd.DataFrame, checkpoints,
                      device: str = "cpu", batch_size: int = 256) -> pd.DataFrame:
    """checkpoints: list of (label, path). Returns one row per (policy, checkpoint, transaction)."""
    daily = perturb(base_daily_df, scenario)
    rows = []
    with injected_daily_state(daily):
        env = CBDCLiquidityEnv()
        env.requests_df = eval_df[REQUEST_COLUMNS].reset_index(drop=True)
        env.max_steps = len(env.requests_df)
        wrapped = Stage1DRawObservationWrapper(env)
        wrapped._daily_df = daily  # CNN windows see the same (stressed) state as execution

        n = env.max_steps
        ctx, raw_f, wins, masks = [], [], [], []
        for i in range(n):
            env.current_step = i
            req = env._current_request()
            amount, date = float(req["amount_usd"]), req["simulation_date"]
            mask, bridges, rejection = env.get_feasibility_mask(req)
            obs = wrapped._wrap_obs(env._get_observation(req))
            caps = np.zeros(len(mask))
            for j, b in enumerate(bridges):
                caps[j] = env._resolve_dynamic_state(b, req["sender_country"], req["receiver_country"], date)[0] / amount
            src = eval_df.iloc[i]
            ctx.append({
                "transaction_id": int(req["transaction_id"]), "source": src.get("source"),
                "corridor": f"{req['sender_country']}->{req['receiver_country']}", "simulation_date": str(date),
                "amount": amount, "regime_original": src.get("regime"),
                "regime_scenario": true_regime_for_row(req["sender_country"], req["receiver_country"], amount, date),
                "combined_capacity_share": float(caps[mask].sum()), "rejected": rejection is not None,
                "_mask": mask, "_bridges": bridges, "_caps": caps,
            })
            raw_f.append(obs["raw_features"])
            wins.append(obs["windows"])
            masks.append(mask)

        def emit(policy, ckpt, i, action, extra=None):
            c = ctx[i]
            rows.append({"scenario": scenario.name, "policy": policy, "checkpoint": ckpt,
                         **{k: v for k, v in c.items() if not k.startswith("_")},
                         **_step(env, i, action, c["amount"]), **(extra or {})})

        for i, c in enumerate(ctx):
            t0 = time.perf_counter()
            wf = liquidity_aware_waterfall_action(c["_bridges"], c["_mask"], c["amount"], c["simulation_date"])
            emit("liquidity_waterfall", "-", i, wf, {"decision_ms": (time.perf_counter() - t0) * 1e3})
            t0 = time.perf_counter()
            ch = cheapest_feasible_action(c["_bridges"], c["_mask"])
            emit("cheapest_feasible", "-", i, ch, {"decision_ms": (time.perf_counter() - t0) * 1e3})

        rf = torch.tensor(np.stack(raw_f), dtype=torch.float32)
        wn = torch.tensor(np.stack(wins), dtype=torch.float32)
        mk = torch.tensor(np.stack(masks), dtype=torch.bool)
        for label, path in checkpoints:
            net = _load_net(path, device)
            actions, per_tx_ms = [], []
            with torch.no_grad():
                for s in range(0, n, batch_size):
                    t0 = time.perf_counter()
                    a = net.act(rf[s:s + batch_size].to(device), wn[s:s + batch_size].to(device),
                                mk[s:s + batch_size].to(device), deterministic=True)[0].cpu().numpy()
                    dt = (time.perf_counter() - t0) * 1e3 / len(a)
                    actions.append(a)
                    per_tx_ms += [dt] * len(a)
            actions = np.concatenate(actions)
            for i, c in enumerate(ctx):
                emit("ppo_original", label, i, actions[i], {"decision_ms": per_tx_ms[i]})
                t0 = time.perf_counter()
                proj = project_capped_simplex(actions[i], c["_caps"], c["_mask"])
                emit("ppo_projected", label, i, proj, {"decision_ms": per_tx_ms[i] + (time.perf_counter() - t0) * 1e3})
    return pd.DataFrame(rows)


def reward_with_weights(df: pd.DataFrame, lam_latency=1.0, lam_risk=1.0, lam_unrouted=1.0) -> pd.Series:
    """Evaluation-time reward re-weighting from stored components, with the AMOUNT-based
    unrouted term (amount - executed) / amount. Does not change the environment's reward
    or the trained policies; it asks whether the policy COMPARISON is robust to the weights."""
    return (df["cost_term"] - lam_latency * df["latency_term"] - lam_risk * df["risk_term"]
            - lam_unrouted * df["amount_unrouted"] / df["amount"])
