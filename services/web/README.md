# CBDC Liquidity Router — web frontend (Phase 2, Dev C)

React 19 + Vite 7 + Tailwind CSS 3.4 + TypeScript. Owner: Dev C (`services/web/`, branch `feature/phase2-web`).
Architecture: `docs/PHASE2_ARCHITECTURE.md` §3, §5.3, §8.3. API: `docs/PHASE2_API_CONTRACT.md` §3–§4.

**Contract status.** The screens below were last checked against contract v0.4 **rev 5** (commit `a42a7c3` on `docs/phase2-v0.4`). The application OpenAPI file is unchanged from rev 4. A later commit on that branch (rev 6) has not been checked. The contract is still a draft pending approval, and has not been merged into this branch.

## What is built, and what is not

**Every data screen runs on illustrative preview data. Nothing here talks to the backend.** There is no API client yet, so none of these screens is connected to a live API, and none shows live bridge availability or real liquidity.

| Screen | Route | State | Data |
|---|---|---|---|
| Dashboard | `/` | Built | Preview data. Filters (corridor, policy, from, to) in the URL, the date window, totals, activity by corridor and policy, a policy metrics table and a corridor metrics table, recent transactions. The policy means (fee cost, reward, latency, risk) show "—": the preview data has no values for them. |
| History | `/transactions` | Built | Preview data. Filters, page size (20, 50, 100) and page in the URL; every invalid parameter is reported and no list is shown until they are fixed; table with state mode, simulation date and executed amount; links to each transaction. |
| Transaction detail | `/transactions/:id` | Built | Preview details for each of the 57 preview transactions: amounts, decision (with its decision ID), allocations, warnings, failure details. No explanation panel: the explanation endpoint is not available. |
| New transaction | `/transactions/new` | Built, **mock submission only** | A form that calls a stand-in service in `src/preview/mockSubmit.ts`. Nothing is sent to the API. Results (completed, partial, rejection) and failures are illustrative. |
| Network | `/network` | Built | Preview reference data: corridors, venues, fees, baseline capacity and data source. Baseline capacity is static reference data, not live liquidity. |
| Bridge monitor | `/bridges` | Built (globe only) | An illustrative 3D globe of the six countries and three corridors. It shows no liquidity, congestion, status or availability. `GET /api/v1/state` is not connected. |
| Compare policies | `/compare` | **Not built.** A placeholder that lists its endpoints. | — |
| Sign-in | `/sign-in` | **Visual only.** It does not validate, store or send the token; validation with `GET /api/v1/auth/me` needs the API client. From 1024px it adds an always-visible "Preview mode" notice, a Show/Hide token control, and visual previews of the checking, invalid-token and error states (`?state=checking`, `?state=invalid`, `?state=error`) that verify, send and store nothing. Below 1024px the page is unchanged. | — |

Also in place: scaffold, routing, design tokens, the shared UI components, the app shell (sidebar, mobile menu, persistent dev-auth banner), and the mandatory labels (arch §5.3), which are constants and a badge component tested against the architecture doc. Routes are not guarded, because there is no session to check.

### Desktop-only screens (1024px and up)

The data screens are gated at **1024px**, the same point as Tailwind's `lg` and the sidebar. Each page chooses its version with `useMediaQuery("(min-width: 1024px)")`.

| Screen | At 1024px and up | Below 1024px |
|---|---|---|
| Dashboard | The desktop dashboard (`DashboardDesktop`) | The original dashboard, unchanged |
| History | The desktop history (`HistoryDesktop`) | The original history, unchanged (table from 768px, cards below) |
| Transaction detail | The preview detail page | The original placeholder, unchanged |
| New transaction | The form with the mock service | The original placeholder, unchanged |
| Network | The network page | The original placeholder, unchanged |
| Bridge monitor | The globe (the 3D code loads only here) | The original placeholder, unchanged |

Because the narrow versions are kept exactly as they were, a few of them still reflect an earlier draft of the contract: the original History includes the "to" day and ignores invalid filter values, and the original Dashboard names the per-corridor count `count` and has a footnote saying what the counts include is still being agreed. These are deliberately not changed. The integration mapper is where the contract's names and rules apply.

jsdom has no `matchMedia`, so in tests every gated page renders its narrow version unless a test mocks `matchMedia`; the desktop tests do.

### Preview data (temporary)

The screens render **illustrative preview data** from `src/preview/`, until the shared API contracts are merged and the API client exists.
- **Isolation:** it is generated in code (seeded, so stable), never copied from `contracts/fixtures/`, and kept apart from `src/mocks/`, which is reserved for MSW.
- **Labelling:** each page that uses it shows "Preview data — illustrative, not from the API". Results from the mock service say "Preview result — illustrative, not from the API".
- **Review states:** add `?state=loading`, `?state=empty` or `?state=error` to the URL of the Dashboard, History, Network or Transaction detail page. (Empty applies where a page has an empty state.)
- **Mock failures:** on New transaction, `?mock=validation`, `busy`, `timeout`, `unavailable`, `notready` or `error` makes every submission return that failure. `notready` is the engine still starting up (a 503 `INFERENCE_UNAVAILABLE` with `details.cause: "NOT_READY"`). A failed submission is never retried automatically, and no `Retry-After` countdown is shown, because whether the backend forwards that header is not settled.
- **Display models:** components take UI-owned display models (`src/features/*/` types), not API types. At integration, a mapper converts the generated API types into them, and `src/preview/` is deleted.
- **What is deliberately absent** because the contract has no field for it:
  - a routed-value (USD) total;
  - activity over time;
  - separate sender and receiver columns in the history list (it has `corridor` only);
  - free-text search (there is "open by transaction ID" instead);
  - a status filter;
  - live liquidity or congestion on the network page (those come from `/state`).

### Not done, and dependencies on the other services

- **Compare policies** is not built.
- **API client, auth context, MSW mock mode and generated types: not started.** The libraries (`msw`, `openapi-typescript`, `@tanstack/react-query`) are installed but not yet used. This is blocked on the shared `contracts/` folder reaching `main`.
- **Live integration is not done.** As reported by the other developers (not verified here), live transaction creation currently fails because the engine returns `decision_id: None`, the explanation endpoint returns 404, `/v1/compare` is not implemented, the dashboard's `meanFeeCostPct` needs a backend column, and the liveness endpoint is still to be implemented and confirmed.

## Commands

Requires Node `^20.19.0 || ^22.13.0` and npm ≥ 10.

```bash
npm ci            # install exactly what package-lock.json records
npm run dev       # http://localhost:5173 ; /api is proxied to the backend on :4000
npm run typecheck
npm run lint
npm test          # Vitest + Testing Library (jsdom)
npm run build     # type check, then production build to dist/
npm run preview   # serve dist/ on :5173
```

## Design system

Visual direction: the Slash style from Refero ("midnight vault with gilded ledger lines"), adapted to an application. No Slash branding, logo or assets are used.

- **Source:** the Refero Extended `DESIGN.md` export for Slash ("Slash — Style Reference"). The export targets Tailwind v4; its values are expressed here in Tailwind 3.4. The export itself is not in the repository.
- **Tokens:** `src/styles/tokens.css` defines every colour, display size, radius and width once, as CSS variables. `tailwind.config.ts` maps them to utilities whose names follow the export:
  - colours (`obsidian` … `paper-white`, `copper`);
  - surfaces `surface-void`, `surface-card`, `surface-panel`, `surface-floating`;
  - the type scale `eyebrow`, `body-xs` (16px), `body-sm` (18px), `body` (20px), `subheading`, `heading-sm` … `display`;
  - radii `card` (10px), `pill` and `indicator` (2px);
  - `shadow-subtle` and `bg-gilded`.

  `ink-*`, `line-*` and `status-*` are semantic aliases. Components use only these names.
- **Rules taken from the export:**
  - The serif is used only at 28px and above, and Inter never above 48px.
  - Body text is 16px Inter in Bone.
  - The white filled button is used once per viewport.
  - Copper is used only for category labels; never on buttons, icons, borders or the focus ring.
  - Cards are Onyx with 1px Graphite borders and no shadows.
  - Inputs use the Panel surface.
  - Navigation links have no background: Fog when inactive, white when active.
  - Eyebrows are 13px Inter 600 at −0.02em: Fog for section types, Copper (`.eyebrow-category`) for categories.
  - The gilded gradient is for charts only.
- **App adaptations (deliberate):**
  - Display sizes scale down on small screens, never below 28px.
  - The 160px marketing section gap isn't used.
  - Inputs use a Steel border, not the white one of the export's single hero email field.
  - Amber and red status colours are added beside the export's sage green.
  - The serif fallback is a serif.
  - Ash never carries text, although the export lists it for muted text.
- **Type:** Playfair Display, the export's first listed substitute for the commercial Ivy Presto, and Inter. Both are self-hosted through `@fontsource`.
- **Contrast (measured, WCAG 2.1):**
  - Text uses Bone, Silver, Mist or Fog.
  - Steel is used only on Obsidian or Onyx; on Carbon it is 4.35:1, which fails.
  - Steel control borders meet the 3:1 boundary requirement.
  - Status colours are ≥ 6.3:1 on every surface.
- **Focus:** one Paper White ring with an Obsidian gap everywhere (`:focus-visible`).

## Layout

```
src/
  app/          routes, navigation entries
  components/
    ui/         Button, Input, Select, Label, FormField, Badge, Card, StatusIndicator,
                PageHeading, Notice, EmptyState, ErrorState, LoadingState/Skeleton,
                Table, Pagination, DescriptionList, Stat, Icon (inline SVG)
    labels/     MandatoryLabel
    layout/     AppShell, Sidebar, MobileHeader, NavItem, DevAuthBanner, Wordmark
  features/
    auth/         SignInStatus, TokenField (visual sign-in previews)
    dashboard/    KpiGrid, ActivityBars, DashboardFilters, PolicyMetricsTable,
                  dashboardQuery.ts (URL filters, UTC window), summaryTypes.ts (desktop model),
                  types.ts (the original, narrow model)
    globe/        Globe, createGlobeScene (the only module that imports three), geo.ts, GlobeControls
    network/      CorridorCard, display types and the fee formatter
    newTransaction/  TransactionForm, ResultPanel, validate.ts, display types
    transactions/ TransactionList (table / mobile cards), OutcomeBadge, PolicyCell,
                  HistoryFilterBar and filters.ts (the original history),
                  historyQuery.ts, HistoryFiltersDesktop, HistoryTableDesktop (desktop history),
                  detail/ (the detail page's panels), detailTypes.ts, historyTypes.ts, display types
  lib/          labels.ts (exact mandatory strings), format.ts, cx.ts, useMediaQuery.ts
  pages/        SignInPage, DashboardPage + DashboardDesktop, HistoryPage + HistoryDesktop,
                TransactionDetailPage, NewTransactionPage, NetworkPage, BridgeMonitorPage,
                PendingScreen + screens.ts, NotFoundPage
  preview/      TEMPORARY preview data and the mock service: previewData, previewDetail,
                previewDashboard, previewHistory, previewNetwork, previewReference, mockSubmit,
                PreviewNotice, usePreviewState (?state=)
  styles/       tokens.css, globals.css
test/           Vitest suites
public/textures/  earth textures for the globe
```

Still to come (arch §4): `src/api/` (typed client; `generated/` is git-ignored), `src/auth/`, `src/mocks/` (MSW reading `../../contracts/fixtures/app/` directly, never copied), the Compare policies screen, and the `Dockerfile`.

## Dependency notes

- Tool versions are chosen to support Node 20.19+: Vitest 4, jsdom 27, jest-dom 6, MSW 2. The current majors of Vitest, jsdom, MSW and jest-dom require Node 22.
- `@tanstack/react-query` 5.105.3 (runtime), `msw` 2.15.0 and `openapi-typescript` 7.13.0 (development) are pinned exactly for the API work.
- `three` 0.187.0 draws the Bridge monitor globe. It is loaded only through a dynamic import, in its own chunk, from 1024px up.
- `"overrides": {"vite": "$vite"}` keeps a single Vite 7.3.7 in the tree. Without it, npm 10's resolver crashes (`Cannot read properties of null (reading 'edgesOut')`). It evaluates Vite 8 for Vitest, and Vite 8's optional `@vitejs/devtools` peer loops back to `vitest@*`.

## Rules that apply here

- The frontend calls only the backend, at the same-origin `/api/v1` (arch D9).
- Components display API values; they never recompute allocations or metrics.
- Tokens are never written to `localStorage`, cookies, URLs, logs or `VITE_*` variables (arch §8.3).
