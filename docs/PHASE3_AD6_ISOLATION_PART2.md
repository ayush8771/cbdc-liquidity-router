# AD-6 Part 2: Engine Isolation — Full Phase 3 Enforcement and Verification

**Status:** **DRAFT v0.2**, 26 November 2026. **Review state:** reviewed on PR #30 — **CHANGES_REQUESTED by Nisarga (26 Nov, on v0.1) and by Varshini, Dev C (26 Nov)** — and **NOT APPROVED**. The findings of both rounds are applied; **neither reviewer has re-reviewed**, and no owner approval exists.
**Relationship to AD-6 v0.2:** this is an **additive companion** to `docs/PHASE3_AD6_ENGINE_BOUNDARY.md`, which stays **exactly as approved**. AD-6 **v0.2 is approved for the D-24 slice only** (25 November 2026, scope §2.2.3), **subject to D-25**, and that approval is **version-specific**. Revising the approved file would require fresh review and a fresh owner approval before the D-24 slice could continue, so this document is written beside it. **Nothing in AD-6 v0.2 is edited, superseded, weakened or reinterpreted here.** Where the two could be read as disagreeing, **v0.2 wins**.
**The rule is unchanged:** *no observation may influence an engine request or an engine result* (AD-6 §1; D-9, D-15).
**Revision v0.2, 26 November 2026 — still DRAFT.** Applies **Nisarga's CHANGES_REQUESTED review of PR #30**, submitted on v0.1 (`5f78500`); its text is on the pull request, not in the repository. Nothing in it approves this document, and no approved decision, contract, threshold, ownership or gate moves. Changes:

- §3 item 3 now records **what closing B-4 will take**: a change to inference's networking that the D-24 overlay cannot express, permitted only under an approved AD-10 change, per `docs/PHASE3_AD1_ARCHITECTURE.md` §7.3.1. **B-4 stays unresolved**, T-5 stays ingestion-only, and **AD-6 is still not fully enforced**.

**Lead:** Dev A. **Reviewers:** Dev B, Dev C (the AD-6 reviewer set). Dev D is not a listed reviewer, and AD-6 v0.2's closing note recommends consulting Dev D because B-4 to B-6 need Dev D's work; §9 follows that recommendation without changing the approved reviewer list. **Approver:** project owner. Dev A is also the approver, so the second-reviewer rule (D-20) applies.
**Scope source:** `docs/PHASE3_SCOPE.md` v1.4 §1.3, §4.2, §7.3; D-1, D-9, D-15, **D-25**; A-3 to A-8; AD6-Q1 to AD6-Q6.
**Feeds:** AD-9, AD-10, AD-11, AD-13; milestone 3.5.

This document changes no engine code, no Phase 1 file, no Phase 2 behaviour, no Docker file, no database and nothing in API contract v0.4. It does not resolve **B-4** (§3), passes no gate and authorizes no milestone.

---

## 1. What Part 2 adds

AD-6 v0.2 states the rule, the reasons, the allowed and forbidden flows, eight controls **B-1 to B-8**, and ten acceptance tests **T-1 to T-10**. It was approved for a slice in which the controls are small and five of them are "implemented by their own milestones". Full Phase 3 adds components that each create a new way for an observation to reach the engine, and the task of this document is to say, per component, **which control covers it, how it is verified, and what is not yet verified**.

| # | Part 2 adds | AD-6 v0.2 |
|---|---|---|
| 1 | The **component-by-component control matrix** for every full-Phase-3 component, including the ones AD-1 §4 places but does not authorize | §5 lists eight controls without mapping them to later components |
| 2 | **Verification status per control**: enforced, partly enforced, or specified only — and by what evidence | §5 says "except where marked, they do not exist yet" |
| 3 | The **B-4 tracking record**, with D-25's limits stated in full and what closes it | §5 B-4, scope D-25, AD-1 §5 item 1 |
| 4 | **Residual-risk analysis** for the paths that no single control closes | §4's "forbidden, including the indirect routes" |
| 5 | **Test extension T-11 to T-18**, additive to T-1 to T-10 | §8 |
| 6 | A **non-interference regression obligation** that holds for every later milestone | §8 T-1, which the D-24 harness implements for one slice |

---

## 2. The control matrix

### 2.1 Controls against components

**[PROPOSED]** Rows are AD-6 v0.2's eight controls, unchanged. Columns are the components: those of the D-24 slice (AD-1 §1) and those AD-1 §4 places for later milestones, **whose placement the owner has not confirmed**, so no row authorizes anything.

| Component | Milestone | Controls that must hold | Status |
|---|---|---|---|
| Ingestion (synthetic) | D-24 slice | B-1, B-3, B-4 (ingestion side), B-5, B-6 | **Enforced and verified** for the slice (§4.1) |
| Live provider adapters | 3.3-L, per provider after Gate 3 | B-1, B-3, **B-4 with an egress allowlist**, B-5, B-6 | **Specified only.** Egress does not exist yet (AD-5 §12.1); **AD-10** |
| Event distribution | 3.4 | B-3, B-4, B-5, B-7 | **Specified only.** Mechanism open (AD-2, AD-3) |
| Observation store | 3.5, 3.7 | B-5, **B-7** | **Specified only.** **AD-11** |
| Audit trail | 3.2, 3.7 | B-7 | **Specified only.** AD-11; a routing record never lists an observation as an input |
| Quarantine store and review queue | 3.6 | B-3, B-7, and **Gate 2** for any knowledge write | **Specified only.** AD-12 |
| Express observation module | D-24 slice | **B-3**, B-7, B-2 | **Enforced and verified** for the slice (§4.1) |
| Express routing and mapper modules | Phase 2, unchanged | **B-2**, B-3 | **Enforced.** Contract v0.4 requests are strict (AD-6 §5 B-2) |
| Observation panel (React) | D-24 slice | **B-8** | **Enforced and verified** for the slice (§4.1) |
| Routing form and result (React) | Phase 2, unchanged | **B-8** | **Enforced** for the slice by T-3 and T-10 |
| Inference service and engine pool | Phase 2, unchanged | B-2, B-3, **B-4 (inference side)**, B-5 | **B-4 NOT enforced** (§3). The rest hold |
| Identity provider | 3.2 | B-5 | **Specified only.** AD-10 |

### 2.2 The three paths that need naming, because they look benign

**[PROPOSED]** AD-6 §4 already forbids the indirect routes; these are the three that a later milestone is most likely to reintroduce, each with the control that stops it:

| Path | Why it looks benign | Control |
|---|---|---|
| **The shared browser.** Both the observation panel and the routing form live in one page, in one memory space | A single store, a single context or one "convenient" selector is all it takes | **B-8**: observation state is separate from form and request state, with **no copy path**, checked by lint and component tests |
| **The shared Express process.** Express is on both networks and holds both modules, so it is "the single point that keeps them apart" (AD-1 §5 item 2) | One import is enough | **B-3**: routing, mapper and inference-client modules do not import observation modules, and the reverse; `app.ts` and `server.ts` may compose both (AD-1 §1) |
| **The shared PostgreSQL server.** Observation records and routing records may sit on one server | One join, one foreign key, one view | **B-7**: observation records are separate; **a routing record never lists an observation as an input**; displayed context follows §6.1 and points **to** the transaction, never the reverse |

AD-6 §4 states the general case: *"the two paths share the browser, Express and possibly the PostgreSQL server. AD-1 decides the components; the separation holds wherever they run."*

---

## 3. B-4: the record of an unresolved requirement

**This section records a gap. It does not close it.**

**[APPROVED]** (AD-6 §5 B-4) The requirement: *ingestion has no route to the inference service, and inference has none to distribution, the observation store or the internet.*

**[APPROVED]** (scope D-25; AD-1 §5 item 1; AD-6 status line)

| Fact | Record |
|---|---|
| **B-4 is UNRESOLVED** | On the **inference** side. The Phase 2 stack does not enforce it, and the D-24 slice delivers only the ingestion side |
| **D-25 is an exception, for the D-24 slice only** | The owner waived **enforcement** of B-4's inference side for that slice. It is a waiver of enforcement, not a satisfaction of the requirement |
| **It is closed by AD-10** | Whose exposure plan **must state how inference egress is controlled** |
| **The D-24 overlay does not isolate inference** | `infra/compose.observations.yaml` says so in its own header; `--profile full` is unchanged |
| **T-5 covers the ingestion side only** | Ingestion has no route to inference, PostgreSQL or the internet, and holds no credential. **The inference side of T-5 is not run and not claimed** |
| **AD-6 must not be described as fully enforced** | AD-1 §5 item 1, §6 item 5 |
| **The exception extends to no later milestone or component** | And it is **not Gate 4 evidence.** **No gate has passed** (D-6, D-18) |

**[PROPOSED]** What Part 2 adds, without resolving it:

1. **Every component in §2.1 that needs B-4 is marked, so the gap cannot be lost** as milestones are planned.
2. **A live adapter makes B-4 materially harder, not easier.** The D-24 posture has ingestion contact nothing at all; a provider adapter gives ingestion outbound access (AD-5 §12.1). B-4's two halves then both need enforcement, and the ingestion half becomes an **allowlist**, not an absence.
3. **The inference side's requirement is unchanged by any of it:** inference needs no outbound access for any Phase 3 capability. It reads local artefacts and answers Express (Phase 2 arch §2). There is no Phase 3 feature that requires inference egress, so the control is a configuration question, not a design trade-off.
   **What closing it will take.** Inference is a Phase 2 service defined in `infra/compose.yaml`, so constraining its network is a change the D-24 overlay cannot express — the D-24 conditions forbid touching that file (scope §2.2.2). `docs/PHASE3_AD1_ARCHITECTURE.md` §7.3.1 separates that **D-24 condition** from the architectural rules that are permanent, so that an **approved** AD-10 change may make it. It is not done under D-24, it changes no Phase 1 or Phase 2 behaviour, and it is **Gate 4 evidence rather than a gate pass**.
4. **T-13 (§6) is the inference-side test**, written here so AD-10 and AD-13 have it ready. **It is not run and not claimed by this document.**

---

## 4. Verification status

### 4.1 What is verified today

**[APPROVED]** (`docs/PHASE3_D24_ACCEPTANCE.md` §2; AD-1 §6 item 5) For the **D-24 slice only**, and as that document's own status line records — the workflow was **not committed or run in CI** when it was written, and its figures come from the first CI run of the workflow (PR #24, commit `bd085e6`):

| Test | Covered | Evidence, as recorded |
|---|---|---|
| T-1 non-interference | Yes | The same two requests on the plain stack and the observations stack in six states; identical `decision_id`, API decision and stored engine response; a different request must differ |
| T-2 no trigger | Yes | Zero rows and zero inference `/v1/route`, `/v1/compare`, `/v1/explain` calls during a burst, with positive controls first |
| T-3 no pre-fill | Yes | Events change no form field, default, option or selection; the request carries exactly the form's five fields |
| T-4 import rules | Yes | With deliberate violations |
| **T-5 network and credentials** | **Ingestion side only** (D-25) | The inference side is **not run and not claimed** |
| T-6 artefact hashes | Yes | A 300 s soak; SHA-256 of `src`, `data` (including the knowledge base), `outputs`, `contracts/test-vectors` and `services/inference`, on the host and inside the container, before and after. The 300 s duration is **not in AD-6 v0.2** and rests on a **relayed** owner approval recorded in the D-24 acceptance document |
| T-7 suites unmodified | Yes | Protected paths, plus the existing `tests` and `phase2-*` workflows passing on the same commit |
| T-8 forbidden phrases | Yes | `services/web/src` and 10 named documents. The list **deliberately excludes the Phase 3 design documents, which quote the phrases in order to forbid them** (`e2e/p3_safeguards.py`) |
| T-9 displayed context | **Not applicable** | The slice records no displayed context (AD-1 §6 item 5) |
| T-10 no converted currency | Yes | A text check on the result region |

### 4.2 What is not verified

**[PROPOSED]**

| # | Not verified | Consequence |
|---|---|---|
| 1 | **The inference side of B-4 / T-5** | AD-6 is **not fully enforced** (§3) |
| 2 | **T-9**, because nothing is recorded yet | It becomes required at milestone 3.5, when displayed context exists (AD6-Q3; scope §2.2.2 on AD6-Q3) |
| 3 | **Every control on a component later than the slice** — adapters, distribution, the store, the audit trail, the quarantine queue, the identity provider | §2.1's "specified only" rows |
| 4 | **B-7**, beyond the slice's "stores nothing" | AD-11 |
| 5 | **B-8 at scale.** The slice has one panel; 3.5 adds pushed routing status beside pushed observations in one page | §5.2 |
| 6 | **The forbidden-phrase check over Phase 3 design documents**, by deliberate exclusion | §5.3 |

**Stating this plainly:** the D-24 evidence is real and it is narrow. It shows that a four-pair synthetic panel does not disturb routing on one host in one CI run. It does not show that the boundary holds for live adapters, a broker, a store, an audit trail or a knowledge queue, none of which exists.

---

## 5. Residual risks

### 5.1 The paths no single control closes

**[PROPOSED]**

| # | Risk | Why no control closes it | Mitigation |
|---|---|---|---|
| R-1 | **Manual re-typing.** A user reads an observed rate and types it into an explicit state | It cannot be prevented, and AD-6 §4 says so | The result is the user's own hypothetical: `user_supplied_synthetic`, with its Phase 2 label, **never described as observed**, and the UI offers **no shortcut** (AD-6 §4; **AD4-Q4** displays it as Manually entered) |
| R-2 | **Operational coupling.** Both paths share a host, so an observation flood could slow routing | AD-6 §4 permits "operational health shared by the host, such as rejecting work under overload, **provided the content of an observation plays no part**" | AD-8 §6.2's envelope and §6.3's limits; the poller never waits for a stream (AD-1 §3.5) |
| R-3 | **A human inference.** An operator sees an alert and changes a scenario | No technical control reaches a person's judgement | It is outside the system boundary. **No alert is wired to a routing action** (AD-8 §7.3), and the panel states: "Observations are shown for context. They do not affect routing" (AD-6 §6) |
| R-4 | **Express as the single separator.** It is on both networks and holds both modules (AD-1 §5 item 2) | A design consequence of F-3, not a defect | B-3's import checks, and the §6 T-16 composition test |
| R-5 | **A future convenience feature.** "Use live rate", "market stress detected", a converted result | Each is a plausible product idea, and each is already forbidden | AD-6 §4's table names all three. T-8's wording check and T-10 catch the display forms |
| R-6 | **The C-1 class of defect:** a safety property failing silently in a counter | C-1 stalled subjects for a whole run and showed only as a counter (AD-1 §3.4.1) | AD-8 §7.3 alerts **Q-2** (conflict loop) and **B-1** (boundary violation, paged) |

### 5.2 Milestone 3.5 raises the frontend risk

**[PROPOSED]** The slice has an observation panel and a routing form in one page. Milestone 3.5 adds **pushed status for routing requests the user made** (AD-6 §9.1 closing line), so the page gains a second push channel whose messages are *about* routing. The two must not share a store, a reducer or a selector, because that is the one place where an observation could be read into a routing view. **B-8 is therefore a 3.5 risk, not a solved slice problem**, and T-17 (§6) tests it.

### 5.3 The forbidden-phrase check excludes these documents, by design

**[APPROVED]** (`e2e/p3_safeguards.py`) T-8's `STATUS_DOCS` list "deliberately excludes the Phase 3 design documents, which quote the phrases in order to forbid them", and a listed document that is missing **fails** the check rather than shrinking the scope silently.

**[PROPOSED]** This document and its companions quote the forbidden phrases for the same reason, and are likewise outside the scan. The residual risk — a design document's wording leaking into user-facing text — is addressed by the scan covering **`services/web/src` in full** and the 10 status documents, which is where user-facing text lives. **No change to T-8's scope is proposed here**; it is Dev D's, and an addition would need the phrase-disclaimer logic to recognize a design document's quoting convention.

---

## 6. Test extension

**[PROPOSED]** Additive to AD-6 §8's T-1 to T-10, which are unchanged. Input to **AD-13**. Several cannot run until their component exists.

| # | Test | Covers | Runnable |
|---|---|---|---|
| **T-11** | **Per-adapter egress allowlist:** from inside the ingestion container, a host outside the adapter's allowlist is unreachable; the allowlisted host is reachable | B-4, ingestion side, with live adapters | After **AD-10**; milestone 3.3-L |
| **T-12** | **Distribution isolation:** the distribution mechanism has no route to inference or the engine, and holds no engine credential | B-4, B-5 | After **AD-3**; milestone 3.4 |
| **T-13** | **Inference egress:** from inside the inference container, **no route to the internet**, to distribution or to the observation store; it holds no credential for either | **B-4, inference side — the test D-25 waives for the slice** | After **AD-10**. **Not run and not claimed** (§3) |
| **T-14** | **Store separation:** no foreign key, join or view links an observation record to a transaction, decision, allocation or comparison record; a displayed-context record points **to** the transaction and never the reverse | B-7 | After **AD-11**; milestone 3.5 |
| **T-15** | **Audit-trail independence:** a routing audit row never names an observation as an input; a missing or failed context record neither blocks nor rolls back the routing record or its audit row, whose atomic write is unchanged | B-7, AD-6 §6.1 | After **AD-11** |
| **T-16** | **Express composition:** the routing, mapper and inference-client modules' transitive import graph contains **no** observation module, and the reverse; only `app.ts` and `server.ts` compose both. A deliberate violation must fail | B-3 | **Now**, extending T-4 |
| **T-17** | **Frontend state separation at 3.5:** with both observation and routing-status channels live, no observation value reaches a form field, a request body, a result field or a routing selector. A deliberate copy must fail lint and the component test | B-8 | Milestone 3.5 |
| **T-18** | **Knowledge-path isolation:** a quarantined or reviewed announcement produces **no** write to the deterministic knowledge base or the Cognee store, and feasibility is byte-identical before and after. `StaticMemoryProvider` remains the only feasibility authority | A-4, **Gate 2** | Milestone 3.6; the write path needs Gate 2 |

**Non-interference is a standing regression obligation, not a one-off.** T-1, T-2 and T-6 are re-run **at every milestone that adds a component to the observation path**, before and after that milestone's own tests — the pattern the D-24 harness already uses, where the T-1 requests run before and after the soak (`docs/PHASE3_D24_ACCEPTANCE.md` §1, §2). Each new component is a new chance to break a property that is currently true, and the test is cheap compared with the claim it protects.

---

## 7. AD-6 §9.2's open questions

**[PROPOSED]** AD-6 v0.2 leaves two open and names their deciders. Part 2 does not decide either; it records what each now needs.

| # | Question | Decider, per AD-6 §9.2 | Status after Part 2 |
|---|---|---|---|
| **AD6-Q5** | How are networks and database roles separated? | AD-1, AD-10, AD-11 | §2.1 maps the components; the **network** half needs AD-10 and carries **B-4**; the **database-role** half needs AD-11. Neither is answered here |
| **AD6-Q6** | How is displayed context captured, stored and retained? | AD-7 (capture), AD-11 | Unanswered. AD-6 §6.1 already fixes the invariants: a separate record, never in an engine request, the `decision_id` document, `clientReference`, a cache key or an engine input log; described as "displayed context"; and **what a browser reports as displayed is a claim, not proof** |

**AD6-Q3's slice exemption expires.** Scope §2.2.2 records that "the slice stores nothing, so displayed context is not recorded. **The requirement stays for milestone 3.5.**" T-9 becomes required then (§4.2 item 2).

---

## 8. Going further is still neither planned nor authorized

**[APPROVED]** (AD-6 §7) Feeding an observation to the engine is **not planned or authorized**, and AD-6 §7's nine conditions would all have to be met: a written proposal for one field; independent out-of-time data and an approved evaluation; an approved Phase 1 research change; Gate 2 and a decision on P5 for knowledge; Gate 3 for the provider with terms covering the use; a new `engine_version`, and `id_scheme` 2 if the canonical document gains an input; a new API contract version; a new AD-4 major version, because `usage` changes; and revised labels and claims, with an owner decision **replacing D-9 and D-15**.

**[PROPOSED]** Part 2 adds nothing to that list and removes nothing from it. Two observations about its current feasibility, for the record:

- **Condition 2 cannot be met with existing data.** All data ends 2025-09-30, the holdouts share the test period, and no genuinely independent out-of-time holdout can be generated without extending the data (root `CLAUDE.md`; scope §4.2). The open Phase 1 item "independent out-of-time data" is **not started** and needs approval.
- **Condition 1 has no candidate field.** A current FX rate has **no defined mapping** to any engine input: the engine accepts no date after 2025-09-30, and cost baseline and risk cannot be overridden (A-6; AD-6 §3). There is nothing to propose a mapping for, which is why the boundary is a rule rather than a deferral.

A value from a legitimate bridge telemetry source, should one ever exist, follows the same list (AD-6 §7).

---

## 9. Questions for the project owner

| # | Question | Draft position | Decides |
|---|---|---|---|
| AD6P2-Q1 | Is the §2.1 control matrix adopted as the tracking record for B-1 to B-8 across all Phase 3 components? | Yes | Owner |
| AD6P2-Q2 | Are **T-11 to T-18** adopted as additive acceptance tests, with T-13 explicitly **unrun and unclaimed** until AD-10? | Yes | Owner; input to **AD-13** |
| AD6P2-Q3 | Is the §6 standing obligation adopted — T-1, T-2 and T-6 re-run at **every** milestone that adds a component to the observation path? | Yes | Owner, with Dev D |
| AD6P2-Q4 | Should **Dev D** be added to AD-6's reviewer list, given that B-4 to B-6 are Dev D's work? | AD-6 v0.2 recommends consulting Dev D and leaves the approved list unchanged. Changing it is the owner's | Owner |
| AD6P2-Q5 | Should T-8's scan cover the Phase 3 design documents, with a convention that recognizes a quoted prohibition? | Not proposed here (§5.3). It is Dev D's check and would need the disclaimer logic extended | Owner, with Dev D |

---

## 10. Approval checklist

**None of these is given. This document is a DRAFT; it has been reviewed on PR #30 with changes requested, those findings are applied, and no reviewer has re-reviewed and no owner has approved it.**

- [ ] **Dev B** — review: §2.1's Express, distribution, store and audit rows; §2.2's three shared-resource paths; T-12, T-14, T-15, T-16
- [ ] **Dev C** — review: §5.2's 3.5 frontend risk; T-17; §5.1 R-1's UI consequences
- [ ] **Dev D** *(recommended, not a listed AD-6 reviewer)* — review: §3's B-4 record; T-11, T-13; §5.3 and **AD6P2-Q5**; §6's regression obligation against CI
- [ ] **Second-reviewer rule (D-20)** — satisfied by any review above, since Dev A is both lead and approver
- [ ] **Project owner** — approval, with §9's questions decided

**AD-6 v0.2's approval, and D-25, are untouched by this document.** The D-24 slice continues on v0.2 (scope §2.2.3). **B-4 remains unresolved and is closed by AD-10. AD-6 must not be described as fully enforced. No gate has passed.**
