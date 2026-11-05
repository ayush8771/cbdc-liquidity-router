"""`decision_id` and the artefact fingerprints as the real engine produces them.

Contract §2.2, §2.11 and §9.1 A-1, A-2, A-9. The byte-for-byte golden vectors live in
`test_hashing_vectors.py`; this file checks the engine's own values and the rules that only
the engine can show: which artefacts are hashed, that the service knowledge hash is the
LF-normalised one rather than Phase 1's raw-byte value, and that reordering an explicit
request's venues changes neither the ID nor the allocations.
"""
import re

import pytest

from cbdc_inference.hashing import ID_ARTEFACTS, sha256_text_file
from cbdc_inference.engine import (ExplicitHistory, ExplicitState, ExplicitVenue, ReplayState, ScenarioState,
                                   Transaction)

DATE = "2024-06-14"
GBR_PHL = ("GBR->PHL#0", "GBR->PHL#1", "GBR->PHL#2")
TX = Transaction("GBR", "PHL", 300000.0)
ID_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


# ------------------------------------------------------------------ artefact fingerprints (A-2)
def test_exactly_the_six_decision_id_artefacts_are_computed(worker):
    assert set(worker.artefacts) == set(ID_ARTEFACTS)
    assert len(ID_ARTEFACTS) == 6
    assert all(re.fullmatch(r"[0-9a-f]{64}", v) for v in worker.artefacts.values())


def test_service_knowledge_hash_is_lf_normalised_not_phase1_raw_bytes(worker):
    """§2.2 / A-2: `knowledge_sha256` is the Phase 2 SERVICE hash, computed after CRLF->LF, so
    it is identical on Windows and Linux. Phase 1's `KnowledgeBase.sha256` hashes the raw file
    bytes, so on a Windows CRLF checkout it differs; Phase 2 never reports that value."""
    expected = sha256_text_file(worker.repo_root / "data/knowledge/regulatory_facts.json")
    assert worker.artefacts["knowledge_sha256"] == expected
    raw = worker.knowledge.sha256
    if (worker.repo_root / "data/knowledge/regulatory_facts.json").read_bytes().count(b"\r\n"):
        assert worker.artefacts["knowledge_sha256"] != raw, "a CRLF checkout must differ from the raw-byte hash"


def test_daily_state_fingerprint_is_the_frame_fingerprint_not_the_parquet_bytes(worker):
    """The sixth artefact is the fingerprint of the LOADED frame (§2.11), so it is stable
    across platforms even though the parquet bytes need not be."""
    from cbdc_inference.hashing import daily_state_fingerprint
    assert worker.artefacts["daily_state_sha256"] == daily_state_fingerprint(worker.baseline_frame)
    assert worker.daily_state_sha256 == worker.artefacts["daily_state_sha256"]


def test_scenarios_fingerprint_is_not_one_of_the_decision_id_artefacts(worker):
    """§2.2: `scenarios_sha256` is a cache key and does NOT enter `decision_id`, because the
    scenario fields that affect a decision are hashed directly (§2.11)."""
    assert "scenarios_sha256" not in worker.artefacts
    assert re.fullmatch(r"[0-9a-f]{64}", worker.scenarios_fingerprint())


# ------------------------------------------------------------------ decision_id shape and scope (A-1)
def test_every_decision_carries_a_non_null_id(worker):
    states = [ReplayState(DATE), ScenarioState(DATE, "cheapest_venue_outage"),
              ExplicitState(DATE, tuple(ExplicitVenue(u, 100000.0, 0.3) for u in GBR_PHL))]
    for state in states:
        for policy in ("waterfall", "cheapest_feasible"):
            r = worker.route(TX, state, policy)
            assert ID_RE.match(r.decision_id), (state.mode, policy)


def test_rejected_transactions_still_get_an_id(worker):
    """A regulatory rejection is a 200 result, not an error, so it has a `decision_id` too."""
    r = worker.route(Transaction("GBR", "PHL", 600000.0), ReplayState(DATE))
    assert r.allowed is False and ID_RE.match(r.decision_id)


def test_the_id_is_stable_across_repeated_requests(worker):
    a = worker.route(TX, ReplayState(DATE))
    b = worker.route(TX, ReplayState(DATE))
    assert a.decision_id == b.decision_id


@pytest.mark.parametrize("policy_a,policy_b", [("waterfall", "cheapest_feasible")])
def test_policy_changes_the_id(worker, policy_a, policy_b):
    assert worker.route(TX, ReplayState(DATE), policy_a).decision_id != \
        worker.route(TX, ReplayState(DATE), policy_b).decision_id


def test_the_default_policy_hashes_as_waterfall(worker):
    """§2.11: the policy is hashed AFTER defaulting, so an omitted policy equals an explicit
    `waterfall`."""
    assert worker.route(TX, ReplayState(DATE), None).decision_id == \
        worker.route(TX, ReplayState(DATE), "waterfall").decision_id


def test_client_reference_is_excluded(worker):
    """§2.11: `client_reference` is never hashed."""
    a = worker.route(Transaction("GBR", "PHL", 300000.0, "ref-a"), ReplayState(DATE))
    b = worker.route(Transaction("GBR", "PHL", 300000.0, "ref-b"), ReplayState(DATE))
    assert a.decision_id == b.decision_id and a.client_reference != b.client_reference


def test_integer_and_float_amounts_hash_alike(worker):
    """§2.11: `300000` and `300000.0` normalise to the same binary64 value."""
    assert worker.route(Transaction("GBR", "PHL", 300000), ReplayState(DATE)).decision_id == \
        worker.route(Transaction("GBR", "PHL", 300000.0), ReplayState(DATE)).decision_id


@pytest.mark.parametrize("mutate", [
    lambda: (Transaction("GBR", "PHL", 300001.0), ReplayState(DATE)),
    lambda: (TX, ReplayState("2024-06-13")),
    lambda: (TX, ScenarioState(DATE, "cheapest_venue_outage")),
    lambda: (Transaction("USA", "IND", 300000.0), ReplayState(DATE)),
])
def test_hashed_inputs_change_the_id(worker, mutate):
    baseline = worker.route(TX, ReplayState(DATE)).decision_id
    tx, state = mutate()
    assert worker.route(tx, state).decision_id != baseline


def test_scenario_id_is_part_of_the_id(worker):
    a = worker.route(TX, ScenarioState(DATE, "congestion_x2")).decision_id
    b = worker.route(TX, ScenarioState(DATE, "liquidity_minus50")).decision_id
    assert a != b


def test_baseline_ids_never_depend_on_a_checkpoint(worker, monkeypatch):
    """§2.11: `checkpoint_sha256` is null for every policy but `ppo_projected`, so approving a
    checkpoint never changes a baseline decision's ID."""
    from cbdc_inference.checkpoints import ApprovedCheckpoint
    before = worker.route(TX, ReplayState(DATE), "waterfall").decision_id
    monkeypatch.setattr(worker, "checkpoint",
                        ApprovedCheckpoint("c1", "outputs/x/ppo_checkpoint.pt", "a" * 64, "o", "2026-11-05", "e"))
    after = worker.route(TX, ReplayState(DATE), "waterfall").decision_id
    assert after == before
    assert worker.route(TX, ReplayState(DATE), "waterfall").checkpoint_sha256 is None


# ------------------------------------------------------------------ explicit venue order (A-1)
def _venues(order, with_history=False):
    values = {"GBR->PHL#0": (210000.0, 0.35), "GBR->PHL#1": (60000.0, 0.2), "GBR->PHL#2": (90000.0, 0.5)}
    out = []
    for uid in order:
        liq, cong = values[uid]
        history = ExplicitHistory(tuple([liq] * 30), tuple([cong] * 30)) if with_history else None
        out.append(ExplicitVenue(uid, liq, cong, history))
    return tuple(out)


def test_reordering_explicit_venues_changes_neither_the_id_nor_the_allocations(worker):
    """§2.4 and §2.11 (owner decision): the ordinal `bridge_uid` sort is for HASHING only.
    Execution, `allocations[].slot` and the explanations keep Phase 1's slot order, matching
    each request venue to its slot by `bridge_uid`."""
    straight = worker.route(TX, ExplicitState(DATE, _venues(GBR_PHL)))
    shuffled = worker.route(TX, ExplicitState(DATE, _venues(("GBR->PHL#2", "GBR->PHL#0", "GBR->PHL#1"))))
    assert straight.decision_id == shuffled.decision_id
    assert straight.allocations == shuffled.allocations
    assert [a.slot for a in shuffled.allocations] == sorted(a.slot for a in shuffled.allocations)


def test_history_null_equals_history_omitted(worker):
    """§2.4 / §2.11: `history: null` and an omitted history mean the same thing and hash alike."""
    explicit_none = ExplicitState(DATE, _venues(GBR_PHL))  # history is None on every venue
    a = worker.route(TX, explicit_none).decision_id
    b = worker.route(TX, ExplicitState(DATE, tuple(
        ExplicitVenue(v.bridge_uid, v.liquidity_usd, v.congestion) for v in explicit_none.venues))).decision_id
    assert a == b


def test_supplied_history_changes_the_id(worker):
    """A history is a hashed input, so supplying one is a different decision from omitting it."""
    without = worker.route(TX, ExplicitState(DATE, _venues(GBR_PHL))).decision_id
    with_history = worker.route(TX, ExplicitState(DATE, _venues(GBR_PHL, with_history=True))).decision_id
    assert without != with_history


def test_explicit_values_change_the_id(worker):
    base = worker.route(TX, ExplicitState(DATE, _venues(GBR_PHL))).decision_id
    changed = ExplicitState(DATE, (ExplicitVenue("GBR->PHL#0", 210001.0, 0.35),
                                   ExplicitVenue("GBR->PHL#1", 60000.0, 0.2),
                                   ExplicitVenue("GBR->PHL#2", 90000.0, 0.5)))
    assert worker.route(TX, changed).decision_id != base


# ------------------------------------------------------------------ route / compare / explain (A-9)
def test_route_compare_and_explain_agree(worker):
    """A-9: the same request gives the same ID on all three endpoints, and a compare entry
    equals its route."""
    state = ScenarioState(DATE, "cheapest_venue_outage")
    routed = worker.route(TX, state, "cheapest_feasible")
    compared = worker.compare(TX, state, ["waterfall", "cheapest_feasible"])
    explained = worker.explain(TX, state, "cheapest_feasible")
    entry = next(r for r in compared["results"] if r.policy == "cheapest_feasible")
    assert routed.decision_id == entry.decision_id == explained["decision_id"]
    assert routed == entry


def test_compare_hashes_each_policy_not_the_policies_list(worker):
    """§2.9: each result's ID is computed for its own policy, never over the list, so the IDs
    inside one comparison differ from each other."""
    compared = worker.compare(TX, ReplayState(DATE), ["waterfall", "cheapest_feasible"])
    ids = [r.decision_id for r in compared["results"]]
    assert len(set(ids)) == len(ids)
    for r in compared["results"]:
        assert r.decision_id == worker.route(TX, ReplayState(DATE), r.policy).decision_id
