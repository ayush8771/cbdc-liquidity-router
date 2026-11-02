import type { RequestHandler } from "express";
import type { InferenceClient } from "../inferenceClient/client.js";
import { inferenceInvalid, inferenceUnavailable } from "../inferenceClient/errors.js";
import type { Logger } from "../logger.js";
import { KeyCollisionError, toCamelCase } from "../mappers/camelCase.js";

// GET /api/v1/replay/calendar (API contract §2.6, §3.1): the camelCase mapping
// of GET /v1/replay/calendar. Any role may call it. Query parameters are
// ignored and not forwarded (none are documented). The body is checked only
// for being a JSON object (by the client); no fields are validated or computed.
// Not cached yet: §3.1 marks it "(cached)", pending a decision on when the
// backend checks /v1/version (§5).
export function replayCalendar(client: InferenceClient | undefined, logger: Logger): RequestHandler {
  return async (req, res) => {
    if (client === undefined) throw inferenceUnavailable("not_configured");
    // Inference errors (InferenceError) reach the error handler as they are.
    const calendar = await client.get("/v1/replay/calendar", { requestId: req.requestId });
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
