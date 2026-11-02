import type { Policy, StateMode } from "@prisma/client";
import type { RequestHandler } from "express";
import type { TransactionListQuery, TransactionListRow, TransactionRepository } from "../db/transactions.js";
import { ApiError } from "../middleware/errors.js";

// GET /api/v1/transactions (API contract §3.3): every user's transactions, to
// any authenticated user, newest first. Items copy stored fields only; nothing
// is computed. A failed transaction has no decision, so its decision fields
// are null.
//
// Query rules (§3.3 where documented, otherwise provisional team decisions):
// - page (default 1) and pageSize (default 20, 1-100): positive whole numbers.
// - corridor, policy, stateMode: the documented values (§1, §3.2).
// - completed: "true" or "false"; matches only transactions with a decision.
// - from (inclusive) and to (exclusive): full ISO 8601 UTC timestamps,
//   e.g. 2026-11-02T10:00:00Z or 2026-11-02T10:00:00.123Z; from must not be
//   later than to.
// - sort: only "createdAt:desc", the documented default.
// - A documented parameter given twice is rejected; unknown parameters are
//   ignored.
// Problems return 422 VALIDATION_ERROR with details.errors[] = [{field,
// message}] (provisional entry shape), all problems at once.

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
const CORRIDORS = ["USA->IND", "GBR->PHL", "ARE->MEX"] as const;
const POLICIES: readonly Policy[] = ["waterfall", "cheapestFeasible", "ppoProjected"];
const STATE_MODES: readonly StateMode[] = ["historicalReplay", "scenario", "explicit"];
const SORTS = ["createdAt:desc"] as const;
const KNOWN = ["page", "pageSize", "corridor", "policy", "stateMode", "completed", "from", "to", "sort"] as const;

export interface FieldError {
  field: string;
  message: string;
}

export type ParseResult = { ok: true; query: TransactionListQuery } | { ok: false; errors: FieldError[] };

export function parseTransactionListQuery(params: URLSearchParams): ParseResult {
  const errors: FieldError[] = [];
  const values = new Map<string, string>();
  for (const name of KNOWN) {
    const all = params.getAll(name);
    if (all.length > 1) errors.push({ field: name, message: "must be given at most once" });
    else if (all.length === 1) values.set(name, all[0]!);
  }

  const positive = (name: string, fallback: number, max?: number): number => {
    const raw = values.get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(value)) {
      errors.push({ field: name, message: "must be a positive whole number" });
    } else if (max !== undefined && value > max) {
      errors.push({ field: name, message: `must be at most ${max}` });
    }
    return value;
  };
  const oneOf = <T extends string>(name: string, allowed: readonly T[]): T | undefined => {
    const raw = values.get(name);
    if (raw === undefined) return undefined;
    if ((allowed as readonly string[]).includes(raw)) return raw as T;
    errors.push({ field: name, message: `must be one of: ${allowed.join(", ")}` });
    return undefined;
  };
  const timestamp = (name: string): Date | undefined => {
    const raw = values.get(name);
    if (raw === undefined) return undefined;
    const parsed = parseUtcTimestamp(raw);
    if (parsed === undefined) {
      errors.push({ field: name, message: "must be an ISO 8601 UTC timestamp, e.g. 2026-11-02T10:00:00Z" });
    }
    return parsed;
  };

  const page = positive("page", 1);
  const pageSize = positive("pageSize", DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const corridor = oneOf("corridor", CORRIDORS);
  const policy = oneOf("policy", POLICIES);
  const stateMode = oneOf("stateMode", STATE_MODES);
  const completedRaw = oneOf("completed", ["true", "false"]);
  const from = timestamp("from");
  const to = timestamp("to");
  oneOf("sort", SORTS);

  if (from !== undefined && to !== undefined && from.getTime() > to.getTime()) {
    errors.push({ field: "from", message: "must not be later than to" });
  }
  // Keeps the row offset exact; only reachable with an absurd page number.
  if (errors.length === 0 && !Number.isSafeInteger((page - 1) * pageSize)) {
    errors.push({ field: "page", message: "is too large" });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    query: {
      page,
      pageSize,
      filters: {
        ...(corridor !== undefined && { corridor }),
        ...(policy !== undefined && { policy }),
        ...(stateMode !== undefined && { stateMode }),
        ...(completedRaw !== undefined && { completed: completedRaw === "true" }),
        ...(from !== undefined && { from }),
        ...(to !== undefined && { to }),
      },
    },
  };
}

// YYYY-MM-DDTHH:MM:SS, optional .f to .fff, then Z. Offsets other than Z,
// date-only values and more than millisecond precision (createdAt's
// precision) are refused. Out-of-range parts such as Feb 30 or hour 24 are
// refused by checking that the parsed date reproduces every part.
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

export function parseUtcTimestamp(value: string): Date | undefined {
  const match = UTC_TIMESTAMP.exec(value);
  if (match === null) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const millis = Number((match[7] ?? "0").padEnd(3, "0"));
  // setUTCFullYear, not Date.UTC, which reads years 0-99 as 1900-1999.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millis);
  const roundTrips =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second;
  return roundTrips ? date : undefined;
}

/** A §3.3 history item, field for field from stored columns. */
export function toListItem(row: TransactionListRow): Record<string, unknown> {
  const decision = row.decision;
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdById,
    corridor: row.corridor,
    amountUsd: row.amountUsd,
    simulationDate: row.simulationDate.toISOString().slice(0, 10),
    stateMode: row.stateMode,
    policy: row.requestedPolicy,
    policyStatus: decision?.policyStatus ?? null,
    status: row.status,
    allowed: decision?.allowed ?? null,
    completed: decision?.completed ?? null,
    completionRatio: decision?.completionRatio ?? null,
    executedUsd: decision?.executedUsd ?? null,
    rewardAmountBased: decision?.rewardAmountBased ?? null,
  };
}

export function listTransactions(repository: TransactionRepository | undefined): RequestHandler {
  return async (req, res) => {
    // Parsed from the raw URL, so duplicates are seen whatever Express's query parser does.
    const parsed = parseTransactionListQuery(new URL(req.originalUrl, "http://localhost").searchParams);
    if (!parsed.ok) {
      throw new ApiError(422, "VALIDATION_ERROR", "The query parameters are invalid.", { errors: parsed.errors });
    }
    // No DATABASE_URL: an unexpected configuration for this endpoint. The error
    // handler logs it and returns 500 INTERNAL_ERROR (no database code exists in §4).
    if (repository === undefined) throw new Error("Transaction history needs DATABASE_URL, which is not set");
    const { page, pageSize } = parsed.query;
    // Database errors propagate to the error handler, which logs Prisma errors
    // without their message and returns 500 INTERNAL_ERROR.
    const { rows, total } = await repository.list(parsed.query);
    res.json({ items: rows.map(toListItem), page, pageSize, total });
  };
}
