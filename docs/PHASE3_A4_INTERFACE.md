# Phase 3.3-S A-4 — interface contract for dependent tests

**Status:** implemented on `feature/phase3-33s-completion`, based on the merged PR #41.
**Audience:** Dev B (Anvesh) and Dev D (Nisarga), before writing dependent tests.
**Author:** Dev A.
**Scope:** AD-5 §13 obligation **A-4**, synthetic fault handling through an
in-process fake-provider seam.

This document exists so that the conformance matrix (Dev B) and the harness,
fixtures and packaging checks (Dev D) are written against a surface that will not
move under them. It records what is stable, what is deliberately not, and what
A-4 still does not cover.

**It changes no approved text.** All four capability gates remain **CLOSED**; no
provider, credential, egress, site, checkpoint or knowledge write is approved;
`ppoProjected` stays disabled; the OpenAPI files stay DRAFT; the D-24 slice is
unchanged and its generator remains the service default. AD-2, AD-3, AD-4 Part 2,
AD-6 Part 2, AD-7, AD-9, AD-10, AD-11, AD-13 and AD-8 as a whole remain
unapproved, so **F-5 stays provisional and official exit criterion 9 is unmet**.

---

## 1. What A-4 needed, and what was done

AD-5 §13's A-4 asks for fault injection *against a controllable fake provider*.
Phase 3.3-A could not do it: its one adapter wraps a local seeded generator, so
`transient_network`, `provider_unavailable`, `rate_limited` and `auth_failure`
were defined in `faults.py` and unreachable, and `infra/testing/fake_provider/`
was a scaffold that nothing imported.

A-4 is now exercised through an **in-process transport seam**. Five additive
modules in `services/ingestion/cbdc_ingestion/adapters/`:

| Module | Contents |
|---|---|
| `simulation.py` | `SimulatedTimingProfile` / `SIMULATION_TIMING`, labelled `SIMULATION_ONLY` |
| `transport.py` | `TransportResponse`, the `Transport` protocol, `assert_admissible`, `read_body` |
| `response.py` | `classify_status`, `read_response`, `STATUS_CLASSES`, `WHOLE_RESPONSE_CLASSES` |
| `retry.py` | `BackoffPolicy`, `FullJitter`, `parse_retry_after`, `CircuitBreaker`, `BreakerRegistry` |
| `simulated_fx.py` | `SimulatedTransportFxAdapter` |

Two changed files, both minimal: `base.py` gained a fault queue and
`drain_faults()`; `pipeline.py` drains and accounts it. Nothing else in the
package changed.

Test-only, outside every build context: `infra/testing/fake_provider/` (step
vocabulary added) and `infra/testing/a4_demo/` (the bridge and the CLI).

## 2. The stable surface

Treat the following as fixed. A change here is a change to this document first.

### 2.1 The case catalogue — `services/ingestion/tests/a4_support.py`

| Name | Contract |
|---|---|
| `TRANSPORT_CASES` | A tuple of `TransportCase`, one per scripted case |
| `TransportCase` | `case_id`, `step`, `fault_class`, `reason`, `permanent`, `authority`, `note` |
| `case(case_id)` | One case by id; **raises `KeyError`** on an unknown id |
| `scripted_adapter(script, …)` | Returns `(adapter, context, transport)`; started by default |
| `pipeline_for(…)` | Returns `(SourcePipeline, ServiceSink)` over the **shipped** registry record |
| `clean_values(sequence)` | The wire items the **unchanged** generator would produce |

**Case ids are stable.** `A4-01` … `A4-19` keep their meaning. A case may gain
assertions; it is never renumbered, and a new case appends an id. Bind a matrix
to the id, not to the index.

| id | Subject | Class | Authority |
|---|---|---|---|
| A4-01 | provider closes immediately on connect | `transient_network` | AD-5 §7.1 |
| A4-02 | truncated stream (the provider closed it) | `provider_unavailable` | AD-5 §7.1, **Target A** |
| A4-03 | 500 | `provider_unavailable` | AD-5 §7.1 |
| A4-04 | 503 | `provider_unavailable` | AD-5 §7.1 |
| A4-05 | 429 with a valid `Retry-After` | `rate_limited` | AD-5 §7.1 |
| A4-06 | 401 | `auth_failure` (permanent) | AD-5 §7.1 |
| A4-07 | 403 | `auth_failure` (permanent) | AD-5 §7.1 |
| A4-08 | wrong content type | `contract_violation` | AD-5 §7.1 |
| A4-09 | malformed body | `contract_violation` | AD-5 §7.1 |
| A4-10 | redirect, refused and never followed | `contract_violation` | AD-5 §7.1 |
| A4-11 | oversized body, checked while reading | `contract_violation` | **slice** |
| A4-12 | unknown payload protocol version | `contract_violation` | **slice** |
| A4-13 | more items than the allowlist permits | `contract_violation` | **slice** |
| A4-14 | two items for one subject | `contract_violation` | **slice** |
| A4-15 | an unsupported 4xx (418) | `contract_violation` (permanent) | **slice**, **Target A** |
| A4-16 | item missing a required field | `item_invalid` | AD-5 §7.1 |
| A4-17 | the clean control | — | — |
| A4-18 | a successful poll carrying nothing | — | AD-5 §9.2 |
| A4-19 | a well-formed item for an undeclared subject | `item_invalid` (not permanent) | **Target A** |

**`authority` matters.** `AD-5 §7.1` means the document names the class.
**`slice`** means AD-5 §7.3 lists the condition without naming a class and this
scope chose one — each is a *shape* failure, which retrying cannot fix, so
`contract_violation`. A later AD-5 revision may classify these differently;
`WHOLE_RESPONSE_CLASSES` in `response.py` is where that change lands, and a test
asserts the table covers every §7.3 condition so the choice cannot be made
silently by omission. **Please review these five rows specifically.**

### Target A classification decisions (applied)

The owner's Target A decisions have now been applied, and this table reflects
them. Four rows changed or were added; everything else is as Dev B reviewed it.

- **A4-02 → `provider_unavailable`.** A stream the provider closed mid-answer is
  the provider failing, which is the row AD-5 §7.1 gives it; `transient_network`
  is reserved for a failure on our side of the connection (DNS, a reset, a read
  timeout). **Both classes are recoverable**, so the retry, the adapter state and
  the internal status are unchanged — only the reason an operator reads changes.
  The reason code stays `truncated_stream`.
- **A4-11 … A4-14 stay permanent `contract_violation`.** Confirmed, not changed:
  these are genuine whole-response faults about the response's *shape*, which
  retrying cannot fix. Their `authority` stays `slice`.
- **A4-15 is now a partition, not a single fall-through.** An **unsupported 4xx**
  (204, 404, 418, 451 …) stays a **permanent** `contract_violation`. **408** is
  `transient_network`, the one 4xx that says nothing about the configuration.
  **Every remaining 5xx** (501, 505-599) is a **recoverable**
  `provider_unavailable` rather than falling through to a permanent class, so an
  unlisted gateway fault can no longer retire a source for ever. `STATUS_CLASSES`
  in `response.py` now covers 5xx in full, so only a non-5xx reaches the default.
- **A4-19 is new.** A well-formed item for a subject the adapter does not declare
  is **one item's** fault: a **non-permanent `item_invalid`**, reason
  `unlisted_subject`, raised by the adapter's `normalize`. It changes no adapter
  state and no source status. **This moves where the verdict is made:** such an
  item previously passed §7.3's checks and was refused by the *service's*
  admission, landing on the `rejected` counter. It is now refused by the adapter
  and lands on `item_faults`. Criterion 14's conservation law is unaffected —
  `produced + item_faults` still equals what the provider delivered — but a
  matrix that asserted `rejected == 1` for this input must now assert
  `item_faults`. `test_a4_conformance_matrix.py`'s mixed-sequence case was
  updated accordingly.

### Defects fixed (D-1, D-2)

Both defects Dev B's review reproduced are fixed, and
`tests/test_a4_defect_regressions.py` is the regression evidence (7 tests).

- **D-1, a half-open breaker that never resolved.** `allow()` admits exactly one
  probe and marks it in flight; only `record_success` or `record_failure`
  released it. A probe could end as **neither**: an empty response, a response
  whose every item was invalid, or a poll the backoff or ceiling gate held back
  *after* the breaker had already admitted it. The probe then stayed in flight
  for ever and every later poll was refused, so the source could never recover
  however healthy the provider became.
  **Fix:** a third report, `CircuitBreaker.release_probe(now_ms)`, called at all
  four of those exits in `_produce`. It returns the breaker to `open` with a
  **fresh cooldown**, so the next probe is admitted one cooldown later. It is
  deliberately *not* a release into `half_open`, which would re-admit a probe on
  the very next cycle and turn the inconclusive case into a tight poll loop
  against §7.4's "exactly one probe". No failure is recorded, so the sliding
  window, `opened_count` and the threshold are untouched: an inconclusive probe
  is not a failed one. It is a no-op when no probe is in flight, so a caller on
  the normal closed path may call it unconditionally. The new counter is
  `probes_released`, an **attribute**: it is kept out of `snapshot()`, whose key
  set `tests/test_a4_breaker.py` pins exactly.
- **D-2, malformed items escalated to a whole-response rejection.** §7.3's
  one-item-per-subject check built each subject with
  `(i.get("base"), i.get("quote"), i.get("rate_type"))`, so two items that each
  *lacked* their subject fields both became `(None, None, ...)`, collided, and
  discarded the **entire** response — including the good items in it. That is
  precisely what §7.1's "one bad item does not discard a good response" forbids,
  and a missing required field is `item_invalid` (A4-16).
  **Fix:** only items that carry all three subject fields enter the duplicate
  comparison (`SUBJECT_FIELDS` in `response.py`). An item with no subject has
  nothing to compare and is passed through to item-level validation, which
  rejects it as `item_invalid`. A genuine repeated subject is still a
  whole-response rejection, including when other items in the same response lack
  a subject — asserted directly.

Two classes are not in the scripted catalogue, on purpose:

- **`item_implausible`** is the plausibility guard's verdict on a correctly
  delivered value, so it arises in the pipeline, not in a response. Exercised in
  `test_a4_integration.py` against the shipped record's real bounds.
- **`internal`** is "a defect in the adapter or the service", so it cannot be a
  scripted provider behaviour. Exercised by a transport that raises.

### 2.2 The step vocabulary — `infra/testing/fake_provider/`

`Deliver`, `Silence`, `Fault`, `StatusFault`, `Redirect`, `WrongContentType`,
`MalformedBody`, `OversizedBody`, `TruncatedStream`, `CloseOnConnect`,
`WrongProtocolVersion`, `RepeatedSubject`, `TooManyItems`, plus `STEP_KINDS` and
`FakeProvider.repeating()`.

Steps carry **semantics, not wire detail**: no bytes, no header syntax, no status
arithmetic. The scaffold still imports nothing from `cbdc_ingestion`, `src/` or
`services/`, and still has no network. `bridge.to_response` raises on a step it
has not been taught, rather than defaulting to a healthy response.

### 2.3 The bridge — `infra/testing/a4_demo/bridge.py`

`ScriptedTransport` (`kind = "in_process_simulation"`), `to_response`, `encode`,
`source_values`. **The suite and the demonstration import the same bridge**, so
the demonstration cannot show a behaviour the suite does not assert.

## 3. What is deliberately not stable

- **The simulation timing numbers.** `SIMULATION_TIMING`'s fields may be retuned.
  Read them from the profile; never hard-code a millisecond count in a test.
- **The literal values a case delivers.** They come from the unchanged
  generator's `rate_for`; use `clean_values(...)`.
- **The internal fields of `SimulatedTransportFxAdapter`** other than
  `state`, `snapshot()`, `transport_calls`, `deferrals`, `breaker`, `backoff` and
  `next_attempt_ms`.

## 4. Three invariants dependent tests must not weaken

1. **No network, asserted structurally.** No A-4 module imports a socket, HTTP,
   TLS or subprocess module, and none names a host, port or URL — checked against
   `ast` import nodes, not prose. §8 item 2 is unchanged.
2. **One transport kind.** `AUTHORIZED_TRANSPORT_KINDS == ("in_process_simulation",)`.
   A transport of any other kind, or one with no declared kind, is refused at
   attachment. **Extending that tuple is an approval question** — AD-10, A-9's
   T-5 from inside the container including the egress allowlist, and Gate 3 for
   anything resembling a real provider.
3. **No registry record selects the A-4 adapter.** `sources.json` names
   `adapter_id: synthetic_fx`; `check_description` makes a mismatch a startup
   failure. The D-24 generator stays the default and `CBDC_INGESTION_SOURCES`
   stays empty.

## 5. Two existing tests changed shape — please review the change, not just the diff

### 5.1 Acceptance criterion 11 (Dev D)

`test_nothing_in_the_repository_imports_the_fake_provider` could not survive A-4
being exercised: the suite necessarily imports the scaffold. It was **replaced by
three tighter tests**, not deleted:

- `test_the_fake_provider_is_imported_only_from_declared_test_only_roots` — the
  scaffold may be imported from `services/ingestion/tests/` and
  `infra/testing/`, and from nowhere else in any first-party Python tree.
- `test_the_production_package_imports_neither_the_scaffold_nor_the_bridge` —
  asserted against `cbdc_ingestion/` itself, the one tree the image copies, by
  text **and** by `ast` import node. This is the assertion that matters for
  packaging, and it does not depend on the root list above being right.
- `test_a_4_is_actually_exercised_by_the_suite` — some suite really does drive a
  fault through the scaffold, so the exercise cannot be removed while the suite
  stays green.

Plus `test_the_bridge_is_outside_the_build_context_too`. The existing Dockerfile,
`.dockerignore`, build context, every CI workflow and every Compose file are
**unchanged**, and the `ingestion-unit` job remains the validation route.

### 5.2 The criterion 14 conservation law (Dev B)

`AdapterRunResult` gained `faults` and `item_faults`. They are **outside** the
law, because the law is stated over what a cycle *produced* and neither
corresponds to a produced observation: a 503 yields no item, and an item the
adapter refused in `normalize` never became a `NormalizedObservation`.
`test_the_counter_set_is_closed` now requires every field to be declared as one
or the other, so a future counter still fails until it is classified, and
`test_the_non_outcome_counters_are_excluded_for_a_reason_that_holds` asserts the
exclusion on the live path instead of in a comment.

The item faults `pipeline._fault` records are unchanged and **are** in the law,
under `rejected`.

## 6. What A-4 does **not** cover — the outstanding transport-level set

The seam is in-process, so these are **simulated, not exercised against a real
connection**, and the 3.3-S exit record must list them rather than claim A-4
complete:

| Not covered | What it needs |
|---|---|
| TLS handshake failure and timeout | a real transport; AD-10 |
| DNS resolution failure | a real transport; AD-10 |
| Socket reset mid-response, real read timeout | a real transport |
| Real mid-flight connection close (ours is a `truncated` flag) | a real transport |
| HTTP redirect **following** (ours asserts the refusal only) | AD-10, egress allowlist |
| Chunked transfer encoding, and a body streamed beyond the limit on the wire | a real transport |
| Real `Retry-After` HTTP-date handling | a trustworthy wall clock; AD-5 §3.5 currently forbids an adapter reading one |
| Egress allowlist enforcement (A-9 **T-5** per adapter, from inside the container) | AD-10; A-9 |
| Anything against a real provider | **Gate 3**, which does not exist |

Also still outstanding, and unchanged by this work: **criterion 10a / A-11(b)**,
the *Unavailable* display for a withdrawn source's stored values, deferred to the
milestone that builds the observation store (AD-11, C-5) and the panel behaviour
(C-8).

## 7. Running it

```bash
# the suites
cd services/ingestion && python -m pytest -q

# the A-4 suites alone
cd services/ingestion && python -m pytest -q tests/test_a4_*.py

# the demonstration: six scenarios, 30 checks, exits non-zero on any failure
python infra/testing/a4_demo/run_demo.py
python infra/testing/a4_demo/run_demo.py --json     # for a byte-exact diff
python infra/testing/a4_demo/run_demo.py --only clean
```

## 8. What Dev A asks for

- **Dev B:** review §2.1's five `slice` rows and §5.2, then build the conformance
  matrix against `TRANSPORT_CASES` by `case_id`.
- **Dev D:** review §5.1 — whether the three replacement tests preserve criterion
  11's guarantee — and §6 as the outstanding set the exit record must carry.
- **Both:** if either of you needs a case the catalogue does not hold, ask for the
  id rather than adding a private fixture; a private one would reintroduce the
  per-adapter divergence A-1 exists to prevent.
