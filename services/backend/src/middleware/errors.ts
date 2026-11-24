import type { ErrorRequestHandler, RequestHandler } from "express";
import { describePrismaError, isPrismaError } from "../db/errors.js";
import type { Logger } from "../logger.js";

// The Application API error envelope (API contract §4):
//   {"error": {"code", "message", "details", "requestId"}}
// Messages never include tokens or stack traces.

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  /** Response headers sent with the envelope, e.g. Retry-After (§4). */
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export const notFound: RequestHandler = (_req, _res, next) => {
  next(new ApiError(404, "NOT_FOUND", "Unknown resource."));
};

export function errorHandler(logger: Logger): ErrorRequestHandler {
  // Express recognises an error handler by its four parameters, so _next stays.
  return (err, req, res, _next) => {
    // Too late to send an envelope. Close the connection so the client sees an
    // incomplete response. Express's default handler is not used, because it
    // prints the raw stack trace. The error itself is not logged either.
    if (res.headersSent) {
      logger.error("error after response started; connection closed", { requestId: req.requestId });
      res.destroy();
      return;
    }

    let error: ApiError;
    if (err instanceof ApiError) {
      error = err;
    } else {
      // The original error is logged server-side only, never returned.
      logger.error("unhandled error", { requestId: req.requestId, error: describe(err) });
      error = new ApiError(500, "INTERNAL_ERROR", "An unexpected error occurred.");
    }

    res.set(error.headers);
    res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details, requestId: req.requestId },
    });
  };
}

function describe(err: unknown): Record<string, unknown> {
  // A Prisma error's message and stack header can contain database details,
  // so only its class name, P#### code and stack frames are logged.
  if (isPrismaError(err)) return describePrismaError(err);
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return { value: String(err) };
}
