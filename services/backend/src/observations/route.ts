import type { RequestHandler } from "express";
import { authenticatedUser } from "../auth/devAuth.js";
import { ApiError } from "../middleware/errors.js";
import { methodNotAllowedError } from "../middleware/methodNotAllowed.js";
import { SHUTTING_DOWN_RETRY_AFTER, STREAM_LIMIT_RETRY_AFTER, STREAM_PATH } from "./constants.js";
import type { StreamHub } from "./streamHub.js";

// `GET /api/rt/v1/observations/stream` (AD-1 v0.5 §3.2). Outside API contract
// v0.4. Mounted with app.all behind requireAuth, so authentication runs first
// for every method: no or bad token is 401, before any 405 (HEAD included).
// Then, in order: 405 for any method but GET (HEAD included, Allow: GET),
// 422 for any query, 503 SHUTTING_DOWN, 429 STREAM_LIMIT. Errors use the
// Phase 2 envelope through the existing error handler. `Last-Event-ID` is
// ignored, and no SSE `id:` is ever sent.

export const QUERY_NOT_ALLOWED_MESSAGE = "This endpoint accepts no query parameters.";

/** True when the request URL carries a non-empty query string. */
function hasQuery(originalUrl: string): boolean {
  const index = originalUrl.indexOf("?");
  return index !== -1 && index < originalUrl.length - 1;
}

export function observationStream(hub: StreamHub): RequestHandler {
  return (req, res) => {
    if (req.method !== "GET") throw methodNotAllowedError(req.method, STREAM_PATH, "GET");
    if (hasQuery(req.originalUrl)) {
      throw new ApiError(422, "VALIDATION_ERROR", "Request failed validation.", {
        errors: [{ message: QUERY_NOT_ALLOWED_MESSAGE }],
      });
    }
    const user = authenticatedUser(req);
    const reserved = hub.reserve(user.userId);
    if (!reserved.ok) {
      if (reserved.reason === "shutting_down") {
        throw new ApiError(503, "SHUTTING_DOWN", "The server is shutting down.", {}, {
          "Retry-After": SHUTTING_DOWN_RETRY_AFTER,
        });
      }
      throw new ApiError(429, "STREAM_LIMIT", "Too many open observation streams.", {}, {
        "Retry-After": STREAM_LIMIT_RETRY_AFTER,
      });
    }
    // The slot is taken: from here every path must hand it to the hub or release it.
    try {
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      req.socket.setNoDelay(true);
      hub.open(reserved.slot, res, { requestId: req.requestId });
    } catch (error) {
      reserved.slot.release();
      res.destroy();
      throw error;
    }
  };
}
