# AD-5: Source Adapter Contract

**Status:** **DRAFT v0.7**, 26 November 2026. **Review state:** reviewed on PR #30 — **CHANGES_REQUESTED by Nisarga (26 Nov, on v0.1) and by Varshini, Dev C (26 Nov)** — and **NOT APPROVED**. The findings of both rounds are applied; **neither reviewer has re-reviewed**, and no owner approval exists. Nothing here authorizes a milestone, a provider, an adapter or a gate.
**Revision vv0.4, 26 November 2026 — still DRAFT, and not re-reviewed.** Applies **Anvesh's (Dev B's) CHANGES_REQUESTED re-review of PR #30** on commit `e457bcf`, together with the conditions in **Nisarga's** re-review that fall in the same sections. Both texts are on the pull request, not in the repository. Documentation only; it preserves every correction from **Varshini's** and Nisarga's earlier rounds, and changes no approved D-24 contract, schema, threshold, ownership or implementation. Cross-AD decisions stay **provisional**: AD-2 is itself a draft (PR #32), and nothing here approves it or is approved by it. Changes:

- **Blocker 1 (H3) fixed — new §8.2a:** validated provider **corrections** are separated from unexplained **value conflicts**, and corrections are **no longer implicitly restricted to announcements** — every event type may be corrected, including `fx_rate`. §6.3's and §8.1's announcement rows now say that "never superseded by recency" is an **ordering** statement only. Five pieces of **revision evidence** are required, including that an adapter sets `supersedes` **only** from something the provider published and **never infers a correction** from a value differing, plus V-4 `supersedes` validation (same source, same event type, or rejected). Aligned with **AD-2 R-5**'s "validated correction" row.
- **Blocker 2 (X-4) fixed — §8.3:** "Older: ignored" now reads **"not current"**, with "not current" explicitly **not** meaning "not stored". An ordinary late arrival is **retained historically** and never becomes current. A table maps all five **AD-2 R-5** cases onto this document and adopts AD-2's vocabulary, and the **late-tracking horizon** is distinguished from the **dedup window** — AD-2 proposes 24 h for the former; AD-5 sets neither.
- **Conflict-rule citation corrected** (Nisarga): §8.2 no longer claims its **C-a** is the same rule as AD-1 §3.4's row. A table records that AD-1's is keyed on **`event_id` inequality** and C-a on the **payload hash**, so two same-payload events with different `event_id`s are a conflict in the slice and a duplicate in the general rule. The slice keeps AD-1 §3.4 **as approved**; the divergence is the benign post-restart case AD-1 §3.4.1 records, and **AD5-Q11** leaves the choice open.
- **Identifier collisions:** AD-2 **R-8**'s classification of an overlapping-run collision as a **conflict, not a duplicate**, is adopted, with its operational rule — a shared-seed overlapping run is invalid as a **performance result**, while its conflicts are **still detected, rejected and counted**.
- New **AD5-Q10** (correction evidence) and **AD5-Q11** (the C-a keying divergence); new gaps **9a** and an extended gap 9.

**Revision v0.7, 26 November 2026 — still DRAFT, and not re-reviewed.** Documentation only. Applies **Anvesh's (Dev B's) CHANGES_REQUESTED re-review of PR #37** on commit `aeec98a` (its one remaining blocker, AD-5 §8.2b) and the architecture-consistency item of **Nisarga's** re-review of the same commit. Their texts are on that pull request, not in the repository. **No approved text, contract, schema, threshold or ownership changes, and the D-24 slice's behaviour is unchanged.** Changes:

- **§8.2b's identity comparison now includes `source_timestamp` and `synthetic.seed`**, both of which participate in the approved C-1 derivation. Under an equal `event_id`, a differing `source_timestamp` gave a **different `observation_key`** and so matched **neither** D nor C-a — the event would have been accepted while carrying an already-used identity — and a differing `synthetic.seed` shared **both** §8.1 keys exactly and would have been classified **D** and silently discarded. A short rule is stated behind the set: every field in the identity derivation and every field distinguishing the producer or the observed content is identity-bearing, and `sequence` is not compared directly because it is not an envelope field.
- **§8.2's stale rationale is removed.** v0.5 and v0.6 argued that an identity collision "necessarily" differs in payload or subject and therefore has a different `idempotency_key`. That stopped being true when v0.6 widened C-b, and it is replaced by the two concrete ways a collision escapes the §8.1 keys, together with the explicit requirement that **C-b is evaluated against an index keyed on `event_id` alone**. The separate AD4P2-Q1 reachability argument is retained only as a fact about the current derivations, which the order no longer depends on.
- **`instance_id`, `retrieved_at` and `emitted_at` remain excluded**, with AD-12 §3.2 cited: a restarted producer resending an event is an ordinary redelivery, not a collision.
- **A-11 is split (Nisarga 4):** **(a)** the ingestion-side negative registry and startup assertion, testable wherever an adapter exists, and **(b)** the **Unavailable** display for stored values, **deferred** to the milestone that builds the observation store (AD-11, C-5) and the panel behaviour (C-8). A milestone implementing only (a) must record (b) as outstanding rather than claim A-11.
- **AD5-Q8** is restated for the v0.7 field set and the `event_id`-keyed index. **AD5-Q11 is split into (a) which rule governs which path** — requested now, each path keeping its own rule — **and (b) the narrowing question, which remains a PENDING owner decision.** §8.2's "Which governs where" paragraph records (a) explicitly.
- **The C-1 residual risk is not closed** (§14 item 5). This is detection, not prevention.

**Revision v0.6, 26 November 2026 — still DRAFT, and not re-reviewed.** Documentation only. Applies **Anvesh's (Dev B's) CHANGES_REQUESTED review of PR #37** (finding 2) and the related points of **Varshini's** and **Nisarga's** reviews of the same pull request; their texts are on that pull request, not in the repository. Changes:

- **New §8.2b, and C-b's predicate widened.** C-b now fires on **differing event content** as §8.2b defines it — payload, subject, `source_id`, `event_type`, or the identity-bearing provenance `synthetic.case_id` and `synthetic.generator_version` — and explicitly **not** on `retrieved_at`, `emitted_at` or `instance_id`, which differ on every ordinary redelivery. v0.5's "different payload or subject" let a reused `event_id` with an unchanged payload hash and subject but a **changed generator configuration** fall through to **D** and be silently discarded as a duplicate, which is the **C-1 class of defect**. AD-1 §3.4's approved row is keyed on "different **content** or pair", so this aligns AD-5 with the approved rule. **AD-1 §3.4 and the D-24 slice are unchanged**, and the C-1 residual risk (§14 item 5) is **not** closed: this is detection, not prevention.
- §8.2's second bullet is corrected: C-b is possible wherever the derivation omits a distinguishing field, not only where it omits the payload hash.
- **AD5-Q8** is restated to cover §8.2b's field set, and §8.2b is **flagged for Dev B's confirmation** by owner direction: the collision fields against ordinary redelivery.
- **§9.3's text is unchanged**, but a scope note is added to it: it describes the mapping **where ingestion's status reaches a consumer**, and the D-24 slice has no such path — `GET /v1/latest` carries no status field and the published `source.status` is derived by Express's own poller (AD-1 §3.2) — so the mapping binds no D-24 behaviour.

**Revision v0.5, 26 November 2026 — still DRAFT, and not re-reviewed.** Documentation only. One correction, raised in the project owner's review of PR #36 and requested in `docs/PHASE3_33A_AUTHORIZATION.md` §4.2: **§8.2 now states the evaluation order of its three classes explicitly** — **C-b, then D, then C-a** — instead of "the first match wins" over a table ordered D, C-a, C-b. It changes **no** key, no outcome, no behaviour and no approved text: on every case reachable under the current derivations the outcome is identical, and the D-24 slice continues to run on AD-1 §3.4 as approved. What it removes is a dependence on an unstated reachability argument that **AD4P2-Q1 would invalidate**. **AD5-Q8** is restated to include the order, so one decision covers both.

**Revision v0.2, 26 November 2026 — still DRAFT.** Applies **Nisarga's CHANGES_REQUESTED review of PR #30**, submitted on v0.1 (`5f78500`); its text is on the pull request, not in the repository. Nothing in it approves this document, and no approved decision, contract, threshold, ownership or gate moves. Changes:

- **Blocker 3 fixed:** §8.1 now defines **two keys** — `observation_key` for conflicts and `idempotency_key` for duplicates — removing v0.1's unsatisfiable rule "the same key with a different `payload_sha256`", which cannot occur because the hash is inside the key. §8.2 replaces it with three outcomes: duplicate, value conflict (first kept) and identity collision (rejected). **No event identity changes:** C-1's approved derivation and AD-4 v0.2 are untouched.
- §8.3's equal-timestamp row now points at §8.2's conflict class instead of reading as a benign tie, matching AD-1 §3.4.
- **New §3.7:** the pending handoff, acknowledgement and replay semantics (**H-1 to H-6**), with what each answer obliges and what holds regardless.
- **New §8.4:** sources with a null `source_timestamp` — the four consequences, and the D-24 slice's differing approved rule.
- **New §8.5:** restart-safe deduplication — which transports are safe and why, what a restart loses, and the requirements it places on AD-8 and AD-3.
- §15 gains **AD5-Q7** (delivery semantics) and **AD5-Q8** (the three-outcome model); **AD5-Q1** and **AD5-Q4** are restated against the new sections.

**Revision v0.3, 26 November 2026 — still DRAFT, and not re-reviewed.** Applies **Varshini's (Dev C's) CHANGES_REQUESTED review of PR #30**, whose text is on the pull request, not in the repository. It preserves Nisarga's v0.2 corrections and changes no approved D-24 contract, schema, threshold or ownership: every finding was a **documentation** inaccuracy about the existing implementation, and the corrections describe that implementation rather than proposing a change to it. Unresolved architecture decisions stay **provisional**. Changes:

- **Finding 2 fixed — new §9.3:** `down` is **internal only**. The approved `stream-message.v1` schema enumerates `source.status` as exactly `starting`, `ok`, `outage`, and the deployed client validates `source` strictly, so a fourth value would **fault every open stream**. §9.3 maps the internal states onto the three published ones, keeps the distinction where it is actionable (metrics and the paged S-2 alert), and lists what publishing a distinct `down` would require — a protocol version change, a coordinated rollout, and AD-7 plus AD-9 decisions. It is **not proposed**. §9.1's inconsistent status list is corrected and §9.2 is relabelled as the **internal** machine.
- New **AD5-Q9** on the mapping; it is explicitly provisional until the owner decides.

**Lead:** Dev A. **Reviewers:** Dev B, Dev D (`docs/PHASE3_SCOPE.md` D-23). **Approver:** project owner. Dev A is also the approver, so the second-reviewer rule (D-20) applies: at least one of Dev B and Dev D reviews before the decision.
**Scope source:** `docs/PHASE3_SCOPE.md` v1.4 §3.A, §5 (Gate 3), §6, §7.1 (milestone 3.3), §7.3 (AD-5 row); F-2, F-4, F-5; D-5, D-17.
**Needs first:** F-2, F-4 and **AD-4** — satisfied for the envelope by AD-4 **v0.2**, approved for the D-24 slice only. This document additionally relies on the full-Phase-3 envelope rules drafted in `docs/PHASE3_AD4_ENVELOPE_PART2.md` (also DRAFT). Where the two disagree, AD-4 v0.2's approved text wins.
**Feeds:** AD-12; milestone 3.3. Values deliberately left unset here are set in **AD-8** (`docs/PHASE3_AD8_BUDGETS.md`).

Every statement cites the decision it rests on. Everything else is **[PROPOSED]** and needs the owner's approval. **No provider is approved, no provider data was used, and no provider may be contacted** — including for a recorded sample or a fixture — before that provider has passed **Gate 3** (D-5, D-17). This document changes no code, no schema, no Compose file and nothing in API contract v0.4.

---

## 1. Purpose and boundaries

AD-5 defines how a source of external observations is **onboarded, represented, driven, normalized and failed over**, so that milestone 3.3 can implement the adapter contract and one synthetic adapter before any gate passes (scope §6), and one Gate 3-approved provider afterwards.

**In scope:** the source registry and the onboarding workflow; the adapter interface and lifecycle; normalization; provenance obligations; transport semantics; error handling, backoff and circuit breaking; the idempotency key; duplicate, late and tie handling; source status, staleness and outage; plausibility bounds; the separation from routing; the adapter security posture; the testing obligations.

**Out of scope, and where it belongs:**

| Not here | Where |
|---|---|
| The envelope's fields, hashing, versioning and labels | AD-4 (v0.2 approved for D-24); `docs/PHASE3_AD4_ENVELOPE_PART2.md` for the rest |
| Numeric thresholds, intervals, latency budgets, clock tolerance | **AD-8** (D-12). AD-5 names each setting; AD-8 gives it a value |
| The mechanism that carries events away from ingestion | AD-2 (requirements), AD-3 (choice). AD-5 publishes through an abstract sink (§3.6) |
| The browser channel, message schemas and reconnect | AD-7; AD-1 component view §3.2, §3.3 for the D-24 slice |
| Secrets management, egress policy enforcement, identity | AD-10; milestone 3.2 |
| Storage, retention, the observation store, the audit trail | AD-11 |
| The seeded generator, fault injection, the quarantine review queue | AD-12 |
| Which providers are acceptable, licensed and appropriate | **Gate 3**, per provider, decided by the project owner (D-5, D-18) |
| Whether ScrapeGraphAI suits a site | Gate 3 per site; evaluated in milestone 3.6 (scope §10.1 item 2) |

**Hard boundaries, restated:**

- **No adapter output may reach the routing engine.** `usage` is `display_only` on every envelope (AD-4 §2; D-9, D-15), and AD-6's controls apply to every adapter, synthetic ones included (AD-6 §1).
- **No FX, news, economic or holiday source may be presented as bridge liquidity or congestion telemetry** (roadmap §4.A; scope §3.A hard boundary). No adapter may emit a bridge-state value, and no such event type exists (AD-4 §1).
- **No adapter is a compliance decision-maker.** Extracted text is data, never an instruction or a determination (roadmap §4.C; AD-6 §4).
- **Synthetic events are never used to train, tune or select a policy** (scope §6).

---

## 2. The source registry and approved-source onboarding

### 2.1 Why a registry

Validation needs a single authority for what a source *is*: its transport, its provenance class, its Gate 3 decision, its freshness profile and its plausibility bounds. AD-4 §3.1 already requires that the Gate 3 reference be **checked against the registry** rather than trusted as a string, and AD-4 §7 places the freshness profile in "the AD-5 registry". §2.2 defines that record.

**[PROPOSED]** The registry is **configuration, not code, and not user input**: a version-controlled file per environment, loaded at ingestion start, validated against a closed schema, and immutable at runtime. A registry that fails validation is a **startup failure**, never a partial load — the same rule the D-24 settings module already applies to its seed (`services/ingestion/cbdc_ingestion/settings.py`). An unregistered `source_id` is a rejection, not a new source (AD-4 §6).

### 2.2 The registry record

**[PROPOSED]** One record per source. `source_id` is stable for the life of the project and is never reused.

| Field | Meaning | Constraint |
|---|---|---|
| `source_id` | Stable identifier, also carried in the envelope | Lower-case dotted; a `synthetic.` prefix **if and only if** the class is `synthetic` (AD-4 §3.2) |
| `display_name` | What a user sees as the source | Shown with every value (AD-4 §8.1) |
| `provider_id` | The commercial or institutional provider, or null for synthetic and manual | A provider may own several sources |
| `event_types` | The AD-4 types this source may emit | A source emitting an unlisted type is rejected |
| `subjects` | The allowlist of subjects (§6.3) this source may emit, or `open` | The D-24 slice uses a four-pair allowlist (AD-1 §3.4) |
| `transport` | `websocket`, `poll`, `scheduled`, `manual` or `synthetic` | Exactly one. The envelope's transport must equal it (AD-4 §6) |
| `provenance_class` | `real`, `derived`, `synthetic` or `assumed` | Must satisfy AD-4 §3's transport pairing |
| `endpoint` | The base URL, or null | HTTPS for every `real` source; no credential, query or fragment (AD-4 §2) |
| `egress_allowlist` | The hosts this adapter may contact | Enforced outside the process too (§12.2) |
| `credential_ref` | A name resolved by the secrets mechanism, never a secret | Null unless the provider requires authentication (AD-10) |
| `gate3_decision_ref` | The recorded Gate 3 decision | **Required and `active` for every `real` and `derived` source**; null for `synthetic` and `assumed` |
| `freshness_profile` | The AD-4 §7 profile | Values from AD-8; `live_max_age_ms` may be null (never live) |
| `plausibility` | The §10 bounds | Per event type and subject |
| `rate_limits` | Documented provider limits, and the self-imposed ceiling | §7.4 |
| `schedule` | Poll interval or cron expression | Required for `poll` and `scheduled`, null otherwise |
| `timestamp_basis` | `observed`, `published` or `none` | Must equal what the adapter emits (AD-4 §5) |
| `retention_policy_ref` | The storage and retention terms permitted for this source | AD-11; a Gate 3 input |
| `redistribution` | Whether values may be shown to pilot users, and to whom | A Gate 3 term, enforced at display |
| `status` | `proposed`, `active`, `suspended` or `withdrawn` | §2.4 |

### 2.3 Onboarding workflow

**[PROPOSED]** Six stages. Nothing after O-2 may touch the provider until the owner has decided Gate 3.

| # | Stage | What happens | Who | Permitted before Gate 3 |
|---|---|---|---|---|
| **O-1** | Candidate identified | A source category and a candidate provider are named. FX is the first category (F-4). | Dev A | Yes |
| **O-2** | Desk evaluation | **From published documentation only:** interface type (genuine streaming or polled), documented rate limits, cost, reliability and outage history, retention and redistribution terms, licence and terms of use. No request is sent to the provider. | Dev A | Yes |
| **O-3** | Gate 3 submission | The §2.5 evidence pack is assembled and submitted. | Dev A | Yes |
| **O-4** | **Gate 3 decision** | The project owner approves, conditions or refuses, after technical review by **Dev A and Dev B** (scope §5). The decision is recorded in writing with its evidence and any waiver (exit criterion 10). | Project owner | — |
| **O-5** | Registry activation | The record is added with `status: active` and the decision reference. The adapter's egress allowlist and credential reference are provisioned (AD-10). | Dev A, Dev D | **No** |
| **O-6** | Live integration | First contact with the provider; the adapter runs against it; milestone 3.3-L evidence is gathered. | Dev A | **No** |

**O-2 is a documentation exercise, by rule.** A connectivity test, a trial key, a sample download, a fixture captured from the provider and a recorded response are all **ingestion** and all need Gate 3 first (D-17). Event-rate estimates for AD-2 come from published documentation or synthetic load, never from recorded provider samples (3.1 plan §5).

**Adapter development does not wait.** The adapter contract, the synthetic adapter and the whole fault-handling path may be built and tested before any gate passes (D-7, scope §6), against the AD-12 harness and the §13 fault catalogue. What waits is only the first byte from the provider.

### 2.4 Status transitions, suspension and withdrawal

**[PROPOSED]**

| From to | Trigger | Effect |
|---|---|---|
| `proposed` to `active` | Gate 3 approval (O-5) | The adapter may start |
| `active` to `suspended` | An operational decision: a breach of rate limits, a cost event, an unresolved data-quality fault, or a provider request | The adapter stops. Stored events keep their provenance and their Gate 3 reference. Values stop being displayed as soon as the registry reloads |
| `active` to `withdrawn` | Gate 3 withdrawn, the licence lapses, or the terms change | As above, and **every value of that source displays Unavailable**, by AD-4 §8.1 rule 2, which already withdraws a `real` or `derived` value whose Gate 3 approval is absent or withdrawn |
| `suspended` to `active` | The operational cause is resolved; no new Gate 3 decision is needed if the decision itself still stands | The adapter may start |
| `withdrawn` to `active` | **Not permitted.** A new Gate 3 decision and a new record | — |

A suspension or withdrawal **never deletes history and never relabels a stored event.** What a source said at the time it said it is a fact about the past; what may be *shown* is a current question, answered by AD-4 §8.1 against the live registry. Deletion obligations arising from a provider's terms belong to AD-11 and are a Gate 3 input.

### 2.5 Gate 3 evidence pack (adapter half)

**[PROPOSED]** AD-13 owns the template; these are the fields AD-5 contributes, per provider, all from O-2:

1. the interface: genuine streaming, polled or scheduled — **stated as it is**, never as a feed it is not (roadmap §4.A: *do not pretend a polled source is a WebSocket feed*);
2. documented rate limits, quotas and cost, and the self-imposed ceiling the adapter will apply (§7.4);
3. the licence or terms, quoted by reference, covering **this** use: ingestion, storage, retention and display to named pilot users;
4. retention and redistribution limits, mapped to `retention_policy_ref` and `redistribution`;
5. reliability and published outage history;
6. the proposed registry record in full (§2.2), including the freshness profile and plausibility bounds;
7. the authentication method and the credential handling (AD-10), with **no credential in the pack**;
8. a statement that the source carries **no bridge liquidity or congestion telemetry** and will not be presented as such.

---

## 3. The adapter interface

### 3.1 What an adapter is

**[PROPOSED]** An adapter is a component inside the ingestion service (F-2) that turns one registered source into a stream of **valid AD-4 envelopes, or into recorded failures**, and does nothing else. One adapter instance serves exactly one `source_id`.

The ingestion service owns everything an adapter must not re-implement: envelope construction, canonical hashing, schema validation, the clock, the sink, backoff timing, metrics and logging. An adapter that constructs its own envelope or its own hash is a defect, because two implementations of AD-4 would eventually disagree.

### 3.2 Required operations

**[PROPOSED]** Transport-independent, named here in the abstract; the Python signatures are milestone 3.3's.

| Operation | Contract |
|---|---|
| `describe()` | Returns the adapter's static capabilities: the transports it supports, the event types and subjects it can emit, and the registry fields it requires. Checked against the registry record at start; a mismatch is a **startup failure**, not a warning |
| `start(context)` | Acquires what the transport needs. `context` provides the injected clock, the sink, the credential resolver, the metrics recorder and a cancellation signal. **Never** a database handle, an inference client or a filesystem writer (§11) |
| `poll()` *or* `subscribe()` | Exactly one, matching the transport. `poll()` returns zero or more raw items for one invocation. `subscribe()` yields raw items until cancelled |
| `normalize(raw)` | Maps one raw item to a **normalized observation**: event type, subject, payload fields as decimal strings and codes, the source timestamp and its basis, the provider sequence if any, and the raw bytes if they may be kept. It performs **no** hashing, no envelope assembly and no I/O |
| `health()` | The adapter's own view: connected, degraded or down, with a reason code from §7.1. Advisory; the authoritative source status is the service's (§9) |
| `stop()` | Releases everything, idempotently, within the AD-8 shutdown budget. It must be safe to call from any state, including mid-`start` |

**Unidirectional by rule.** An adapter has no method that accepts an observation, a routing request, a routing result, a user identity or a form value. There is nothing to call downstream; the only output is the sink.

### 3.3 Lifecycle

```text
            registry record (active)
                     |
                     v
   created --> starting --> running <----> degraded
                  |            |             |
                  |            v             v
                  +-------> stopping --> stopped --> (restart, with backoff)
                                            ^
                     failed_permanent ------+   (no automatic restart)
```

**[PROPOSED]**

| State | Meaning | Automatic transition out |
|---|---|---|
| `created` | Constructed, nothing acquired | On `start` |
| `starting` | Acquiring the transport; the first item not yet seen | To `running` on the first successful item or subscription; to `degraded` on a recoverable fault; to `failed_permanent` on a permanent one |
| `running` | Producing items within its expected cadence | To `degraded` on the §9 outage criteria |
| `degraded` | Reachable but failing, or silent past its expected interval | Back to `running` after one successful item; stays `degraded` while retrying |
| `stopping`, `stopped` | Shutdown or suspension | — |
| `failed_permanent` | Authentication failure, authorization failure, a protocol or contract violation, a withdrawn Gate 3 decision, or a registry mismatch | **None.** It needs an operator action, by the same reasoning as AD-1 §3.3.2's permanent client states |

**Recoverable and permanent are distinguished, not merged.** Retrying a 401 forever burns a provider's rate limit and hides a real configuration fault; retrying a 503 is correct. §7.1 classifies every fault.

### 3.4 What the service does around an adapter

**[PROPOSED]** For each normalized observation, in this order:

1. **Assemble** the AD-4 envelope: `event_id` (§5), `usage: display_only`, the registry's source block and provenance class, the timestamps (`retrieved_at` from the injected clock at receipt, `emitted_at` at assembly), the payload, and the synthetic block for a synthetic source.
2. **Canonicalize and hash** `{"event_type", "payload"}` to `payload_sha256` under the RFC 8785 profile; set `raw_sha256` only where the registry permits keeping the bytes.
3. **Validate** against the envelope schema and then the semantic rules (AD-4 §6; `docs/PHASE3_AD4_ENVELOPE_PART2.md` §4). The outcome is `validated`, `quarantined` or **rejected**.
4. **Deduplicate** on the idempotency key (§8).
5. **Publish** the validated envelope, and a quarantined one on the quarantine path only (§3.6).
6. **Record** counters, and a rate-limited log line carrying the reason and, where the envelope is well formed, the `event_id` — never a payload (AD-1 §3.4).

Steps 1 to 3 are the service's, not the adapter's, in every transport. The D-24 implementation already follows this split: the generator produces values, and `envelope.py`, `canonical.py` and `validation.py` do the rest.

### 3.5 Clock discipline

**[PROPOSED]** An adapter never reads a wall clock. The clock is injected (`services/ingestion/cbdc_ingestion/clock.py` is the existing precedent), so that replay is deterministic and a test can move time.

- `source_timestamp` comes **only** from the provider, and is null when the provider gives none — **never filled from a local clock** (AD-4 §5). `source_timestamp_basis` is `none` exactly then.
- A date-only value gets no invented time (AD-4 §5).
- `retrieved_at` is at or before `emitted_at`, enforced by validation.
- Clock skew against a provider is handled by the AD-8 tolerance, as a **quarantine** reason (`FUTURE_SOURCE_TIMESTAMP`), not by adjusting the timestamp. Rewriting a provider's timestamp would destroy the evidence that the clocks disagree.

### 3.6 The sink

**[PROPOSED]** Adapters publish to an abstract sink with three channels, so that AD-3's mechanism choice changes no adapter:

| Channel | Carries | Consumers |
|---|---|---|
| `observations` | `validated` envelopes | Distribution, then Express, then the browser; the observation store (AD-11) |
| `quarantine` | `quarantined` envelopes with their reasons | The quarantine store and review queue (AD-12, Gate 2 for any knowledge write) |
| `faults` | Rejections and transport faults, as counters plus a bounded log record | Monitoring (AD-8 §7); the audit trail where AD-11 requires it |

The D-24 slice implements the first channel as an in-memory latest-per-pair store served over HTTP (AD-1 §3.1), with no durability and no replay. **That is the slice's choice, not AD-5's**: the sink is where AD-3's mechanism attaches, and the poll it replaces is named as such in AD-1 §4. The delivery semantics the sink does **not** fix are open, and are enumerated in §3.7.

### 3.7 Handoff, acknowledgement and replay: PENDING

**[PROPOSED, and deliberately unresolved here.]** The sink (§3.6) hides the mechanism, but it cannot hide the **delivery semantics**, which change what the rest of AD-5 has to guarantee. **AD-2 states the requirements and AD-3 chooses the mechanism**; neither is written. AD-5 therefore records what is open, and what each answer would oblige, so that the question is decided rather than defaulted by whatever the first implementation happens to do.

| # | Open question | What each answer obliges |
|---|---|---|
| **H-1** | **At-least-once, at-most-once, or effectively-once?** | At-least-once makes **restart-safe deduplication load-bearing** (§8.5) and requires every consumer to be idempotent. At-most-once permits loss, which must then be **counted and displayed**, not silent. Effectively-once needs deduplication at the consumer as well as the producer |
| **H-2** | **Where is the handoff point** — when does ingestion consider an event delivered? | If it is acceptance by the mechanism, ingestion may drop an event the mechanism later loses. If it is a durable write, ingestion must block or buffer, which puts a bound on the AD-8 §3.2 T2-to-T3 segment |
| **H-3** | **Is an acknowledgement required, and from whom?** | A consumer acknowledgement implies per-consumer progress tracking, which the current one-consumer design does not have. No acknowledgement implies a fire-and-forget sink, so an outage of Express loses whatever was in flight |
| **H-4** | **What may be replayed, over what window?** | A replay window implies retention and ordering guarantees in the mechanism (AD-11 for storage). **Replay must preserve the original timestamps**, so that an old event cannot look fresh (AD-4 §5) |
| **H-5** | **What happens when a consumer is slow?** | Back-pressure onto ingestion, buffering, or dropping. Each has a different failure mode, and only the first can slow a provider adapter |
| **H-6** | **Are these semantics per channel?** | `observations`, `quarantine` and `faults` (§3.6) have different tolerances: losing a fault counter is an observability gap, losing a quarantined item loses a review obligation |

**What holds regardless of the answer**, so that AD-5 is implementable now:

- **Delivery semantics never reach the engine.** Whatever H-1 to H-6 decide, no observation crosses into the routing path (§11; AD-6 §1), and an outage of any channel never blocks simulation-based routing (**AD6-Q2**).
- **Replay is not a refresh.** A replayed event keeps all its original timestamps, so freshness and the display label are computed from the observation's own time, never from its redelivery (AD-4 §5, §7).
- **Loss is never silent.** Whatever is lost is counted and visible in monitoring (AD-8 §7), and a value whose updates stop simply ages into `stale` and then `unavailable` — which is the correct user-facing outcome and needs no delivery guarantee to be true.
- **Adapters are unaffected.** They publish to the sink and never observe a consumer, so no H-answer changes §3.2's operations.

**What the D-24 slice does today, which is not a decision:** Express **polls** `GET /v1/latest` for the latest validated envelope per pair, held **in memory** (AD-1 §3.1). That is **at-most-once with no durability, no acknowledgement and no replay** — AD-1 §3 states it plainly for the slice: "No broker, durability or replay; a restart may lose state." It is sound for a four-pair panel displaying only current values, and it is **explicitly not** a template: AD-1 §4 records that the distribution mechanism "replaces the poll".
---

## 4. Normalization

**[PROPOSED]** Normalization is **format work only**. It changes representation, never meaning, and it is the boundary AD-4 §3 means by "a value as published by an approved provider, after the format normalization of §4 only".

| Concern | Rule |
|---|---|
| **Numbers** | Decimal strings, as AD-4 §4 requires. The provider's digits are preserved exactly: no rounding, no reformatting, no float round-trip. A trailing zero is significant to the hash, so it is kept as received |
| **Currency and country codes** | ISO 4217 and ISO 3166-1 alpha-3, upper case. A provider's own symbol is mapped through an explicit, version-controlled mapping table in the registry entry — never by string surgery, and never by guessing |
| **FX direction** | Units of quote per one unit of base (AD-4 §4). A provider quoting the inverse is **not** silently flipped: inversion is a derivation, so the result is `derived` with `derived_from` set, or the registry declares the provider's native direction and the adapter emits it as published |
| **Units** | `economic_indicator.unit` records the provider's unit. No unit conversion in v1; a converted value is `derived` |
| **Periods and dates** | `economic_indicator.period` as the source states it. A `bank_holiday.date` is a local calendar date with no time-zone conversion (AD-4 §4) |
| **Text** | `announcement` title and summary are **untrusted plain text**: stored escaped, never rendered as HTML, never executed, never used as an instruction to a model (AD-4 §4) |
| **Whitespace and case** | Trimmed only where the field is a code. Free text is preserved as received, so that `raw_sha256` and the stored text correspond |
| **Missing fields** | A required field the provider omits is a **rejection**, not a default. A defaulted observation is an invented one |
| **Subject identity** | Derived from the payload, never from the provider's own key (§6.3) |

**Two rules worth stating because they look like helpfulness.** An adapter must not fill a gap in a series by interpolation, and must not carry a previous value forward as a new observation. Both would manufacture observations that no source made, and freshness (AD-4 §7) is precisely the mechanism for telling the user that a value is old.

---

## 5. Event identity

**[PROPOSED]** `event_id` is assigned by the ingestion component and a redelivery keeps it (AD-4 §2). AD-5 fixes **how** it is assigned per transport; the full derivation rules, the generalization of correction C-1 and its unresolved residual risk are drafted in `docs/PHASE3_AD4_ENVELOPE_PART2.md` §3, which this section defers to.

| Transport | Derivation |
|---|---|
| `synthetic` | Deterministic, so replay reproduces it. For the D-24 generator: `UUIDv5(seed, pair, sequence, source_timestamp)`, the derivation **approved as correction C-1** (AD-1 §3.4.1). It is unchanged by this document |
| `websocket`, `poll`, `scheduled` | Deterministic from the observation's identity: `UUIDv5` over `source_id`, `event_type`, subject, `source_timestamp` and `payload_sha256`. A redelivery of the same observation therefore yields the same `event_id` without any stored state, which is what makes a restart safe |
| `manual` | Random UUIDv4 at entry. A typed value has no reproducible identity, and two identical entries are two distinct acts |

**Identity is not the idempotency key.** They coincide for the deterministic transports and differ for `manual`; §8 defines the key, and AD-4 §2 leaves it to this document.

---

## 6. Transports

### 6.1 Semantics

**[PROPOSED]** `source.transport` records **how the value was actually obtained** (AD-4 §2), and a polled source is never `websocket`.

| Transport | When it applies | Cadence | Notes |
|---|---|---|---|
| `websocket` | The provider offers a genuine streaming interface and the adapter is subscribed to it | Provider-driven | Only where a selected provider actually offers it (roadmap §4.A). A long-poll or a server-push emulation is `poll` |
| `poll` | The adapter requests on its own schedule | `schedule`, bounded by the §7.4 ceiling | The display shows "polled" in words (AD-4 §8.1) |
| `scheduled` | A low-frequency fetch at defined times — a daily reference rate, a holiday calendar | `schedule` as a cron expression | Usually `live_max_age_ms: null`: never live |
| `manual` | A person enters a value | None | §6.2 |
| `synthetic` | The AD-12 generator | Generator-defined | Four markers must agree (AD-4 §3.2) |

### 6.2 Manual entry is still ingestion

**[APPROVED]** (AD-4 §3.1; D-5, D-17) A provider's value typed in by hand is `real` with transport `manual`, and needs that provider's Gate 3 approval. Calling it `assumed` to avoid the gate is not permitted. `assumed` is for a value **stated by a person**, not taken from a provider.

**[PROPOSED]** The manual adapter therefore requires, per entry: the entering user's identity (AD-10), the `source_id` of the provider the value came from with its active Gate 3 reference, the provider's own timestamp if the person has it — and `source_timestamp: null` with basis `none` if not — and the class, `real` or `assumed`, chosen explicitly rather than defaulted. `retrieved_at` is the time of entry (AD-4 §5).

### 6.3 Subjects

**[PROPOSED]** A **subject** is what an observation is about, and it is what "the current value" is current *for* (AD-4 §5). It is derived from the payload, so a subject and its payload cannot disagree — the reasoning behind correction C-1.

| Event type | Subject |
|---|---|
| `fx_rate` | `base_currency`, `quote_currency`, `rate_type` |
| `economic_indicator` | `indicator_code`, `country`, `period` |
| `bank_holiday` | `country`, `date` |
| `announcement` | **None.** An announcement is an event, not a value with a current state, so it is never superseded **by recency**. This is an **ordering** statement only: like every type, an announcement may be **corrected** by a new event carrying `supersedes` (§8.2a) |

A source's `subjects` allowlist bounds the state an adapter can create, which bounds memory and the display. The D-24 slice's four-pair allowlist is this mechanism (AD-1 §3.4).

---

## 7. Error handling

### 7.1 Fault taxonomy

**[PROPOSED]** Every fault is classified, because the classification decides the retry.

| Class | Examples | Retry | Source status |
|---|---|---|---|
| `transient_network` | DNS failure, connection reset, TLS handshake timeout, read timeout | Backoff (§7.2) | To `degraded` after the §9 criteria |
| `provider_unavailable` | 500, 502, 503, 504; a stream closed by the provider | Backoff; honour `Retry-After` | To `degraded` |
| `rate_limited` | 429, or a documented quota exceeded | Honour `Retry-After`, bounded by §7.4 | To `degraded`; never a tighter spin |
| `auth_failure` | 401, 403, an expired or revoked credential | **None.** To `failed_permanent` | To `down`, and an alert (AD-8 §7) |
| `contract_violation` | An unexpected content type, an unparsable body, a schema the adapter cannot map, a redirect where none is allowed | **None** for the adapter, to `failed_permanent`; the **item** is a rejection | To `down` |
| `item_invalid` | One item fails AD-4 validation | None; the item is **rejected** and counted. Other items in the same response are unaffected | Unchanged |
| `item_implausible` | One item fails a §10 bound | None; the item is **quarantined** | Unchanged |
| `internal` | A defect in the adapter or the service | Restart with backoff; alert | To `degraded` |

**One bad item does not discard a good response, and one bad response does not discard a good item.** AD-1 §3.1 already draws this line for the D-24 poll — "200, some events invalid: rejects those events only; successful poll" — and §7.3 states when the whole response goes instead.

### 7.2 Backoff

**[PROPOSED]** Exponential with full jitter: attempt *n* waits a random value in the interval from 0 to the smaller of `base` times 2 to the power *n*-1 and the `ceiling`. `base` and `ceiling` are AD-8's, per transport. The counter resets after one successful item, not merely after a successful connection — a connection that opens and immediately closes is not progress.

- A server-supplied `Retry-After` **overrides** the computed wait, clamped to the AD-8 bounds. The D-24 slice's clamp of 1 to 30 s (AD-1 §3.1) is the slice's instance of this rule.
- Jitter is required, not optional: several adapters that restart together must not synchronize onto one provider.
- `failed_permanent` has no backoff, because it has no retry.

### 7.3 Whole-response rejection

**[PROPOSED]** The entire response is discarded, and the poll counts as failed, when it cannot be trusted as a whole: a wrong content type; a body that is not parsable; a body over the AD-8 size limit, **checked while reading** rather than after; an unknown payload protocol version; a redirect; more items than the subject allowlist permits; or two items for the same subject in one response. AD-1 §3.1 is the D-24 instance of this table.

### 7.4 Rate limits and the circuit breaker

**[PROPOSED]**

- The adapter applies a **self-imposed ceiling** strictly below the provider's documented limit, from the registry. The provider's limit is a cliff, not a target.
- A **circuit breaker** per source: after the AD-8 failure threshold within the AD-8 window, the adapter stops requesting for the AD-8 cooldown, then admits one probe. The breaker is per `source_id`, never global, so one provider's outage cannot silence another.
- The breaker's state is a metric and is visible in the source status (§9); it is **not** an HTTP status passed to the browser (AD-1 §3.1).
- A `rate_limited` fault never shortens the next wait, and a retry storm is itself an alertable condition (AD-8 §7).

### 7.5 What is never done on a fault

- **No fabricated observation.** No last-value-carried-forward, no interpolation, no synthetic substitute presented as the source's. Degradation is a **display** concern: the value ages, becomes stale, then Unavailable (AD-4 §7, §8), and AD-9 specifies what is shown.
- **No routing effect.** An outage never blocks simulation-based routing (**AD6-Q2**, owner-decided), and a failed observation changes only the observation panel (AD-6 §6).
- **No silent degradation.** Every fault increments a counter and is visible in monitoring. The C-1 defect is the precedent: a conflict that failed silently in a counter, for a whole run (AD-1 §3.4.1).
- **No payload in a log line.** Reason code, `source_id` and, where well formed, `event_id` (AD-1 §3.4).

---

## 8. Idempotency, duplicates, late events and ties

### 8.1 Two keys, because one key cannot answer both questions

**[PROPOSED]** Scope §3.B proposes a key of (`source_id`, `source_timestamp`, `payload_hash`) and leaves the decision to AD-5. A single key of that shape cannot serve both of the questions deduplication has to answer, so **AD-5 defines two keys over the same fields**:

```text
observation_key  = (source_id, event_type, subject, source_timestamp)
idempotency_key  = (observation_key, payload_sha256)
```

| Key | Answers | Used for |
|---|---|---|
| `observation_key` | "Which observation is this, of what, at what time?" | Detecting a **conflict**: the source said two different things about one subject at one instant |
| `idempotency_key` | "Have I already seen exactly this event?" | Detecting a **duplicate**: discard it |

**Why two.** `payload_sha256` is inside the idempotency key, so two events with different payload hashes have **different** idempotency keys **by construction**. A rule phrased as "the same idempotency key with a different payload hash" is therefore unsatisfiable, and the case it was meant to catch — one subject, one instant, two different values — is a difference in the **payload**, not in the key. It is caught by the `observation_key`, which deliberately excludes the hash.

`event_type` and `subject` are in both keys, because the scope's three-part form cannot distinguish subjects of one source: two FX pairs published at the same instant by the same provider share `source_id` and `source_timestamp`, and differ only in a payload whose hash the key already carries — so the three-part key separates them only through the hash, and cannot answer the first question at all. The same reasoning fixed correction C-1, where the pair was missing from the event name (AD-1 §3.4.1).

**Neither key is an event name.** They are lookup structures inside the deduplication state. **The approved `event_id` derivations are unchanged** — C-1's `UUIDv5(seed, pair, sequence, source_timestamp)` for the D-24 generator, and `docs/PHASE3_AD4_ENVELOPE_PART2.md` §3.2's derivations for the other transports. Nothing in §8 renames an event, changes a hash or alters what the D-24 slice computes.

| Case | Handling |
|---|---|
| `source_timestamp` is null | Both keys use `retrieved_at` in its place, and the source is **not restart-safe**: it is marked `dedup: within_run` (§8.4, §8.5) |
| `manual` | Not deduplicated. Two identical entries are two acts (§5) |
| `announcement` | Deduplicated on the `idempotency_key`, but **never superseded by recency**: an announcement has no subject (§6.3), so a newer one does not replace an older one. A **declared correction** still applies, through `supersedes` (§8.2a) |

### 8.2 Duplicates and conflicts

**[PROPOSED]** Three outcomes, distinguished by which key matches. The behaviour of each is AD-1 §3.4's, unchanged.

**Evaluation order (corrected in v0.5).** The classes are evaluated **C-b, then D, then C-a** — identity collision **before** duplicate and before value conflict.  v0.4 said only "the first match wins" with the table ordered D, C-a, C-b, which read as the opposite order.

**Why the order is a requirement and not a convenience (corrected in v0.7).** v0.5 and v0.6 justified the order with the claim that "a genuine identity collision differs in payload or subject and therefore has a different `idempotency_key`", so D could not pre-empt C-b in any case. **That rationale was already false once §8.2b widened C-b, and it is removed.** With §8.2b's field set, an identity collision can land in either of two ways that the two keys of §8.1 do not catch:

- **It may share the `idempotency_key` exactly.** Two events differing only in `synthetic.case_id`, `synthetic.generator_version` or `synthetic.seed` have an identical `source_id`, `event_type`, subject, `source_timestamp` and `payload_sha256`, so **both keys are equal**. Without C-b evaluated first on the `event_id`, such an event is classified **D** and **silently discarded** — the C-1 defect.
- **It may match neither key.** Two events sharing an `event_id` but differing in `source_timestamp` have a **different `observation_key`**, hence a different `idempotency_key`, so they match **neither D nor C-a** and would be accepted as a new observation while carrying an already-used identity. `source_timestamp` is in the C-1 derivation, so equal `event_id` with unequal `source_timestamp` is possible only through a collision.

**Therefore C-b requires its own lookup.** C-b is evaluated against an index keyed on **`event_id` alone**, not on either key of §8.1, and it is evaluated **first**. Evaluating it first makes the outcome a rule: a collision is **rejected** (AD-2 **R-8**, §8.2's closing paragraph), where C-a would merely keep the first and count a conflict, and D would discard it unseen. Nothing in the D-24 slice's behaviour changes — it runs on AD-1 §3.4 as approved (see the mapping table below), which is itself keyed on `event_id`, and on the reachable C-1 class (differing pairs, the recorded 40 conflicts) C-b fires under either order.

**A separate reachability argument also lapses.** For the synthetic transport `event_id = f(seed, pair, sequence, source_timestamp)` while the payload is `f(seed, pair, sequence)`, so today an equal `event_id` at an equal pair and timestamp forces an equal payload and the C-a overlap case is unreachable. **That argument stops holding if AD4P2-Q1 changes the derivation.** It is recorded here as a fact about the current derivations, and the order does not depend on it.

| # | Condition | Outcome | Behaviour |
|---|---|---|---|
| **D** | Same `idempotency_key` as an event already seen | **Duplicate** | **Discarded**, not rejected and not quarantined (AD-4 §6), and counted. Normal and expected for a polled source: AD-1 §3.4 counts it as "duplicate (normal for polling): ignored, no update" |
| **C-a** | Same `observation_key`, **different** `payload_sha256`, and **no** validated `supersedes` (§8.2a) | **Value conflict** | The **first is kept**; the later event is counted as a conflict and does not become current |
| **C-b** | Same `event_id`, **differing event content** as §8.2b defines it | **Identity collision** | **Rejected**, counted; the first is kept (AD-1 §3.4). This is the **C-1 class of defect** |

- **C-a is a statement about the source.** Two different values for one subject at one instant means the provider contradicted itself, the adapter mis-normalized, or two configurations are writing to one `source_id`. None of them is resolvable by picking a value, so the first is kept and the disagreement is counted rather than hidden.
- **C-b is a statement about us.** It means two distinct observations were given one name, which is a derivation defect, not a data fault. It is possible wherever the derivation omits a field that distinguishes two observations — **the payload hash**, and also the **identity-bearing provenance** of §8.2b. That is the synthetic transport, whose derivation is fixed by C-1 and includes neither the payload hash nor `case_id` or `generator_version`. For the provider transports the hash is in the name (AD-4 Part 2 §3.2), so a differing payload yields a differing `event_id`; such a transport can still collide only through the provenance fields of §8.2b.
- **Both conflict classes must be alertable** (AD-8 §7.3 **Q-2**), because C-1 showed a conflict loop can stall a subject for an entire run while showing only as a counter.

**How these classes relate to AD-1 §3.4's approved rows — similar, not identical.** AD-1 §3.4 is **approved for the D-24 slice** and is **unchanged**; §8.2 is the full-Phase-3 generalization, and the two are keyed differently, so the correspondence is partial:

| AD-1 §3.4 row (approved, slice) | Keyed on | Nearest §8.2 class | Where they differ |
|---|---|---|---|
| "Same `event_id` as a current event, different content or pair — conflict: rejected, counted; first kept" | `event_id` | **C-b** identity collision | None of substance: both reject and keep the first |
| "Same `source_timestamp`, different `event_id` — conflict: first kept; counted" | `event_id` **inequality** at an equal timestamp | **C-a** value conflict | **The keys differ.** AD-1's row fires whenever the `event_id`s differ, *whatever the payloads are*; C-a fires only when the **payload hashes** differ. Two events with the same payload and different `event_id`s are AD-1's **conflict** in the slice and §8.2's **duplicate** in the general rule, because their `idempotency_key`s are equal |
| "Same `event_id`, identical content — duplicate: ignored, no update" | `event_id` | **D** duplicate | None of substance |

**Which governs where.** The slice runs on **AD-1 §3.4 as approved**; §8.2 governs adapters AD-5 introduces. The divergent cell is reachable in the slice only through a generator restart that realigns a pair's timestamp at a different sequence — the case AD-1 §3.4.1 records as "**not a defect, for the record**", where one post-restart event per pair is dropped and the next is accepted. **Nothing here changes that behaviour or that approval.**

**The per-path split is the requested resolution of AD5-Q11(a)** (§15; requested in `docs/PHASE3_33A_AUTHORIZATION.md` §4.6), stated so that an implementation is unambiguous:

| Path | Governing rule |
|---|---|
| The existing D-24 generator path (the default) | **AD-1 §3.4 exactly as approved**, keyed on `event_id` inequality. Unchanged: no reclassification, no new counter, no behaviour change |
| An adapter path, when a registry record selects it | **§8.2**, with §8.2b's predicate and the C-b → D → C-a order over an `event_id`-keyed index |

**AD5-Q11(b)** — whether the general rule should be narrowed to match the slice, or the slice's rule widened at its next revision — **remains a PENDING owner decision** and is **not decided here**.

**Identifier collisions from overlapping synthetic runs.** AD-2's **R-8** classifies the second arrival of a C-1-style collision as a **conflict, rejected and counted — not a duplicate**, which agrees with **C-b**. AD-2 adds an operational rule this document adopts: until AD-5 and AD-12 resolve the residual risk, **load and fault runs must not overlap with a shared seed**, and a run that does is **invalid as a performance result** and may be excluded from throughput and latency figures — but its conflicts are **still detected, rejected, counted and recorded** exactly as in any other run. **Exclusion applies to the result, never to conflict detection.**
- **The C-1 residual risk lives in C-b** and is **open**: overlapping generator runs with the same seed and timestamps but a different `case_id` or `generator_version` produced 40 collisions. §14 item 5 and AD-4 Part 2 §3.4 track it.

The dedup window is bounded, not unbounded: the AD-8 `dedup_window` per source, long enough to cover a redelivery and a restart (§8.5), short enough to bound memory. A duplicate arriving after the window is handled by §8.3's ordering rule, which is safe — it is older, so it does not become current and is counted as late (§8.3).

### 8.2b What "differing event content" means for C-b

**[PROPOSED in v0.6. FLAGGED FOR DEV B'S CONFIRMATION, by the project owner's direction of 26 November 2026 (relayed, not quoted), as the owner of the P-4 acceptance rules. Until Dev B confirms the field set, AD5-Q8 is not decidable.]** C-b's predicate must be stated as a field set, because "different payload or subject" was too narrow in one direction, and "any difference at all" would be too wide in another. **The two directions fail differently and both failures are serious:** too narrow and a changed generator configuration is silently discarded as a duplicate, which is the C-1 defect; too wide and **every ordinary redelivery becomes a rejected identity collision**, which breaks at-least-once delivery outright (§3.7 **H-1**). The field set below is drawn to separate exactly those two cases, and that separation is what Dev B is asked to confirm.

**C-b fires when two events share an `event_id` and differ in any of:**

| Field | Why it is identity-bearing |
|---|---|
| `payload`, equivalently `payload_sha256` | Two different values are two different observations |
| the subject: the `base`/`quote` pair, or the event type's subject | Two different subjects are two different observations |
| `source_id` | Two sources are two sources, however their names were derived |
| `event_type` | Two different kinds of observation |
| `source_timestamp` | **In the C-1 derivation.** Two different instants are two different observations, and an equal `event_id` at unequal instants can only be a collision. Added in **v0.7**: without it such a pair has a different `observation_key`, so it matches **neither** D nor C-a and would be accepted with an already-used identity |
| `synthetic.seed` | **In the C-1 derivation.** Two seeds are two runs. Added in **v0.7**: without it such a pair shares both keys of §8.1 exactly and would be classified **D** and silently discarded |
| `synthetic.case_id`, `synthetic.generator_version` | **This is the C-1 class.** Two generator configurations are two distinct producers, and AD-1 §3.4.1 recorded **40** collisions caused precisely by their absence from the derivation |

**The rule behind the set.** Every field that **participates in the identity derivation** (`synthetic.seed`, the pair, the sequence, `source_timestamp` — C-1) and every field that **distinguishes the producer or the observed content** (`payload_sha256`, subject, `source_id`, `event_type`, `synthetic.case_id`, `synthetic.generator_version`) is identity-bearing. `sequence` is not compared directly: it is not an envelope field, and a differing `sequence` at an equal `event_id` necessarily shows up as a differing `payload_sha256` or `source_timestamp`.

**C-b does not fire on a difference in** `retrieved_at`, `emitted_at`, `instance_id`, or any other field that records *when, or by which process, we received* an event rather than *what was observed*. Those differ on **every** ordinary redelivery, so including them would turn each redelivery into a rejected collision and break at-least-once delivery outright (§3.7 **H-1**). `instance_id` in particular stays diagnostic by AD-12 §3.2: a restarted producer resending an event is a redelivery, not a collision.

**Why the widening is needed, and why it changes no behaviour.** `payload_sha256` covers `{event_type, payload}` only (AD-4 §2), and the `idempotency_key` adds nothing beyond it, so two events from **different generator configurations** sharing a seed, pair, sequence and `source_timestamp` have an **identical** `event_id`, an identical payload hash and an identical subject. Under v0.5's narrower C-b they fell through to **D** and were silently **discarded as duplicates**, although they are two distinct producers — the exact defect C-1 recorded. AD-1 §3.4's approved row is keyed on "different **content** or pair", which already reads wider than "payload or subject", so this **aligns** AD-5 with the approved rule rather than departing from it. **AD-1 §3.4 is unchanged, and the D-24 slice's behaviour is unchanged:** the slice runs one generator configuration per process, so no two of its events can differ in `case_id` or `generator_version` while sharing an `event_id`.

**It does not close the C-1 residual risk.** Classifying a collision correctly is detection, not prevention: the collision still occurs, because `case_id` and `generator_version` remain absent from the approved derivation. Prevention is **AD4P2-Q1** (a future generator version) together with the harness safeguards of AD-12 §3.1. **§14 item 5 stays open.**

### 8.2a Validated corrections are not conflicts

**[PROPOSED]** §8.2's conflict classes catch an **unexplained** second value. A provider that **declares** a revision is a different case, and conflating the two would either reject legitimate corrections or let an unexplained disagreement through as one. This section separates them and is written to align with **AD-2 R-5**'s "validated correction" row.

**Corrections are not restricted to announcements.** §6.3 gives `announcement` no subject, so a later announcement never supersedes an earlier one *by recency* — but that is a statement about **ordering**, not about corrections. **Every event type may be corrected**, including `fx_rate`, `economic_indicator` and `bank_holiday`: a revised economic indicator is the ordinary case, and AD-4 §2's `supersedes` field is defined for every type.

| | **Validated correction** | **Value conflict (§8.2 C-a)** |
|---|---|---|
| What arrives | A **new event** whose `supersedes` names an earlier event | A second value for one subject at one instant, with **no** `supersedes` |
| Evidence of intent | The provider stated a revision, and `supersedes` records which event it revises | None. The source contradicted itself, or two configurations write to one `source_id` |
| Validation | **V-4** (AD-4 Part 2 §5.1): `supersedes` must resolve to an existing event **of the same source and the same event type**, or the event is **rejected** (AD-4 §6) | Not applicable |
| Stored | **Yes**, and **the superseded event is kept unchanged.** Events are immutable (AD-4 §2) | The later event is **rejected and counted**; the first is kept |
| Becomes current | **Only if** it is the subject's newest by §8.3's ordering rule. A superseded event is **never** current again (AD-4 §8.1) | Never |
| Counted as | A correction | A conflict, and **alertable** (AD-8 §7.3 **Q-2**) |

**Revision evidence required of a correction**, so that "it carried `supersedes`" cannot be asserted without support:

1. **`supersedes` resolves.** The named `event_id` exists, is of the same `source_id` and the same `event_type`. A dangling, cross-source or cross-type reference is `SUPERSEDES_INVALID` and is **rejected** (AD-4 §6; AD-4 Part 2 §5.3).
2. **The provider declared it.** The adapter sets `supersedes` only from something the provider actually published — a revision flag, a revision identifier, a corrected-value endpoint or an explicit restatement. **An adapter must never infer a correction** from the mere fact that a value differs: that inference is exactly what would turn §8.2's C-a conflict into a silent overwrite.
3. **The subject is unchanged.** A correction corrects an observation *of the same subject* (§6.3). An event whose `supersedes` points at another subject is rejected under rule 1's same-type check plus V-4's semantic check.
4. **Timestamps are the correction's own**, except that a review approval copies the reviewed event's timestamps apart from `emitted_at` (AD-4 §5). A correction is never back-dated to make itself current.
5. **No in-place edit, ever.** The correction is a new event with its own `event_id`; the superseded event is retained exactly as received. Correction history belongs to **AD-11**.

**What AD-5 does not decide.** How corrections are retained and queried, and how a correction chain is presented, are **AD-11**'s and **AD-9**'s. Whether a given provider's revision mechanism is usable at all is a **Gate 3** question, recorded in its registry entry (§2.2). **AD5-Q10** (§15) puts rule 2 to the owner, because it constrains every future adapter.

### 8.3 Ordering, late events and ties

**[APPROVED]** (AD-4 §5) A late event is valid. Where source timestamps exist, the current value for a subject is the one with the **latest source timestamp, not the latest arrival**.

**[PROPOSED]** Per subject:

| Case | Result |
|---|---|
| Newer `source_timestamp` | Becomes current; one update is published |
| Older | **Not current**; counted as **late**, not as an error. "Not current" is **not** "not stored": an ordinary late arrival within the late-tracking horizon is **retained historically** and simply never becomes the subject's current value (**AD-2 R-5**; storage and retention are **AD-11**'s) |
| Equal `source_timestamp`, different `event_id` | **First kept**, counted. This is §8.2's **C-a** value conflict, so it is also alertable, not a benign tie. Provider sequence is not used to break it: `source_sequence` is opaque (AD-4 §2) |
| `source_timestamp` null for the source | Arrival order, within the run only, and the registry says so |
| Beyond the AD-8 clock tolerance in the future | **Quarantined** as `FUTURE_SOURCE_TIMESTAMP` (AD-4 §6) and never current, so it cannot block later valid events (AD-1 §3.4) |

- The current event remains the **ordering watermark** after it becomes unavailable, while its number stops being shown (AD-1 §3.4).
- A superseded event is never the current value (AD-4 §8.1).
- **No reordering buffer in v1.** Holding events back to sort them would add latency against AD-8's budget to correct an ordering the timestamp already settles.
- **"Ignored" never meant "discarded".** Throughout §8, a late or non-current event is one that does **not become the subject's current value**; whether it is **stored** is a separate question, answered by **AD-2 R-5** and **AD-11**, not here. The five AD-2 R-5 cases map onto this document as follows, and AD-5 adopts that vocabulary:

| AD-2 R-5 case | AD-5 | Current value? | Stored? |
|---|---|---|---|
| **Ordinary late arrival** | §8.3 "Older" | Never | **Yes**, within the late-tracking horizon; counted by lateness bucket |
| **Eligible late history** | §8.3 "Older", beyond the horizon | Never | **Only if** the source's Gate 3 terms and AD-11's retention permit; otherwise not stored and counted as outside retention. That is a **retention or permission refusal, not a validation rejection** |
| **Validated correction** | **§8.2a** | Only if it is the subject's newest by this section's ordering | **Yes**, and the superseded event is kept unchanged |
| **Quarantined** | §10; AD-4 §6 | Never, unless a review approves it as a **new** event | **Yes**, in quarantine only (AD-11) |
| **Rejected** | §7.1 `item_invalid`; §8.2 conflicts | — | Only a rejection record without payload (AD-4 Part 2 §5.4). **Lateness alone never causes rejection** |

- **The late-tracking horizon and the dedup window are different bounds.** The dedup window (§8.2, AD-8 §3.5) bounds **memory** for recognizing a redelivery; the late-tracking horizon bounds **how far back an arrival is still counted as ordinary**. **AD-2 R-5 proposes 24 h** for the latter, marked provisional there; AD-5 does not set it, and a late-event window beyond the dedup window remains an **AD-2** decision.

### 8.4 Sources without a source timestamp

**[PROPOSED]** AD-4 §5 permits `source_timestamp: null`, with `source_timestamp_basis: none` exactly then, and forbids filling it from a local clock. A null timestamp weakens four separate things at once, so they are gathered here rather than left to be rediscovered per component.

| Concern | With a source timestamp | With none |
|---|---|---|
| **Identity** | Deterministic from observation properties (§5) | Still deterministic for the provider transports, because `retrieved_at` substitutes — but `retrieved_at` is **our** clock, so two ingestion instances observing the same value name it differently |
| **Both keys** (§8.1) | Over `source_timestamp` | Over `retrieved_at`, so they are **run-local** |
| **Deduplication** | Restart-safe (§8.5) | **Not restart-safe.** `dedup: within_run` |
| **Ordering** | Latest `source_timestamp` is current, so a late event is handled correctly (AD-4 §5) | **Arrival order, within the run only.** A late event is indistinguishable from a new one |
| **Freshness age** | From `source_timestamp` | From `retrieved_at` (AD-4 §7; AD-8 §2.3 decides this as **AD4-Q1**) |
| **Display** | May be **Live** if it meets AD-4 §8.1 rule 6 | **Never Live.** Rule 6 requires `source_timestamp` to be set, so the best available label is **Delayed** |

**Consequences, stated rather than implied:**

- The registry records `timestamp_basis: none` and `dedup: within_run` **explicitly** (§2.2), so the limitation is a declared property of the source, not a silent behaviour.
- **Such a source is still displayable**, with age from `retrieved_at` and the label Delayed. **AD5-Q4** (§15) puts this to the owner, because it is a real weakening: the age shown is the age since *we fetched it*, which is a lower bound on the true age.
- **A `real` source with no source timestamp cannot be given one.** Inventing a time would convert an unknown into a measurement (AD-4 §5; AD-5 §3.5).
- **A date-only value is not a null timestamp.** It keeps its own date in the payload — `bank_holiday.date`, `economic_indicator.period` — and the envelope's `source_timestamp` is null only if the provider documents no publication time.

**The D-24 slice differs, deliberately.** AD-1 §3.4 **rejects** an event whose `source_timestamp` is null, and AD-1 §3.2 requires every value in the slice to carry a positive `unavailable_after_ms`. The slice's only source is its own generator, which always sets a timestamp, so a null one there means a defect rather than a provider limitation. **That slice rule is approved and unchanged;** §8.4 governs sources the slice does not have, and no §8.4 rule loosens an approved slice rule.

### 8.5 Restart-safe deduplication

**[PROPOSED]** A restart must not cause an already-published observation to be republished as a new one, nor cause a genuinely new one to be discarded as a duplicate. Both are possible, and which one happens depends on properties of the derivation rather than on stored state.

| Transport | Restart-safe? | Why |
|---|---|---|
| `websocket`, `poll`, `scheduled`, with a source timestamp | **Yes** | The `event_id` and both keys are functions of observation properties only (§5, §8.1), so a restarted process recomputes exactly the same values. No stored state is required for correctness |
| `synthetic`, with a fixed seed and injected clock | **Yes within one configuration**, by C-1's derivation. The cross-configuration case is the open C-1 residual risk (§8.2 C-b) | |
| Any transport with a null source timestamp | **No** — `dedup: within_run` (§8.4) | The keys depend on `retrieved_at`, which a restart changes |
| `manual` | Not applicable | Not deduplicated (§8.1) |

**What a restart loses, and why that is safe.** The dedup state is a bounded window, not a ledger, so a restart loses it. The consequence is **re-acceptance**, not corruption:

- A redelivered event recomputes the same `event_id` and the same keys, so it is recognized as a duplicate once the window refills — and in the interval it is handled by §8.3's ordering rule, which ignores it as **not newer** than the subject's current value.
- An event that *is* newer is accepted, which is correct.
- Nothing is rejected on the strength of state that no longer exists, so a restart cannot stall a subject. That matters because C-1's failure was precisely a stall that outlived a restart (AD-1 §3.4.1).

**Requirements this places on AD-8 and AD-3:**

1. **`dedup_window` must exceed the expected restart time** plus the provider's redelivery window, or a redelivery after a restart is briefly indistinguishable from a new event. AD-8 §3.5 sets it (300 s for the fast transports, 7 days for `scheduled`).
2. **Dedup state is rebuildable, never authoritative.** It may be warmed from the observation store at start (AD-11) as an optimization; correctness must not depend on it, because the store may be empty or behind.
3. **Redelivery semantics are undecided** (§3.7). At-least-once delivery makes restart-safe deduplication load-bearing rather than a nicety, so §3.7's open question and this section are decided together.

**The D-24 slice:** a restart may lose state and needs no reset — "a clock moved backwards yields late events, so values age out safely" (AD-1 §3.4), and Dev B's C-1 review measured a live ingestion restart across two `instance_id`s: **29 events accepted, zero rejections, zero `event_id` conflicts, zero hash mismatches** (AD-1 §3.4.1). That is the restart-safety property above, measured on the one transport that exists today.
---

## 9. Source status, staleness and outage

### 9.1 Source status is not freshness

**[PROPOSED]** Two independent things, deliberately kept apart:

- **Source status** is about the **connection**. It is not an observation, and AD-4 §1 excludes it from the envelope: "A connection status is not an observation. It belongs to AD-5." **Two vocabularies exist and §9.3 maps between them:** the adapter's internal lifecycle (§3.3) and the **published status**, which on the wire is the approved closed set `starting | ok | outage`.
- **Freshness** is about the **value**: its age against the profile, evaluated when read (AD-4 §7).

They are separate because a source can be connected and silent — healthy connection, ageing value — or in outage while its last value is still fresh. Collapsing them would let a reconnection appear to refresh a value, and AD-4 §7 forbids exactly that: *a source outage does not refresh or reset age.*

### 9.2 The internal status machine

**[PROPOSED]** Per source, **inside ingestion**; thresholds from AD-8. These are **internal** states, not wire values: §9.3 maps them onto the published set.

| Internal state | Entered when | Left when |
|---|---|---|
| `starting` | The adapter starts, before the first successful item | One successful item, to `ok`; a permanent fault, to `down` |
| `ok` | At least one successful item within the expected cadence | The outage criteria below, to `outage`; a permanent fault, to `down` |
| `outage` | Either: consecutive failures reach the AD-8 count, **or** no successful item for the AD-8 silence window — whichever comes first | One successful item, to `ok` |
| `down` | A `failed_permanent` fault (§7.1): authentication, authorization, a contract violation, a withdrawn Gate 3 decision or a registry mismatch | **An operator action only.** It never self-heals, which is why it is distinguished internally (§3.3) |

AD-1 §3.1 is the D-24 instance: `starting` until the first successful poll, then `ok`; `outage` after 3 consecutive failures or 2 s without a success, whichever is first. The two-criteria form matters for a streaming transport, where a silent subscription produces no failures at all.

- **A silent source is a degraded source**, judged against `expected_interval_ms`. A `scheduled` source is judged against its schedule, not an interval.
- Status is published to the browser as **content**, not as an HTTP status (AD-1 §3.1, §3.2): the stream opens and reports the outage.
- Status changes are rate-limited in logs and debounced before alerting (AD-8 §7), so that a flapping source does not drown the signal.

### 9.3 Mapping onto the published status: `down` is internal only

**Scope note (v0.6).** This section describes the mapping **where ingestion's status reaches a consumer**. The **D-24 slice has no such path**: `GET /v1/latest` carries no status field at all (`contracts/events/ingestion-latest.v1.schema.json`), and the published `source.status` is derived by **Express's own poller** from poll success and failure (AD-1 §3.2). Nothing below changes that, and no D-24 behaviour depends on it. Giving ingestion a published status would change an approved contract, and is **not proposed**.

**The approved wire contract is a closed three-value set.** `contracts/events/stream-message.v1.schema.json` enumerates `source.status` as exactly `starting`, `ok`, `outage`, and AD-1 §3.1 and §3.2 state the same three. The deployed client validates `source` strictly and a wrongly typed `source` is a **protocol fault** (AD-1 §3.3.3), so **adding a fourth value to that enum would fault every open stream.** §9.2's `down` is therefore **internal to ingestion and is not published as a new wire value.**

**[PROPOSED]** The mapping, which keeps the approved contract exactly as it is:

| Internal state (§9.2) | Published `source.status` | Rationale |
|---|---|---|
| `starting` | `starting` | Direct |
| `ok` | `ok` | Direct |
| `outage` | `outage` | Direct |
| `down` | **`outage`** | To a *viewer*, a permanently failed source and an unreachable one are the same thing: no fresh values arrive, and the values age through `stale` to `unavailable` identically. The distinction is **operational**, not user-facing |
| `stopping`, `stopped` (suspension or shutdown) | **`outage`** | Same reasoning |

**The distinction is not lost — it is carried where it is actionable.** `down` differs from `outage` in exactly one respect: it will **never** recover without an operator (§3.3). That is an operations fact, so it surfaces in operations:

- `observation_source_status` records the **internal** state as a label, so metrics distinguish all of them (AD-8 §7.1);
- **alert S-2 is paged and S-1 is not** — AD-8 §7.3 already separates "source down (a permanent fault)" from "source outage", precisely because one self-heals and the other does not;
- the fault class and reason code are logged (§7.1).

**What publishing a distinct `down` would require, if it is ever wanted.** It is **not proposed here**:

1. a new value in the `source.status` enum, which the deployed client rejects, so a **protocol version change** under AD-1 §3.2's rule that "a major version changes meaning and the path" — adding to a closed enum validated strictly is not an additive change (AD-4 Part 2 §6.2.1);
2. a coordinated client rollout, or acceptance that older tabs fault and then stop permanently;
3. a decision in **AD-7**, which owns the channel contract, with **AD-9** deciding what a user would see that differs from an outage;
4. a reason to show it at all: the display difference would have to be meaningful to a pilot user, and today it is not.

**This is provisional.** **AD5-Q9** (§15) puts the mapping to the owner. Until it is decided, the mapping above is what AD-5 assumes, and **the approved three-value contract is unchanged in every case.**
---

## 10. Plausibility bounds

**[PROPOSED]** A plausibility failure is a **quarantine**, never a correction and never a rejection: the value is a valid envelope that the system declines to display (AD-4 §6). The bounds live in the registry; AD-8 sets the numbers.

| Setting | Meaning | AD-4 reason code |
|---|---|---|
| `value_min`, `value_max` | Absolute bounds per event type and subject | `VALUE_OUT_OF_RANGE` |
| `max_relative_jump` | Greatest change from the subject's current value, per unit time | `VALUE_JUMP` |
| `clock_tolerance_ms` | How far ahead of `retrieved_at` a source timestamp may be | `FUTURE_SOURCE_TIMESTAMP` |
| `review_required` | Every unreviewed `announcement` and every extracted item | `REVIEW_REQUIRED` |

- Bounds are **wide and documented**, not tuned: their purpose is to catch a decimal-point error or a test value in a production feed, not to smooth real volatility. A bound narrow enough to quarantine a genuine market move would hide the observation the pilot exists to show.
- `max_relative_jump` is evaluated against the subject's **current** value; with no current value, only the absolute bounds apply.
- A quarantined value is **not displayed** (AD-4 §6) and does not become the ordering watermark.
- Quarantine counters and the quarantine store are the AD-12 review flow's input. **No knowledge-layer write follows from a quarantine release without Gate 2** (D-4), and nothing here affects feasibility (A-4).

---

## 11. Separation from routing

**[APPROVED]** (D-9, D-15; AD-6 §1) No observation may influence an engine request or an engine result. Synthetic events follow the same rule, so the tests exercise the real boundary.

**[PROPOSED]** The adapter-specific controls, mapping onto AD-6 §5:

| AD-6 control | AD-5's obligation |
|---|---|
| **B-1** type | Every adapter emits `usage: display_only`. No adapter may emit a bridge-state value, and no such event type exists. An adapter cannot set `usage` itself: the service sets it (§3.4) |
| **B-3** code | No adapter imports from `src/`, `services/inference/`, the Express routing, mapper or inference-client modules, or any Phase 1 module. Checked in CI (`infra/scripts/check_import_boundaries.py` is the existing mechanism) |
| **B-4** network | Each adapter's egress is limited to its registry allowlist; ingestion has no route to inference, the engine or the Phase 2 database. **B-4 remains unresolved on the inference side** (§14) |
| **B-5** credentials | An adapter holds no database credential and no distribution credential; its provider credential is resolved by reference at `start` and is never written to disk, a log or an envelope |
| **B-6** filesystem | Ingestion mounts no Phase 1 path with write access. An adapter writes no project file: `data/`, `outputs/`, the knowledge base and every engine artefact are untouched (AD-6 §4) |

Additionally: **no adapter is driven by a routing event.** No adapter has an input that a routing request, result, form value or user selection can reach, so there is no code path by which routing could change what is observed — the converse direction of AD-6 §1, which AD-6 does not need to state because the engine has no outputs pointed this way, and which AD-5 states because an adapter is the component that could have been written to accept one.

---

## 12. Security posture

### 12.1 Process posture

**[PROPOSED]** Every adapter runs inside the ingestion service, which keeps the posture the D-24 overlay already applies (`infra/compose.observations.yaml`): non-root, read-only root filesystem, `cap_drop: [ALL]`, `no-new-privileges`, process, memory and CPU limits, no published port, no `env_file`, no volume.

A provider adapter changes exactly one thing: ingestion acquires **outbound** access, to its allowlisted hosts only. That is a material change to the D-24 posture, where ingestion contacts nothing at all, and it belongs to **AD-10**, whose exposure plan must state how egress is controlled and enforced.

### 12.2 Credentials

**[PROPOSED]**

- The registry holds a `credential_ref`, **never a secret**. Resolution is AD-10's mechanism; nothing goes in source control (scope §4.E; root `CLAUDE.md`).
- A credential is read at `start`, held in memory, never logged, never in an envelope, never in a URL, and never in `source_url` — which AD-4 §2 already requires to carry no credential, user information, query or fragment.
- Rotation is a restart of that adapter, not a process restart, and never a code change.
- A revoked credential is an `auth_failure`: `failed_permanent`, with an alert (§7.1). It never retries.

### 12.3 Untrusted input

**[PROPOSED]** Everything a provider sends is untrusted, as AD-1 §2 already treats the ingestion-to-Express boundary. Bodies are size-limited while reading; parsing is bounded in depth and element count; `announcement` text is data, never an instruction to a model and never HTML (AD-4 §4); TLS verification is never disabled; redirects are not followed; and a response that violates the contract is rejected whole (§7.3) rather than salvaged.

---

## 13. Testing obligations

**[PROPOSED]** AD-13 owns the strategy; these are the obligations AD-5 places on milestone 3.3. The D-24 fault catalogue (AD-1 §3.7) is the model and the starting set.

| # | Obligation |
|---|---|
| A-1 | **Contract conformance:** every adapter passes one shared suite driven by the §3.2 operations, so a new adapter cannot define its own semantics. `describe()` is checked against the registry record |
| A-2 | **Registry validation:** a malformed, inconsistent or incomplete record is a startup failure. Negative cases include a `synthetic.` prefix with a non-synthetic class, a transport mismatch, a `real` source with no active Gate 3 reference, and an out-of-order freshness profile |
| A-3 | **Determinism:** the synthetic adapter with a fixed seed and injected clock reproduces identical payloads, hashes and `event_id`s (AD-1 §6 item 1) |
| A-4 | **Fault injection**, against a controllable fake provider that is **test-only and absent from runtime images**: every §7.1 class; `Retry-After` present, absent and invalid; the breaker opening, cooling down and probing; a redirect; an oversized body; a wrong content type; a truncated stream; a provider that closes immediately on connect |
| A-5 | **Item-level faults:** duplicate, late, tie, conflict, future at and beyond the tolerance, malformed, wrong hash, unknown code, identical FX currencies, a subject outside the allowlist, a non-synthetic marker on a synthetic source |
| A-6 | **Idempotency:** the §8.1 key is stable across process restarts for the deterministic transports, and the dedup window's boundary is tested at, inside and outside it |
| A-7 | **Status machine:** both outage criteria, independently; recovery; the permanent states, each of which must **not** retry |
| A-8 | **Normalization:** decimal strings survive with their trailing zeros; no float round-trip; codes are mapped only through the mapping table; a missing required field is a rejection, not a default |
| A-9 | **Boundary tests:** AD-6 T-1 to T-8 and T-10 apply to every adapter. **T-5 is run per adapter**, from inside the container, including the egress allowlist: a host outside it must be unreachable |
| A-10 | **No provider data:** every fixture in the suite is synthetic or hand-written. A fixture recorded from a provider is ingestion and needs Gate 3 (D-17). CI must be able to show this, which means fixtures carry their origin |
| A-11 | **Gate 3 enforcement, in two parts (split in v0.7).** **(a) Ingestion side, testable wherever an adapter exists:** with a source's decision reference absent, inactive or withdrawn, the adapter **does not start** and the service records the reason. This is a negative registry and startup assertion. **(b) Display side:** stored values of that source display **Unavailable** (AD-4 §8.1 rule 2). Part (b) is **deferred to the milestone that builds the observation store (AD-11, C-5) and the panel behaviour (C-8)**; it cannot be asserted before either exists, and a milestone that implements only (a) must record (b) as outstanding rather than claim A-11 |

---

## 14. Known gaps and what closes each

| # | Gap | Closed by |
|---|---|---|
| 1 | **AD-6 B-4 is unresolved on the inference side.** D-25 waives it for the D-24 slice only; the exception extends to no later milestone or component, is not Gate 4 evidence, and no gate has passed | **AD-10** (scope §2.2.3, D-25; AD-1 §5 item 1) |
| 2 | **Outbound egress from ingestion does not exist yet** and its enforcement is unspecified. §12.1 states the requirement only | **AD-10**; milestone 3.2 |
| 3 | **Every numeric value in this document is deferred.** Intervals, thresholds, tolerances, windows, ceilings, backoff bases, size and timeout limits | **AD-8**. Until AD-8 is approved, F-5's targets stay provisional and exit criterion 9 is unmet |
| 4 | **The distribution mechanism is open**, so §3.6's sink has one in-memory implementation and no durability or replay. **The delivery semantics H-1 to H-6 (§3.7) are pending**: at-least-once versus at-most-once, the handoff point, acknowledgement, the replay window, slow-consumer behaviour, and whether any of it is per channel | **AD-2**, **AD-3**. H-1 and §8.5 are decided together |
| 5 | **The C-1 residual risk is open:** overlapping generator runs with the same seed and timestamps but a different `case_id` or `generator_version` produced 40 `event_id` conflicts, because the derivation includes neither. Recorded by Dev B's C-1 review and **outside C-1's scope** | `docs/PHASE3_AD4_ENVELOPE_PART2.md` §3.4 proposes a derivation for a future generator version; it needs the owner's approval, because C-1's derivation is approved text |
| 6 | **The three non-FX payload schemas are minimal** and each is reviewed again before its first adapter (AD-4 §4) | AD-4 at that point; `docs/PHASE3_AD4_ENVELOPE_PART2.md` §7 drafts the refinement |
| 7 | **Multi-source derivation is deferred beyond envelope v1** (**AD4-Q8**, owner-decided), so §4's inversion case cannot combine two providers | A future AD-4 major version |
| 8 | **No provider is approved**, so no adapter beyond the synthetic one can be exercised end to end | **Gate 3**, per provider |
| 9 | **Storage, retention and the trust level of a stored observation** are unspecified here, including whether a late arrival or a superseded event is retained and for how long | **AD-11**; the case split is **AD-2 R-5** |
| 9a | **The late-tracking horizon is not set here.** AD-2 R-5 proposes 24 h, provisionally | **AD-2** |
| 10 | **The review queue for quarantined and extracted items** is unspecified here | **AD-12**; Gate 2 for any knowledge write |

---

## 15. Questions for the project owner

| # | Question | Draft position | Decides |
|---|---|---|---|
| AD5-Q1 | Are the **two keys** of §8.1 adopted in place of scope §3.B's single three-part key — `observation_key` for conflicts and `idempotency_key` for duplicates? | Yes. One key cannot answer both questions: a key containing the payload hash cannot detect two different payloads. **No event identity changes** | Owner, on this document |
| AD5-Q2 | Is the §2.3 onboarding workflow, with O-2 restricted to published documentation, adopted? | Yes. It is what D-17 requires in practice | Owner |
| AD5-Q3 | Is a provider's native FX direction emitted as published (`real`), or always normalized to quote-per-base (`derived`)? | Emit as published where the provider's direction is declared in the registry; inversion is a derivation | Owner, with Dev B |
| AD5-Q4 | May a `real` source with no `source_timestamp` be displayed at all, given §8.4's four consequences — run-local keys, no restart-safe deduplication, arrival-order ordering, and age measured from our own fetch? | Yes, labelled **Delayed** and never Live, with `timestamp_basis: none` and `dedup: within_run` recorded in the registry (§8.4) | Owner; interacts with **AD4-Q1**, decided in AD-8 §2.3 |
| AD5-Q5 | Who may enter a `manual` observation, and is a second person's confirmation required? | Deferred to AD-10's authorization model | AD-10 |
| AD5-Q6 | Does a provider's `withdrawn` status ever require deleting stored observations? | Only where its terms require it; §2.4 keeps history by default | Gate 3 terms; AD-11 |
| AD5-Q7 | Which **delivery semantics** does Phase 3 require (§3.7 **H-1**)? | At-least-once, which makes §8.5's restart-safe deduplication load-bearing and is the semantics the deterministic derivations already support | **AD-2** states the requirement, **AD-3** chooses; the owner approves both |
| AD5-Q8 | Is **§8.2's three-outcome model** adopted — duplicate, value conflict (first kept), identity collision (rejected) — with both conflict classes alertable, its **v0.5 evaluation order** (C-b before D before C-a) **evaluated against an `event_id`-keyed index**, and **§8.2b's v0.7 definition of "differing event content"** for C-b, which now includes `source_timestamp` and `synthetic.seed`? | Yes. Each row's behaviour is AD-1 §3.4's, unchanged; the order is a requirement, not a consequence of the current derivations, because an identity collision may share both §8.1 keys or match neither; and §8.2b stops a changed generator configuration, a changed seed or a changed instant being discarded or silently accepted | Owner, with Dev B (P-4 owns the acceptance rules; §8.2b's field set needs Dev B's confirmation) |
| AD5-Q11 | §8.2's **C-a** is keyed on the **payload hash** while AD-1 §3.4's approved row is keyed on **`event_id` inequality**, so two same-payload events with different `event_id`s are a conflict in the slice and a duplicate in the general rule. **(a)** Which rule governs which path? **(b)** Should the general rule be narrowed to match the slice, or the slice's rule widened at its next revision? | **(a) Each path keeps its own rule, and this is the part asked now:** the existing D-24 generator path runs **AD-1 §3.4 exactly as approved**, and the adapter path, when a registry record selects it, runs **§8.2** with §8.2b's predicate and the C-b → D → C-a order. No reclassification, no new counter and no behaviour change on the D-24 path. **(b) stays open:** the slice's approval is version-specific and the divergent cell is the benign post-restart case AD-1 §3.4.1 already records. Decide it when AD-7 or a slice revision next opens §3.4 | Owner, with Dev B and Dev D. **(a)** is requested in `docs/PHASE3_33A_AUTHORIZATION.md` §4.6; **(b)** remains a **PENDING owner decision** |
| AD5-Q10 | Is **§8.2a rule 2** adopted — an adapter sets `supersedes` **only** from something the provider actually published, and **never infers a correction** from a value simply differing? | Yes. The inference is exactly what would turn a §8.2 C-a conflict into a silent overwrite | Owner, with Dev B. It constrains every future adapter |
| AD5-Q9 | Is **§9.3's mapping** adopted — `down` stays internal and publishes as `outage`, keeping the approved three-value `source.status` enum unchanged, with the distinction carried in metrics and the paged S-2 alert? | Yes. A fourth enum value would fault the deployed client, and the difference is operational rather than user-facing | Owner, with Dev C; a published `down` would be **AD-7**'s and **AD-9**'s |

---

## 16. Approval checklist

**None of these is given. This document is a DRAFT; it has been reviewed on PR #30 with changes requested, those findings are applied, and no reviewer has re-reviewed and no owner has approved it.**

- [ ] **Dev B** — review: §3.6 sink and §3.7's pending delivery semantics; §7 fault classes and `Retry-After` handling; **§8.1's two keys and §8.2's three outcomes against the P-4 acceptance rules Dev B owns**; §8.4 null timestamps; §8.5 restart safety; §9 status as content; §12 credentials
- [ ] **Dev D** — review: §2 registry as version-controlled configuration; §12.1 container posture and egress; §13 CI obligations, fixture origin and the test-only fake provider
- [ ] **Second-reviewer rule (D-20)** — satisfied by either review above, since Dev A is both lead and approver
- [ ] **Project owner** — approval, with §15's questions decided

On approval, the decision is recorded in `docs/PHASE3_SCOPE.md` §2 (3.1 plan §5), and milestone 3.3 gains one of its four required deliverables: the AD-1 component view, AD-4, **AD-5** and AD-12 (scope §7.1). **No gate passes by this document, and no provider becomes approved.**
