import express, { type RequestHandler } from "express";
import { ApiError } from "./errors.js";

// JSON request bodies for mutating endpoints, mounted per route (not app-wide).
// Every rejection is 400 MALFORMED_REQUEST, the only body-format code in API
// contract §4 ("Invalid JSON"):
// - Content-Type isn't application/json (any parameters, e.g. charset=utf-8,
//   are allowed), or there is no body at all;
// - the body is empty, isn't valid JSON, or its top level isn't an object or
//   array (strict mode). express.json() alone would turn an empty body into {};
// - the body is larger than JSON_BODY_LIMIT, or uses an unsupported charset
//   or content encoding.
// PROVISIONAL: §4 has no 413 or 415 code, so those cases also use 400
// MALFORMED_REQUEST, each with its own message. The parser's own error text is
// never returned.

/** Express's json() default. An explicit state with history is a few kilobytes. */
export const JSON_BODY_LIMIT = "100kb";

const NOT_JSON = "The request body is not valid JSON.";
const MESSAGES: Readonly<Record<string, string>> = {
  "entity.parse.failed": NOT_JSON,
  "entity.verify.failed": NOT_JSON, // the empty-body check below
  "entity.too.large": `The request body is larger than ${JSON_BODY_LIMIT}.`,
  "charset.unsupported": "The request body must be UTF-8 JSON.",
  "encoding.unsupported": "The request body uses an unsupported content encoding.",
  "request.aborted": "The request body was not received completely.",
  "request.size.invalid": "The request body was not received completely.",
};

export function jsonBody(): RequestHandler {
  const parse = express.json({
    limit: JSON_BODY_LIMIT,
    strict: true,
    type: "application/json",
    // Runs on the raw bytes before parsing; throwing becomes entity.verify.failed.
    verify: (_req, _res, buffer) => {
      if (buffer.length === 0) throw new Error("empty body");
    },
  });
  return (req, res, next) => {
    // req.is() is null when there's no body and false for another type.
    if (req.is("application/json") !== "application/json") {
      next(new ApiError(400, "MALFORMED_REQUEST", "The request body must be JSON sent as application/json."));
      return;
    }
    parse(req, res, (error?: unknown) => {
      if (error === undefined) return next();
      const type = (error as { type?: unknown }).type;
      if (typeof type === "string" && Object.hasOwn(MESSAGES, type)) {
        return next(new ApiError(400, "MALFORMED_REQUEST", MESSAGES[type]!));
      }
      // Anything else is unexpected: 500 INTERNAL_ERROR, logged by the error handler.
      next(error);
    });
  };
}
