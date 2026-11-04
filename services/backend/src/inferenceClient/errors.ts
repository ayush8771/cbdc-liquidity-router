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
  | "upstream_5xx" // 5xx not passed through or mapped, e.g. INTERNAL_ERROR
  | "not_ready" // 503 NOT_READY, mapped to 503 INFERENCE_UNAVAILABLE (§3.2, §4)
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
   * Retry-After in integer seconds, as forwarded to the client (§4), or
   * undefined. Set only for ENGINE_BUSY and NOT_READY, and only when the
   * inference value is valid (see retryAfterSeconds).
   */
  readonly retryAfter: string | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    failure: InferenceFailure,
    extra: {
      upstreamStatus?: number;
      upstreamCode?: string;
      retryAfter?: string;
      /** Backend-written details only, e.g. {cause: "NOT_READY"}; never inference details. */
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(
      status,
      code,
      message,
      extra.details ?? {},
      extra.retryAfter === undefined ? {} : { "Retry-After": extra.retryAfter },
    );
    this.name = "InferenceError";
    this.failure = failure;
    this.upstreamStatus = extra.upstreamStatus;
    this.upstreamCode = extra.upstreamCode;
    this.retryAfter = extra.retryAfter;
  }
}

/** Inference codes whose Retry-After is forwarded (§4). */
export const RETRY_AFTER_CODES: readonly string[] = Object.freeze(["ENGINE_BUSY", "NOT_READY"]);

/**
 * Normalises an inference Retry-After to integer seconds (§4), or undefined.
 * Only delta-seconds (digits, optional surrounding spaces) are accepted; an
 * HTTP-date, a fraction, a sign, a non-safe integer or any other text is
 * dropped, so the app response has no Retry-After rather than a wrong one.
 * Leading zeros are removed ("05" -> "5").
 */
export function retryAfterSeconds(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^[0-9]{1,15}$/.test(trimmed)) return undefined;
  const seconds = Number(trimmed);
  return Number.isSafeInteger(seconds) ? String(seconds) : undefined;
}

/** Inference 503 NOT_READY, as §3.2 and §4 map it: fixed text, cause set. */
export function inferenceNotReady(retryAfter: string | undefined): InferenceError {
  return new InferenceError(503, "INFERENCE_UNAVAILABLE", "The inference service is unavailable.", "not_ready", {
    upstreamStatus: 503,
    upstreamCode: "NOT_READY",
    retryAfter,
    details: { cause: "NOT_READY" },
  });
}

// Inference error codes the client keeps, with the HTTP status §4 gives each
// and a message written here. Only these are documented as passed through:
// engine validation errors, 422 (§3.2: "passed through with the same code"),
// and ENGINE_BUSY and ENGINE_TIMEOUT (§4: "passed through by app").
// The inference message is never forwarded. Of the details, only a 422's
// field paths pass, mapped through fieldPaths.ts (§4); for every other code
// details stay empty. The messages below
// paraphrase §4's "When" column. An envelope whose status doesn't match its
// code is an invalid response. Every other code maps to 502 INFERENCE_ERROR,
// including NOT_FOUND and POLICY_DISABLED (no pass-through rule in §3.2 or §4;
// PROVISIONAL, confirm with Dev A) and MALFORMED_REQUEST (the backend always
// sends valid JSON, so it would be a backend fault). A call may opt in to
// passing POLICY_DISABLED through; see OPT_IN_PASSTHROUGH_CODES. The one
// mapped code is 503 NOT_READY: it becomes 503 INFERENCE_UNAVAILABLE with
// details.cause "NOT_READY" (inferenceNotReady). Retry-After is forwarded
// for ENGINE_BUSY and NOT_READY only (RETRY_AFTER_CODES).
export const PASSTHROUGH_CODES: Readonly<Record<string, { status: number; message: string }>> = Object.freeze({
  // The same text as the backend's own VALIDATION_ERROR: one message per code (§4).
  VALIDATION_ERROR: { status: 422, message: "Request failed validation." },
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

// Codes passed through only when a call asks for them by name (the
// passThrough option of InferenceClient.post), handled like PASSTHROUGH_CODES.
// Without the option they map to 502 INFERENCE_ERROR as above.
// POLICY_DISABLED: team decision, Step 6E-3, for POST /v1/route from
// transaction creation, and for POST /v1/explain from the explanation
// endpoint (§3.5: passed through). Comparisons don't opt in.
export const OPT_IN_PASSTHROUGH_CODES = Object.freeze({
  POLICY_DISABLED: { status: 409, message: "The experimental PPO policy has no approved checkpoint enabled." },
});

export type OptInPassthroughCode = keyof typeof OPT_IN_PASSTHROUGH_CODES;

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
