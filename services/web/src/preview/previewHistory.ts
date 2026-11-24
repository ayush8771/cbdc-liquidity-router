/*
 * PREVIEW DATA — a stand-in for GET /api/v1/transactions, over the 57 preview
 * transactions. Illustrative, not from the API, and not used once integration
 * starts: delete this file with ./previewData.ts and ./previewDetail.ts.
 *
 * It follows the rev 5 contract's query rules:
 * - `from` is inclusive and `to` is exclusive, on `createdAt`;
 * - `completed=true|false` matches only transactions with a decision, so never
 *   a failed one; `corridor` never matches a failed one either, because a
 *   failed transaction has no corridor; `policy` matches the requested policy,
 *   so failed ones are included;
 * - newest first (the only sort the contract has).
 *
 * The executed amount and the completion ratio come from the same
 * transaction's detail preview, joined by ID. A transaction with no detail
 * gets nulls, which are shown as "—"; nothing is made up.
 *
 * The contract doesn't say what the API returns for a page past the last one.
 * This adapter returns an empty page, which is what the plain reading of
 * "page N of the results" gives; the screen decides what to show.
 */
import type { TransactionPageView, TransactionSummaryView } from "../features/transactions/historyTypes";
import type { PolicyKey, StateModeKey, TransactionRow } from "../features/transactions/types";
import { getPreviewTransactionDetail } from "./previewDetail";
import { PREVIEW_TRANSACTIONS } from "./previewData";

export type PreviewHistoryQuery = {
  corridor?: string;
  policy?: PolicyKey;
  stateMode?: StateModeKey;
  completed?: boolean;
  /** UTC date-times. Null means unbounded. */
  window: { from: string | null; to: string | null };
  page: number;
  pageSize: number;
};

/**
 * The summary of one preview transaction. What the row already says (status,
 * allowed, completed) comes from the row; the executed amount and the
 * completion ratio come from the same transaction's detail, joined by ID, and
 * are null when there is no decision to read them from.
 */
export function toSummary(row: TransactionRow): TransactionSummaryView {
  const failed = row.outcome === "failed";
  const decision = failed ? null : (getPreviewTransactionDetail(row.id)?.decision ?? null);
  return {
    id: row.id,
    createdAt: row.createdAt,
    corridor: row.corridor,
    amountUsd: row.amountUsd,
    simulationDate: row.simulationDate,
    stateMode: row.stateMode,
    policy: row.policy,
    policyStatus: row.policyTier,
    status: failed ? "failed" : "routed",
    allowed: failed ? null : row.outcome !== "rejected",
    completed: failed ? null : row.outcome === "completed",
    completionRatio: decision ? decision.totals.completionRatio : null,
    executedUsd: decision ? decision.totals.executedUsd : null,
  };
}

/** One page of the preview transactions that match the query. */
export function queryPreviewHistory(query: PreviewHistoryQuery): TransactionPageView {
  const from = query.window.from === null ? Number.NEGATIVE_INFINITY : Date.parse(query.window.from);
  const to = query.window.to === null ? Number.POSITIVE_INFINITY : Date.parse(query.window.to);

  const matches = PREVIEW_TRANSACTIONS.filter((row) => {
    const at = Date.parse(row.createdAt);
    if (at < from || at >= to) return false; // from inclusive, to exclusive
    if (query.corridor && row.corridor !== query.corridor) return false;
    if (query.policy && row.policy !== query.policy) return false;
    if (query.stateMode && row.stateMode !== query.stateMode) return false;
    // `completed` only ever matches a transaction that has a decision.
    if (query.completed === true && row.outcome !== "completed") return false;
    if (query.completed === false && !(row.outcome === "partial" || row.outcome === "rejected")) return false;
    return true;
  });

  const start = (query.page - 1) * query.pageSize;
  return {
    items: matches.slice(start, start + query.pageSize).map(toSummary),
    page: query.page,
    pageSize: query.pageSize,
    total: matches.length,
  };
}
