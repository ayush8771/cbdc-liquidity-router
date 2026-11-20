/*
 * GET /api/v1/dashboard/summary (contract §3.8) and the recent-transactions
 * list for the desktop dashboard. The two are separate requests with separate
 * results, so one failing never hides the other:
 * - the summary becomes the DashboardSummaryView the page already renders
 *   (summaryTypes.ts): a copy of the same field names behind a strict check;
 * - the recent transactions are the first page of the History's own request
 *   (GET /api/v1/transactions, via fetchTransactionPage), shaped for the list.
 * Nothing here recomputes a value: a null stays null ("not available").
 */
import { ApiError, INVALID_RESPONSE, type ApiClient } from "../../api/client";
import { isApiDashboardSummary, type ApiDashboardSummary } from "../../api/types";
import { fetchTransactionPage } from "../transactions/historyApi";
import { DEFAULT_PAGE_SIZE } from "../transactions/historyQuery";
import { outcomeOf, type TransactionSummaryView } from "../transactions/historyTypes";
import type { PolicyKey, TransactionRow } from "../transactions/types";
import { toWindow, type DashboardFilters } from "./dashboardQuery";
import type { DashboardSummaryView } from "./summaryTypes";

/**
 * The summary request's query parameters, under the contract's names. `from`
 * and `to` are UTC-midnight ISO timestamps, `from` inclusive and `to`
 * exclusive (§3.3, §3.8); an unset filter is left out (unbounded).
 */
export function toDashboardApiQuery(filters: DashboardFilters) {
  const window = toWindow(filters);
  return {
    from: window.from ?? undefined,
    to: window.to ?? undefined,
    corridor: filters.corridor,
    policy: filters.policy,
  };
}

/**
 * API summary to display model: the same names, passed through. A policy this
 * version doesn't know is kept as written (contract §1). `meanFeeCostPct`
 * stays the percentage number it is (1.4 is 1.4%).
 */
export function mapDashboardSummary(summary: ApiDashboardSummary): DashboardSummaryView {
  return {
    window: { from: summary.window.from, to: summary.window.to },
    totals: { ...summary.totals },
    byPolicy: summary.byPolicy.map((p) => ({
      policy: p.policy as PolicyKey,
      count: p.count,
      allowedRouted: p.allowedRouted,
      completionRate: p.completionRate,
      meanRewardAmountBased: p.meanRewardAmountBased,
      meanFeeCostPct: p.meanFeeCostPct,
      meanLatencyTerm: p.meanLatencyTerm,
      meanRiskTerm: p.meanRiskTerm,
    })),
    byCorridor: summary.byCorridor.map((c) => ({
      corridor: c.corridor,
      routed: c.routed,
      allowedRouted: c.allowedRouted,
      completionRate: c.completionRate,
    })),
    note: summary.note,
  };
}

/** One request for the summary. A body that isn't the documented shape is an INVALID_RESPONSE error. */
export async function fetchDashboardSummary(api: ApiClient, filters: DashboardFilters): Promise<DashboardSummaryView> {
  const raw = await api.get<unknown>("/dashboard/summary", { query: toDashboardApiQuery(filters) });
  if (!isApiDashboardSummary(raw)) {
    throw new ApiError({ status: 200, code: INVALID_RESPONSE, message: "The server's response could not be read." });
  }
  return mapDashboardSummary(raw);
}

/** A history row as the recent-transactions list shows it. The outcome is derived as the History derives it. */
export function toRecentRow(row: TransactionSummaryView): TransactionRow {
  return {
    id: row.id,
    createdAt: row.createdAt,
    corridor: row.corridor,
    amountUsd: row.amountUsd,
    policy: row.policy,
    policyTier: row.policyStatus,
    outcome: outcomeOf(row),
    stateMode: row.stateMode,
    simulationDate: row.simulationDate,
  };
}

/**
 * The newest transactions overall: the first page of the History's own request
 * (no filters; the dashboard's filters apply to the summary only), at most `count` rows.
 */
export async function fetchRecentTransactions(api: ApiClient, count: number): Promise<TransactionRow[]> {
  const page = await fetchTransactionPage(api, { page: 1, pageSize: Math.min(count, DEFAULT_PAGE_SIZE) });
  return page.items.slice(0, count).map(toRecentRow);
}

export type DashboardErrorView = {
  message: string;
  /** Field messages of a 422, as "field: message". */
  details: string[];
  /** The request ID, for the user to quote. */
  reference: string | undefined;
  canRetry: boolean;
};

/**
 * What to tell the user about a failed summary. The wording is this UI's own,
 * chosen by `code` and `status`, never by the backend's `message`. The summary
 * reads the database only, so the cases are an unreachable server, an
 * unreadable body and the server's own errors.
 */
export function describeDashboardError(error: unknown): DashboardErrorView {
  if (!(error instanceof ApiError)) {
    return { message: "Something went wrong while loading the dashboard.", details: [], reference: undefined, canRetry: true };
  }
  const reference = error.requestId ?? undefined;
  const view = (message: string, canRetry = true, details: string[] = []): DashboardErrorView => ({
    message,
    details,
    reference,
    canRetry,
  });

  if (error.code === "NETWORK_ERROR") return view("The server could not be reached. Check your connection, then try again.");
  if (error.code === INVALID_RESPONSE) return view("The server sent a response this page couldn't read.");
  if (error.status === 422) {
    const details = (error.details.errors ?? []).map((e) => (e.field ? `${e.field}: ${e.message}` : e.message));
    return view("The server didn't accept these filters.", false, details);
  }
  if (error.status === 403) return view("You don't have access to the dashboard.", false);
  if (error.status >= 500) return view("The server hit an unexpected error. Try again in a moment.");
  return view(`The request failed (${error.code}).`);
}
