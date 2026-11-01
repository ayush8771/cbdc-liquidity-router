"""Fresh synthetic holdout + evaluation of the six multi-seed checkpoints.

Run from the repository root:
    python run_holdout_evaluation.py

1. Generates a NEW holdout with the existing generator
   (src/training/transaction_generator.generate_split) and a new fixed seed.
   It uses the generator's "test" date window (2024-01-01 .. 2025-09-30, out of time
   relative to train/validation, gap buffers excluded) and new transaction IDs
   (400000+). Existing datasets are never read for generation and never written;
   the holdout is written to a NEW file and the script refuses to overwrite it.
   generate_all() is NOT used (it would overwrite the existing splits).
2. Evaluates, for each of the six checkpoints in the multi-seed experiment:
   ppo_original (deterministic), ppo_projected (inference-time capped-simplex
   projection), liquidity_waterfall. All three go through the same env.step()
   from the same per-transaction state.

Unrouted is reported two ways:
   env_unrouted    - as the environment reports it: requested - executed. An
                     amount that is never requested is NOT counted.
   amount_unrouted - max(amount - executed, 0) (what actually failed to move);
                     over_executed = max(executed - amount, 0) records float32
                     action-sum overshoot (cents) separately.
They differ only when an action requests less than 100% of the amount: the
projection and the waterfall do this when amount > combined liquidity
(exceeds_combined). Completion is reported under both definitions.

No training, tuning, or model/environment/reward/checkpoint changes.
Outputs: outputs/experiments/stage1d_holdout_eval_<timestamp>/
"""

from __future__ import annotations

import hashlib
import io
import json
import platform
import subprocess
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
from src.training.metrics import RELATIVE_UNROUTED_TOLERANCE, bridges_used
from src.training.transaction_generator import generate_split

HOLDOUT_SEED = 20261102          # new fixed seed (existing splits used 42)
HOLDOUT_WINDOW = "test"          # generator date window: 2024-01-01..2025-09-30
HOLDOUT_N = 500
HOLDOUT_START_ID = 400000        # existing splits use 100000/200000/300000
HOLDOUT_CSV = Path(f"data/processed/stage1d_transactions_holdout_seed{HOLDOUT_SEED}.csv")
EXISTING_SPLITS = [Path(f"data/processed/stage1d_transactions_{s}.csv") for s in ("train", "validation", "test")]

MULTISEED_DIR = Path("outputs/experiments/stage1d_entropy_multiseed_20261101_180551")
SEEDS = (42, 123, 2026)
CONDITIONS = (("entropy000", 0.0), ("entropy005", 0.005))
POLICIES = ("ppo_original", "ppo_projected", "liquidity_waterfall")
REGIME_ORDER = ("below_cheapest", "near_boundary", "splitting_needed", "exceeds_combined")
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


def make_holdout():
    before = {str(p): _sha(p) for p in EXISTING_SPLITS}
    df = generate_split(HOLDOUT_WINDOW, HOLDOUT_N, seed=HOLDOUT_SEED, start_id=HOLDOUT_START_ID)
    if HOLDOUT_CSV.exists():
        # Never overwrite: the regenerated holdout must be identical (after a CSV round trip) to the file.
        if not pd.read_csv(io.StringIO(df.to_csv(index=False))).equals(pd.read_csv(HOLDOUT_CSV)):
            raise FileExistsError(f"{HOLDOUT_CSV} exists and differs from the regenerated holdout; refusing to overwrite")
        reused = True
    else:
        df.to_csv(HOLDOUT_CSV, index=False)
        reused = False
    after = {str(p): _sha(p) for p in EXISTING_SPLITS}
    assert before == after, "existing splits changed during holdout generation"

    existing = pd.concat([pd.read_csv(p).assign(split=p.stem.split("_")[-1]) for p in EXISTING_SPLITS])
    key = ["sender_country", "receiver_country", "simulation_date", "amount_usd"]
    # Exact duplicates: keep BOTH transaction IDs (holdout and existing split) explicitly.
    merged = (df[key + ["transaction_id", "regime"]]
              .merge(existing[key + ["transaction_id", "regime", "split"]], on=key, how="inner",
                     suffixes=("_holdout", "_existing"))
              .rename(columns={"split": "existing_split"}))
    date_key = ["sender_country", "receiver_country", "simulation_date"]
    shared_dates = df.merge(existing[date_key + ["split"]].drop_duplicates(), on=date_key, how="inner")
    return df, {
        "generator": "src.training.transaction_generator.generate_split",
        "window": HOLDOUT_WINDOW, "seed": HOLDOUT_SEED,
        "effective_rng_seed": "seed + SPLIT_SEED_OFFSET['test'] (= seed + 2)",
        "n": HOLDOUT_N, "start_id": HOLDOUT_START_ID,
        "path": str(HOLDOUT_CSV), "sha256": _sha(HOLDOUT_CSV),
        "existing_splits_sha256_unchanged": before,
        "date_range": [df.simulation_date.min(), df.simulation_date.max()],
        "true_regime_counts": df.regime.value_counts().to_dict(),
        "intended_regime_counts": df.intended_regime.value_counts().to_dict(),
        "corridor_counts": (df.sender_country + "->" + df.receiver_country).value_counts().to_dict(),
        "holdout_file_reused_after_identity_check": reused,
        "exact_duplicate_rows_with_existing_splits": int(len(merged)),
        "exact_duplicate_rows_detail": merged.to_dict(orient="records"),
        "holdout_rows_sharing_corridor_and_date_with_existing": shared_dates.groupby("split").size().to_dict(),
        "holdout_rows_sharing_any_date_with_existing": {
            s: int(df.simulation_date.isin(existing[existing.split == s].simulation_date).sum())
            for s in existing.split.unique()},
        "transaction_id_overlap_with_existing": int(df.transaction_id.isin(existing.transaction_id).sum()),
    }


def evaluate_checkpoint(label, ckpt):
    env, regimes = _make_eval_env(str(HOLDOUT_CSV))
    wrapped = Stage1DRawObservationWrapper(env)
    tx = pd.read_csv(HOLDOUT_CSV)
    net = PPOActorCritic().to(DEVICE)
    net.load_state_dict(torch.load(ckpt, map_location=DEVICE, weights_only=True))
    net.eval()

    rows = []
    with torch.no_grad():
        for i in range(env.max_steps):
            env.current_step = i
            req = env._current_request()
            amount, date = float(req["amount_usd"]), req["simulation_date"]
            mask, bridges, rejection = env.get_feasibility_mask(req)
            obs = wrapped._wrap_obs(env._get_observation(req))
            rf = torch.tensor(obs["raw_features"], dtype=torch.float32, device=DEVICE).unsqueeze(0)
            wn = torch.tensor(obs["windows"], dtype=torch.float32, device=DEVICE).unsqueeze(0)
            mt = torch.tensor(mask, dtype=torch.bool, device=DEVICE).unsqueeze(0)
            a_orig = net.act(rf, wn, mt, deterministic=True)[0].squeeze(0).cpu().numpy()
            caps = np.zeros(len(mask))
            for j, b in enumerate(bridges):
                caps[j] = env._resolve_dynamic_state(b, req["sender_country"], req["receiver_country"], date)[0] / amount
            actions = {
                "ppo_original": a_orig,
                "ppo_projected": project_capped_simplex(a_orig, caps, mask),
                "liquidity_waterfall": liquidity_aware_waterfall_action(bridges, mask, amount, date),
            }
            for name, a in actions.items():
                env.current_step = i  # identical state for every policy
                _, r, _, _, info = env.step(a)
                rc = info["reward_components"]
                executed = info["executed_total"]
                # float32 PPO actions can sum to 1 +/- ~1e-7, so executed may exceed amount by cents;
                # record that separately rather than letting it produce negative "unrouted".
                amount_unrouted = max(amount - executed, 0.0)
                over_executed = max(executed - amount, 0.0)
                rows.append({
                    "checkpoint": label, "policy": name, "row_index": i,
                    "transaction_id": tx.transaction_id[i], "regime": regimes[i],
                    "corridor": f"{req['sender_country']}->{req['receiver_country']}", "simulation_date": date,
                    "amount": amount, "combined_capacity_share": float(caps[mask].sum()),
                    "rejected": rejection is not None,
                    "action_sum": float(np.sum(a)), "bridges_used": bridges_used(list(map(float, a))),
                    "reward": float(r), "cost_term": rc["cost_term"], "latency_term": rc["latency_term"],
                    "risk_term": rc["risk_term"], "unrouted_term": rc["unrouted_term"],
                    "executed": executed, "env_unrouted": info["unrouted"], "amount_unrouted": amount_unrouted,
                    "over_executed": over_executed,
                    "env_completed": info["unrouted"] <= RELATIVE_UNROUTED_TOLERANCE * amount,
                    "amount_completed": amount_unrouted <= RELATIVE_UNROUTED_TOLERANCE * amount,
                })
    return pd.DataFrame(rows)


def aggregate(df):
    def agg(g):
        return pd.Series({
            "n": len(g),
            "env_completion_rate": g.env_completed.mean(),
            "amount_completion_rate": g.amount_completed.mean(),
            "env_total_unrouted": g.env_unrouted.sum(),
            "amount_total_unrouted": g.amount_unrouted.sum(),
            "mean_reward": g.reward.mean(),
            "mean_cost_term": g.cost_term.mean(),
            "mean_latency_cost": g.latency_term.mean(),
            "mean_risk_cost": g.risk_term.mean(),
            "liquidity_utilization": g.executed.sum() / g.amount.sum(),
            "mean_bridges_used": g.bridges_used.mean(),
        })
    per_ckpt = df.groupby(["checkpoint", "policy"]).apply(agg).reset_index()
    per_ckpt_regime = df.groupby(["checkpoint", "policy", "regime"]).apply(agg).reset_index()
    metrics = [c for c in per_ckpt.columns if c not in ("checkpoint", "policy", "n")]

    def across(t, keys):
        g = t.groupby(keys)[metrics]
        m, s = g.mean(), g.std(ddof=1)
        out = m.add_suffix("_mean").join(s.add_suffix("_sd")).join(t.groupby(keys)["n"].first())
        return out.reset_index()
    return per_ckpt, per_ckpt_regime, across(per_ckpt, ["policy"]), across(per_ckpt_regime, ["regime", "policy"])


def main():
    specs = [(f"seed{s}_{c}", s, coef, MULTISEED_DIR / f"seed{s}" / c / "ppo_checkpoint.pt")
             for s in SEEDS for c, coef in CONDITIONS]
    for *_, ck in specs:
        if not ck.is_file():
            raise FileNotFoundError(ck)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = Path("outputs/experiments") / f"stage1d_holdout_eval_{ts}"
    out_dir.mkdir(parents=True, exist_ok=False)

    holdout, holdout_prov = make_holdout()
    print("holdout:", json.dumps({k: holdout_prov[k] for k in ("path", "true_regime_counts", "date_range",
                                                              "exact_duplicate_rows_with_existing_splits")}))

    status = _git("status", "--porcelain")
    code = ["run_holdout_evaluation.py", "src/training/capacity_projection.py", "src/training/transaction_generator.py"]
    prov = {
        "experiment": "stage1d_fresh_holdout_evaluation", "started_at": ts,
        "holdout": holdout_prov, "policies": list(POLICIES),
        "ppo_action_mode": "deterministic (normalized Dirichlet concentration)",
        "projection": "Euclidean projection onto {0<=x_i<=liquidity_i/amount, sum x = 1}; if combined "
                      "liquidity < amount, x_i = cap_i (requests < 100% of amount)",
        "unrouted_definitions": {"env_unrouted": "requested - executed (environment's definition)",
                                 "amount_unrouted": "max(amount - executed, 0)",
                                 "over_executed": "max(executed - amount, 0) (float32 action-sum overshoot)"},
        "completion_tolerance_relative": RELATIVE_UNROUTED_TOLERANCE,
        "training_performed": False, "tuning_performed": False,
        "checkpoints": [{"label": l, "seed": s, "entropy_coef": c, "checkpoint": str(ck), "sha256": _sha(ck),
                         "last_commit": _git("log", "-1", "--format=%H", "--", str(ck))} for l, s, c, ck in specs],
        "git_head": _git("rev-parse", "HEAD"), "git_dirty": bool(status),
        "git_dirty_files": status.splitlines() if status else [],
        "code_sha256": {f: _sha(f) for f in code}, "code_git_blob": {f: _git("hash-object", f) for f in code},
        "python": platform.python_version(), "torch": torch.__version__, "device": DEVICE,
        "gpu": torch.cuda.get_device_name(0) if DEVICE == "cuda" else None,
    }
    _save(out_dir / "provenance.json", prov)

    frames = []
    for label, seed, coef, ck in specs:
        print(f"evaluating {label} ...", flush=True)
        frames.append(evaluate_checkpoint(label, ck).assign(seed=seed, entropy_coef=coef))
    per_tx = pd.concat(frames, ignore_index=True)
    per_tx.to_csv(out_dir / "per_transaction.csv", index=False)

    per_ckpt, per_ckpt_regime, overall, by_regime = aggregate(per_tx)
    per_ckpt.to_csv(out_dir / "metrics_per_checkpoint.csv", index=False)
    per_ckpt_regime.to_csv(out_dir / "metrics_per_checkpoint_regime.csv", index=False)
    overall.to_csv(out_dir / "metrics_overall_across_checkpoints.csv", index=False)
    by_regime.to_csv(out_dir / "metrics_by_regime_across_checkpoints.csv", index=False)

    # Paired projected-minus-original per checkpoint
    piv = per_ckpt.pivot(index="checkpoint", columns="policy")
    paired = {m: (piv[m]["ppo_projected"] - piv[m]["ppo_original"]).describe()[["mean", "std", "min", "max"]].to_dict()
              for m in ("amount_completion_rate", "env_completion_rate", "mean_reward", "mean_cost_term",
                        "mean_latency_cost", "liquidity_utilization")}
    gap = (per_tx.env_unrouted - per_tx.amount_unrouted).abs()
    checks = {
        "n_rows": len(per_tx),
        "rejected_rows": int(per_tx.rejected.sum()),
        # Material = gap larger than the completion tolerance (relative to amount); smaller gaps are
        # float32 action-sum noise (cents), counted separately so they are not mistaken for real gaps.
        "env_vs_amount_unrouted_tolerance": f"|env - amount| > {RELATIVE_UNROUTED_TOLERANCE:.0e} * amount",
        "env_vs_amount_unrouted_material_rows": {f"{p}|{r}": int(n) for (p, r), n in per_tx[
            gap > RELATIVE_UNROUTED_TOLERANCE * per_tx.amount].groupby(["policy", "regime"]).size().items()},
        "env_vs_amount_unrouted_float_noise_rows": int(((gap > 0) & (gap <= RELATIVE_UNROUTED_TOLERANCE * per_tx.amount)).sum()),
        "max_float_noise_gap_usd": float(gap[gap <= RELATIVE_UNROUTED_TOLERANCE * per_tx.amount].max()),
        "env_vs_amount_completion_disagree_rows": {f"{p}|{r}": int(n) for (p, r), n in per_tx[
            per_tx.env_completed != per_tx.amount_completed].groupby(["policy", "regime"]).size().items()},
        "over_executed_rows": int((per_tx.over_executed > 0).sum()),
        "max_over_executed_usd": float(per_tx.over_executed.max()),
        "ppo_original_action_sum_range": [float(per_tx[per_tx.policy == "ppo_original"].action_sum.min()),
                                          float(per_tx[per_tx.policy == "ppo_original"].action_sum.max())],
        "waterfall_identical_across_checkpoints": bool(
            per_tx[per_tx.policy == "liquidity_waterfall"].groupby("row_index").reward.nunique().max() == 1),
    }
    _save(out_dir / "summary.json", {
        "holdout": {k: holdout_prov[k] for k in ("n", "true_regime_counts", "date_range", "corridor_counts")},
        "overall": overall.to_dict(orient="records"),
        "by_regime": by_regime.to_dict(orient="records"),
        "paired_projected_minus_original_across_checkpoints": paired,
        "checks": checks,
    })

    pd.set_option("display.width", 250, "display.max_columns", 40)
    cols = ["policy", "amount_completion_rate_mean", "env_completion_rate_mean", "amount_total_unrouted_mean",
            "env_total_unrouted_mean", "mean_reward_mean", "mean_reward_sd", "mean_cost_term_mean",
            "mean_latency_cost_mean", "liquidity_utilization_mean"]
    print("\n=== HOLDOUT, MEAN ACROSS 6 CHECKPOINTS ===")
    print(overall[cols].to_string(index=False))
    print("\n=== BY REGIME ===")
    print(by_regime[["regime", "n"] + cols].to_string(index=False))
    print("\nchecks:", json.dumps(checks, default=str))
    print(f"\nOutputs: {out_dir.resolve()}")


if __name__ == "__main__":
    main()
