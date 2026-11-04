import type { FailureCode, Policy, StateMode } from "@prisma/client";
import type { RequestHandler } from "express";
import { authenticatedUser } from "../auth/devAuth.js";
import { authorizePolicies } from "../auth/policies.js";
import { isFailureCode, type TransactionPersistence } from "../db/transactionPersistence.js";
import type {
  TransactionDetailRow,
  TransactionListQuery,
  TransactionListRow,
  TransactionRepository,
} from "../db/transactions.js";
import type { InferenceClient } from "../inferenceClient/client.js";
import {
  InferenceError,
  PASSTHROUGH_CODES,
  inferenceInvalid,
  inferenceUnavailable,
} from "../inferenceClient/errors.js";
import type { Logger } from "../logger.js";
import { toRouteRequest } from "../mappers/routeRequest.js";
import { InvalidRouteResponseError, mapRouteResponse, type MappedRouteResponse } from "../mappers/routeResponse.js";
import { ApiError } from "../middleware/errors.js";
import {
  INVALID_AMOUNT_MESSAGE,
  VALIDATION_ERROR_MESSAGE,
  validateTransactionRequest,
  type StateSpec,
  type TransactionRequest,
} from "../validation/transactionRequest.js";

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
    if (all.length > 1) errors.push({ field: name, message: "Must be given at most once." });
    else if (all.length === 1) values.set(name, all[0]!);
  }

  const positive = (name: string, fallback: number, max?: number): number => {
    const raw = values.get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(value)) {
      errors.push({ field: name, message: "Must be a positive whole number." });
    } else if (max !== undefined && value > max) {
      errors.push({ field: name, message: `Must be at most ${max}.` });
    }
    return value;
  };
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
    errors.push({ field: "from", message: "Must not be later than to." });
  }
  // Keeps the row offset exact; only reachable with an absurd page number.
  if (errors.length === 0 && !Number.isSafeInteger((page - 1) * pageSize)) {
    errors.push({ field: "page", message: "Is too large." });
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
      throw new ApiError(422, "VALIDATION_ERROR", VALIDATION_ERROR_MESSAGE, { errors: parsed.errors });
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

// POST /api/v1/transactions (API contract §3.2, §6). In order:
// 1. Auth (requireAuth) and the JSON body (jsonBody) run before this handler.
// 2. Role: a non-analyst asking for ppoProjected gets 403 FORBIDDEN_POLICY,
//    checked on the raw policy before validation. Nothing is saved.
// 3. Validation (Step 6E-1): 422 VALIDATION_ERROR with details.errors[] for
//    schema problems; then, for an otherwise valid body whose finite amountUsd
//    is zero or less, 422 INVALID_AMOUNT with details.field (§3.2 precedence).
//    Nothing is saved either way, and inference is not called.
// 4. The caller's seeded User row must exist; it is never created. Without it
//    (or without DATABASE_URL) the request fails with 500 INTERNAL_ERROR
//    before inference is called, so nothing is saved.
// 5. POST /v1/route, never retried, with the request ID forwarded.
// 6. HTTP 200: the response is validated and mapped (Step 6E-2), then the
//    transaction, decision, allocations and SUCCESS audit row are saved in one
//    database transaction, and 201 returns {id, createdAt, createdBy, status,
//    transaction, failure: null, decision} (transactionBody, shared with GET :id). A regulatory rejection (allowed false) is a 200
//    and is saved the same way.
// 7. Inference failures with a 5xx status (503 INFERENCE_UNAVAILABLE,
//    ENGINE_BUSY, 504 ENGINE_TIMEOUT, 502 INFERENCE_ERROR, including a 200
//    body the mapper rejects) save the transaction as failed, with a FAILED
//    audit row and no decision, in one database transaction. The mapped error
//    is returned with details.transactionId.
// 8. Engine 422 errors and 409 POLICY_DISABLED pass through; nothing is saved
//    or audited.
// A database error at any write returns 500 INTERNAL_ERROR, with nothing saved.
export function createTransaction(
  persistence: TransactionPersistence | undefined,
  client: InferenceClient | undefined,
  logger: Logger,
): RequestHandler {
  return async (req, res) => {
    const user = authenticatedUser(req);
    const body: unknown = req.body;
    const rawPolicy = isObject(body) ? body.policy : undefined;
    authorizePolicies(user, typeof rawPolicy === "string" ? [rawPolicy] : []);

    const validated = validateTransactionRequest(body);
    if (!validated.ok) {
      // Schema problems first, then INVALID_AMOUNT for an otherwise valid body
      // (§3.2 precedence). Neither echoes a caller-supplied value.
      if (validated.code === "INVALID_AMOUNT") {
        throw new ApiError(422, "INVALID_AMOUNT", INVALID_AMOUNT_MESSAGE, { field: validated.field });
      }
      throw new ApiError(422, "VALIDATION_ERROR", VALIDATION_ERROR_MESSAGE, { errors: validated.errors });
    }
    const request = validated.value;

    // Configuration faults: the error handler logs them and returns 500.
    if (persistence === undefined) throw new Error("Saving transactions needs DATABASE_URL, which is not set");
    if (!(await persistence.userExists(user.userId))) {
      throw new Error("The authenticated user has no User row; run the development-user seed");
    }
    const context = { userId: user.userId, requestId: req.requestId, request };

    let engineResponse: Record<string, unknown>;
    let mapped: MappedRouteResponse;
    try {
      if (client === undefined) throw inferenceUnavailable("not_configured");
      // POLICY_DISABLED passes through for this call only (Step 6E-3 decision).
      engineResponse = await client.post("/v1/route", toRouteRequest(request), {
        requestId: req.requestId,
        passThrough: ["POLICY_DISABLED"],
      });
      mapped = mapRouteResponse(engineResponse, request);
    } catch (error) {
      if (error instanceof InvalidRouteResponseError) {
        // Field paths only, never values.
        logger.warn("inference response rejected", {
          requestId: req.requestId,
          path: "/v1/route",
          problems: error.problems,
        });
      }
      if (!(error instanceof InferenceError) || error.status < 500) throw error;
      // The stored code is the code returned below (§3.2), so NOT_READY is
      // stored as INFERENCE_UNAVAILABLE. Every 5xx InferenceError has one of
      // the four codes; anything else is a backend fault (500, nothing saved).
      if (!isFailureCode(error.code)) throw new Error(`Inference failure with an unstorable code: ${error.code}`);
      const saved = await persistence.saveFailed({ ...context, failureCode: error.code });
      // Keeps the backend-written details (cause) and headers (Retry-After).
      throw new ApiError(
        error.status,
        error.code,
        error.message,
        { transactionId: saved.id, ...error.details },
        { ...error.headers },
      );
    }

    const saved = await persistence.saveRouted({
      ...context,
      corridor: mapped.columns.corridor,
      decision: mapped.columns.decision,
      allocations: mapped.columns.allocations,
      engineResponse,
    });
    res.status(201).json(
      transactionBody({
        id: saved.id,
        createdAt: saved.createdAt,
        createdBy: user.userId,
        status: "routed",
        transaction: mapped.transaction,
        failure: null,
        decision: mapped.decision,
      }),
    );
  };
}

// ---- The §3.2 transaction body, shared by POST 201 and GET :id (§3.4) ----

export interface TransactionFailure {
  code: FailureCode;
  message: string;
}

/**
 * failure.message for each stored code (§3.2): the backend's fixed text, never
 * engine text. The same text the POST returned for that code, except that
 * INFERENCE_UNAVAILABLE always uses the live-service wording (not mock mode's).
 */
export const FAILURE_MESSAGES: Readonly<Record<FailureCode, string>> = Object.freeze({
  INFERENCE_ERROR: inferenceInvalid("invalid_response").message,
  INFERENCE_UNAVAILABLE: inferenceUnavailable("unreachable").message,
  ENGINE_BUSY: PASSTHROUGH_CODES.ENGINE_BUSY!.message,
  ENGINE_TIMEOUT: PASSTHROUGH_CODES.ENGINE_TIMEOUT!.message,
});

/** The §3.2 body, in the documented key order. */
export function transactionBody(fields: {
  id: string;
  createdAt: Date;
  createdBy: string;
  status: "routed" | "failed";
  transaction: Record<string, unknown>;
  failure: TransactionFailure | null;
  decision: Record<string, unknown> | null;
}): Record<string, unknown> {
  return {
    id: fields.id,
    createdAt: fields.createdAt.toISOString(),
    createdBy: fields.createdBy,
    status: fields.status,
    transaction: fields.transaction,
    failure: fields.failure,
    decision: fields.decision,
  };
}

// GET /api/v1/transactions/:id (API contract §3.4). The same body as the 201.
// - Auth: any authenticated user may read any transaction (§3.1, as for history).
// - :id must be standard UUID syntax, any version and either case. Anything
//   else is 404 NOT_FOUND, exactly like an unknown UUID (team decision on
//   §10 Q11a), and is checked before the database is touched.
// - Routed: rebuilt from the stored engineResponse with mapRouteResponse,
//   against the request rebuilt from the stored columns, so the body is the
//   201's. A stored response that no longer maps is a backend fault: 500
//   INTERNAL_ERROR (not 502, since inference isn't called), logged with field
//   paths only.
// - Failed: from the stored columns; decision null, transaction.corridor null,
//   failure {code, message} from failureCode.
//   PENDING contract-owner clarification: a failed row saved before failureCode
//   existed has none. It returns failure: null, which the OpenAPI schema
//   allows but §3.4's prose ("failure set") doesn't. No code is invented.
// - Writes nothing: no audit row (§6.2: audit rows are for mutating calls).
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getTransaction(repository: TransactionRepository | undefined, logger: Logger): RequestHandler {
  return async (req, res) => {
    const id = req.params.id;
    if (typeof id !== "string" || !UUID.test(id)) throw unknownResource();
    if (repository === undefined) throw new Error("Transaction details need DATABASE_URL, which is not set");
    const row = await repository.findById(id);
    if (row === null) throw unknownResource();
    res.json(detailBody(row, req.requestId, logger));
  };
}

export function unknownResource(): ApiError {
  // The same envelope as the app's 404 for an unknown path.
  return new ApiError(404, "NOT_FOUND", "Unknown resource.");
}

export function detailBody(row: TransactionDetailRow, requestId: string, logger: Logger): Record<string, unknown> {
  const common = { id: row.id, createdAt: row.createdAt, createdBy: row.createdById };
  const request = storedRequest(row);

  if (row.status === "failed") {
    return transactionBody({
      ...common,
      status: "failed",
      transaction: {
        senderCountry: row.senderCountry,
        receiverCountry: row.receiverCountry,
        corridor: null,
        amountUsd: row.amountUsd,
        simulationDate: row.simulationDate.toISOString().slice(0, 10),
        clientReference: row.clientReference,
      },
      failure: row.failureCode === null ? null : { code: row.failureCode, message: FAILURE_MESSAGES[row.failureCode] },
      decision: null,
    });
  }

  // A routed row always has its decision (saved in the same database transaction).
  if (row.decision === null) throw new Error("A routed transaction has no RoutingDecision row");
  let mapped: MappedRouteResponse;
  try {
    mapped = mapRouteResponse(row.decision.engineResponse as Record<string, unknown>, request);
  } catch (error) {
    if (error instanceof InvalidRouteResponseError) {
      logger.error("stored route response no longer maps", { requestId, transactionId: row.id, problems: error.problems });
      // A plain Error, so the handler returns 500 INTERNAL_ERROR, not 502.
      throw new Error("A stored route response failed validation");
    }
    throw error;
  }
  return transactionBody({
    ...common,
    status: "routed",
    transaction: mapped.transaction,
    failure: null,
    decision: mapped.decision,
  });
}

/** The validated request as saved (transactionRequestData in transactionPersistence.ts). */
export function storedRequest(
  row: Pick<
    TransactionDetailRow,
    "senderCountry" | "receiverCountry" | "amountUsd" | "stateSpec" | "requestedPolicy" | "clientReference"
  >,
): TransactionRequest {
  return {
    senderCountry: row.senderCountry,
    receiverCountry: row.receiverCountry,
    amountUsd: row.amountUsd,
    state: row.stateSpec as unknown as StateSpec,
    policy: row.requestedPolicy,
    clientReference: row.clientReference,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
