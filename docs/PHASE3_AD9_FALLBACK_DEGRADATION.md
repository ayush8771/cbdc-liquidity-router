# AD-9: Fallback and Degradation Specification

**Status:** **DRAFT v0.1, proposed, not approved.** Written 26 November 2026 against `origin/feature/phase3-platform` at `4424b45`. It is documentation only: it changes no code, test, contract, schema or behaviour, and it authorizes no milestone and passes no gate.
**Scope approval:** the AD-9 scope below was clarified and approved by the project owner (Ayush) on 26 November 2026. The approval is relayed, not quoted: the repository holds no text of it. The same convention as AD-1 §3.4.1 applies.
**Lead:** Dev C. **Reviewers:** Dev A, Dev B. **Approver:** project owner (`docs/PHASE3_MILESTONE_3_1_PLAN.md` §3).
**Scope source:** `docs/PHASE3_SCOPE.md` §3 Workstream D and §7.3 (AD-9 row); D-9, D-15, D-21, D-24; F-5.
**Relies on:** `docs/PHASE3_AD1_COMPONENT_VIEW.md` v0.5 (§3.2, §3.3 to §3.3.5, §3.5), `docs/PHASE3_AD4_EVENT_ENVELOPE.md` v0.2 (§7, §8), `docs/PHASE3_AD6_ENGINE_BOUNDARY.md` v0.2 (§1, §6), `docs/PHASE2_API_CONTRACT.md` v0.4 (§3.2, §3.9, §4). AD-1, AD-4 and AD-6 are approved **for the D-24 slice only**.
**Depends on, not yet written:** **AD-8** (non-functional budgets and monitoring) and **AD-10** (threat model, authentication and exposure plan). Neither document exists in the repository, so this document names them and links nothing.

This document specifies what the system does when something fails, and what the user is shown. **Everything here describes behaviour that is already approved elsewhere, or states a boundary that must hold.** It adds no feature and no capability. Where it records a number, the number is owned by the document cited beside it.

## 1. Scope and ownership

AD-9 is the **fallback and degradation specification** of `docs/PHASE3_SCOPE.md` §7.3: the fallback order, when routing is refused, and how stale, simulated or missing values are shown. It mentions the dashboard, freshness and authentication **only where they matter to failure handling**.

| Topic | Owner | What AD-9 does with it |
|---|---|---|
| Dashboard architecture, components, panel gating, SSE protocol | **AD-1** (§1, §3.2, §3.3.4) | Cites it. Records only how the dashboard behaves while observations fail (§3.4). |
| Freshness definition, thresholds, labels | **AD-4** §7, §8 and **AD-1** §3.3 (slice values); final numbers: **AD-8** | Restates the slice values with their source (§3.1). Does not change them. |
| Monitoring, budgets, measurement points | **AD-8** (not yet written) | Lists which failures must be visible and refers the how to AD-8 (§3.6). |
| Authentication and exposure | **AD-10** (not yet written); today AD-1 §2, §3.3.4 and Phase 2 development auth | States the failure semantics that must hold (§3.5). Defines no mechanism. |
| Observation-to-engine boundary | **AD-6** (§1, §6) | Applies it (§2, §4). |
| Routing errors, policies, persistence | **API contract v0.4** (§3.2, §3.9, §4), normative | Cites it. Defines no error code (§4). |

**Out of scope:** new features, new thresholds, new error codes, a history view, any live provider, `ppo_projected` activation (Gate 1), Cognee writes, any exposure beyond the private development environment (Gate 4).

## 2. Two failure domains

The system has two separate things that can fail. They must not be mixed.

| | **Observation domain** | **Routing and inference domain** |
|---|---|---|
| What | Ingestion, the Express observation module, the SSE stream, the observation panel | The Phase 2 path: `POST /api/v1/transactions`, `POST /api/v1/comparisons`, the inference engine, the database |
| Failure shows up as | A freshness state, a connection or source status, or a stopped stream in the panel | An API error, a `skipped` policy, a failed transaction record |
| Effect on the other domain | **None** | **None on observations** |

**The boundary rule (AD-6 §1, AD6-Q1, AD6-Q2).** Observations are display and context only (D-9, D-15). An observation outage, a stale or withdrawn value, or a stopped stream **never blocks, delays, refuses or alters a routing request**, and routing returns the same results. Conversely, an inference failure does not hide observations.

**Observation availability is not routing eligibility.** Whether a request can be routed depends only on the existing engine and contract conditions (§4), never on what the panel is showing. The panel's states are not a gate for the form, the submit button or any policy.

| Observations | Routing | Result |
|---|---|---|
| Healthy | Healthy | Normal. |
| Failed, stale or withdrawn | Healthy | Panel degrades (§3). Routing works and is unchanged. |
| Healthy | Failed | Routing errors per the contract (§4). Panel keeps updating. |
| Failed | Failed | Both degrade independently. Each shows its own state; neither explains the other. |

## 3. Observation degradation

Applies to the D-24 slice (synthetic `fx_rate` only, local only, off by default). The panel's behaviour below is what AD-1 v0.5 specifies and the merged D-24 frontend implements; AD-9 **does not change it**.

### 3.1 Fresh, stale and unavailable

The slice's profile, sent in every snapshot (AD-1 §3.2), is `expected_interval_ms` 2000, `stale_after_ms` 6000, `unavailable_after_ms` 30000. The client applies the `profile` it receives and has no thresholds of its own (AD-1 §3.3). AD-8 sets final values (AD-1 §3.3; scope F-5).

| Age of the value | State | Display (AD-4 §8, AD-1 §3.3) |
|---|---|---|
| ≤ 6 s (exactly 6.000 s included) | Fresh | **SIMULATED**, with source, age and transport |
| > 6 s and ≤ 30 s (exactly 30.000 s included) | Stale | **SIMULATED · stale**, same details, age shown |
| > 30 s | **Unavailable** | "Unavailable", **no number** |

- Age is measured from `source_timestamp` (AD-4 §7). A source outage, a poll result or a reconnect does not refresh or reset it.
- Between messages a value only **degrades**: fresh, then stale, then unavailable. Only a new `update` or `snapshot` can improve it (AD-1 §3.3.3).
- A value that disagrees with the recomputed state is a protocol fault (AD-1 §3.3.3).

### 3.2 The last known value and its withdrawal

**Decision (project owner, 26 November 2026).** The D-24 behaviour is preserved: **the last known observation value is withdrawn once it is unavailable**, that is, after 30 seconds without a newer event for that pair.

- While stale (6 s to 30 s), the last known value stays on screen, labelled **SIMULATED · stale**, with its age. This is the only period in which an old number is shown.
- Once unavailable it is **withdrawn**: no number, no rate, and the D-24 panel shows no age or source for it. It does not come back unless a new `update` or `snapshot` carries a newer event.
- The same rule holds for every cause: a source outage, a lost stream, a paused tab, a stopped stream or an invalid value. The cause changes the connection message, never the 30 s rule. Backend and client both withdraw the number (AD-1 §3.4: the watermark stays, the number is not sent).
- AD-4 §8 allows an unavailable value to appear "only as history, with its timestamp". **D-24 shows no such history, and this document does not add one.** Adding it is a frontend change that needs its own approval.
- No value is ever relabelled to avoid showing "Unavailable". A value that fails the per-value checks is shown as Unavailable with no number (AD-1 §3.3.3).

### 3.3 Failure scenarios and degradation

Detection, thresholds, backoff and wire handling belong to AD-1 (§3.1, §3.3.1 to §3.3.3, §3.5); the table says only what the user sees and what recovers it.

| Scenario | What the user sees | Values | Recovery |
|---|---|---|---|
| **Source outage** (ingestion down or failing; AD-1 §3.1: 3 failed polls or 2 s) | "Source synthetic.fx: outage", with a notice that values keep ageing | Age on; stale at 6 s, withdrawn at 30 s | Automatic when the source recovers and newer events arrive |
| **Stream lost** (network error, 5xx, normal end, no bytes for 35 s, no headers in 2 s) | "Disconnected, reconnecting" | Kept, age on, same 6 s and 30 s rules | Automatic: backoff 1 s then 2 s with jitter (AD-1 §3.3). A new snapshot replaces all state |
| **Too many streams** (429, per-user limit of 3) | "Too many streams, waiting to retry" | Kept, age on | Automatic after the larger of `Retry-After` and the backoff, at most 30 s |
| **Backend shutting down** (503) | Disconnected, reconnecting | Kept, age on | Automatic, honouring `Retry-After`, at most 30 s |
| **Tab hidden** (AD-1 §3.3.1) | "Paused (tab hidden)" | Kept, age on: a paused tab never shows a frozen number as current | One fresh snapshot when visible again |
| **Offline** | "Offline" | Kept, age on | One fresh snapshot after `online` |
| **Single protocol fault** (bad JSON, wrong content type, sequence gap, a first message that is not a snapshot) | Disconnected, reconnecting | Kept, age on | Automatic reconnect. Three faults without 60 s of valid streaming stop the stream |
| **Stopped, protocol faults or unsupported version** | "Stopped", with "Observations unavailable" or "stopped: the stream sent messages that couldn't be read" | Kept, age on, so withdrawn at 30 s | **Retry now only** (AD-1 §3.3.2). Never automatic |
| **Stopped, 403, 404 or other 4xx** | "Stopped", "Observations unavailable" | As above | **Retry now only** |
| **Stopped, 401** | The session handling of §3.5 runs | As above | Sign-in first (§3.5) |
| **One value fails the per-value checks** | That pair shows "Unavailable", no number; other pairs are unaffected | That pair withdrawn | Next valid `update` |
| **Feature off, preview mode, or narrower than 1024 px** | **No panel, and no request.** This is absence, not a failure state (AD-1 §3.3.4; D-24 acceptance §5 item 7) | None | Not applicable |

Rules that apply to every row:

1. **Recoverable and permanent are never confused** (AD-1 §3.3.2). A permanent stop is shown as stopped and never retries on its own.
2. **Source outage is shown apart from a disconnected stream** (AD-1 §3.3). Either can occur without the other.
3. **Every state is text, not colour alone** (AD-4 §8.1).
4. **Nothing is shown that implies live routing or live data.** Wording stays within scope §1.3 and §6 (D-15; AD-6 T-8).

### 3.4 Dashboard behaviour during observation failures

Dashboard architecture is owned by AD-1. The failure-relevant facts:

- The observation panel is an **isolated section** of the desktop dashboard with its own stream controller and state. It is not shared with any form, routing request or Phase 2 dashboard query (AD-1 §1, AD-6 B-8).
- **An observation failure changes only the panel.** The KPI figures, activity charts, policy table, history and the New transaction and Compare forms are unaffected, and keep their own loading, error and empty states from Phase 2.
- **A Phase 2 failure does not change the panel**, and the panel's stream is not a retry of any Phase 2 request.
- The panel reads the session only through the stream-opening method (AD-1 §3.3.4); it holds no routing, transaction or API-client state.

### 3.5 Authentication failure handling

Authentication is owned by **AD-10**. Today it is Phase 2 development authentication, for a developer's machine or a private Compose network only (scope A-1, D-16); replacing it is milestone 3.2 and AD-10. AD-9 states only what must hold when authentication fails:

- A **401 on the stream is a permanent stop**: no timer, no backoff and no reconnect on `online` or `visible`. Retrying with a dead token would only hammer the endpoint (AD-1 §3.3.2).
- The stream hands a 401 to the **same session-expiry handling** the API client uses. A late 401 from a superseded session is dropped and cannot sign out the session that replaced it (AD-1 §3.3.4).
- **Sign-out and sign-in abort every in-flight stream attempt.** After sign-out nothing reconnects.
- The credential is never put in a URL, a log or another origin, and the stream request sends no cookies and follows no redirects (AD-1 §3.3.4).
- **An authentication failure on the stream never changes routing,** and a routing request's own 401 is handled by the existing API client (§4). Neither triggers a fallback.

Whatever AD-10 selects for authentication, **these failure semantics must be kept or AD-10 must state each change** and have it reviewed. AD-9 sets no requirement on identity providers, cookies, CSP or token storage.

### 3.6 Monitoring and failure visibility

Monitoring, budgets and measurement points are owned by **AD-8**. AD-9 asks AD-8 to make these failures visible to an operator, with no further design here:

- source status changes (`starting`, `ok`, `outage`) and poll failures;
- stream opens, closes and the reason, including refusals by the stream limits;
- events rejected, withheld, late or conflicting, by reason;
- a client's repeated protocol faults and stopped streams;
- the freshness distribution of served values, so a source that quietly ages out is visible.

What D-24 provides today, as observed, not required by this document: the backend writes token-redacted logs for source status changes, poll failures and stream opens and closes, and keeps in-memory counters by reason that nothing yet reads; `GET /api/v1/health` reports the database and inference only, not the observation source; the browser writes short reasons to the console only. **AD-9 does not require any of these to change.** Until AD-8 exists, freshness thresholds and the 1 s and 5 s targets stay provisional (scope F-5).

## 4. Routing and inference failures

Routing behaviour is owned by API contract v0.4, which is normative. AD-9 adds one boundary and one rule.

### 4.1 What can refuse or fail a routing request

Only conditions that are **already in the contract** (§3.2, §3.9, §4):

| Condition | Result (contract) |
|---|---|
| Invalid request | `422 VALIDATION_ERROR`, nothing persisted |
| A viewer asks for `ppoProjected` | `403 FORBIDDEN_POLICY`, checked first |
| Policy disabled (no approved checkpoint) | `409 POLICY_DISABLED`, not persisted; in a comparison that policy is listed in `skipped` and the comparison is still saved |
| Policy not available for the state (for example `ppo_projected` without `history`) | Refused with `POLICY_UNAVAILABLE_FOR_STATE` |
| Inference unreachable, 15 s timeout, or not ready | `503 INFERENCE_UNAVAILABLE` (with `details.cause: "NOT_READY"` where applicable) |
| Inference busy | `503 ENGINE_BUSY`, with `Retry-After` |
| Engine deadline expired while running | `504 ENGINE_TIMEOUT` |
| Inference 5xx or an invalid body | `502 INFERENCE_ERROR` |

After validation, an inference failure is persisted as a `failed` transaction and returned with its `transactionId` (contract §3.2). A stored `ppoProjected` decision is never recomputed with another checkpoint.

**No observation state appears in this list, and none may be added.** AD-6 §6: refusals come only from the existing engine and contract conditions, or from a routing value without its own label.

### 4.2 No silent policy substitution

**Rule.** If a requested policy cannot run, the system **says so and does not run another policy in its place.** A different policy's result is never presented as the requested one, and the result for a policy that was not requested is never returned.

This is already how the contract works and AD-9 only records it as a requirement that must not erode:

- A comparison reports an unavailable policy in `skipped` with the engine's own message, and "never substitutes or retries a policy"; a result for a policy it didn't send makes the response invalid (contract §3.6, "PPO availability"), "so there is no fallback to raw PPO".
- A single transaction for a disabled policy returns `409 POLICY_DISABLED`; it does not fall back to `waterfall`.
- The default `waterfall` for an omitted `policies` is a **declared default** (contract §3.2: `policy` "defaults to `waterfall`"), chosen before the request runs. It is not a fallback after a failure.

Any future automatic fallback between policies would be a new behaviour: it needs an explicit owner decision, a contract change, and a visible label on the result saying which policy ran and why. **None is authorized by this document.**

### 4.3 What "refuse to route rather than route on unlabelled data" now means

Scope §3 Workstream D proposes that, as a last fallback, the system "refuse to route rather than route on unlabelled data", to be decided in AD-9. Under D-9 and AD6-Q2 it **never applies to an observation outage**. For AD-9 it means only that a **routing value without its own provenance label** cannot be presented as a result (Phase 2 labels, architecture §5.3). It adds no new refusal condition.

### 4.4 Inference failure and observations

An inference failure leaves the panel running (AD-6 §6). The routing error is shown where the routing request was made, in the form or result area, using the contract's fixed messages, and is not repeated in the panel.

## 5. Conflicts and open items

Recorded, not resolved here. The first two follow from the owner's 26 November 2026 decisions and need an editor to bring the older text into line; AD-9 edits no other document.

| # | Item | Position |
|---|---|---|
| **C-1** | **Scope §3 Workstream D fallback order** ("last known good value, labelled stale; then a synthetic snapshot; then refuse to route") against AD6-Q2 and the owner's decision | The scope sentence is marked **[PROPOSED]** and "Decided in AD-9". Applied here: step 1 holds only while the value is stale and ends at 30 s (§3.2); step 3 never applies to observations (§4.3). `docs/PHASE3_SCOPE.md` itself is **not edited**. |
| **C-2** | **AD-4 §8** permits an unavailable value to appear as history with its timestamp; D-24 does not show it | D-24 stands (§3.2). Whether a history view is ever added is not decided and not authorized. |
| **O-1** | **The "synthetic snapshot" step** | Meaningless in D-24, where every value is already synthetic. Whether a later source needs a synthetic stand-in is open and belongs to a later milestone. |
| **O-2** | **AD-8 is not written.** Thresholds, the 1 s and 5 s targets, measurement points and monitoring signals are provisional | Referenced by name. AD-9 should be re-checked when AD-8 is drafted. Plan §3 lists AD-8 as an AD-9 input. |
| **O-3** | **AD-10 is not written.** Replacement of development authentication | Referenced by name (§3.5). B-4 (inference egress) is also AD-10's and stays unresolved (D-25). |
| **O-4** | **"60 s of valid streaming"** (AD-1 §3.3, §3.3.2) is not defined: whether it is continuous, and how it is measured. The client documents its own reading and calls it open for the AD-1 owner (`observationController.ts`) | Owned by AD-1. Not changed here. |
| **O-5** | **Retry now when idle or offline.** AD-1 §3.3.2 says it is shown in every state and disabled while an attempt is in flight. The D-24 panel also disables it while idle or offline | Owned by AD-1. Recorded as observed. |
| **O-6** | **Distinct empty states.** The panel shows one message ("No observations are shown yet.") before any snapshot, and when a stopped stream has no values | Observed behaviour. Whether to tell them apart is a frontend decision for a later milestone. |
| **O-7** | **Whether the 401 stop message is ever seen.** A 401 ends the session, so the panel unmounts and the route guard redirects to sign-in. This is read from the code and not exercised | Needs a test or a statement from Dev B or Dev C before any text relies on it. |
| **O-8** | **Announcing freshness changes to assistive technology.** The connection area is a status region; fresh, stale and withdrawn changes in the table are not announced | Not specified by AD-1 or AD-4. Needs an owner. |

## 6. Traceability to D-24 evidence

This document specifies no new test. The behaviour in §3 is already covered by the D-24 suites; the table points at them so a reviewer can check each claim. It does not say the tests were re-run for this document.

| Claim | Existing evidence |
|---|---|
| Fresh to stale to unavailable at the thresholds; number withdrawn | `services/web/test/observations/panel.test.tsx` ("moves a value from fresh to stale to unavailable at the thresholds, withdrawing the number"); `pure.test.ts`; `e2e/p3/observations.spec.ts` ("@on fresh, stale, unavailable and recovery") |
| Source outage shown apart from the connection; values keep ageing while disconnected | `panel.test.tsx` ("applies an update to one pair and reports a source outage apart from the connection", "keeps values, ageing, while disconnected and says so") |
| Stopped state, Retry now, 429 and offline | `panel.test.tsx` ("explains a stop, offers Retry now, and Retry now connects once", "says too many streams on a 429", "shows Offline, ...") |
| Hidden tab pauses and reconnects once | `panel.test.tsx`; `e2e/p3/observations.spec.ts` ("@on a hidden tab aborts the stream at once and a visible one reconnects once") |
| 401 ends the session and does not reconnect; a late 401 is dropped | `services/web/test/observations/authStream.test.tsx` |
| A non-synthetic value is Unavailable, no number | `panel.test.tsx` ("shows a withheld (non-synthetic) value as Unavailable with no number") |
| Observations never affect routing | `panel.test.tsx` ("makes no routing, transaction or API-client call"); `e2e/p3/observations.spec.ts` (T-2, T-3, T-10 test); AD-6 T-1 to T-4 in `docs/PHASE3_D24_ACCEPTANCE.md` §2 |
| Panel absent when off, in preview, or below 1024 px | `services/web/test/observations/dashboard.test.tsx`; `e2e/p3/observations.spec.ts` (off, preview and narrow tests) |
| No policy substitution in comparisons | `docs/PHASE2_API_CONTRACT.md` §3.6 ("PPO availability"); the backend contract tests (not re-read for this document) |

## 7. Approval

Nothing is approved. This is a draft for review.

- [ ] **Dev A** review
- [ ] **Dev B** review
- [ ] **Dev C** (lead) confirmation
- [ ] **Project owner** approval

**Not approved by this document:** any change to D-24 behaviour, the API contract, authentication, routing, monitoring, `ppo_projected` activation, live feeds, Cognee writes or any exposure. No gate has passed.
