# AD-4 Part 2: Event Identity, Canonical Hashing, Validation and Cross-Service Compatibility

**Status:** **DRAFT v0.1**, 26 November 2026. **Not reviewed and not approved.**
**Relationship to AD-4 v0.2:** this is an **additive companion** to `docs/PHASE3_AD4_EVENT_ENVELOPE.md`, which stays **exactly as approved**. AD-4 **v0.2 is approved for the D-24 slice only** (25 November 2026, scope §2.2.3), and that approval is **version-specific**: a revision of v0.2 would need fresh review and a fresh owner approval before the D-24 slice could continue on it (AD-4 status line; AD-1 status line). Revising the approved file would therefore **suspend the authorization of work now in progress**, so this document is written beside it instead. **Nothing in AD-4 v0.2 is edited, superseded or reinterpreted here.** Where the two could be read as disagreeing, **v0.2 wins**, and the disagreement is a defect in this document.
**Lead:** Dev A. **Reviewers:** Dev B, Dev C, Dev D (the AD-4 reviewer set). **Approver:** project owner. Dev A is also the approver, so the second-reviewer rule (D-20) applies.
**Scope source:** `docs/PHASE3_SCOPE.md` v1.4 §3.A, §3.B, §7.3 (AD-4 row), §10.1; D-9, D-15, D-17; AD4-Q1 to AD4-Q8.
**Feeds:** AD-5, AD-7, AD-9, AD-11, AD-12; milestones 3.3 to 3.6.
**Machine artefacts referenced, not changed:** `contracts/events/event-envelope.v1.schema.json`, `contracts/events/ingestion-latest.v1.schema.json`, `contracts/events/stream-message.v1.schema.json`, `contracts/test-vectors/event_payload_hash.v1.json`, and the checker `infra/scripts/check_event_contracts.py`.

**No provider data was used** (D-17). API contract v0.4 is unchanged. This document changes no code and no schema.

---

## 1. Why a Part 2, and what it adds

AD-4 v0.2 was written for, and approved for, the D-24 slice: one synthetic `fx_rate` source, four pairs, one process, no storage, no distribution mechanism, one consumer. It is complete for that. Full Phase 3 adds four things it leaves open, each of which has to be settled before milestones 3.3 to 3.6 can be built:

| # | What full Phase 3 adds | Where AD-4 v0.2 leaves it | Here |
|---|---|---|---|
| 1 | **Event identity for non-synthetic transports**, and the unresolved C-1 residual risk | "A UUID assigned by the ingestion component" (§2) | §3 |
| 2 | **An exact canonical-hashing profile**, binding across two languages and several services | "SHA-256 of the RFC 8785 form" (§2) | §4 |
| 3 | **A validation architecture**: which stage runs where, the full outcome catalogue, and what each component may conclude | "Validation runs at ingestion and again at the first downstream trust boundary" (§6) | §5 |
| 4 | **Cross-service compatibility**: version negotiation across four services and two languages, and what a schema change obliges each to do | The rules in §9, without the per-service obligations | §6 |

It also drafts the three non-FX payload schemas (§7), which AD-4 §4 requires to be "reviewed again before its first adapter".

---

## 2. Terms

| Term | Meaning |
|---|---|
| **Observation** | One external measurement, or one synthetic stand-in for one (AD-4 §1) |
| **Subject** | What an observation is about, and what "the current value" is current for. Defined per event type in AD-5 §6.3 |
| **Identity** (`event_id`) | Which event this is. Stable under redelivery (AD-4 §2) |
| **Idempotency key** | Whether two events are the same observation. Defined in AD-5 §8.1; AD-4 §2 defers it |
| **Canonical form** | The RFC 8785 serialization of `{"event_type", "payload"}`, which `payload_sha256` digests |
| **Producer** | The component that assembles an envelope: the ingestion service |
| **First downstream boundary** | The first component to receive an envelope from another process. In the D-24 slice, Express |

---

## 3. Event identity

### 3.1 The properties identity must have

**[PROPOSED]** `event_id` must be:

1. **stable under redelivery** — a redelivery keeps it (AD-4 §2), which is what lets a duplicate be recognized without consulting storage;
2. **stable across a producer restart**, because a restart must not re-name an observation it has already published;
3. **distinct for distinct observations**, including two observations of **different subjects** at the same instant — the property whose absence was correction **C-1** (AD-1 §3.4.1);
4. **reproducible for replay**, for synthetic sources, so that the same seed and clock give the same events (AD-1 §6 item 1);
5. **free of any input that is not a property of the observation** — no start moment, no process identifier, no arrival time. C-1's analysis records this explicitly: *"putting the start moment or the instance identifier in the name would have fixed the collision and broken replay, so neither was used."*

### 3.2 Derivation per transport

**[PROPOSED]** Restating AD-5 §5, which defers the derivation rules to this section.

| Transport | `event_id` | Satisfies |
|---|---|---|
| `synthetic` | `UUIDv5(namespace, seed \| pair \| sequence \| source_timestamp)` — the derivation **approved as correction C-1**, unchanged | 1 to 5 within one generator configuration (§3.4) |
| `websocket`, `poll`, `scheduled` | `UUIDv5(namespace, source_id \| event_type \| subject \| source_timestamp \| payload_sha256)` | 1 to 3 and 5. Property 4 does not apply: a provider's stream is not replayed from a seed |
| `manual` | `UUIDv4`, random at entry | 3 and 5. Properties 1, 2 and 4 do not apply: a typed value has no reproducible identity, and two identical entries are two distinct acts |

**Why `payload_sha256` is in the derivation for provider transports, and the pair is for synthetic.** For a provider, two events with the same source, type, subject and timestamp but different values are a genuine conflict that must be visible, so the payload hash puts the disagreement into the name and the AD-1 §3.4 conflict rule catches it. For the generator, the value is a function of the seed, the pair and the sequence, so the pair is sufficient and keeps the derivation independent of the hash.

**A single namespace UUID** is fixed once, recorded in the schema repository, and never changed: changing it would re-name every event ever produced.

### 3.3 Identity, idempotency and ordering are three different things

**[PROPOSED]** They are often conflated, and conflating them is how C-1 happened.

| Question | Answered by | Defined in |
|---|---|---|
| Which event is this? | `event_id` | §3.2 |
| Is this the same observation as one already seen? | The idempotency key | AD-5 §8.1 |
| Which observation of this subject is current? | `source_timestamp`, with first-kept on a tie | AD-4 §5; AD-5 §8.3 |

`source_sequence` answers **none** of them: it is the provider's own identifier, **opaque** (AD-4 §2), and AD-5 §8.3 forbids using it to break a tie. `instance_id` is diagnostic only (AD-1 §3.4).

### 3.4 The C-1 residual risk, unresolved

**[PROPOSED]** Dev B's C-1 review recorded a residual risk that **C-1 does not close** and that is **outside its scope** (AD-1 §3.4.1):

> Overlapping runs with the same seed and timestamps but a different `case_id` or `generator_version` produced **40** conflicts, because the derivation includes neither.

It cannot be closed here, because C-1's derivation is **approved text** and §3.2 keeps it unchanged. What AD-4 Part 2 does instead:

1. **Records it as open**, so it is not lost between documents (AD-5 §14 item 5 carries the same entry).
2. **Bounds it.** Two generator configurations can collide only while both run against one consumer with the same seed and an aligned clock. One `source_id` with one active configuration cannot collide with itself.
3. **Proposes a containment that needs no change to the approved derivation:** the registry (AD-5 §2.2) permits **one active generator configuration per `source_id`**, and a second configuration is a **second `source_id`** — which enters the derivation through nothing, but enters the **idempotency key** as its first component (AD-5 §8.1), so the conflict becomes two distinct observation streams rather than two names for one. This is a configuration rule, not a derivation change, so it is available now.
4. **Proposes, for a future generator version only,** adding `generator_version` and `case_id` to the synthetic derivation: `UUIDv5(namespace, seed \| generator_version \| case_id \| pair \| sequence \| source_timestamp)`. Both are already envelope fields (AD-4 §2, §3.2) and both are properties of the observation, so property 5 holds and replay is preserved.

**This fourth item needs the project owner's approval and is not adopted here.** It would change an approved derivation, so it belongs to a **new generator version** with its own `synthetic.generator_version`, and events produced under C-1's derivation keep their names. Question **AD4P2-Q1** (§9) puts it to the owner.

---

## 4. Canonical hashing

### 4.1 What is hashed

**[APPROVED]** (AD-4 §2) `payload_sha256` is the SHA-256 of the RFC 8785 form of `{"event_type", "payload"}`, lowercase hex. `raw_sha256` is the SHA-256 of the raw provider bytes, or null; whether the bytes may be kept is a Gate 3 question.

**[PROPOSED]** The two-member object, rather than the payload alone, is load-bearing: it binds a payload to its **type**, so an `fx_rate` payload cannot be re-presented as another type with the same digest. Nothing else is inside the hash — not the identity, not the timestamps, not the validation status — so the digest is a function of **what was observed**, and it stays equal across a redelivery, a replay and a correction that changes only metadata.

### 4.2 The canonicalization profile

**[PROPOSED]** RFC 8785 is the rule; this profile records the part of it the implementations actually exercise, so that two languages cannot diverge in an untested corner.

| Rule | Consequence |
|---|---|
| Object members sorted by **UTF-16 code-unit** order of their names | The sort is RFC 8785's, not the host language's locale collation |
| No insignificant whitespace | — |
| Strings escaped per RFC 8785's shortest form | `\u` escapes only where required |
| **All payload numbers are decimal strings, not JSON numbers** (AD-4 §4) | **RFC 8785's number serialization is never reached.** This is deliberate: its ECMAScript double rules are where two languages are most likely to differ, and a decimal string in JSON survives both without rounding |
| A trailing zero is **significant** | `"1.2340"` and `"1.234"` are different canonical strings and different digests. They are the provider's digits, preserved (AD-5 §4) |
| No `null` inside a payload | A payload field is present with a value, or the envelope is rejected. `null` appears in the envelope's metadata, never in the hashed payload |
| Payloads are **closed objects, one level deep** | No nested objects, no arrays, so canonicalization never recurses. The existing D-24 canonicalizer is already limited to "objects and ASCII strings" (AD-1 §3.7, P-9) |
| Non-ASCII text is permitted in `announcement` fields, and is canonicalized per RFC 8785 | §7.3 requires the canonicalizer to be extended and re-vectored **before** the first announcement adapter, because the slice's is ASCII-limited |

### 4.3 Cross-language parity is a contract, not a convention

**[APPROVED]** (AD-1 §3.7, P-9, technically approved by Dev A) The shared vectors are `contracts/test-vectors/event_payload_hash.v1.json`: input, the exact RFC 8785 string and the SHA-256, checked by **Python** (`rfc8785`) and **TypeScript**, including AD-4 §10's hash, reordered keys, trailing-zero rates and altered payloads that must fail. Dev B's C-1 review reports all **11** vectors (7 `vectors`, 4 `must_not_match`) matching byte-for-byte across both languages.

**[PROPOSED]** The obligations that keep it true as Phase 3 grows:

1. **Both sides publish the canonical string, not only the digest.** A digest mismatch says two implementations disagree; the string says where. The vector file already carries both.
2. **A new event type, payload field or character class requires new vectors in the same commit**, and CI fails if a type has no vector. `check_event_contracts.py` already enforces coverage of this kind (its check 5).
3. **The producer's digest is authoritative; a consumer verifies, never recomputes-and-replaces.** A mismatch is a **rejection** (AD-4 §6), never a silent repair.
4. **No third implementation** without a vector run. Each new language or service that hashes an envelope is a new way to disagree.
5. **Neither implementation adds a dependency that the other cannot match.** The backend has no RFC 8785 or JSON Schema library, which is why AD-1 §3.7 specifies a strict validator and a canonicalizer with no new dependency.

### 4.4 Failure modes, and what each means

**[PROPOSED]**

| Symptom | Means | Action |
|---|---|---|
| Digest differs, canonical strings differ | A canonicalization divergence | **Rejection**, and a paged alert (AD-8 §7.3, B-1): it is a contract failure, not a data fault |
| Digest differs, canonical strings identical | A digest implementation fault | As above |
| Digest matches, payload differs | Impossible short of a SHA-256 collision | — |
| A stored event's digest no longer matches its payload | Corruption, or an edit of an immutable record | **Rejection** on read, and an alert. Events are immutable (AD-4 §2) |

---

## 5. Validation architecture

### 5.1 Stages

**[APPROVED]** (AD-4 §6) Validation runs **at ingestion and again at the first downstream trust boundary**, and the outcomes are `validated`, `quarantined` or **rejected** — where rejected means no valid envelope exists and is "not an envelope status".

**[PROPOSED]** Five stages, named so that an implementation can say which one failed:

| # | Stage | Checks | Runs at |
|---|---|---|---|
| **V-1** | Structural | JSON parses; size within the AD-8 limit, checked while reading; the closed envelope schema; the `schema_version` is known | Producer; every boundary |
| **V-2** | Integrity | `payload_sha256` recomputed and compared; `retrieved_at` at or before `emitted_at`; real calendar dates | Producer; every boundary |
| **V-3** | Registry | `source_id` registered; transport equals the registered one; the Gate 3 reference present, matching and **active** for `real` and `derived`; the event type and subject within the source's allowlist; the synthetic markers all four agreeing | Producer; **and the first downstream boundary, independently** |
| **V-4** | Semantic | Code membership (ISO 4217, ISO 3166-1 alpha-3); FX currencies differ; derivation rules of AD-4 §3.1 and §5; `supersedes` resolves to an event of the same source and type | Producer; boundary where it has the inputs |
| **V-5** | Plausibility | The AD-5 §10 bounds, with AD-8's values: range, jump, clock tolerance, review required | Producer. A boundary may re-apply it; it may not **clear** a quarantine |

**Independent re-validation is the point of V-3, not redundancy.** AD-4 §3.1 already requires the Gate 3 reference to be checked against the registry "for the provider named", because "a string in the field proves nothing by itself", and the D-24 slice already has Express re-validate everything ingestion validated — hashes, markers, codes, dates, timestamp ordering (AD-1 §3.4). A boundary that trusted the producer's verdict would make the producer's compromise the system's.

### 5.2 Who may conclude what

**[PROPOSED]** The asymmetry is deliberate, and it is a safety property:

| Component | May conclude | May **not** conclude |
|---|---|---|
| Producer (ingestion) | `validated`, `quarantined`, rejected | — |
| First downstream boundary | Reject, or withhold as quarantined | **`validated` for an event the producer did not validate.** A boundary can only ever be more restrictive |
| Any later consumer | Reject, or display Unavailable | As above |
| The browser | Reject a message and show Unavailable (AD-1 §3.3.3) | Any upgrade of status. It has no thresholds of its own (AD-1 §3.3) |

**Monotonic restriction:** status may only move towards less display, never towards more. There is no path by which a quarantined event becomes displayable without the AD-12 review flow, and **no knowledge-layer write follows without Gate 2** (D-4).

### 5.3 Outcome catalogue

**[APPROVED]** (AD-4 §6) The rejection list and the three quarantine reasons.

**[PROPOSED]** The same list, grouped by stage and extended with the full-Phase-3 cases AD-4 v0.2's single-source slice did not need. **Every addition is a rejection or a quarantine, never a new permissive case.**

| Code | Stage | Outcome | In AD-4 v0.2 |
|---|---|---|---|
| `SCHEMA_INVALID`, `UNKNOWN_SCHEMA_VERSION`, `IMPOSSIBLE_DATE` | V-1 | Reject | Yes |
| `OVERSIZE` | V-1 | Reject | Implied by AD-1 §3.1, §3.3.5 |
| `HASH_MISMATCH`, `TIMESTAMP_ORDER` | V-2 | Reject | Yes |
| `SOURCE_UNREGISTERED`, `TRANSPORT_MISMATCH`, `GATE3_MISSING`, `GATE3_WITHDRAWN` | V-3 | Reject | Yes |
| `EVENT_TYPE_NOT_PERMITTED`, `SUBJECT_NOT_PERMITTED` | V-3 | Reject | New. AD-1 §3.4 is the slice's pair allowlist; §2.2 of AD-5 generalizes it |
| `SYNTHETIC_MARKERS_DISAGREE` | V-3 | Reject | Yes, as AD-4 §3.2's four-way agreement |
| `UNKNOWN_CODE`, `FX_CURRENCIES_IDENTICAL`, `DERIVATION_INVALID`, `SUPERSEDES_INVALID` | V-4 | Reject | Yes |
| `MULTI_SOURCE_DERIVATION` | V-4 | Reject | Yes — **AD4-Q8**, owner-decided: deferred beyond envelope v1, and validation rejects it |
| `FUTURE_SOURCE_TIMESTAMP` | V-5 | **Quarantine** | Yes |
| `VALUE_OUT_OF_RANGE`, `VALUE_JUMP` | V-5 | **Quarantine** | Yes |
| `REVIEW_REQUIRED` | V-5 | **Quarantine** | Yes — every unreviewed `announcement` and extracted item |
| *(duplicate)* | Post-validation | **Discarded**, counted. Neither rejected nor quarantined | Yes (AD-4 §6); AD-5 §8.2 defines how |

### 5.4 What a rejection records

**[PROPOSED]** A rejection has no envelope, so it cannot be an envelope (AD-4 §1: "Input that cannot form a valid envelope is rejected and recorded separately"). It records: the stage and code; the `source_id`; the `event_id` **only if the envelope was well formed enough to have one**; `retrieved_at`; and the byte length. **Never the payload, and never the raw bytes** (AD-1 §3.4). Storage is AD-11's; counters and the rate-limited log are AD-8 §7's.

A rejection is **not** a quarantine: a quarantined event is a valid envelope that is withheld and can be reviewed, while a rejected input has nothing to review.

---

## 6. Cross-service compatibility

### 6.1 The services an envelope crosses

**[PROPOSED]** Four, in two languages, plus the stored form:

| # | Service | Language | Role for the envelope |
|---|---|---|---|
| 1 | Ingestion | Python | Producer: assembles, hashes, validates |
| 2 | Distribution | AD-3's mechanism | Transport. **It does not interpret an envelope** |
| 3 | Express | TypeScript | First downstream boundary: re-validates, holds current state, serves the channel |
| 4 | Web | TypeScript | Consumer: validates each message, renders labels |
| 5 | The observation store | PostgreSQL via Prisma (AD-11) | Durable form |

Each hop is a place two implementations can disagree, which is why §4.3's parity obligations and §5.1's independent re-validation exist.

### 6.2 Versioning rules

**[APPROVED]** (AD-4 §9) Minor (1.x) adds an optional field or an `event_type`, and stored events stay valid. Major removes or redefines a field, or changes the values of `usage`, `provenance_class`, `transport` or `validation.status`, and gets a new file. **Producers and the first downstream boundary validate strictly** against the stated version and reject a version they don't know; later consumers accept an unknown 1.x, ignoring unknown fields and event types, as in contract v0.4 §1. The four safety fields are the exception: an unknown value makes the observation **Unavailable**, as does an unknown major version. Changing `usage` also needs the engine change described in AD-6 §7.

**[PROPOSED]** The per-service obligations that follow, which AD-4 v0.2 states as rules without assigning:

| Service | On a known 1.x | On an unknown 1.x | On an unknown major |
|---|---|---|---|
| Ingestion (producer) | Emits exactly one declared version | n/a | n/a |
| Express (first boundary) | **Strict:** rejects unknown fields | **Rejects** | **Rejects** |
| Web (consumer) | Ignores unknown message fields | Ignores unknown fields and event types | **Unavailable, and stops** (AD-1 §3.2) |
| Store (AD-11) | Keeps the version with the record | Stores it, does not interpret | Stores it, does not interpret |

**Why the boundary is strict and the consumer is lenient.** A strict boundary is a security control: it stops an unexpected field from reaching the browser or the store. A lenient consumer is an upgrade control: it lets the producer and Express be upgraded before every browser tab is reloaded. Reversing either would be a defect.

### 6.3 The channel's version is not the envelope's

**[PROPOSED]** Two independent versions, and conflating them would couple a UI change to an envelope change:

| Version | Governs | Owner | Current |
|---|---|---|---|
| `schema_version` | The **envelope** | AD-4 | `1.0` |
| `protocol_version` | The **channel message** that wraps it | AD-7; AD-1 §3.1, §3.2 for the slice | `1.0` |

An envelope travels inside a channel message unchanged — AD-1 §3.2 requires `value.event` to be "the unmodified envelope" — so a channel version may rise without the envelope's, and the reverse.

### 6.4 What a schema change obliges

**[PROPOSED]** A checklist, because a partial rollout is the realistic failure:

| Change | Obliges |
|---|---|
| A new optional envelope field | A minor bump; the schema; a fixture per validity case; **no** change to `payload_sha256` unless the field is inside `payload`; consumers ignore it |
| A new `event_type` | A minor bump; a payload schema; **new hash vectors**; a subject definition (AD-5 §6.3); a freshness profile and plausibility bounds (AD-8 §4); display rules (AD-9); fixtures on both sides |
| A new `payload` field in an existing type | A minor bump **and new hash vectors**, because the canonical form changes. Every stored digest of that type stays valid, since old payloads lack the field |
| A change to `usage`, `provenance_class`, `transport` or `validation.status` values | A **major** version, a new schema file, and — for `usage` — the full AD-6 §7 list, which is **not planned or authorized** |
| A new `validation` reason code | A minor bump; consumers must treat an unknown reason as a reason to **withhold**, never to display |

**Deployment order for a minor bump:** schema and vectors, then Express's validator, then ingestion's producer, then the web consumer. Express must accept the new form before ingestion emits it; the consumer may lag, because it is lenient (§6.2).

### 6.5 Compatibility test obligations

**[PROPOSED]** Extending the mechanism AD-1 §3.7 established and `check_event_contracts.py` implements:

| # | Obligation |
|---|---|
| X-1 | **One fixture set, two languages, same verdict** on every fixture. AD-1 §3.7 already requires this; it extends to every event type and every new validation code |
| X-2 | **Hash vector coverage per type and per character class**, including non-ASCII once §7.3 lands |
| X-3 | **Version-matrix tests:** a known 1.x, an unknown 1.x and an unknown major, asserted at **each** of Express and the web client, with the §6.2 outcome for each |
| X-4 | **Safety-field tests:** an unknown value in each of `usage`, `provenance_class`, `transport` and `validation.status` yields **Unavailable**, not a silent default |
| X-5 | **Round-trip through the store:** an envelope stored and read back validates identically and keeps its digest (AD-11) |
| X-6 | **Monotonic restriction:** no component upgrades a status (§5.2), tested with a quarantined and a non-validated event at each boundary |
| X-7 | **No provider data** in any fixture or vector (D-17; AD-5 §13 A-10) |

---

## 7. The three non-FX payload schemas

**[APPROVED]** (AD-4 §4) The three types other than `fx_rate` are **minimal, and each is reviewed again before its first adapter.** This section is that review's input; it changes nothing until the type's adapter is proposed, and each needs Gate 3 for its source.

### 7.1 `economic_indicator`

**[PROPOSED]** Fields stay `indicator_code`, `country`, `period`, `value`, `unit` (AD-4 §4), with: `period` as the source states it, carried as a string with a stated grammar per publisher rather than parsed into a date; `value` a decimal string; `unit` from a closed enumeration per `indicator_code` in the registry, because a free-text unit cannot be compared or displayed safely. A revision or a restatement is a **new event with `supersedes` set** (AD-4 §2), never an edit.

### 7.2 `bank_holiday`

**[PROPOSED]** Fields stay `country`, `date`, `name`. `date` is a local calendar date with **no time-zone conversion** (AD-4 §4), and the subject is (`country`, `date`) (AD-5 §6.3). A calendar is a set of events, not one value, so **a holiday calendar has no single current value**: a source that publishes a whole year emits one event per date, and the display is a list.

**Hard boundary, worth stating in the schema review:** a holiday **never** blocks or warns on a corridor. AD-6 §4 lists exactly that as forbidden, because it would act on unverified text as a compliance decision.

### 7.3 `announcement`

**[PROPOSED]** Fields stay `issuer`, `title`, `summary`, `country`, with:

- **text is untrusted data** — shown escaped, never HTML, never executed, **never used as an instruction to a model** (AD-4 §4). This is the one payload where prompt injection is a live concern, since Cognee and extraction tools read it;
- **every unreviewed announcement is `REVIEW_REQUIRED`**, hence quarantined and not displayed (AD-4 §6). The review flow is AD-12's, and **any knowledge-layer write needs Gate 2** (D-4);
- `extraction` is non-null for an extracted item, carrying tool, version, status and confidence (AD-4 §2), and ScrapeGraphAI is **an extraction aid, not an authoritative source and not a compliance decision-maker** (roadmap §4.A);
- **a size limit on `summary`**, inside the 65 536-byte payload limit (C-2), with the full text referenced by `source_url` rather than copied;
- **no subject** (AD-5 §6.3): an announcement is never superseded by recency, only by an explicit `supersedes`.

**Before the first announcement adapter**, the canonicalizer and the hash vectors must be extended beyond ASCII (§4.2) and a non-ASCII vector set added; the slice's canonicalizer is ASCII-limited (AD-1 §3.7).

---

## 8. Known gaps

| # | Gap | Closed by |
|---|---|---|
| 1 | **The C-1 residual risk is open** (§3.4). §3.4 item 3's registry rule contains it; item 4's derivation change needs the owner | **AD4P2-Q1**; a future generator version |
| 2 | **AD4-Q5 — where the schema lives — is still Dev D's to decide** and stays open in AD-4 §11.2. AD-1 §3.7 (P-8) records the slice's location and check, and `check_event_contracts.py` now exists | Dev D |
| 3 | **AD4-Q7 — storage separation and the reviewer-reference format** — is open | **AD-11**, **AD-12** |
| 4 | **The canonicalizer is ASCII-limited** and cannot hash non-ASCII announcement text | §7.3, before the first announcement adapter |
| 5 | **Multi-source derivation is deferred beyond envelope v1** (**AD4-Q8**, owner-decided), so an FX cross or an inversion across two providers is rejected | A future AD-4 major version |
| 6 | **The distribution mechanism is unchosen**, so §6.1's hop 2 has no concrete behaviour and no durability | **AD-2**, **AD-3** |
| 7 | **No provider is approved**, so §7's three types have no source and every V-3 Gate 3 check has nothing to pass | **Gate 3**, per provider |
| 8 | **AD-6 B-4 is unresolved on the inference side.** D-25 waives it for the D-24 slice only; it is not Gate 4 evidence and no gate has passed | **AD-10** |

---

## 9. Questions for the project owner

| # | Question | Draft position | Decides |
|---|---|---|---|
| AD4P2-Q1 | Should a **future** synthetic generator version add `generator_version` and `case_id` to the `event_id` derivation, closing the C-1 residual risk? | Yes, in a new generator version only, with C-1's derivation untouched for existing events (§3.4) | Owner. It touches approved C-1 text, so it cannot be adopted without the decision |
| AD4P2-Q2 | Is the §3.4 item 3 registry rule — **one active generator configuration per `source_id`** — adopted now, as containment? | Yes. It is configuration only and needs no derivation change | Owner, with AD-5 §2.2 |
| AD4P2-Q3 | Is the §5.1 five-stage model, with **independent V-3 re-validation at every boundary**, adopted? | Yes. It is what AD-4 §3.1 and AD-1 §3.4 already do, named | Owner |
| AD4P2-Q4 | Is the §5.2 **monotonic restriction** — no component may ever upgrade a validation status — adopted as an invariant? | Yes | Owner |
| AD4P2-Q5 | Are the §5.3 **new rejection codes** (`OVERSIZE`, `EVENT_TYPE_NOT_PERMITTED`, `SUBJECT_NOT_PERMITTED`) added to the AD-4 catalogue, and does adding them require an AD-4 minor revision? | Add them. Whether the approved AD-4 file is revised, or they live here until AD-4's next version, is the owner's call | Owner; affects AD-4 v0.2's version-specific approval |
| AD4P2-Q6 | Is §6.4's deployment order — schema and vectors, Express, ingestion, web — adopted as the rule for a minor bump? | Yes: a strict boundary must accept a form before a producer emits it | Owner, with Dev B and Dev D |

---

## 10. Approval checklist

**None of these is given. This document is DRAFT v0.1 and has not been reviewed.**

- [ ] **Dev B** — review: §5.1 and §5.2 at the Express boundary; §6.2's strict-boundary obligations; §6.4's deployment order; §4.3's TypeScript parity obligations
- [ ] **Dev C** — review: §5.2's browser row; §6.2's consumer leniency and the unknown-major behaviour; §7.3's untrusted-text handling in the UI
- [ ] **Dev D** — review: §4.3's vector governance and CI coverage; §6.5's test obligations against `check_event_contracts.py`; **AD4-Q5**, which remains Dev D's
- [ ] **Second-reviewer rule (D-20)** — satisfied by any review above, since Dev A is both lead and approver
- [ ] **Project owner** — approval, with §9's questions decided

**AD-4 v0.2's approval is untouched by this document, whatever is decided here.** The D-24 slice continues on v0.2 (scope §2.2.3). On approval, the decision is recorded in `docs/PHASE3_SCOPE.md` §2, and milestones 3.3 to 3.6 gain the envelope rules they need beyond the slice. **No gate passes by this document, and no provider becomes approved.**
