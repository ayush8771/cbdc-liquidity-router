/*
 * UI display model for the desktop dashboard. Defined by the UI, like the other
 * feature models: components render these, and once the shared contracts are
 * merged a mapper converts GET /api/v1/dashboard/summary into them. The field
 * names follow the rev 5 contract's DashboardSummary so that mapper
 * stays a straight copy, but this is not the API type and must not become one.
 *
 * The narrow-screen dashboard keeps its own, older model in ./types.ts, which
 * this file does not replace.
 *
 * What the contract means by each count, because the page shows the difference:
 * - policy `count`: every transaction that requested the policy, failed and
 *   rejected ones included;
 * - `allowedRouted`: routed decisions the feasibility rules allowed. It is the
 *   denominator of `completionRate` and of every mean;
 * - corridor `routed`: routed decisions on that corridor. A failed transaction
 *   has no corridor, so it is not in any corridor row.
 * A mean is null when nothing qualified. Null is "not available", never zero.
 */
import type { PolicyKey } from "../transactions/types";

/** The date-time window the summary covers, UTC. Null on either side means unbounded. */
export type SummaryWindow = { from: string | null; to: string | null };

export type PolicySummary = {
  policy: PolicyKey;
  count: number;
  allowedRouted: number;
  /** A share in [0, 1], or null when `allowedRouted` is 0. */
  completionRate: number | null;
  /** Mean over the allowed routed decisions, under placeholder reward weights. */
  meanRewardAmountBased: number | null;
  /**
   * Already a percentage number: 1.56 means 1.56%. Unlike a venue's `feePct`,
   * which is a fraction, it is never multiplied by 100 for display.
   */
  meanFeeCostPct: number | null;
  /** Under placeholder weights. Its unit is not defined here, so it is shown as a plain number. */
  meanLatencyTerm: number | null;
  /** Under placeholder weights. Its unit is not defined here, so it is shown as a plain number. */
  meanRiskTerm: number | null;
};

export type CorridorSummary = {
  corridor: string;
  routed: number;
  allowedRouted: number;
  /** A share in [0, 1], or null when `allowedRouted` is 0. */
  completionRate: number | null;
};

export type DashboardSummaryView = {
  window: SummaryWindow;
  totals: {
    transactions: number;
    routed: number;
    failed: number;
    rejectedByFeasibility: number;
  };
  byPolicy: PolicySummary[];
  byCorridor: CorridorSummary[];
  note: string;
};
