# AD-11: Audit Trail and Persistence Proposal

**Status:** **DRAFT v0.3 for review. Not approved.** 26 November 2026. **Review state:** on PR #35, v0.2 (`1efb269`) was **APPROVED as DRAFT architecture documentation by the project owner (Ayush)**, with two non-blocking corrections, and received **CHANGES_REQUESTED from Nisarga (Dev D)** on the review path. v0.3 applies both; **neither reviewer has re-reviewed v0.3**. Draft approval authorizes no migration, privilege change or implementation, and every AD-11 decision stays provisional. A **proposal**: no migration, schema change or role change is made or authorized until it is approved (scope §7.3). Physical storage and schema choices are **provisional**. New numbers are `[#?]`.
**Lead:** Dev B. **Reviewers:** Dev A, Dev D. **Approver:** project owner.
**Inputs:** AD-3 (**v0.3**, PR #31, merged into `feature/phase3-platform` and still DRAFT), AD-4 v0.2 (approved for the D-24 slice only), AD-10 (**draft v0.2**, PR #33, open). **Feeds:** milestones 3.2, 3.7. **Coordinates with:** AD-2, AD-5, AD-7, AD-12, Gate 3.

**Revision v0.2, 26 November 2026 — still DRAFT.** Documentation only: no migration, role, privilege, retention value or schema is created or changed, and every mechanism below remains a proposal needing owner approval. Applied:

| From | Finding | Where applied |
|---|---|---|
| Nisarga 1 | §9: reconcile shared routing and observation write privileges with AD-3 H-6/H-7; evaluate a distinct observation writer role; document the failure-isolation boundaries | **§9.1**, §9, **AD11-D11** |
| Nisarga 2 | §4: replace the assumed commit-ordered storage sequence with a **gap-safe replay** requirement | **§4** storage-sequence bullet, **AD11-D14** |
| Nisarga 3 / Owner 1 | §6 and §9: the atomic P-5/P-7 write is incompatible with the role matrix; specify an **executable** transaction and role mechanism, consistent with AD-10 | **§9.2**, §6, **AD11-D10** |
| Nisarga 4 | Retention dependency between review records and quarantined evidence | **§8.1**, **AD11-D12** |
| Nisarga 5 | Retention **permissions** and reviewer-identity **erasure** requirements | §8.1, §9, **AD11-D13** |
| Nisarga 6 | Align idempotency with the **revised AD-5 keys** | **§4** idempotency and semantic-deduplication bullets |
| Nisarga 7 | Clarify consumer row isolation and the remaining role definitions | **§9.3** |
| Owner 2 | §8/§9: observed P-2 retention is provider-bound, but no proposed role can delete observed rows | **§8**, §9 role table, **AD11-D12** |
| Owner 3 | PR #31 alignment: AD-3/AD-12/AD-13 to v0.3; correct C11-4, C11-5, C11-6, in particular AD-13's existing G4-1 and G4-2 | **§13** |
| Owner 4 (minor) | Clarify P-9 retention, the seeder role, and the storage implication of 30-day synthetic retention | §8, §9.3 |

**Revision v0.3, 26 November 2026 — still DRAFT.** Documentation only. Applied from the re-reviews of v0.2 at `1efb269`:

| From | Finding | Where applied |
|---|---|---|
| Nisarga (blocking) | The role split does not say how the review module reads P-4 and coordinates the approved P-2 event with P-5 and P-7: read access, atomicity or recoverable coordination, idempotent retries, partial-commit recovery, no premature publication, without changing the event-identity contract; acceptance criteria | **§9.4**, §9 role table, §11 items 14 to 19, **AD11-D15** |
| Owner 1; Nisarga | Reflect AD-10's finding that Phase 2 integration tests need a separate privileged fixture connection | §9, §11 item 1 |
| Owner 2; Nisarga | Stale AD-5 v0.3 reference in §4 | §4 |
| Consistency (AD-7 v0.3, PR #34) | One claim per record enforced by a database uniqueness constraint | §3 P-6 |
| Consistency (merged AD-2 v0.2) | `degraded` is an internal source state, not a published status | §9.1 |
**Scope source:** `docs/PHASE3_SCOPE.md` v1.4 §3 Workstream E, §5 (Gates 2–4), §7.3 (AD-11 row); `docs/PHASE2_API_CONTRACT.md` §6; `docs/PHASE3_AD6_ENGINE_BOUNDARY.md` §5 (B-5, B-7), §6.1; AD4-Q7.

## 1. Directions applied (relayed)

Relayed 26 November 2026; no approval document exists in the repository. The owner approved proceeding with durable delivery and replay for the broader pilot; **Dev D (Nisarga)** supports backend-mediated persistence and these review-record proposals; Dev C supports separate, untrusted context records. Directions, not approval of this document.

## 2. What exists and is preserved

| Item | State at `4424b45` |
|---|---|
| Authoritative routing records | `TransactionRequest`, `RoutingDecision` (with `stateFrameSha256`, `checkpointSha256`, `knowledgeSha256`, `gitCommit`, verbatim `engineResponse`), `Allocation`, `Comparison`, `Explanation` (`services/backend/prisma/schema.prisma`). **Unchanged by this proposal** |
| Append-only rule | Contract §6.1: "Records are append-only. Corrections create new records." Enforced by **convention only**: no GRANT, REVOKE or trigger in the two migrations |
| **Q19** | Contract §6.2: an `AuditLog` row only together with a persisted record, in the same transaction; rejected requests create none. **Preserved without change** |
| Provisional values | `AuditLog.action`, `outcome` (`schema.prisma:213,222`); the both-or-neither entity rule has no CHECK constraint |
| Runtime mutation | None on business records; only the seeder upserts `User` (`services/backend/src/db/seedDevUsers.ts:34`) |
| Observations | Nothing stored (D-24; AD-1 §3.7) |
| Database role | One `cbdc` role for `migrate` and `backend` (`infra/env/*.example`) |

**Gate 4's "audit trail"** (scope §5: input data, model version, request, allocation, response) is already covered by the routing records above, not by `AuditLog`. This proposal names them as the audit trail and adds nothing to them.

## 3. Record families (logical; physical layout provisional)

| # | Family | Mutability | Written by | Links |
|---|---|---|---|---|
| P-1 | Phase 2 routing records + `AuditLog` | Append-only | Backend, as today | Unchanged |
| P-2 | **Observation history** (accepted envelopes, verbatim, with storage sequence) | Append-only | Backend acceptance point (AD-2 R-6 to R-8) | None to P-1 (AD-6 B-7; draft AD-6 Part 2 T-14) |
| P-3 | **Rejection records** (no payload; draft AD-4 Part 2 §5.4) | Append-only | Backend | None to P-1 |
| P-4 | **Quarantine** (withheld valid envelopes) | Append-only | Backend | Referenced by P-5 |
| P-5 | **Review records**: queue entries, outcomes (approve or refuse), refusals | Append-only | Backend, on an authenticated reviewer action | P-4 item; on approval, the new event in P-2 (`supersedes`, AD-4 §6) |
| P-6 | **Browser-context claims** (AD-7 §8) | Append-only; **at most one claim per record**, enforced by a uniqueness constraint on (`request_kind`, `record_id`) — the persisted record `id`, never `X-Request-Id` (AD-7 v0.3 §8.1) | Backend | Points **to** a P-1 record; never the reverse (AD-6 §6.1) |
| P-7 | **Security events** (AD-10 §6) | Append-only for the application; deleted only by retention | Backend | None |
| P-8 | **Sessions** (AD-10 §4) | **Mutable** (create, refresh, delete) | Backend | User |
| P-9 | **Consumer positions** (AD-2 R-9) | **Mutable** (advance only) | Each consumer | P-2 sequence |
| P-10 | **Reviewer identities** (§6) | Append-only mapping; deactivation is a new row | Backend, from the IdP | P-5 |

- **Separation (AD-4 §3.2; AD-2 R-14):** synthetic and observed events are kept so that an observed-only query cannot return synthetic ones: a `provenance_class` column is **not enough** by itself; proposed: separate tables or a schema per class, plus read roles that can see only observed rows `[provisional]`.
- **Physical store:** PostgreSQL is the **first candidate** (backend already uses it; AD-3 v0.3 §5.1). Whether P-2 to P-7 share the Phase 2 database, use a separate schema, or a separate database is **AD11-D1**, open until AD-3 is approved. Draft AD-4 Part 2 lists "PostgreSQL via Prisma (AD-11)" as the store; that is not decided here.
- **No direct ingestion database access.** Ingestion holds no credential and no route to PostgreSQL (AD-1 §3.6; AD-6 B-5). Any change needs a separate owner approval and new T-5 evidence.

## 4. Durable acceptance and idempotent persistence

- **Acceptance (AD-2 §4, R-6), mechanism-neutral:** an event is accepted when the acceptance point has validated it and **durably committed** it to P-2, and only then acknowledges it to its producer. This document does not choose the mechanism (AD-3 does). **Under the PostgreSQL proposal** (AD-3 v0.3 §5.1, H-5, unapproved), the acceptance point is the backend and "committed" means a committed PostgreSQL transaction on the P-2 table.
- **Idempotency (AD-2 R-8):** a uniqueness constraint on `event_id` (the persistence identity); a redelivery with identical content is a no-op; different content is a conflict recorded in P-3 and counted. **Known limit (AD-12 v0.3 §3.1, PR #31; AD-1 §3.4.1 C-1 residual):** overlapping synthetic runs with the same seed and timestamps but a different `case_id` or `generator_version` derive the same `event_id`; under this rule the second is stored as a conflict, not as a distinct event. Whether the synthetic identity changes is AD-5's and AD-12's; until then such runs must not share a seed (AD-2 §7). AD-12 v0.3 §3.1 records a **second** gap on the same rule: the C-1 derivation contains **no source identity**, so two synthetic sources, or a slice run and a load run, with the same seed, pair, sequence and timestamp also collide, and under this rule the second source's events are stored as conflicts for the whole run.
- **Semantic deduplication, aligned with the revised AD-5 keys (Nisarga's finding 6).** AD-5 **v0.4 §8.1** replaced its v0.1 single five-part key with **two** keys over the same fields: `observation_key` = (`source_id`, `event_type`, subject, `source_timestamp`), which **excludes** the payload hash, and `idempotency_key` = (`observation_key`, `payload_sha256`). They answer different questions, so they map to **different** persistence rules, and the v0.1 text here — "AD-5's key, applied as a second constraint" — was too loose to be implementable:

| AD-5 v0.4 key | Question | Proposed persistence rule | Outcome |
|---|---|---|---|
| `idempotency_key` | "Have I already stored exactly this event?" | A uniqueness rule **may** be added on it as a second constraint beside `event_id` | A second arrival is a **duplicate**: discarded, counted, **not** written to P-3 (AD-5 §8.2 outcome D) |
| `observation_key` | "Do I already hold a different value for this subject at this instant?" | **Not** a uniqueness constraint: enforcing it would reject legitimate corrections, which carry `supersedes` and a new `event_id` (§5; AD-5 v0.4 §8.2a). It is a **detection** rule: first row kept, the second — **unless it carries a validated `supersedes`** — recorded in P-3 as a value conflict and counted, and it is alertable (AD-8 §7.3 Q-2) | **Value conflict** (AD-5 §8.2 outcome C-a); a validated correction is stored as a new P-2 row (§5) |
| `event_id` | "Is this the same event?" | The uniqueness constraint of the bullet above — **unchanged**, and the persistence identity | Duplicate (no-op) or identity collision (conflict, P-3) |

  Neither AD-5 key is an event name and **no `event_id` derivation changes** (AD-5 §8.1). Null-timestamp sources have both keys fall back to `retrieved_at`, so they are run-local and **not restart-safe** (AD-5 §8.4, §8.5, `dedup: within_run`): for such a source neither AD-5 key may be used as a persistence constraint, and only `event_id` uniqueness applies. Announcements have no subject and are never superseded by recency (AD-5 §8.1, §6.3), so no "current value" rule applies to them. All of this is applied **only once AD-5 is approved** `[DEP: AD-5]`; AD-2 X-3 closes there, not here.
- **Storage sequence, and why it is not enough on its own (Nisarga's finding 2).** v0.1 said the sequence was "assigned at commit", which **overstated what a sequence gives**. A monotonic sequence (`BIGSERIAL`, `IDENTITY`, an explicit `nextval`) is allocated **before** the inserting transaction commits, and allocation is non-transactional, so two concurrent writers can hold sequences *n* and *n+1* and commit in the opposite order. A reader replaying "up to the highest visible sequence" can then read *n+1*, miss the still-uncommitted *n*, advance its position past it, and **never deliver it** — a skipped row with no gap counter firing, because the row exists. A failed insert also leaves a permanent hole, so "no holes" cannot be the completeness test, and commit timestamps do not help (`clock_timestamp()` is not monotonic across sessions; `now()` is the transaction's start).
- **Requirement, replacing the assumption: replay is gap-safe.** A consumer replaying from its committed position receives **every** accepted event above it, exactly once, in per-subject sequence order, with **no row skipped because it committed late**. The sequence is a storage attribute, never an envelope field (AD-3 v0.3 H-3; AD-2 R-4). **The mechanism is open** (**AD11-D14**, with AD-2 **AD2-D8** and AD-3): a watermark or lag bound, an in-flight transaction snapshot, assignment serialized at commit, or a consumer position that is a set rather than a scalar. Each trades replay latency against write throughput (AD-2 R-1, R-3), so this document recommends none. **Acceptance:** a concurrent-writer fixture where the lower sequence commits **last**, with a consumer replaying throughout, delivers both rows exactly once (AD-2 §5.3); §11 item 9.
- **Consumer positions (P-9):** a consumer advances its position only after processing; a position older than the retention of P-2 is reported as "outside window" (AD-2 R-9).
- **Separation from routing:** an observation write never shares a transaction with a P-1 write; routing never waits on it (AD6-Q2; AD-3 v0.3 H-6, H-7). Separate transactions are **necessary but not sufficient**: v0.1 still gave one role, and so one connection pool, both write paths. The privilege and failure-isolation boundary is §9.1.

## 5. Correction history

- A correction is a **new** P-2 row with `supersedes` (AD-4 §2). The superseded row is never updated or deleted.
- "Current value" is derived at read time (AD-2 R-4, §6), never stored as a mutable flag on P-2.
- A review approval is a new event (AD-4 §6) recorded in P-2 and linked from its P-5 outcome.

## 6. Reviewer references

AD-4 §2: the `review` field holds an opaque internal ID, not a name or email (AD4-Q7 open).

- **Proposed format:** `rv_` + a UUIDv4 (`[provisional]`), issued once per human reviewer in P-10.
- **Link to identity:** P-10 maps the reference to the **pair** (IdP issuer `iss`, subject `sub`) of an authenticated user (AD-10 §4). `sub` is unique only within its issuer, so the pair, never `sub` alone, is the key. Names and emails are not stored in P-10; they stay in the IdP.
- **Lifecycle (append-only, as new P-10 rows):** *issued* when the reviewer role is first granted; *deactivated* when it is removed or the user leaves; *re-linked* when the same person's (`iss`, `sub`) changes (for example an IdP migration), which is a privileged change (AD-10 §6, fail closed) recorded as a new row naming both pairs. A reference is never reused or reassigned; past references stay resolvable for audit.
- **Authorized:** only a user holding the reviewer role **at the time of the action** can create P-5 outcomes; the check runs per action, not per session start (AD-12 v0.3 §6.2 leaves "reviewer authorization and separation of duties" `[PENDING: AD-10, AD-11]`; this is AD-11's part of the proposal, and AD-10 v0.2 §5.7 holds the role model). The P-5 outcome and its P-7 security event are written in one transaction, as a database-backed privileged mutation (AD-10 §6, case (a); AD10-D12). That transaction contains no P-1 record and no `AuditLog` row, so Q19 is unchanged. **v0.1's role matrix could not execute this** (both reviewers): `cbdc_app` had no privilege on P-7, and `cbdc_security_log` was to be used on a "separate connection", which cannot share a transaction. The executable options, and the open decision between them, are **§9.2** (**AD11-D10**, jointly with AD-10's **AD10-D14**). The same applies to a P-10 lifecycle row written with its P-7 event. A reviewer-role change made in the IdP is case (b): enforced on the next action, logged when the backend learns of it.
- **Reviewer and submitter separation (provisional):** a reviewer cannot approve or refuse an item they submitted themselves (for example a `manual` entry, draft AD-5 §5); the rule compares (`iss`, `sub`) pairs, not reviewer references. Whether a single-person pilot may waive it, with a recorded waiver, is AD11-D9.

## 7. Review semantics (aligned with AD-12)

AD-12 **v0.3** (PR #31, merged into `feature/phase3-platform`, still DRAFT) §6.2 records these proposals as pending AD-11; this section is the proposal. AD-12 v0.3 §6.2 also records, as `[OPEN]`, **who reviews a quarantined FX observation and whether it can ever be released**, since `REVIEW_REQUIRED` applies only to announcements and extracted items. **This document does not answer that**: the queue-entry row below applies to whatever AD-4 §6 and AD-12 make reviewable.

| Item | Rule |
|---|---|
| Queue entry | Created when an item is quarantined with `REVIEW_REQUIRED` or another reviewable reason (AD-4 §6) |
| Outcome | `approved` → a new validated event in P-2 with `supersedes`; `refused` → an append-only refusal record with a reason code and the reviewer reference. Never an edit (AD-12 §6.2's open refusal question) |
| Knowledge layer | **No write** from any outcome without Gate 2 (D-4); an approval means "displayable", not knowledge (AD-4 §6) |
| Provider permission | An item from a provider is stored, reviewed and retained only as its Gate 3 terms allow (`retention_policy_ref`, draft AD-5 §2.2). Before Gate 3, only synthetic items exist (D-17) |

## 8. Retention

**Authority:** the project owner sets retention per family, bounded by each provider's Gate 3 terms; no deletion outside an approved policy. Proposed starting points `[#?]`:

| Family | Retention | Constraint |
|---|---|---|
| P-1 | Indefinite (research record) | Unchanged |
| P-2 observed | ≥ AD-2 replay window (24 h); longer only if Gate 3 terms allow. **Deleted** when its source's approved retention (`retention_policy_ref`, AD-5 §2.2) ends, or earlier if those terms require it | **Provider terms win**, including over the replay window: a term shorter than 24 h shortens AD-2 R-9 for that source |
| P-2 synthetic | 30 days | Test data; storage implication below |
| P-3, P-4 | 90 days | No payload in P-3; P-4 subject to §8.1 |
| P-5, P-10 | Indefinite | Audit of decisions; subject to §8.1 and AD11-D13 |
| P-6 | Same as its P-1 record (so indefinite while P-1 is) | Claim, not proof |
| P-7 | 90 days | AD-10 §6 |
| P-8 | Until expiry + 7 days | AD-10 §4.3 |
| **P-9** | **While the consumer is registered.** A position is one mutable row per consumer and is never history; the row is removed when the consumer is deregistered by an approved change | It is not an event record. A retained position older than P-2's retention answers "outside window" (§4); it is never a reason to retain P-2 |

**Who can delete what (owner finding 2).** v0.1 made observed P-2 retention provider-bound but gave **no role** the right to delete observed rows (§9 granted `cbdc_retention` DELETE on synthetic P-2, P-3 and P-4 only), so an expiring or withdrawn provider term **could not be honoured**. v0.2 extends `cbdc_retention` to observed P-2 rows past their source's approved retention (§9). Retention for observed data is a **per-source** value read from the registry, not one table-wide period, and a source's suspension or withdrawal never deletes history by itself (AD-5 v0.4 §2.4: deletion obligations arising from a provider's terms are AD-11's, and are a Gate 3 input).

**Storage implication of 30-day synthetic retention (owner minor finding).** AD-2 §9 sizes envelope bytes at ≈ 1.56 GB/day at 20 events/s and 900 B, **excluding** row overhead, indexes, WAL, TOAST and backups. If synthetic load ran continuously at that rate, 30 days would hold ≈ **46.7 GB** of envelope bytes before overhead, and AD-2 §9 states real usage is higher by an unmeasured factor. Synthetic load runs are bounded in practice, so this is a **ceiling**, not an estimate, but it sits on the same single host as Phase 2's database (F-6). Whether 30 days stands, is shortened, or is replaced by a **volume cap** (delete oldest synthetic runs past a size) is part of **AD11-D6**; this document records the arithmetic and does not choose.

Retention is executed only by a dedicated role (§9) through a scheduled job (milestone 3.7), and each run is logged as a P-7 event.

### 8.1 Retention dependencies and erasure (open)

**Review records outliving their evidence (Nisarga's finding 4).** P-5 is indefinite, while the P-4 item it reviewed is kept 90 days and an approval's new P-2 event is kept only as long as P-2's retention (30 days if synthetic; provider-bound if observed). Under v0.1's values a P-5 outcome would, within months, reference evidence that no longer exists. Options, **not decided here**:

| Option | Effect | Cost |
|---|---|---|
| (a) A reviewed P-4 item is retained as long as its P-5 outcome | Evidence stays resolvable | Conflicts with provider terms for observed items, and **provider terms win**, so (a) can never be absolute |
| (b) The P-5 outcome carries a **non-payload digest** of what was reviewed (`event_id`, `payload_sha256`, reason code, source, quarantine time); the evidence follows its own retention | The decision stays auditable and the evidence can be **verified** while it exists, but not re-read after it is gone | The reviewer's view cannot be reconstructed after deletion |
| (c) P-5 takes the retention of its evidence | Nothing dangles | Loses the audit of decisions, which is why P-5 was indefinite |

Provisional preference: **(b)**, because it is the only option that respects provider terms without losing the decision record. Decision **AD11-D12**. Whatever is chosen, **no deletion may leave a P-5 row pointing at a row it claims still exists**: a reference to deleted evidence is recorded as deleted-by-retention, not left to fail at read time.

**Retention permissions.** Deletion is a separate authority from writing (§9): `cbdc_retention` alone deletes, only whole rows, only past an approved period, only for families listed in §9, and each run is a P-7 event. **No role may delete P-1, P-5 or P-10.** Changing any retention value, or adding a family to `cbdc_retention`'s grants, is an owner-approved change.

**Reviewer-identity erasure (Nisarga's finding 5).** P-10 maps an opaque `rv_` reference to an IdP (`iss`, `sub`) pair. That pair identifies a person, so a future obligation to erase it can conflict with an indefinite, append-only audit. Requirements, **without** deciding whether or when erasure applies:

1. P-5 rows hold **only** the `rv_` reference, never (`iss`, `sub`), a name or an email (§6), so erasing a P-10 pair never requires touching P-5.
2. Erasure, if ever approved, removes or irreversibly redacts **only** the (`iss`, `sub`) pair of the affected P-10 rows. The `rv_` reference and the lifecycle rows stay, and become **unresolvable** to a person. That is the one sanctioned in-place change to an append-only family, so it needs a **dedicated privilege** that no runtime role holds today, and each use writes a P-7 event that names the `rv_` reference only.
3. After erasure, AD11-D9's self-review comparison can no longer be evaluated for that person's past actions; past outcomes are not re-judged.
4. **Who may request and approve erasure, under which policy, is not an engineering decision** and is left to the owner (**AD11-D13**). Until it is decided, no P-10 row is erased and no erasure privilege exists.

## 9. Roles and append-only enforcement

Builds on AD-10 §5.6, which defines the Phase 2 roles; this adds the Phase 3 families. **v0.2 matrix** — every row is a proposal; the rows marked *(v0.2)* answer the reviews and depend on the open decisions named:

| Role | P-1 | P-2, P-3, P-4 | P-5, P-6, P-10 | P-7 | P-8 | P-9 |
|---|---|---|---|---|---|---|
| `cbdc_owner` (migrate) | DDL | DDL | DDL | DDL | DDL | DDL |
| `cbdc_app` (backend, routing and review) | SELECT, INSERT | **—** *(v0.2, if AD11-D11 adopts the writer role; otherwise SELECT, INSERT as v0.1)* | SELECT, INSERT | **Through §9.2 only** *(v0.2, AD11-D10)* | ALL | — |
| `cbdc_obs_writer` *(v0.2, proposed, AD11-D11)* | **—** | SELECT, INSERT | — | — | — | SELECT (to answer "outside window") |
| `cbdc_review` *(v0.3, proposed, AD11-D15; §9.4)* | **—** | **SELECT** P-2 and P-4 (P-4 read-only); P-2 INSERT **only** under §9.4 option (a) | SELECT, INSERT on P-5 and P-10 | EXECUTE on the §9.2 function only | — | — |
| `cbdc_security_log` | — | — | — | INSERT | — | — |
| `cbdc_consumer` (a group role; §9.3) | — | SELECT (P-2, observed or synthetic per §3 separation) | — | — | — | SELECT, INSERT, UPDATE, **own row only** (§9.3) |
| `cbdc_retention` | — | DELETE past retention: P-2 synthetic, **P-2 observed past its source's approved retention** *(v0.2)*, P-3, P-4 (subject to §8.1) | **—** | DELETE past retention | DELETE expired | DELETE deregistered consumers' rows *(v0.2)* |
| `cbdc_seed` *(v0.2, listed; defined in AD-10 §5.6)* | INSERT, UPDATE on `User` only | — | — | — | — | — |
| Ingestion, inference | — | — | — | — | — | — |

- **What "append-only" means here:** no in-place modification by any role, and no deletion by the application. Two changes are still allowed, and neither is an edit: (1) **authorized retention deletion** of whole rows past an approved retention period, only by `cbdc_retention`, and each run logged as a P-7 event; (2) **identity and status changes** expressed as **new rows** (P-10 lifecycle, review outcomes, corrections), never as updates.
- **Append-only enforcement:** no UPDATE privilege for any runtime role on append-only families; DELETE only for `cbdc_retention`, on the families listed; a trigger that raises on UPDATE always, and on DELETE unless the current role is `cbdc_retention`, as a second line `[provisional]`.
- **Retention authority** is separate from writing: `cbdc_app` cannot delete; `cbdc_retention` cannot insert or update. P-1, P-5 and P-10 have no retention deletion (§8).
- The test database needs the same roles. **The Phase 2 backend integration tests cannot simply run as `cbdc_app`:** AD-10 v0.2 §5.6 (PR #33 at `a8fb24b`, open) found that the suite resets its tables with `TRUNCATE … CASCADE` through the same Prisma client (`services/backend/test/integration/transactions.test.ts:157-158`), which an INSERT-only role cannot do. The requirement is therefore: **the code under test connects as `cbdc_app`, and setup and cleanup use a separate, privileged fixture connection** that the application never holds. That is a test-harness change for the implementing milestone and is **not authorized here**. The same split applies to any test of the Phase 3 families. Whether Prisma Client's `create` needs only INSERT and SELECT remains **an assumption to test** (AD-10 §5.6).

### 9.1 Observation writes: privilege and failure isolation (Nisarga's finding 1)

**The conflict.** AD-3 v0.3 **H-6** requires observation rows to have "separate database privileges" from Phase 2 records, and **H-7** requires that an observation-storage failure — "the observation tables, their role or their writes fail while PostgreSQL still serves Phase 2" — leaves routing and Phase 2 records **unaffected**. v0.1 gave `cbdc_app` INSERT on both P-1 and P-2–P-4, so the routing path and the observation acceptance point shared **one role and, in practice, one connection pool**. Under that matrix an observation write storm, a lock wait on a P-2 index or an exhausted pool could block a routing write, and H-7's case (a) could not be demonstrated. AD-13 v0.3 **G4-2** already assumes the separation it needs: "the observation role cannot read or write Phase 2 tables and the reverse".

**Options evaluated** (decision **AD11-D11**, open):

| Option | Privilege isolation | Failure isolation | Cost |
|---|---|---|---|
| (a) Shared `cbdc_app` (v0.1) | **None**: one role writes both | **None**: shared pool, shared timeouts | None; fails H-6 and G4-2 |
| (b) Distinct `cbdc_obs_writer`, same pool | Yes: neither role can write the other's tables | **Partial**: pool exhaustion and lock waits still cross over | A second role and its grants |
| (c) Distinct `cbdc_obs_writer` with its **own connection pool** in the backend, its own pool size, `statement_timeout` and `lock_timeout` `[#?]` | Yes | **Yes, at the role, pool and timeout level**; not at the instance level (residuals below) | A second pool in one process; AD-1 §4 placement of the acceptance point |

**Provisional recommendation: (c).** It is the only option under which H-7's case (a) is testable, and it matches G4-2.

**Failure-isolation boundaries under (c):**

| Failure | Observation path | Routing and Phase 2 | Boundary that holds it |
|---|---|---|---|
| P-2 to P-4 writes fail (constraint, lock timeout, table missing) | Backend stops acknowledging; ingestion keeps entries until its buffer limit (AD-2 R-7, L-1); the source enters the **internal** `degraded` state, which is not a published source status (AD-2 L-1; AD-5 v0.4 §9.3) | **Unaffected** | Separate role, pool and timeouts; separate transactions (§4) |
| Observation pool exhausted | As above | **Unaffected**: routing uses its own pool | Separate pool |
| `cbdc_obs_writer` credentials revoked or wrong | As above | **Unaffected** | Separate credential |
| **Complete PostgreSQL outage** (AD-3 H-7 case b) | Stops | **Also affected**; outside the observation boundary and governed by Phase 2's readiness rules | None: **not claimed** |
| **Disk full, WAL pressure, `max_connections`, CPU or I/O saturation on the shared instance** | May stop | **May also be affected** | **None at role level.** These are instance-wide; only a separate database or host (**AD11-D1**) isolates them, and AD-2 §9 states observation volume is the dominant storage consumer. **Recorded as a residual, not solved here** |

**Not changed:** routing never waits on observation persistence (AD6-Q2); no observation write shares a transaction with a P-1 write; inference and ingestion hold no database credential (AD-6 B-5). **Acceptance:** §11 items 10 and 11.

### 9.2 Atomic P-5 + P-7 writes: an executable mechanism (Nisarga 3, owner 1; with AD-10)

**Why v0.1 could not execute.** §6 and AD-10 §6(a) require a review outcome (P-5), or a P-10 lifecycle row, and its security event (P-7) to commit in **one** transaction. v0.1's matrix gave `cbdc_app` no P-7 privilege, and AD-10 v0.1 §5.6 had `cbdc_security_log` used through "a separate connection or `SET ROLE`". A transaction belongs to one connection, so **a separate connection cannot share it**, and `SET ROLE` needs a role membership that neither document granted. The requirement was therefore unexecutable as written.

**Executable options** (all keep Q19: no P-1 row and no `AuditLog` row is ever in the transaction):

| Option | Mechanism, in one transaction on one connection | Separation kept | Cost or risk |
|---|---|---|---|
| (a) Role switch | `cbdc_app` is granted membership in `cbdc_security_log` (`NOINHERIT`); within the transaction: INSERT P-5 as `cbdc_app`, `SET LOCAL ROLE cbdc_security_log`, INSERT P-7, `RESET ROLE`, COMMIT | **Weakened**: `cbdc_app` can assume the logging role at any time and insert arbitrary security events (it still cannot update or delete them) | Role state on a pooled connection must be reset on every path, including errors; under Prisma this is raw SQL inside an interactive `$transaction` |
| (b) Direct grant | `cbdc_app` is granted INSERT on P-7 | **Weakened most**: the separate role becomes nominal | Simplest |
| (c) Definer function | A `SECURITY DEFINER` function owned by a non-login role holding INSERT on P-7, with a pinned `search_path` and a fixed, typed parameter list, is the **only** P-7 privilege `cbdc_app` holds (EXECUTE). The P-5 INSERT and the function call run in `cbdc_app`'s transaction | **Kept**: `cbdc_app` can write a security event only in the shape the function permits, and holds no table privilege on P-7 | The function is DDL under `cbdc_owner`, needs its own review and test, and is a privilege-escalation surface if `search_path` is not pinned |
| (d) Leave unresolved | State the atomicity requirement only | — | The requirement stays unexecutable; **§6 and AD-10 §6(a) cannot be accepted** until it is resolved |

**Provisional recommendation: (c)**, because it is the only option that is both atomic and keeps `cbdc_app` from holding P-7 table privileges. **Not decided:** **AD11-D10**, decided **jointly** with AD-10's **AD10-D14** so the two documents cannot diverge; Nisarga's review permits leaving the mechanism unresolved, and the owner's requires an executable one, so the choice between (c) and (d) is the owner's. Ordinary security events (AD-10 §6 default) are **not** affected: they stay outside every other transaction and use `cbdc_security_log` directly. **Acceptance:** §11 item 12.

### 9.4 The review path: reading quarantine and coordinating P-2, P-5 and P-7 (Nisarga, v0.2 re-review)

**The gap v0.2 left.** v0.2's table gives `cbdc_app` P-5 and P-10, and, under AD11-D11, gives P-2 to P-4 to `cbdc_obs_writer` alone. A reviewer therefore had **no defined way to read the P-4 item under review**, and an approval — which writes a **new P-2 event** (AD-4 §2, §6), a **P-5 outcome** and a **P-7 security event** (§6; AD-10 §6 case (a)) — spanned roles that v0.2 kept apart. §9.2 made P-5 + P-7 atomic, but said nothing about P-2.

**Guarantees required, whatever mechanism is chosen** (the mechanism itself stays provisional, AD11-D15):

| # | Guarantee |
|---|---|
| R-1 | **Read access.** The review module reads P-4, and the P-2 rows a reviewed item refers to, **read-only**. It never holds UPDATE or DELETE on P-4 or P-2, and never reads P-1. The synthetic/observed separation (§3; AD-2 R-14) applies to what a reviewer may see. `cbdc_obs_writer` keeps sole INSERT on P-3 and P-4, so the ingestion path is unchanged |
| R-2 | **All or nothing.** An **approval** leaves exactly one P-5 outcome, exactly one new P-2 event and exactly one P-7 event, or none of them. A **refusal** leaves exactly one P-5 outcome and one P-7 event and **no** P-2 row. No state persists in which P-5 says "approved" and the approved event can never appear, or the approved event exists with no outcome |
| R-3 | **One outcome per item.** A uniqueness constraint on the P-5 outcome's P-4 item reference. Two reviewers, or one reviewer retrying, can never record two outcomes for one item; the loser is answered `409` and writes nothing |
| R-4 | **Idempotent retry and partial-commit recovery.** A retry after an unknown result (timeout, lost connection) either finds the committed outcome through R-3 and returns it, writing nothing, or finds nothing and runs again in full. **No new event-identity rule is introduced:** the approved event is a new event whose `supersedes` names the reviewed event and whose timestamps copy it except `emitted_at` (AD-4 §2, §5). Its `event_id` is produced as the approved AD-4 contract and its drafts provide, and AD-11 neither derives nor changes it |
| R-5 | **No premature publication.** The approved event is not visible to replay, distribution, the stream hub or the current-value computation before the transaction that creates it commits. Current-value updates are driven only from **committed** P-2 rows, and gap-safe replay (§4) applies to it like any other row. A rolled-back approval is never displayed |
| R-6 | **Boundaries unchanged.** No P-1 row and no `AuditLog` row is in any review transaction, so Q19 is unchanged. No outcome writes to the knowledge layer without Gate 2 (§7). The routing path never waits on a review |

**Mechanism options** (decision **AD11-D15**, open):

| Option | How R-2 is met | R-4 | Privilege | Cost |
|---|---|---|---|---|
| (a) **One transaction, dedicated role.** `cbdc_review` reads P-4, inserts the P-2 event and the P-5 outcome, and calls the §9.2 function for P-7, all on one connection | Atomic commit | A retry after rollback starts clean; after commit, R-3 returns the existing outcome | `cbdc_review` holds INSERT on P-2, a second P-2 writer beside `cbdc_obs_writer` | Two P-2 writers; review writes share P-2's uniqueness and sequence rules |
| (b) **One transaction through a definer function.** `cbdc_app` (or `cbdc_review`) holds SELECT on P-4 and EXECUTE on an `approve_review` / `refuse_review` function that performs the P-2, P-5 and P-7 inserts with a pinned `search_path` and fixed parameters | Atomic commit | As (a) | **No** table privilege on P-2, P-5 or P-7 for the caller: the same pattern as §9.2 option (c) | A larger privileged function under `cbdc_owner`, needing its own review and test |
| (c) **Recoverable coordination.** One transaction records the P-5 outcome as `approved — publication pending` with its P-7 event and the approved event's full envelope; `cbdc_obs_writer` then inserts the P-2 event in a second transaction, and a reconciler retries any pending outcome until the P-2 row exists | **Eventually**: a pending outcome is never displayed as published, and the reconciler completes it | The P-2 insert is idempotent on `event_id`, which was fixed in the pending outcome, so a reconciler retry is a duplicate, not a second event | Keeps P-2 with `cbdc_obs_writer` alone | A reconciler, a pending state and a monitored backlog; more moving parts |

**Provisional preference: (b)**, because it meets R-2 by an atomic commit and keeps every caller free of P-2, P-5 and P-7 table privileges, consistent with §9.2's preference. **Not decided here.** If (a) or (b) is chosen, the §9.2 function, or a new one, must be callable by the review path, and AD-10 v0.2 §6.1 — which names `cbdc_app` as the caller — must be aligned in the same change. Under every option a refusal writes no P-2 row.

### 9.3 Remaining role definitions and consumer row isolation (Nisarga 7; owner minor)

- **`cbdc_consumer` is a group role, never a login.** Each server-side consumer (≤ 3, AD-2 R-11) has its own login role that is a member of it. PostgreSQL has no row ownership, so v0.1's "own rows" was not enforceable by grants alone. **Proposal:** **row-level security** on P-9 with a policy `USING (consumer_name = current_user) WITH CHECK (consumer_name = current_user)`, P-9 owned by `cbdc_owner`, and no consumer role ever an owner (owners bypass row-level security unless it is forced). A consumer can then read and advance only its own position, and cannot read another's lag. **Acceptance:** §11 item 13.
- **Observed-only consumers** read P-2 through the observed partition or schema only (§3 separation; AD-2 R-14), not through a filter they could omit.
- **`cbdc_seed`** (AD-10 §5.6): INSERT and UPDATE on `User` only, used by development seeding (`services/backend/src/db/seedDevUsers.ts:34`), **never present in the pilot build**, and never granted any Phase 3 family. v0.1 omitted it from this matrix.
- **`cbdc_obs_writer`** (§9.1) and the **erasure privilege** (§8.1) are the only new privileged definitions in v0.2. Neither exists, and the erasure privilege is not proposed for creation until AD11-D13 is decided.
- **`cbdc_retention`** cannot INSERT or UPDATE anything; it deletes whole rows only (unchanged).

## 10. Backup, recovery and integrity

- **Backup:** P-1, P-2, P-5, P-10 in the PostgreSQL backup; recovery objectives from AD-8 (draft §8 states none for observations yet: AD-2 X-2). P-8 need not be restored (sessions are re-created).
- **Integrity evidence:** `payload_sha256` of each P-2 row is re-verified on read in tests (draft AD-4 Part 2 X-5); a periodic job compares row counts and a hash chain or per-day digest `[provisional]` and records the result as a P-7 event.
- **Restore drill:** restore into a scratch database; every P-2 row validates and hashes identically; no P-1 row links to P-2.

## 11. Acceptance criteria

1. UPDATE or DELETE on an append-only family as `cbdc_app` fails; the Phase 2 suites pass with the **code under test connected as `cbdc_app`** and their setup and cleanup (`TRUNCATE`) on a **separate privileged fixture connection** (§9; AD-10 v0.2 §5.6).
2. Redelivery leaves exactly one P-2 row per `event_id`; a conflict writes a P-3 record.
3. No foreign key, join or view links P-2–P-6 to P-1 except P-6 → P-1 (draft AD-6 Part 2 T-14).
4. A 401 writes a P-7 event and **no** `AuditLog` row (Q19).
5. A missing or failed P-6 write leaves engine requests, responses and `decision_id` identical (AD-6 T-9).
6. An observed-only query returns zero synthetic rows.
7. A refusal and an approval each create new rows; nothing is updated.
8. A retention run deletes only past-retention rows of allowed families, **including observed P-2 rows past their source's approved retention and no others**, and logs itself.
9. **Gap-safe replay:** a concurrent-writer fixture in which the lower storage sequence commits last, with a consumer replaying throughout, delivers both rows exactly once (§4; AD-2 §5.3).
10. **Privilege isolation (if AD11-D11 adopts (b) or (c)):** connected as `cbdc_obs_writer`, every read or write on P-1 fails; connected as `cbdc_app`, every write on P-2 to P-4 fails (AD-13 G4-2).
11. **Failure isolation (if (c)):** with observation writes failing, the observation pool exhausted, or `cbdc_obs_writer`'s credential revoked, AD-6 T-1's routing requests give identical responses and `decision_id`s, and Phase 2 suites pass (AD-3 H-7 case a). Instance-wide failures are not claimed (§9.1).
12. **Atomic review write (per AD11-D10):** with P-7 unavailable, a review outcome is refused with no P-5 row left; with P-5's insert failing, no P-7 row is left; `cbdc_app` holds no P-7 table privilege under option (c).
13. **Consumer row isolation:** a consumer cannot read or update another consumer's P-9 row.
14. **Review read access (§9.4 R-1):** the review path can read a P-4 item and cannot update or delete any P-4 or P-2 row, nor read any P-1 row.
15. **Failure between writes (R-2):** with a failure injected after the P-2 insert, after the P-5 insert, and at the P-7 call in turn, an approval leaves **either all three rows or none**; under option (c), a pending outcome with no P-2 row is completed by the reconciler and is never displayed as published meanwhile.
16. **Concurrent and repeated approval (R-3, R-4):** two simultaneous approvals of one item leave one outcome and one P-2 event (the other `409`); a retry after a committed approval whose response was lost returns the existing outcome and writes nothing; a retry after a rolled-back approval completes once.
17. **No premature publication (R-5):** while the approval transaction is open, and after it rolls back, no consumer replay, stream `update` or current value shows the approved event.
18. **Refusal (R-2):** a refusal leaves one P-5 outcome and one P-7 event and no P-2 row.
19. **Boundaries (R-6):** no review transaction contains a P-1 or `AuditLog` row, and feasibility is byte-identical before and after an approval (AD-6 Part 2 T-18).

## 12. Decisions

| # | Decision | Alternatives | Recommendation | Depends on | Approver | Evidence |
|---|---|---|---|---|---|---|
| AD11-D1 | Physical placement of P-2–P-10 | Same database and schema; separate schema; separate database | **Separate schema in the same PostgreSQL**, provisional | AD-3 | Owner, Dev A, Dev D | §11 items 3, 6 |
| AD11-D2 | Append-only enforcement | Convention; privileges; privileges + triggers | **Privileges + triggers** | AD10-D10 | Owner | §11 item 1 |
| AD11-D3 | Reviewer reference | Name; IdP subject; opaque mapped ID | **Opaque mapped ID** (§6) | AD10-D3, AD4-Q7 | Owner, Dev A | P-10 tests |
| AD11-D4 | Refusal records | Edit status; new record | **New record** (§7) | AD-12 | Owner, Dev D | §11 item 7 |
| AD11-D5 | Synthetic/observed separation | Column; table or schema + roles | **Table or schema + roles** | AD-4 §3.2 | Owner | §11 item 6 |
| AD11-D6 | Retention values | §8 | **§8 provisional**; owner authority; Gate 3 bound | Gate 3, AD-2 | Owner | Retention test |
| AD11-D7 | Security-event and session storage | §3 P-7, P-8 | **As AD-10 §6, §4** | AD-10 | Owner | §11 item 4 |
| AD11-D8 | Audit `action`/`outcome` values | Keep provisional; finalize | **Finalize** with Phase 3 additions in one approved change | Phase 2 open item | Owner | Schema CHECK |
| AD11-D9 | Reviewer and submitter separation | Required; required with a recorded single-person waiver; not required | **Required, waivable only by a recorded owner waiver** (provisional) | Team size; AD-12; **AD-10 §5.7** | Owner, Dev D | A self-review attempt is refused and logged as a P-7 event |
| **AD11-D10** | **Atomic P-5/P-10 + P-7 mechanism** (§9.2) | (a) role switch; (b) direct grant; (c) definer function; (d) unresolved | **(c), provisional**; decided **jointly with AD10-D14** | AD-10 §5.6, §6 | Owner, Dev A, Dev D | §11 item 12 |
| **AD11-D11** | **Observation writer role** (§9.1) | (a) shared `cbdc_app`; (b) distinct role; (c) distinct role, own pool and timeouts | **(c), provisional** | AD-3 H-6, H-7; AD-1 §4; AD11-D1 | Owner, Dev B, Dev D | §11 items 10, 11 |
| **AD11-D12** | **Reviewed-evidence retention** (§8.1), and observed P-2 deletion authority (§8) | (a) keep reviewed evidence with P-5; (b) non-payload digest in P-5; (c) P-5 follows its evidence | **(b), provisional**; observed P-2 deletable by `cbdc_retention` per source | Gate 3; AD-5 `retention_policy_ref`; AD11-D6 | Owner, Dev D | §11 item 8; a P-5 row whose evidence was deleted resolves as "deleted by retention" |
| **AD11-D13** | **Reviewer-identity erasure** (§8.1) | Never; on approved request, redacting only P-10's (`iss`, `sub`) | **Open — no recommendation.** Policy, requester and approver are not engineering decisions | Owner policy | Owner | None until decided; no erasure privilege exists |
| **AD11-D15** | **Review-path coordination** (§9.4) | (a) one transaction, `cbdc_review` writes P-2; (b) one transaction through a definer function; (c) recoverable coordination with a reconciler | **(b), provisional**; R-1 to R-6 required under every option | AD11-D10, AD10-D14, AD11-D11; AD-4 §2, §6; AD-12 §6.2 | Owner, Dev A, Dev D | §11 items 14 to 19 |
| **AD11-D14** | **Gap-safe replay mechanism** (§4) | Watermark or lag bound; in-flight snapshot; commit-serialized assignment; set-valued position | **Open — no recommendation**; same decision as AD-2 **AD2-D8** | AD-3, AD-2 | Owner, Dev B, Dev D | §11 item 9 |

## 13. Conflicts and open dependencies

| ID | With | Item |
|---|---|---|
| C11-1 | Draft AD-4 Part 2 (PR #30) | States the store is "PostgreSQL via Prisma (AD-11)"; here provisional (AD11-D1) |
| C11-2 | AD-8 **v0.5** §8.1, §6.1a (PR #30, `730f75a`) | No observation recovery objective yet. **Path agreed in the drafts, still open:** AD-8 v0.5 §8.1 adopts AD-2's R-7 buffer and R-9 replay window as the source of its objective once AD-2 and AD-3 are approved, and §6.1a's accounting identity matches AD-2 §7. The objective, when it exists, bounds §10's backup and restore drill for P-2 |
| C11-3 | AD-5 **v0.4** §8.1, §8.2, §8.2a (PR #30, `730f75a`) | **Resolved in the draft, pending AD-5's approval:** v0.1's single key is replaced by `observation_key` and `idempotency_key`; §4 is aligned to them (AD-2 X-3). v0.4 adds §8.2a: a correction carrying a validated `supersedes` is **not** a C-a conflict, consistent with §4's refusal to make `observation_key` a uniqueness constraint and with §5. **AD5-Q11** (C-a keyed on payload hash, the slice's row on `event_id` inequality) is open and does not change §4 |
| C11-4 | AD-12 **v0.3** §6.2 (PR #31, merged into `feature/phase3-platform`, still DRAFT) | **Corrected.** v0.3 marks reviewer format, review-queue persistence, retention and synthetic/observed separation `[PENDING: AD-11 approval]`; refusal recording `[OPEN]` until AD-11 is approved; and **reviewer authorization and separation of duties `[PENDING: AD-10, AD-11]`**, with four open questions: who may review, whether a reviewer may review an item **they submitted or caused to be submitted**, whether a **second reviewer** is required for some categories, and how an authenticated identity maps to the reference. §6 answers the identity mapping and the self-review rule (AD11-D9) as proposals; AD-10 §5.7 holds the role model; **the second-reviewer question is unanswered here**, and so is AD-12's `[OPEN]` **release of quarantined FX observations** (§7) |
| C11-5 | AD-12 **v0.3** §3.1 (PR #31) | **Corrected.** Two identity gaps, both open for AD-5/AD-12, both become persistence conflicts under §4: (1) the C-1 residual, overlapping runs with the same seed and timestamps but a different `case_id` or `generator_version`; (2) the derivation contains **no source identity**, so two synthetic sources, or a slice run and a load run, collide too. v0.1 recorded only (1) |
| C11-6 | AD-13 **v0.3** §3.3 (PR #31) | **Corrected — v0.1's claim was wrong.** AD-13 v0.3 already requires **G4-1** (separate security-event logging preserving Q19, a rejected request leaving no audit row and a security-event record) and **G4-2** (each role verified: the observation role cannot read or write Phase 2 tables and the reverse; append-only tables refuse update and delete; review and refusal records append-only), both `[DEP: AD-10, AD-11]`, plus **G4-5** (owner-controlled `main` protection). Remaining alignment: G4-2 assumes a distinct observation role, which this document now proposes (§9.1, AD11-D11) rather than has; AD-13 can cite §11 items 1, 4, 7, 10 and 12 as G4-1 and G4-2's tests once approved |
| **C11-7** | AD-3 **v0.3** H-6, H-7 | Separate observation privileges and an observation-storage failure that leaves routing unaffected; v0.1's shared `cbdc_app` met neither. §9.1, AD11-D11 |
| **C11-8** | AD-3 **v0.3** H-3; AD-2 R-4 | A storage sequence does not give gap-safe replay. §4, AD11-D14, AD2-D8 |
| **C11-9** | AD-10 **v0.1** §5.6, §6(a) | "Separate connection or `SET ROLE`" for `cbdc_security_log` cannot share the P-5/P-7 transaction. §9.2; joint decision AD11-D10 / AD10-D14 (AD-10 v0.2 updated to match) |

## 14. Approval checklist

- [ ] Dev A: §4, §6, §7 (Stage 1E and AD-4 consistency)
- [ ] Dev D: §3, §9, §9.1 to §9.4, §10 (operations, roles, backup)
- [ ] Project owner: AD11-D1 to **AD11-D15**. **No migration before approval.**
