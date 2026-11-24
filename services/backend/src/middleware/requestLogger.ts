import type { RequestHandler } from "express";
import type { Logger } from "../logger.js";

// Logs one line per completed request. Headers and query strings are not
// logged, so neither a token nor a token in a URL can reach the log.
export function requestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      logger.info("request", {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl.split("?")[0],
        status: res.statusCode,
        durationMs: Number(process.hrtime.bigint() - start) / 1e6,
      });
    });
    next();
  };
}
