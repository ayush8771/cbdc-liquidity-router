/*
 * UI display model for the desktop History. Defined by the UI, like the other
 * feature models: components render these, and once the shared contracts are
 * merged a mapper converts GET /api/v1/transactions into them. The field names
 * follow the rev 5 contract's TransactionSummary, so that mapper
 * stays a straight copy, but this is not the API type and must not become one.
 *
 * It leaves out `createdBy` and `rewardAmountBased`: the desktop table doesn't
 * show them, and the preview data has no source for either.
 *
 * For a failed transaction every decision-derived field is null: `corridor`,
 * `policyStatus`, `allowed`, `completed`, `completionRatio` and `executedUsd`.
 * A null is "not available", never zero.
 */
import type { Outcome, PolicyKey, PolicyTier, StateModeKey } from "./types";

export type TransactionSummaryView = {
  id: string;
  /** ISO 8601 UTC. */
  createdAt: string;
  corridor: string | null;
  amountUsd: number;
  /** YYYY-MM-DD. */
  simulationDate: string;
  stateMode: StateModeKey;
  /** The requested policy; set even when the transaction failed. */
  policy: PolicyKey;
  policyStatus: PolicyTier | null;
  status: "routed" | "failed";
  /** Whether the feasibility rules allowed it. Null when there is no decision. */
  allowed: boolean | null;
  completed: boolean | null;
  /** A share in [0, 1], or null when there is no decision. */
  completionRatio: number | null;
  /** Null when there is no decision. Zero is a real value: a rejection executed nothing. */
  executedUsd: number | null;
};

/** What GET /api/v1/transactions returns: one page, and the total across all pages. */
export type TransactionPageView = {
  items: TransactionSummaryView[];
  page: number;
  pageSize: number;
  total: number;
};

/**
 * The outcome shown in the Status column, derived the way the history list
 * defines it: a failed call is Failed; a decision the rules did not allow is
 * Rejected; a fully executed one is Completed; any other allowed decision is
 * Partial. A routed transaction always has these values in the contract; only
 * a missing one falls through to Partial.
 */
export function outcomeOf(row: Pick<TransactionSummaryView, "status" | "allowed" | "completed">): Outcome {
  if (row.status === "failed") return "failed";
  if (row.allowed === false) return "rejected";
  return row.completed === true ? "completed" : "partial";
}
