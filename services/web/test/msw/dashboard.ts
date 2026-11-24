/*
 * MSW handler for GET /api/v1/dashboard/summary (contract §3.8), serving the
 * aggregates of contracts/fixtures/app/dashboard/200_summary.json. As the
 * backend does (services/backend/src/routes/dashboard.ts):
 * - the token is checked first;
 * - `from` and `to` are full ISO 8601 UTC timestamps (milliseconds optional,
 *   `from` not later than `to`), `corridor` and `policy` take the documented
 *   values, a documented parameter given twice is rejected, unknown parameters
 *   are ignored, and every problem comes back together as a 422 with
 *   details.errors[];
 * - `window` echoes the bounds exactly as sent, and is null for an omitted one.
 * The aggregates are the fixture's whatever the filters say: this handler tests
 * what the page sends and shows, not the backend's arithmetic.
 */
import { http, HttpResponse } from "msw";
import { contractFixture } from "./fixtures";

const VALID_TOKENS = ["mock-analyst", "mock-viewer"];
const CORRIDORS = ["USA->IND", "GBR->PHL", "ARE->MEX"];
const POLICIES = ["waterfall", "cheapestFeasible", "ppoProjected"];
const KNOWN = ["from", "to", "corridor", "policy"];
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export type SummaryBody = {
  window: { from: string | null; to: string | null };
  totals: { transactions: number; routed: number; failed: number; rejectedByFeasibility: number };
  byPolicy: Record<string, unknown>[];
  byCorridor: Record<string, unknown>[];
  note: string;
};

/** The body of the contract's dashboard fixture (a fresh copy each call, so a test can change it). */
export function fixtureSummary(): SummaryBody {
  return structuredClone(contractFixture("dashboard/200_summary.json").response.body) as SummaryBody;
}

export type DashboardHandlerOptions = {
  /** Called with the request URL of every request that reaches the handler. */
  onRequest?: (url: URL, authorization: string | null) => void;
};

export function dashboardHandler(base: SummaryBody = fixtureSummary(), options: DashboardHandlerOptions = {}) {
  return http.get("*/api/v1/dashboard/summary", ({ request }) => {
    const url = new URL(request.url);
    const authorization = request.headers.get("Authorization");
    options.onRequest?.(url, authorization);

    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    if (token === null || !VALID_TOKENS.includes(token)) {
      return HttpResponse.json(
        { error: { code: "UNAUTHENTICATED", message: "Missing or invalid token.", details: {}, requestId: "msw-request-1" } },
        { status: 401 },
      );
    }

    const problems: { field: string; message: string }[] = [];
    const value = new Map<string, string>();
    for (const name of KNOWN) {
      const all = url.searchParams.getAll(name);
      if (all.length > 1) problems.push({ field: name, message: "Must be given at most once." });
      else if (all.length === 1) value.set(name, all[0]!);
    }
    for (const [name, allowed] of [
      ["corridor", CORRIDORS],
      ["policy", POLICIES],
    ] as const) {
      const raw = value.get(name);
      if (raw !== undefined && !allowed.includes(raw)) problems.push({ field: name, message: `Must be one of: ${allowed.join(", ")}.` });
    }
    const times: Record<string, number> = {};
    for (const name of ["from", "to"]) {
      const raw = value.get(name);
      if (raw === undefined) continue;
      if (!TIMESTAMP.test(raw) || Number.isNaN(Date.parse(raw))) {
        problems.push({ field: name, message: "Must be an ISO 8601 UTC timestamp, e.g. 2026-11-02T10:00:00Z." });
      } else {
        times[name] = Date.parse(raw);
      }
    }
    if (times.from !== undefined && times.to !== undefined && times.from > times.to) {
      problems.push({ field: "from", message: "Must not be later than to." });
    }
    if (problems.length > 0) {
      return HttpResponse.json(
        { error: { code: "VALIDATION_ERROR", message: "Request failed validation.", details: { errors: problems }, requestId: "msw-request-1" } },
        { status: 422 },
      );
    }

    return HttpResponse.json({ ...base, window: { from: value.get("from") ?? null, to: value.get("to") ?? null } });
  });
}
