# AD-1: Component View

**Status:** **DRAFT v0.1**, 24 November 2026. Not reviewed, not approved. No code may start before it is approved (D-22).
**Lead:** Dev D. **Reviewers:** Dev A, Dev B, Dev C. **Approver:** project owner.
**Scope source:** `docs/PHASE3_SCOPE.md` v1.3 §2.2.2, §7.3; D-22, D-24; F-2, F-3, F-6.
**Extends:** `PHASE2_ARCHITECTURE.md` §2. **Relies on:** AD-4 (envelope) and AD-6 (boundary), both drafts.

Approving this view satisfies D-22 **for the D-24 slice only**. §4 places the later components, but the owner must confirm that placement before any milestone 3.2–3.7 begins.

## 1. Components of the slice

```text
 existing Phase 2 network (unchanged)             new "observations" network (internal)

 Browser --> web (nginx) --> backend (Express) ---- polls ----> ingestion (Python, synthetic)
             127.0.0.1           |   |                           no published port
                                 |   +--> postgres
                                 +------> inference    (no path from ingestion)
```

| Component | Does | Must not | Owner |
|---|---|---|---|
| **Ingestion** (new, `services/ingestion/`) | Generates seeded synthetic `fx_rate` envelopes (AD-4); serves the latest one per pair over private HTTP | Contact any external host, the inference service or PostgreSQL; mount project files; hold a secret | Dev A |
| **Observation module** (new, in Express) | Polls ingestion, validates, keeps the latest valid event per pair in memory, serves SSE | Import, or be imported by, routing, mapper or inference-client code; write to the database | Dev B |
| **Observation panel** (new, in React) | Shows values, labels, age and source on the desktop dashboard | Share state with any form or routing request | Dev C |
| **Compose overlay** (new, `infra/compose.observations.yaml`) | Adds ingestion and its network; enables the feature | Publish a port; change `compose.yaml` | Dev D |

Express is the only component on both networks, and it forwards nothing between them. Inference, Prisma, PostgreSQL, the engine, API contract v0.4 and the OpenAPI files are unchanged.

## 2. Trust boundaries

| Boundary | Control |
|---|---|
| Browser → Express | Existing development bearer token in the `Authorization` header, never in a URL. Loopback only (A-1, D-16). |
| Ingestion → Express | Untrusted input. Express validates strictly, accepts only synthetic `fx_rate` events from `synthetic.fx`, and bounds response size and time. The connection has no authentication; isolation is the internal network, or host loopback outside Docker. |
| Observation → engine | No path (AD-6). Enforced by network, import checks and non-interference tests. |

## 3. Slice decisions

Under D-24 these stand in for the named deliverables **for this slice only**. They do not approve those deliverables.

| For | Decision |
|---|---|
| AD-2, AD-3 | 2 events/s: 4 pairs, one update each per 2 s. No broker, durability or replay. Express polls every 500 ms. A restart may lose state. |
| AD-5 | One hard-coded source: `synthetic.fx`, transport `synthetic`. A repeated `event_id` is ignored; the greatest `source_timestamp` per pair wins; invalid events are rejected and counted. An unreachable source is retried at the poll interval and never refreshes a value's age. |
| AD-7 | SSE: `GET /api/rt/v1/observations/stream`, outside v0.4, read with `fetch`. A full snapshot on connect, then updates; each message carries a protocol version and the server's evaluation time; heartbeat every 15 s; `X-Accel-Buffering: no`. The client reconnects after 1 s, backing off to 4 s, and never after a 401. |
| AD-8 | Freshness age from `source_timestamp`; stale above 6 s; unavailable above 30 s; clock tolerance 1 s. Display p95 ≤ 1 s from `emitted_at`, with both clocks on one host; reconnect p95 ≤ 5 s from the moment the backend is reachable again. Numbers are for the slice, not final budgets. |
| AD-9 | A value reads "Simulated" (shown as SIMULATED), then "Simulated · stale", then "Unavailable" with no number. A lost stream shows a disconnected status, and ages keep advancing. Routing is unaffected throughout. |
| AD-10 | Threats covered: token leakage, stream exhaustion (3 streams per user, 20 in total; further ones get 429), malformed or forged input, accidental exposure. Sign-out and server shutdown close streams. Development auth stays; this is not Gate 4 evidence. |
| AD-12 | Seed and sequence fix payloads and hashes. Timestamps come from an injected clock, and `event_id` is derived from seed, sequence and timestamp. Rates are deliberately unrealistic. Faults tested: duplicate, older, malformed, non-synthetic, outage, recovery. No review queue. |

**Off by default.** Without `OBSERVATIONS_URL`, Express does not poll and does not register the route. Without the web build flag `VITE_OBSERVATIONS=on`, the panel is not shown and nothing is requested. The overlay sets both and builds separately tagged images. The `full` profile on its own never needs ingestion, and the backend does not wait for it.

**Not recorded:** which observations were displayed (AD-6 §6.1). This slice stores nothing; that work stays with AD-7 and AD-11.

## 4. Placement of later components (not authorized)

| Component | Placement |
|---|---|
| Live adapters | Inside ingestion, one per Gate 3-approved provider, with outbound access limited to that provider |
| Event distribution | Between ingestion and Express; mechanism open (AD-2, AD-3). It replaces the poll. |
| Observation store, audit trail | Separate from Phase 2 records (AD-11) |
| Quarantine and review queue | After ingestion; no automatic path to the knowledge layer (AD-12, Gate 2) |
| Identity provider | Replaces development auth on Express routes and the stream (AD-10, milestone 3.2) |

## 5. Known gaps for reviewers

1. **Flagged for Dev B.** AD-6 B-4 also says inference has no route to the internet. The Phase 2 stack does not enforce that, and this slice leaves `compose.yaml` unchanged. The slice delivers only the ingestion side of B-4. Proposed: accept for the slice, and close in AD-10.
2. Express is on both networks, so it is the single point that keeps them apart.
3. `fetch` streaming needs one addition to the web API client, whose current method buffers whole responses. The web Dockerfile needs one build argument, off by default.

## 6. Acceptance

1. The same seed gives identical payloads and hashes; every event passes the AD-4 schema.
2. The panel updates with no user action; AD-8 targets are met over 5 minutes; every value shows label, source and age.
3. Each AD-12 fault leaves the displayed value correct; AD-9 states appear at their thresholds.
4. 401, stream caps, sign-out, disconnect and clean shutdown behave as in §3.
5. AD-6 T-1 to T-4, T-6 to T-8 and T-10 pass; T-5 passes for ingestion (no route to inference, PostgreSQL or the internet; no credentials). T-9 does not apply, because no context is recorded.
6. With the feature off, the Phase 1 and 2 suites, the fixtures and the existing Compose and stack-security checks pass unmodified.

## 7. Approval checklist

- [ ] Dev A: ingestion and generator (§1; §3 AD-2, AD-5, AD-12)
- [ ] Dev B: observation module, SSE, authentication (§2; §3 AD-7, AD-10)
- [ ] Dev C: panel, labels, off-by-default behaviour (§3 AD-8, AD-9)
- [ ] Project owner: approval, recorded in `docs/PHASE3_SCOPE.md` §2
