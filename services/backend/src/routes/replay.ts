import type { RequestHandler } from "express";
import type { InferenceCache } from "../inferenceClient/cache.js";
import { inferenceInvalid, inferenceUnavailable } from "../inferenceClient/errors.js";
import type { Logger } from "../logger.js";
import { KeyCollisionError, toCamelCase } from "../mappers/camelCase.js";

// GET /api/v1/replay/calendar (API contract §2.6, §3.1): the camelCase mapping
// of GET /v1/replay/calendar. Any role may call it. Query parameters are
// ignored and not forwarded (none are documented). The body is checked only
// for being a JSON object (by the client); no fields are validated or computed.
// Cached (§3.1) through the shared inference cache, which re-checks
// /v1/version and drops the calendar when the §5 fingerprint changes.
export function replayCalendar(cache: InferenceCache | undefined, logger: Logger): RequestHandler {
  return async (req, res) => {
    if (cache === undefined) throw inferenceUnavailable("not_configured");
    // Inference errors (InferenceError) reach the error handler as they are.
    const calendar = await cache.get("/v1/replay/calendar", req.requestId);
    let mapped: unknown;
    try {
      mapped = toCamelCase(calendar);
    } catch (error) {
      if (!(error instanceof KeyCollisionError)) throw error;
      logger.warn("inference response could not be mapped", {
        requestId: req.requestId,
        path: "/v1/replay/calendar",
        reason: "key_collision",
      });
      throw inferenceInvalid("invalid_response", 200);
    }
    res.json(mapped);
  };
}
