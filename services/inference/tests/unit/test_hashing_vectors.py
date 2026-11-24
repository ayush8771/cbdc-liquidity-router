"""Golden-vector tests for `decision_id` and the daily-state fingerprint (§2.11, §9.1 A-1/A-2).

These must pass identically on Windows and Linux. Until they do on both, no
cross-platform determinism is claimed (§1).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from cbdc_inference.hashing import (FINGERPRINT_DOMAIN, FINGERPRINT_PANDAS, MAX_SAFE_INTEGER, UnsafeNumberError,
                                    binary64, canonical, compute_decision_id, daily_state_descriptor,
                                    daily_state_fingerprint, decision_document, scenarios_sha256, unsafe_numbers)

VECTORS = Path(__file__).resolve().parents[3].parent / "contracts" / "test-vectors"


def _load(name: str) -> dict:
    path = VECTORS / name
    if not path.is_file():
        pytest.skip(f"test vectors not present: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


# ------------------------------------------------------------------ decision_id
def _decision_vectors():
    payload = _load("decision_id.v1.json")
    return payload["id_scheme"], payload["vectors"]


def test_decision_id_vectors_reproduce_byte_for_byte():
    """A-1: every vector's canonical string and ID, exactly."""
    id_scheme, vectors = _decision_vectors()
    assert id_scheme == 1
    for vector in vectors:
        doc = decision_document(vector["inputs"])
        assert canonical(doc) == vector["canonical"], f"canonical form differs for {vector['name']}"
        assert compute_decision_id(vector["inputs"]) == vector["decision_id"], \
            f"decision_id differs for {vector['name']}"


def test_decision_id_equivalence_pairs_agree():
    """`300000` == `300000.0`, and a null history == a missing one with venues reordered."""
    _, vectors = _decision_vectors()
    by_name = {v["name"]: v["decision_id"] for v in vectors}
    assert by_name["replay_waterfall_default_policy"] == by_name["replay_waterfall_integer_amount"]
    assert by_name["explicit_waterfall_history_null_equals_missing"] == by_name["explicit_waterfall_history_missing"]
    # A compare entry equals the route decision for the same policy and state (A-9).
    assert by_name["scenario_cheapest_feasible"] == by_name["compare_entry_cheapest_feasible"]


def test_excluded_members_do_not_change_the_id():
    """`client_reference`, the scenario `description` and the reward-weight `status` are excluded."""
    _, vectors = _decision_vectors()
    vector = next(v for v in vectors if v["name"] == "replay_waterfall_default_policy")
    baseline = compute_decision_id(vector["inputs"])

    changed = json.loads(json.dumps(vector["inputs"]))
    changed["request"]["transaction"]["client_reference"] = "something-else"
    changed["reward_weights"]["status"] = "calibrated"
    assert compute_decision_id(changed) == baseline


def test_hashed_members_change_the_id():
    _, vectors = _decision_vectors()
    vector = next(v for v in vectors if v["name"] == "replay_waterfall_default_policy")
    baseline = compute_decision_id(vector["inputs"])

    for mutate in (
        lambda d: d.__setitem__("engine_version", "9.9.9"),
        lambda d: d["request"]["transaction"].__setitem__("amount_usd", 300001.0),
        lambda d: d["request"]["state"].__setitem__("date", "2024-06-13"),
        lambda d: d["request"].__setitem__("policy", "cheapest_feasible"),
        lambda d: d["reward_weights"].__setitem__("lambda_risk", 2.0),
        lambda d: d["artefacts"].__setitem__("daily_state_sha256", "0" * 64),
    ):
        changed = json.loads(json.dumps(vector["inputs"]))
        mutate(changed)
        assert compute_decision_id(changed) != baseline


def test_ppo_projected_without_checkpoint_is_refused():
    """A ppo_projected request with no enabled checkpoint gets no ID (it is POLICY_DISABLED)."""
    _, vectors = _decision_vectors()
    vector = next(v for v in vectors if v["name"] == "explicit_ppo_projected")
    changed = json.loads(json.dumps(vector["inputs"]))
    changed["checkpoint_sha256"] = None
    with pytest.raises(ValueError):
        compute_decision_id(changed)


def test_baseline_ignores_a_supplied_checkpoint():
    _, vectors = _decision_vectors()
    vector = next(v for v in vectors if v["name"] == "explicit_waterfall_history_null_equals_missing")
    assert decision_document(vector["inputs"])["checkpoint_sha256"] is None


# ------------------------------------------------------------------ binary64 / unsafe integers
@pytest.mark.parametrize("a,b", [(300000, 300000.0), (1.5e-7, 0.00000015), (0, -0.0),
                                 (MAX_SAFE_INTEGER, float(MAX_SAFE_INTEGER))])
def test_numerically_equal_safe_inputs_normalise_alike(a, b):
    assert binary64(a, "f") == binary64(b, "f")


@pytest.mark.parametrize("value", [9007199254740993, 9007199254740992.0, 9.007199254740992e15, 1e21,
                                   -9007199254740992.0])
def test_unsafe_integers_are_rejected_not_rounded(value):
    with pytest.raises(UnsafeNumberError):
        binary64(value, "transaction.amount_usd")


def test_max_safe_integer_itself_is_accepted():
    assert binary64(MAX_SAFE_INTEGER, "f") == float(MAX_SAFE_INTEGER)


def test_unsafe_numbers_reports_every_path():
    body = {"transaction": {"amount_usd": 1e21},
            "state": {"venues": [{"liquidity_usd": 1.0}, {"liquidity_usd": 2 ** 53}]}}
    assert sorted(unsafe_numbers(body)) == ["state.venues[1].liquidity_usd", "transaction.amount_usd"]


def test_unsafe_numbers_ignores_booleans_and_safe_values():
    assert unsafe_numbers({"a": True, "b": 1.0, "c": "1e21"}) == []


# ------------------------------------------------------------------ daily-state fingerprint
def _frame_from_vector(spec: dict):
    pd = pytest.importorskip("pandas")
    data = {}
    for column in spec["columns"]:
        values = column["values"]
        if column["dtype"].startswith("datetime64"):
            data[column["name"]] = pd.to_datetime(values)
        else:
            data[column["name"]] = pd.Series(values, dtype=column["dtype"])
    index = pd.Index(spec["index"]["values"], dtype=spec["index"]["dtype"], name=spec["index"]["name"])
    return pd.DataFrame(data, index=index)


def test_daily_state_fingerprint_golden_vector():
    """A-2: reproduce the recorded descriptor and fingerprint exactly, with pandas 2.3.3."""
    payload = _load("daily_state_fingerprint.v1.json")
    assert payload["scheme"] == 1
    assert payload["domain_separator"].encode() == FINGERPRINT_DOMAIN
    for vector in payload["vectors"]:
        frame = _frame_from_vector(vector["frame"])
        import rfc8785
        assert rfc8785.dumps(daily_state_descriptor(frame)).decode() == vector["descriptor"], \
            f"descriptor differs for {vector['name']}"
        assert daily_state_fingerprint(frame) == vector["sha256"], f"fingerprint differs for {vector['name']}"


def test_pinned_pandas_version():
    pd = pytest.importorskip("pandas")
    assert pd.__version__ == FINGERPRINT_PANDAS, "the scheme-1 fingerprint is pinned to pandas 2.3.3"


def test_each_frame_property_changes_the_fingerprint():
    """Index values, column order, dtypes, names, row count and values each matter (§2.11 step 5)."""
    pd = pytest.importorskip("pandas")
    base = pd.DataFrame({"a": pd.Series([1, 2], dtype="int64"), "b": pd.Series([0.5, 0.25], dtype="float64")})
    original = daily_state_fingerprint(base)

    variants = {
        "index values": base.set_index(pd.Index([7, 8])),
        "column order": base[["b", "a"]],
        "dtype": base.astype({"a": "int32"}),
        "column name": base.rename(columns={"a": "z"}),
        "row count": base.iloc[:1],
        "values": base.assign(b=[0.5, 0.26]),
        "index name": base.rename_axis("idx"),
    }
    for label, variant in variants.items():
        assert daily_state_fingerprint(variant) != original, f"{label} did not change the fingerprint"


# ------------------------------------------------------------------ scenarios_sha256
def test_scenarios_sha256_is_insertion_order_independent():
    a = {"scenario_id": "baseline", "liquidity_multiplier": 1.0}
    b = {"scenario_id": "congestion_x2", "congestion_multiplier": 2.0}
    assert scenarios_sha256([a, b]) == scenarios_sha256([b, a])


def test_scenarios_sha256_sorts_ordinally():
    """`#10` before `#2`: ordinal, not natural, ordering."""
    items = [{"scenario_id": "s2"}, {"scenario_id": "s10"}]
    assert scenarios_sha256(items) == scenarios_sha256(list(reversed(items)))
    assert scenarios_sha256(items) != scenarios_sha256([{"scenario_id": "s2"}, {"scenario_id": "s11"}])
