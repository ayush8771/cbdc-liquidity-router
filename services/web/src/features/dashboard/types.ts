import type { PolicyKey } from "../transactions/types";

/** UI display model for the dashboard; see features/transactions/types.ts for the rule. */
export type DashboardView = {
  totals: {
    transactions: number;
    routed: number;
    failed: number;
    rejectedByFeasibility: number;
  };
  /** Completion rates are shares in [0, 1], or null when nothing qualified. */
  byCorridor: { corridor: string; count: number; completionRate: number | null }[];
  byPolicy: { policy: PolicyKey; count: number; completionRate: number | null }[];
};
