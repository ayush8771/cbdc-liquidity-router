"""Tests for the TEST-ONLY fake ingestion service (infra/testing/fault_ingestion/) and its Compose override (Dev D).

Scenarios are judged against the shared contract checker (check_event_contracts.py), so "valid" means valid under the same
schema and rules as the fixtures, and every fault is a named, deterministic deviation. No container is started. The docker
resolving test is skipped without the docker CLI unless CBDC_REQUIRE_DOCKER=1. Run: pytest infra/scripts/tests/test_fault_ingestion.py
"""
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest
import yaml

SCRIPTS = Path(__file__).resolve().parents[1]
REPO = SCRIPTS.parents[1]
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(REPO / "services" / "ingestion"))
sys.path.insert(0, str(REPO / "infra" / "testing" / "fault_ingestion"))

import check_event_contracts as cec  # noqa: E402
import p3_stack as p3  # noqa: E402
import scenarios as sc  # noqa: E402
import server as fake  # noqa: E402

OVERRIDE = REPO / "infra" / "compose.observations-test.yaml"
NOW = 1_795_700_003_217  # an arbitrary fixed "now" in ms: every scenario is a pure function of it


@pytest.fixture(scope="module")
def checker():
    c = cec.Checker(REPO)
    validators = c.load_schemas()
    assert validators is not None, c.problems
    return c, validators


def verdict(checker, body, status=None):
    c, validators = checker
    fx = {"instance": body}
    if status is not None:
        fx["status"] = status
    return c.verdict(validators, "ingestion-latest", fx)


def body_of(text, now=NOW, set_at=0):
    r = sc.respond(sc.parse(text), now, set_at)
    return r, json.loads(r.body) if r.body and r.content_type.startswith("application/json") else None


def age_ms(event, now):
    ts = event["timestamps"]["source_timestamp"]
    dt = datetime.datetime.strptime(ts, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=datetime.timezone.utc)
    return now - int(dt.timestamp() * 1000)


def backend_constant(name):
    text = (REPO / "services" / "backend" / "src" / "observations" / "constants.ts").read_text(encoding="utf-8")
    return int(re.search(rf"{name}\s*[:=]\s*(\d+)", text).group(1))


# --- parsing ------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("text", ["normal", "extreme", "stale", "unavailable", "empty", "malformed_json", "malformed_hash",
                                  "malformed_body", "html_200", "drop", "http:503", "http:429", "http:429:7", "http:302",
                                  "slow", "slow:250", "outage_recovery:0:1", "outage_recovery:5000:3000", " normal "])
def test_every_documented_scenario_parses(text):
    assert sc.parse(text).kind


@pytest.mark.parametrize("text", ["", "nope", "normal:1", "http", "http:200", "http:99", "http:600", "http:abc", "http:503:5",
                                  "http:429:-1", "http:429:99999", "slow:0", "slow:60001", "slow:x", "outage_recovery",
                                  "outage_recovery:1", "outage_recovery:-1:5", "outage_recovery:5:0", "outage_recovery:a:b", "NORMAL"])
def test_anything_else_is_refused(text):
    with pytest.raises(sc.ScenarioError):
        sc.parse(text)


# --- valid and extreme-valid bodies ---------------------------------------------------------------------------

def test_normal_is_four_fresh_valid_events_judged_by_the_shared_checker(checker):
    r, body = body_of("normal")
    assert r.status == 200 and r.content_type == "application/json"
    assert verdict(checker, body) == []
    assert [e["payload"]["base_currency"] + "/" + e["payload"]["quote_currency"] for e in body["events"]] == \
        ["AED/MXN", "EUR/USD", "GBP/PHP", "USD/INR"]
    assert all(0 <= age_ms(e, NOW) < 2000 + 500 for e in body["events"])
    assert all(e["validation"] == {"status": "validated", "reasons": []} for e in body["events"])
    assert body["source_id"] == "synthetic.fx" and body["protocol_version"] == "1.0"


def test_scenarios_are_deterministic_and_events_advance_with_time():
    assert sc.respond(sc.parse("normal"), NOW).body == sc.respond(sc.parse("normal"), NOW).body
    first = json.loads(sc.respond(sc.parse("normal"), NOW).body)["events"]
    later = json.loads(sc.respond(sc.parse("normal"), NOW + 2000).body)["events"]
    assert [e["source_sequence"] for e in later] != [e["source_sequence"] for e in first]
    assert all(l["timestamps"]["source_timestamp"] > f["timestamps"]["source_timestamp"] for f, l in zip(first, later))
    same_tick = json.loads(sc.respond(sc.parse("normal"), NOW + 1, 0).body)["events"]
    assert [e["event_id"] for e in same_tick] == [e["event_id"] for e in first], "inside one tick a poll repeats the same events"


def test_extreme_is_valid_but_extreme_and_within_the_clients_rate_limits(checker):
    _, body = body_of("extreme")
    assert verdict(checker, body) == [], "extreme rates are still valid under AD-4"
    rates = [e["payload"]["rate"] for e in body["events"]]
    assert rates == list(sc.EXTREME_RATES)
    assert all(len(r) <= 40 for r in rates), "the web client withholds rates over 40 characters"
    assert min(rates, key=lambda r: float(r)) < "0.000000000001" and any(float(r) > 1e20 for r in rates)


def test_stale_and_unavailable_ages_sit_on_the_right_side_of_the_backend_thresholds(checker):
    stale_after, unavailable_after = backend_constant("stale_after_ms"), backend_constant("unavailable_after_ms")
    for text, low, high in (("stale", stale_after, unavailable_after), ("unavailable", unavailable_after, None)):
        _, body = body_of(text)
        assert verdict(checker, body) == [], text + " events are still valid events"
        for e in body["events"]:
            a = age_ms(e, NOW)
            assert a > low and (high is None or a <= high), (text, a)


def test_empty_is_a_valid_success_with_no_events(checker):
    _, body = body_of("empty")
    assert body["events"] == [] and verdict(checker, body) == []


# --- malformed ----------------------------------------------------------------------------------------------

def test_malformed_json_is_not_json_and_html_200_has_the_wrong_content_type():
    r = sc.respond(sc.parse("malformed_json"), NOW)
    assert r.status == 200 and r.content_type == "application/json"
    with pytest.raises(ValueError):
        json.loads(r.body)
    h = sc.respond(sc.parse("html_200"), NOW)
    assert h.status == 200 and h.content_type.startswith("text/html")


def test_malformed_hash_breaks_exactly_one_event_and_nothing_else(checker):
    _, body = body_of("malformed_hash")
    problems = verdict(checker, body)
    assert len(problems) == 1 and "payload_sha256 does not match" in problems[0]
    assert cec.payload_hash(body["events"][0]) != body["events"][0]["payload_sha256"]
    assert all(cec.payload_hash(e) == e["payload_sha256"] for e in body["events"][1:])


def test_malformed_body_has_an_extra_field_and_is_refused_by_the_schema(checker):
    _, body = body_of("malformed_body")
    assert body["unexpected"] is True and verdict(checker, body), "the closed body schema must refuse it"
    del body["unexpected"]
    assert verdict(checker, body) == [], "negative control: without the extra field the same body is valid"


# --- http failures, drop, slow, outage ---------------------------------------------------------------------

@pytest.mark.parametrize("status, headers", [(302, {"Location": "/elsewhere"}), (401, {}), (403, {}), (404, {}),
                                              (429, {}), (500, {}), (503, {})])
def test_http_failures_give_the_status_and_a_contract_shaped_body(status, headers):
    r = sc.respond(sc.parse(f"http:{status}"), NOW)
    assert r.status == status and r.headers == headers
    doc = json.loads(r.body)
    assert set(doc) == {"error"} and set(doc["error"]) == {"code", "message"}


def test_429_carries_retry_after_only_when_asked():
    assert sc.respond(sc.parse("http:429:7"), NOW).headers == {"Retry-After": "7"}
    assert "Retry-After" not in sc.respond(sc.parse("http:429"), NOW).headers


@pytest.mark.parametrize("status", [500, 503, 404])
def test_error_bodies_with_a_known_code_pass_the_shared_error_verdict(checker, status):
    _, body = body_of(f"http:{status}")
    assert verdict(checker, body, status) == []


def test_drop_and_slow():
    assert sc.respond(sc.parse("drop"), NOW).drop is True
    r = sc.respond(sc.parse("slow"), NOW)
    assert r.delay_ms == sc.DEFAULT_SLOW_MS > backend_constant("POLL_DEADLINE_MS") and r.status == 200
    assert sc.respond(sc.parse("slow:250"), NOW).delay_ms == 250


def test_outage_recovery_follows_the_schedule_from_when_it_was_set(checker):
    scenario = sc.parse("outage_recovery:1000:2000")
    set_at = NOW
    seen = {dt: sc.respond(scenario, set_at + dt, set_at).status for dt in (0, 999, 1000, 2999, 3000, 10_000)}
    assert seen == {0: 200, 999: 200, 1000: 503, 2999: 503, 3000: 200, 10_000: 200}
    recovered = json.loads(sc.respond(scenario, set_at + 3000, set_at).body)
    assert verdict(checker, recovered) == [], "after the outage the service gives valid events again"
    immediate = sc.parse("outage_recovery:0:500")
    assert sc.respond(immediate, set_at, set_at).status == 503


# --- the HTTP service ---------------------------------------------------------------------------------------

@pytest.fixture
def live():
    clock = {"now": NOW}
    state = fake.State("normal", clock=lambda: clock["now"])
    data, control = fake.make_servers(state, "127.0.0.1", 0, 0)
    for s in (data, control):
        threading.Thread(target=s.serve_forever, daemon=True).start()
    yield state, clock, f"http://127.0.0.1:{data.server_address[1]}", f"http://127.0.0.1:{control.server_address[1]}"
    for s in (data, control):
        s.shutdown()
        s.server_close()


def get(url, timeout=5):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def set_scenario(control, text):
    req = urllib.request.Request(control + "/scenario", data=text.encode(), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_the_service_answers_what_express_polls_and_obeys_the_control(live, checker):
    state, clock, data, control = live
    assert get(data + "/healthz")[0] == 200 and get(data + "/nope")[0] == 404
    status, headers, raw = get(data + "/v1/latest")
    assert status == 200 and verdict(checker, json.loads(raw)) == []
    assert set_scenario(control, "http:503")[0] == 200
    assert get(data + "/v1/latest")[0] == 503
    assert set_scenario(control, "http:429:3")[0] == 200
    assert get(data + "/v1/latest")[0] == 429
    assert get(data + "/v1/latest")[1].get("Retry-After") == "3"
    assert set_scenario(control, "normal")[0] == 200
    assert get(data + "/v1/latest")[0] == 200
    snap = json.loads(get(control + "/state")[2])
    assert snap["scenario"] == "normal" and snap["requests"] >= 5 and snap["last_status"] == 200


def test_an_unknown_scenario_is_refused_and_changes_nothing(live):
    state, _clock, data, control = live
    assert set_scenario(control, "http:503")[0] == 200
    code, doc = set_scenario(control, "bogus")
    assert code == 400 and "error" in doc
    assert state.text == "http:503" and get(data + "/v1/latest")[0] == 503


def test_drop_closes_the_connection_without_a_response(live):
    _state, _clock, data, control = live
    set_scenario(control, "drop")
    with pytest.raises((urllib.error.URLError, ConnectionError, OSError)):
        get(data + "/v1/latest", timeout=3)
    assert json.loads(get(control + "/state")[2])["last_status"] == "drop"


def test_outage_recovery_through_the_service_uses_the_injected_clock(live):
    state, clock, data, control = live
    set_scenario(control, "outage_recovery:1000:2000")
    codes = []
    for dt in (0, 1500, 3500):
        clock["now"] = NOW + dt
        codes.append(get(data + "/v1/latest")[0])
    assert codes == [200, 503, 200]


def test_control_refuses_anything_but_loopback_and_binds_to_loopback_only():
    assert sc.is_loopback("127.0.0.1") and sc.is_loopback("::1")
    for host in ("10.0.0.5", "172.20.0.3", "0.0.0.0", "", "192.168.1.1"):
        assert not sc.is_loopback(host)
    assert fake.CONTROL_HOST == "127.0.0.1" and fake.CONTROL_PORT != fake.DATA_PORT == 8300


# --- the Compose override -----------------------------------------------------------------------------------

def test_override_changes_only_the_ingestion_process_and_publishes_nothing():
    doc = yaml.safe_load(OVERRIDE.read_text(encoding="utf-8"))
    assert set(doc) == {"services"} and set(doc["services"]) == {"ingestion"}
    svc = doc["services"]["ingestion"]
    assert set(svc) == {"command", "environment", "volumes"}, "nothing else of the isolated overlay may be touched"
    assert svc["command"] == ["python", "/fault/server.py"]
    (mount,) = svc["volumes"]
    assert mount["type"] == "bind" and mount["read_only"] is True and mount["target"] == "/fault"
    assert mount["source"] == "./testing/fault_ingestion" and mount["bind"] == {"create_host_path": False}
    text = OVERRIDE.read_text(encoding="utf-8")
    assert not re.search(r"^    (ports|expose|network_mode|privileged|cap_add|devices|networks|user|read_only|image|build):", text, re.M)
    assert (REPO / "infra" / "testing" / "fault_ingestion").is_dir()


def test_the_default_stack_and_the_plain_overlay_never_reference_the_fake():
    for name in ("compose.yaml", "compose.observations.yaml"):
        text = (REPO / "infra" / name).read_text(encoding="utf-8")
        assert "fault_ingestion" not in text and "observations-test" not in text, name
    for f in (REPO / ".github" / "workflows").glob("*.yml"):
        assert "observations-test" not in f.read_text(encoding="utf-8"), f.name
    for dockerfile in (REPO / "services").glob("*/Dockerfile"):
        assert "fault_ingestion" not in dockerfile.read_text(encoding="utf-8")


def _docker_or_skip():
    if shutil.which("docker") is None:
        if os.environ.get("CBDC_REQUIRE_DOCKER") == "1":
            pytest.fail("the docker CLI is required (CBDC_REQUIRE_DOCKER=1)")
        pytest.skip("docker CLI not available")


def test_merged_fault_stack_keeps_every_isolation_setting_and_publishes_only_web(tmp_path):
    _docker_or_skip()
    state = p3.prepare_config(tmp_path / "root", "0a1b2c3d", 18123, "abc", fault=True)
    out = subprocess.run(p3.compose_args(state) + ["config", "--format", "json"], cwd=REPO, env=p3.compose_env(state),
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr[-500:]
    cfg = json.loads(out.stdout)
    ing = cfg["services"]["ingestion"]
    assert ing["command"] == ["python", "/fault/server.py"] and ing["environment"]["PYTHONPATH"] == "/app"
    assert ing["user"] == "10001:10001" and ing["read_only"] is True and ing["cap_drop"] == ["ALL"]
    assert "no-new-privileges:true" in ing["security_opt"] and ing["pids_limit"] == 64
    assert set(ing["networks"]) == {"observations"} and "ports" not in ing
    assert all(str(x) == "8300" for x in ing.get("expose", [])), "only the data port may be exposed, never the control port"
    (vol,) = ing["volumes"]
    assert Path(vol["source"]) == REPO / "infra" / "testing" / "fault_ingestion" and vol["target"] == "/fault" and vol["read_only"]
    assert ing["image"] == p3.image_tag("ingestion", state["suffix"])
    assert [n for n, s in cfg["services"].items() if s.get("ports")] == ["web"]
    assert cfg["networks"]["observations"]["internal"] is True
    assert cfg["services"]["backend"]["environment"]["OBSERVATIONS_URL"] == "http://ingestion:8300"
