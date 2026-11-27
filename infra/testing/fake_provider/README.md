# `fake_provider/` — a controllable fake provider (TEST-ONLY)

**Status:** scaffold only. **A-4 (fault injection) is NOT exercised in Phase
3.3-A**, and the 3.3-S exit record must still list it as **outstanding**.

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
  **exists** and that it is **outside** that context.
- **Nothing imports it.** No suite drives a fault through it, which is what
  "A-4 unexercised" means in practice.

## What a future A-4 adds

A transport that reads a script and misbehaves accordingly, under an authorized
milestone. Adding one here without that authorization would exercise A-4 and
change the slice's acceptance claim.
