"""Stage 1E step 1 tests: knowledge base, static memory provider, and
behaviour parity of the CogneeMemoryLayer compatibility wrapper.

No network, LLM or Cognee access is required.
"""
import copy
import json
import os
import subprocess
import sys

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from src.memory.cognee_layer import CogneeMemoryLayer
from src.memory.knowledge import (DEFAULT_KNOWLEDGE_PATH, KnowledgeValidationError, build_knowledge_base,
                                  load_knowledge)
from src.memory.provider import (REASON_OK, REASON_OVER_LIMIT, REASON_RESTRICTED, MemoryProvider,
                                 StaticMemoryProvider)

LEGACY_CONSTRAINTS = {"max_single_transfer_usd": 500000.0, "restricted_corridors": []}


def _legacy_check(constraints, sender, receiver, amount):
    """Verbatim logic of the pre-Stage-1E stub (src/memory/cognee_layer.py at commit 782099f)."""
    if amount > constraints["max_single_transfer_usd"]:
        return False, "Transaction amount exceeds single transfer policy limit."
    if (sender, receiver) in constraints["restricted_corridors"]:
        return False, "Corridor restricted under active memory policy rules."
    return True, "Valid transaction under memory rules."


def _fact(**over):
    f = {"fact_id": "f1", "rule_type": "max_single_transfer_usd", "value": 100.0,
         "scope": {"sender": "*", "receiver": "*"}, "effective_from": None, "effective_to": None,
         "provenance_tag": "synthetic", "verified": False, "source": "unit test"}
    f.update(over)
    return f


def _kb(*facts):
    return build_knowledge_base({"schema_version": 1, "knowledge_version": "test", "facts": list(facts)})


def _raises(fn, exc=KnowledgeValidationError, contains=None):
    try:
        fn()
    except exc as e:
        assert contains is None or contains in str(e), f"message {e!r} lacks {contains!r}"
        return
    raise AssertionError(f"expected {exc.__name__}")


# --- Knowledge base -----------------------------------------------------------

def test_seed_knowledge_file_loads_and_is_provenance_tagged():
    kb = load_knowledge()
    assert kb.schema_version == 1 and kb.knowledge_version and len(kb.sha256) == 64
    assert [f.fact_id for f in kb.facts] == ["global_max_single_transfer_usd"]
    f = kb.facts[0]
    assert f.value == 500000.0 and f.is_global and f.is_undated
    assert f.provenance_tag == "project_assumption" and f.verified is False and f.source


def test_seed_file_contains_no_verified_or_real_regulation_facts():
    # No real regulatory facts have been sourced yet; none may be presented as verified.
    kb = load_knowledge()
    assert not any(f.verified or f.provenance_tag.startswith("real_") for f in kb.facts)


def test_validation_rejects_bad_facts():
    _raises(lambda: _kb(_fact(rule_type="max_fee")), contains="unknown rule_type")
    _raises(lambda: _kb(_fact(value=-1.0)), contains="finite positive")
    _raises(lambda: _kb(_fact(value=float("nan"))), contains="finite positive")
    _raises(lambda: _kb(_fact(value=float("inf"))), contains="finite positive")
    _raises(lambda: _kb(_fact(value=True)), contains="finite positive")
    _raises(lambda: _kb(_fact(source="")), contains="source")
    _raises(lambda: _kb(_fact(provenance_tag="made_up")), contains="provenance_tag")
    _raises(lambda: _kb(_fact(verified="yes")), contains="verified")
    _raises(lambda: _kb(_fact(provenance_tag="project_assumption", verified=True)), contains="cannot be marked verified")
    _raises(lambda: _kb(_fact(effective_from="2025-02-01", effective_to="2025-01-01")), contains="after")
    _raises(lambda: _kb(_fact(effective_from="not-a-date")), contains="invalid effective_from")
    _raises(lambda: _kb(_fact(scope={"sender": "USA"})), contains="scope")
    _raises(lambda: _kb(_fact(rule_type="restricted_corridor", value=None)), contains="exact sender")
    _raises(lambda: _kb(_fact(rule_type="restricted_corridor", value=5.0,
                              scope={"sender": "USA", "receiver": "IND"})), contains="value null")
    _raises(lambda: _kb(_fact(), _fact()), contains="duplicate")
    _raises(lambda: build_knowledge_base({"schema_version": 2, "knowledge_version": "x", "facts": []}),
            contains="schema_version")


def test_load_rejects_invalid_json():
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "bad.json")
        open(p, "w", encoding="utf-8").write("{not json")
        _raises(lambda: load_knowledge(p), contains="invalid JSON")


# --- Static provider ----------------------------------------------------------

def test_static_provider_satisfies_protocol_and_is_deterministic():
    p = StaticMemoryProvider()
    assert isinstance(p, MemoryProvider)
    a = p.explain("USA", "IND", 600000.0)
    b = StaticMemoryProvider().explain("USA", "IND", 600000.0)
    assert a == b
    assert a["allowed"] is False and a["decisive_fact_ids"] == ["global_max_single_transfer_usd"]
    assert a["knowledge_sha256"] == load_knowledge().sha256


def test_cap_boundary_matches_legacy_strict_inequality():
    p = StaticMemoryProvider()
    assert p.check_transaction("USA", "IND", 500000.0) == (True, REASON_OK)
    assert p.check_transaction("USA", "IND", 500000.01) == (False, REASON_OVER_LIMIT)


def test_most_restrictive_applicable_cap_wins():
    kb = _kb(_fact(fact_id="global", value=1000.0),
             _fact(fact_id="usa_ind", value=200.0, scope={"sender": "USA", "receiver": "IND"}),
             _fact(fact_id="usa_any", value=500.0, scope={"sender": "USA", "receiver": "*"}))
    p = StaticMemoryProvider(knowledge=kb)
    assert p.check_transaction("USA", "IND", 300.0)[0] is False
    assert p.explain("USA", "IND", 300.0)["decisive_fact_ids"] == ["usa_ind"]
    assert p.check_transaction("USA", "PHL", 300.0)[0] is True   # only global + usa_any apply
    assert p.check_transaction("USA", "PHL", 600.0)[0] is False
    assert p.check_transaction("GBR", "PHL", 900.0)[0] is True


def test_restricted_corridor_is_exact_and_checked_after_cap():
    kb = _kb(_fact(fact_id="cap", value=1000.0),
             _fact(fact_id="block", rule_type="restricted_corridor", value=None, scope={"sender": "ARE", "receiver": "MEX"}))
    p = StaticMemoryProvider(knowledge=kb)
    assert p.check_transaction("ARE", "MEX", 10.0) == (False, REASON_RESTRICTED)
    assert p.check_transaction("MEX", "ARE", 10.0) == (True, REASON_OK)
    assert p.check_transaction("ARE", "MEX", 5000.0) == (False, REASON_OVER_LIMIT)  # cap checked first, as legacy


def test_as_of_date_lookup_is_inclusive_and_never_assumes_today():
    kb = _kb(_fact(fact_id="cap", value=1000.0),
             _fact(fact_id="dated", value=100.0, effective_from="2024-03-01", effective_to="2024-03-31"),
             _fact(fact_id="open_end", rule_type="restricted_corridor", value=None,
                   scope={"sender": "USA", "receiver": "IND"}, effective_from="2025-01-01"))
    p = StaticMemoryProvider(knowledge=kb)
    ids = lambda d: sorted(f.fact_id for f in p.get_context("USA", "IND", d))
    assert ids("2024-02-29") == ["cap"]
    assert ids("2024-03-01") == ["cap", "dated"]
    assert ids("2024-03-31") == ["cap", "dated"]
    assert ids("2024-04-01") == ["cap"]
    assert ids("2025-01-01") == ["cap", "open_end"]
    assert ids(None) == ["cap"]  # no date -> only undated facts
    assert p.check_transaction("USA", "IND", 500.0, "2024-03-15") == (False, REASON_OVER_LIMIT)
    assert p.check_transaction("USA", "IND", 500.0, "2024-04-15") == (True, REASON_OK)
    assert p.check_transaction("USA", "IND", 10.0, "2025-06-01") == (False, REASON_RESTRICTED)


# --- Compatibility wrapper ----------------------------------------------------

def test_wrapper_constraints_equal_legacy_values():
    layer = CogneeMemoryLayer()
    assert layer.constraints == LEGACY_CONSTRAINTS
    assert type(layer.constraints["max_single_transfer_usd"]) is float
    assert layer.constraints_overridden() is False


def test_wrapper_check_matches_legacy_logic_on_grid():
    layer = CogneeMemoryLayer()
    corridors = [("USA", "IND"), ("GBR", "PHL"), ("ARE", "MEX"), ("IND", "USA"), ("XXX", "YYY")]
    amounts = [0.0, 1.0, 499999.99, 500000.0, 500000.01, 1e6, float("inf")]
    for s, r in corridors:
        for a in amounts:
            assert layer.check_transaction(s, r, a) == _legacy_check(LEGACY_CONSTRAINTS, s, r, a), (s, r, a)


def test_wrapper_respects_runtime_override_like_env():
    from src.envs.cbdc_env import CBDCLiquidityEnv
    env = CBDCLiquidityEnv(max_transfer_usd=1_000_000.0)
    assert env.memory_layer.constraints["max_single_transfer_usd"] == 1_000_000.0
    assert env.memory_layer.check_transaction("USA", "IND", 750000.0)[0] is True
    assert env.memory_layer.constraints_overridden() is True
    e = env.memory_layer.explain("USA", "IND", 750000.0)
    assert e["allowed"] is False and e["enforced_allowed"] is True  # knowledge vs enforced, both reported


def test_wrapper_rejects_facts_the_legacy_check_cannot_express():
    for extra in (_fact(fact_id="dated", value=100.0, effective_from="2024-01-01"),
                  _fact(fact_id="scoped", value=100.0, scope={"sender": "USA", "receiver": "IND"})):
        kb = _kb(_fact(fact_id="cap", value=500000.0), extra)
        _raises(lambda: CogneeMemoryLayer(provider=StaticMemoryProvider(knowledge=kb)), NotImplementedError)
    _raises(lambda: CogneeMemoryLayer(provider=StaticMemoryProvider(knowledge=_kb())), NotImplementedError)


def test_wrapper_supports_undated_restricted_corridor():
    kb = _kb(_fact(fact_id="cap", value=500000.0),
             _fact(fact_id="block", rule_type="restricted_corridor", value=None, scope={"sender": "ARE", "receiver": "MEX"}))
    layer = CogneeMemoryLayer(provider=StaticMemoryProvider(knowledge=kb))
    assert layer.constraints == {"max_single_transfer_usd": 500000.0, "restricted_corridors": [("ARE", "MEX")]}
    assert layer.check_transaction("ARE", "MEX", 1.0) == (False, REASON_RESTRICTED)


def test_feasibility_masks_unchanged_on_all_datasets():
    """Environment feasibility masks and rejection reasons are identical to the
    legacy stub on every Stage 1D split, holdout and the structured fixture."""
    import numpy as np
    from src.envs.cbdc_env import CBDCLiquidityEnv
    files = ["data/structured/transaction_requests.csv"] + [
        f"data/processed/stage1d_transactions_{s}.csv" for s in
        ("train", "validation", "test", "holdout_seed20261102", "holdout_datedisjoint_seed20261103",
         "holdout_datedisjoint_v2_seed20261104")]
    env = CBDCLiquidityEnv()
    checked = 0
    for f in files:
        path = os.path.join(ROOT, f)
        if not os.path.exists(path):
            continue
        df = pd.read_csv(path)
        amount_col = "amount_usd" if "amount_usd" in df.columns else "amount"
        for _, row in df.iterrows():
            req = pd.Series({"sender_country": row["sender_country"], "receiver_country": row["receiver_country"],
                             "amount_usd": float(row[amount_col])})
            mask, bridges, reason = env.get_feasibility_mask(req)
            ok, legacy_reason = _legacy_check(LEGACY_CONSTRAINTS, req.sender_country, req.receiver_country, req.amount_usd)
            if ok:
                expected = np.zeros_like(mask)
                expected[:len(env.bridge_network.get_bridges_for_corridor(req.sender_country, req.receiver_country)[:len(mask)])] = True
                assert reason is None and np.array_equal(mask, expected), (f, row.get("transaction_id"))
            else:
                assert reason == legacy_reason and not mask.any(), (f, row.get("transaction_id"))
            checked += 1
    assert checked >= 2000, checked


def test_memory_modules_do_not_import_cognee():
    code = ("import sys; sys.path.insert(0, r'%s'); import src.memory.cognee_layer, src.memory.provider, "
            "src.memory.knowledge; print('cognee' in sys.modules)" % ROOT)
    out = subprocess.check_output([sys.executable, "-c", code], text=True).strip().splitlines()[-1]
    assert out == "False"


def test_generator_cap_matches_knowledge_base_cap():
    """The Stage 1D transaction generator hard-codes the regulatory cap it samples under.
    It must equal the knowledge-base cap the environment enforces, or generated data would
    silently stop matching the feasibility check."""
    from src.training.transaction_generator import MAX_REGULATORY_TRANSFER_USD
    kb_caps = [f.value for f in load_knowledge().facts
               if f.rule_type == "max_single_transfer_usd" and f.is_global and f.is_undated]
    assert kb_caps == [MAX_REGULATORY_TRANSFER_USD], (kb_caps, MAX_REGULATORY_TRANSFER_USD)
    assert CogneeMemoryLayer().constraints["max_single_transfer_usd"] == MAX_REGULATORY_TRANSFER_USD


def test_seed_file_round_trips_through_fact_serialization():
    raw = json.loads(open(DEFAULT_KNOWLEDGE_PATH, encoding="utf-8").read())
    kb = load_knowledge()
    again = build_knowledge_base({**copy.deepcopy(raw), "facts": [f.to_dict() for f in kb.facts]})
    assert again.facts == kb.facts


if __name__ == "__main__":
    tests = [v for k, v in dict(globals()).items() if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {t.__name__}: {type(e).__name__}: {e}")
    print(f"{len(tests) - failed} passed, {failed} failed out of {len(tests)}")
    sys.exit(1 if failed else 0)
