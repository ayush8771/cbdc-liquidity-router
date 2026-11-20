import { MandatoryLabel } from "../components/labels/MandatoryLabel";
import { Button, ButtonLink } from "../components/ui/Button";
import { Card, CardHeader } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { LoadingState } from "../components/ui/LoadingState";
import { Notice } from "../components/ui/Notice";
import { PageHeading } from "../components/ui/PageHeading";
import { StatusIndicator } from "../components/ui/StatusIndicator";
import { ActivityBars } from "../features/dashboard/ActivityBars";
import { KpiGrid } from "../features/dashboard/KpiGrid";
import { TransactionList } from "../features/transactions/TransactionList";
import { POLICY_NAMES } from "../features/transactions/types";
import { formatCorridor } from "../lib/format";
import { NO_LIQUIDITY_CARRY_OVER } from "../lib/labels";
import { useMediaQuery } from "../lib/useMediaQuery";
import { PREVIEW_DASHBOARD, PREVIEW_TRANSACTIONS } from "../preview/previewData";
import { PreviewNotice } from "../preview/PreviewNotice";
import { usePreviewState } from "../preview/usePreviewState";
import { DashboardDesktop } from "./DashboardDesktop";

// Recent activity is the history list, newest first (contract §3.3 default sort).
const RECENT_COUNT = 5;

// Desktop starts at 1024px, the same point as Tailwind's `lg` and the sidebar.
const DESKTOP = "(min-width: 1024px)";

/**
 * Dashboard on PREVIEW DATA. Will read GET /api/v1/dashboard/summary and
 * GET /api/v1/transactions once the shared contracts are integrated.
 *
 * This is the dashboard below 1024px. It is kept exactly as it was; only its
 * name changed, so the desktop version can be chosen above it.
 */
function NarrowDashboard() {
  const { state, clear } = usePreviewState();
  const view = PREVIEW_DASHBOARD;
  const recent = PREVIEW_TRANSACTIONS.slice(0, RECENT_COUNT);

  return (
    <div className="space-y-8">
      <PageHeading
        eyebrow="Overview"
        title="Dashboard"
        description="Aggregates over stored routing decisions, by policy and corridor."
        actions={<StatusIndicator tone="neutral" label="Not connected" />}
        meta={<MandatoryLabel kind="placeholderWeights" />}
      />

      <PreviewNotice />

      {state === "error" ? (
        <Card padded={false}>
          <ErrorState
            title="Couldn't load the dashboard"
            message="This is the preview of an error. With the live API, the server's message appears here."
            reference="preview"
            action={
              <Button variant="secondary" onClick={clear}>
                Try again
              </Button>
            }
          />
        </Card>
      ) : state === "empty" ? (
        <Card padded={false}>
          <EmptyState
            icon="route"
            title="No transactions yet"
            actions={
              <ButtonLink to="/transactions/new" variant="primary">
                New transaction
              </ButtonLink>
            }
          >
            Routed transactions and their outcomes will be summarised here.
          </EmptyState>
        </Card>
      ) : (
        <>
          <section aria-labelledby="totals-heading" className="space-y-4">
            <h2 id="totals-heading" className="sr-only">
              Totals
            </h2>
            {state === "loading" ? <LoadingState label="Loading dashboard" rows={0} /> : null}
            <KpiGrid totals={state === "loading" ? null : view.totals} />
          </section>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Activity by corridor" description="Transactions per corridor." />
              {state === "loading" ? (
                <LoadingState label="Loading corridor activity" rows={3} announce={false} />
              ) : (
                <ActivityBars
                  caption="Transactions by corridor"
                  categoryHeader="Corridor"
                  items={view.byCorridor.map((c) => ({
                    key: c.corridor,
                    label: formatCorridor(c.corridor),
                    value: c.count,
                    completionRate: c.completionRate,
                  }))}
                />
              )}
            </Card>
            <Card>
              <CardHeader title="Activity by policy" description="Transactions per requested policy." />
              {state === "loading" ? (
                <LoadingState label="Loading policy activity" rows={3} announce={false} />
              ) : (
                <ActivityBars
                  caption="Transactions by policy"
                  categoryHeader="Policy"
                  items={view.byPolicy.map((p) => ({
                    key: p.policy,
                    label: POLICY_NAMES[p.policy],
                    value: p.count,
                    completionRate: p.completionRate,
                  }))}
                />
              )}
            </Card>
          </div>

          <Card>
            <CardHeader
              title="Recent transactions"
              actions={
                <ButtonLink to="/transactions" variant="secondary" size="sm">
                  View all
                </ButtonLink>
              }
            />
            {state === "loading" ? (
              <LoadingState label="Loading recent transactions" rows={5} announce={false} />
            ) : (
              <TransactionList rows={recent} caption="Recent transactions" />
            )}
          </Card>

          <Notice>{NO_LIQUIDITY_CARRY_OVER}</Notice>
          <p className="text-meta text-ink-muted">
            Completion rates count only routed decisions that were allowed; rejected and failed transactions are
            counted separately. What the per-group counts include is still being agreed in the API contract.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Dashboard. From 1024px up it shows the desktop version; below that it
 * renders the existing dashboard, unchanged.
 */
export function DashboardPage() {
  const isDesktop = useMediaQuery(DESKTOP);
  return isDesktop ? <DashboardDesktop /> : <NarrowDashboard />;
}
