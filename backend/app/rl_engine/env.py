import gymnasium as gym
from gymnasium import spaces
import numpy as np

class CBDCLiquidityEnv(gym.Env):
    """
    Custom Gymnasium Environment for Cross-Border CBDC Routing.
    Simulates 5 Nodes (India, Singapore, UAE, Germany, Japan) and 8 Bridges.
    """
    metadata = {"render_modes": ["console"]}

    def __init__(self):
        super(CBDCLiquidityEnv, self).__init__()
        
        self.num_bridges = 8
        self.order_size = 100000.0  # Simulated transaction size ($100k)
        
        # Action Space: Continuous values between 0 and 1 representing the split percentage across 8 bridges.
        self.action_space = spaces.Box(low=0.0, high=1.0, shape=(self.num_bridges,), dtype=np.float32)
        
        # Observation Space: 25-dimensional vector
        # [Fees (8), Liquidity (8), Congestion (8), Order Size (1)]
        self.observation_space = spaces.Box(low=0.0, high=np.inf, shape=(25,), dtype=np.float32)
        
    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        
        # Synthetic Mode: Generate mathematical market noise
        self.fees = self.np_random.uniform(0.001, 0.05, size=(self.num_bridges,)).astype(np.float32)
        self.liquidity = self.np_random.uniform(10000, 500000, size=(self.num_bridges,)).astype(np.float32)
        self.congestion = self.np_random.uniform(0.1, 2.0, size=(self.num_bridges,)).astype(np.float32)
        
        obs = self._get_obs()
        info = {}
        return obs, info

    def _get_obs(self):
        return np.concatenate([self.fees, self.liquidity, self.congestion, [self.order_size]], dtype=np.float32)

    def step(self, action):
        # Normalize the action array so routing percentages always sum to 1.0 (100%)
        action_sum = np.sum(action)
        if action_sum > 0:
            weights = action / action_sum
        else:
            weights = np.ones(self.num_bridges) / self.num_bridges
            
        allocated_funds = weights * self.order_size
        
        # Calculate execution metrics
        transaction_fees = np.sum(allocated_funds * self.fees)
        latency = np.sum(weights * self.congestion)
        
        # Calculate Slippage / Liquidity Penalty (if AI routes more money than the bridge holds)
        liquidity_penalty = np.sum(np.maximum(0, allocated_funds - self.liquidity)) * 10.0
        
        # Hardcoded Reward Weights (Fees, Latency, Liquidity)
        reward = -(transaction_fees + latency + liquidity_penalty)
        
        # In this prototype, every transfer is a single episodic step
        terminated = True 
        truncated = False
        
        obs = self._get_obs()
        info = {
            "total_fees": transaction_fees, 
            "total_latency": latency, 
            "liquidity_penalty": liquidity_penalty
        }
        
        return obs, reward, terminated, truncated, info

    def render(self):
        print(f"Current Environment State -> Fees: {self.fees} | Liquidity: {self.liquidity}")