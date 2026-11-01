import numpy as np
import pandas as pd
import torch

from src.training.ppo_train import train
from src.training.evaluate import _make_eval_env
from src.training.baselines import liquidity_aware_waterfall_action
from src.envs.stage1d_raw_obs_wrapper import Stage1DRawObservationWrapper


TRAIN_CSV = "data/processed/stage1d_transactions_train.csv"
VAL_CSV = "data/processed/stage1d_transactions_validation.csv"
TEST_CSV = "data/processed/stage1d_transactions_test.csv"


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

    test_df = pd.read_csv(TEST_CSV)

    splitting_df = test_df[
        test_df["regime"] == "splitting_needed"
    ].reset_index(drop=True)

    print(
        f"\nSplitting-needed transactions: {len(splitting_df)}"
    )

    env, _ = _make_eval_env(TEST_CSV)
    wrapped = Stage1DRawObservationWrapper(env)
    base = wrapped.env.unwrapped

    rows = []

    for _, csv_row in splitting_df.iterrows():

        transaction_id = csv_row["transaction_id"]

        matches = np.where(
            base.requests_df["transaction_id"].values
            == transaction_id
        )[0]

        if len(matches) != 1:
            raise RuntimeError(
                f"Transaction {transaction_id} not found."
            )

        i = int(matches[0])

        base.current_step = i
        req = base._current_request()

        amount = float(req["amount_usd"])
        simulation_date = req["simulation_date"]

        mask, bridges, _ = base.get_feasibility_mask(req)

        obs = wrapped._wrap_obs(
            base._get_observation(req)
        )

        raw_features = torch.tensor(
            obs["raw_features"],
            dtype=torch.float32,
        ).unsqueeze(0)

        windows = torch.tensor(
            obs["windows"],
            dtype=torch.float32,
        ).unsqueeze(0)

        mask_t = torch.tensor(
            mask,
            dtype=torch.bool,
        ).unsqueeze(0)

        # --------------------------------------------------
        # PPO
        # --------------------------------------------------

        with torch.no_grad():
            ppo_action, _, _ = net.act(
                raw_features,
                windows,
                mask_t,
                deterministic=True,
            )

        ppo_action = (
            ppo_action
            .squeeze(0)
            .cpu()
            .numpy()
        )

        base.current_step = i

        _, ppo_reward, _, _, ppo_info = base.step(
            ppo_action
        )

        ppo_components = ppo_info[
            "reward_components"
        ]

        # --------------------------------------------------
        # WATERFALL
        # --------------------------------------------------

        base.current_step = i

        waterfall_action = (
            liquidity_aware_waterfall_action(
                bridges,
                mask,
                amount,
                simulation_date,
            )
        )

        _, waterfall_reward, _, _, waterfall_info = (
            base.step(waterfall_action)
        )

        waterfall_components = waterfall_info[
            "reward_components"
        ]

        rows.append({

            "transaction_id": transaction_id,
            "corridor": (
                f"{csv_row['sender_country']}"
                f"->{csv_row['receiver_country']}"
            ),
            "amount": amount,
            "simulation_date": simulation_date,

            "ppo_reward": float(ppo_reward),
            "waterfall_reward": float(
                waterfall_reward
            ),

            "reward_gap": float(
                ppo_reward - waterfall_reward
            ),

            # PPO reward components
            "ppo_cost": float(
                ppo_components["cost_term"]
            ),
            "ppo_latency": float(
                ppo_components["latency_term"]
            ),
            "ppo_risk": float(
                ppo_components["risk_term"]
            ),
            "ppo_unrouted_term": float(
                ppo_components["unrouted_term"]
            ),

            # Waterfall reward components
            "waterfall_cost": float(
                waterfall_components["cost_term"]
            ),
            "waterfall_latency": float(
                waterfall_components["latency_term"]
            ),
            "waterfall_risk": float(
                waterfall_components["risk_term"]
            ),
            "waterfall_unrouted_term": float(
                waterfall_components["unrouted_term"]
            ),

            "ppo_unrouted": float(
                ppo_info["unrouted"]
            ),
            "waterfall_unrouted": float(
                waterfall_info["unrouted"]
            ),

            "ppo_executed": float(
                ppo_info["executed_total"]
            ),
            "waterfall_executed": float(
                waterfall_info["executed_total"]
            ),
        })

    df = pd.DataFrame(rows)

    # --------------------------------------------------
    # OVERALL COMPONENT COMPARISON
    # --------------------------------------------------

    print("\n=== MEAN REWARD COMPONENTS ===")

    print("\nPPO:")
    print(
        "cost:",
        round(df["ppo_cost"].mean(), 6),
    )
    print(
        "latency:",
        round(df["ppo_latency"].mean(), 6),
    )
    print(
        "risk:",
        round(df["ppo_risk"].mean(), 6),
    )
    print(
        "unrouted:",
        round(df["ppo_unrouted_term"].mean(), 6),
    )
    print(
        "reward:",
        round(df["ppo_reward"].mean(), 6),
    )

    print("\nWaterfall:")
    print(
        "cost:",
        round(df["waterfall_cost"].mean(), 6),
    )
    print(
        "latency:",
        round(df["waterfall_latency"].mean(), 6),
    )
    print(
        "risk:",
        round(df["waterfall_risk"].mean(), 6),
    )
    print(
        "unrouted:",
        round(
            df["waterfall_unrouted_term"].mean(),
            6,
        ),
    )
    print(
        "reward:",
        round(df["waterfall_reward"].mean(), 6),
    )

    # --------------------------------------------------
    # FAILED PPO ONLY
    # --------------------------------------------------

    failed = df[
        df["ppo_unrouted"] > 1e-4
    ]

    successful = df[
        df["ppo_unrouted"] <= 1e-4
    ]

    print(
        "\n=== FAILED PPO TRANSACTIONS ==="
    )
    print(
        "count:",
        len(failed),
    )

    if len(failed) > 0:

        print(
            "mean PPO unrouted:",
            round(
                failed["ppo_unrouted"].mean(),
                2,
            ),
        )

        print(
            "mean PPO unrouted penalty:",
            round(
                failed["ppo_unrouted_term"].mean(),
                6,
            ),
        )

        print(
            "mean PPO cost:",
            round(
                failed["ppo_cost"].mean(),
                6,
            ),
        )

        print(
            "mean PPO latency:",
            round(
                failed["ppo_latency"].mean(),
                6,
            ),
        )

        print(
            "mean reward gap:",
            round(
                failed["reward_gap"].mean(),
                6,
            ),
        )

    print(
        "\n=== SUCCESSFUL PPO TRANSACTIONS ==="
    )
    print(
        "count:",
        len(successful),
    )

    print(
        "mean PPO reward:",
        round(
            successful["ppo_reward"].mean(),
            6,
        ),
    )

    print(
        "mean reward gap:",
        round(
            successful["reward_gap"].mean(),
            6,
        ),
    )

    # --------------------------------------------------
    # COMPONENT CONTRIBUTION TO REWARD GAP
    # --------------------------------------------------

    df["cost_gap"] = (
        df["ppo_cost"]
        - df["waterfall_cost"]
    )

    df["latency_gap"] = (
        df["ppo_latency"]
        - df["waterfall_latency"]
    )

    df["risk_gap"] = (
        df["ppo_risk"]
        - df["waterfall_risk"]
    )

    df["unrouted_gap"] = (
        df["ppo_unrouted_term"]
        - df["waterfall_unrouted_term"]
    )

    print(
        "\n=== PPO - WATERFALL COMPONENT GAPS ==="
    )

    print(
        "Cost gap:",
        round(df["cost_gap"].mean(), 6),
    )

    print(
        "Latency gap:",
        round(df["latency_gap"].mean(), 6),
    )

    print(
        "Risk gap:",
        round(df["risk_gap"].mean(), 6),
    )

    print(
        "Unrouted gap:",
        round(df["unrouted_gap"].mean(), 6),
    )

    print(
        "Total reward gap:",
        round(df["reward_gap"].mean(), 6),
    )

    # --------------------------------------------------
    # WORST 10 BY REWARD
    # --------------------------------------------------

    print(
        "\n=== WORST 10 PPO REWARD GAPS ==="
    )

    worst = (
        df.sort_values(
            "reward_gap"
        )
        .head(10)
        [
            [
                "transaction_id",
                "amount",
                "ppo_reward",
                "waterfall_reward",
                "reward_gap",
                "ppo_cost",
                "waterfall_cost",
                "ppo_latency",
                "waterfall_latency",
                "ppo_unrouted_term",
                "waterfall_unrouted_term",
                "ppo_unrouted",
            ]
        ]
    )

    print(
        worst.to_string(index=False)
    )

    # --------------------------------------------------
    # SAVE
    # --------------------------------------------------

    output = (
        "splitting_reward_analysis.csv"
    )

    df.to_csv(
        output,
        index=False,
    )

    print(
        f"\nDetailed CSV written to: {output}"
    )


if __name__ == "__main__":
    main()