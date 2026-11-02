import type { Config, InferenceMode } from "../config/config.js";
import type { Logger } from "../logger.js";
import { REQUEST_ID_HEADER } from "../middleware/requestId.js";
import {
  InferenceError,
  PASSTHROUGH_CODES,
  inferenceInvalid,
  inferenceUnavailable,
  type InferenceFailure,
} from "./errors.js";

// The only module that calls the inference service (arch §5.2; API contract §2,
// §4, §5). It returns the engine's snake_case JSON unchanged: mapping to
// camelCase belongs to the mappers. Response bodies are checked only for being
// a JSON object, because no OpenAPI schema exists yet.
//
// - Timeout: INFERENCE_TIMEOUT_MS covers the whole call, response body included.
// - Headers: only Accept, Content-Type (POST) and X-Request-Id are set. The
//   client takes no incoming request or header object, so Authorization, a
//   development token or a cookie can't be forwarded (§5: inference has no auth).
// - Retries: none. POST is never retried (§5). GET may be retried once under
//   §5, but that isn't done yet.
// - Redirects are not followed; a 3xx is an invalid response.
// - Errors: only documented codes pass through, with the backend's own message
//   and empty details (errors.ts). Response size is bounded only by the
//   timeout; a limit awaits expected response sizes from Dev A.
// - health() is the one exception to "only HTTP 200 succeeds": /v1/health
//   answers 503 when not ready (§2.1), so it also accepts 503, returns the
//   status with the body, and leaves logging to the health probe.
// - Mock mode makes no network call. It answers only from an injected handler;
//   contracts/fixtures/inference/ doesn't exist yet, so by default every call
//   fails with 503 INFERENCE_UNAVAILABLE.

// The documented inference endpoints (API contract §2).
export const INFERENCE_GET_PATHS = [
  "/v1/health",
  "/v1/version",
  "/v1/network",
  "/v1/state",
  "/v1/replay/calendar",
  "/v1/scenarios",
] as const;
export const INFERENCE_POST_PATHS = ["/v1/route", "/v1/compare", "/v1/explain"] as const;

export type InferenceGetPath = (typeof INFERENCE_GET_PATHS)[number];
export type InferencePostPath = (typeof INFERENCE_POST_PATHS)[number];
export type QueryValue = string | number | boolean | undefined;
export type JsonObject = Record<string, unknown>;

export interface InferenceRequest {
  method: "GET" | "POST";
  path: InferenceGetPath | InferencePostPath;
  /** GET only. Undefined values are left out. */
  query?: Record<string, QueryValue>;
  /** POST only. */
  body?: JsonObject;
  requestId?: string;
}

/** What a mock handler answers: an HTTP status and an already-parsed JSON body. */
export interface MockResponse {
  status: number;
  body: unknown;
  retryAfter?: string;
}

/** Returns the mock answer for a request, or undefined when it has none. */
export type MockHandler = (request: Readonly<InferenceRequest>) => MockResponse | undefined;

/** A /v1/health answer: HTTP 200 (ready) or 503 (not ready), with its JSON object body. */
export interface InferenceHealthResponse {
  httpStatus: 200 | 503;
  body: JsonObject;
}

export interface InferenceClient {
  readonly mode: InferenceMode;
  get(path: InferenceGetPath, options?: { query?: Record<string, QueryValue>; requestId?: string }): Promise<JsonObject>;
  post(path: InferencePostPath, body: JsonObject, options?: { requestId?: string }): Promise<JsonObject>;
  /** GET /v1/health. Any other status, or a failure, throws as get() does, without logging. */
  health(options?: { requestId?: string }): Promise<InferenceHealthResponse>;
}

export interface InferenceClientOptions {
  logger: Logger;
  /** Mock mode only. */
  mockHandler?: MockHandler;
}

// A received status and body before interpretation. NOT_JSON marks a body that
// isn't JSON or doesn't parse.
const NOT_JSON = Symbol("not JSON");
interface Answer {
  status: number;
  body: unknown;
  retryAfter: string | undefined;
}

export function createInferenceClient(config: Config["inference"], options: InferenceClientOptions): InferenceClient {
  const { logger } = options;

  const sendLive = async (request: InferenceRequest): Promise<Answer> => {
    const url = new URL(config.url + request.path);
    for (const [name, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    // Built outside the try below, so a bad header value isn't reported as a
    // network failure.
    const headers = new Headers({ Accept: "application/json" });
    if (request.method === "POST") headers.set("Content-Type", "application/json");
    if (request.requestId) headers.set(REQUEST_ID_HEADER, request.requestId);
    const payload = request.method === "POST" ? JSON.stringify(request.body) : undefined;

    const signal = AbortSignal.timeout(config.timeoutMs);
    try {
      const response = await fetch(url, { method: request.method, headers, body: payload, signal, redirect: "manual" });
      const text = await response.text();
      const isJson = /^application\/json\b/i.test(response.headers.get("content-type") ?? "");
      return {
        status: response.status,
        body: isJson ? parseJson(text) : NOT_JSON,
        retryAfter: response.headers.get("retry-after") ?? undefined,
      };
    } catch {
      throw inferenceUnavailable(signal.aborted ? "timeout" : "unreachable");
    }
  };

  const sendMock = async (request: InferenceRequest): Promise<Answer> => {
    // Copies in both directions, so neither side can change the other's objects.
    const answer = options.mockHandler?.(structuredClone(request));
    if (answer === undefined) throw inferenceUnavailable("mock_unavailable");
    return { status: answer.status, body: structuredClone(answer.body), retryAfter: answer.retryAfter };
  };

  const call = async (
    request: InferenceRequest,
    { accepted = OK_ONLY, log = true }: { accepted?: readonly number[]; log?: boolean } = {},
  ): Promise<{ status: number; body: JsonObject }> => {
    const started = Date.now();
    try {
      const answer = await (config.mode === "mock" ? sendMock(request) : sendLive(request));
      return interpret(answer, accepted);
    } catch (error) {
      if (log && error instanceof InferenceError) {
        // A passed-through inference error is usually the caller's input
        // (e.g. 422), not a fault. Bodies, query values and inference
        // messages are never logged.
        const fields = {
          requestId: request.requestId,
          method: request.method,
          path: request.path,
          failure: error.failure,
          code: error.code,
          upstreamStatus: error.upstreamStatus,
          upstreamCode: error.upstreamCode,
          durationMs: Date.now() - started,
        };
        if (error.failure === "upstream_error") logger.info("inference request returned an error", fields);
        else logger.warn("inference request failed", fields);
      }
      throw error;
    }
  };

  return {
    mode: config.mode,
    // async, so a refused path is a rejected promise like every other failure.
    async get(path, { query, requestId } = {}) {
      assertPath(INFERENCE_GET_PATHS, path);
      return (await call({ method: "GET", path, query, requestId })).body;
    },
    async post(path, body, { requestId } = {}) {
      assertPath(INFERENCE_POST_PATHS, path);
      return (await call({ method: "POST", path, body, requestId })).body;
    },
    async health({ requestId } = {}) {
      // The probe logs status changes itself, so failures aren't logged per call.
      const { status, body } = await call(
        { method: "GET", path: "/v1/health", requestId },
        { accepted: HEALTH_STATUSES, log: false },
      );
      return { httpStatus: status as 200 | 503, body };
    },
  };
}

// Every documented success is HTTP 200 with a JSON object; /v1/health also
// answers 503 with a body when not ready (§2.1).
const OK_ONLY: readonly number[] = [200];
const HEALTH_STATUSES: readonly number[] = [200, 503];

function interpret(
  { status, body, retryAfter }: Answer,
  accepted: readonly number[],
): { status: number; body: JsonObject } {
  if (accepted.includes(status)) {
    if (isPlainObject(body)) return { status, body };
    throw inferenceInvalid("invalid_response", status);
  }
  const code = readEnvelopeCode(body);
  const upstreamCode = code !== undefined && LOGGABLE_CODE.test(code) ? code : undefined;
  const passthrough = code !== undefined && Object.hasOwn(PASSTHROUGH_CODES, code) ? PASSTHROUGH_CODES[code] : undefined;
  if (code !== undefined && passthrough?.status === status) {
    // Only the code is kept; the message is the backend's own and details stay empty.
    throw new InferenceError(status, code, passthrough.message, "upstream_error", {
      upstreamStatus: status,
      upstreamCode,
      retryAfter,
    });
  }
  let failure: InferenceFailure = "invalid_response";
  if (status >= 500) failure = "upstream_5xx";
  else if (status >= 400 && code !== undefined) failure = "upstream_4xx";
  throw inferenceInvalid(failure, status, upstreamCode);
}

// The inference code is logged only when it looks like one, so arbitrary
// response text never reaches the logs.
const LOGGABLE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

// The code of an inference error envelope (API contract §4), or undefined when
// the body isn't one. Only the code is read: the message, details and
// request_id are checked for shape and then dropped.
function readEnvelopeCode(body: unknown): string | undefined {
  if (!isPlainObject(body) || !isPlainObject(body.error)) return undefined;
  const { code, message, details } = body.error;
  if (typeof code !== "string" || typeof message !== "string") return undefined;
  if (details !== undefined && !isPlainObject(details)) return undefined;
  return code;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return NOT_JSON;
  }
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPath(allowed: readonly string[], path: string): void {
  // The types already restrict paths; this catches untyped callers.
  if (!allowed.includes(path)) throw new Error(`Not a documented inference endpoint for this method: ${path}`);
}
