# AD-11: Audit Trail and Persistence Proposal

**Status:** **DRAFT v0.1 for review. Not approved.** 26 November 2026. A **proposal**: no migration, schema change or role change is made or authorized until it is approved (scope §7.3). Physical storage and schema choices are **provisional**. New numbers are `[#?]`.
**Lead:** Dev B. **Reviewers:** Dev A, Dev D. **Approver:** project owner.
**Inputs:** AD-3 (draft v0.2, PR #31), AD-4 v0.2 (approved for the D-24 slice only), AD-10 (draft). **Feeds:** milestones 3.2, 3.7. **Coordinates with:** AD-2, AD-5, AD-7, AD-12, Gate 3.
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
| P-6 | **Browser-context claims** (AD-7 §8) | Append-only | Backend | Points **to** a P-1 record; never the reverse (AD-6 §6.1) |
| P-7 | **Security events** (AD-10 §6) | Append-only for the application; deleted only by retention | Backend | None |
| P-8 | **Sessions** (AD-10 §4) | **Mutable** (create, refresh, delete) | Backend | User |
| P-9 | **Consumer positions** (AD-2 R-9) | **Mutable** (advance only) | Each consumer | P-2 sequence |
| P-10 | **Reviewer identities** (§6) | Append-only mapping; deactivation is a new row | Backend, from the IdP | P-5 |

- **Separation (AD-4 §3.2; AD-2 R-14):** synthetic and observed events are kept so that an observed-only query cannot return synthetic ones: a `provenance_class` column is **not enough** by itself; proposed: separate tables or a schema per class, plus read roles that can see only observed rows `[provisional]`.
- **Physical store:** PostgreSQL is the **first candidate** (backend already uses it; AD-3 v0.2 §5.1). Whether P-2 to P-7 share the Phase 2 database, use a separate schema, or a separate database is **AD11-D1**, open until AD-3 is approved. Draft AD-4 Part 2 lists "PostgreSQL via Prisma (AD-11)" as the store; that is not decided here.
- **No direct ingestion database access.** Ingestion holds no credential and no route to PostgreSQL (AD-1 §3.6; AD-6 B-5). Any change needs a separate owner approval and new T-5 evidence.

## 4. Durable acceptance and idempotent persistence

- **Acceptance (AD-2 §4, R-6), mechanism-neutral:** an event is accepted when the acceptance point has validated it and **durably committed** it to P-2, and only then acknowledges it to its producer. This document does not choose the mechanism (AD-3 does). **Under the PostgreSQL proposal** (AD-3 v0.2 §5.1, H-5, unapproved), the acceptance point is the backend and "committed" means a committed PostgreSQL transaction on the P-2 table.
- **Idempotency (AD-2 R-8):** a uniqueness constraint on `event_id` (the persistence identity); a redelivery with identical content is a no-op; different content is a conflict recorded in P-3 and counted. **Known limit (PR #31 AD-12 v0.2 §3.1; AD-1 §3.4.1 C-1 residual):** overlapping synthetic runs with the same seed and timestamps but a different `case_id` or `generator_version` derive the same `event_id`; under this rule the second is stored as a conflict, not as a distinct event. Whether the synthetic identity changes is AD-5's and AD-12's; until then such runs must not share a seed (AD-2 §7).
- **Semantic deduplication:** AD-5's key, applied as a second constraint or check **only once AD-5 is approved**; null-timestamp sources follow AD-5 (draft: `within_run`) `[DEP: AD-5]`.
- **Storage sequence:** assigned at commit, monotonic per store; it orders replay (AD-2 R-4; AD-3 v0.2 H-3). It is not an envelope field.
- **Consumer positions (P-9):** a consumer advances its position only after processing; a position older than the retention of P-2 is reported as "outside window" (AD-2 R-9).
- **Separation from routing:** an observation write never shares a transaction with a P-1 write; routing never waits on it (AD6-Q2; AD-3 v0.2 H-6, H-7).

## 5. Correction history

- A correction is a **new** P-2 row with `supersedes` (AD-4 §2). The superseded row is never updated or deleted.
- "Current value" is derived at read time (AD-2 R-4, §6), never stored as a mutable flag on P-2.
- A review approval is a new event (AD-4 §6) recorded in P-2 and linked from its P-5 outcome.

## 6. Reviewer references

AD-4 §2: the `review` field holds an opaque internal ID, not a name or email (AD4-Q7 open).

- **Proposed format:** `rv_` + a UUIDv4 (`[provisional]`), issued once per human reviewer in P-10.
- **Link to identity:** P-10 maps the reference to the **pair** (IdP issuer `iss`, subject `sub`) of an authenticated user (AD-10 §4). `sub` is unique only within its issuer, so the pair, never `sub` alone, is the key. Names and emails are not stored in P-10; they stay in the IdP.
- **Lifecycle (append-only, as new P-10 rows):** *issued* when the reviewer role is first granted; *deactivated* when it is removed or the user leaves; *re-linked* when the same person's (`iss`, `sub`) changes (for example an IdP migration), which is a privileged change (AD-10 §6, fail closed) recorded as a new row naming both pairs. A reference is never reused or reassigned; past references stay resolvable for audit.
- **Authorized:** only a user holding the reviewer role **at the time of the action** can create P-5 outcomes; the check runs per action, not per session start (PR #31 AD-12 v0.2 §6.2 leaves reviewer authorization `[DEP: AD-10]`; this is the proposal). The P-5 outcome and its P-7 security event are written in one transaction, as a database-backed privileged mutation (AD-10 §6, case (a); AD10-D12). That transaction contains no P-1 record and no `AuditLog` row, so Q19 is unchanged. A reviewer-role change made in the IdP is case (b): enforced on the next action, logged when the backend learns of it.
- **Reviewer and submitter separation (provisional):** a reviewer cannot approve or refuse an item they submitted themselves (for example a `manual` entry, draft AD-5 §5); the rule compares (`iss`, `sub`) pairs, not reviewer references. Whether a single-person pilot may waive it, with a recorded waiver, is AD11-D9.

## 7. Review semantics (aligned with AD-12)

AD-12 v0.2 (PR #31) §6.2 records these proposals as pending AD-11; this section is the proposal.

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
| P-2 observed | ≥ AD-2 replay window (24 h); longer only if Gate 3 terms allow | Provider terms win |
| P-2 synthetic | 30 days | Test data |
| P-3, P-4 | 90 days | No payload in P-3 |
| P-5, P-10 | Indefinite | Audit of decisions |
| P-6 | Same as its P-1 record | Claim, not proof |
| P-7 | 90 days | AD-10 §6 |
| P-8 | Until expiry + 7 days | AD-10 §4.3 |

AD-2 §9 sizes P-2 at about 1.56 GB/day of envelope bytes at 20 events/s (excluding overhead). Retention is executed only by a dedicated role (§9) through a scheduled job (milestone 3.7), and each run is logged as a P-7 event.

## 9. Roles and append-only enforcement

Builds on AD-10 §5.6, which defines the Phase 2 roles; this adds the Phase 3 families.

| Role | P-1 | P-2–P-6, P-10 | P-7 | P-8 | P-9 |
|---|---|---|---|---|---|
| `cbdc_owner` (migrate) | DDL | DDL | DDL | DDL | DDL |
| `cbdc_app` (backend) | SELECT, INSERT | SELECT, INSERT | — | ALL | — |
| `cbdc_security_log` | — | — | INSERT | — | — |
| `cbdc_consumer` | — | SELECT (P-2) | — | — | SELECT, INSERT, UPDATE (own rows) |
| `cbdc_retention` | — | DELETE past retention (P-2 synthetic, P-3, P-4) | DELETE past retention | DELETE expired | — |
| Ingestion, inference | — | — | — | — | — |

- **What "append-only" means here:** no in-place modification by any role, and no deletion by the application. Two changes are still allowed, and neither is an edit: (1) **authorized retention deletion** of whole rows past an approved retention period, only by `cbdc_retention`, and each run logged as a P-7 event; (2) **identity and status changes** expressed as **new rows** (P-10 lifecycle, review outcomes, corrections), never as updates.
- **Append-only enforcement:** no UPDATE privilege for any runtime role on append-only families; DELETE only for `cbdc_retention`, on the families listed; a trigger that raises on UPDATE always, and on DELETE unless the current role is `cbdc_retention`, as a second line `[provisional]`.
- **Retention authority** is separate from writing: `cbdc_app` cannot delete; `cbdc_retention` cannot insert or update. P-1, P-5 and P-10 have no retention deletion (§8).
- The test database needs the same roles.

## 10. Backup, recovery and integrity

- **Backup:** P-1, P-2, P-5, P-10 in the PostgreSQL backup; recovery objectives from AD-8 (draft §8 states none for observations yet: AD-2 X-2). P-8 need not be restored (sessions are re-created).
- **Integrity evidence:** `payload_sha256` of each P-2 row is re-verified on read in tests (draft AD-4 Part 2 X-5); a periodic job compares row counts and a hash chain or per-day digest `[provisional]` and records the result as a P-7 event.
- **Restore drill:** restore into a scratch database; every P-2 row validates and hashes identically; no P-1 row links to P-2.

## 11. Acceptance criteria

1. UPDATE or DELETE on an append-only family as `cbdc_app` fails; the Phase 2 suites pass as `cbdc_app`.
2. Redelivery leaves exactly one P-2 row per `event_id`; a conflict writes a P-3 record.
3. No foreign key, join or view links P-2–P-6 to P-1 except P-6 → P-1 (draft AD-6 Part 2 T-14).
4. A 401 writes a P-7 event and **no** `AuditLog` row (Q19).
5. A missing or failed P-6 write leaves engine requests, responses and `decision_id` identical (AD-6 T-9).
6. An observed-only query returns zero synthetic rows.
7. A refusal and an approval each create new rows; nothing is updated.
8. A retention run deletes only past-retention rows of allowed families and logs itself.

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
| AD11-D9 | Reviewer and submitter separation | Required; required with a recorded single-person waiver; not required | **Required, waivable only by a recorded owner waiver** (provisional) | Team size; AD-12 | Owner, Dev D | A self-review attempt is refused and logged as a P-7 event |

## 13. Conflicts and open dependencies

| ID | With | Item |
|---|---|---|
| C11-1 | Draft AD-4 Part 2 (PR #30) | States the store is "PostgreSQL via Prisma (AD-11)"; here provisional (AD11-D1) |
| C11-2 | AD-8 draft §8.1 | No observation recovery objective; AD-2 durability direction needs one |
| C11-3 | AD-5 draft §8.1 | Idempotency key and conflict definition (AD-2 X-3) |
| C11-4 | AD-12 v0.2 §6.2 | Waits on this document for reviewer format, persistence, retention, refusals and reviewer authorization; §6–§8 answer them as proposals |
| C11-5 | AD-12 v0.2 §3.1 (PR #31) | Synthetic `event_id` collisions across overlapping runs become persistence conflicts under §4; open for AD-5/AD-12 |
| C11-6 | AD-13 v0.2 Gate 4 row (PR #31) | Names the routing audit trail but not the append-only enforcement, role split or P-7 evidence (§11 items 1, 4); AD-13 to reference §11 |

## 14. Approval checklist

- [ ] Dev A: §4, §6, §7 (Stage 1E and AD-4 consistency)
- [ ] Dev D: §3, §9, §10 (operations, roles, backup)
- [ ] Project owner: AD11-D1 to AD11-D9. **No migration before approval.**
