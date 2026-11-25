"""Tests for infra/scripts/check_event_contracts.py.

Each negative test copies contracts/events into a temporary root, breaks one rule and checks that the checker
reports it. Run: pytest infra/scripts/tests
"""
import json
import shutil
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
REPO = SCRIPTS.parents[1]
sys.path.insert(0, str(SCRIPTS))

import check_event_contracts as cec  # noqa: E402


@pytest.fixture
def root(tmp_path):
    shutil.copytree(REPO / "contracts" / "events", tmp_path / "contracts" / "events")
    shutil.copytree(REPO / "contracts" / "test-vectors", tmp_path / "contracts" / "test-vectors")
    return tmp_path


def fixture_path(root, rel):
    return root / "contracts" / "events" / "fixtures" / rel


def edit_fixture(root, rel, change):
    path = fixture_path(root, rel)
    data = json.loads(path.read_text(encoding="utf-8"))
    change(data)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def problems(root):
    return cec.Checker(root).run()


def assert_reported(found, *fragments):
    assert any(all(f in p for f in fragments) for p in found), "\n".join(found) or "no problems reported"


def test_repository_event_contracts_conform():
    assert cec.Checker(REPO).run() == []


def test_main_exit_status(root, capsys):
    assert cec.main(["--root", str(REPO)]) == 0
    edit_fixture(root, "envelope/valid_trailing_zero_rate.json", lambda d: d["instance"].update(payload_sha256="0" * 64))
    assert cec.main(["--root", str(root)]) == 1
    assert "FAIL" in capsys.readouterr().out


def test_valid_fixture_with_wrong_hash_is_reported(root):
    edit_fixture(root, "envelope/valid_trailing_zero_rate.json", lambda d: d["instance"].update(payload_sha256="0" * 64))
    assert_reported(problems(root), "valid_trailing_zero_rate.json", "marked valid", "payload_sha256")


def test_invalid_fixture_that_is_accepted_is_reported(root):
    edit_fixture(root, "envelope/invalid_wrong_hash.json", lambda d: d["instance"].update(payload_sha256=cec.payload_hash(d["instance"])))
    assert_reported(problems(root), "invalid_wrong_hash.json", "marked invalid", "accepted")


def test_hash_ignores_key_order_and_uses_the_decimal_string(root):
    ev = json.loads(fixture_path(root, AD4).read_text(encoding="utf-8"))["instance"]
    assert cec.payload_hash(ev) == cec.AD4_EXAMPLE_HASH
    reordered = dict(ev, payload=dict(reversed(list(ev["payload"].items()))))
    assert cec.payload_hash(reordered) == cec.AD4_EXAMPLE_HASH
    assert cec.payload_hash(dict(ev, payload=dict(ev["payload"], rate="1.23450"))) != cec.AD4_EXAMPLE_HASH


AD4 = cec.AD4_EXAMPLE_FIXTURE


def test_ad4_example_is_required(root):
    edit_fixture(root, AD4, lambda d: d["instance"].update(payload_sha256="1" * 64))
    assert_reported(problems(root), AD4)


def test_missing_schema_is_reported(root):
    (root / "contracts" / "events" / "stream-message.v1.schema.json").unlink()
    assert_reported(problems(root), "missing schema", "stream-message")


def test_relaxed_schema_lets_an_invalid_fixture_through(root):
    path = root / "contracts" / "events" / "ingestion-latest.v1.schema.json"
    schema = json.loads(path.read_text(encoding="utf-8"))
    schema["$defs"]["error"]["properties"]["error"]["additionalProperties"] = True
    path.write_text(json.dumps(schema), encoding="utf-8")
    assert_reported(problems(root), "invalid_internal_detail.json", "accepted")


def test_missing_fixture_directory_is_reported(root):
    shutil.rmtree(root / "contracts" / "events" / "fixtures" / "ingestion-latest")
    assert_reported(problems(root), "fixtures/ingestion-latest", "no fixtures")


def test_file_name_must_match_the_flag(root):
    p = fixture_path(root, "ingestion-latest/valid_not_found.json")
    p.rename(p.with_name("invalid_not_found.json"))
    assert_reported(problems(root), "invalid_not_found.json", "file name must start with valid_")


def test_invalid_fixture_needs_a_reason(root):
    edit_fixture(root, "envelope/invalid_wrong_hash.json", lambda d: d.pop("reason"))
    assert_reported(problems(root), "invalid_wrong_hash.json", "needs a reason")


def test_removing_all_valid_heartbeats_is_a_coverage_failure(root):
    (fixture_path(root, "stream-message/valid_heartbeat_outage.json")).unlink()
    assert_reported(problems(root), "no valid heartbeat")


@pytest.mark.parametrize("age,fresh,ok", [(6000, "fresh", True), (6001, "fresh", False), (6001, "stale", True), (6000, "stale", False)])
def test_freshness_boundary(age, fresh, ok):
    ev = json.loads((REPO / "contracts/events/fixtures" / AD4).read_text(encoding="utf-8"))["instance"]
    value = {"base_currency": "USD", "quote_currency": "INR", "event": ev, "age_ms": age, "freshness": fresh}
    profile = {"expected_interval_ms": 2000, "live_max_age_ms": None, "stale_after_ms": 6000, "unavailable_after_ms": 30000, "clock_tolerance_ms": 1000}
    assert (cec.value_problems(value, profile) == []) is ok


def edit_vectors(root, change):
    path = root / "contracts" / "test-vectors" / "event_payload_hash.v1.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    change(data)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def test_vector_with_a_wrong_digest_is_reported(root):
    edit_vectors(root, lambda d: d["vectors"][0].update(sha256="0" * 64))
    assert_reported(problems(root), "ad4_section10_usd_inr", "sha256")


def test_vector_with_a_wrong_canonical_string_is_reported(root):
    edit_vectors(root, lambda d: d["vectors"][2].update(canonical=d["vectors"][2]["canonical"].replace("1.23450", "1.2345")))
    assert_reported(problems(root), "trailing_zero_rate_differs", "canonical")


def test_altered_payload_vector_with_the_original_hash_is_reported(root):
    def make_equal(d):
        d["must_not_match"][0].update(payload=d["vectors"][0]["payload"], canonical=d["vectors"][0]["canonical"], sha256=d["vectors"][0]["sha256"])
    edit_vectors(root, make_equal)
    assert_reported(problems(root), "altered_rate", "original hash")


def test_missing_vector_file_is_reported(root):
    (root / "contracts" / "test-vectors" / "event_payload_hash.v1.json").unlink()
    assert_reported(problems(root), "event_payload_hash.v1.json", "missing")


def test_instance_mode_checks_one_live_body(root, tmp_path, capsys):
    body = json.loads(fixture_path(root, "ingestion-latest/valid_four_events.json").read_text(encoding="utf-8"))["instance"]
    f = tmp_path / "latest.json"
    f.write_text(json.dumps(body), encoding="utf-8")
    assert cec.main(["--root", str(root), "--instance", "ingestion-latest", str(f), "--expect-events", "4"]) == 0
    assert cec.main(["--root", str(root), "--instance", "ingestion-latest", str(f), "--expect-events", "3"]) == 1
    body["events"][0]["payload_sha256"] = "0" * 64
    f.write_text(json.dumps(body), encoding="utf-8")
    assert cec.main(["--root", str(root), "--instance", "ingestion-latest", str(f)]) == 1
    assert cec.main(["--root", str(root), "--instance", "nonsense", str(f)]) == 1


# --- the envelope URN: resolved when present, a loud failure when not -------------------------------------------------

ENVELOPE_URN = "urn:cbdc-liquidity-router:event-envelope:v1"


def schema_path(root, name):
    return root / "contracts" / "events" / name


def edit_schema(root, name, change):
    path = schema_path(root, name)
    doc = json.loads(path.read_text(encoding="utf-8"))
    change(doc)
    path.write_text(json.dumps(doc, indent=2), encoding="utf-8")


def test_the_envelope_urn_is_actually_followed(root):
    """Positive control: an embedded event that breaks the ENVELOPE schema is rejected through the reference."""
    checker = cec.Checker(root)
    validators = checker.load_schemas()
    assert checker.problems == []
    body = json.loads(fixture_path(root, "ingestion-latest/valid_four_events.json").read_text(encoding="utf-8"))["instance"]
    body["events"][0]["usage"] = "trade"
    (top,) = list(validators["ingestion-latest"].iter_errors(body))
    nested = [list(c.absolute_path) for c in top.context]
    assert ["events", 0, "usage"] in nested, nested


def test_both_wire_schemas_reference_the_envelope_by_its_urn(root):
    for name in ("ingestion-latest.v1.schema.json", "stream-message.v1.schema.json"):
        text = schema_path(root, name).read_text(encoding="utf-8")
        assert f'"$ref": "{ENVELOPE_URN}"' in text, name
    assert cec.Checker(root).run() == []


def test_a_renamed_envelope_id_is_reported_and_no_fixture_passes_by_crashing(root):
    edit_schema(root, "event-envelope.v1.schema.json", lambda d: d.update({"$id": "urn:cbdc-liquidity-router:event-envelope:v2"}))
    found = problems(root)
    assert_reported(found, "unresolved $ref", ENVELOPE_URN)
    assert_reported(found, "ingestion-latest.v1.schema.json", "unresolved $ref")
    assert_reported(found, "stream-message.v1.schema.json", "unresolved $ref")
    # An invalid fixture must not be credited as "rejected" because the validator crashed on the reference.
    assert_reported(found, "invalid_event_with_wrong_hash.json", "validator could not run")
    assert_reported(found, "valid_four_events.json", "validator could not run")


def test_a_reference_to_a_missing_definition_is_reported(root):
    edit_schema(root, "ingestion-latest.v1.schema.json",
                lambda d: d["$defs"]["success"]["properties"]["instance_id"].update({"$ref": ENVELOPE_URN + "#/$defs/nope"}))
    assert_reported(problems(root), "ingestion-latest.v1.schema.json", "unresolved $ref", "nope")


def test_an_unresolved_reference_fails_the_command(root, capsys):
    edit_schema(root, "event-envelope.v1.schema.json", lambda d: d.update({"$id": "urn:cbdc-liquidity-router:other"}))
    assert cec.main(["--root", str(root)]) == 1
    assert "unresolved $ref" in capsys.readouterr().out


# --- coverage of the AD-1 section 3.1 and 3.2 cases by the shared fixtures ---------------------------------------------

def fixture_names(kind):
    return {p.stem for p in (REPO_FIXTURES / kind).glob("*.json")}


REPO_FIXTURES = cec.Path(__file__).resolve().parents[3] / "contracts" / "events" / "fixtures"


@pytest.mark.parametrize("kind,names", [
    ("ingestion-latest", {"valid_empty", "valid_one_event", "valid_four_events", "invalid_five_events", "invalid_duplicate_pair", "invalid_unsorted",
                          "invalid_quarantined_event_served", "invalid_unknown_version", "invalid_extra_field", "invalid_missing_events",
                          "invalid_instance_id_not_uuid", "valid_invalid_request", "valid_not_found", "valid_method_not_allowed",
                          "valid_internal_error", "valid_not_ready", "invalid_internal_detail", "invalid_status_mismatch"}),
    ("stream-message", {"valid_snapshot", "valid_snapshot_all_unavailable", "valid_update", "valid_update_unavailable_value", "valid_heartbeat_outage",
                        "invalid_protocol_version_major_2", "invalid_missing_source", "invalid_server_time_format", "invalid_snapshot_three_values",
                        "invalid_snapshot_wrong_order", "invalid_stream_seq_zero", "invalid_profile_null_unavailable_after",
                        "invalid_unknown_type", "invalid_unavailable_with_event"}),
    ("envelope", {"valid_ad4_section10_example", "valid_quarantined_future_timestamp", "valid_null_source_timestamp", "invalid_wrong_hash",
                  "invalid_impossible_date", "invalid_unknown_version", "invalid_usage_not_display_only", "invalid_synthetic_transport_mismatch"}),
])
def test_the_shared_fixtures_cover_the_ad1_cases(kind, names):
    assert names <= fixture_names(kind), sorted(names - fixture_names(kind))


def test_the_fixture_total_and_the_empty_states():
    total = sum(len(fixture_names(k)) for k in cec.KINDS)
    assert total == 73
    empty_latest = json.loads((REPO_FIXTURES / "ingestion-latest" / "valid_empty.json").read_text(encoding="utf-8"))["instance"]
    assert empty_latest["events"] == []
    empty_stream = json.loads((REPO_FIXTURES / "stream-message" / "valid_snapshot_all_unavailable.json").read_text(encoding="utf-8"))["instance"]
    assert [v["freshness"] for v in empty_stream["values"]] == ["unavailable"] * 4 and empty_stream["source"]["status"] == "starting"


# --- --frames: the frames a real producer wrote (P-8; infra/testing/observations/dump_frames.ts) ---

def _fixture(rel):
    return json.loads((REPO / "contracts" / "events" / "fixtures" / rel).read_text(encoding="utf-8"))["instance"]


def _frames():
    """One connection built from shared fixtures: snapshot (fresh), stale update, unavailable update, heartbeat."""
    msgs = [_fixture("stream-message/valid_snapshot.json"), _fixture("stream-message/valid_update_stale_value.json"),
            _fixture("stream-message/valid_update_unavailable_value.json"), _fixture("stream-message/valid_heartbeat_outage.json")]
    for seq, m in enumerate(msgs, 1):
        m["stream_seq"] = seq
    return [{"connection": "c", "event": m["type"], "msg": m} for m in msgs]


def _frame_problems(frames):
    checker = cec.Checker(REPO)
    validators = checker.load_schemas()
    assert validators is not None, checker.problems
    return cec.frames_problems(checker, validators, frames)


def test_frames_built_from_valid_fixtures_conform():
    assert _frame_problems(_frames()) == []


@pytest.mark.parametrize("change, expected", [
    (lambda f: f[0]["msg"]["values"][0].update(freshness="stale"), "freshness disagrees"),
    (lambda f: f[1].update(event="snapshot"), "differs from the SSE event name"),
    (lambda f: f[2]["msg"].update(stream_seq=9), "stream_seq 9 is not 3"),
    (lambda f: f[1]["msg"].update(extra=1), "schema"),
    (lambda f: f.__delitem__(0), "must be a snapshot"),
    (lambda f: f.__delitem__(3), "no heartbeat was produced"),
])
def test_a_broken_frame_is_reported(change, expected):
    frames = _frames()
    change(frames)
    assert any(expected in p for p in _frame_problems(frames)), expected


def test_a_dump_without_every_freshness_state_or_with_no_frames_cannot_pass():
    one_sided = [f for i, f in enumerate(_frames()) if i != 2]
    assert any("no unavailable value" in p for p in _frame_problems(one_sided))
    assert _frame_problems([]) and _frame_problems({"not": "a list"})


def test_the_frames_command_exits_nonzero_on_a_bad_file(tmp_path, capsys):
    good, bad = tmp_path / "good.json", tmp_path / "bad.json"
    good.write_text(json.dumps(_frames()), encoding="utf-8")
    frames = _frames()
    frames[2]["msg"]["stream_seq"] = 9
    bad.write_text(json.dumps(frames), encoding="utf-8")
    assert cec.main(["--frames", str(good)]) == 0
    assert cec.main(["--frames", str(bad)]) == 1
    assert "stream_seq 9" in capsys.readouterr().out
