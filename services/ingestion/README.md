# Ingestion component (Phase 3, D-24 slice)

**Owner:** Dev A. **Status:** implementation of the authorized D-24 slice only.
**Normative documents:** `docs/PHASE3_AD1_COMPONENT_VIEW.md` v0.5 (§3.1, §3.4),
`docs/PHASE3_AD4_EVENT_ENVELOPE.md` v0.2, `docs/PHASE3_AD6_ENGINE_BOUNDARY.md`
v0.2, and `contracts/events/event-envelope.v1.schema.json`. All three documents
are approved **for the D-24 slice only** (25 November 2026). **No gate has
passed**, and **no milestone 3.2–3.7 is authorized.**

This component generates **seeded synthetic FX observations** and serves the
latest validated one per currency pair over a private HTTP endpoint. It is a
local demonstration producer: there is no provider, no adapter, no outbound
connection and no credential anywhere in it.

## What it is not

- **Not a live data feed.** Every value is generated locally from a seed. Live
  adapters are placed inside this component by AD-1 §4, which is **not
  authorized**, and each provider needs Gate 3 first.
- **Not an input to routing.** Every envelope is `usage: display_only`, and no
  observation may influence an engine request or result (AD-6 §1). The rates are
  deliberately unrealistic so that no reader can mistake one for a market quote.
- **Not a store.** State is the four current events in memory. A restart loses
  it, which AD-1 §3 allows: "No broker, durability or replay."
- **Not knowledge.** A validated event permits display only; writing to the
  knowledge layer needs Gate 2 (AD-4 §6), and feasibility stays with
  `StaticMemoryProvider` (A-4).

## Endpoint

`GET /v1/latest` — no query, no body, no authentication (AD-1 §3.1). Its
isolation is the internal Compose network, or host loopback outside Docker.

```
200 application/json, Cache-Control: no-store
{"protocol_version": "1.0", "instance_id": "<uuid>", "source_id": "synthetic.fx",
 "generated_at": "<AD-4 timestamp>", "events": [ /* 0-4 AD-4 envelopes */ ]}
```

`events` holds at most one envelope per pair, sorted by base then quote, and
**validated only**: a quarantined event is never served. Before the first event
the answer is `200` with `events: []` — never `204`, never `404`.

Errors are `{"error": {"code", "message"}}` with no internal detail:
`400 INVALID_REQUEST` (any query parameter or body), `404 NOT_FOUND`,
`405 METHOD_NOT_ALLOWED` (with `Allow: GET`), `500 INTERNAL_ERROR`,
`503 NOT_READY` (the generator is not running, or is stopping).

`GET /healthz` returns 200 while the process is alive. It is deliberately
independent of readiness, because its question is whether the process lives.

The machine-readable form is `contracts/events/ingestion-latest.v1.schema.json`
(DRAFT, like the envelope schema: the repository check over `contracts/events/`
is P-8 and is Dev D's).

## The generator

Four pairs, fixed and in this order: **AED/MXN, EUR/USD, GBP/PHP, USD/INR**,
`rate_type` `mid` (AD-1 §3.4, P-3). Each pair is observed every 2 s, staggered by
500 ms, so the component emits 2 events/s.

A rate is a pure function of the **seed, the pair and the pair's sequence
number**, computed with SHA-256 rather than a stateful random generator. The
same seed and sequence therefore give the same payload and the same
`payload_sha256` on any platform and at any time, which is AD-1 §6 item 1:
"payloads and hashes do not depend on the clock". The clock is **injected** and
used for timestamps only.

`event_id` is a UUIDv5 of the seed, the **pair**, the sequence and the source
timestamp, so a redelivery keeps its identity (AD-4 §2).

The pair is part of the name because it has to be. Within one run the 500 ms
stagger alone separates the pairs, but a restart resets every sequence to 1 and
re-bases the stagger, so a restart offset of 500, 1000 or 1500 ms (mod 2000)
lined up one run's pair with another's at equal sequences and equal timestamps:
three of four pairs then shared an `event_id` while carrying different pairs and
different rates. Under AD-1 §3.4 Express rejects an event whose `event_id`
matches a current event with different content or another pair, and the offset is
constant, so those pairs' values would have stalled and aged out for the whole
run. `tests/test_restart_identity.py` pins this. AD-1 §3's AD-12 row carries the
corrected derivation, marked as a correction awaiting confirmation.

A restart one whole interval later is a separate, benign case: the pair and the
source timestamp coincide but the sequence differs, so AD-1 §3.4's tie rule
drops one post-restart event per pair, counted, and the next is accepted.

A source timestamp more than 1 s after `retrieved_at` makes the envelope
`quarantined` with reason `FUTURE_SOURCE_TIMESTAMP` (AD-4 §6, AD-1 §3.4). It is
withheld: only a counter by reason and a rate-limited log line with the reason
and the `event_id` remain. No payload is kept and there is no review queue.

## Running it

Standard library only — no third-party dependency is needed to run it:

```powershell
cd services\ingestion
python -m cbdc_ingestion
```

| Variable | Default | Meaning |
|---|---|---|
| `CBDC_INGESTION_SEED` | `20261125` | Fixes every payload and hash |
| `CBDC_INGESTION_CASE_ID` | `normal` | `synthetic.case_id` on every envelope |
| `CBDC_INGESTION_HOST` | `127.0.0.1` | Bind address |
| `CBDC_INGESTION_PORT` | `8300` | Bind port; never published to the host |
| `CBDC_INGESTION_LOG_LEVEL` | `INFO` | Process log level |

There is no provider URL, token or key setting, because the component contacts
nothing. An unparsable value stops the process rather than falling back to a
default: a component quietly running on another seed would produce events nobody
can reproduce.

## Tests

```powershell
cd services\ingestion
python -m pytest
```

`pytest` is the only requirement. Two cross-checks are **skipped** when their
package is absent, and both ran green here when it was present:

- `rfc8785` — compares the restricted canonicalizer (P-9) against a full
  RFC 8785 implementation on every hash vector;
- `jsonschema` (with `referencing`) — validates generated events against
  `contracts/events/event-envelope.v1.schema.json` and the `/v1/latest` body
  against its own schema.

The shared cross-language fixtures are
`contracts/test-vectors/event_payload_hash.v1.json` (AD-1 §3.7): input, the
exact RFC 8785 string and the SHA-256, including AD-4 §10's documented hash,
reordered keys, a trailing-zero rate and altered payloads that must not match.
The backend's TypeScript implementation must reproduce the same strings and
digests.

Every timing test drives a manual clock, so the suite needs no real waiting.

## Not in this component

| Item | Owner |
|---|---|
| Polling, validation, SSE and the `/api/rt/v1` stream in Express | Dev B |
| The observation panel | Dev C |
| `infra/compose.observations.yaml`, the container image, network isolation (P-6), Nginx (P-7), the `check_contracts.py` extension (P-8) and the `phase3-observations` workflow (P-10) | Dev D |
| The fault-injection fake ingestion server (test-only) | Dev B |

AD-6 **T-5** is the from-inside-the-container network and credential test. It is
not in this suite: it belongs with the Compose overlay, and in this slice it is
claimed for the **ingestion side only** (AD-1 §6 item 5, D-25). `tests/test_boundary.py`
covers the source-level half that this component owns: no client, database,
Phase 1 or inference import (AD-6 B-3), no external host or credential named
anywhere, `usage: display_only` on every event and no bridge-state field (B-1).
AD-6 **B-4** remains **unresolved** on the inference side and is closed by AD-10.
