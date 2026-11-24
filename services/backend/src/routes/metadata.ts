import type { RequestHandler } from "express";
import type { CachedResourcePath, InferenceCache } from "../inferenceClient/cache.js";
import { inferenceInvalid, inferenceUnavailable } from "../inferenceClient/errors.js";
import type { Logger } from "../logger.js";
import { KeyCollisionError, toCamelCase } from "../mappers/camelCase.js";

// GET /api/v1/network (API contract §2.3, §3.1) and GET /api/v1/scenarios
// (§2.7, §3.1): the camelCase mapping of the inference body, read through the
// shared cache (§5), so a version fingerprint change drops both. Any role may
// call them. Query parameters are ignored and not forwarded (none are
// documented). As for the replay calendar, the body is checked only for being
// a JSON object (by the client): keys are mapped, values are unchanged, and
// unknown fields are kept (§1 run-time tolerance). Two keys mapping to the
// same camelCase name are a 502 INFERENCE_ERROR, logged without key names.
// Inference errors (InferenceError) reach the error handler as they are.

export const getNetwork = (cache: InferenceCache | undefined, logger: Logger): RequestHandler =>
  cachedResource(cache, "/v1/network", logger);

export const getScenarios = (cache: InferenceCache | undefined, logger: Logger): RequestHandler =>
  cachedResource(cache, "/v1/scenarios", logger);

function cachedResource(cache: InferenceCache | undefined, path: CachedResourcePath, logger: Logger): RequestHandler {
  return async (req, res) => {
    if (cache === undefined) throw inferenceUnavailable("not_configured");
    const body = await cache.get(path, req.requestId);
    let mapped: unknown;
    try {
      mapped = toCamelCase(body);
    } catch (error) {
      if (!(error instanceof KeyCollisionError)) throw error;
      logger.warn("inference response could not be mapped", { requestId: req.requestId, path, reason: "key_collision" });
      throw inferenceInvalid("invalid_response", 200);
    }
    res.json(mapped);
  };
}
