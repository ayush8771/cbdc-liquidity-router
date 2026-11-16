import type { Policy } from "@prisma/client";
import type { RequestHandler } from "express";
import type {
  DashboardAggregates,
  DashboardCorridorRow,
  DashboardFilters,
  DashboardPolicyRow,
  DashboardRepository,
} from "../db/dashboard.js";
import { ApiError } from "../middleware/errors.js";
import { VALIDATION_ERROR_MESSAGE } from "../validation/transactionRequest.js";
import { parseUtcTimestamp, type FieldError } from "./transactions.js";

// GET /api/v1/dashboard/summary (API contract §3.8): aggregates over every
// user's stored decisions, for any authenticated user, viewer or analyst
// (§3.1). It reads PostgreSQL only: no inference call, and nothing is written.
//
// Query (§3.8: from, to, corridor, policy), with the §3.3 rules that §1 points
// dashboard queries to:
// - from (inclusive) and to (exclusive): full ISO 8601 UTC timestamps on
//   createdAt; from must not be later than to. An omitted bound is unbounded
//   and echoed as null in window (owner decision A3); a given bound is echoed
//   exactly as sent.
// - corridor and policy: the documented values (§1).
// - A documented parameter given twice is rejected; unknown parameters are
//   ignored.
// - Problems return 422 VALIDATION_ERROR with details.errors[], all at once.
//
// Response (§3.8), computed from the repository's aggregates:
// - completionRate = completed allowed routed / allowed routed, null when
//   allowedRouted is 0 (byPolicy and byCorridor alike).
// - The means come from the database as they are: null when there is nothing
//   to average. Nothing is rounded.
// - Only groups with rows are listed: byPolicy in the §1 enum order, byCorridor
//   by corridor name.

const CORRIDORS = ["USA->IND", "GBR->PHL", "ARE->MEX"] as const;
const POLICIES: readonly Policy[] = ["waterfall", "cheapestFeasible", "ppoProjected"];
const KNOWN = ["from", "to", "corridor", "policy"] as const;

/** §3.8, verbatim. */
export const DASHBOARD_NOTE =
  "Aggregates of independent what-if decisions on synthetic states, under placeholder reward weights. " +
  "Transactions do not consume liquidity. Not a backtest.";

export interface DashboardQuery {
  filters: DashboardFilters;
  /** The from and to values as sent, or null when omitted. */
  window: { from: string | null; to: string | null };
}

export type DashboardParseResult = { ok: true; query: DashboardQuery } | { ok: false; errors: FieldError[] };

export function parseDashboardQuery(params: URLSearchParams): DashboardParseResult {
  const errors: FieldError[] = [];
  const values = new Map<string, string>();
  for (const name of KNOWN) {
    const all = params.getAll(name);
    if (all.length > 1) errors.push({ field: name, message: "Must be given at most once." });
    else if (all.length === 1) values.set(name, all[0]!);
  }

  const oneOf = <T extends string>(name: string, allowed: readonly T[]): T | undefined => {
    const raw = values.get(name);
    if (raw === undefined) return undefined;
    if ((allowed as readonly string[]).includes(raw)) return raw as T;
    errors.push({ field: name, message: `Must be one of: ${allowed.join(", ")}.` });
    return undefined;
  };
  const timestamp = (name: string): Date | undefined => {
    const raw = values.get(name);
    if (raw === undefined) return undefined;
    const parsed = parseUtcTimestamp(raw);
    if (parsed === undefined) {
      errors.push({ field: name, message: "Must be an ISO 8601 UTC timestamp, e.g. 2026-11-02T10:00:00Z." });
    }
    return parsed;
  };

  const from = timestamp("from");
  const to = timestamp("to");
  const corridor = oneOf("corridor", CORRIDORS);
  const policy = oneOf("policy", POLICIES);
  if (from !== undefined && to !== undefined && from.getTime() > to.getTime()) {
    errors.push({ field: "from", message: "Must not be later than to." });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    query: {
      filters: {
        ...(from !== undefined && { from }),
        ...(to !== undefined && { to }),
        ...(corridor !== undefined && { corridor }),
        ...(policy !== undefined && { policy }),
      },
      window: { from: values.get("from") ?? null, to: values.get("to") ?? null },
    },
  };
}

/** completed / allowedRouted, or null when allowedRouted is 0 (§3.8). */
export function completionRate(completedAllowedRouted: number, allowedRouted: number): number | null {
  return allowedRouted === 0 ? null : completedAllowedRouted / allowedRouted;
}

function policyItem(row: DashboardPolicyRow): Record<string, unknown> {
  return {
    policy: row.policy,
    count: row.count,
    allowedRouted: row.allowedRouted,
    completionRate: completionRate(row.completedAllowedRouted, row.allowedRouted),
    meanRewardAmountBased: row.meanRewardAmountBased,
    meanFeeCostPct: row.meanFeeCostPct,
    meanLatencyTerm: row.meanLatencyTerm,
    meanRiskTerm: row.meanRiskTerm,
  };
}

function corridorItem(row: DashboardCorridorRow): Record<string, unknown> {
  return {
    corridor: row.corridor,
    routed: row.routed,
    allowedRouted: row.allowedRouted,
    completionRate: completionRate(row.completedAllowedRouted, row.allowedRouted),
  };
}

/** The §3.8 body: exactly window, totals, byPolicy, byCorridor and note. */
export function toDashboardSummary(
  window: DashboardQuery["window"],
  aggregates: DashboardAggregates,
): Record<string, unknown> {
  const { totals } = aggregates;
  const byPolicy = [...aggregates.byPolicy].sort((a, b) => POLICIES.indexOf(a.policy) - POLICIES.indexOf(b.policy));
  const byCorridor = [...aggregates.byCorridor].sort((a, b) =>
    a.corridor < b.corridor ? -1 : a.corridor > b.corridor ? 1 : 0,
  );
  return {
    window: { from: window.from, to: window.to },
    totals: {
      transactions: totals.transactions,
      routed: totals.routed,
      failed: totals.failed,
      rejectedByFeasibility: totals.rejectedByFeasibility,
    },
    byPolicy: byPolicy.map(policyItem),
    byCorridor: byCorridor.map(corridorItem),
    note: DASHBOARD_NOTE,
  };
}

export function getDashboardSummary(repository: DashboardRepository | undefined): RequestHandler {
  return async (req, res) => {
    // Parsed from the raw URL, so duplicates are seen whatever Express's query parser does.
    const parsed = parseDashboardQuery(new URL(req.originalUrl, "http://localhost").searchParams);
    if (!parsed.ok) {
      throw new ApiError(422, "VALIDATION_ERROR", VALIDATION_ERROR_MESSAGE, { errors: parsed.errors });
    }
    // No DATABASE_URL: the error handler logs it and returns 500 INTERNAL_ERROR.
    if (repository === undefined) throw new Error("The dashboard needs DATABASE_URL, which is not set");
    // Database errors propagate to the error handler: 500 INTERNAL_ERROR.
    const aggregates = await repository.summary(parsed.query.filters);
    res.json(toDashboardSummary(parsed.query.window, aggregates));
  };
}
