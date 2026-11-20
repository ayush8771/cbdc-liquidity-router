/*
 * PREVIEW DATA — a stand-in for GET /api/v1/dashboard/summary, computed from
 * the 57 preview transactions so the dashboard, the history list and the
 * detail pages agree with each other. Illustrative, not from the API, and not
 * used once integration starts: delete this file with ./previewData.ts.
 *
 * What is counted follows the rev 5 contract:
 * - totals count every transaction in the window;
 * - a policy's `count` is every transaction that requested it, failed and
 *   rejected included; `allowedRouted` is the routed decisions the feasibility
 *   rules allowed, and is the denominator of `completionRate`;
 * - a corridor's `routed` leaves out failed transactions, which have no corridor.
 *
 * What is NOT here, on purpose: the five mean fields. The preview data has no
 * reward, latency or risk values, and no fee cost in dollars, so there is
 * nothing real to average. Inventing them, or deriving a fee cost from the
 * allocations' fee rates without the contract saying that is how it is
 * computed, would look like findings. They are null, shown as "—".
 */
import type { CorridorSummary, DashboardSummaryView, PolicySummary, SummaryWindow } from "../features/dashboard/summaryTypes";
import { CORRIDORS } from "../features/transactions/filters";
import type { PolicyKey, TransactionRow } from "../features/transactions/types";
import { PREVIEW_TRANSACTIONS } from "./previewData";

const POLICY_ORDER: PolicyKey[] = ["waterfall", "cheapestFeasible", "ppoProjected"];

export type PreviewDashboardQuery = {
  corridor?: string;
  policy?: PolicyKey;
  window: SummaryWindow;
};

const isAllowedRouted = (row: TransactionRow) => row.outcome === "completed" || row.outcome === "partial";

/** completed ÷ allowed routed, or null when none were allowed (never 0). */
function completionRate(rows: TransactionRow[]): number | null {
  const allowed = rows.filter(isAllowedRouted);
  return allowed.length ? allowed.filter((r) => r.outcome === "completed").length / allowed.length : null;
}

/** The summary of the preview transactions inside a window, for the given filters. */
export function queryPreviewDashboard(query: PreviewDashboardQuery): DashboardSummaryView {
  const from = query.window.from === null ? Number.NEGATIVE_INFINITY : Date.parse(query.window.from);
  const to = query.window.to === null ? Number.POSITIVE_INFINITY : Date.parse(query.window.to);

  const rows = PREVIEW_TRANSACTIONS.filter((row) => {
    const at = Date.parse(row.createdAt);
    if (at < from || at >= to) return false; // from inclusive, to exclusive
    if (query.policy && row.policy !== query.policy) return false;
    // A failed transaction has no corridor, so a corridor filter leaves it out.
    if (query.corridor && row.corridor !== query.corridor) return false;
    return true;
  });

  const byPolicy: PolicySummary[] = POLICY_ORDER.flatMap((policy) => {
    const own = rows.filter((r) => r.policy === policy);
    if (own.length === 0) return [];
    return [
      {
        policy,
        count: own.length,
        allowedRouted: own.filter(isAllowedRouted).length,
        completionRate: completionRate(own),
        meanRewardAmountBased: null,
        meanFeeCostPct: null,
        meanLatencyTerm: null,
        meanRiskTerm: null,
      },
    ];
  });

  const byCorridor: CorridorSummary[] = CORRIDORS.flatMap((corridor) => {
    const own = rows.filter((r) => r.corridor === corridor); // failed rows have no corridor
    if (own.length === 0) return [];
    return [
      {
        corridor,
        routed: own.length,
        allowedRouted: own.filter(isAllowedRouted).length,
        completionRate: completionRate(own),
      },
    ];
  });

  return {
    window: query.window,
    totals: {
      transactions: rows.length,
      routed: rows.filter((r) => r.outcome !== "failed").length,
      failed: rows.filter((r) => r.outcome === "failed").length,
      rejectedByFeasibility: rows.filter((r) => r.outcome === "rejected").length,
    },
    byPolicy,
    byCorridor,
    note: "Illustrative aggregates over the preview transactions. The live summary comes from the API, with its own note.",
  };
}
