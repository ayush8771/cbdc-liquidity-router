import numpy as np
import pandas as pd

from src.envs.dynamic_bridge_state import get_dynamic_state
from src.training.transaction_generator import (
    CORRIDOR_VENUE_UIDS,
    VENUE_FEES,
)


CSV = "data/processed/stage1d_transactions_train.csv"


def main():
    df = pd.read_csv(CSV)

    rows = []

    for _, r in df.iterrows():
        source = r["sender_country"]
        target = r["receiver_country"]
        amount = float(r["amount_usd"])
        date = r["simulation_date"]

        corridor = (source, target)
        venue_uids = CORRIDOR_VENUE_UIDS[corridor]

        # Same fee ordering used by the generator/baseline.
        fee_order = sorted(
            range(3),
            key=lambda i: VENUE_FEES[venue_uids[i]],
        )

        liquidities = [
            float(
                get_dynamic_state(
                    venue_uids[i],
                    date,
                )[0]
            )
            for i in fee_order
        ]

        cheapest_liquidity = liquidities[0]
        combined_liquidity = sum(liquidities)

        rows.append(
            {
                "regime": r["regime"],
                "amount": amount,
                "cheapest_liquidity": cheapest_liquidity,
                "combined_liquidity": combined_liquidity,
                "amount_to_cheapest": (
                    amount / cheapest_liquidity
                    if cheapest_liquidity > 0
                    else np.nan
                ),
                "amount_to_combined": (
                    amount / combined_liquidity
                    if combined_liquidity > 0
                    else np.nan
                ),
            }
        )

    out = pd.DataFrame(rows)

    print("=== OVERALL BOUNDARY RATIOS ===")
    print(
        out[
            [
                "amount_to_cheapest",
                "amount_to_combined",
            ]
        ].describe().to_string()
    )

    print("\n=== BY REGIME ===")

    summary = (
        out.groupby("regime")
        .agg(
            n=("amount", "count"),
            mean_amount_to_cheapest=(
                "amount_to_cheapest",
                "mean",
            ),
            median_amount_to_cheapest=(
                "amount_to_cheapest",
                "median",
            ),
            min_amount_to_cheapest=(
                "amount_to_cheapest",
                "min",
            ),
            max_amount_to_cheapest=(
                "amount_to_cheapest",
                "max",
            ),
            mean_amount_to_combined=(
                "amount_to_combined",
                "mean",
            ),
            median_amount_to_combined=(
                "amount_to_combined",
                "median",
            ),
        )
    )

    print(summary.to_string())

    print("\n=== COUNTS NEAR CHEAPEST-BRIDGE BOUNDARY ===")

    bins = [
        0.0,
        0.5,
        0.8,
        0.9,
        0.95,
        1.0,
        1.05,
        1.1,
        1.2,
        1.5,
        2.0,
        np.inf,
    ]

    labels = [
        "<0.5",
        "0.5-0.8",
        "0.8-0.9",
        "0.9-0.95",
        "0.95-1.0",
        "1.0-1.05",
        "1.05-1.1",
        "1.1-1.2",
        "1.2-1.5",
        "1.5-2.0",
        ">=2.0",
    ]

    out["cheapest_ratio_bin"] = pd.cut(
        out["amount_to_cheapest"],
        bins=bins,
        labels=labels,
        right=False,
    )

    print(
        out["cheapest_ratio_bin"]
        .value_counts(sort=False)
        .to_string()
    )

    print("\n=== COUNTS BY REGIME AND BOUNDARY BIN ===")

    print(
        pd.crosstab(
            out["cheapest_ratio_bin"],
            out["regime"],
        ).to_string()
    )

    output = "training_boundary_analysis.csv"
    out.to_csv(output, index=False)

    print(f"\nSaved: {output}")


if __name__ == "__main__":
    main()