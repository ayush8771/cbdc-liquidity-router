import type { RequestHandler } from "express";
import { BACKEND_VERSION } from "../config/backendVersion.js";
import type { InferenceMode } from "../config/config.js";
import type { InferenceCache } from "../inferenceClient/cache.js";
import { inferenceInvalid, inferenceUnavailable } from "../inferenceClient/errors.js";
import type { Logger } from "../logger.js";
import { KeyCollisionError, toCamelCase } from "../mappers/camelCase.js";
import { POLICY_FROM_ENGINE } from "../mappers/routeResponse.js";

// GET /api/v1/meta (API contract §3.1, §3.9): the camelCase mapping of
// /v1/version (§2.2), read through the shared cache, plus "backendVersion"
// (package.json) and "inferenceMode" ("live" or "mock", from the inference
// client's configured mode). Any role may call it. Query parameters are
// ignored. Like the calendar, the body is checked only for being a JSON object
// (by the client); no fields are validated or computed.
//
// Policy names are enum values, mapped like a decision's policy (§3.2,
// contracts/README "Engine -> app mapping"; fixture app/meta/200_meta.json):
// defaultPolicy and each policies[].policy, cheapest_feasible ->
// cheapestFeasible and ppo_projected -> ppoProjected. An unknown name is kept
// as sent (§1). Nothing else is changed, and the cached body isn't mutated.
//
// If the mapped engine body already has a "backendVersion" or "inferenceMode"
// key, it is treated as a key collision (502), the same as two engine keys
// colliding, rather than overwriting either value.
export function getMeta(
  cache: InferenceCache | undefined,
  inferenceMode: InferenceMode | undefined,
  logger: Logger,
): RequestHandler {
  return async (req, res) => {
    if (cache === undefined || inferenceMode === undefined) throw inferenceUnavailable("not_configured");
    // Inference errors (InferenceError) reach the error handler as they are.
    const version = await cache.version(req.requestId);
    let mapped: Record<string, unknown>;
    try {
      mapped = toCamelCase(version) as Record<string, unknown>;
      if (Object.hasOwn(mapped, "backendVersion") || Object.hasOwn(mapped, "inferenceMode")) {
        throw new KeyCollisionError();
      }
    } catch (error) {
      if (!(error instanceof KeyCollisionError)) throw error;
      logger.warn("inference response could not be mapped", {
        requestId: req.requestId,
        path: "/v1/version",
        reason: "key_collision",
      });
      throw inferenceInvalid("invalid_response", 200);
    }
    res.json({ ...mapPolicyNames(mapped), backendVersion: BACKEND_VERSION, inferenceMode });
  };
}

function appPolicyName(value: unknown): unknown {
  return typeof value === "string" && Object.hasOwn(POLICY_FROM_ENGINE, value) ? POLICY_FROM_ENGINE[value] : value;
}

/** A copy of the camelCase body with its policy names in the application spelling. */
export function mapPolicyNames(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  if (Object.hasOwn(out, "defaultPolicy")) out.defaultPolicy = appPolicyName(out.defaultPolicy);
  if (Array.isArray(out.policies)) {
    out.policies = out.policies.map((entry: unknown) =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry) && Object.hasOwn(entry, "policy")
        ? { ...(entry as Record<string, unknown>), policy: appPolicyName((entry as Record<string, unknown>).policy) }
        : entry,
    );
  }
  return out;
}
