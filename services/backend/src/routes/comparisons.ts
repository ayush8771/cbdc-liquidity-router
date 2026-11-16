import type { RequestHandler } from "express";
import { authenticatedUser } from "../auth/devAuth.js";
import { authorizePolicies, canUseExperimentalPolicies, EXPERIMENTAL_POLICIES } from "../auth/policies.js";
import type { Role } from "../config/devTokens.js";
import type { ComparisonRow, ComparisonStore } from "../db/comparisons.js";
import type { InferenceClient } from "../inferenceClient/client.js";
import { inferenceUnavailable } from "../inferenceClient/errors.js";
import type { Logger } from "../logger.js";
import {
  InvalidCompareResponseError,
  mapCompareResponse,
  toCompareRequest,
  type MappedComparison,
} from "../mappers/compareResponse.js";
import { ApiError } from "../middleware/errors.js";
import {
  DEFAULT_COMPARISON_POLICIES,
  validateComparisonRequest,
  type ComparisonRequest,
} from "../validation/comparisonRequest.js";
import {
  INVALID_AMOUNT_MESSAGE,
  VALIDATION_ERROR_MESSAGE,
  type Policy,
  type StateSpec,
} from "../validation/transactionRequest.js";
import { unknownResource, UUID } from "./transactions.js";

// POST /api/v1/comparisons (API contract §3.6, §6; owner decisions Q18).
// In order:
// 1. Auth (requireAuth) and the JSON body (jsonBody) run before this handler.
//    Any role may compare.
// 2. Role: a non-analyst listing ppoProjected gets 403 FORBIDDEN_POLICY,
//    checked on the raw list before validation and before anything that
//    depends on server state. No alias names ppoProjected. Nothing is saved.
// 3. Validation (validateComparisonRequest): 422 VALIDATION_ERROR, then 422
//    INVALID_AMOUNT, as for POST /transactions. Aliases become canonical
//    names in place. Nothing is saved.
// 4. Policies: the caller's list, canonical, in the caller's order. When
//    omitted, the default list in its fixed order (DEFAULT_COMPARISON_POLICIES),
//    without the experimental policies for a non-analyst (§3.6).
// 5. The caller's seeded User row must exist; otherwise 500 before inference.
// 6. POST /v1/compare with exactly that list, never retried, with the request
//    ID forwarded. The engine owns checkpoint approval and policy enablement
//    (§7): a disabled or unavailable policy comes back in `skipped`, and the
//    comparison is still saved (§3.6). The backend makes no /v1/version call
//    and no checkpoint check of its own for comparisons. An engine 409
//    POLICY_DISABLED is not passed through here; it would break §2.9 and maps
//    to 502.
// 7. The 200 body is validated and mapped (compareResponse.ts), including
//    the effective state confirmed by every result's provenance.
// 8. The Comparison and its SUCCESS audit row are saved in one database
//    transaction, and 201 returns the record (comparisonBody).
// No raw PPO: only canonical policies are ever sent (ppoProjected is the
// engine's ppo_projected, served only with capacity projection), a result
// for any policy that was not sent is refused, and a skipped policy is never
// substituted or retried.
// Any error saves and audits nothing, and carries no transactionId (§3.6).
// Inference failures map as in §3.2. A database error returns 500.
export function createComparison(
  store: ComparisonStore | undefined,
  client: InferenceClient | undefined,
  logger: Logger,
): RequestHandler {
  return async (req, res) => {
    const user = authenticatedUser(req);
    const body: unknown = req.body;
    const rawPolicies: unknown = typeof body === "object" && body !== null ? (body as Record<string, unknown>).policies : undefined;
    authorizePolicies(
      user,
      Array.isArray(rawPolicies) ? rawPolicies.filter((p): p is string => typeof p === "string") : [],
    );

    const validated = validateComparisonRequest(body);
    if (!validated.ok) {
      if (validated.code === "INVALID_AMOUNT") {
        throw new ApiError(422, "INVALID_AMOUNT", INVALID_AMOUNT_MESSAGE, { field: validated.field });
      }
      throw new ApiError(422, "VALIDATION_ERROR", VALIDATION_ERROR_MESSAGE, { errors: validated.errors });
    }
    const request: ComparisonRequest = {
      ...validated.value,
      policies: resolveComparisonPolicies(validated.value.policies, user.role),
    };

    // Configuration faults: the error handler logs them and returns 500.
    if (store === undefined) throw new Error("Saving comparisons needs DATABASE_URL, which is not set");
    if (!(await store.userExists(user.userId))) {
      throw new Error("The authenticated user has no User row; run the development-user seed");
    }
    if (client === undefined) throw inferenceUnavailable("not_configured");

    const engineResponse = await client.post("/v1/compare", toCompareRequest(request), { requestId: req.requestId });
    let mapped: MappedComparison;
    try {
      mapped = mapCompareResponse(engineResponse, request);
    } catch (error) {
      if (error instanceof InvalidCompareResponseError) {
        // Field paths only, never values.
        logger.warn("inference response rejected", { requestId: req.requestId, path: "/v1/compare", problems: error.problems });
      }
      throw error;
    }

    const saved = await store.save({
      userId: user.userId,
      requestId: req.requestId,
      request,
      corridor: mapped.corridor,
      engineResponse,
    });
    res.status(201).json(comparisonBody({ id: saved.id, createdAt: saved.createdAt, createdBy: user.userId, request, mapped }));
  };
}

/**
 * The policy list of a comparison (approved Q18 decisions): the caller's own
 * list unchanged, or the default list in its fixed order. A role that may not
 * use the experimental policies gets the default without them (§3.6).
 */
export function resolveComparisonPolicies(requested: readonly Policy[] | undefined, role: Role): Policy[] {
  if (requested !== undefined) return [...requested];
  return DEFAULT_COMPARISON_POLICIES.filter(
    (policy) => canUseExperimentalPolicies(role) || !EXPERIMENTAL_POLICIES.includes(policy),
  );
}

/**
 * The comparison record, returned by POST (201) and GET :id (200): the §3.6
 * fields plus `state` and `policies` (owner decision Q18), so the record says
 * what was compared and on which state.
 * - transaction: the request's fields, and the corridor the results confirmed
 *   (null when every policy was skipped; never derived).
 * - state: the effective state (MappedComparison.state), as stored.
 * - policies: the resolved canonical list, in the order `results` and
 *   `skipped` follow. Aliases are never returned.
 */
export function comparisonBody(fields: {
  id: string;
  createdAt: Date;
  createdBy: string;
  request: ComparisonRequest;
  mapped: MappedComparison;
}): Record<string, unknown> {
  const { request, mapped } = fields;
  const state = mapped.state;
  return {
    id: fields.id,
    createdAt: fields.createdAt.toISOString(),
    createdBy: fields.createdBy,
    transaction: {
      senderCountry: request.senderCountry,
      receiverCountry: request.receiverCountry,
      amountUsd: request.amountUsd,
      corridor: mapped.corridor,
      simulationDate: state.mode === "explicit" ? state.referenceDate : state.date,
      clientReference: request.clientReference,
    },
    state,
    policies: [...request.policies],
    results: mapped.results.map((result) => result.decision),
    skipped: mapped.skipped,
    sameState: true,
    note: mapped.note,
  };
}

// GET /api/v1/comparisons/:id (API contract §3.1, §3.6). The same body as the
// POST's 201.
// - Auth: any authenticated user may read any comparison (§3.1), whatever its
//   policies: a viewer reads one that compared ppoProjected too
//   (FORBIDDEN_POLICY is about requesting a policy; nothing is requested here).
// - :id must be UUID syntax, any version and either case. Anything else is
//   404 NOT_FOUND, exactly like an unknown UUID (the Q11a team decision used
//   for GET /transactions/:id), checked before the database is touched.
// - Rebuilt from the stored row alone: its columns, stateSpec, policies and
//   the verbatim engineResponse, mapped and confirmed as the POST did it.
//   Inference is not called, so a stored record stays readable after its
//   checkpoint is disabled or replaced.
// - A stored response that no longer maps is a backend fault: 500
//   INTERNAL_ERROR (not 502), logged with field paths only.
// - Writes nothing, so no audit row (§6.2).
export function getComparison(store: ComparisonStore | undefined, logger: Logger): RequestHandler {
  return async (req, res) => {
    const id = req.params.id;
    if (typeof id !== "string" || !UUID.test(id)) throw unknownResource();
    if (store === undefined) throw new Error("Comparisons need DATABASE_URL, which is not set");
    const row = await store.findById(id);
    if (row === null) throw unknownResource();

    const request = storedComparisonRequest(row);
    let mapped: MappedComparison;
    try {
      mapped = mapCompareResponse(row.engineResponse, request);
    } catch (error) {
      if (error instanceof InvalidCompareResponseError) {
        logger.error("stored compare response no longer maps", {
          requestId: req.requestId,
          comparisonId: row.id,
          problems: error.problems,
        });
        // A plain Error, so the handler returns 500 INTERNAL_ERROR, not 502.
        throw new Error("A stored compare response failed validation");
      }
      throw error;
    }
    res.json(comparisonBody({ id: row.id, createdAt: row.createdAt, createdBy: row.createdById, request, mapped }));
  };
}

/** The resolved request as saved (comparisonData in db/comparisons.ts). */
export function storedComparisonRequest(row: ComparisonRow): ComparisonRequest {
  return {
    senderCountry: row.senderCountry,
    receiverCountry: row.receiverCountry,
    amountUsd: row.amountUsd,
    state: row.stateSpec as unknown as StateSpec,
    policies: [...row.policies],
    clientReference: row.clientReference,
  };
}
