"""Capacity-aware allocation experiment (Stage 1D, validation only).

Run from the repository root:
    python run_capacity_projection_experiment.py

Compares, on the VALIDATION split, for each of the six multi-seed
checkpoints (seeds 42/123/2026 x ENTROPY_COEF 0.0/0.005):
  1. ppo_original   - deterministic PPO action (normalized Dirichlet concentration)
  2. ppo_projected  - the same action, Euclidean-projected at inference time onto
                      the capped simplex {0 <= x_i <= liquidity_i/amount, sum x = 1}
                      (src/training/capacity_projection.py)
  3. liquidity_waterfall - existing baseline
All three go through the same CBDCLiquidityEnv.step() from the same state.

No training, no tuning, and nothing existing is modified. The test split is never
loaded. Before evaluating the projection, each checkpoint's original PPO and the
waterfall must reproduce the saved validation metrics exactly; otherwise the
script stops.

Caveat: validation was also used for checkpoint selection in the multi-seed run,
so absolute PPO numbers are optimistic; the paired original-vs-projected
comparison uses the same checkpoints and is unaffected by that choice.

Outputs: outputs/experiments/stage1d_capacity_projection_<timestamp>/
"""

from __future__ import annotations

import hashlib
import json
import platform
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import torch

from src.envs.stage1d_raw_obs_wrapper import Stage1DRawObservationWrapper
from src.models.ppo_actor_critic import PPOActorCritic
from src.training.baselines import liquidity_aware_waterfall_action
from src.training.capacity_projection import project_capped_simplex
from src.training.evaluate import _make_eval_env
from src.training.metrics import compute_metrics, is_completed

VAL_CSV = "data/processed/stage1d_transactions_validation.csv"
MULTISEED_DIR = Path("outputs/experiments/stage1d_entropy_multiseed_20261101_180551")
SEEDS = (42, 123, 2026)
CONDITIONS = (("entropy000", 0.0), ("entropy005", 0.005))
POLICIES = ("ppo_original", "ppo_projected", "liquidity_waterfall")
METRICS = ("completion_rate", "total_unrouted", "mean_reward", "mean_cost_term",
           "mean_latency_cost", "mean_risk_cost", "liquidity_utilization",
           "mean_bridges_used", "mean_largest_allocation")
REPLAY_TOL = 1e-6
# Shifts below this are float32->float64 renormalization noise (PPO actions are float32 and sum
# to 1 only to ~1e-7), not capacity corrections.
CHANGE_TOL = 1e-6
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


def _git(*args):
    try:
        return subprocess.check_output(["git", *args], text=True).strip()
    except Exception:
        return None


def _sha(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def _save(path, obj):
    path.write_text(json.dumps(obj, indent=2, default=lambda v: v.item() if hasattr(v, "item") else str(v)),
                    encoding="utf-8")


def _record(amount, action, reward, info, regime):
    rc = info["reward_components"]
    return {"amount": amount, "reward": float(reward), "executed_total": info["executed_total"],
            "unrouted": info["unrouted"], "action": list(map(float, action)),
            "latency_term": rc["latency_term"], "risk_term": rc["risk_term"], "cost_term": rc["cost_term"],
            "regime": regime}


def evaluate_checkpoint(ckpt):
    env, regimes = _make_eval_env(VAL_CSV)
    wrapped = Stage1DRawObservationWrapper(env)
    tx = pd.read_csv(VAL_CSV)
    net = PPOActorCritic().to(DEVICE)
    net.load_state_dict(torch.load(ckpt, map_location=DEVICE, weights_only=True))
    net.eval()

    recs = {p: [] for p in POLICIES}
    rows = []
    with torch.no_grad():
        for i in range(env.max_steps):
            env.current_step = i
            req = env._current_request()
            amount, date = float(req["amount_usd"]), req["simulation_date"]
            mask, bridges, _ = env.get_feasibility_mask(req)
            obs = wrapped._wrap_obs(env._get_observation(req))
            rf = torch.tensor(obs["raw_features"], dtype=torch.float32, device=DEVICE).unsqueeze(0)
            wn = torch.tensor(obs["windows"], dtype=torch.float32, device=DEVICE).unsqueeze(0)
            mt = torch.tensor(mask, dtype=torch.bool, device=DEVICE).unsqueeze(0)
            a_orig = net.act(rf, wn, mt, deterministic=True)[0].squeeze(0).cpu().numpy()

            # Caps from the same dynamic-state lookup env.step() uses for execution.
            caps = np.zeros(len(mask))
            for j, b in enumerate(bridges):
                caps[j] = env._resolve_dynamic_state(b, req["sender_country"], req["receiver_country"], date)[0] / amount
            a_proj = project_capped_simplex(a_orig, caps, mask)
            a_wf = liquidity_aware_waterfall_action(bridges, mask, amount, date)

            out = {}
            for name, a in (("ppo_original", a_orig), ("ppo_projected", a_proj), ("liquidity_waterfall", a_wf)):
                env.current_step = i  # identical state for every policy
                _, r, _, _, info = env.step(a)
                recs[name].append(_record(amount, a, r, info, regimes[i]))
                out[name] = (float(r), info)

            row = {"row_index": i, "transaction_id": tx.transaction_id[i], "regime": regimes[i], "amount": amount,
                   "combined_capacity_share": float(caps[mask].sum()),
                   "projection_changed": bool(np.abs(a_proj - a_orig).sum() > CHANGE_TOL),
                   "projection_l1_shift": float(np.abs(a_proj - a_orig).sum()),
                   "orig_action_sum": float(a_orig.sum()), "proj_action_sum": float(a_proj.sum())}
            for name, (r, info) in out.items():
                row[f"{name}_reward"] = r
                row[f"{name}_unrouted"] = info["unrouted"]
                row[f"{name}_completed"] = is_completed(info["unrouted"], amount)
                row[f"{name}_cost_term"] = info["reward_components"]["cost_term"]
                row[f"{name}_latency_term"] = info["reward_components"]["latency_term"]
            rows.append(row)
    return {p: compute_metrics(recs[p]) for p in POLICIES}, pd.DataFrame(rows)


def replay_check(label, metrics, saved_path):
    saved = json.loads(Path(saved_path).read_text(encoding="utf-8"))
    out, ok = {}, True
    for mine, theirs in (("ppo_original", "ppo"), ("liquidity_waterfall", "liquidity_waterfall")):
        for k in ("mean_reward", "completion_rate", "total_unrouted", "liquidity_utilization"):
            s, r = float(saved[theirs][k]), float(metrics[mine][k])
            m = abs(s - r) <= REPLAY_TOL * max(1.0, abs(s))
            ok &= m
            out[f"{mine}.{k}"] = {"saved": s, "replayed": r, "abs_diff": abs(s - r), "match": m}
    return ok, {"label": label, "saved_metrics": str(saved_path), "match": bool(ok), "fields": out}


def stats(vals):
    a = np.asarray(vals, dtype=float)
    return {"mean": float(a.mean()), "sd": float(a.std(ddof=1)) if len(a) > 1 else 0.0, "values": a.tolist()}


def main():
    specs = [(f"seed{s}_{c}", s, coef, MULTISEED_DIR / f"seed{s}" / c / "ppo_checkpoint.pt",
              MULTISEED_DIR / f"seed{s}" / c / "validation_metrics.json")
             for s in SEEDS for c, coef in CONDITIONS]
    for *_, ck, js in specs:
        if not ck.is_file() or not js.is_file():
            raise FileNotFoundError(ck if not ck.is_file() else js)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = Path("outputs/experiments") / f"stage1d_capacity_projection_{ts}"
    out_dir.mkdir(parents=True, exist_ok=False)

    status = _git("status", "--porcelain")
    files = ["run_capacity_projection_experiment.py", "src/training/capacity_projection.py"]
    config = {
        "experiment": "stage1d_capacity_projection_validation",
        "policies": list(POLICIES),
        "projection": "Euclidean projection onto {0<=x_i<=liquidity_i/amount on feasible slots, sum x = 1}; "
                      "if combined capacity < amount, x_i = cap_i",
        "split": "validation", "validation_csv": VAL_CSV, "validation_sha256": _sha(VAL_CSV),
        "test_split_used": False, "training_performed": False,
        "ppo_action_mode": "deterministic (normalized Dirichlet concentration)",
        "checkpoints": [{"label": l, "seed": s, "entropy_coef": c, "checkpoint": str(ck), "sha256": _sha(ck),
                         "saved_metrics": str(js)} for l, s, c, ck, js in specs],
        "git_head": _git("rev-parse", "HEAD"), "git_dirty": bool(status),
        "git_dirty_files": status.splitlines() if status else [],
        "code_sha256": {f: _sha(f) for f in files},
        "code_git_blob": {f: _git("hash-object", f) for f in files},
        "python": platform.python_version(), "torch": torch.__version__, "device": DEVICE,
        "started_at": ts,
    }
    _save(out_dir / "experiment_config.json", config)

    all_metrics, checks, frames = {}, [], []
    for label, seed, coef, ck, js in specs:
        print(f"evaluating {label} ...", flush=True)
        m, df = evaluate_checkpoint(ck)
        ok, chk = replay_check(label, m, js)
        checks.append(chk)
        print(f"  replay match={ok}", flush=True)
        all_metrics[label] = m
        frames.append(df.assign(checkpoint=label, seed=seed, entropy_coef=coef))
        _save(out_dir / f"metrics_{label}.json", m)
    _save(out_dir / "replay_check.json", checks)
    if not all(c["match"] for c in checks):
        print("REPLAY MISMATCH - results not valid; see replay_check.json", file=sys.stderr)
        sys.exit(2)

    per_tx = pd.concat(frames, ignore_index=True)
    per_tx.to_csv(out_dir / "per_transaction.csv", index=False)

    labels = [s[0] for s in specs]
    summary = {"n_checkpoints": len(labels), "overall": {}, "by_entropy_coef": {}, "by_regime": {},
               "paired_projected_minus_original": {}, "projection_effect": {}}
    for k in METRICS:
        summary["overall"][k] = {p: stats([all_metrics[l][p][k] for l in labels]) for p in POLICIES}
        summary["paired_projected_minus_original"][k] = stats(
            [all_metrics[l]["ppo_projected"][k] - all_metrics[l]["ppo_original"][k] for l in labels])
    for cname, coef in CONDITIONS:
        ls = [s[0] for s in specs if s[2] == coef]
        summary["by_entropy_coef"][cname] = {
            k: {p: stats([all_metrics[l][p][k] for l in ls]) for p in POLICIES}
            for k in ("completion_rate", "total_unrouted", "mean_reward")}
    regimes = sorted(all_metrics[labels[0]]["ppo_original"].get("by_regime", {}))
    for g in regimes:
        summary["by_regime"][g] = {
            k: {p: stats([all_metrics[l][p]["by_regime"][g][k] for l in labels]) for p in POLICIES}
            for k in ("completion_rate", "mean_reward")}
    summary["projection_effect"] = {
        "rows_changed_per_checkpoint": per_tx.groupby("checkpoint").projection_changed.sum().to_dict(),
        "mean_l1_shift_when_changed": float(per_tx.loc[per_tx.projection_changed, "projection_l1_shift"].mean())
        if per_tx.projection_changed.any() else 0.0,
        "changed_rows_by_regime": per_tx[per_tx.projection_changed].regime.value_counts().to_dict(),
        "change_tol_l1": CHANGE_TOL,
        "reward_delta_on_changed_rows": {k: v for k, v in stats(
            (per_tx.ppo_projected_reward - per_tx.ppo_original_reward)[per_tx.projection_changed]).items() if k != "values"},
        "on_original_failures": {
            "n": int((~per_tx.ppo_original_completed).sum()),
            "projected_completes": int(per_tx.loc[~per_tx.ppo_original_completed, "ppo_projected_completed"].sum()),
            **{f"mean_{m}_delta_proj_minus_orig": float((per_tx[f"ppo_projected_{m}"] - per_tx[f"ppo_original_{m}"])[~per_tx.ppo_original_completed].mean())
               for m in ("reward", "cost_term", "latency_term", "unrouted")},
            "mean_reward_delta_proj_minus_waterfall": float((per_tx.ppo_projected_reward - per_tx.liquidity_waterfall_reward)[~per_tx.ppo_original_completed].mean()),
        },
        "changed_but_original_completed": int((per_tx.projection_changed & per_tx.ppo_original_completed).sum()),
        "max_abs_reward_delta_on_unchanged_rows": float(
            (per_tx.ppo_projected_reward - per_tx.ppo_original_reward)[~per_tx.projection_changed].abs().max()),
        "proj_action_sum_min": float(per_tx.proj_action_sum.min()),
        "proj_action_sum_max": float(per_tx.proj_action_sum.max()),
        "projected_failures": int((~per_tx.ppo_projected_completed).sum()),
        "original_failures": int((~per_tx.ppo_original_completed).sum()),
        "waterfall_failures": int((~per_tx.liquidity_waterfall_completed).sum()),
        "projected_reward_ge_waterfall_rows": int((per_tx.ppo_projected_reward >= per_tx.liquidity_waterfall_reward).sum()),
        "n_rows": len(per_tx),
    }
    _save(out_dir / "summary.json", summary)

    print("\n=== VALIDATION, MEAN (SD) ACROSS 6 CHECKPOINTS ===")
    for k in METRICS:
        r = summary["overall"][k]
        print(f"{k:24s} " + " | ".join(f"{p}={r[p]['mean']:.6g} ({r[p]['sd']:.3g})" for p in POLICIES))
    print(json.dumps(summary["projection_effect"], indent=1, default=str))
    print(f"\nOutputs: {out_dir.resolve()}")


if __name__ == "__main__":
    main()
