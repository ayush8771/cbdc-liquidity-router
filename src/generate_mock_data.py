import pandas as pd
import os

# Ensure structured directory exists
os.makedirs("data/structured", exist_ok=True)

# 1. Create bridge_network.csv with expected column names
bridge_data = {
    "source_node": ["USA", "GBR", "ARE"],
    "target_node": ["IND", "PHL", "MEX"],
    "liquidity_capacity": [1000000.0, 500000.0, 750000.0],
    "latency_fee_pct": [0.015, 0.02, 0.012]
}
pd.DataFrame(bridge_data).to_csv("data/structured/bridge_network.csv", index=False)

# 2. Create transaction_requests.csv
txn_data = {
    "transaction_id": [101, 102, 103],
    "sender_country": ["USA", "GBR", "ARE"],
    "receiver_country": ["IND", "PHL", "MEX"],
    "amount_usd": [500.0, 1200.0, 300.0]
}
pd.DataFrame(txn_data).to_csv("data/structured/transaction_requests.csv", index=False)

print("Mock structured files regenerated successfully with updated schema!")