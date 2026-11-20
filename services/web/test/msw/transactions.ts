/*
 * MSW handler for GET /api/v1/transactions, following contract §3.3 and the
 * backend's query rules (services/backend/src/routes/transactions.ts):
 * - a documented parameter given twice, or a value that isn't allowed, is
 *   422 VALIDATION_ERROR with every problem in details.errors[];
 * - `from` is inclusive and `to` exclusive, on createdAt, as full UTC timestamps;
 * - `completed` and `corridor` never match a failed row (its values are null);
 *   `policy` matches the requested policy, so failed rows are included;
 * - newest first; a page past the last one is an empty page (the contract does
 *   not say; this is the plain reading, as in the preview adapter).
 * The rows come from the contract fixture 200_list.json.
 */
import { http, HttpResponse } from "msw";
import { contractFixture } from "./fixtures";

export type ListRow = Record<string, unknown> & { id: string; createdAt: string };

/** The seven rows of contracts/fixtures/app/transactions/200_list.json. */
export function fixtureRows(): ListRow[] {
  const body = contractFixture("transactions/200_list.json").response.body as { items: ListRow[] };
  return body.items;
}

/** `count` rows, newest first: the fixture's rows repeated with new IDs and an earlier createdAt each. */
export function makeRows(count: number): ListRow[] {
  const base = fixtureRows();
  return Array.from({ length: count }, (_, i) => {
    const row = base[i % base.length]!;
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const createdAt = new Date(Date.UTC(2026, 10, 2, 10, 0, 0) - i * 60_000).toISOString().replace(".000Z", "Z");
    return { ...row, id, createdAt };
  });
}

const CORRIDORS = ["USA->IND", "GBR->PHL", "ARE->MEX"];
const POLICIES = ["waterfall", "cheapestFeasible", "ppoProjected"];
const STATE_MODES = ["historicalReplay", "scenario", "explicit"];
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const WHOLE = /^[1-9]\d*$/;
const KNOWN = ["page", "pageSize", "corridor", "policy", "stateMode", "completed", "from", "to", "sort"];
const VALID_TOKENS = ["mock-analyst", "mock-viewer"];

type Problem = { field: string; message: string };

function envelope(code: string, message: string, details: unknown = {}) {
  return { error: { code, message, details, requestId: "msw-request-1" } };
}

export type TransactionsHandlerOptions = {
  /** Called with the request URL of every request that reaches the handler. */
  onRequest?: (url: URL, authorization: string | null) => void;
};

export function transactionsHandler(rows: ListRow[] = fixtureRows(), options: TransactionsHandlerOptions = {}) {
  return http.get("*/api/v1/transactions", ({ request }) => {
    const url = new URL(request.url);
    const authorization = request.headers.get("Authorization");
    options.onRequest?.(url, authorization);

    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    if (token === null || !VALID_TOKENS.includes(token)) {
      return HttpResponse.json(envelope("UNAUTHENTICATED", "Missing or invalid token."), { status: 401 });
    }

    const problems: Problem[] = [];
    const value = new Map<string, string>();
    for (const name of KNOWN) {
      const all = url.searchParams.getAll(name);
      if (all.length > 1) problems.push({ field: name, message: "must be given at most once" });
      else if (all.length === 1) value.set(name, all[0]!);
    }
    const whole = (name: string, fallback: number, max?: number) => {
      const raw = value.get(name);
      if (raw === undefined) return fallback;
      if (!WHOLE.test(raw)) problems.push({ field: name, message: "must be a positive whole number" });
      else if (max !== undefined && Number(raw) > max) problems.push({ field: name, message: `must be at most ${max}` });
      return Number(raw);
    };
    const oneOf = (name: string, allowed: string[]) => {
      const raw = value.get(name);
      if (raw !== undefined && !allowed.includes(raw)) problems.push({ field: name, message: "is not an allowed value" });
      return raw;
    };
    const timestamp = (name: string) => {
      const raw = value.get(name);
      if (raw === undefined) return undefined;
      if (!TIMESTAMP.test(raw) || Number.isNaN(Date.parse(raw))) {
        problems.push({ field: name, message: "must be a full ISO 8601 UTC timestamp" });
        return undefined;
      }
      return Date.parse(raw);
    };

    const page = whole("page", 1);
    const pageSize = whole("pageSize", 20, 100);
    const corridor = oneOf("corridor", CORRIDORS);
    const policy = oneOf("policy", POLICIES);
    const stateMode = oneOf("stateMode", STATE_MODES);
    const completed = oneOf("completed", ["true", "false"]);
    oneOf("sort", ["createdAt:desc"]);
    const from = timestamp("from");
    const to = timestamp("to");
    if (from !== undefined && to !== undefined && from > to) {
      problems.push({ field: "from", message: "must not be later than to" });
    }
    if (problems.length > 0) {
      return HttpResponse.json(envelope("VALIDATION_ERROR", "Request failed validation.", { errors: problems }), {
        status: 422,
      });
    }

    const matches = rows.filter((row) => {
      const at = Date.parse(row.createdAt);
      if (from !== undefined && at < from) return false; // from inclusive
      if (to !== undefined && at >= to) return false; // to exclusive
      if (corridor !== undefined && row.corridor !== corridor) return false;
      if (policy !== undefined && row.policy !== policy) return false;
      if (stateMode !== undefined && row.stateMode !== stateMode) return false;
      if (completed !== undefined && row.completed !== (completed === "true")) return false;
      return true;
    });
    const start = (page - 1) * pageSize;
    return HttpResponse.json({ items: matches.slice(start, start + pageSize), page, pageSize, total: matches.length });
  });
}
