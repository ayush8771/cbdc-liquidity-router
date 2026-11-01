# Plan: investigation of the 6 failed `splitting_needed` transactions

**Status:** plan only. Nothing here has been run or implemented yet.
**Scope:** read-only diagnosis. No changes to the model, reward, environment, data or baselines.

## Subject
Under the seed-42 `entropy005` checkpoint
(`outputs/experiments/stage1d_entropy_pair_seed42_20261031_153140/entropy005/ppo_checkpoint.pt`),
6 of the 48 `splitting_needed` transactions in the test split had unrouted amounts above the
completion tolerance. The baseline (`entropy000`) checkpoint had 14 such failures.

This test split has already been examined, and this diagnosis looks at it again. The findings
must not be used to choose coefficients or model changes that are later scored on this same split.

## Steps
1. **Identify the failures.** Load both seed-42 checkpoints without modifying them and replay
   deterministic PPO on the test split through `evaluate.run_ppo`'s execution path. Record each
   transaction's `transaction_id`, corridor, date, amount and verified regime. Confirm the
   replay reproduces the saved `evaluation_metrics.json` exactly (6 and 14 failures). If it does
   not, stop and report the mismatch.
2. **Record bridge state per failure, for each slot:** bridge id, mask, fee, dynamic liquidity and
   congestion from `get_dynamic_state`, and risk. Also record the cheapest-bridge liquidity, the
   combined feasible liquidity, and the amount relative to each.
3. **Record PPO behaviour:** Dirichlet concentrations, deterministic action, requested and executed
   amount per slot, clipped amount per slot, unrouted amount, and reward components.
4. **Counterfactuals on the same `env.step()`:** the waterfall action, and K=200 stochastic samples
   from the same policy with a fixed sampling seed. Report the best sample's reward and the
   fraction of samples that complete the transaction.
5. **Classify each failure into one of these causes:**
   - (a) over-allocation to a liquidity-limited slot (clipped amount with no redistribution);
   - (b) under-use of slots that had spare capacity;
   - (c) a mismatch between the deterministic mean and good samples (the distribution contains
     good actions but the mean is poor);
   - (d) reward trade-off (a higher-reward action that leaves some amount unrouted);
   - (e) data or environment edge case (e.g. amount close to combined liquidity, mask anomaly).
6. **Cross-check across seeds.** Once `run_entropy_multiseed.py` has finished, repeat steps 1–5 on
   the validation split for each seed's checkpoints. This tells us whether the same failure
   pattern appears on data we haven't already examined.

## Deliverables
- A new script, `diagnose_failed_splitting.py`, that writes to
  `outputs/diagnostics/failed_splitting_<timestamp>/`:
  - a per-transaction CSV;
  - a JSON summary;
  - the exact checkpoint paths and git HEAD used.
- A short write-up that separates measured facts from hypotheses.

## Out of scope until the evidence is reviewed
Reward reweighting, action redistribution, architecture changes, extra training data, and
coefficient sweeps.
