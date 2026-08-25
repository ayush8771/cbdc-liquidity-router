import torch
import torch.nn as nn

class FeatureExtractor1DCNN(nn.Module):
    """1D CNN Architecture to extract feature representations from macroeconomic time-series data."""
    def __init__(self, input_channels=1, sequence_length=30, feature_dim=64):
        super(FeatureExtractor1DCNN, self).__init__()
        self.conv1 = nn.Conv1d(in_channels=input_channels, out_channels=16, kernel_size=3, padding=1)
        self.relu1 = nn.ReLU()
        self.conv2 = nn.Conv1d(in_channels=16, out_channels=32, kernel_size=3, padding=1)
        self.relu2 = nn.ReLU()
        self.pool = nn.AdaptiveAvgPool1d(8)
        self.fc = nn.Linear(32 * 8, feature_dim)

    def forward(self, x):
        # Input tensor shape: (batch_size, input_channels, sequence_length)
        x = self.relu1(self.conv1(x))
        x = self.relu2(self.conv2(x))
        x = self.pool(x)
        x = x.view(x.size(0), -1)
        out = self.fc(x)
        return out