import { formatDateTime } from "../../lib/format";
import { CORRIDORS } from "../transactions/filters";
import { POLICY_NAMES, type PolicyKey } from "../transactions/types";
import type { SummaryWindow } from "./summaryTypes";

/**
 * Dashboard filters. The URL keys are the query parameter names of
 * GET /api/v1/dashboard/summary in the rev 5 contract: `from`, `to`,
 * `corridor` and `policy`, all optional. Dates are YYYY-MM-DD here; the API
 * takes date-times, so they are converted to UTC midnight (see `toWindow`).
 */
export type DashboardFilters = {
  corridor?: string;
  policy?: PolicyKey;
  /** YYYY-MM-DD. Inclusive. */
  from?: string;
  /** YYYY-MM-DD. Exclusive: the transactions of this day are not counted. */
  to?: string;
};

/** A message per filter that can't be applied. Anything in here blocks the summary; nothing is dropped or corrected silently. */
export type FilterProblems = Partial<Record<keyof DashboardFilters, string>>;

export const RANGE_MESSAGE = "The start date must not be later than the end date.";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const POLICIES = Object.keys(POLICY_NAMES) as PolicyKey[];

/** YYYY-MM-DD, and a real calendar date. */
export function isIsoDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Reads the filters from the URL. A value that isn't recognised is not
 * applied and is reported as a problem, so the page can say so instead of
 * quietly showing a different summary.
 */
export function readDashboardParams(params: URLSearchParams): { filters: DashboardFilters; problems: FilterProblems } {
  const filters: DashboardFilters = {};
  const problems: FilterProblems = {};

  const corridor = params.get("corridor");
  if (corridor) {
    if ((CORRIDORS as readonly string[]).includes(corridor)) filters.corridor = corridor;
    else problems.corridor = "Choose one of the listed corridors.";
  }
  const policy = params.get("policy");
  if (policy) {
    if ((POLICIES as string[]).includes(policy)) filters.policy = policy as PolicyKey;
    else problems.policy = "Choose one of the listed policies.";
  }
  for (const key of ["from", "to"] as const) {
    const value = params.get(key);
    if (!value) continue;
    if (isIsoDate(value)) filters[key] = value;
    else problems[key] = "Use the format YYYY-MM-DD.";
  }

  const range = validateRange(filters);
  if (range) problems.to = range;
  return { filters, problems };
}

/** From later than to is an error. It is reported, never swapped or clamped. From equal to to is a valid, empty window. */
export function validateRange(filters: DashboardFilters): string | null {
  return filters.from && filters.to && filters.from > filters.to ? RANGE_MESSAGE : null;
}

/** Writes the filters back to URL parameters, dropping empty ones. */
export function writeDashboardParams(filters: DashboardFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.corridor) params.set("corridor", filters.corridor);
  if (filters.policy) params.set("policy", filters.policy);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  return params;
}

export function hasDashboardFilters(filters: DashboardFilters): boolean {
  return Object.values(filters).some((v) => v !== undefined);
}

/**
 * The date-time window for the API. Always UTC, whatever the browser's time
 * zone: a date becomes midnight UTC of that day. `from` is inclusive and `to`
 * is exclusive. A missing bound is null, which means unbounded.
 */
export function toWindow(filters: Pick<DashboardFilters, "from" | "to">): SummaryWindow {
  return {
    from: filters.from ? `${filters.from}T00:00:00.000Z` : null,
    to: filters.to ? `${filters.to}T00:00:00.000Z` : null,
  };
}

/** The window in words. "All time" when neither bound is set. */
export function describeWindow(window: SummaryWindow): string {
  if (window.from && window.to) return `${formatDateTime(window.from)} to ${formatDateTime(window.to)} (end not included)`;
  if (window.from) return `From ${formatDateTime(window.from)}`;
  if (window.to) return `Until ${formatDateTime(window.to)} (not included)`;
  return "All time";
}
