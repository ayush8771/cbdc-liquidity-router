/*
 * The Application API client (contract §3, arch §8.3).
 *
 * Rules it enforces:
 * - Base path `/api/v1`, same origin. A path must start with a single "/", so
 *   the bearer token can never be sent to another origin.
 * - The token comes from `getToken` at request time and is sent only as
 *   `Authorization: Bearer`. It is never put in a URL, a message or a log.
 * - Error bodies are parsed from the standard envelope (contract §4). Anything
 *   that isn't that envelope still becomes an ApiError, keyed by HTTP status.
 * - Nothing is ever retried. In particular a POST is sent once, so a routing
 *   request is never repeated behind the user's back.
 * - A 401 on a request that carried a token calls `onUnauthorized` (arch §8.3:
 *   "a 401 clears the token and returns to sign-in"). A 403 does not.
 */
import { isErrorEnvelope, type ApiErrorDetails } from "./types";

export const API_BASE_PATH = "/api/v1";

/** Raised by the client itself: no response was received (offline, refused, reset). */
export const NETWORK_ERROR = "NETWORK_ERROR";
/** Raised by the client itself: the body wasn't the JSON the endpoint should return. */
export const INVALID_RESPONSE = "INVALID_RESPONSE";
/**
 * Raised by the client itself: no answer within the request's `timeoutMs`. As with
 * NETWORK_ERROR, `status` is 0: the server may or may not have received, or even
 * finished, the request. A timeout is not an answer.
 */
export const REQUEST_TIMEOUT = "REQUEST_TIMEOUT";

/**
 * Every failure of a request. `code` is the backend's error code when it sent
 * the standard envelope, `NETWORK_ERROR` or `INVALID_RESPONSE` when the client
 * raised it, and `HTTP_<status>` for an error response with no envelope (for
 * example a proxy's 502 page). `status` is 0 when there was no response.
 * Callers key on `code` (and `status`), never on `message`.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ApiErrorDetails;
  readonly requestId: string | null;
  /** Whole seconds from a `Retry-After` header, or null. It is never acted on automatically. */
  readonly retryAfterSeconds: number | null;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    details?: ApiErrorDetails;
    requestId?: string | null;
    retryAfterSeconds?: number | null;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.details = init.details ?? {};
    this.requestId = init.requestId ?? null;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
  }
}

export type QueryValue = string | number | boolean | null | undefined;

export type RequestOptions = {
  /** Appended to the URL. null and undefined are left out. */
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
  /**
   * Gives up after this many milliseconds, response body included, with a
   * REQUEST_TIMEOUT error. Off unless set. A timed-out request is never retried.
   */
  timeoutMs?: number;
};

export type ApiClient = {
  get<T>(path: string, options?: RequestOptions): Promise<T>;
  /** Sent once. A failed POST is never retried (see the file comment). */
  post<T>(path: string, body: unknown, options?: Pick<RequestOptions, "signal" | "timeoutMs">): Promise<T>;
};

export type ApiClientOptions = {
  /** Read on every request, so a token set after sign-in is used straight away. */
  getToken: () => string | null;
  /** Called when a request that carried a token got 401. The session is over. */
  onUnauthorized?: () => void;
  /** Defaults to `/api/v1`. */
  baseUrl?: string;
  /** For tests. Defaults to the global `fetch`, looked up on each call. */
  fetchImpl?: typeof fetch;
};

function assertSafePath(path: string): void {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://") || path.includes("\\")) {
    throw new TypeError("An API path must start with a single '/' and name no other origin.");
  }
}

function buildUrl(baseUrl: string, path: string, query: RequestOptions["query"]): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== null && value !== undefined) params.append(key, String(value));
  }
  const search = params.toString();
  const url = `${baseUrl}${path}${search ? `?${search}` : ""}`;
  // Browsers take the relative URL as it is. Where `fetch` can't resolve one
  // (Node, in tests), resolve it against the page's own origin: still same origin.
  if (url.startsWith("/") && typeof globalThis.location !== "undefined" && globalThis.location.origin !== "null") {
    return new URL(url, globalThis.location.origin).href;
  }
  return url;
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const seconds = Number(value.trim());
  return Number.isSafeInteger(seconds) ? seconds : null;
}

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const baseUrl = options.baseUrl ?? API_BASE_PATH;

  async function request<T>(
    method: "GET" | "POST",
    path: string,
    init: { query?: RequestOptions["query"]; body?: unknown; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T> {
    assertSafePath(path);
    const token = options.getToken();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    let body: string | undefined;
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.body ?? {});
    }

    const doFetch = options.fetchImpl ?? ((input, requestInit) => globalThis.fetch(input, requestInit));
    let response!: Response;
    let text!: string;

    // An optional deadline for the whole exchange. It aborts the request, and also stops waiting if
    // the fetch in use ignores the abort, so a stalled connection can never hang the caller.
    const controller = init.timeoutMs !== undefined ? new AbortController() : null;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forwardAbort: (() => void) | undefined;
    let expire: (() => void) | undefined;
    const deadline = controller
      ? new Promise<never>((_, reject) => {
          expire = () => reject(new Error("deadline"));
        })
      : null;
    if (controller) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        expire?.();
      }, init.timeoutMs);
      if (init.signal) {
        if (init.signal.aborted) controller.abort();
        else {
          forwardAbort = () => controller.abort();
          init.signal.addEventListener("abort", forwardAbort, { once: true });
        }
      }
    }

    const exchange = async () => {
      response = await doFetch(buildUrl(baseUrl, path, init.query), {
        method,
        headers,
        body,
        // No cookies: the only credential is the bearer token.
        credentials: "omit",
        signal: controller ? controller.signal : init.signal,
      });
      text = await response.text();
    };

    try {
      await (deadline ? Promise.race([exchange(), deadline]) : exchange());
    } catch (error) {
      if (timedOut) {
        throw new ApiError({ status: 0, code: REQUEST_TIMEOUT, message: "The server did not answer in time." });
      }
      if (isAbort(error)) throw error;
      throw new ApiError({ status: 0, code: NETWORK_ERROR, message: "The server could not be reached." });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (forwardAbort) init.signal?.removeEventListener("abort", forwardAbort);
    }

    let parsed: unknown;
    let isJson = true;
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        isJson = false;
      }
    }

    const headerRequestId = response.headers.get("X-Request-Id");
    const retryAfterSeconds = parseRetryAfter(response.headers.get("Retry-After"));

    if (response.ok) {
      if (response.status === 204) return undefined as T;
      if (!isJson || text === "") {
        throw new ApiError({
          status: response.status,
          code: INVALID_RESPONSE,
          message: "The server's response could not be read.",
          requestId: headerRequestId,
        });
      }
      return parsed as T;
    }

    if (response.status === 401 && token) options.onUnauthorized?.();

    if (isJson && isErrorEnvelope(parsed)) {
      const { code, message, details, requestId } = parsed.error;
      throw new ApiError({
        status: response.status,
        code,
        message,
        details: typeof details === "object" && details !== null ? details : {},
        requestId: requestId ?? headerRequestId,
        retryAfterSeconds,
      });
    }
    throw new ApiError({
      status: response.status,
      code: `HTTP_${response.status}`,
      message: "The server returned an unexpected error.",
      requestId: headerRequestId,
      retryAfterSeconds,
    });
  }

  return {
    get: (path, requestOptions) => request("GET", path, { query: requestOptions?.query, signal: requestOptions?.signal }),
    post: (path, body, requestOptions) =>
      request("POST", path, { body, signal: requestOptions?.signal, timeoutMs: requestOptions?.timeoutMs }),
  };
}
