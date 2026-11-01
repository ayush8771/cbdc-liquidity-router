"""Read-only diagnosis of failed PPO transactions (Stage 1D).

Follows docs/FAILED_SPLITTING_INVESTIGATION_PLAN.md.

Run from the repository root:
    python diagnose_failed_splitting.py

What it does (no training, no tuning, nothing existing is modified):
1. Replays deterministic PPO for each checkpoint through the same
   execution path as src/training/evaluate.run_ppo and checks that the
   replay reproduces the saved evaluation metrics exactly. If any replay
   does not match, it writes replay_check.json and stops before diagnosing.
   - Test split (retrospective; this split was already examined): the two
     original seed-42 checkpoints (entropy 0.0 and 0.005).
   - Validation split (cross-check): all six multi-seed checkpoints.
2. For every failed transaction (unrouted > completion tolerance) it records
   per-bridge state, PPO concentrations/allocation, requested/executed/
   clipped/spare amounts and reward components.
3. Counterfactuals on the same env.step(), each started from an identical
   environment state: the liquidity-aware waterfall action, and
   N_SAMPLES stochastic actions from the same policy (fixed seed).
4. Assigns a cause by the rules in classify().

Outputs: outputs/diagnostics/failed_splitting_<timestamp>/
"""

from __future__ import annotations

import hashlib
import json
import platform
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import torch

from src.envs.stage1d_raw_obs_wrapper import Stage1DRawObservationWrapper
from src.models.ppo_actor_critic import PPOActorCritic
from src.training.baselines import liquidity_aware_waterfall_action
from src.training.evaluate import _make_eval_env
from src.training.metrics import compute_metrics, is_completed, RELATIVE_UNROUTED_TOLERANCE

TEST_CSV = "data/processed/stage1d_transactions_test.csv"
VAL_CSV = "data/processed/stage1d_transactions_validation.csv"
SEED42_DIR = Path("outputs/experiments/stage1d_entropy_pair_seed42_20261031_153140")
MULTISEED_DIR = Path("outputs/experiments/stage1d_entropy_multiseed_20261101_180551")

N_SAMPLES = 200
SAMPLE_SEED = 20261101  # fixed; re-seeded per transaction so results do not depend on order
REPLAY_TOL = 1e-6
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

CHECKPOINTS = [
    # (label, split_name, csv, checkpoint path, saved metrics json, saved metrics key path)
    ("test_seed42_entropy000", "test", TEST_CSV,
     SEED42_DIR / "baseline_entropy000" / "ppo_checkpoint.pt",
     SEED42_DIR / "baseline_entropy000" / "evaluation_metrics.json"),
    ("test_seed42_entropy005", "test", TEST_CSV,
     SEED42_DIR / "entropy005" / "ppo_checkpoint.pt",
     SEED42_DIR / "entropy005" / "evaluation_metrics.json"),
] + [
    (f"val_seed{s}_{c}", "validation", VAL_CSV,
     MULTISEED_DIR / f"seed{s}" / c / "ppo_checkpoint.pt",
     MULTISEED_DIR / f"seed{s}" / c / "validation_metrics.json")
    for s in (42, 123, 2026) for c in ("entropy000", "entropy005")
]


# ----------------------------------------------------------------------------- utils

def _git(*args: str) -> str | None:
    try:
        return subprocess.check_output(["git", *args], text=True).strip()
    except Exception:
        return None


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _json_default(v: Any) -> Any:
    if hasattr(v, "item"):
        return v.item()
    if hasattr(v, "tolist"):
        return v.tolist()
    return str(v)


def _save_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, indent=2, default=_json_default), encoding="utf-8")


def _load_net(ckpt: Path) -> PPOActorCritic:
    net = PPOActorCritic().to(DEVICE)
    net.load_state_dict(torch.load(ckpt, map_location=DEVICE, weights_only=True))
    net.eval()
    return net


class Txn:
    """Snapshot of one transaction's environment state and policy inputs."""

    def __init__(self, wrapped, i: int):
        env = wrapped.env.unwrapped
        self.wrapped, self.env, self.i = wrapped, env, i
        env.current_step = i
        req = env._current_request()
        self.req = req
        self.amount = float(req["amount_usd"])
        self.date = req["simulation_date"]
        self.sender, self.receiver = req["sender_country"], req["receiver_country"]
        self.mask, self.bridges, _ = env.get_feasibility_mask(req)
        self.raw_obs = env._get_observation(req)
        obs = wrapped._wrap_obs(self.raw_obs)
        self.raw_features = torch.tensor(obs["raw_features"], dtype=torch.float32, device=DEVICE).unsqueeze(0)
        self.windows = torch.tensor(obs["windows"], dtype=torch.float32, device=DEVICE).unsqueeze(0)
        self.mask_t = torch.tensor(self.mask, dtype=torch.bool, device=DEVICE).unsqueeze(0)
        self.state = [env._resolve_dynamic_state(b, self.sender, self.receiver, self.date) for b in self.bridges]

    def step(self, action: np.ndarray) -> dict:
        """Executes `action` from this transaction's state (identical every call)."""
        self.env.current_step = self.i
        _, reward, _, _, info = self.env.step(np.asarray(action))
        return {"reward": float(reward), "info": info}

    def assert_state_unchanged(self) -> None:
        """Environment state for this transaction must be identical before/after counterfactuals."""
        self.env.current_step = self.i
        req = self.env._current_request()
        assert req.equals(self.req), f"request changed for row {self.i}"
        assert np.array_equal(self.env._get_observation(req), self.raw_obs), f"observation changed for row {self.i}"
        now = [self.env._resolve_dynamic_state(b, self.sender, self.receiver, self.date) for b in self.bridges]
        assert now == self.state, f"dynamic state changed for row {self.i}"


def _record(t: Txn, action: np.ndarray, out: dict, regime: str | None) -> dict:
    info = out["info"]
    rec = {
        "amount": t.amount, "reward": out["reward"],
        "executed_total": info["executed_total"], "unrouted": info["unrouted"],
        "action": list(action),
        "latency_term": info["reward_components"]["latency_term"],
        "risk_term": info["reward_components"]["risk_term"],
        "cost_term": info["reward_components"]["cost_term"],
    }
    if regime is not None:
        rec["regime"] = regime
    return rec


# ----------------------------------------------------------------------------- replay

def replay(label, split, csv, ckpt, saved_json):
    """Deterministic PPO + waterfall replay. Returns (ok, check, txns, det_actions, det_outs, net, regimes, tx_df)."""
    env, regimes = _make_eval_env(csv)
    wrapped = Stage1DRawObservationWrapper(env)
    net = _load_net(ckpt)
    tx_df = pd.read_csv(csv)

    txns, det_actions, det_outs, conc_list = [], [], [], []
    ppo_records, wf_records = [], []
    with torch.no_grad():
        for i in range(env.max_steps):
            t = Txn(wrapped, i)
            action, _, _ = net.act(t.raw_features, t.windows, t.mask_t, deterministic=True)
            a = action.squeeze(0).cpu().numpy()
            out = t.step(a)
            reg = regimes[i] if regimes else None
            ppo_records.append(_record(t, a, out, reg))
            wf = liquidity_aware_waterfall_action(t.bridges, t.mask, t.amount, t.date)
            wf_records.append(_record(t, wf, t.step(wf), reg))
            txns.append(t)
            det_actions.append(a)
            det_outs.append(out)

    replayed = {"ppo": compute_metrics(ppo_records), "liquidity_waterfall": compute_metrics(wf_records)}
    saved = json.loads(saved_json.read_text(encoding="utf-8"))
    check = {"label": label, "split": split, "checkpoint": str(ckpt), "saved_metrics": str(saved_json),
             "tolerance": REPLAY_TOL, "fields": {}}
    ok = True
    for pol in ("ppo", "liquidity_waterfall"):
        keys = [(k,) for k in ("mean_reward", "completion_rate", "total_unrouted", "liquidity_utilization")]
        keys += [("by_regime", g, "completion_rate") for g in saved[pol].get("by_regime", {})]
        keys += [("by_regime", g, "mean_reward") for g in saved[pol].get("by_regime", {})]
        for kp in keys:
            s, r = saved[pol], replayed[pol]
            for k in kp:
                s, r = s[k], r[k]
            diff = abs(float(s) - float(r))
            scale = max(1.0, abs(float(s)))
            match = diff <= REPLAY_TOL * scale
            ok &= match
            check["fields"][f"{pol}." + ".".join(kp)] = {"saved": s, "replayed": r, "abs_diff": diff, "match": match}

    n_fail = sum(not is_completed(r["unrouted"], r["amount"]) for r in ppo_records)
    n_fail_saved = round((1 - saved["ppo"]["completion_rate"]) * saved["ppo"]["n_transactions"])
    check["ppo_failures_replayed"] = n_fail
    check["ppo_failures_expected_from_saved"] = n_fail_saved
    ok &= n_fail == n_fail_saved
    check["match"] = bool(ok)
    return ok, check, txns, det_actions, det_outs, net, regimes, tx_df


# ----------------------------------------------------------------------------- diagnosis

def classify(row: dict) -> tuple[str, list[str]]:
    """Failure MECHANISM (exclusive) + independent, non-exclusive FLAGS.

    Mechanism:
      exceeds_combined_liquidity  amount > combined feasible liquidity (no policy can complete)
      over_allocation_clipped     >=1 slot requested more than its liquidity; the excess was
                                  clipped and not redistributed, while combined liquidity sufficed
      other                       anything else
    Flags (each a measured comparison, not a cause):
      ppo_reward_ge_waterfall           deterministic PPO reward >= waterfall reward despite
                                        unrouted (waterfall is a heuristic, NOT reward-optimal)
      zero_action_reward_ge_waterfall   the all-zero action, executed via env.step, scores >= waterfall
      sample_completes_and_beats_det    at least one SINGLE sample both completes and beats the
                                        deterministic reward
      amount_within_1pct_of_combined    |amount/combined - 1| <= 1%
    """
    flags = []
    if row["det_reward"] >= row["waterfall_reward"]:
        flags.append("ppo_reward_ge_waterfall")
    if row["zero_action_reward"] >= row["waterfall_reward"]:
        flags.append("zero_action_reward_ge_waterfall")
    if row["sample_frac_complete_and_beat_det"] > 0:
        flags.append("sample_completes_and_beats_det")
    if row["near_combined_edge"]:
        flags.append("amount_within_1pct_of_combined")

    if row["amount"] > row["combined_liquidity"] * (1 + RELATIVE_UNROUTED_TOLERANCE):
        return "exceeds_combined_liquidity", flags
    if row["total_clipped"] > 0:
        return "over_allocation_clipped", flags
    return "other", flags


def diagnose_one(label, split, t: Txn, det_action, det_out, net, regime, tx_row) -> dict:
    amount = t.amount
    feas = [i for i in range(len(t.mask)) if t.mask[i]]
    with torch.no_grad():
        conc, _ = net.forward(t.raw_features, t.windows, t.mask_t)
    conc = conc.squeeze(0).cpu()

    # Bridge state and deterministic allocation, per feasible slot
    fee_order = sorted(feas, key=lambda i: t.bridges[i]["fee"])
    liq = {i: float(t.state[i][0]) for i in feas}
    combined = sum(liq.values())
    cheapest = fee_order[0]
    executed = {i: min(float(det_action[i]) * amount, liq[i]) for i in feas}
    clipped = {i: max(float(det_action[i]) * amount - liq[i], 0.0) for i in feas}
    spare = {i: max(liq[i] - executed[i], 0.0) for i in feas}

    # Waterfall counterfactual (identical state)
    wf_action = liquidity_aware_waterfall_action(t.bridges, t.mask, amount, t.date)
    wf_out = t.step(wf_action)

    # Stochastic counterfactuals: the model's own masked-Dirichlet sampler, fixed seed
    torch.manual_seed(SAMPLE_SEED)
    mask_cpu = t.mask_t.cpu().repeat(N_SAMPLES, 1)
    with torch.no_grad():
        samples, _, _ = net._sample_or_evaluate(conc.unsqueeze(0).repeat(N_SAMPLES, 1), mask_cpu, deterministic=False)
    samples = samples.numpy()
    s_rewards, s_complete, s_unrouted = [], [], []
    for a in samples:
        o = t.step(a)
        s_rewards.append(o["reward"])
        s_unrouted.append(o["info"]["unrouted"])
        s_complete.append(is_completed(o["info"]["unrouted"], amount))
    s_rewards = np.asarray(s_rewards)
    s_complete = np.asarray(s_complete, dtype=bool)
    best = int(np.argmax(s_rewards))
    joint = s_complete & (s_rewards > det_out["reward"])  # same sample completes AND beats det
    best_completing = float(s_rewards[s_complete].max()) if s_complete.any() else float("nan")

    # All-zero action, executed via the real env.step (measured, not computed by formula)
    zero_out = t.step(np.zeros_like(det_action))

    # Re-check identical state and deterministic reproducibility after counterfactuals
    t.assert_state_unchanged()
    redo = t.step(det_action)
    assert redo["reward"] == det_out["reward"], f"deterministic reward not reproducible for row {t.i}"

    rc = det_out["info"]["reward_components"]
    wrc = wf_out["info"]["reward_components"]
    row = {
        "checkpoint": label, "split": split, "row_index": t.i,
        "transaction_id": tx_row["transaction_id"], "corridor": f"{t.sender}->{t.receiver}",
        "simulation_date": t.date, "regime": regime, "intended_regime": tx_row.get("intended_regime"),
        "amount": amount,
        "cheapest_slot": cheapest, "cheapest_liquidity": liq[cheapest], "combined_liquidity": combined,
        "amount_over_cheapest_liquidity": amount / liq[cheapest] if liq[cheapest] else np.inf,
        "amount_over_combined_liquidity": amount / combined if combined else np.inf,
        "near_combined_edge": bool(combined and abs(amount / combined - 1) <= 0.01),
        "det_reward": det_out["reward"], "det_unrouted": det_out["info"]["unrouted"],
        "det_unrouted_pct": det_out["info"]["unrouted"] / amount,
        "det_cost_term": rc["cost_term"], "det_latency_term": rc["latency_term"],
        "det_risk_term": rc["risk_term"], "det_unrouted_term": rc["unrouted_term"],
        "waterfall_reward": wf_out["reward"], "waterfall_unrouted": wf_out["info"]["unrouted"],
        "waterfall_cost_term": wrc["cost_term"], "waterfall_latency_term": wrc["latency_term"],
        "waterfall_unrouted_term": wrc["unrouted_term"],
        "reward_gap_waterfall_minus_ppo": wf_out["reward"] - det_out["reward"],
        "zero_action_reward": zero_out["reward"], "zero_action_unrouted": zero_out["info"]["unrouted"],
        "det_action_sum": float(np.sum(det_action)), "waterfall_action_sum": float(np.sum(wf_action)),
        "over_allocated_slots": [i for i in feas if clipped[i] > 0],
        "over_allocated_fee_ranks": [r for r, i in enumerate(fee_order) if clipped[i] > 0],
        "over_allocated_cheapest": clipped[cheapest] > 0,
        "total_clipped": sum(clipped.values()),
        "clipped_pct_of_amount": sum(clipped.values()) / amount,
        "max_clip_pct_of_slot_liquidity": max((clipped[i] / liq[i] for i in feas if liq[i] > 0), default=0.0),
        "total_spare_liquidity": sum(spare.values()),
        "spare_pct_of_amount": sum(spare.values()) / amount,
        "concentration_sum": float(conc[feas].sum()),
        "sample_n": N_SAMPLES, "sample_seed": SAMPLE_SEED,
        "sample_completion_rate": float(np.mean(s_complete)),
        "sample_reward_mean": float(s_rewards.mean()), "sample_reward_std": float(s_rewards.std()),
        "sample_reward_min": float(s_rewards.min()), "sample_reward_p05": float(np.percentile(s_rewards, 5)),
        "sample_reward_p25": float(np.percentile(s_rewards, 25)), "sample_reward_median": float(np.median(s_rewards)),
        "sample_reward_p75": float(np.percentile(s_rewards, 75)), "sample_reward_p95": float(np.percentile(s_rewards, 95)),
        "sample_reward_max": float(s_rewards.max()),
        "sample_frac_reward_above_det": float(np.mean(s_rewards > det_out["reward"])),
        "sample_unrouted_mean": float(np.mean(s_unrouted)),
        "best_sample_unrouted": float(s_unrouted[best]),
        "best_sample_completes": bool(s_complete[best]),
        "sample_frac_complete_and_beat_det": float(joint.mean()),
        "best_completing_sample_reward": best_completing,
    }
    for rank, i in enumerate(fee_order):
        b = t.bridges[i]
        p = f"fee_rank{rank}_"
        row.update({
            p + "slot": i, p + "bridge_id": b["bridge_id"], p + "fee": b["fee"],
            p + "liquidity": liq[i], p + "congestion": float(t.state[i][1]), p + "risk": float(t.state[i][2]),
            p + "concentration": float(conc[i]), p + "det_share": float(det_action[i]),
            p + "liquidity_share_of_amount": liq[i] / amount,
            p + "requested": float(det_action[i]) * amount, p + "executed": executed[i],
            p + "clipped": clipped[i], p + "spare": spare[i],
            p + "waterfall_share": float(wf_action[i]), p + "best_sample_share": float(samples[best][i]),
        })
    row["mechanism"], flags = classify(row)
    row["flags"] = flags
    return row


# ----------------------------------------------------------------------------- report

def _md(df: pd.DataFrame, index: bool = True) -> str:
    """Minimal Markdown table (avoids an optional tabulate dependency)."""
    d = df.reset_index() if index else df
    fmt = lambda v: f"{v:.4f}" if isinstance(v, (float, np.floating)) else str(v)
    lines = ["| " + " | ".join(map(str, d.columns)) + " |", "|" + "---|" * len(d.columns)]
    lines += ["| " + " | ".join(fmt(v) for v in row) + " |" for row in d.itertuples(index=False)]
    return "\n".join(lines)


def write_report(out_dir: Path, prov: dict, checks: list, df: pd.DataFrame) -> None:
    L = ["# Failed-transaction diagnosis (Stage 1D)", "",
         f"Generated: {prov['generated_at']} | git HEAD `{prov['git_head']}` (dirty: {prov['git_dirty']}) | device {DEVICE}",
         f"Stochastic counterfactuals: {N_SAMPLES} samples per transaction, torch seed {SAMPLE_SEED} re-set per transaction.",
         "Deterministic PPO = normalized Dirichlet concentration. All counterfactuals executed via the same env.step() "
         "from an identical, asserted-unchanged environment state.", "",
         "Test-split rows are a retrospective diagnosis of an already-examined split; do not use them for selection.", "",
         "## Replay check", "", "| Checkpoint | Split | PPO failures (replayed / saved) | Exact match |", "|---|---|---|---|"]
    for c in checks:
        L.append(f"| {c['label']} | {c['split']} | {c['ppo_failures_replayed']} / {c['ppo_failures_expected_from_saved']} | {c['match']} |")

    L += ["", "## Failure mechanism and flags by checkpoint", ""]
    if df.empty:
        L.append("No failed transactions.")
    else:
        has = lambda flag: df["flags"].apply(lambda f: flag in f)
        df = df.assign(
            f_ppo_ge_wf=has("ppo_reward_ge_waterfall"),
            f_zero_ge_wf=has("zero_action_reward_ge_waterfall"),
            f_sample_joint=has("sample_completes_and_beats_det"),
        )
        mech = df.groupby(["checkpoint", "mechanism"]).size().unstack(fill_value=0)
        flags = df.groupby("checkpoint")[["f_ppo_ge_wf", "f_zero_ge_wf", "f_sample_joint"]].sum().rename(columns={
            "f_ppo_ge_wf": "ppo_reward_ge_waterfall", "f_zero_ge_wf": "zero_action_reward_ge_waterfall",
            "f_sample_joint": "sample_completes_and_beats_det"})
        L.append(_md(mech.join(flags)))
        L += ["", "Mechanism is exclusive; flags are independent counts and overlap with each other and with the mechanism.", ""]

        L += ["## Failures by regime", "", _md(df.groupby(["checkpoint", "regime"]).size().unstack(fill_value=0))]
        L += ["", "## Over-allocated bridge (fee rank: 0 = cheapest)", "",
              _md(df.assign(ranks=df["over_allocated_fee_ranks"].astype(str))
                  .groupby(["checkpoint", "ranks"]).size().unstack(fill_value=0))]
        L += ["", "## Per-checkpoint aggregates", ""]
        agg = df.groupby("checkpoint").agg(
            n_failed=("transaction_id", "size"),
            mean_unrouted_pct=("det_unrouted_pct", "mean"),
            mean_clipped_pct=("clipped_pct_of_amount", "mean"),
            max_clip_pct_slot_liq=("max_clip_pct_of_slot_liquidity", "max"),
            mean_spare_pct=("spare_pct_of_amount", "mean"),
            max_amount_over_combined=("amount_over_combined_liquidity", "max"),
            mean_sample_completion=("sample_completion_rate", "mean"),
            mean_frac_complete_beat_det=("sample_frac_complete_and_beat_det", "mean"),
            best_sample_completes=("best_sample_completes", "mean"),
            mean_gap_wf_minus_ppo=("reward_gap_waterfall_minus_ppo", "mean"),
        )
        L.append(_md(agg))

        test005 = df[df.checkpoint == "test_seed42_entropy005"]
        if not test005.empty:
            L += ["", "## The test-split failures under seed-42 entropy 0.005", ""]
            cols = ["transaction_id", "corridor", "simulation_date", "amount",
                    "amount_over_combined_liquidity", "fee_rank0_det_share", "fee_rank0_liquidity_share_of_amount",
                    "det_unrouted_pct", "det_reward", "waterfall_reward", "sample_completion_rate",
                    "sample_frac_complete_and_beat_det", "best_completing_sample_reward", "mechanism"]
            L.append(_md(test005[cols], index=False))

        tests = df[df.split == "test"]
        if not tests.empty:
            ids0 = set(tests[tests.checkpoint == "test_seed42_entropy000"].transaction_id)
            ids5 = set(tests[tests.checkpoint == "test_seed42_entropy005"].transaction_id)
            L += ["", f"Test overlap: {len(ids0 & ids5)} transaction(s) fail under both seed-42 checkpoints; "
                  f"{len(ids5 - ids0)} fail only under 0.005; {len(ids0 - ids5)} only under 0.0."]
        val = df[df.split == "validation"]
        if not val.empty:
            counts = val.groupby("transaction_id").size().sort_values(ascending=False)
            L += ["", "## Validation cross-check: recurrence across the six checkpoints", "",
                  f"{len(counts)} distinct validation transactions fail under at least one checkpoint; "
                  f"{int((counts >= 2).sum())} fail under 2+, {int((counts >= 4).sum())} under 4+, "
                  f"{int((counts == 6).sum())} under all 6.", "",
                  _md(counts.rename("n_checkpoints_failed").to_frame().head(15))]

        # ---- Interpretation: measured facts, then explicitly labelled hypotheses
        n = len(df)
        n_over = int((df.mechanism == "over_allocation_clipped").sum())
        n_exceed = int((df.mechanism == "exceeds_combined_liquidity").sum())
        n_ppo_ge = int(df.f_ppo_ge_wf.sum())
        n_zero_ge = int(df.f_zero_ge_wf.sum())
        n_joint = int(df.f_sample_joint.sum())
        n_best_c = int(df.best_sample_completes.sum())
        zero_rewards = sorted(set(float(x) for x in np.round(df.zero_action_reward, 6)))
        zero_unrouted = float(df.zero_action_unrouted.abs().max())
        corridors = df.corridor.value_counts().to_dict()
        regimes = df.regime.value_counts().to_dict()
        L += ["", "## Interpretation", "", "### Measured facts", "",
              f"- {n} failed (checkpoint, transaction) rows. Corridors: {corridors}. Regimes: {regimes}.",
              f"- Mechanism: {n_over}/{n} over-allocation with clipping (excess not redistributed); "
              f"{n_exceed}/{n} exceed combined liquidity. Max amount/combined liquidity = "
              f"{df.amount_over_combined_liquidity.max():.4f}.",
              f"- Clipped excess: median {df.clipped_pct_of_amount.median():.2%} of amount "
              f"(range {df.clipped_pct_of_amount.min():.2%}-{df.clipped_pct_of_amount.max():.2%}).",
              f"- Deterministic PPO reward >= waterfall reward in {n_ppo_ge}/{n} rows. "
              "The waterfall is a fee-ordered heuristic, not reward-optimal, so this is not evidence that "
              "unrouted money is reward-optimal.",
              f"- All-zero action, executed via env.step: reward(s) {zero_rewards}, max |unrouted| reported "
              f"{zero_unrouted:.4f}; zero-action reward >= waterfall reward in {n_zero_ge}/{n} rows.",
              f"- Stochastic samples: in {n_joint}/{n} rows at least one single sample both completes and beats "
              f"the deterministic reward; the highest-reward sample completes in {n_best_c}/{n} rows.",
              f"- Deterministic action sums: min {df.det_action_sum.min():.6f}, max {df.det_action_sum.max():.6f}. "
              f"Waterfall action sums: min {df.waterfall_action_sum.min():.6f}, max {df.waterfall_action_sum.max():.6f}.",
              "", "### Hypotheses (not established by this diagnosis)", "",
              "- H1: the deterministic mean allocation does not track per-date liquidity closely enough at the "
              "capacity boundary, so small overshoots on one bridge are clipped and lost.",
              "- H2: the env computes unrouted as requested minus executed, so an action that requests less than "
              "the full amount is not penalised for the unrequested part (see the all-zero action above). PPO's "
              "Dirichlet actions sum to 1, so PPO itself cannot under-request; this concerns reward/metric "
              "semantics for under-requesting policies, not the failures above.",
              "- H3: the entropy coefficient does not address H1; failures recur on the same transactions "
              "under both coefficients.",
              "", "None of these hypotheses has been tested by changing the model, reward or environment.", ""]

    L += ["## Definitions", "",
          "Mechanism (exclusive): `exceeds_combined_liquidity`; `over_allocation_clipped` (>=1 bridge requested "
          "more than its liquidity, excess clipped and not redistributed, while combined liquidity sufficed); `other`.",
          "Flags (non-exclusive): `ppo_reward_ge_waterfall`; `zero_action_reward_ge_waterfall` (all-zero action "
          "run through env.step); `sample_completes_and_beats_det` (a single sample does both); "
          "`amount_within_1pct_of_combined`.", ""]
    (out_dir / "FINDINGS.md").write_text("\n".join(L), encoding="utf-8")


# ----------------------------------------------------------------------------- main

def main() -> None:
    for _, _, csv, ckpt, js in CHECKPOINTS:
        for p in (Path(csv), ckpt, js):
            if not p.is_file():
                raise FileNotFoundError(p)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = Path("outputs/diagnostics") / f"failed_splitting_{ts}"
    out_dir.mkdir(parents=True, exist_ok=False)

    status = _git("status", "--porcelain")
    prov = {
        "script": "diagnose_failed_splitting.py", "plan": "docs/FAILED_SPLITTING_INVESTIGATION_PLAN.md",
        "script_sha256": _sha256(Path(__file__)),
        "script_git_blob": _git("hash-object", __file__),
        "script_blob_in_head": _git("rev-parse", "--verify", "--quiet", "HEAD:diagnose_failed_splitting.py"),
        "script_matches_head": _git("rev-parse", "--verify", "--quiet", "HEAD:diagnose_failed_splitting.py")
        == _git("hash-object", __file__),
        "generated_at": ts, "git_head": _git("rev-parse", "HEAD"), "git_branch": _git("rev-parse", "--abbrev-ref", "HEAD"),
        "git_dirty": bool(status), "git_dirty_files": status.splitlines() if status else [],
        "python": platform.python_version(), "torch": torch.__version__, "device": DEVICE,
        "gpu": torch.cuda.get_device_name(0) if DEVICE == "cuda" else None,
        "n_samples": N_SAMPLES, "sample_seed": SAMPLE_SEED, "replay_tolerance": REPLAY_TOL,
        "completion_tolerance_relative": RELATIVE_UNROUTED_TOLERANCE,
        "data": {p: _sha256(Path(p)) for p in (TEST_CSV, VAL_CSV)},
        "checkpoints": [
            {"label": l, "split": s, "csv": c, "checkpoint": str(ck), "checkpoint_sha256": _sha256(ck),
             "checkpoint_last_commit": _git("log", "-1", "--format=%H", "--", str(ck)),
             "saved_metrics": str(js), "saved_metrics_sha256": _sha256(js)}
            for l, s, c, ck, js in CHECKPOINTS
        ],
    }
    _save_json(out_dir / "provenance.json", prov)

    # Phase 1: replay every checkpoint; stop before any diagnosis if one does not reproduce.
    replays, checks = [], []
    for spec in CHECKPOINTS:
        print(f"replaying {spec[0]} ...", flush=True)
        res = replay(*spec)
        replays.append((spec, res))
        checks.append(res[1])
        print(f"  match={res[0]} failures replayed={res[1]['ppo_failures_replayed']} "
              f"saved={res[1]['ppo_failures_expected_from_saved']}", flush=True)
    _save_json(out_dir / "replay_check.json", checks)
    if not all(c["match"] for c in checks):
        print("REPLAY MISMATCH - stopping before diagnosis. See replay_check.json", file=sys.stderr)
        sys.exit(2)

    # Phase 2: diagnose every failed transaction.
    rows = []
    for (label, split, csv, ckpt, js), (_, _, txns, det_actions, det_outs, net, regimes, tx_df) in replays:
        for t, a, o in zip(txns, det_actions, det_outs):
            if is_completed(o["info"]["unrouted"], t.amount):
                continue
            rows.append(diagnose_one(label, split, t, a, o, net,
                                     regimes[t.i] if regimes else None, tx_df.iloc[t.i].to_dict()))
        print(f"diagnosed {label}: {sum(r['checkpoint'] == label for r in rows)} failures", flush=True)

    df = pd.DataFrame(rows)
    df.to_csv(out_dir / "failed_transactions.csv", index=False)

    summary = {"n_failed_rows": len(df), "by_checkpoint": {}}
    for label, g in (df.groupby("checkpoint") if not df.empty else []):
        summary["by_checkpoint"][label] = {
            "n_failed": len(g),
            "by_regime": g["regime"].value_counts().to_dict(),
            "by_mechanism": g["mechanism"].value_counts().to_dict(),
            "n_flag_ppo_reward_ge_waterfall": int(sum("ppo_reward_ge_waterfall" in f for f in g["flags"])),
            "n_flag_zero_action_reward_ge_waterfall": int(sum("zero_action_reward_ge_waterfall" in f for f in g["flags"])),
            "n_flag_sample_completes_and_beats_det": int(sum("sample_completes_and_beats_det" in f for f in g["flags"])),
            "n_best_sample_completes": int(g["best_sample_completes"].sum()),
            "over_allocated_fee_ranks": g["over_allocated_fee_ranks"].astype(str).value_counts().to_dict(),
            "n_over_allocated_cheapest": int(g["over_allocated_cheapest"].sum()),
            "transaction_ids": g["transaction_id"].tolist(),
            "mean_sample_completion_rate": float(g["sample_completion_rate"].mean()),
            "mean_reward_gap_waterfall_minus_ppo": float(g["reward_gap_waterfall_minus_ppo"].mean()),
            "total_unrouted": float(g["det_unrouted"].sum()),
        }
    _save_json(out_dir / "summary.json", summary)
    write_report(out_dir, prov, checks, df)
    print(f"\nOutputs: {out_dir.resolve()}")


if __name__ == "__main__":
    main()
