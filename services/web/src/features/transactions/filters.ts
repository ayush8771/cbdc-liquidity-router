import type { PolicyKey, StateModeKey } from "./types";

/**
 * History filters. The URL keys are the query parameter names of
 * GET /api/v1/transactions in the rev 5 contract (§3.3), so the same URL
 * state can be passed to the API once it is integrated. Dates are YYYY-MM-DD
 * here; the API takes date-times, which Step 0 will convert.
 */
export type HistoryFilters = {
  corridor?: string;
  policy?: PolicyKey;
  stateMode?: StateModeKey;
  completed?: boolean;
  from?: string;
  to?: string;
};

export const CORRIDORS = ["USA->IND", "GBR->PHL", "ARE->MEX"] as const;
export const PAGE_SIZE = 20; // the contract's default page size

const POLICIES: PolicyKey[] = ["waterfall", "cheapestFeasible", "ppoProjected"];
const STATE_MODES: StateModeKey[] = ["historicalReplay", "scenario", "explicit"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Reads filters and page from the URL, ignoring values that aren't recognised. */
export function readHistoryParams(params: URLSearchParams): { filters: HistoryFilters; page: number } {
  const filters: HistoryFilters = {};
  const corridor = params.get("corridor");
  if (corridor && (CORRIDORS as readonly string[]).includes(corridor)) filters.corridor = corridor;
  const policy = params.get("policy");
  if (policy && (POLICIES as string[]).includes(policy)) filters.policy = policy as PolicyKey;
  const stateMode = params.get("stateMode");
  if (stateMode && (STATE_MODES as string[]).includes(stateMode)) filters.stateMode = stateMode as StateModeKey;
  const completed = params.get("completed");
  if (completed === "true" || completed === "false") filters.completed = completed === "true";
  const from = params.get("from");
  if (from && DATE.test(from)) filters.from = from;
  const to = params.get("to");
  if (to && DATE.test(to)) filters.to = to;

  const page = Number.parseInt(params.get("page") ?? "1", 10);
  return { filters, page: Number.isFinite(page) && page >= 1 ? page : 1 };
}

/** Writes filters and page back to URL parameters, dropping empty values and page 1. */
export function writeHistoryParams(filters: HistoryFilters, page: number): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.corridor) params.set("corridor", filters.corridor);
  if (filters.policy) params.set("policy", filters.policy);
  if (filters.stateMode) params.set("stateMode", filters.stateMode);
  if (filters.completed !== undefined) params.set("completed", String(filters.completed));
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (page > 1) params.set("page", String(page));
  return params;
}

export function hasActiveFilters(filters: HistoryFilters): boolean {
  return Object.values(filters).some((v) => v !== undefined);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Transaction IDs are UUIDs (contract §3.4). */
export function isTransactionId(value: string): boolean {
  return UUID.test(value.trim());
}
