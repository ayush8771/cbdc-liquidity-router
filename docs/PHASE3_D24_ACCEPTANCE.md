# Phase 3 D-24 acceptance: CI integration and evidence limits

**Status:** Stage 7 deliverable (Dev D), 26 November 2026. **Not committed or run in CI yet.** The workflow is `.github/workflows/phase3-observations.yml`; the harnesses are `e2e/p3_*.py`, `infra/scripts/p3_stack.py` and `infra/testing/fault_ingestion/`.
**Approved by the project owner, Ayush, relayed through the Dev D Stage 7 instruction** (no separate approval document exists in the repository): T-6 as a 300-second event soak with before/after artefact hashes and routing non-interference verification; T-8 over `services/web/src` and the 10 documents of §3. The T-6 duration is not stated in AD-6 v0.2, so this approval is the only source of the 300 s figure. It is a relayed approval, not a quoted one.
This document approves nothing else. It claims the D-24 slice only (AD-6 v0.2, scope v1.4); it is not production readiness and it passes no gate.

## 1. CI jobs

The seven earlier jobs are unchanged. Four are added. All run on `ubuntu-24.04`, use no secret, and place no pull-request text in a command.

| Job | Covers | Needs | Timeout | Estimated run |
|---|---|---|---|---|
| `guards` | AD-6 T-7 protected paths, T-8 wording, and the harnesses' own tests (with the negative controls) | none | 20 min | 0.9 min |
| `regression-gate` | AD-6 T-7: the existing `tests` and `phase2-*` workflows passed on the same commit | `guards` | 75 min | 3.3 min (waited for the Phase 2 full-stack job, then failed on it) |
| `acceptance-stack` | T-6, T-1, T-2, real SSE, fault recovery, limits, restart and graceful shutdown | `contracts`, `backend-observations`, `web-observations` | 90 min | 13.1 min |
| `acceptance-browser` | Browser: panel on, off and preview | `contracts`, `web-observations` | 90 min | 11.2 min |

**Runtimes are measured**, from the first CI run of this workflow (PR #24, commit `bd085e6`, GitHub-hosted runners, one run each): the figures in the last column are job durations, including the 300 s soaks and stack builds. They are one sample, not an average, and a cold cache or a busier runner will lengthen them; the timeouts stay at 20, 75 and 90 minutes. An earlier local estimate of about 40 and 30 minutes for the two acceptance jobs was too high.

**No redundant builds or soaks.** `acceptance-stack` builds two stacks (observations with the test-only fake ingestion, and the plain Phase 2 stack, the T-1 baseline) and runs everything on them in this order: T-6 (the 300 s soak and the fault phases, with the T-1 requests before and after), then T-1/T-2, then the probe phases that stop or restart the backend (`auth,quiet,limits,restart,sigterm`). The stream probe's own soak and fault phases are the ones inside T-6, so they are not run twice. The browser job builds one stack per flavour and runs the panel-on tests, including a separate 300 s browser soak, because the browser is a different client.

**What each harness check needs to see.** Each step writes a text log. `infra/scripts/assert_harness_log.py` fails on any `FAIL` or `SKIP` line, any non-zero failed, skipped, did-not-run or flaky count, a log with no passing result, and any named check that is absent (for example the T-6 hash checks, `T-2: zero calls`, `sigterm: the backend exits 0`, and the browser summary `on: passed, off: passed, preview: passed`). pytest steps keep the JUnit no-skip check.

**Where the browser spec lives.** `e2e/p3/observations.spec.ts`, with its own `e2e/playwright.p3.config.ts` (it imports and extends `playwright.config.ts`, so the loopback guard, the one worker and the no-recording settings are inherited). It is deliberately outside `e2e/tests/` and outside the default config's `testDir`: the Phase 2 `npm test` (phase2-stack) discovers exactly its original 7 tests and never collects these 10 (8 for the panel on, 1 off, 1 preview), which need stacks only `p3_browser_acceptance.py` builds. The first CI run showed why: with the spec in `e2e/tests/` the Phase 2 browser step collected it and failed.

**Timeouts, cleanup and evidence.** Every harness command is wrapped in `timeout`. Each job removes only the projects it created (`cbdc-p3s-*` under its own `$RUNNER_TEMP` directory, by `p3_stack.py down`, which refuses any other name), also after a failure or cancellation. It never prunes Docker. Container logs of this job's projects (last 400 lines each) and the text logs are kept for 7 days as an artifact. Playwright's output directory is deleted by the runner and never uploaded, because a failure snapshot can list form values.

## 2. AD-6 coverage

| Test | Where | Evidence |
|---|---|---|
| T-1 | `acceptance-stack` | the same two requests on the plain stack and on the observations stack in six states; identical `decision_id`, API decision and stored engine response; a different request must differ |
| T-2 | `acceptance-stack` | zero rows and zero inference `/v1/route`, `/v1/compare`, `/v1/explain` calls during a burst, with positive controls first. The browser job also asserts no routing request during its five minutes |
| T-3 | `acceptance-browser` | events change no form field, default, option or selection; the request carries exactly the form's five fields |
| T-4 | `contracts` (unchanged) | import rules with deliberate violations |
| T-5 | `runtime` (unchanged) | **ingestion side only** (D-25) |
| T-6 | `acceptance-stack` | 300 s soak; SHA-256 of `src`, `data` (including the knowledge base), `outputs`, `contracts/test-vectors` and `services/inference` on the host and the same trees inside the inference container, before and after; the T-1 requests before and after must give the same `decision_id` and engine responses |
| T-7 | `guards` and `regression-gate` | see §4 |
| T-8 | `guards` | see §3 |
| T-9 | not applicable | no displayed context is recorded (AD-1 §6 item 5) |
| T-10 | `acceptance-browser` | the routing result has no currency code, no symbol other than `$`, and no conversion wording. This is a text check on the result region |

## 3. T-8: exact scope

The check is `python e2e/p3_safeguards.py text`. It scans, as UTF-8 text:

- **The UI:** every `.ts`, `.tsx`, `.md`, `.html`, `.json` and `.css` file under `services/web/src` (133 files at this commit).
- **The 10 documents:**
  1. `README.md`
  2. `CLAUDE.md`
  3. `docs/PHASE2_STATUS.md`
  4. `docs/PROJECT_HANDOVER.md`
  5. `docs/PHASE3_MILESTONE_3_1_PLAN.md`
  6. `infra/README.md`
  7. `contracts/README.md`
  8. `services/backend/README.md`
  9. `services/web/README.md`
  10. `services/ingestion/README.md`

A listed document that is missing, or an empty UI folder, **fails** the check; it never shrinks the scope silently.

**Phrases** (AD-6 §6, D-15, scope §1.3): "live routing", "routing on/with/using live data" (and the real-time variants), "real-time optimal route", "real-time routing". A line that quotes a phrase only to forbid it passes: the phrase must be quoted after an explicit prohibition ("do not describe ... as", "never call it", "is never used"), or follow "is not". A bare "no" or "not" elsewhere on the line excuses nothing.

**Not scanned (exclusions):**
- `services/web/test/` and every other test file, which quote the phrases as assertions;
- the Phase 3 design documents (`PHASE3_SCOPE.md`, `PHASE3_AD1_COMPONENT_VIEW.md`, `PHASE3_AD4_EVENT_ENVELOPE.md`, `PHASE3_AD6_ENGINE_BOUNDARY.md`), which quote the phrases in order to forbid them, and this document;
- other documents (`PHASE2_API_CONTRACT.md`, `PHASE2_ARCHITECTURE.md`, the Stage 1x results, the roadmap) and any other README;
- build output and `node_modules`; and the generated bundle.

**Human wording review is still required.** The check is a pattern match. It cannot judge a sentence that implies live routing without using the listed words, and a crafted sentence that imitates a denial could pass. Before sign-off a person reads the UI strings (`services/web/src/features/observations/ObservationPanel.tsx` and the dashboard copy) and the status wording of the 10 documents against scope §1.3 and §6, and records that review with the gate evidence.

## 4. T-7: baseline and regression suites

- **Baseline:** commit `28da68f`, the merge of PR #14 (Phase 2 integrated, all CI checks passed). It must be an ancestor of the commit under test, so the job clones the full history.
- **Protected paths:** `src/`, `data/`, `outputs/`, `tests/`, `contracts/fixtures/`, `contracts/test-vectors/`, `contracts/openapi/`, `services/inference/`, the backend `routes`, `mappers` and `inferenceClient` folders, the root Phase 1 `.py` scripts and the requirements files. A modification, deletion or rename there fails. An addition fails unless it is in `AUTHORIZED_ADDITIONS`, which holds one file: `contracts/test-vectors/event_payload_hash.v1.json` (AD-4 §10).
- **Suites:** the Phase 1 and Phase 2 suites are **not run again**. `regression-gate` waits for the existing workflows on the pull request head commit through the REST API. `tests` (Phase 1, Windows) and `phase2-docker` are required. `phase2-integration` and `phase2-stack` are path-filtered: if they ran they must have passed, and the log states which did not run, so nothing is claimed for them.
- **Branch protection** should require `guards`, `regression-gate`, `acceptance-stack` and `acceptance-browser`. That is a repository setting and is not made by this change.

## 5. Evidence limitations (what is not shown)

1. **A live `503 SHUTTING_DOWN` is not shown on a real stack.** The sigterm phase proves the backend exits 0 within its grace period, ends every open stream, and refuses a stream requested right after the signal. The refusal it accepts is a `502` from Nginx, a refused connection, or `503 SHUTTING_DOWN` with `Retry-After: 1`. Which one occurs depends on a race between the backend closing its listener and Nginx noticing. The exact `503 SHUTTING_DOWN` body and header are asserted only in the backend's own tests, with the hub in its shutting-down state, not on a running stack. The code is in `services/backend/src/observations/route.ts`.
2. **T-5, inference side.** Not run or claimed (D-25; B-4 stays unresolved for AD-10).
3. **No live source.** Every event is synthetic. The streaming pipeline has been exercised with synthetic events only; no live source is integrated.
4. **Test-only fake ingestion.** The fault, stale and outage evidence comes from `infra/testing/fault_ingestion/`, which is not in any production image.
5. **Preview mode is built outside the production image.** `services/web/Dockerfile` has no `VITE_API_MODE` build argument, so the browser job builds a preview bundle from the unmodified sources in a throwaway Node container and copies it into the plain stack's Nginx. It proves the app's preview behaviour (the preview notice is shown, no panel, no stream request), not a preview production image.
6. **Hidden-tab behaviour is emulated** by overriding `document.visibilityState` and dispatching `visibilitychange`; it is not a real background tab. Component tests cover `pageshow`, `online` and the combined triggers.
7. **Narrow screens (confirmed).** The panel is desktop-only: `DashboardPage` shows the desktop dashboard from `(min-width: 1024px)` and only `DashboardDesktop` mounts the panel (AD-1 v0.5 §3.3.4), and `services/web/test/observations/dashboard.test.tsx` asserts "makes no stream request below 1024px, where the mobile dashboard is shown". The browser test confirms it at 390 px (no panel, no stream request, no sideways scrolling) and confirms the panel fits at exactly 1024 px. The AD-1 text does not define a mobile panel; adding one would be a frontend change that needs its own approval.
8. **T-10 is a text check** on the result region, not a proof over every screen.
9. **Latency and soak numbers are from one disposable runner each**; the p95 budget check depends on the runner's clock and load. A failure there should be read, not re-run blindly.
10. **Runtime estimates in §1 are unmeasured in CI.**
11. **T-6 hashes cover** the trees named in §2. They do not cover a Docker image digest, a model checkpoint outside `outputs/`, or the PostgreSQL contents (rows are checked by T-1 and T-2).
12. **The regression gate can only wait for what GitHub reports.** If an existing workflow is renamed, the gate's required list (`infra/scripts/wait_for_workflows.py`) must change with it; a test checks that the names exist.
