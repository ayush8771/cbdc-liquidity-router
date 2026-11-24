import { CORRIDORS } from "./filters";
import { STATE_MODE_NAMES, POLICY_NAMES, type PolicyKey, type StateModeKey } from "./types";

/**
 * The desktop History's query. The URL keys are the query parameter names of
 * GET /api/v1/transactions in the rev 5 contract. Unlike the narrow
 * History's reader (./filters.ts, which this does not replace), this one
 * follows the contract's rules: `to` is exclusive, a documented parameter given
 * twice is an error, an invalid value is an error, and every problem is
 * reported together. Nothing invalid is dropped, corrected or guessed.
 */
export const PAGE_SIZES = [20, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100; // the contract's maximum

export type HistoryQuery = {
  corridor?: string;
  policy?: PolicyKey;
  stateMode?: StateModeKey;
  completed?: boolean;
  /** YYYY-MM-DD. Inclusive, at UTC midnight. */
  from?: string;
  /** YYYY-MM-DD. Exclusive, at UTC midnight: this day is not included. */
  to?: string;
  page: number;
  pageSize: number;
};

/** The URL parameters this screen owns. Everything else in the URL is left alone. */
export const MANAGED_KEYS = ["corridor", "policy", "stateMode", "completed", "from", "to", "pageSize", "page"] as const;
export type ManagedKey = (typeof MANAGED_KEYS)[number];

/** One message per parameter that can't be used. Anything in here means no list is shown. */
export type HistoryProblems = Partial<Record<ManagedKey, string>>;

export const RANGE_MESSAGE = "The start date must not be later than the end date.";
export const DUPLICATE_MESSAGE = "Given more than once. Use it once.";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WHOLE_NUMBER = /^[1-9]\d*$/;
const POLICIES = Object.keys(POLICY_NAMES) as PolicyKey[];
const STATE_MODES = Object.keys(STATE_MODE_NAMES) as StateModeKey[];

/** YYYY-MM-DD, and a real calendar date. */
export function isIsoDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Reads the query from the URL and checks every parameter, reporting all the
 * problems at once. An empty value counts as not given. `query` holds only the
 * values that were valid, so it is safe to use when `problems` is empty and
 * must not be used for a list when it isn't.
 */
export function readHistoryQuery(params: URLSearchParams): { query: HistoryQuery; problems: HistoryProblems } {
  const query: HistoryQuery = { page: 1, pageSize: DEFAULT_PAGE_SIZE };
  const problems: HistoryProblems = {};

  /** The single non-empty value of a parameter, or undefined. A repeated parameter is a problem. */
  const single = (key: ManagedKey): string | undefined => {
    const values = params.getAll(key).filter((v) => v !== "");
    if (values.length > 1) {
      problems[key] = DUPLICATE_MESSAGE;
      return undefined;
    }
    return values[0];
  };

  const corridor = single("corridor");
  if (corridor !== undefined) {
    if ((CORRIDORS as readonly string[]).includes(corridor)) query.corridor = corridor;
    else problems.corridor = "Choose one of the listed corridors.";
  }

  const policy = single("policy");
  if (policy !== undefined) {
    if ((POLICIES as string[]).includes(policy)) query.policy = policy as PolicyKey;
    else problems.policy = "Choose one of the listed policies.";
  }

  const stateMode = single("stateMode");
  if (stateMode !== undefined) {
    if ((STATE_MODES as string[]).includes(stateMode)) query.stateMode = stateMode as StateModeKey;
    else problems.stateMode = "Choose one of the listed state modes.";
  }

  const completed = single("completed");
  if (completed !== undefined) {
    if (completed === "true" || completed === "false") query.completed = completed === "true";
    else problems.completed = "Choose Completed or Not completed.";
  }

  for (const key of ["from", "to"] as const) {
    const value = single(key);
    if (value === undefined) continue;
    if (isIsoDate(value)) query[key] = value;
    else problems[key] = "Use the format YYYY-MM-DD.";
  }
  // The range is only checked when both dates are usable. It is reported, never swapped or clamped.
  if (query.from && query.to && query.from > query.to) problems.to = RANGE_MESSAGE;

  const pageSize = single("pageSize");
  if (pageSize !== undefined) {
    const n = Number(pageSize);
    if (WHOLE_NUMBER.test(pageSize) && n <= MAX_PAGE_SIZE) query.pageSize = n;
    else problems.pageSize = `Use a whole number from 1 to ${MAX_PAGE_SIZE}.`;
  }

  const page = single("page");
  if (page !== undefined) {
    if (WHOLE_NUMBER.test(page) && Number.isSafeInteger(Number(page))) query.page = Number(page);
    else problems.page = "Use a whole number from 1.";
  }

  return { query, problems };
}

/** Every problem together, as "name: message", in the order of the parameters. */
export function listProblems(problems: HistoryProblems): string[] {
  return MANAGED_KEYS.flatMap((key) => (problems[key] ? [`${key}: ${problems[key]}`] : []));
}

/** The date window for the API: UTC midnight, `from` inclusive and `to` exclusive. A missing bound is null (unbounded). */
export function toHistoryWindow(query: Pick<HistoryQuery, "from" | "to">): { from: string | null; to: string | null } {
  return {
    from: query.from ? `${query.from}T00:00:00.000Z` : null,
    to: query.to ? `${query.to}T00:00:00.000Z` : null,
  };
}

type Patch = Partial<Record<ManagedKey, string | undefined>>;

/**
 * The URL parameters after the user changes something. Only the parameters in
 * `patch` are touched: a value of undefined (or "") removes it, and setting a
 * parameter replaces every copy of it. Parameters the user didn't touch,
 * including invalid ones and unrelated ones such as `state`, stay exactly as
 * they were, so an error never disappears on its own.
 *
 * Changing a filter or the page size resets the page to 1; only a change to
 * `page` itself keeps it.
 */
export function updateHistoryParams(current: URLSearchParams, patch: Patch): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(patch) as [ManagedKey, string | undefined][]) {
    next.delete(key);
    if (value !== undefined && value !== "") next.set(key, value);
  }
  if (!("page" in patch)) next.delete("page");
  // The defaults are not written, so a clean URL stays clean.
  if (next.get("page") === "1") next.delete("page");
  if (next.get("pageSize") === String(DEFAULT_PAGE_SIZE)) next.delete("pageSize");
  return next;
}

/** "Clear filters": removes the six filters and the page, and keeps the page size and everything unrelated. */
export function clearHistoryFilters(current: URLSearchParams): URLSearchParams {
  return updateHistoryParams(current, {
    corridor: undefined,
    policy: undefined,
    stateMode: undefined,
    completed: undefined,
    from: undefined,
    to: undefined,
  });
}

/** Whether any of the six filters is in the URL, valid or not. */
export function hasHistoryFilters(params: URLSearchParams): boolean {
  return (["corridor", "policy", "stateMode", "completed", "from", "to"] as const).some((key) =>
    params.getAll(key).some((v) => v !== ""),
  );
}

/** The last page that exists for a total. There is always at least page 1. */
export function lastPageOf(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}
