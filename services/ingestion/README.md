# Ingestion component (Phase 3, D-24 slice)

**Owner:** Dev A. **Status:** implementation of the authorized D-24 slice only.
**Normative documents:** `docs/PHASE3_AD1_COMPONENT_VIEW.md` v0.5 (§3.1, §3.4),
`docs/PHASE3_AD4_EVENT_ENVELOPE.md` v0.2, `docs/PHASE3_AD6_ENGINE_BOUNDARY.md`
v0.2, and `contracts/events/event-envelope.v1.schema.json`. All three documents
are approved **for the D-24 slice only** (25 November 2026). **No gate has
passed**, and **no milestone 3.2–3.7 is authorized.**

This component generates **seeded synthetic FX observations** and serves the
latest validated one per currency pair over a private HTTP endpoint. It is a
local demonstration producer: there is **no provider, no outbound connection and
no credential** anywhere in it.

Since Phase 3.3-A it also holds a **synthetic adapter layer** (`adapters/`,
below), authorized by `docs/PHASE3_33A_AUTHORIZATION.md` v1.3 §7. That layer is
**synthetic-only and local-only**, and it is **not** the live-adapter placement
of AD-1 §4, which stays unauthorized. The D-24 generator remains the default
path and is unchanged.

## What it is not

- **Not a live data feed.** Every value is generated locally from a seed. The
  3.3-A adapter layer is **synthetic-only**: its one adapter wraps that local
  generator and has **no transport**. The **live**-adapter placement of AD-1 §4
  remains **not authorized**, and each real provider needs **Gate 3** first,
  which does not exist — all four capability gates are **CLOSED**.
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
corrected derivation as **correction C-1** (§3.4.1), approved by the project
owner on 25 November 2026. The D-20 peer review for this implementation is Dev
B's communicated technical approval, as determined by the owner; it is relayed
rather than quoted, and a C-1-specific confirmation from Dev B is still wanted
before the Express acceptance rules (P-4) are implemented.

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

## The Phase 3.3-A adapter contract, as implemented

Authorized by `docs/PHASE3_33A_AUTHORIZATION.md` v1.3 §7, with the exclusions of
§8 and the acceptance criteria of §9. **Synthetic sources only**, local-only, and
**additive**: the D-24 generator above is unchanged and remains the default.

| Module | What it is |
|---|---|
| `adapters/base.py` | AD-5 §3.2's operations and §3.3's state machine. `failed_permanent` is reached only by a permanent fault and left by nothing |
| `adapters/context.py` | The **closed** field set an adapter is given: injected clock, sink, cancellation, metrics, credential resolver. Never a database handle, an inference client or a filesystem writer |
| `adapters/faults.py` | AD-5 §7.1's taxonomy, partitioned into permanent, recoverable and item-level |
| `adapters/registry.py` | AD-5 §2.2's record as version-controlled configuration, A-2's startup validation and AD-12 §3.1's collision safeguards |
| `adapters/synthetic_fx.py` | The first adapter. Wraps the generator's **pure functions**, so values cannot drift between the two paths |
| `sink.py` | AD-5 §3.6's three channels. `observations` is the existing `LatestStore`; `quarantine` and `faults` are **bounded counters, not queues** |
| `pipeline.py` | The service-side steps around an adapter (AD-5 §3.4) |
| `registry/sources.json`, `registry/seed_allocations.json` | The one synthetic record and the seed allocations. **Read-only at runtime**, never written by the process, inside the package where the existing `COPY` already carries them — no Dockerfile, `.dockerignore` or Compose change |

### The D-24 generator path is the default, and is exempt

`CBDC_INGESTION_SOURCES` is **empty by default**, which selects nothing. With it
empty the registry and allocation files are **not read at all**, the adapters
package is not imported by the default path, and the events are byte-identical.

### One `source_id`, two mutually exclusive configurations

By the owner's decision of **27 November 2026 (Option B, Phase 3.3-A only)**, the
D-24 generator and the registry-selected adapter **both** use
`source_id = synthetic.fx`, **provided they are mutually exclusive**: only one
generator configuration may be active for that `source_id` at any time.
Selecting a record **replaces** the generator rather than running beside it, and
two selected records sharing a `source_id` is a startup failure.

The record **does not register the D-24 generator**, which stays
env-configured (`CBDC_INGESTION_SEED`), unregistered, without an allocation entry
and exempt. The two are told apart by their **seed** — a C-1 derivation input —
and not by their `source_id`, which is not one.

This is why **no contract moved**. `/v1/latest` pins `source_id` to
`{"const": "synthetic.fx"}`, so the adapter's body and envelopes validate against
the **unchanged** schemas and the unchanged `validation.py`;
`test_adapter_integration.py` asserts exactly that. The decision authorizes **no**
envelope, schema, backend, frontend or `event_id` derivation change.

The generator takes its seed from `CBDC_INGESTION_SEED` and has **no registry
record and no allocation entry**. It is exempt from the registry and
seed-allocation checks, and must be: an unscoped refusal would refuse to start
the approved slice. `tests/test_seed_allocation.py` asserts both halves — that it
still starts, and that the default path never loads the registry.

### The three modules the earlier draft listed as missing are implemented

An earlier revision of this file said `dedup.py`, `status.py` and the
plausibility bounds were "not implemented yet". **They are implemented**, and
each has its §9 suite passing. The stale list is corrected here rather than left
to mislead a reviewer.

| Module | Criteria | Suite |
|---|---|---|
| `dedup.py` — AD5-Q1's two keys and AD5-Q8's outcomes in the order C-b, D, C-a | 5, 5a | `tests/test_idempotency.py`, `tests/test_envelope_validation.py` |
| `status.py` — AD-5 §9.2's internal status machine, in process only | 6 | `tests/test_status_machine.py` |
| `plausibility.py` — quarantine, never reject and never clamp | 16 | `tests/test_plausibility.py` |

A redelivery on the adapter path is therefore classified by AD-5 §8.2's
classifier, not merely by the store's AD-1 §3.4 ordering and duplicate rules.

### Nine criterion 5 cases reach the classifier directly, by design

`pipeline.py` validates with the **unchanged** D-24 strict validator
(`validation.py`), which refuses envelopes that are schema-valid but foreign to
this slice. Nine of criterion 5's cases are exactly that, so they **cannot reach
the classifier through `run_cycle`** and are fed to `dedup.py` directly:

`g2`, `h`, `i`, `j`, `k`, `k2`, `l`, `m`, `r` — listed as
`DIRECT_CLASSIFIER_ONLY` in `tests/idempotency_cases.py`.

**This is accepted, not a gap.** Criterion 5 defines its inputs as *schema-valid
envelopes*, which these are, so they remain required cases. Strict validation is
**deliberately preserved**: weakening it to route these through `run_cycle` would
change D-24 production behaviour, which §7.3 forbids. Two tests hold the pair of
claims together, and neither may be dropped:

- `tests/test_idempotency_cases.py::test_direct_classifier_only_list_matches_the_unchanged_strict_validator`
  — the list cannot drift from what the validator actually refuses;
- `tests/test_idempotency_conformance.py::test_direct_classifier_only_cases_are_refused_by_the_strict_validator`
  — each one really is refused before the classifier, which is the rejection
  evidence.

Recorded in the authorization as the owner's acceptance of 27 November 2026
(§9 criterion 5, closing note).

A record naming a `source_id` other than `synthetic.fx` is still a permanent
`contract_violation` from `pipeline.build_envelope`: Option B settled the shared
identity, and it authorized no `envelope.py` change.

**Also out of scope, and not claimed:** any real provider or contact with one,
any outbound network access, any credential, restart-safe deduplication,
acknowledgement or replay, the distribution mechanism, and any capability
activation. **All four capability gates remain closed**, and **A-4 fault
injection is not exercised**, so the 3.3-S exit is not reached.

`infra/testing/fake_provider/` is the **test-only home created for A-4** (§7.1).
It is a scaffold: a deterministic script of outcomes with **no transport, no
network and no real provider**, outside the ingestion build context, and
**nothing imports it**. Criterion 11 asserts that it exists, that it is outside
that context and that it has acquired no transport — the three together are what
keep "A-4 unexercised" an assertion rather than an assumption.

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
