import numpy as np
import pandas as pd
import torch

from src.training.ppo_train import train
from src.training.evaluate import _make_eval_env
from src.training.baselines import liquidity_aware_waterfall_action
from src.envs.stage1d_raw_obs_wrapper import Stage1DRawObservationWrapper
from src.envs.dynamic_bridge_state import get_dynamic_state


TRAIN_CSV = "data/processed/stage1d_transactions_train.csv"
VAL_CSV = "data/processed/stage1d_transactions_validation.csv"
TEST_CSV = "data/processed/stage1d_transactions_test.csv"

N_SAMPLES = 128
MAX_FAILURES = 5


def main():
    print("=== TRAINING 20-EPOCH PPO ===")

    net, history = train(
        TRAIN_CSV,
        VAL_CSV,
        n_epochs=20,
        batch_size=32,
        lr=3e-4,
        device="cpu",
        seed=42,
    )

    net.train()

    test_df = pd.read_csv(TEST_CSV)

    # We only want splitting-needed transactions that were actually
    # failures for the deterministic PPO policy.
    env, _ = _make_eval_env(TEST_CSV)
    wrapped = Stage1DRawObservationWrapper(env)
    base = wrapped.env.unwrapped

    failures = []

    for _, csv_row in test_df.iterrows():
        if csv_row["regime"] != "splitting_needed":
            continue

        txid = csv_row["transaction_id"]

        matches = np.where(
            base.requests_df["transaction_id"].values == txid
        )[0]

        if len(matches) != 1:
            continue

        i = int(matches[0])
        base.current_step = i
        req = base._current_request()

        mask, bridges, _ = base.get_feasibility_mask(req)

        if sum(mask[:3]) != 3:
            continue

        obs = wrapped._wrap_obs(
            base._get_observation(req)
        )

        raw = torch.tensor(
            obs["raw_features"],
            dtype=torch.float32
        ).unsqueeze(0)

        windows = torch.tensor(
            obs["windows"],
            dtype=torch.float32
        ).unsqueeze(0)

        mask_t = torch.tensor(
            mask,
            dtype=torch.bool
        ).unsqueeze(0)

        with torch.no_grad():
            action, _, _ = net.act(
                raw,
                windows,
                mask_t,
                deterministic=True
            )

        deterministic_action = (
            action.squeeze(0).cpu().numpy()
        )

        # Execute deterministic PPO action.
        base.current_step = i
        _, reward, _, _, info = base.step(
            deterministic_action
        )

        if info["unrouted"] > 1e-4:
            failures.append({
                "index": i,
                "transaction_id": txid,
                "amount": float(req["amount_usd"]),
                "date": req["simulation_date"],
                "raw": raw,
                "windows": windows,
                "mask": mask_t,
                "deterministic_action": deterministic_action,
                "deterministic_reward": float(reward),
                "deterministic_unrouted": float(
                    info["unrouted"]
                ),
                "bridges": bridges,
            })

        if len(failures) >= MAX_FAILURES:
            break

    print(
        f"\nFound {len(failures)} deterministic PPO "
        f"failures for diagnostic."
    )

    if not failures:
        print("No suitable failed splitting-needed transactions found.")
        return

    # ------------------------------------------------------------
    # ANALYZE EACH FAILED TRANSACTION
    # ------------------------------------------------------------

    for case_no, case in enumerate(failures, start=1):

        print("\n" + "=" * 70)
        print(f"CASE {case_no}")
        print("=" * 70)

        raw = case["raw"]
        windows = case["windows"]
        mask = case["mask"]

        print(
            f"Transaction: {case['transaction_id']} "
            f"| Amount: ${case['amount']:,.2f} "
            f"| Date: {case['date']}"
        )

        bridge_ids = [
            b["bridge_id"]
            for b in case["bridges"][:3]
        ]

        liquidities = []

        for bridge_id in bridge_ids:
            liq, cong = get_dynamic_state(
                bridge_id,
                case["date"]
            )
            liquidities.append(float(liq))

        print("Bridge IDs:", bridge_ids)
        print(
            "Liquidity:",
            [round(x, 2) for x in liquidities]
        )

        print(
            "Current deterministic PPO:",
            np.round(
                case["deterministic_action"][:3],
                4
            ).tolist()
        )

        print(
            "Current unrouted:",
            round(case["deterministic_unrouted"], 2)
        )

        # --------------------------------------------------------
        # WATERFALL REFERENCE
        # --------------------------------------------------------

        waterfall_action = liquidity_aware_waterfall_action(
            case["bridges"],
            mask.squeeze(0).numpy(),
            case["amount"],
            case["date"],
        )

        print(
            "Waterfall target:",
            np.round(
                np.asarray(waterfall_action[:3]),
                4
            ).tolist()
        )

        # --------------------------------------------------------
        # SAMPLE MANY ACTIONS FROM CURRENT PPO
        # --------------------------------------------------------

        raw_batch = raw.repeat(N_SAMPLES, 1)
        windows_batch = windows.repeat(N_SAMPLES, 1, 1, 1)
        mask_batch = mask.repeat(N_SAMPLES, 1)

        with torch.no_grad():
            sampled_actions, _, _ = net.act(
                raw_batch,
                windows_batch,
                mask_batch,
                deterministic=False,
            )

        sampled_np = (
            sampled_actions.cpu().numpy()
        )

        rewards = []
        unrouted = []

        # Execute every sampled action through the REAL env.
        for j in range(N_SAMPLES):
            base.current_step = case["index"]

            _, r, _, _, info = base.step(
                sampled_np[j]
            )

            rewards.append(float(r))
            unrouted.append(
                float(info["unrouted"])
            )

        rewards = np.asarray(rewards)
        unrouted = np.asarray(unrouted)

        print(
            "\nSampled-policy reward:",
            f"mean={rewards.mean():.6f}, "
            f"max={rewards.max():.6f}, "
            f"min={rewards.min():.6f}"
        )

        print(
            "Sampled-policy unrouted:",
            f"mean=${unrouted.mean():,.2f}, "
            f"best=${unrouted.min():,.2f}"
        )

        best_idx = int(np.argmax(rewards))
        best_action = sampled_np[best_idx]

        print(
            "Best sampled allocation:",
            np.round(
                best_action[:3],
                4
            ).tolist()
        )

        print(
            "Best sampled reward:",
            round(float(rewards[best_idx]), 6)
        )

        print(
            "Best sampled unrouted:",
            round(float(unrouted[best_idx]), 2)
        )

        # --------------------------------------------------------
        # SCORE-FUNCTION POLICY GRADIENT
        # --------------------------------------------------------

        # Recompute log probabilities WITH gradient tracking.
        log_probs, _, _ = net.evaluate_actions(
            raw_batch,
            windows_batch,
            mask_batch,
            sampled_actions,
        )

        reward_tensor = torch.tensor(
            rewards,
            dtype=torch.float32,
        )

        # Center rewards, matching the spirit of PPO's
        # advantage normalization for this one-state diagnostic.
        advantage = (
            reward_tensor - reward_tensor.mean()
        )

        if advantage.std() > 1e-8:
            advantage = (
                advantage
                / (advantage.std() + 1e-8)
            )

        loss = -(
            advantage.detach()
            * log_probs
        ).mean()

        net.zero_grad(set_to_none=True)
        loss.backward()

        # Actor output bias gradient.
        grad = net.actor_head.bias.grad.detach().cpu().numpy()

        # Negative gradient means gradient descent increases that
        # output/concentration; positive means it decreases it.
        print(
            "\nPolicy-gradient diagnostic:"
        )

        print(
            "Actor-head bias gradient:",
            np.round(grad[:3], 6).tolist()
        )

        direction = np.where(
            grad[:3] < 0,
            "increase",
            "decrease"
        )

        print(
            "Estimated concentration pressure:",
            direction.tolist()
        )

        # --------------------------------------------------------
        # HIGH-REWARD VS LOW-REWARD ACTIONS
        # --------------------------------------------------------

        top_k = max(1, N_SAMPLES // 8)

        top_idx = np.argsort(rewards)[-top_k:]
        bottom_idx = np.argsort(rewards)[:top_k]

        top_mean = sampled_np[
            top_idx, :3
        ].mean(axis=0)

        bottom_mean = sampled_np[
            bottom_idx, :3
        ].mean(axis=0)

        print(
            "\nTop 12.5% sampled actions mean:",
            np.round(top_mean, 4).tolist()
        )

        print(
            "Bottom 12.5% sampled actions mean:",
            np.round(bottom_mean, 4).tolist()
        )

        print(
            "Top-minus-bottom allocation:",
            np.round(
                top_mean - bottom_mean,
                4
            ).tolist()
        )

        # --------------------------------------------------------
        # SIMPLE CORRELATION
        # --------------------------------------------------------

        for bridge_idx in range(3):
            corr = np.corrcoef(
                sampled_np[:, bridge_idx],
                rewards
            )[0, 1]

            print(
                f"Reward correlation with "
                f"Bridge {bridge_idx} allocation: "
                f"{corr:.4f}"
            )

    print("\n=== INTERPRETATION GUIDE ===")
    print(
        "A useful capacity-learning signal should generally show:"
    )
    print(
        "1. High-reward sampled actions allocate substantially "
        "more to alternative bridges than low-reward actions."
    )
    print(
        "2. The policy-gradient direction is consistent with "
        "increasing useful alternative-bridge mass on failed cases."
    )
    print(
        "3. Best sampled actions have much less unrouted amount "
        "than the current deterministic PPO action."
    )


if __name__ == "__main__":
    main()