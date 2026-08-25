import torch
import torch.nn as nn

class RLAgent(nn.Module):
    """Deep RL Policy Network for CBDC routing decisions."""
    def __init__(self, state_dim=64, action_dim=4):
        super(RLAgent, self).__init__()
        self.network = nn.Sequential(
            nn.Linear(state_dim, 128),
            nn.ReLU(),
            nn.Linear(128, 64),
            nn.ReLU(),
            nn.Linear(64, action_dim)
        )

    def forward(self, state):
        return self.network(state)

    def select_action(self, state_tensor):
        with torch.no_grad():
            q_values = self.forward(state_tensor)
            return torch.argmax(q_values).item()