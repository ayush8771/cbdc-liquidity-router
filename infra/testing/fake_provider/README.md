# `fake_provider/` - a controllable fake provider (TEST-ONLY)

**Status:** the home of A-4 fault injection (AD-5 section 13). A-4 is exercised
**in-process**, through the production transport seam, against **simulated**
responses. It is not exercised against a real connection, and the 3.3-S exit
record must list the transport-level set in `docs/PHASE3_A4_INTERFACE.md`
section 6 as outstanding. All four capability gates remain **CLOSED**.

Created by `docs/PHASE3_33A_AUTHORIZATION.md` v1.3 section 7.1.

## What is here

| Path | What it is |
|---|---|
| `provider.py`, `__init__.py` | A deterministic script of steps a caller pulls one at a time: `Deliver`, `Silence`, `Fault` and the response-shaped faults (`StatusFault`, `Redirect`, `WrongContentType`, `MalformedBody`, `OversizedBody`, `TruncatedStream`, `CloseOnConnect`, ...). Steps carry semantics, not wire detail. No clock, no randomness, no I/O |
| `fixtures/a4_cases.v1.json` | 12 hand-written wire-level cases `A4-OK-01`, `A4-RL-01..03`, `A4-5XX-01`, `A4-AUTH-01`, `A4-REDIR-01`, `A4-CT-01`, `A4-MAL-01`, `A4-BIG-01`, `A4-TRUNC-01`, `A4-CLOSE-01`. Data only; each declares the class it expects |
| `fixtures/a4_cases.v1.origin.json` | Provenance: `origin: hand-written`. Nothing is recorded from a provider |

This directory holds **no classification, backoff, `Retry-After` or breaker
logic**. Those are production code and the single authority:
`cbdc_ingestion/adapters/response.py` and `retry.py`.

## How the fixtures are run

| What | Where |
|---|---|
| Bridge from a step to a production `TransportResponse` | `infra/testing/a4_demo/bridge.py` |
| Fixture loader and runner over the production classifier, policy and breaker | `infra/testing/a4_demo/fixture_cases.py` |
| Tests (collected by the `ingestion-unit` job) | `services/ingestion/tests/test_a4_fixture_cases.py`, `test_a4_*.py` |
| Demonstrations | `python infra/testing/a4_demo/run_demo.py` and `python infra/testing/a4_demo/run_fixture_demo.py` |

## The limits, which are the point

- **No network.** No socket, HTTP client or server, URL or hostname.
  `services/ingestion/tests/test_image_packaging.py` asserts this statically.
- **No real provider.** No vendor, endpoint, credential or recorded sample.
  **Gate 3 does not exist** and C-2 is out of scope (authorization section 8 item 1).
- **No coupling.** This directory imports nothing from `cbdc_ingestion`, `src/`
  or `services/`. Only `a4_demo` (also test-only) meets the two sides.
- **Cannot enter the image.** It lives under `infra/`, outside the ingestion
  build context (section 7.4). Acceptance criterion 11 asserts that the directory
  exists, lies outside that context, and is imported only from declared
  test-only roots.
- **Transport-level behaviour is simulated.** TLS, DNS, resets, real timeouts,
  redirect following, chunked encoding and real `Retry-After` dates are not
  exercised. A redirect is refused, never followed; truncation is a flag.
- Simulation timings are `SIMULATION_ONLY`, read from the production profile and
  never hard-coded in a test.
