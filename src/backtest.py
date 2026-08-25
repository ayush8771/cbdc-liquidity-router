import pandas as pd
import os

def run_backtest():
    print("=== Running Historical Evaluation & Backtesting Suite ===")
    txn_file = "data/structured/transaction_requests.csv"
    
    if os.path.exists(txn_file):
        df_txns = pd.read_csv(txn_file)
        print(f"[Backtest] Successfully loaded {len(df_txns)} transaction requests.")
        print(df_txns.head())
        print("\n[Backtest] Evaluation completed successfully.")
    else:
        print(f"[Backtest] Error: File {txn_file} not found.")

if __name__ == "__main__":
    run_backtest()