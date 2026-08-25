import numpy as np
from src.envs.cbdc_env import CBDCLiquidityEnv

def run_test():
    # Initialize environment
    env = CBDCLiquidityEnv()
    obs, info = env.reset()
    
    print("--- Environment Verification ---")
    print(f"Initial Observation: {obs}")
    print(f"Total Requests in Queue: {info['total_requests']}\n")

    terminated = False
    total_reward = 0.0

    while not terminated:
        # Sample random action (Select vault bridge)
        action = env.action_space.sample()
        obs, reward, terminated, truncated, info = env.step(action)
        total_reward += reward

    print(f"Simulation completed across {info['step']} steps.")
    print(f"Total Cost Savings (Reward): ${total_reward:,.2f}")

if __name__ == "__main__":
    run_test()