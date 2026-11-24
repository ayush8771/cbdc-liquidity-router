/*
 * GET /api/v1/transactions (contract §3.3) for the desktop History: the query
 * the URL holds becomes the request, and the response becomes the display
 * model the History components already render (historyTypes.ts). Nothing here
 * recomputes a value: a null from the API stays null ("not available").
 */
import { ApiError, INVALID_RESPONSE, type ApiClient } from "../../api/client";
import { isTransactionPage, type TransactionPage } from "../../api/types";
import { toHistoryWindow, type HistoryQuery } from "./historyQuery";
import type { TransactionPageView } from "./historyTypes";
import type { PolicyKey, PolicyTier, StateModeKey } from "./types";

/**
 * The request's query parameters, under the contract's names. `from` and `to`
 * are full ISO 8601 UTC timestamps at UTC midnight (`from` inclusive, `to`
 * exclusive, §3.3). `sort` is left out: `createdAt:desc` is the only value and
 * the default. `page` and `pageSize` are always sent.
 */
export function toApiQuery(query: HistoryQuery) {
  const window = toHistoryWindow(query);
  return {
    page: query.page,
    pageSize: query.pageSize,
    corridor: query.corridor,
    policy: query.policy,
    stateMode: query.stateMode,
    completed: query.completed,
    from: window.from ?? undefined,
    to: window.to ?? undefined,
  };
}

/**
 * API page to display model. The enum values (`policy`, `policyStatus`,
 * `stateMode`) are passed through as they came, so a value this version doesn't
 * know is shown as written rather than rejected (contract §1); the components
 * that print them fall back to the raw text. Any status other than `failed`
 * counts as routed.
 */
export function mapTransactionPage(page: TransactionPage): TransactionPageView {
  return {
    items: page.items.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      corridor: row.corridor,
      amountUsd: row.amountUsd,
      simulationDate: row.simulationDate,
      stateMode: row.stateMode as StateModeKey,
      policy: row.policy as PolicyKey,
      policyStatus: row.policyStatus as PolicyTier | null,
      status: row.status === "failed" ? "failed" : "routed",
      allowed: row.allowed,
      completed: row.completed,
      completionRatio: row.completionRatio,
      executedUsd: row.executedUsd,
    })),
    page: page.page,
    pageSize: page.pageSize,
    total: page.total,
  };
}

/** One request for one page. A body that isn't the documented shape is an INVALID_RESPONSE error. */
export async function fetchTransactionPage(api: ApiClient, query: HistoryQuery): Promise<TransactionPageView> {
  const raw = await api.get<unknown>("/transactions", { query: toApiQuery(query) });
  if (!isTransactionPage(raw)) {
    throw new ApiError({ status: 200, code: INVALID_RESPONSE, message: "The server's response could not be read." });
  }
  return mapTransactionPage(raw);
}

export type HistoryErrorView = {
  message: string;
  /** Field messages of a 422, as "field: message". */
  details: string[];
  /** The request ID, for the user to quote. */
  reference: string | undefined;
};

/**
 * What to tell the user. The wording is this UI's own, chosen by `code` and
 * `status` (never by the backend's `message`), except the field messages of a
 * 422, which name the parameters the server didn't accept.
 */
export function describeHistoryError(error: unknown): HistoryErrorView {
  if (!(error instanceof ApiError)) {
    return { message: "Something went wrong while loading the transactions.", details: [], reference: undefined };
  }
  const reference = error.requestId ?? undefined;
  if (error.code === "NETWORK_ERROR") {
    return { message: "The server could not be reached. Check your connection, then try again.", details: [], reference };
  }
  if (error.code === INVALID_RESPONSE) {
    return { message: "The server sent a response this page couldn't read.", details: [], reference };
  }
  if (error.status === 422) {
    const details = (error.details.errors ?? []).map((e) => (e.field ? `${e.field}: ${e.message}` : e.message));
    return { message: "The server didn't accept these filters.", details, reference };
  }
  if (error.status === 403) {
    return { message: "You don't have access to the transaction history.", details: [], reference };
  }
  if (error.status >= 500) {
    return { message: "The server hit an unexpected error. Try again in a moment.", details: [], reference };
  }
  return { message: `The request failed (${error.code}).`, details: [], reference };
}
