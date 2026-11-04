import type { Prisma } from "@prisma/client";
import type { RequestHandler } from "express";
import { authenticatedUser } from "../auth/devAuth.js";
import type { ExplanationStore, ExplanationTarget } from "../db/explanations.js";
import type { InferenceClient, JsonObject } from "../inferenceClient/client.js";
import { inferenceInvalid, inferenceUnavailable, OPT_IN_PASSTHROUGH_CODES } from "../inferenceClient/errors.js";
import type { Logger } from "../logger.js";
import { InvalidExplainResponseError, mapExplainResponse } from "../mappers/explainResponse.js";
import { toRouteRequest } from "../mappers/routeRequest.js";
import { ApiError } from "../middleware/errors.js";
import { storedRequest, unknownResource, UUID } from "./transactions.js";

// GET /api/v1/transactions/:id/explanation (API contract §3.5). In order:
// 1. Auth (requireAuth) runs first. Any authenticated user may read any
//    transaction's explanation (§3.1), whatever its policy: a viewer reads a
//    stored ppoProjected decision too (FORBIDDEN_POLICY is about requesting a
//    policy, and nothing is requested here).
// 2. :id must be UUID syntax; anything else is 404 NOT_FOUND, like an unknown
//    UUID, checked before the database is touched (as GET :id, Q11a).
// 3. Failed transaction: 409 TRANSACTION_FAILED; inference isn't called and
//    nothing is stored.
// 4. A stored explanation is returned (200); nothing is recomputed (Q17 rule 1).
// 5. ppoProjected only (Q17 rules 2-3), from GET /v1/version before /v1/explain:
//    checkpoint null -> 409 POLICY_DISABLED; checkpoint.sha256 differing from
//    the decision's stored checkpointSha256 -> 409 DECISION_MISMATCH. So a
//    decision is never recomputed with another checkpoint. /v1/version is not
//    cached in the backend yet (§5 caching is unimplemented), so it is read
//    on each such request.
// 6. POST /v1/explain with the stored request (the /v1/route body). An engine
//    409 POLICY_DISABLED passes through (§3.5); other failures map as for
//    POST /transactions (§3.2). A 200 body that doesn't validate is 502.
// 7. Its decision_id must equal the stored one, else 409 DECISION_MISMATCH.
// 8. The Explanation and its audit row are saved in one database transaction,
//    and 200 returns {transactionId, ...explanation}. If a concurrent request
//    stored one first, that one is returned instead (one row, one audit row).
// Nothing is saved or audited on any error. Error messages are the backend's
// fixed text; engine messages and details never reach the client.

export const TRANSACTION_FAILED_MESSAGE = "The transaction failed, so it has no decision to explain.";
export const DECISION_MISMATCH_MESSAGE =
  "The recomputed decision differs from the stored one; the engine artefacts have changed.";

export function getTransactionExplanation(
  store: ExplanationStore | undefined,
  client: InferenceClient | undefined,
  logger: Logger,
): RequestHandler {
  return async (req, res) => {
    const user = authenticatedUser(req);
    const id = req.params.id;
    if (typeof id !== "string" || !UUID.test(id)) throw unknownResource();
    if (store === undefined) throw new Error("Explanations need DATABASE_URL, which is not set");
    const target = await store.findTarget(id);
    if (target === null) throw unknownResource();

    if (target.status === "failed") throw new ApiError(409, "TRANSACTION_FAILED", TRANSACTION_FAILED_MESSAGE);
    // A routed row always has its decision (saved in the same database transaction).
    const decision = target.decision;
    if (decision === null) throw new Error("A routed transaction has no RoutingDecision row");

    if (decision.explanation !== null) {
      res.json(storedBody(target, decision.explanation.engineResponse, req.requestId, logger));
      return;
    }

    // Configuration faults (500) before inference is called, as in POST /transactions.
    if (!(await store.userExists(user.userId))) {
      throw new Error("The authenticated user has no User row; run the development-user seed");
    }
    if (client === undefined) throw inferenceUnavailable("not_configured");

    if (target.requestedPolicy === "ppoProjected") {
      const sha256 = enabledCheckpointSha256(await client.get("/v1/version", { requestId: req.requestId }));
      if (sha256 === null) {
        const disabled = OPT_IN_PASSTHROUGH_CODES.POLICY_DISABLED;
        throw new ApiError(disabled.status, "POLICY_DISABLED", disabled.message);
      }
      if (sha256 !== decision.checkpointSha256) throw decisionMismatch();
    }

    const engineResponse = await client.post("/v1/explain", toRouteRequest(storedRequest(target)), {
      requestId: req.requestId,
      passThrough: ["POLICY_DISABLED"],
    });
    let mapped;
    try {
      mapped = mapExplainResponse(engineResponse, target.requestedPolicy);
    } catch (error) {
      if (error instanceof InvalidExplainResponseError) {
        logger.warn("inference response rejected", { requestId: req.requestId, path: "/v1/explain", problems: error.problems });
      }
      throw error;
    }
    if (mapped.decisionId !== decision.decisionId) throw decisionMismatch();

    const result = await store.save({
      routingDecisionId: decision.id,
      engineResponse,
      userId: user.userId,
      requestId: req.requestId,
    });
    if (result.stored === "existing") {
      res.json(storedBody(target, result.engineResponse, req.requestId, logger));
      return;
    }
    res.json({ transactionId: target.id, ...mapped.body });
  };
}

function decisionMismatch(): ApiError {
  return new ApiError(409, "DECISION_MISMATCH", DECISION_MISMATCH_MESSAGE);
}

// The enabled checkpoint's sha256 from a /v1/version body (§2.2), or null when
// none is enabled. Any other shape is an invalid inference response (502).
function enabledCheckpointSha256(version: JsonObject): string | null {
  if (!Object.hasOwn(version, "checkpoint")) throw inferenceInvalid("invalid_response", 200);
  const checkpoint = version.checkpoint;
  if (checkpoint === null) return null;
  if (typeof checkpoint === "object" && !Array.isArray(checkpoint)) {
    const sha256 = (checkpoint as Record<string, unknown>).sha256;
    if (typeof sha256 === "string" && sha256 !== "") return sha256;
  }
  throw inferenceInvalid("invalid_response", 200);
}

// A stored explanation as the 200 body. It was validated before it was saved,
// so a body that no longer maps is a backend fault: 500, not 502, since
// inference isn't involved; logged with field paths only.
function storedBody(
  target: ExplanationTarget,
  engineResponse: Prisma.JsonValue,
  requestId: string,
  logger: Logger,
): Record<string, unknown> {
  try {
    return { transactionId: target.id, ...mapExplainResponse(engineResponse, target.requestedPolicy).body };
  } catch (error) {
    if (error instanceof InvalidExplainResponseError) {
      logger.error("stored explanation no longer maps", { requestId, transactionId: target.id, problems: error.problems });
      throw new Error("A stored explanation failed validation");
    }
    throw error;
  }
}
