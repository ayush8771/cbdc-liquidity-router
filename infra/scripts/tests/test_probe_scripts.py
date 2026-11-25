"""Negative controls for infra/scripts/probe_ingestion_isolation.py and tcp_check.py.

The probe runs inside the ingestion container in CI. Here it runs on the test machine against local listeners, to prove
that it can FAIL: a reachable sentinel, a reachable gateway listener or a broken positive control must be reported, and
a missing or malformed target must never pass. Lines that depend on the machine's own network (external names and
addresses, the root filesystem) are not asserted.
"""
import contextlib
import socket
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
PROBE = SCRIPTS / "probe_ingestion_isolation.py"
TCP_CHECK = SCRIPTS / "tcp_check.py"


@contextlib.contextmanager
def listener():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    s.listen(8)
    try:
        yield s.getsockname()[1]
    finally:
        s.close()


def closed_port():
    with listener() as port:
        pass
    return port


def run_probe(env_extra):
    import os
    env = {k: v for k, v in os.environ.items() if not k.startswith("PROBE_")}
    env.update(env_extra)
    r = subprocess.run([sys.executable, str(PROBE)], capture_output=True, text=True, env=env, timeout=120)
    return r.returncode, r.stdout


def lines(out, prefix, fragment):
    return [l for l in out.splitlines() if l.startswith(prefix) and fragment in l]


@pytest.mark.parametrize("env", [
    {},
    {"PROBE_BLOCKED": "inference=10.0.0.5:9000"},
    {"PROBE_GATEWAY": "10.0.0.1:9999"},
    {"PROBE_BLOCKED": "", "PROBE_GATEWAY": "10.0.0.1:9999"},
    {"PROBE_BLOCKED": "inference=nonsense", "PROBE_GATEWAY": "10.0.0.1:9999"},
    {"PROBE_BLOCKED": "inference=10.0.0.5:9000", "PROBE_GATEWAY": "10.0.0.1:99999"},
    {"PROBE_BLOCKED": "Inference Server=10.0.0.5:9000", "PROBE_GATEWAY": "10.0.0.1:9999"},
])
def test_missing_or_malformed_targets_fail_instead_of_passing(env):
    code, out = run_probe(env)
    assert code == 1 and "FAIL probe targets supplied" in out
    assert "PASS" not in out.replace("PASS probe targets supplied", "")


@pytest.fixture(scope="module")
def everything_reachable():
    with listener() as own, listener() as sentinel, listener() as host:
        return run_probe({"PROBE_BLOCKED": f"inference=127.0.0.1:{sentinel},postgres=127.0.0.1:{sentinel}",
                          "PROBE_GATEWAY": f"127.0.0.1:{host}", "PROBE_SELF_PORT": str(own)})


@pytest.fixture(scope="module")
def nothing_reachable():
    with listener() as own:
        return run_probe({"PROBE_BLOCKED": f"inference=127.0.0.1:{closed_port()},postgres=127.0.0.1:{closed_port()}",
                          "PROBE_GATEWAY": f"127.0.0.1:{closed_port()}", "PROBE_SELF_PORT": str(own)})


def test_reachable_sentinels_and_gateway_listener_are_reported(everything_reachable):
    code, out = everything_reachable
    assert code == 1
    assert lines(out, "FAIL", "no connection to inference at 127.0.0.1:")
    assert lines(out, "FAIL", "no connection to postgres at 127.0.0.1:")
    assert lines(out, "FAIL", "through the gateway 127.0.0.1:")
    assert "isolated gateway mode" in out
    assert lines(out, "PASS", "control: the probe can connect to its own service")


def test_unreachable_targets_pass_when_the_controls_hold(nothing_reachable):
    code, out = nothing_reachable
    assert lines(out, "PASS", "no connection to inference at 127.0.0.1:")
    assert lines(out, "PASS", "no connection to postgres at 127.0.0.1:")
    assert lines(out, "PASS", "through the gateway 127.0.0.1:")
    assert lines(out, "PASS", "control: the probe can connect to its own service")
    assert lines(out, "PASS", "control: the resolver works")


def test_a_broken_positive_control_is_reported_even_if_everything_else_refuses():
    code, out = run_probe({"PROBE_BLOCKED": f"inference=127.0.0.1:{closed_port()}", "PROBE_GATEWAY": f"127.0.0.1:{closed_port()}",
                           "PROBE_SELF_PORT": str(closed_port())})
    assert code == 1 and lines(out, "FAIL", "control: the probe can connect to its own service")


def tcp(*args):
    r = subprocess.run([sys.executable, str(TCP_CHECK), *args], capture_output=True, text=True, timeout=60)
    return r.returncode, r.stdout


def test_tcp_check_connect_and_refuse_modes():
    with listener() as up:
        down = closed_port()
        assert tcp(f"127.0.0.1:{up}")[0] == 0
        assert tcp("--expect", "refuse", f"127.0.0.1:{down}")[0] == 0
        assert tcp(f"127.0.0.1:{down}")[0] == 1
        assert tcp("--expect", "refuse", f"127.0.0.1:{up}")[0] == 1
        assert tcp(f"127.0.0.1:{up}", f"127.0.0.1:{down}")[0] == 1, "one failing target fails the run"


def test_tcp_check_rejects_bad_usage_and_unresolvable_names():
    assert tcp()[0] == 2
    assert tcp("--expect", "maybe", "127.0.0.1:1")[0] == 2
    assert tcp("not-a-target")[0] == 1
    assert tcp("--timeout", "1", "no-such-host.invalid:80")[0] == 1


def run_with_inet6(content, tmp_path):
    f = tmp_path / "if_inet6"
    f.write_text(content, encoding="utf-8")
    with listener() as own:
        return run_probe({"PROBE_BLOCKED": f"inference=127.0.0.1:{closed_port()}", "PROBE_GATEWAY": f"127.0.0.1:{closed_port()}",
                          "PROBE_SELF_PORT": str(own), "PROBE_IF_INET6_PATH": str(f)})


LOOPBACK6 = "00000000000000000000000000000001 01 80 10 80       lo\n"


def test_loopback_only_ipv6_passes(tmp_path):
    code, out = run_with_inet6(LOOPBACK6, tmp_path)
    assert lines(out, "PASS", "IPv6 is disabled for this container")


@pytest.mark.parametrize("row", [
    "fd000000000000000000000000000002 05 40 00 80   eth0",   # a unique-local address: IPv6 was enabled on the network
    "20010db8000000000000000000000002 05 40 00 80   eth0",   # a global address
    "fe800000000000000042acfffe120002 05 40 20 80   eth0",   # link-local alone also means the interface has IPv6
])
def test_any_non_loopback_ipv6_address_is_reported(tmp_path, row):
    code, out = run_with_inet6(LOOPBACK6 + row + "\n", tmp_path)
    assert code == 1 and lines(out, "FAIL", "IPv6 is disabled for this container") and "IPv4 only" in out


def test_a_missing_ipv6_table_means_no_ipv6(tmp_path):
    with listener() as own:
        code, out = run_probe({"PROBE_BLOCKED": f"inference=127.0.0.1:{closed_port()}", "PROBE_GATEWAY": f"127.0.0.1:{closed_port()}",
                               "PROBE_SELF_PORT": str(own), "PROBE_IF_INET6_PATH": str(tmp_path / "does-not-exist")})
    assert lines(out, "PASS", "IPv6 is disabled for this container")
