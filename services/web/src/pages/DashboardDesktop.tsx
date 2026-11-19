import { useSearchParams } from "react-router-dom";
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
import { DashboardFilters } from "../features/dashboard/DashboardFilters";
import {
  describeWindow,
  hasDashboardFilters,
  readDashboardParams,
  toWindow,
  writeDashboardParams,
  type DashboardFilters as Filters,
} from "../features/dashboard/dashboardQuery";
import { KpiGrid } from "../features/dashboard/KpiGrid";
import { CorridorMetricsTable, PolicyMetricsTable } from "../features/dashboard/PolicyMetricsTable";
import { TransactionList } from "../features/transactions/TransactionList";
import { POLICY_NAMES } from "../features/transactions/types";
import { formatCorridor } from "../lib/format";
import { NO_LIQUIDITY_CARRY_OVER } from "../lib/labels";
import { PREVIEW_TRANSACTIONS } from "../preview/previewData";
import { queryPreviewDashboard } from "../preview/previewDashboard";
import { PreviewNotice } from "../preview/PreviewNotice";
import { usePreviewState } from "../preview/usePreviewState";

// Recent activity is the history list, newest first (contract §3.3 default sort). It does not come from the summary.
const RECENT_COUNT = 5;

/**
 * The desktop dashboard (1024px and up) on PREVIEW DATA. It will read
 * GET /api/v1/dashboard/summary and GET /api/v1/transactions once the shared
 * contracts are integrated. Filters live in the URL under the contract's query
 * names. Preview states: ?state=loading, ?state=empty and ?state=error.
 */
export function DashboardDesktop() {
  const [params, setParams] = useSearchParams();
  const { state, clear } = usePreviewState();
  const { filters, problems } = readDashboardParams(params);
  const hasProblems = Object.keys(problems).length > 0;

  // A filter that can't be applied blocks the summary: nothing is corrected for the user.
  const summary = hasProblems
    ? null
    : queryPreviewDashboard({ corridor: filters.corridor, policy: filters.policy, window: toWindow(filters) });

  const update = (next: Filters) => {
    const nextParams = writeDashboardParams(next);
    const previewState = params.get("state");
    if (previewState) nextParams.set("state", previewState);
    setParams(nextParams);
  };

  const filtersActive = hasDashboardFilters(filters);
  const isEmpty = state === "empty" || (summary !== null && summary.totals.transactions === 0);
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

      <Card>
        <DashboardFilters filters={filters} problems={problems} onChange={update} />
      </Card>

      {hasProblems ? (
        <Notice tone="warning" title="The summary isn't shown">
          A filter can&apos;t be applied. Fix the highlighted filters; nothing has been changed for you.
        </Notice>
      ) : state === "error" ? (
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
      ) : summary ? (
        <>
          <p className="text-ui text-ink-secondary">
            <span className="text-ink-muted">Window: </span>
            <span data-testid="window">{describeWindow(summary.window)}</span>
          </p>

          {state === "loading" ? (
            <section aria-labelledby="totals-heading" className="space-y-4">
              <h2 id="totals-heading" className="sr-only">
                Totals
              </h2>
              <LoadingState label="Loading dashboard" rows={0} />
              <KpiGrid totals={null} />
            </section>
          ) : isEmpty ? (
            <Card padded={false}>
              <EmptyState
                icon="route"
                title={filtersActive && state !== "empty" ? "No transactions in this window" : "No transactions yet"}
                actions={
                  filtersActive && state !== "empty" ? (
                    <Button variant="secondary" onClick={() => update({})}>
                      Clear filters
                    </Button>
                  ) : (
                    <ButtonLink to="/transactions/new" variant="primary">
                      New transaction
                    </ButtonLink>
                  )
                }
              >
                {filtersActive && state !== "empty"
                  ? "Try a wider date range or fewer filters."
                  : "Routed transactions and their outcomes will be summarised here."}
              </EmptyState>
            </Card>
          ) : (
            <>
              <section aria-labelledby="totals-heading" className="space-y-4">
                <h2 id="totals-heading" className="sr-only">
                  Totals
                </h2>
                <KpiGrid totals={summary.totals} />
              </section>

              <div className="grid grid-cols-2 gap-4">
                <Card aria-label="Activity by corridor">
                  <CardHeader
                    title="Activity by corridor"
                    description="Routed transactions per corridor. Failed transactions have no corridor."
                  />
                  {summary.byCorridor.length === 0 ? (
                    <p className="text-ui text-ink-muted">No routed transactions in this window.</p>
                  ) : (
                    <ActivityBars
                      caption="Routed transactions"
                      categoryHeader="Corridor"
                      items={summary.byCorridor.map((c) => ({
                        key: c.corridor,
                        label: formatCorridor(c.corridor),
                        value: c.routed,
                        completionRate: c.completionRate,
                      }))}
                    />
                  )}
                </Card>
                <Card aria-label="Activity by policy">
                  <CardHeader
                    title="Activity by policy"
                    description="Requests per policy, failed and rejected ones included."
                  />
                  <ActivityBars
                    caption="Requests by policy"
                    categoryHeader="Policy"
                    items={summary.byPolicy.map((p) => ({
                      key: p.policy,
                      label: POLICY_NAMES[p.policy],
                      value: p.count,
                      completionRate: p.completionRate,
                    }))}
                  />
                </Card>
              </div>

              <Card aria-label="Policy metrics">
                <CardHeader
                  title="Policy metrics"
                  description="One row per policy that was requested in this window."
                  actions={<MandatoryLabel kind="placeholderWeights" />}
                />
                {/* The eight columns need the wider layout; below 1280px the table scrolls inside its card. */}
                <p className="mb-3 text-meta text-ink-muted xl:hidden">Scroll sideways to see every column.</p>
                <PolicyMetricsTable rows={summary.byPolicy} />
                <div className="mt-5 space-y-2 border-t border-line-subtle pt-4 text-meta text-ink-muted">
                  <p>
                    <strong className="font-medium text-ink-secondary">Requests</strong> counts every transaction that
                    asked for the policy, failed and rejected ones included.{" "}
                    <strong className="font-medium text-ink-secondary">Allowed routed</strong> counts routed decisions
                    the feasibility rules allowed: it is the denominator of the completion rate and of every mean.
                  </p>
                  <p>
                    A dash means the value isn&apos;t available. The preview data has no fee cost, reward, latency or
                    risk values, so those columns stay empty here. Reward, latency and risk use placeholder weights:
                    the table is not a ranking.
                  </p>
                </div>
              </Card>

              <Card aria-label="Corridor metrics">
                <CardHeader title="Corridor metrics" description="Routed decisions per corridor, with the completion denominator." />
                <CorridorMetricsTable rows={summary.byCorridor} />
              </Card>

              <p className="text-meta text-ink-muted">
                <span className="font-medium text-ink-secondary">Note: </span>
                {summary.note}
              </p>
            </>
          )}

          <Card aria-label="Recent transactions">
            <CardHeader
              title="Recent transactions"
              description="The newest transactions overall, from the transaction history. The filters above apply to the summary only."
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
        </>
      ) : null}
    </div>
  );
}
