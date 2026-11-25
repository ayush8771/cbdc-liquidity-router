"""AD-6 T-5, ingestion side, run INSIDE the ingestion container (AD-1 v0.5 section 3.6, P-6, section 6 item 5; D-25).

    docker compose ... exec -T -e PROBE_BLOCKED=... -e PROBE_GATEWAY=... ingestion python - < infra/scripts/probe_ingestion_isolation.py

The container has no tools, so the probe is a standard-library script read from stdin. It prints one `PASS` or `FAIL`
line per check and exits 1 on any FAIL. It claims only the ingestion side: nothing here tests the inference side of
B-4, which D-25 excepts for the D-24 slice.

The harness (the phase3-observations `runtime` job) supplies real targets, so that a refusal is evidence and not an
artefact of there being nothing to reach:
  PROBE_BLOCKED   comma list of `name=ip:port`: services that EXIST and LISTEN on another network (sentinels aliased
                  `inference` and `postgres`). Ingestion must resolve none of the names and connect to none of the addresses.
  PROBE_GATEWAY   `ip:port`: a listener on the host, addressed through this network's gateway as Docker reports it (from
                  `docker network inspect`, never assumed). The harness first proves that the same listener is reachable
                  through the gateway of an ordinary (non-internal) network. Ingestion must not reach it.
  PROBE_SELF_PORT this container's own port (default 8300).
A missing or malformed variable is a FAIL, never a skipped check.

Positive controls: the probe connects to its own port and resolves `localhost`, so a refusal below cannot come from a
connection helper or resolver that never works.
Other checks: not root; read-only root filesystem; no credential-like environment variable name; no external name or
address reachable; no default route that is not accounted for (printed for the record).
IPv6: the overlay leaves it disabled, and this probe verifies isolation for IPv4 only. It therefore FAILS if the container has
any IPv6 address besides loopback, so that enabling IPv6 is a decision with its own checks and never an accident.
Limits: IPv4 only; the environment check looks at names, not values; one gateway port is tried, the one the harness
opened, not every port.
"""
import os
import re
import socket
import struct
import sys

failed = []


def report(ok, name, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (": " + detail if detail else ""))
    if not ok:
        failed.append(name)


def connects(host, port, timeout=3.0):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def resolves(name):
    try:
        socket.gethostbyname(name)
        return True
    except OSError:
        return False


def target(text):
    host, _, port = text.rpartition(":")
    if not host or not port.isdigit() or not 0 < int(port) < 65536:
        raise ValueError(text)
    return host, int(port)


def default_gateway():
    try:
        with open("/proc/net/route") as f:
            next(f)
            for line in f:
                fields = line.split()
                if fields[1] == "00000000" and int(fields[3], 16) & 2:
                    return socket.inet_ntoa(struct.pack("<L", int(fields[2], 16)))
    except (OSError, IndexError, ValueError):
        pass
    return None


# --- harness input: required, so no check can be skipped by omission ---------------------------------------------------
blocked, gateway = [], None
try:
    for item in os.environ["PROBE_BLOCKED"].split(","):
        name, _, addr = item.partition("=")
        if not re.fullmatch(r"[a-z][a-z0-9-]*", name):
            raise ValueError(item)
        blocked.append((name, target(addr)))
    if not blocked:
        raise ValueError("empty")
    gateway = target(os.environ["PROBE_GATEWAY"])
    self_port = int(os.environ.get("PROBE_SELF_PORT", "8300"))
    report(True, "probe targets supplied", f"{len(blocked)} blocked service(s) and a gateway listener")
except (KeyError, ValueError) as exc:
    report(False, "probe targets supplied", f"PROBE_BLOCKED / PROBE_GATEWAY missing or malformed ({exc!r})")
    sys.exit(1)

# --- positive controls -------------------------------------------------------------------------------------------------
report(connects("127.0.0.1", self_port), "control: the probe can connect to its own service", f"127.0.0.1:{self_port}")
report(resolves("localhost"), "control: the resolver works")

# --- the container itself -----------------------------------------------------------------------------------------------
uid = os.getuid() if hasattr(os, "getuid") else -1  # -1 only off Linux, where the probe is exercised by tests
report(uid != 0, "runs as a non-root user", f"uid {uid}")
try:
    with open("/app/.write-test", "w"):
        pass
    os.remove("/app/.write-test")
    report(False, "root filesystem is read-only", "a file could be created")
except OSError:
    report(True, "root filesystem is read-only")
secret = re.compile(r"(PASSWORD|PASSWD|TOKEN|SECRET|CREDENTIAL|DATABASE_URL|PRIVATE_KEY|API_KEY|ACCESS_KEY)", re.I)
names = sorted(k for k in os.environ if secret.search(k))
report(not names, "no credential-like environment variable", ", ".join(names))

# --- no path to the other Phase 2 services (they exist, on another network) ---------------------------------------------
for name, (ip, port) in blocked:
    report(not resolves(name), f"{name} does not resolve")
    report(not connects(ip, port), f"no connection to {name} at {ip}:{port}")

# --- no path out of Docker ----------------------------------------------------------------------------------------------
report(not resolves("example.com"), "an external name does not resolve")
for host, port in (("1.1.1.1", 443), ("8.8.8.8", 53)):
    report(not connects(host, port), f"no connection to {host}:{port}")

# --- the host, through the gateway Docker reports for this network ------------------------------------------------------
gateway_open = connects(*gateway)
report(not gateway_open, f"no connection to the host listener through the gateway {gateway[0]}:{gateway[1]}",
       "REACHABLE: AD-1 section 3.6 requires isolated gateway mode or a residual risk recorded for the owner" if gateway_open else "")
route = default_gateway()
print("INFO default route: " + (route if route else "none"))


def ipv6_addresses(path):
    """Non-loopback IPv6 addresses from /proc/net/if_inet6 (the path can be changed for tests only)."""
    try:
        with open(path) as f:
            rows = [line.split() for line in f if line.strip()]
    except OSError:
        return []
    return [r[0] for r in rows if len(r) >= 6 and r[0] != "0" * 31 + "1"]


v6 = ipv6_addresses(os.environ.get("PROBE_IF_INET6_PATH", "/proc/net/if_inet6"))
report(not v6, "IPv6 is disabled for this container (only loopback ::1)",
       "IPv6 addresses present: " + ", ".join(v6) + ". Isolation is verified for IPv4 only." if v6 else "")

sys.exit(1 if failed else 0)
