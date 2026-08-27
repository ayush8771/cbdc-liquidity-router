"""Stage 1D - end-to-end CNN+PPO actor-critic.

The CNN (FeatureExtractor1DCNN, UNMODIFIED architecture from Stage 1C -
no Transformer/attention/BiLSTM/hybrid) is instantiated as a genuine
nn.Module submodule here, so PPO's backward pass updates its weights
jointly with the policy/value heads. This is the trainable pathway;
Stage1CObservationWrapper (frozen, precomputed embeddings) remains
untouched as a separate reference/ablation path.

Architecture:
    raw_features (31,) --------------------------------------\
                                                                +-- concat (415,) -> actor MLP -> Dirichlet concentration (masked)
    windows (6,2,30) -> shared CNN (per populated slot) -> (384,) /
                                                                \
                                                                 +-- concat (415,) -> critic MLP -> value (1,)

CNN weight sharing: ONE shared CNN instance feeds both actor and critic
(default, per the approved spec) - fewer parameters, standard PPO
feature-sharing pattern.
"""
import numpy as np
import torch
import torch.nn as nn
from torch.distributions import Dirichlet

from ..models.feature_extractor import FeatureExtractor1DCNN
from ..models.stage1c_windowing import SEQUENCE_LENGTH, FEATURE_DIM, NUM_CHANNELS, MAX_SLOTS

RAW_FEATURES_DIM = 31
CNN_BLOCK_DIM = MAX_SLOTS * FEATURE_DIM  # 384
COMBINED_DIM = RAW_FEATURES_DIM + CNN_BLOCK_DIM  # 415

MIN_CONCENTRATION = 1e-3  # numerical floor, avoids Dirichlet degeneracy


class PPOActorCritic(nn.Module):
    def __init__(self, hidden_dim=128):
        super().__init__()
        # Shared, trainable CNN - same architecture as Stage 1C, unmodified.
        self.cnn = FeatureExtractor1DCNN(
            input_channels=NUM_CHANNELS, sequence_length=SEQUENCE_LENGTH, feature_dim=FEATURE_DIM
        )

        self.actor_trunk = nn.Sequential(
            nn.Linear(COMBINED_DIM, hidden_dim), nn.ReLU(),
            nn.Linear(hidden_dim, hidden_dim), nn.ReLU(),
        )
        self.actor_head = nn.Linear(hidden_dim, MAX_SLOTS)  # -> Dirichlet concentration (pre-softplus)

        self.critic_trunk = nn.Sequential(
            nn.Linear(COMBINED_DIM, hidden_dim), nn.ReLU(),
            nn.Linear(hidden_dim, hidden_dim), nn.ReLU(),
        )
        self.critic_head = nn.Linear(hidden_dim, 1)

    def _embed(self, raw_features, windows, mask):
        """raw_features: (B,31), windows: (B,6,2,30), mask: (B,6) bool.
        Returns (B,415) combined features. Padded/infeasible slots'
        windows are zero'd upstream by the wrapper - only feasible slots
        are actually run through the CNN, per Stage 1C's rule (padded
        slots must bypass the CNN, not just receive zero input)."""
        B = raw_features.shape[0]
        cnn_out = torch.zeros(B, MAX_SLOTS, FEATURE_DIM, device=raw_features.device)

        # Run the CNN only on feasible slots, batched across (batch x slot).
        flat_windows = windows.reshape(B * MAX_SLOTS, NUM_CHANNELS, SEQUENCE_LENGTH)
        flat_mask = mask.reshape(B * MAX_SLOTS)
        if flat_mask.any():
            feasible_windows = flat_windows[flat_mask]
            feasible_embeddings = self.cnn(feasible_windows)  # (n_feasible, 64)
            flat_out = cnn_out.reshape(B * MAX_SLOTS, FEATURE_DIM)
            flat_out[flat_mask] = feasible_embeddings
            cnn_out = flat_out.reshape(B, MAX_SLOTS, FEATURE_DIM)

        cnn_block = cnn_out.reshape(B, CNN_BLOCK_DIM)
        return torch.cat([raw_features, cnn_block], dim=-1)

    def forward(self, raw_features, windows, mask):
        combined = self._embed(raw_features, windows, mask)
        concentration = torch.nn.functional.softplus(self.actor_head(self.actor_trunk(combined))) + MIN_CONCENTRATION
        value = self.critic_head(self.critic_trunk(combined)).squeeze(-1)
        return concentration, value

    def _sample_or_evaluate(self, concentration, mask, given_actions=None, deterministic=False):
        """Proper feasible-subset Dirichlet, per the required correction:
        - the Dirichlet is constructed ONLY over feasible slots (no fake
          near-zero concentration on infeasible slots)
        - sampling/log_prob happens strictly in the feasible-dimensional
          subspace, then the result is scattered back into the full
          6-slot vector with infeasible slots exactly 0
        - all-infeasible case is handled explicitly (no Dirichlet built
          at all): action is the zero vector, log_prob/entropy defined
          as 0 (a degenerate/undefined distribution has no density to
          evaluate - 0 is the conventional placeholder, consistent with
          this case contributing no signal to the PPO update)
        - single-feasible-slot case is handled explicitly too: a 1-
          category Dirichlet is a point mass at 1.0 (no real randomness),
          so log_prob/entropy are defined as 0 rather than constructing
          a degenerate torch.distributions.Dirichlet with k=1
        Batched per-sample (a python loop over the batch) because the
        feasible-slot COUNT can differ per sample, which
        torch.distributions.Dirichlet cannot represent as a single
        batched call - this env always has either 3 feasible slots
        (populated corridor) or 0 (regulatory rejection), but the code
        does not assume that; it handles 1/2/3+ generically.
        """
        B, K = concentration.shape
        actions_out, log_probs, entropies = [], [], []

        for b in range(B):
            idx = mask[b].nonzero(as_tuple=True)[0]  # feasible slot indices, long tensor
            n = idx.numel()

            if n == 0:
                action_full = torch.zeros(K, device=concentration.device, dtype=concentration.dtype)
                log_prob_b = torch.zeros((), device=concentration.device, dtype=concentration.dtype)
                entropy_b = torch.zeros((), device=concentration.device, dtype=concentration.dtype)
                actions_out.append(action_full)
                log_probs.append(log_prob_b)
                entropies.append(entropy_b)
                continue

            conc_sub = concentration[b].index_select(0, idx)  # (n,), still requires_grad-connected

            if n == 1:
                action_sub = torch.ones_like(conc_sub)  # point mass - only one feasible slot gets everything
                log_prob_b = torch.zeros((), device=concentration.device, dtype=concentration.dtype)
                entropy_b = torch.zeros((), device=concentration.device, dtype=concentration.dtype)
            else:
                dist = Dirichlet(conc_sub)
                if given_actions is not None:
                    given_sub = given_actions[b].index_select(0, idx).clamp_min(1e-8)
                    action_sub = given_sub / given_sub.sum()
                elif deterministic:
                    action_sub = conc_sub / conc_sub.sum()
                else:
                    action_sub = dist.rsample() if self.training else dist.sample()
                log_prob_b = dist.log_prob(action_sub)
                entropy_b = dist.entropy()

            action_full = torch.zeros(K, device=concentration.device, dtype=concentration.dtype)
            action_full = action_full.scatter(0, idx, action_sub)
            actions_out.append(action_full)
            log_probs.append(log_prob_b)
            entropies.append(entropy_b)

        return torch.stack(actions_out), torch.stack(log_probs), torch.stack(entropies)

    def act(self, raw_features, windows, mask, deterministic=False):
        """Samples a masked Dirichlet action over feasible slots only."""
        concentration, value = self.forward(raw_features, windows, mask)
        action, log_prob, _entropy = self._sample_or_evaluate(concentration, mask, given_actions=None, deterministic=deterministic)
        return action, log_prob, value

    def evaluate_actions(self, raw_features, windows, mask, actions):
        """For PPO update: recompute log_prob/value/entropy for stored
        actions under the CURRENT policy parameters, using the SAME
        feasible-subset construction as act() - required for the PPO
        ratio to be well-defined."""
        concentration, value = self.forward(raw_features, windows, mask)
        _action, log_prob, entropy = self._sample_or_evaluate(concentration, mask, given_actions=actions, deterministic=False)
        return log_prob, value, entropy
