"""TCP reachability check for the phase3-observations runtime job (positive controls). Standard library only.

    python tcp_check.py [--expect connect|refuse] [--timeout SECONDS] HOST:PORT [HOST:PORT ...]

`connect` (default): every target must accept a connection. `refuse`: every target must fail to. Hosts may be names,
so the same script proves that an alias resolves. Prints one PASS or FAIL line per target and exits 1 on any FAIL.
Run inside a container as `python - HOST:PORT ... < infra/scripts/tcp_check.py` (the image has no other tooling).
"""
import socket
import sys


def reachable(host: str, port: int, timeout: float) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def main(argv) -> int:
    expect, timeout, targets = "connect", 3.0, []
    args = list(argv)
    while args:
        a = args.pop(0)
        if a == "--expect" and args:
            expect = args.pop(0)
        elif a == "--timeout" and args:
            timeout = float(args.pop(0))
        else:
            targets.append(a)
    if expect not in ("connect", "refuse") or not targets:
        print("usage: tcp_check.py [--expect connect|refuse] [--timeout S] HOST:PORT ...", file=sys.stderr)
        return 2
    bad = 0
    for t in targets:
        host, _, port = t.rpartition(":")
        if not host or not port.isdigit():
            print(f"FAIL {t}: not HOST:PORT")
            bad += 1
            continue
        ok = reachable(host, int(port), timeout) == (expect == "connect")
        print(f"{'PASS' if ok else 'FAIL'} {t} {'accepts' if expect == 'connect' else 'refuses'} a connection")
        bad += not ok
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
