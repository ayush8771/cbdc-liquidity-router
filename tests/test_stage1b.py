"""Stage 1B deterministic tests."""
import os
import sys
import pandas as pd
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.preprocessing.wdi import build_wdi_fx_features
from src.preprocessing.cpi import build_cpi_features, build_name_to_iso3_crosswalk
from src.preprocessing.rpw import build_rpw_corridor_quarterly, _normalize_speed_bucket
from src.preprocessing.country_reference import build_country_reference_clean
from src.preprocessing.macro_risk import build_macro_risk_components, apply_macro_risk_proxy
from src.preprocessing.normalization import fit_macro_component_stats
from src.preprocessing.are_mex_fallback import build_are_mex_fallback
from src.preprocessing.synthetic_generator import generate_daily_series
from src.preprocessing.split import assign_split, in_gap_buffer, lagged_quarter, lagged_month, SPLIT_BOUNDARIES

RAW = os.path.join(os.path.dirname(__file__), "..", "data", "raw")
STRUCTURED = os.path.join(os.path.dirname(__file__), "..", "data", "structured")
STAGE1A_ORIGINAL_DIR = os.path.join(os.path.dirname(__file__), "fixtures", "stage1a_original")


def test_wdi_no_aggregates():
    df = build_wdi_fx_features(os.path.join(RAW, "WDIData.csv"), os.path.join(STRUCTURED, "countries.csv"))
    # ARB, EAP, HIC etc must not appear
    assert "ARB" not in set(df["iso3"])
    assert "EAP" not in set(df["iso3"])
    assert "USA" in set(df["iso3"])


def test_wdi_no_imputation():
    df = build_wdi_fx_features(os.path.join(RAW, "WDIData.csv"), os.path.join(STRUCTURED, "countries.csv"))
    # fcrf_volatility_5y should be NaN for the first couple of years of any country's series
    usa = df[df["iso3"] == "USA"].sort_values("year")
    assert usa["fcrf_volatility_5y"].iloc[0:2].isna().all() or len(usa) < 3


def test_cpi_matched_month_yoy_computed_not_copied():
    df, _ = build_cpi_features(os.path.join(RAW, "CPI_Price__not_seas__adj_.xlsx"), os.path.join(STRUCTURED, "countries.csv"))
    usa = df[df["iso3"] == "USA"].sort_values("month").reset_index(drop=True)
    # Manually verify one YoY value: month[12] vs month[0] (assuming monthly, contiguous)
    row_month_13 = usa.iloc[12]
    row_month_1 = usa.iloc[0]
    expected = (row_month_13["cpi_level"] / row_month_1["cpi_level"] - 1) * 100.0
    if row_month_13["month"] == row_month_1["month"] + pd.DateOffset(years=1):
        assert abs(row_month_13["cpi_yoy_pct"] - expected) < 1e-6


def test_cpi_crosswalk_manual_entries():
    xwalk = build_name_to_iso3_crosswalk(os.path.join(RAW, "CPI_Price__not_seas__adj_.xlsx"), os.path.join(STRUCTURED, "countries.csv"))
    row = xwalk[xwalk["cpi_country_name"] == "Turkey"].iloc[0]
    assert row["iso3"] == "TUR"
    assert row["match_type"] == "manual"
    unresolved = xwalk[xwalk["cpi_country_name"] == "Congo, Rep."].iloc[0]
    assert pd.isna(unresolved["iso3"])
    assert unresolved["match_type"] == "unresolved"


def test_speed_bucket_normalization():
    assert _normalize_speed_bucket("Less than one hour") == 0.5
    assert _normalize_speed_bucket("less than one hour") == 0.5  # casing variant
    assert _normalize_speed_bucket("Next Day") == 24.0  # casing variant, correctly normalized via .lower()
    assert _normalize_speed_bucket("6 days or more") == 168.0
    assert _normalize_speed_bucket("garbage") is None


def test_rpw_median_aggregation():
    df = build_rpw_corridor_quarterly(os.path.join(RAW, "rpw_dataset_2011_2025_q3.xlsx"))
    row = df[(df["source_code"] == "USA") & (df["destination_code"] == "IND")].iloc[0]
    assert row["n_obs"] > 0
    assert not pd.isna(row["real_cost_baseline"])


def test_rpw_no_fabricated_are_mex():
    df = build_rpw_corridor_quarterly(os.path.join(RAW, "rpw_dataset_2011_2025_q3.xlsx"))
    are_mex = df[(df["source_code"] == "ARE") & (df["destination_code"] == "MEX")]
    assert len(are_mex) == 0, "ARE->MEX must not appear in real RPW output - RPW has zero real observations for it"


def test_country_reference_sentinel_cleaned():
    df = build_country_reference_clean(os.path.join(STRUCTURED, "countries.csv"))
    assert not (df["Region"] == "..").any()
    assert df["Region"].isna().any()  # AFG etc had real ".." values, now NaN


def test_are_mex_fallback_tagged_and_not_real():
    rpw_df = build_rpw_corridor_quarterly(os.path.join(RAW, "rpw_dataset_2011_2025_q3.xlsx"))
    countries_clean = build_country_reference_clean(os.path.join(STRUCTURED, "countries.csv"))
    fallback, provenance = build_are_mex_fallback(rpw_df, countries_clean)
    assert (fallback["data_source_tag"] == "synthetic_no_real_anchor").all()
    assert provenance["tier_used"] == "tier1_exact_destination_match"
    assert provenance["substitute_corridor"] == "USA->MEX"
    assert (fallback["source_code"] == "ARE").all()
    assert (fallback["destination_code"] == "MEX").all()


def test_split_boundaries():
    assert assign_split(pd.Timestamp("2015-06-15")) == "train"
    assert assign_split(pd.Timestamp("2022-06-15")) == "validation"
    assert assign_split(pd.Timestamp("2024-06-15")) == "test"
    assert assign_split(pd.Timestamp("2030-01-01")) is None


def test_gap_buffer():
    assert in_gap_buffer(pd.Timestamp("2021-12-20"))  # within 30 days of train end
    assert in_gap_buffer(pd.Timestamp("2022-01-10"))  # within 30 days of val start
    assert not in_gap_buffer(pd.Timestamp("2015-06-15"))  # deep in train, no boundary nearby


def test_lag_functions_no_same_period_leakage():
    assert lagged_quarter(2020, 1) == (2019, 4)
    assert lagged_quarter(2020, 2) == (2020, 1)
    assert lagged_month(2020, 1) == (2019, 12)
    assert lagged_month(2020, 6) == (2020, 5)


def test_synthetic_generator_reproducibility():
    date_range = pd.date_range("2020-01-01", "2020-01-10", freq="D")
    s1 = generate_daily_series("TEST_BRIDGE", 100000.0, date_range, {}, {}, {}, 0.0, 1.0, 0.0, 1.0, master_seed=42)
    s2 = generate_daily_series("TEST_BRIDGE", 100000.0, date_range, {}, {}, {}, 0.0, 1.0, 0.0, 1.0, master_seed=42)
    assert np.allclose(s1["liquidity_level"], s2["liquidity_level"])
    assert np.allclose(s1["congestion_level"], s2["congestion_level"])


def test_synthetic_generator_different_seed_differs():
    date_range = pd.date_range("2020-01-01", "2020-01-10", freq="D")
    s1 = generate_daily_series("TEST_BRIDGE", 100000.0, date_range, {}, {}, {}, 0.0, 1.0, 0.0, 1.0, master_seed=42)
    s2 = generate_daily_series("TEST_BRIDGE", 100000.0, date_range, {}, {}, {}, 0.0, 1.0, 0.0, 1.0, master_seed=99)
    assert not np.allclose(s1["liquidity_level"], s2["liquidity_level"])


def test_synthetic_generator_configurable_hyperparams():
    date_range = pd.date_range("2020-01-01", "2020-01-10", freq="D")
    s_low = generate_daily_series("TEST_BRIDGE", 100000.0, date_range, {}, {}, {}, 0.0, 1.0, 0.0, 1.0, master_seed=42,
                                    hyperparams={"sigma_base": 0.01})
    s_high = generate_daily_series("TEST_BRIDGE", 100000.0, date_range, {}, {}, {}, 0.0, 1.0, 0.0, 1.0, master_seed=42,
                                     hyperparams={"sigma_base": 0.04})
    assert not np.allclose(s_low["liquidity_level"], s_high["liquidity_level"])


def test_no_stale_carry_forward_flag_exists():
    """Confirms the deprecated 'stale_carry_forward' source_flag from v1 is
    never produced - v3 replaced it with unconditioned_default/cpi_wdi_derived."""
    wdi_df = build_wdi_fx_features(os.path.join(RAW, "WDIData.csv"), os.path.join(STRUCTURED, "countries.csv"))
    cpi_df, _ = build_cpi_features(os.path.join(RAW, "CPI_Price__not_seas__adj_.xlsx"), os.path.join(STRUCTURED, "countries.csv"))
    full_range = pd.date_range("2011-01-01", "2025-09-30", freq="MS")
    macro_df = build_macro_risk_components(wdi_df, cpi_df, ["USA", "IND", "GBR", "PHL", "ARE", "MEX"], full_month_range=full_range)
    assert "stale_carry_forward" not in set(macro_df["source_flag"])


def test_macro_risk_no_real_daily_fx_for_currencies_without_a_fred_file():
    """PHP and AED have no FRED file (per approved Option 2 handling) - even
    though INR/GBP/MXN's real files are now present, PHL/ARE must never
    show real_daily_fx."""
    wdi_df = build_wdi_fx_features(os.path.join(RAW, "WDIData.csv"), os.path.join(STRUCTURED, "countries.csv"))
    cpi_df, _ = build_cpi_features(os.path.join(RAW, "CPI_Price__not_seas__adj_.xlsx"), os.path.join(STRUCTURED, "countries.csv"))
    full_range = pd.date_range("2011-01-01", "2025-09-30", freq="MS")
    macro_df = build_macro_risk_components(wdi_df, cpi_df, ["PHL", "ARE"], full_month_range=full_range)
    assert "real_daily_fx" not in set(macro_df[macro_df["iso3"].isin(["PHL", "ARE"])]["source_flag"])


ALL_TESTS = [
    test_wdi_no_aggregates,
    test_wdi_no_imputation,
    test_cpi_matched_month_yoy_computed_not_copied,
    test_cpi_crosswalk_manual_entries,
    test_speed_bucket_normalization,
    test_rpw_median_aggregation,
    test_rpw_no_fabricated_are_mex,
    test_country_reference_sentinel_cleaned,
    test_are_mex_fallback_tagged_and_not_real,
    test_split_boundaries,
    test_gap_buffer,
    test_lag_functions_no_same_period_leakage,
    test_synthetic_generator_reproducibility,
    test_synthetic_generator_different_seed_differs,
    test_synthetic_generator_configurable_hyperparams,
    test_no_stale_carry_forward_flag_exists,
]

# ---------------------------------------------------------------------------
# Stage 1B review fixes: additional deterministic tests
# ---------------------------------------------------------------------------

def test_train_only_normalization_unaffected_by_future_values():
    """Core leakage test: fitting friction/risk stats using only a
    train-period subset must be IDENTICAL whether or not a future
    (validation/test-period) row exists in the input, and must NOT equal
    what you'd get by (incorrectly) fitting over the full range."""
    from src.preprocessing.normalization import fit_friction_stats, fit_risk_stats

    base_rows = [
        {"source_code": "USA", "destination_code": "IND", "year": 2019, "quarter": 1, "corridor_friction": 1.0},
        {"source_code": "USA", "destination_code": "IND", "year": 2019, "quarter": 2, "corridor_friction": 2.0},
        {"source_code": "USA", "destination_code": "IND", "year": 2020, "quarter": 1, "corridor_friction": 1.5},
    ]
    future_row = {"source_code": "USA", "destination_code": "IND", "year": 2024, "quarter": 1, "corridor_friction": 999.0}

    df_without_future = pd.DataFrame(base_rows)
    df_with_future = pd.DataFrame(base_rows + [future_row])

    stats_a = fit_friction_stats(df_without_future, "USA", "IND")
    stats_b = fit_friction_stats(df_with_future, "USA", "IND")

    assert stats_a["mean"] == stats_b["mean"], "adding a future-period row changed the train-only fitted mean"
    assert stats_a["std"] == stats_b["std"], "adding a future-period row changed the train-only fitted std"
    assert stats_a["n"] == stats_b["n"] == 3, "future row must not be counted into n"

    # And confirm it's genuinely different from a naive full-range fit (999.0 would drag the mean way up)
    naive_mean_with_future = df_with_future["corridor_friction"].mean()
    assert abs(stats_b["mean"] - naive_mean_with_future) > 100, "train-only fit should differ hugely from a full-range fit once a 999.0 outlier is in val/test"


def test_train_only_risk_normalization_excludes_val_test_and_unconditioned():
    from src.preprocessing.normalization import fit_risk_stats
    rows = [
        {"iso3": "IND", "month": pd.Timestamp("2015-01-01"), "macro_risk_proxy": 0.5, "source_flag": "cpi_wdi_derived"},
        {"iso3": "IND", "month": pd.Timestamp("2015-02-01"), "macro_risk_proxy": 1.5, "source_flag": "cpi_wdi_derived"},
        {"iso3": "IND", "month": pd.Timestamp("2015-03-01"), "macro_risk_proxy": None, "source_flag": "unconditioned_default"},
        {"iso3": "IND", "month": pd.Timestamp("2024-01-01"), "macro_risk_proxy": 999.0, "source_flag": "real_daily_fx"},  # val/test period
    ]
    df = pd.DataFrame(rows)
    stats = fit_risk_stats(df, "IND")
    assert stats["n"] == 2  # only the two real, in-train, non-unconditioned rows
    assert abs(stats["mean"] - 1.0) < 1e-9  # (0.5+1.5)/2, NOT dragged by the 999.0 test-period value


def test_unconditioned_default_explicitly_present_for_full_timeline():
    """Fix for review item 2: every month in the requested range must
    appear explicitly, even with no real signal."""
    wdi_df = build_wdi_fx_features(os.path.join(RAW, "WDIData.csv"), os.path.join(STRUCTURED, "countries.csv"))
    cpi_df, _ = build_cpi_features(os.path.join(RAW, "CPI_Price__not_seas__adj_.xlsx"), os.path.join(STRUCTURED, "countries.csv"))
    full_range = pd.date_range("2011-01-01", "2025-09-30", freq="MS")
    macro_df = build_macro_risk_components(wdi_df, cpi_df, ["PHL"], full_month_range=full_range)

    phl = macro_df[macro_df["iso3"] == "PHL"]
    assert len(phl) == len(full_range), "every month in the requested range must be explicitly represented"
    assert (phl["source_flag"] == "unconditioned_default").any(), "PHL should have unconditioned_default months (no FRED source)"
    # Confirm the val/test tail specifically is present, not silently dropped
    val_test_months = phl[phl["month"] >= pd.Timestamp("2022-01-01")]
    assert len(val_test_months) == 45  # 2022-01 through 2025-09 inclusive
    assert (val_test_months["source_flag"] == "unconditioned_default").all()


def test_fred_loader_absent_file_returns_none():
    from src.preprocessing.fx_daily import load_fred_daily
    result = load_fred_daily("INR", raw_dir="/tmp/definitely_does_not_exist_stage1b_test")
    assert result is None


def test_fred_loader_small_controlled_csv():
    """Constructed test fixture (not real data) to verify the loader's
    parsing logic in isolation, independent of the real files' size."""
    tmp_dir = "/tmp/stage1b_fred_test"
    os.makedirs(tmp_dir, exist_ok=True)
    fixture_path = os.path.join(tmp_dir, "DEXINUS.csv")
    with open(fixture_path, "w") as f:
        f.write("observation_date,DEXINUS\n2023-01-02,80.1\n2023-01-03,80.5\n2023-01-04,.\n")

    from src.preprocessing.fx_daily import load_fred_daily
    df = load_fred_daily("INR", raw_dir=tmp_dir)
    assert df is not None
    assert len(df) == 3
    assert df["rate"].isna().sum() == 1  # the "." placeholder should parse to NaN, not crash
    assert df["date"].iloc[0] == pd.Timestamp("2023-01-02")


def test_real_fred_files_produce_real_daily_fx_flag():
    """Uses the actual FRED files supplied by the user - confirms the
    pipeline now genuinely uses real_daily_fx rather than falling back."""
    from src.preprocessing.fx_daily import load_fred_daily
    df = load_fred_daily("INR")  # default raw_dir=data/raw/fred
    assert df is not None, "real DEXINUS.csv should be present and loadable"
    assert len(df) == 1305
    assert df["date"].min() == pd.Timestamp("2021-08-09")
    assert df["date"].max() == pd.Timestamp("2026-08-07")


def test_six_slot_three_populated_compatibility():
    """Confirms Stage 1B's original bridge network (1 bridge per corridor,
    3 corridors total) is compatible with Stage 1A's MAX_BRIDGES=6
    capacity, with no bridges invented to reach 6.

    Uses STAGE1A_ORIGINAL_DIR (isolated fixture), not production
    data/structured/, because Stage 1D (approved) intentionally expanded
    production bridge_network.csv to 9 rows (3 venues/corridor). This
    test's original intent - exactly 3 bridges, one per corridor -
    is preserved unweakened against the isolated fixture, matching the
    same pattern already used in tests/test_stage1a.py for the same
    reason. Stage 1D's 9-bridge production topology is validated
    separately in tests/test_stage1d.py.
    """
    import sys as _sys
    _sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from src.envs.bridge_network import MAX_BRIDGES

    bridge_network = pd.read_csv(os.path.join(STAGE1A_ORIGINAL_DIR, "bridge_network.csv"))
    assert len(bridge_network) == 3
    assert len(bridge_network) <= MAX_BRIDGES, "populated bridges must not exceed the Stage 1A capacity"
    assert MAX_BRIDGES == 6  # confirms the Stage 1A constant this document assumes hasn't silently changed


MORE_TESTS = [
    test_train_only_normalization_unaffected_by_future_values,
    test_train_only_risk_normalization_excludes_val_test_and_unconditioned,
    test_unconditioned_default_explicitly_present_for_full_timeline,
    test_fred_loader_absent_file_returns_none,
    test_fred_loader_small_controlled_csv,
    test_real_fred_files_produce_real_daily_fx_flag,
    test_six_slot_three_populated_compatibility,
    test_macro_risk_no_real_daily_fx_for_currencies_without_a_fred_file,
]


def test_macro_component_leakage_extreme_2025_value_does_not_change_training_output():
    """Required leakage test (review item 1): inject an extreme value into
    a 2024/2025 (validation/test-period) raw component, run the FULL
    two-step pipeline (build_macro_risk_components -> fit_macro_component_stats
    -> apply_macro_risk_proxy), and confirm every TRAINING-period row of
    the final macro_risk_proxy is bit-identical whether or not that
    extreme value is present. This directly tests the actual leakage path
    that was found (full-period z-scoring inside macro_risk.py), not just
    the already-fixed downstream normalization.py layer.
    """
    full_range = pd.date_range("2020-01-01", "2025-12-01", freq="MS")

    def _make_components(extreme_value):
        rows = []
        for i, month in enumerate(full_range):
            cpi_val = 1.0 + 0.1 * (i % 5)  # some ordinary in-range variation
            if month == pd.Timestamp("2025-06-01"):
                cpi_val = extreme_value
            rows.append({
                "iso3": "IND", "month": month,
                "real_fx_volatility": np.nan,
                "fcrf_volatility_5y": np.nan,
                "cpi_volatility_12m": cpi_val,
                "source_flag": "cpi_wdi_derived",
            })
        return pd.DataFrame(rows)

    components_normal = _make_components(1.2)
    components_extreme = _make_components(999999.0)

    stats_normal = fit_macro_component_stats(components_normal, ["IND"])
    stats_extreme = fit_macro_component_stats(components_extreme, ["IND"])

    assert stats_normal["IND"]["cpi_volatility_12m"]["mean"] == stats_extreme["IND"]["cpi_volatility_12m"]["mean"]
    assert stats_normal["IND"]["cpi_volatility_12m"]["std"] == stats_extreme["IND"]["cpi_volatility_12m"]["std"]

    proxy_normal = apply_macro_risk_proxy(components_normal, stats_normal)
    proxy_extreme = apply_macro_risk_proxy(components_extreme, stats_extreme)

    train_end = SPLIT_BOUNDARIES["train"][1]
    train_rows_normal = proxy_normal[proxy_normal["month"] <= train_end].sort_values("month").reset_index(drop=True)
    train_rows_extreme = proxy_extreme[proxy_extreme["month"] <= train_end].sort_values("month").reset_index(drop=True)

    pd.testing.assert_series_equal(
        train_rows_normal["macro_risk_proxy"], train_rows_extreme["macro_risk_proxy"],
        check_names=False,
    )
    row_normal = proxy_normal[proxy_normal["month"] == pd.Timestamp("2025-06-01")]["macro_risk_proxy"].iloc[0]
    row_extreme = proxy_extreme[proxy_extreme["month"] == pd.Timestamp("2025-06-01")]["macro_risk_proxy"].iloc[0]
    assert row_normal != row_extreme


def test_fred_observations_after_simulation_end_excluded():
    """Required FRED boundary test (review item 2): confirms FRED daily
    observations dated after 2025-09-30 (the approved simulation end)
    cannot enter macro_risk_proxy.parquet's real_daily_fx computation -
    verified against the REAL DEXINUS.csv, which genuinely extends to
    2026-08-07."""
    from src.preprocessing.macro_risk import _real_daily_fx_monthly_vol

    sim_end = SPLIT_BOUNDARIES["test"][1]  # 2025-09-30

    without_ceiling = _real_daily_fx_monthly_vol("INR", month_ceiling=None)
    with_ceiling = _real_daily_fx_monthly_vol("INR", month_ceiling=sim_end)

    assert without_ceiling["month"].max() > pd.Timestamp("2025-09-30"), (
        "sanity check: the real DEXINUS.csv must actually extend past the "
        "simulation end for this test to mean anything"
    )
    assert with_ceiling["month"].max() <= pd.Timestamp("2025-09-30")

    wdi_df = build_wdi_fx_features(os.path.join(RAW, "WDIData.csv"), os.path.join(STRUCTURED, "countries.csv"))
    cpi_df, _ = build_cpi_features(os.path.join(RAW, "CPI_Price__not_seas__adj_.xlsx"), os.path.join(STRUCTURED, "countries.csv"))
    full_range = pd.date_range("2011-01-01", "2025-09-30", freq="MS")
    components = build_macro_risk_components(wdi_df, cpi_df, ["IND"], full_month_range=full_range, month_ceiling=sim_end)
    assert components["month"].max() <= pd.Timestamp("2025-09-30")


EVEN_MORE_TESTS = [
    test_macro_component_leakage_extreme_2025_value_does_not_change_training_output,
    test_fred_observations_after_simulation_end_excluded,
]

if __name__ == "__main__":
    passed, failed = 0, 0
    for t in ALL_TESTS + MORE_TESTS + EVEN_MORE_TESTS:
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
    print(f"\n{passed} passed, {failed} failed out of {len(ALL_TESTS) + len(MORE_TESTS) + len(EVEN_MORE_TESTS)}")
    sys.exit(1 if failed else 0)