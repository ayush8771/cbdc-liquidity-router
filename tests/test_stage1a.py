"""Stage 1A deterministic tests: Environment & Network Foundation.

Uses two data sets:
  - The real (synthetic-fixture) structured data at data/structured/
    (unchanged Phase 1 data: 3 corridors, 1 bridge each, small amounts) -
    used for basic loading/masking/observation tests.
  - Dedicated test fixtures at tests/fixtures/structured/ - explicitly
    constructed for this test suite (NOT presented as real or as the
    approved Stage 1B synthetic generator's output) so that capacity
    clipping, unrouted amounts, and multi-bridge-per-corridor behavior can
    be tested deterministically. The USA->IND fixture corridor mirrors the
    three-bridge numerical example ($100,000 / bridges of 40k, 30k, 50k
    capacity at 0.5%/0.8%/0.3% fee) from the approved Action/Execution
    Semantics clarification, so its expected reward components can be
    checked against that worked example by hand.

Run with: python3 -m pytest tests/test_stage1a.py -v
       or: python3 tests/test_stage1a.py   (falls back to plain asserts)
"""
import os
import sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.envs.bridge_network import BridgeNetwork, MAX_BRIDGES
from src.envs.cbdc_env import CBDCLiquidityEnv
from src.envs.reward import compute_reward_components

REAL_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "structured")
FIXTURE_DIR = os.path.join(os.path.dirname(__file__), "fixtures", "structured")


# ---------------------------------------------------------------------------
# 1. Bridge loading
# ---------------------------------------------------------------------------

def test_bridge_loading_real_columns():
    """Confirms the Stage 1A column-name fix: liquidity_capacity/
    latency_fee_pct are read correctly, not silently defaulted."""
    bn = BridgeNetwork(
        bridge_csv=os.path.join(REAL_DIR, "bridge_network.csv"),
        countries_csv=os.path.join(REAL_DIR, "countries.csv"),
    )
    bridges = bn.get_bridges_for_corridor("USA", "IND")
    assert len(bridges) == 1
    assert bridges[0]["capacity"] == 1000000.0, "capacity should read real liquidity_capacity value, not default"
    assert bridges[0]["fee"] == 0.015, "fee should read real latency_fee_pct value"


def test_bridge_loading_multi_bridge_per_corridor():
    """Confirms the storage-structure fix: multiple bridges on the same
    corridor are all retained, not silently overwritten."""
    bn = BridgeNetwork(
        bridge_csv=os.path.join(FIXTURE_DIR, "bridge_network.csv"),
        countries_csv=os.path.join(FIXTURE_DIR, "countries.csv"),
    )
    bridges = bn.get_bridges_for_corridor("USA", "IND")
    assert len(bridges) == 3, f"expected 3 bridges on USA->IND, got {len(bridges)}"
    caps = sorted(b["capacity"] for b in bridges)
    assert caps == [30000.0, 40000.0, 50000.0]


def test_bridge_loading_missing_corridor():
    bn = BridgeNetwork(
        bridge_csv=os.path.join(FIXTURE_DIR, "bridge_network.csv"),
        countries_csv=os.path.join(FIXTURE_DIR, "countries.csv"),
    )
    bridges = bn.get_bridges_for_corridor("USA", "MEX")
    assert bridges == []


# ---------------------------------------------------------------------------
# 2. Transaction loading
# ---------------------------------------------------------------------------

def test_transaction_loading_via_env():
    env = CBDCLiquidityEnv(structured_dir=FIXTURE_DIR)
    assert env.max_steps == 3
    req0 = env._current_request()
    assert req0["sender_country"] == "USA"
    assert req0["receiver_country"] == "IND"
    assert float(req0["amount_usd"]) == 100000.0


# ---------------------------------------------------------------------------
# 3. Feasibility masking
# ---------------------------------------------------------------------------

def test_feasibility_mask_valid_corridor():
    env = CBDCLiquidityEnv(structured_dir=FIXTURE_DIR)
    env.reset()
    mask, bridges, reason = env.get_feasibility_mask()
    assert reason is None
    assert mask[:3].all() and not mask[3:].any()
    assert len(bridges) == 3


def test_feasibility_mask_missing_corridor():
    env = CBDCLiquidityEnv(structured_dir=FIXTURE_DIR)
    req = env.requests_df.iloc[2]  # USA -> MEX, no bridge in fixture
    mask, bridges, reason = env.get_feasibility_mask(req)
    assert reason is None  # not a regulatory rejection, just no bridge
    assert not mask.any()
    assert bridges == []


def test_feasibility_mask_regulatory_rejection():
    env = CBDCLiquidityEnv(structured_dir=FIXTURE_DIR)
    req = env.requests_df.iloc[1]  # GBR -> PHL, $600,000 > $500,000 default cap
    mask, bridges, reason = env.get_feasibility_mask(req)
    assert reason is not None
    assert not mask.any()
    assert bridges == []


def test_feasibility_mask_respects_configured_cap():
    env = CBDCLiquidityEnv(structured_dir=FIXTURE_DIR, max_transfer_usd=1_000_000.0)
    req = env.requests_df.iloc[1]  # $600,000, now under the raised cap
    mask, bridges, reason = env.get_feasibility_mask(req)
    assert reason is None
    # GBR->PHL has exactly one bridge for this corridor, so it occupies
    # mask slot 0 regardless of that row's position in the CSV file.
    assert mask[0] == True
    assert not mask[1:].any()


# ---------------------------------------------------------------------------
# 4 & 5 & 6. Requested allocation / capacity clipping / unrouted amount
# ---------------------------------------------------------------------------

def test_requested_allocation_matches_action_before_clipping():
    """Confirms env does not mutate the action array (log-prob consistency
    precondition) and that requested = action * amount pre-clip."""
    env = CBDCLiquidityEnv(structured_dir=FIXTURE_DIR)
    env.reset()
    action = np.array([0.5, 0.2, 0.3, 0.0, 0.0, 0.0], dtype=np.float32)
    action_copy = action.copy()
    obs, reward, terminated, truncated, info = env.step(action)
    assert np.array_equal(action, action_copy), "env must not mutate the input action array"
    assert abs(info["requested_total"] - 100000.0) < 0.01


def test_capacity_clipping_worked_example():
    """Reproduces the approved $100,000 / 3-bridge worked example exactly:
    requested [50k, 20k, 30k] against capacities [40k, 30k, 50k] should
    execute [40k, 20k, 30k] with $10,000 unrouted (bridge A overflows,
    NOT redistributed to B or C)."""
    env = CBDCLiquidityEnv(structured_dir=FIXTURE_DIR)
    env.reset()
    action = np.array([0.50, 0.20, 0.30, 0.0, 0.0, 0.0], dtype=np.float32)
    obs, reward, terminated, truncated, info = env.step(action)

    assert abs(info["requested_total"] - 100000.0) < 0.01
    assert abs(info["executed_total"] - 90000.0) < 0.01, "40k+20k+30k = 90k executed"
    assert abs(info["unrouted"] - 10000.0) < 0.01, "10k overflow from bridge A, not redistributed"


def test_no_overflow_redistribution():
    """Explicitly confirms bridge B/C don't silently absorb bridge A's
    overflow even though they have spare capacity (B: 30k cap, C: 50k cap,
    both under-requested relative to their capacity here)."""
    env = CBDCLiquidityEnv(structured_dir=FIXTURE_DIR)
    env.reset()
    action = np.array([1.0, 0.0, 0.0, 0.0, 0.0, 0.0], dtype=np.float32)  # all $100k requested on bridge A (40k cap)
    obs, reward, terminated, truncated, info = env.step(action)
    assert abs(info["executed_total"] - 40000.0) < 0.01
    assert abs(info["unrouted"] - 60000.0) < 0.01


def test_infeasible_slot_weight_becomes_unrouted():
    """If an action places weight on a slot beyond the number of real
    bridges for this corridor (only 3 exist, slots 3-5 are padding), that
    weight must NOT be executed - it becomes unrouted, and a warning is
    logged (checked qualitatively; not asserting on log output here)."""
    env = CBDCLiquidityEnv(structured_dir=FIXTURE_DIR)
    env.reset()
    action = np.array([0.5, 0.0, 0.0, 0.5, 0.0, 0.0], dtype=np.float32)  # slot 3 is padding for this corridor
    obs, reward, terminated, truncated, info = env.step(action)
    assert abs(info["executed_total"] - 40000.0) < 0.01  # only bridge A's 50k-request clipped to 40k cap
    # unrouted = 10k (bridge A overflow) + 50k (padding-slot request, never executable) = 60k
    assert abs(info["unrouted"] - 60000.0) < 0.01


# ---------------------------------------------------------------------------
# 7. Reward component calculations
# ---------------------------------------------------------------------------

def test_reward_components_worked_example():
    """Exact numbers from the approved Action/Execution Semantics worked
    example: executed [40k,20k,30k], fees [0.5%,0.8%,0.3%], baseline 5%,
    unit lambda weights (all placeholders, per that doc's own framing)."""
    result = compute_reward_components(
        amount=100000.0,
        executed=[40000.0, 20000.0, 30000.0],
        fees=[0.005, 0.008, 0.003],
        congestion=[0.2, 0.5, 0.1],
        risk=[0.10, 0.30, 0.05],
        unrouted=10000.0,
        baseline_cost_pct=0.05,
        lambda_latency=1.0,
        lambda_risk=1.0,
        lambda_unrouted=1.0,
    )
    assert abs(result["cost_term"] - 0.0405) < 1e-9
    assert abs(result["latency_term"] - 0.21) < 1e-9
    assert abs(result["risk_term"] - 0.115) < 1e-9
    assert abs(result["unrouted_term"] - 0.10) < 1e-9
    assert abs(result["total"] - (-0.3845)) < 1e-9


def test_reward_components_zero_congestion_risk_placeholder():
    """With placeholder congestion/risk = 0 (Stage 1A default, Stage 1B not
    yet built), reward should reduce to pure cost-savings minus unrouted."""
    result = compute_reward_components(
        amount=500.0,
        executed=[500.0],
        fees=[0.015],
        congestion=[0.0],
        risk=[0.0],
        unrouted=0.0,
        baseline_cost_pct=0.05,
    )
    assert abs(result["cost_term"] - 0.035) < 1e-9
    assert result["latency_term"] == 0.0
    assert result["risk_term"] == 0.0
    assert result["unrouted_term"] == 0.0
    assert abs(result["total"] - 0.035) < 1e-9


def test_reward_rejects_mismatched_lengths():
    try:
        compute_reward_components(
            amount=100.0, executed=[10.0, 20.0], fees=[0.1], congestion=[0.0], risk=[0.0], unrouted=0.0
        )
        assert False, "should have raised ValueError"
    except ValueError:
        pass


# ---------------------------------------------------------------------------
# End-to-end / full episode
# ---------------------------------------------------------------------------

def test_full_episode_runs_and_terminates():
    env = CBDCLiquidityEnv(structured_dir=FIXTURE_DIR)
    obs, info = env.reset()
    terminated = False
    steps = 0
    while not terminated:
        action = env.action_space.sample()
        obs, reward, terminated, truncated, info = env.step(action)
        steps += 1
    assert steps == 3


def test_env_still_runs_on_original_phase1_data():
    """Regression check against the original (unmodified) Phase 1 structured
    data - confirms Stage 1A didn't break loading of the real repo data."""
    env = CBDCLiquidityEnv(structured_dir=REAL_DIR)
    obs, info = env.reset()
    action = np.zeros(MAX_BRIDGES, dtype=np.float32)
    action[0] = 1.0
    obs, reward, terminated, truncated, info = env.step(action)
    # USA->IND, $500 amount, 1.5% fee, 5% baseline placeholder -> reward should be data-dependent now
    assert abs(reward - 0.035) < 1e-9  # (0.05*500 - 0.015*500)/500 = 0.035, congestion/risk placeholders=0


ALL_TESTS = [
    test_bridge_loading_real_columns,
    test_bridge_loading_multi_bridge_per_corridor,
    test_bridge_loading_missing_corridor,
    test_transaction_loading_via_env,
    test_feasibility_mask_valid_corridor,
    test_feasibility_mask_missing_corridor,
    test_feasibility_mask_regulatory_rejection,
    test_feasibility_mask_respects_configured_cap,
    test_requested_allocation_matches_action_before_clipping,
    test_capacity_clipping_worked_example,
    test_no_overflow_redistribution,
    test_infeasible_slot_weight_becomes_unrouted,
    test_reward_components_worked_example,
    test_reward_components_zero_congestion_risk_placeholder,
    test_reward_rejects_mismatched_lengths,
    test_full_episode_runs_and_terminates,
    test_env_still_runs_on_original_phase1_data,
]

if __name__ == "__main__":
    passed, failed = 0, 0
    for t in ALL_TESTS:
        try:
            t()
            print(f"PASS  {t.__name__}")
            passed += 1
        except AssertionError as e:
            print(f"FAIL  {t.__name__}: {e}")
            failed += 1
        except Exception as e:
            print(f"ERROR {t.__name__}: {type(e).__name__}: {e}")
            failed += 1
    print(f"\n{passed} passed, {failed} failed out of {len(ALL_TESTS)}")
    sys.exit(1 if failed else 0)