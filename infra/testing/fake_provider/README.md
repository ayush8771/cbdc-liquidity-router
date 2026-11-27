# `fake_provider/` — a controllable fake provider (TEST-ONLY)

**Status:** scaffold plus an **in-process A-4 demonstration harness** (`harness.py`,
`demo.py`, `fixtures/`, `tests/`). It is a demonstration against simulated
responses, **not** against an adapter or a transport: the 3.3-S exit record must
still say so, and must not claim A-4 closed on this evidence alone.

Required by `docs/PHASE3_33A_AUTHORIZATION.md` v1.3 §7.1, which asks for this
home to exist while A-4 waits: the slice's one adapter wraps a local seeded
generator and so **has no transport to fault**.

## What is here

| File | What it is |
|---|---|
| `provider.py` | A deterministic script of outcomes a caller pulls one at a time: `Deliver`, `Fault` (AD-5 §7.1's `recoverable`, `permanent`, `item`) and `Silence`. Pure in-process object — no clock, no randomness, no I/O |
| `__init__.py` | Re-exports the above |

## The limits, which are the point

- **No network.** No socket, no HTTP client or server, no URL, no hostname.
  `services/ingestion/tests/test_image_packaging.py` asserts this statically, so
  the file cannot quietly grow one.
- **No real provider.** No vendor, endpoint, credential or recorded sample.
  **Gate 3 does not exist**, all four capability gates are **CLOSED**, and C-2 is
  out of scope (authorization §8 item 1).
- **No coupling.** It imports nothing from `cbdc_ingestion`, `src/` or
  `services/`, so it cannot drift into the production path.
- **Cannot enter the image.** It lives under `infra/`, outside the ingestion
  build context (§7.4). Acceptance criterion 11 asserts both that this directory
  **exists**## The A-4 demonstration harness

Run (no network, ~instant): `python infra/testing/fake_provider/demo.py`
Tests: `python -m pytest infra/testing/fake_provider/tests -p no:cacheprovider` (needs pytest >= 9 only if run from `services/ingestion`; this directory has no pytest config).

| Piece | What it does |
|---|---|
| `Deliver` / `Fault` / `Silence` scripts | Existing scaffold steps; `Deliver` may carry `SimResponse` objects |
| `fixtures/a4_cases.v1.json` (+ `.origin.json`, hand-written) | 12 case IDs `A4-*`: ok, 429 with / without / invalid `Retry-After`, 503, 401, redirect, wrong content type, malformed, oversized (abandoned while reading), truncated, closed on connect |
| `classify()` | AD-5 s7.1/7.3 mapping of a simulated response to a fault class |
| `Backoff` | Seeded full-jitter; valid `Retry-After` overrides (clamp 1-30 s); `rate_limited` never shortens the wait |
| `Breaker` | Per source; 3 failures / 30 s opens, 10 s cooldown, one probe; success closes, failure reopens |
| `ManualClock` | The only clock; runs are reproducible |
| `log_line()` | Reason code, case and source id only; no body, header or location |

### Limits (transport level)

- Redirects, truncation, resets and oversize are **data describing a response**, not bytes on a wire. Nothing here proves how a real HTTP client behaves: TLS, DNS, real redirect following, slow reads, mid-stream resets, and chunked-encoding edge cases are **not modelled**.
- The classifier and breaker are **harness-local references** of AD-5 s7. The ingestion adapters have **no breaker, backoff or classifier** (`adapters/faults.py` says so), so this harness cannot test them. **Interface dependency for Ayush:** a poll-level seam in `Adapter` taking a response-like object and returning/raising `AdapterFault`, plus a breaker/backoff component taking an injected `Clock`. Nothing here uses them.
- Thresholds, windows and the redirect/truncation class mappings are provisional until AD-8 and AD-5 are ratified. Contract violations are classed permanent per AD-5 s7.1, so one redirect ends a source; the owner may wish to revisit that.
- No real provider, no Gate 3 evidence, all four gates stay CLOSED.
