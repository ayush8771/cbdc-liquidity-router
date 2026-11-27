# A-4 demonstration CLI (test-only)

Two reproducible command-line demonstrations of **A-4 synthetic fault handling**
on the real ingestion pipeline, through an **in-process fake-provider seam**.

**Status:** Target A is complete and merged at `549907b` on
`feature/phase3-platform` ([PR #42](https://github.com/ayush8771/cbdc-liquidity-router/pull/42)).

**This directory changes no approved text.** All four capability gates remain
**CLOSED**; no provider, credential, egress, site, checkpoint or knowledge write
is approved; `ppoProjected` stays disabled; the OpenAPI files stay DRAFT; the
D-24 slice is unchanged and its generator remains the service default. AD-2,
AD-3, AD-4 Part 2, AD-6 Part 2, AD-7, AD-9, AD-10, AD-11, AD-13 and AD-8 as a
whole remain unapproved, so **F-5 stays provisional and official exit criterion
9 is unmet**. No code milestone 3.2–3.7 is authorized.

The normative contract is [`docs/PHASE3_A4_INTERFACE.md`](../../../docs/PHASE3_A4_INTERFACE.md);
the component description is [`services/ingestion/README.md`](../../../services/ingestion/README.md).

## What it is not

- **No network.** No module here imports a socket, HTTP, TLS or subprocess
  module, and none names a host, port or URL. `services/ingestion/tests/test_a4_faults.py`
  asserts this against `ast` import nodes, not prose.
- **No provider, credential, Docker or service process.** The pipeline is built
  in-process from the production objects.
- **Not a production path.** This directory lives under `infra/`, outside every
  build context, so nothing here can enter a runtime image, and nothing in
  `services/ingestion/cbdc_ingestion/` imports it.
- **Not reachable from the service.** `registry/sources.json` names
  `adapter_id: synthetic_fx` and a mismatch is a startup failure, so the service
  path cannot reach the A-4 adapter. The D-24 generator remains the default.

## Prerequisites

- **Python 3.10** or later. The validated environment is Python **3.10.11** on
  Windows 11.
- **No third-party dependency.** The ingestion component and these demos are
  standard library only. The repository `venv` works, but any Python 3.10+
  interpreter is enough; `pytest` is needed only for the test suite.
- **No dataset, raw file, checkpoint, Docker image, env file or token.** The
  Phase 1 dataset prerequisites in the root [`README.md`](../../../README.md) do
  **not** apply to these demos.
- Run both commands **from the repository root**: each script resolves the
  repository root from its own path and adds `services/ingestion` and
  `infra/testing` to `sys.path`.

## Commands and verified results

Verified on 27 November 2026 at merge `549907b`, Python 3.10.11, Windows 11.

```powershell
cd c:\dev\cbdc-liquidity-router
.\venv\Scripts\Activate.ps1          # optional; any Python 3.10+ works

python infra\testing\a4_demo\run_demo.py            # six scenarios, 30 checks
python infra\testing\a4_demo\run_demo.py --json      # machine-readable, for a byte-exact diff
python infra\testing\a4_demo\run_demo.py --only clean   # one scenario by name
python infra\testing\a4_demo\run_fixture_demo.py     # twelve fixture cases plus the breaker
```

| Command | Expected result | Exit code |
|---|---|---|
| `run_demo.py` | header, then one table per scenario, ending `-- 30/30 checks passed across 6 scenarios` | `0` |
| `run_fixture_demo.py` | twelve `PASS` lines, one `PASS breaker states […]`, then `RESULT: OK (0 failing)` | `0` |

Both scripts exit **non-zero if any expectation fails**, so each is a
demonstration *and* a check.

### `run_demo.py` — the six scenarios

| Scenario | Claim it demonstrates |
|---|---|
| `clean` | a healthy source publishes every pair and the status is `ok` |
| `provider_unavailable_then_recovery` | a 503 degrades the adapter, backoff is set, and one good item recovers it |
| `auth_failure_is_permanent` | a permanent fault does not retry |
| `circuit_breaker` | the breaker opens at the threshold, the cooldown costs no requests, and the source reaches `outage` |
| `whole_response_rejection` | a response that cannot be trusted as a whole publishes nothing and is counted by reason |
| `silence_is_an_outage` | the silence criterion fires with no recorded failure at all |

`--only NAME` takes the scenario name as the table headings print it (`clean`,
`circuit_breaker`, …). An unknown name exits `2`; note that its message lists the
scenarios' *function* names (`scenario_clean`, …), not the names `--only` matches.

### `run_fixture_demo.py` — the twelve fixture cases

`A4-OK-01`, `A4-RL-01`, `A4-RL-02`, `A4-RL-03`, `A4-5XX-01`, `A4-AUTH-01`,
`A4-REDIR-01`, `A4-CT-01`, `A4-MAL-01`, `A4-BIG-01`, `A4-TRUNC-01`,
`A4-CLOSE-01`, run through the **production** classifier, backoff policy and
circuit breaker, plus the breaker state sequence
`['closed', 'closed', 'closed', 'open', 'open', 'closed']`.

### In the test suite

```powershell
cd services\ingestion
python -m pytest -q        # verified: 1487 passed in 17.0s
```

`services/ingestion/tests/test_a4_demo.py` runs `run_demo.py` inside the suite,
so the demonstration cannot rot.

## Determinism

Every clock is a `ManualClock`, the jitter source is seeded, and the delivered
values come from the unchanged generator's `rate_for`, which is a pure function
of the seed, the pair and the sequence number. Two runs on two machines print
the same numbers, and a fault scenario differs from a clean one in its **faults
only**. `--json` emits the scenarios for a byte-exact diff.

## Limitations

- **The timings are simulation parameters, not AD-8 defaults.** They come from
  `SimulatedTimingProfile`, whose own label is `SIMULATION_ONLY`, because AD-8
  §3.5's `poll` column is **unapproved**. The header prints them so that no
  reader mistakes a printed millisecond count for an approved production
  threshold. `tests/test_a4_simulation_params.py` asserts field by field that no
  value coincides with the unapproved AD-8 number it would be mistaken for. Only
  two approved synthetic values are used: 3 consecutive failures or 3× the
  interval to outage, and the 2000 ms shutdown budget.
- **The seam is in-process, so the transport-level half of A-4's catalogue is
  simulated, not exercised against a real connection.** Not covered: TLS
  handshakes, DNS failures, socket resets, real read timeouts, HTTP redirect
  following, chunked transfer encoding and a genuine mid-flight connection
  close. Those need a transport, which needs **AD-10**, A-9's **T-5 from inside
  the container including the egress allowlist**, and **Gate 3**, which does not
  exist. [`docs/PHASE3_A4_INTERFACE.md`](../../../docs/PHASE3_A4_INTERFACE.md)
  §6 lists them as the outstanding set, and the 3.3-S exit record must carry
  that list rather than claim A-4 complete.
- **One transport kind.** `AUTHORIZED_TRANSPORT_KINDS` is
  `("in_process_simulation",)`; a transport of any other kind, or one that
  forgot to declare a kind, is refused at attachment.
- **The rates are deliberately unrealistic** and every envelope is
  `usage: display_only`, so no value may be mistaken for a market quote or reach
  a routing decision.
