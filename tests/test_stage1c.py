"""Stage 1C deterministic tests: 1D CNN Feature Extraction / windowing /
observation wrapper.

Covers the nine tests from the approved Stage 1C specification:
  1. window correctness
  2. first-29-days zero padding
  3. split-boundary / gap-buffer validation
  4. normalization leakage
  5. slot mapping stability
  6. padded-slot invariance
  7. CNN (3,2,30) -> (3,64) shape
  8. final (415,) observation
  9. Stage 1A regression (re-run via subprocess-free re-import, see bottom)

Run with: python3 -m pytest tests/test_stage1c.py -v
       or: python3 tests/test_stage1c.py
"""
import copy
import json
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import torch

from src.envs.cbdc_env import CBDCLiquidityEnv
from src.envs.stage1c_obs_wrapper import Stage1CObservationWrapper, CNN_BLOCK_DIM
from src.models.feature_extractor import FeatureExtractor1DCNN
from src.models.stage1c_windowing import (
    SLOT_BRIDGE_IDS,
    POPULATED_BRIDGE_IDS,
    SEQUENCE_LENGTH,
    FEATURE_DIM,
    MAX_SLOTS,
    build_window,
    build_all_windows,
    compute_cnn_block,
    load_daily_series,
    load_normalization_stats,
    validate_simulation_date,
    InvalidSimulationDateError,
)
from src.preprocessing.normalization import fit_daily_series_stats
from src.preprocessing.split import SPLIT_BOUNDARIES

REAL_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "structured")
DAILY_PARQUET = os.path.join(os.path.dirname(__file__), "..", "data", "processed",
                              "synthetic_liquidity_congestion_daily.parquet")
STATS_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "processed",
                           "normalization_stats.json")


def _load():
    daily = load_daily_series(DAILY_PARQUET)
    stats = load_normalization_stats(STATS_PATH)
    return daily, stats


# 1. Window correctness --------------------------------------------------

def test_window_correctness_matches_hand_computed_slice():
    daily, stats = _load()
    bridge_id = "USA->IND"
    sim_date = pd.Timestamp("2015-06-15")

    window = build_window(daily, stats, bridge_id, sim_date)
    assert window.shape == (2, SEQUENCE_LENGTH)

    # Hand-computed: last column (index 29) must equal the normalized
    # value of the row dated exactly sim_date.
    row = daily[(daily.bridge_id == bridge_id) & (daily.date == sim_date)].iloc[0]
    liq_stats = stats["liquidity_level"][bridge_id]
    cong_stats = stats["congestion_level"][bridge_id]
    expected_liq = (row["liquidity_level"] - liq_stats["mean"]) / liq_stats["std"]
    expected_cong = (row["congestion_level"] - cong_stats["mean"]) / cong_stats["std"]

    assert np.isclose(window[0, -1], expected_liq, atol=1e-5)
    assert np.isclose(window[1, -1], expected_cong, atol=1e-5)

    # First column (index 0) must equal sim_date - 29 days.
    first_date = sim_date - pd.Timedelta(days=29)
    row0 = daily[(daily.bridge_id == bridge_id) & (daily.date == first_date)].iloc[0]
    expected_liq0 = (row0["liquidity_level"] - liq_stats["mean"]) / liq_stats["std"]
    assert np.isclose(window[0, 0], expected_liq0, atol=1e-5)


# 2. First-29-days zero padding ------------------------------------------

def test_first_29_days_zero_padding_shape_and_content():
    # NOTE: build_window is pure window-mechanics and intentionally does
    # NOT enforce split/gap-buffer validation (that's a transaction-
    # assignment concern, checked separately by validate_simulation_date
    # and enforced at the wrapper level - see test 3 below and
    # stage1c_windowing.py's build_window docstring/comment). This test
    # exercises the padding mechanics directly regardless of whether
    # 2011-01-10 would be a valid transaction anchor date.
    daily, stats = _load()
    bridge_id = "USA->IND"
    sim_date = pd.Timestamp("2011-01-10")  # 9 days into the series

    window = build_window(daily, stats, bridge_id, sim_date)
    assert window.shape == (2, SEQUENCE_LENGTH)  # shape never shrinks

    # Days before 2011-01-01 don't exist -> leading positions must be
    # exact zero, not a repeat of the first real value.
    n_real_days = (sim_date - pd.Timestamp("2011-01-01")).days + 1  # = 10
    n_padded = SEQUENCE_LENGTH - n_real_days  # = 20
    assert n_padded == 20

    assert np.all(window[:, :n_padded] == 0.0)

    # The first real (non-padded) entry must NOT equal a repeat of
    # itself artificially duplicated backward - i.e. padded zeros must
    # differ from the real first value (unless coincidentally zero,
    # which normalized data essentially never is).
    first_real_value = window[0, n_padded]
    assert not np.isclose(first_real_value, 0.0, atol=1e-6), (
        "sanity check: first real value should not itself be ~0 given "
        "z-scored data - if this fails, re-examine test data assumptions."
    )
    # Explicitly confirm no replication: all padded columns are
    # identically 0.0, not identically equal to first_real_value.
    assert not np.all(window[:, :n_padded] == first_real_value)


# 3. Split-boundary / gap-buffer validation -------------------------------

def test_simulation_date_in_gap_buffer_is_rejected():
    # 2021-12-31 is the train end boundary; a date within 30 days of it
    # must be rejected.
    bad_date = pd.Timestamp("2021-12-15")
    try:
        validate_simulation_date(bad_date)
        assert False, "expected InvalidSimulationDateError for gap-buffer date"
    except InvalidSimulationDateError:
        pass


def test_simulation_date_outside_all_splits_is_rejected():
    bad_date = pd.Timestamp("2026-01-01")  # after test split ends
    try:
        validate_simulation_date(bad_date)
        assert False, "expected InvalidSimulationDateError for out-of-range date"
    except InvalidSimulationDateError:
        pass


def test_approved_simulation_dates_are_valid_and_correctly_split():
    assert validate_simulation_date(pd.Timestamp("2015-06-15")) == "train"
    assert validate_simulation_date(pd.Timestamp("2023-06-15")) == "validation"
    assert validate_simulation_date(pd.Timestamp("2025-03-15")) == "test"


def test_wrapper_rejects_transaction_with_gap_buffer_simulation_date():
    # Confirms enforcement lives at the transaction/wrapper boundary
    # (per the fix documented in stage1c_windowing.py), not inside
    # build_window's pure padding mechanics.
    env = CBDCLiquidityEnv(structured_dir=REAL_DIR, raw_dir=os.path.join(REAL_DIR, "..", "raw"))
    wrapped = Stage1CObservationWrapper(env)
    wrapped.env.unwrapped.requests_df.loc[0, "simulation_date"] = "2011-01-10"
    try:
        wrapped.reset()
        assert False, "expected InvalidSimulationDateError from wrapper"
    except InvalidSimulationDateError:
        pass


# 4. Normalization leakage -------------------------------------------------

def test_normalization_leakage_liquidity_congestion():
    daily, _ = _load()
    bridge_id = "USA->IND"

    baseline = fit_daily_series_stats(daily, bridge_id, "liquidity_level")

    tampered = daily.copy()
    future_mask = (tampered.bridge_id == bridge_id) & (tampered.date == pd.Timestamp("2025-01-01"))
    assert future_mask.sum() == 1
    tampered.loc[future_mask, "liquidity_level"] = 1e12  # extreme future value

    tampered_stats = fit_daily_series_stats(tampered, bridge_id, "liquidity_level")

    assert baseline["mean"] == tampered_stats["mean"]
    assert baseline["std"] == tampered_stats["std"]
    assert baseline["n"] == tampered_stats["n"]


# 5. Slot mapping stability -------------------------------------------------

def test_slot_mapping_is_fixed_and_stable():
    expected = ("USA->IND", "GBR->PHL", "ARE->MEX", None, None, None)
    assert SLOT_BRIDGE_IDS == expected
    assert POPULATED_BRIDGE_IDS == ("USA->IND", "GBR->PHL", "ARE->MEX")

    # Re-importing / re-reading must not change ordering (it's a hardcoded
    # tuple, not derived from CSV row order or dict iteration).
    daily, stats = _load()
    daily_shuffled = daily.sample(frac=1.0, random_state=123).reset_index(drop=True)
    w1 = build_all_windows(daily, stats, pd.Timestamp("2015-06-15"))
    w2 = build_all_windows(daily_shuffled, stats, pd.Timestamp("2015-06-15"))
    assert np.allclose(w1, w2), "window order must not depend on input row order"


# 6. Padded-slot invariance -------------------------------------------------

def test_padded_slots_are_exact_zeros_and_bypass_cnn():
    daily, stats = _load()
    cnn = FeatureExtractor1DCNN(input_channels=2, sequence_length=SEQUENCE_LENGTH, feature_dim=FEATURE_DIM)
    cnn.eval()

    block = compute_cnn_block(daily, stats, pd.Timestamp("2015-06-15"), cnn=cnn)
    assert block.shape == (MAX_SLOTS * FEATURE_DIM,)
    block_reshaped = block.reshape(MAX_SLOTS, FEATURE_DIM)

    for slot in (3, 4, 5):
        assert np.all(block_reshaped[slot] == 0.0)

    # Populated slots must NOT be all-zero (CNN output on real data).
    for slot in (0, 1, 2):
        assert not np.all(block_reshaped[slot] == 0.0)


# 7. CNN (3,2,30) -> (3,64) shape -------------------------------------------

def test_cnn_batched_shape():
    cnn = FeatureExtractor1DCNN(input_channels=2, sequence_length=SEQUENCE_LENGTH, feature_dim=FEATURE_DIM)
    x = torch.randn(3, 2, SEQUENCE_LENGTH)
    with torch.no_grad():
        out = cnn(x)
    assert out.shape == (3, FEATURE_DIM)


# 8. Final (415,) observation ------------------------------------------------

def test_final_observation_dimension_and_roundtrip():
    env = CBDCLiquidityEnv(structured_dir=REAL_DIR, raw_dir=os.path.join(REAL_DIR, "..", "raw"))
    wrapped = Stage1CObservationWrapper(env)

    assert wrapped.observation_space.shape == (415,)

    obs, info = wrapped.reset()
    assert obs.shape == (415,)
    assert not np.any(np.isnan(obs))

    action = np.zeros(6, dtype=np.float32)
    action[0] = 1.0
    obs2, reward, terminated, truncated, info = wrapped.step(action)
    assert obs2.shape == (415,)
    assert not np.any(np.isnan(obs2))


def test_observation_dimension_breakdown():
    # 1 (amount) + 6*5 (raw Stage 1A) + 6*64 (CNN block) = 415
    raw_dim = 1 + 6 * 5
    assert raw_dim == 31
    assert CNN_BLOCK_DIM == 384
    assert raw_dim + CNN_BLOCK_DIM == 415


# 9. Stage 1A regression -----------------------------------------------------
# Re-runs the actual Stage 1A test module's ALL_TESTS list in-process, to
# confirm the wrapper approach required zero changes to cbdc_env.py and
# Stage 1A's own behavior is unaffected.

def test_stage1a_regression_all_pass():
    import importlib
    stage1a = importlib.import_module("tests.test_stage1a")
    failed = []
    for t in stage1a.ALL_TESTS:
        try:
            t()
        except Exception as e:  # noqa: BLE001
            failed.append((t.__name__, str(e)))
    assert not failed, f"Stage 1A regression failures: {failed}"


ALL_TESTS = [
    test_window_correctness_matches_hand_computed_slice,
    test_first_29_days_zero_padding_shape_and_content,
    test_simulation_date_in_gap_buffer_is_rejected,
    test_simulation_date_outside_all_splits_is_rejected,
    test_approved_simulation_dates_are_valid_and_correctly_split,
    test_wrapper_rejects_transaction_with_gap_buffer_simulation_date,
    test_normalization_leakage_liquidity_congestion,
    test_slot_mapping_is_fixed_and_stable,
    test_padded_slots_are_exact_zeros_and_bypass_cnn,
    test_cnn_batched_shape,
    test_final_observation_dimension_and_roundtrip,
    test_observation_dimension_breakdown,
    test_stage1a_regression_all_pass,
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
