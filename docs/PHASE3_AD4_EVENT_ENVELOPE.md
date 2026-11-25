# AD-4: Event Envelope and Provenance Schema

**Status:** **DRAFT v0.2**, 24 November 2026. **Not approved by the project owner.** Dev B, C and D approved it in the D-24 review; this is recorded as reviewer feedback only (AD-1 §8). v0.2 applies the owner decisions in §11.1; they settle those points, but do not approve the document.
**Lead:** Dev A. **Reviewers:** Dev B, Dev C, Dev D. **Approver:** project owner. Dev A is also the approver, so the second-reviewer rule (D-20) applies.
**Schema:** `contracts/events/event-envelope.v1.schema.json` (JSON Schema 2020-12, DRAFT).
**Scope source:** `docs/PHASE3_SCOPE.md` v1.2 §3.A, §3.B, §6, §7.3.
**Feeds:** AD-5, AD-7, AD-9, AD-11, AD-12; milestones 3.3–3.6.

Statements cite the decision they rest on, including the owner decisions in §11.1. Everything else is **proposed** until this document is approved. API contract v0.4 is unchanged, and no provider data was used (D-17).

## 1. What the envelope covers

One envelope carries **one external observation**, or one synthetic stand-in for one. The types are `fx_rate`, `economic_indicator`, `announcement` and `bank_holiday` (the roadmap §4.A categories). FX is the first candidate category (F-4).

It does **not** carry:

- **Bridge liquidity, congestion, fees, risk or allocations.** No such event type exists, and payloads are closed. Simulated bridge state keeps its Phase 2 path and labels (§8.2).
- **Routing results or route status.** Their push messages belong to AD-7.
- **Source health.** A connection status is not an observation. It belongs to AD-5.
- **Display labels, age or freshness.** These change with time, so they are computed when read (§7) and never stored.
- **Malformed input.** Input that cannot form a valid envelope is rejected and recorded separately (AD-5, AD-11).

## 2. Fields

Names are `snake_case`. Every field is required; `null` is written out. The schema is closed at every level.

| Field | Meaning |
|---|---|
| `schema_version` | Envelope version, `1.0` (§9) |
| `event_id` | UUID assigned by the ingestion component. A redelivery keeps it. |
| `event_type` | Selects the payload schema |
| `usage` | Always `display_only` (D-9, D-15; AD-6) |
| `source.source_id` | Stable identifier from the source registry |
| `source.transport` | `websocket`, `poll`, `scheduled`, `manual` or `synthetic`: how the value was actually obtained. A polled source is never `websocket`. |
| `source.source_url` | HTTPS document or endpoint URL, or null. It has no user information, query or fragment, and must contain no credential. |
| `source.gate3_decision_ref` | The recorded Gate 3 decision for the provider, or null (§3) |
| `provenance_class` | `real`, `derived`, `synthetic` or `assumed` (§3) |
| `derived_from`, `derivation` | Input `event_id`s, and the named method. Empty and null when nothing was derived. |
| `timestamps` | §5 |
| `source_sequence` | The provider's own sequence identifier, opaque, or null |
| `payload` | §4 |
| `payload_sha256` | SHA-256 of the RFC 8785 form of `{"event_type", "payload"}`, lowercase hex |
| `raw_sha256` | SHA-256 of the raw provider bytes, or null. Whether the bytes may be kept is a Gate 3 question. |
| `validation` | Status and reasons (§6) |
| `extraction` | Tool, version, status and confidence for extracted items, otherwise null |
| `review` | Reviewer reference and time, otherwise null. The reference is an opaque internal ID, not a name or email. |
| `supersedes` | The `event_id` this event corrects or whose review it concludes, or null |
| `synthetic` | Generator version, seed and case, or null (§3.2) |

Events are immutable. A correction or a review approval is a **new** event with `supersedes` set. How a review refusal is recorded belongs to AD-12.

`payload_sha256` is an input to duplicate detection. The idempotency key itself is decided in AD-5.

## 3. Provenance classes

| Class | Meaning | Transport | Gate 3 reference |
|---|---|---|---|
| `real` | A value as published by an approved provider, after the format normalization of §4 only | Any except `synthetic` | Required |
| `derived` | Computed from `real` or `derived` events | That of its inputs | Required |
| `synthetic` | Generated, or computed from anything synthetic | `synthetic` only | Null |
| `assumed` | Stated by a person, not taken from a provider, or computed from such values | `manual` only | Null |

### 3.1 Rules

- **Copying is ingestion.** A provider's value typed in by hand is `real` with transport `manual`, and needs that provider's Gate 3 approval (D-5, D-17). Calling it `assumed` to avoid the gate is not permitted.
- **The weakest input wins.** If any input is synthetic, the result is `synthetic`; otherwise, if any is assumed, it is `assumed`; otherwise it is `derived`.
- **In v1, all inputs of a derivation share one source and one transport.** Derivation from several sources, synthetic ones included, is deferred beyond envelope v1 (AD4-Q8). Validation rejects it; the schema alone cannot see the inputs' sources.
- **The Gate 3 reference is checked against the source registry,** for the provider named. A string in the field proves nothing by itself. The gate also blocks connecting, so this check is a second line of defence.

### 3.2 Synthetic marking

Four markers must agree, and the schema enforces it:

- `provenance_class: synthetic`;
- `transport: synthetic`;
- a `source_id` beginning `synthetic.`;
- a non-null `synthetic` block.

A synthetic event has no URL and no Gate 3 reference. Synthetic and observed events are stored so that a query for observed events cannot return synthetic ones; AD-11 defines how. Synthetic events are never used to train, tune or select a policy (scope §6).

### 3.3 Relation to Phase 1 tags

The four classes reuse Phase 1's vocabulary. They do **not** rename or reclassify any Phase 1 tag, and code must **not** infer a class from a tag's prefix. For example, the Phase 1 tag `real_rpw_derived` marks synthetic daily bridge values that are conditioned on real RPW data (`src/preprocessing/synthetic_generator.py`). Reading it as `real` would present a simulation as an observation.

## 4. Payloads and normalization

| Type | Fields | Rule |
|---|---|---|
| `fx_rate` | `base_currency`, `quote_currency`, `rate`, `rate_type` | Units of quote per one unit of base. The currencies differ. An inverted or crossed rate is `derived`, or keeps the weaker class of its inputs (§3.1). |
| `economic_indicator` | `indicator_code`, `country`, `period`, `value`, `unit` | `period` as the source states it |
| `announcement` | `issuer`, `title`, `summary`, `country` | Untrusted plain text |
| `bank_holiday` | `country`, `date`, `name` | Local calendar date, with no time zone conversion |

- **Numbers are decimal strings,** so precision and hashes survive JSON. They are parsed as decimals. API contract v0.4's JSON numbers are unaffected.
- **Codes:** ISO 4217 currencies and ISO 3166-1 alpha-3 countries, upper case. The schema checks their shape; validation checks membership.
- **Text is data.** It is shown escaped and is never rendered as HTML, executed, or used as an instruction to a model.
- The three types other than `fx_rate` are minimal. Each is reviewed again before its first adapter.

## 5. Timestamps

All are UTC, RFC 3339, with exactly three fractional digits and `Z`.

| Field | Set by | Meaning |
|---|---|---|
| `source_timestamp` | Provider | When the value was observed or published. Null if the provider gives none; **never** filled from a local clock. (The synthetic generator is its own provider.) |
| `source_timestamp_basis` | Adapter | `observed`, `published`, or `none` exactly when the timestamp is null |
| `retrieved_at` | Ingestion component | When the raw value was received. For `manual`, when it was entered. |
| `emitted_at` | Ingestion component | When the envelope was created |

- `retrieved_at` ≤ `emitted_at`.
- A date-only source value is not given an invented time. `source_timestamp` is null unless the provider documents the publication time.
- For a derived event, `source_timestamp` and `retrieved_at` are the **oldest** among its inputs. If any input has no source timestamp, the result has none.
- Replay and redelivery keep all original timestamps, so an old event cannot look fresh. A review approval copies the timestamps of the reviewed event, except `emitted_at`.
- A late event is valid. Where source timestamps exist, the current value for a subject is the one with the latest, not the latest arrival. Ordering without them, ties and late-event windows belong to AD-2 and AD-5.

## 6. Validation

| Outcome | Meaning | Reaches the dashboard as a value |
|---|---|---|
| `validated` | All checks passed, and human review is done where required | Yes |
| `quarantined` | A valid envelope that failed a plausibility check or awaits review | No |
| Rejected | No valid envelope exists, or a boundary rule was broken. Not an envelope status. | No |

Validation runs at ingestion and again at the first downstream trust boundary.

**Rejected:**

- a schema failure, an unknown version, or an impossible calendar date;
- an unregistered source, a transport that differs from the registered one, or a missing or wrong Gate 3 approval;
- a hash mismatch, or `retrieved_at` after `emitted_at`;
- unknown currency, country or unit codes, or identical FX currencies;
- derivation inputs that are missing or break §3.1 or §5;
- a superseded event that is missing, of another source or of another event type.

**Quarantined:**

| Reason | When |
|---|---|
| `FUTURE_SOURCE_TIMESTAMP` | `source_timestamp` exceeds `retrieved_at` by more than the AD-8 clock tolerance |
| `VALUE_OUT_OF_RANGE`, `VALUE_JUMP` | Outside per-source bounds set in AD-5 |
| `REVIEW_REQUIRED` | Every unreviewed `announcement` or extracted item |

A duplicate is neither rejected nor quarantined; AD-5 defines how it is discarded.

**A validated event is not knowledge.** Validation permits display only. Writing to the knowledge layer needs Gate 2 (D-4), and nothing here affects feasibility (A-4).

## 7. Freshness

Freshness is a function of the event, its source profile and the evaluation time.

**Age** = evaluation time − `source_timestamp`, or − `retrieved_at` when the source timestamp is null. An age that is negative within the clock tolerance counts as 0.

**The source profile** (held in the AD-5 registry; values set in AD-8) has:

| Setting | Meaning |
|---|---|
| `expected_interval_ms` | Expected update interval, or null |
| `live_max_age_ms` | Greatest age that may be shown as live. Null means **never live**, for example a daily reference rate. |
| `stale_after_ms` | Age beyond which the value is stale |
| `unavailable_after_ms` | Age beyond which the value is withdrawn, or null |

- `live_max_age_ms` ≤ `stale_after_ms` ≤ `unavailable_after_ms`, where set.
- For a synthetic source, `stale_after_ms` = 3 × `expected_interval_ms`, provisionally (F-5).
- A source without `stale_after_ms` cannot be displayed, unless its transport is `manual`.
- Freshness state: `stale` if age > `stale_after_ms`, otherwise `fresh`. A manual source without a threshold shows its age and no freshness state. A source outage does not refresh or reset age.
- The server evaluates with its own clock and sends the evaluation time. The browser advances age by elapsed monotonic time, not by its wall clock. AD-7 defines the messages.

## 8. Display labels

### 8.1 Observations

The label is one of **Live, Delayed, Simulated, Manually entered, Unavailable** (roadmap §4.D, exit criterion 7). First match wins:

| # | Condition | Label |
|---|---|---|
| 1 | No event; not `validated`; unknown major version or unknown value in `usage`, `provenance_class`, `transport` or `validation.status`; or no usable source profile | Unavailable |
| 2 | Class `real` or `derived`, and the Gate 3 approval is absent or withdrawn | Unavailable |
| 3 | Age > `unavailable_after_ms` | Unavailable |
| 4 | Class `synthetic` | Simulated |
| 5 | Transport `manual` | Manually entered |
| 6 | `source_timestamp` is set, the value is `fresh`, age ≤ `live_max_age_ms`, and the source is not in outage (AD-5) | Live |
| 7 | Otherwise | Delayed |

- **A polled value may be Live** if it meets rule 6, and then always shows its transport: "Live · polled" (AD4-Q2). It is never described as streamed.
- **Stale is a qualifier, not a sixth label** (AD4-Q3). It is shown beside the label, not instead of it: "Delayed · stale · 12 min", "Simulated · stale". A stale value is never Live.
- **Every displayed value also shows** its source, its age or source timestamp, its transport in words ("polled", "streamed") and its class when it is `derived` or `assumed`.
- **Unavailable shows no number.** The last value may appear only as history, with its timestamp.
- A superseded event is never the current value.
- Labels are text, not colour alone.
- The label permits no wider claim: status documents follow scope §6, and routing is never described as live (D-15).

### 8.2 Phase 2 values

These are not envelope events. Their Phase 2 labels (arch §5.3) stay, word for word. The mapping adds the display label required by exit criterion 7. An explicit state displays as **Manually entered** (AD4-Q4), together with its existing Phase 2 label:

| `values_provenance` | Existing label | Display label |
|---|---|---|
| `synthetic_simulation`, `synthetic_scenario` | Simulated | Simulated |
| `user_supplied_synthetic` | User-supplied synthetic state | Manually entered |

This covers liquidity and congestion. Corridor risk stays Simulated in every mode. No Phase 2 value may be Live or Delayed.

## 9. Versioning

- **Minor (1.x):** adds an optional field or an `event_type`. The `schema_version` list grows, and stored events stay valid.
- **Major:** removes or redefines a field, or changes the values of `usage`, `provenance_class`, `transport` or `validation.status`. It gets a new file.
- **Producers and the first downstream boundary validate strictly,** against the stated version, and reject a version they don't know. Later consumers accept an unknown 1.x version, ignoring unknown fields and event types, as in contract v0.4 §1. The four safety fields above are the exception: an unknown value makes the observation Unavailable, as does an unknown major version.
- Changing `usage` also needs the engine change described in AD-6 §7.

## 10. Example (synthetic)

```json
{
  "schema_version": "1.0",
  "event_id": "018f0000-0000-7000-8000-000000000001",
  "event_type": "fx_rate",
  "usage": "display_only",
  "source": {"source_id": "synthetic.fx", "transport": "synthetic", "source_url": null, "gate3_decision_ref": null},
  "provenance_class": "synthetic",
  "derived_from": [],
  "derivation": null,
  "timestamps": {
    "source_timestamp": "2026-11-24T10:00:00.000Z",
    "source_timestamp_basis": "observed",
    "retrieved_at": "2026-11-24T10:00:00.050Z",
    "emitted_at": "2026-11-24T10:00:00.060Z"
  },
  "source_sequence": "1",
  "payload": {"base_currency": "USD", "quote_currency": "INR", "rate": "1.2345", "rate_type": "mid"},
  "payload_sha256": "22fe8747cb6a035235c3ad84c45c5214d271941c784a5a2e4cc0c8c048798ca4",
  "raw_sha256": null,
  "validation": {"status": "validated", "reasons": []},
  "extraction": null,
  "review": null,
  "supersedes": null,
  "synthetic": {"generator_version": "0.0.0-example", "seed": 1, "case_id": "normal"}
}
```

The rate is deliberately unrealistic.

## 11. Questions

### 11.1 Decided by the project owner (24 November 2026)

| # | Decision | Section |
|---|---|---|
| AD4-Q2 | A fresh polled observation may be labelled Live, and the polling transport is displayed. | §8.1 |
| AD4-Q3 | Stale is a qualifier, not a sixth label. | §8.1 |
| AD4-Q4 | An explicit user-supplied synthetic state displays as Manually entered. | §8.2 |
| AD4-Q8 | Multi-source derivation is deferred beyond event envelope v1. | §3.1 |

### 11.2 Open

| # | Question | Draft position | Decides |
|---|---|---|---|
| AD4-Q1 | Is freshness age measured from `source_timestamp`? | Yes, with `retrieved_at` as the fallback. F-5's event-to-display start point is separate and still open. | AD-8 |
| AD4-Q5 | Where does the schema live? | `contracts/events/`, owned by Dev D. Not yet covered by `check_contracts.py`. | Dev D |
| AD4-Q6 | Clock tolerance, plausibility bounds, thresholds | Not set here | AD-5, AD-8 |
| AD4-Q7 | Storage separation, and reviewer reference format | Not set here | AD-11, AD-12 |

## 12. Approval checklist

- [ ] Dev B: persistence and hashing
- [ ] Dev C: labels and freshness, including how §8.2's two labels appear together
- [ ] Dev D: schema, location and versioning. **Flagged:** AD4-Q5 (schema location) is yours to decide
- [ ] Project owner: approval, recorded in `docs/PHASE3_SCOPE.md` §2
