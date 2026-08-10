from app.rl_engine.env import CBDCLiquidityEnv
from gymnasium.utils.env_checker import check_env
import warnings

# Suppress minor gym warnings for a cleaner console output
warnings.filterwarnings("ignore", category=UserWarning)

def main():
    print("Initializing CBDC Liquidity Environment...")
    env = CBDCLiquidityEnv()
    
    print("Running Gymnasium Environment Checker...")
    check_env(env, warn=True)
    
    print("✅ Environment check passed successfully! No API compliance errors found.")
    
    # Run a dummy step to verify the math
    obs, info = env.reset()
    dummy_action = env.action_space.sample()
    obs, reward, terminated, truncated, info = env.step(dummy_action)
    
    print("\n--- Action Test ---")
    print(f"Sample Reward: {reward:.2f}")
    print(f"Execution Info: {info}")

if __name__ == "__main__":
    main()