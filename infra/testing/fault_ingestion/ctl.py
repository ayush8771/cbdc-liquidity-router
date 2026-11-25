"""Control client for the TEST-ONLY fake ingestion service. Runs INSIDE its container (docker compose exec), loopback only.

  python /fault/ctl.py set SCENARIO     python /fault/ctl.py state
Prints the JSON state; exit 0 on success, 1 when the service refuses the scenario, 2 on usage or connection errors.
"""
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8301"


def main(argv) -> int:
    try:
        if argv[:1] == ["set"] and len(argv) == 2:
            req = urllib.request.Request(BASE + "/scenario", data=argv[1].encode("utf-8"), method="POST")
        elif argv == ["state"]:
            req = urllib.request.Request(BASE + "/state")
        else:
            print(__doc__.strip(), file=sys.stderr)
            return 2
        with urllib.request.urlopen(req, timeout=5) as response:
            print(response.read().decode("utf-8"))
            return 0
    except urllib.error.HTTPError as error:
        print(error.read().decode("utf-8"), file=sys.stderr)
        return 1
    except OSError as error:
        print(f"cannot reach the control port: {type(error).__name__}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
