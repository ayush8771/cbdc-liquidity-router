import { ApiError } from "../middleware/errors.js";

// Inference failures as Application API errors (API contract §4, §5). An
// InferenceError is an ApiError, so the existing error handler renders it with
// the backend's own requestId; the inference body's request_id is never used.

/** Why the call failed; logged, never sent to the client. */
export type InferenceFailure =
  | "timeout" // INFERENCE_TIMEOUT_MS elapsed (request or response body)
  | "unreachable" // connection refused, DNS failure, reset, ...
  | "upstream_error" // an inference error code passed through (§3.2, §4)
  | "upstream_4xx" // a 4xx error envelope not passed through, e.g. NOT_FOUND or POLICY_DISABLED
  | "upstream_5xx" // 5xx not passed through, e.g. INTERNAL_ERROR or NOT_READY
  | "invalid_response" // not JSON, not an object, a redirect, or an unexpected status or envelope
  | "mock_unavailable" // mock mode has no response for this request
  | "not_configured"; // the app was created without an inference client

export class InferenceError extends ApiError {
  readonly failure: InferenceFailure;
  /** The inference service's HTTP status, when it answered. Logged only. */
  readonly upstreamStatus: number | undefined;
  /** The inference error code, when it looks like one (upper case and underscores). Logged only. */
  readonly upstreamCode: string | undefined;
  /**
   * The inference service's Retry-After header (ENGINE_BUSY, NOT_READY), when
   * present. Kept for later use; not sent to the client until that is agreed.
   */
  readonly retryAfter: string | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    failure: InferenceFailure,
    extra: { upstreamStatus?: number; upstreamCode?: string; retryAfter?: string } = {},
  ) {
    // details stay empty: no inference details are forwarded (see below).
    super(status, code, message);
    this.name = "InferenceError";
    this.failure = failure;
    this.upstreamStatus = extra.upstreamStatus;
    this.upstreamCode = extra.upstreamCode;
    this.retryAfter = extra.retryAfter;
  }
}

// Inference error codes the client keeps, with the HTTP status §4 gives each
// and a message written here. Only these are documented as passed through:
// engine validation errors, 422 (§3.2: "passed through with the same code"),
// and ENGINE_BUSY and ENGINE_TIMEOUT (§4: "passed through by app").
// The inference message and details are never forwarded: the contract doesn't
// say they pass through, and no details schema is agreed. The messages below
// paraphrase §4's "When" column. An envelope whose status doesn't match its
// code is an invalid response. Every other code maps to 502 INFERENCE_ERROR,
// including NOT_FOUND and POLICY_DISABLED (no pass-through rule in §3.2 or §4;
// PROVISIONAL, confirm with Dev A) and MALFORMED_REQUEST (the backend always
// sends valid JSON, so it would be a backend fault).
export const PASSTHROUGH_CODES: Readonly<Record<string, { status: number; message: string }>> = Object.freeze({
  VALIDATION_ERROR: { status: 422, message: "The routing request has a schema or type error." },
  UNSUPPORTED_CORRIDOR: { status: 422, message: "The corridor is not in the network." },
  INVALID_AMOUNT: { status: 422, message: "The amount must be greater than 0 and finite." },
  DATE_OUT_OF_RANGE: { status: 422, message: "The date is outside 2011-01-01 to 2025-09-30." },
  DATE_IN_GAP_BUFFER: { status: 422, message: "The date falls within a gap buffer." },
  UNKNOWN_SCENARIO: { status: 422, message: "The scenario is not defined." },
  STATE_VENUE_MISMATCH: { status: 422, message: "The explicit state's venues don't match the corridor exactly." },
  INVALID_STATE_VALUE: {
    status: 422,
    message:
      "The explicit state has an invalid value: negative, NaN or infinite, history of the wrong length, " +
      "or a last history value different from the current one.",
  },
  POLICY_UNAVAILABLE_FOR_STATE: {
    status: 422,
    message: "The experimental PPO policy needs history on every venue in explicit state mode.",
  },
  ENGINE_BUSY: { status: 503, message: "The routing engine is busy. Try again later." },
  ENGINE_TIMEOUT: { status: 504, message: "The routing engine did not finish in time." },
});

export function inferenceUnavailable(
  failure: "timeout" | "unreachable" | "mock_unavailable" | "not_configured",
): InferenceError {
  const message =
    failure === "mock_unavailable"
      ? "The inference mock has no response for this request."
      : "The inference service is unavailable.";
  return new InferenceError(503, "INFERENCE_UNAVAILABLE", message, failure);
}

export function inferenceInvalid(
  failure: "upstream_4xx" | "upstream_5xx" | "invalid_response",
  upstreamStatus?: number,
  upstreamCode?: string,
): InferenceError {
  return new InferenceError(502, "INFERENCE_ERROR", "The inference service returned an invalid response.", failure, {
    upstreamStatus,
    upstreamCode,
  });
}
