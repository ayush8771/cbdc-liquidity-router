# Phase 3 Milestone 3.1 — Architecture Work Plan

**Status:** **Approved in part**, last updated 25 November 2026. The project owner approved, on **25 November 2026**:

- the **AD-1 component view v0.5**, **AD-4 v0.2** and **AD-6 v0.2**, **for the D-24 slice only** (scope §2.2.3), on Dev B's, Dev C's and Dev D's approvals of AD-1 v0.5 and Dev A's technical approval of its ingestion contract, four FX pairs, ordering and quarantine rules and shared hash fixtures;
- **D-25**, the D-24-only inference-network isolation exception (AD-6 **B-4 unresolved**, closed by AD-10; T-5 ingestion-side only).

On **24 November 2026** the project owner approved:

- the first decisions F-1 to F-6 (§2);
- the deliverable leads (§3; scope D-21);
- the second-reviewer rule (§1; scope D-20);
- the AD-1 component view as a precondition of every code milestone (§3; scope D-22);
- the reviewers of AD-2, AD-5 and AD-12 (§3; scope D-23).

The sequence in §4 is a plan, not a decision.
**Milestone state:** 3.1 has **begun**. Wave 0 (the first decisions) is complete. The **AD-1 component view v0.5, AD-4 v0.2 and AD-6 v0.2 are approved by the project owner for the D-24 slice only** (25 November 2026; scope §2.2.3), which authorizes the D-24 slice and no milestone. The other deliverables are not written yet. The component view's §4 placement of later components is **not confirmed**, so **D-22 is not satisfied for milestones 3.2–3.7** and none of them may begin. **No gate has passed.**
**Scope source:** `docs/PHASE3_SCOPE.md` v1.4, which records the decisions (§2.2, §2.3), the D-24 implementation authorization and D-25 (§2.2.3), and the approved deliverable list (§7.3).
**Boundaries:** milestone 3.1 produces documents and schemas only. It writes no application code, changes no Compose file or database, installs no broker, leaves API contract v0.4 and the Phase 1 files unchanged, and uses no provider data before that provider has passed Gate 3 (D-17).

**Drafts added on 26 November 2026, none reviewed and none approved:** AD-5 (`docs/PHASE3_AD5_ADAPTER_CONTRACT.md`) and AD-8 (`docs/PHASE3_AD8_BUDGETS.md`), which were not written before; and three **additive companion** documents that extend the D-24-slice deliverables to full Phase 3 without altering them — `docs/PHASE3_AD1_ARCHITECTURE.md`, `docs/PHASE3_AD4_ENVELOPE_PART2.md` and `docs/PHASE3_AD6_ISOLATION_PART2.md`. The approved AD-1 component view **v0.5**, AD-4 **v0.2** and AD-6 **v0.2** are **unchanged**, because each approval is version-specific and revising those files would need fresh review before the D-24 slice could continue on them. **AD-6 B-4 stays unresolved** and is closed by AD-10. No milestone is authorized and **no gate has passed.**

## 1. Roles

| Role | Who | In this plan |
|---|---|---|
| Project owner | Accountable approver of every deliverable and every gate (D-18); also holds the Dev A role | Approves each AD |
| Dev A | Inference service and FastAPI; owner of the new Python ingestion component (F-2) | AD-4, AD-5, AD-6, AD-8 |
| Dev B | Express, Prisma, auth, audit log | AD-2, AD-7, AD-10, AD-11 |
| Dev C | React frontend | AD-9 |
| Dev D | Contracts, infrastructure, CI, E2E | AD-1, AD-3, AD-12, AD-13 |

The roles are those of `PHASE2_ARCHITECTURE.md` §3. The **lead** writes the deliverable; the **reviewers** give technical review before the owner approves it. **Second-reviewer rule (D-20):** where the lead is also the approver (the Dev A deliverables), at least one other team member reviews.

## 2. First decisions (approved 24 November 2026)

| # | Decision | Feeds |
|---|---|---|
| **F-1** | A code milestone may begin after its own required 3.1 deliverables are approved, subject to its other dependencies and to the gates. Tightened by scope D-22: the AD-1 component view must also be approved. | Every code milestone |
| **F-2** | A separate Python ingestion component, owned by Dev A, outside the inference service and outside Express request handling. | AD-1, AD-5, AD-12 |
| **F-3** | Express terminates the authenticated browser update channel; WebSocket or SSE is chosen in AD-7. | AD-7, AD-10 |
| **F-4** | FX rates are the first candidate live-data category. No provider is approved. | AD-2, AD-5 |
| **F-5** | Provisional targets: event-to-display p95 ≤ 1 s; reconnect p95 ≤ 5 s; a synthetic source's value is stale after three expected update intervals. Provider-specific freshness and the remaining budgets are finalized in AD-8. | AD-2, AD-8, AD-9 |
| **F-6** | Local Docker development first; design for a controlled, single-host, containerized pilot, with no external exposure before Gate 4. | AD-3, AD-10 |

## 3. Deliverables, leads and dependencies

Leads are approved (D-21). The reviewers of AD-2, AD-5 and AD-12, which were adjusted after their leads changed, are confirmed (D-23).

| # | Deliverable | Lead | Reviewers | Needs first | Unblocks |
|---|---|---|---|---|---|
| AD-1 | Phase 3 architecture document (component view **v0.5 approved 25 Nov 2026 for the D-24 slice only**: `docs/PHASE3_AD1_COMPONENT_VIEW.md`; §4 placement unconfirmed) | Dev D | Dev A, B, C | Component view: F-2, F-3. Final version: all other ADs. | Component view: every code milestone (3.2–3.7) and AD-10. Final version: the integrated architecture. |
| AD-2 | Streaming requirements | Dev B | Dev A, Dev D | F-4, F-5 | AD-3; milestone 3.4 |
| AD-3 | Streaming mechanism decision record | Dev D | Dev B (the PostgreSQL option) | AD-2, F-6 | AD-11; milestone 3.4 |
| AD-4 | Event envelope and provenance schema (**v0.2 approved 25 Nov 2026 for the D-24 slice only**: `docs/PHASE3_AD4_EVENT_ENVELOPE.md`) | Dev A | Dev B, C, D | — | AD-5, AD-7, AD-9, AD-11, AD-12; milestone 3.3 |
| AD-5 | Source adapter contract (**DRAFT v0.4, 26 Nov 2026, in review**: `docs/PHASE3_AD5_ADAPTER_CONTRACT.md`) | Dev A | Dev B, Dev D | F-2, F-4, AD-4 | AD-12; milestone 3.3 |
| AD-6 | Live-data-to-engine boundary (**v0.2 approved 25 Nov 2026 for the D-24 slice only**, subject to D-25, B-4 unresolved: `docs/PHASE3_AD6_ENGINE_BOUNDARY.md`) | Dev A | Dev B, Dev C | — (records D-9 and D-15) | AD-9; milestone 3.5 |
| AD-7 | Real-time channel contract | Dev B | Dev C, Dev D | F-3, AD-4, AD-10 | Milestone 3.5 |
| AD-8 | Non-functional budgets (**DRAFT v0.5, 26 Nov 2026, in review**: `docs/PHASE3_AD8_BUDGETS.md`) | Dev A | Dev B, C, D | F-5, F-6 | AD-9; milestones 3.5, 3.7; exit criterion 9 |
| AD-9 | Fallback and degradation spec | Dev C | Dev A, Dev B | AD-4, AD-6, AD-8 | Milestone 3.5 |
| AD-10 | Threat model and exposure plan | Dev B | Dev C, Dev D | F-3, F-6, AD-1 component view | AD-7, AD-11; milestone 3.2; the Gate 4 checklist |
| AD-11 | Audit trail and persistence proposal | Dev B | Dev A, Dev D | AD-3, AD-4, AD-10 | Milestones 3.2 and 3.7 |
| AD-12 | Synthetic event harness and review-queue spec | Dev D | Dev A (Stage 1E rules), Dev B (review-queue persistence) | AD-4, AD-5 | Milestones 3.3, 3.4, 3.6 |
| AD-13 | Test strategy and gate evidence templates | Dev D | Dev A, B, C | Gate templates: none (scope §5). Test strategy: all other ADs. | All gates; the 3.1 exit |

**Every code milestone (3.2–3.7) first needs the AD-1 component view, approved by the project owner after review by Dev A, B and C (D-22).** Beyond that, under F-1, each needs only the deliverables listed for it in scope §7.1:

| Milestone | Required deliverables |
|---|---|
| 3.2 | AD-1 component view, AD-10 |
| 3.3 | AD-1 component view, AD-4, AD-5, AD-12 |
| 3.4 | AD-1 component view, AD-2, AD-3 |
| 3.5 | AD-1 component view, AD-6 to AD-9 |
| 3.6 | AD-1 component view, AD-12 |
| 3.7 | AD-1 component view. Depends on 3.2; uses AD-8 and AD-11 |

**D-24 slice** (scope §2.2.2, §2.2.3): needed the AD-1 component view, AD-4 and AD-6 only. **All three are approved (25 November 2026) and the slice is authorized**, under D-25's limits. It is not a milestone and changes no row above: every milestone 3.2–3.7 still waits on the owner's confirmation of the component view's §4 placement, plus its own deliverables and gates.

The final AD-1 is not a precondition of any code milestone. AD-10 also needs the component view.

## 4. Sequence

| Wave | Work | Starts when |
|---|---|---|
| **0** | Decisions F-1 to F-6 | **Complete** (24 November 2026) |
| **1** | AD-1 component view, AD-2, AD-4, AD-6, AD-8, AD-13 gate templates | Now. Their first decisions are made, and AD-4 and AD-6 need none. **The AD-1 component view v0.5, AD-4 v0.2 and AD-6 v0.2 are approved for the D-24 slice (25 November 2026); AD-2 and the AD-13 gate templates are not written. AD-8 is drafted, not reviewed.** |
| **2** | AD-3, AD-5, AD-9, AD-10 | Their wave-1 inputs are approved. **AD-5 is drafted, not reviewed**, on AD-4 v0.2 |
| **3** | AD-7, AD-11, AD-12 | Their wave-2 inputs are approved |
| **4** | AD-1 final, AD-13 test strategy | All other ADs are approved or deferred |

**Critical paths:**

- **All code:** AD-1 component view → every code milestone (D-22).
- **Security:** AD-1 component view → AD-10 → milestone 3.2.
- **Streaming:** AD-2 → AD-3 → milestone 3.4, which also needs 3.3-S.
- **Adapters:** AD-4 → AD-5 → AD-12 → milestone 3.3.

So milestone 3.2 can start after wave 2, and milestone 3.3 after wave 3.

## 5. Working rules

- **One pull request per deliverable.** Each is reviewed by the listed reviewers and approved by the project owner, and the approval is recorded in `docs/PHASE3_SCOPE.md` §2.
- **CODEOWNERS:** no CODEOWNERS file exists in the repository. `PHASE2_ARCHITECTURE.md` §3.1 only specifies an intended `.github/CODEOWNERS`, with placeholder handles, so ownership is a team agreement and is not enforced. If Dev D creates the file, it is recommended that it also cover `docs/PHASE3_*.md`, and the ingestion component's directory once AD-1 sets it. That change is not part of this plan.
- **AD-3 evidence:** measurement spikes are disposable and run outside the project's Compose stack; nothing is merged as the mechanism before AD-3 is approved.
- **No provider data in evidence:** event-rate estimates for AD-2 come from published provider documentation or synthetic load, never from recorded provider samples (D-17).
- **Provisional targets stay provisional:** F-5's numbers guide AD-2 and AD-9, but only AD-8 makes them final and defines how they are measured.
- **No durations:** this plan sets order and ownership, not dates. Dates are for the team to set.

## 6. Risks

- **Concentration on Dev A:** the project owner leads four deliverables (AD-4, AD-5, AD-6, AD-8), owns the ingestion component (F-2), reviews Gates 1–3 and approves every deliverable and gate. The second-reviewer rule covers review independence, not workload. Dev C, which leads one deliverable, has the most spare review capacity.
- **F-5 measurement points:** "event-to-display" can be measured from the source timestamp or from ingestion. Until AD-8 fixes this, the 1 s figure cannot be tested.
- **The adapter path is the longest:** milestone 3.3 waits on AD-4, AD-5 and AD-12, so the synthetic adapter (3.3-S), and with it milestone 3.4, starts last among the early code milestones.

## 7. Exit

Milestone 3.1 exits when:

- each of AD-1 to AD-13 is approved by the project owner after the listed reviews, or explicitly deferred with a reason and the code milestone it holds back;
- AD-3 is recorded as the roadmap §6 streaming decision;
- the approvals are recorded in `docs/PHASE3_SCOPE.md` §2.

The D-24-slice approvals of 25 November 2026 do not exit 3.1: AD-2, AD-3, AD-5, AD-7 to AD-13 and the final AD-1 are still outstanding, and the component view's §4 placement is unconfirmed.

The drafts of 26 November 2026 do not exit 3.1 either. Each is **DRAFT and unapproved** after four review rounds on PR #30 — AD-8 at **v0.5**, AD-5 and AD-1 Part 2 at **v0.4**, AD-4 Part 2 and AD-6 Part 2 at **v0.2** — so AD-5 and AD-8 are not yet approved deliverables, the companion documents approve nothing, and the component view's §4 placement stays **unconfirmed** until the project owner confirms it — which `docs/PHASE3_AD1_ARCHITECTURE.md` is the material for, not a substitute for. All four rounds were **documentation corrections only**: no approved contract, schema, threshold or ownership moved, and the unresolved architecture decisions — the streaming mechanism, delivery semantics, capacity, recovery objectives, published source status and T6 instrumentation — remain **provisional**. Every latency target whose endpoint is a browser render is recorded as **unmeasured**, and the **AD-2 draft (PR #32) and these drafts differ on burst size and stream concurrency**, which AD-2 and the owner reconcile, not these documents.
