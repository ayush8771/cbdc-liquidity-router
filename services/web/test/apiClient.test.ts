import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { ApiError, createApiClient, INVALID_RESPONSE, NETWORK_ERROR } from "../src/api/client";
import { isErrorEnvelope, isMeResponse } from "../src/api/types";
import { MOCK_ANALYST_TOKEN, server } from "./msw/server";

const TOKEN = "t".repeat(64); // made up for tests

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" }, ...init });
}

/** A fetch stand-in that records its calls. */
function fakeFetch(respond: () => Response | Promise<Response>) {
  return vi.fn<typeof fetch>(async () => respond());
}

async function failureOf(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("expected the request to fail");
}

describe("API client requests", () => {
  it("calls /api/v1 on this origin with a bearer token, JSON accept and no cookies", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ ok: true }));
    const client = createApiClient({ getToken: () => TOKEN, fetchImpl });

    await expect(client.get("/auth/me")).resolves.toEqual({ ok: true });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`${window.location.origin}/api/v1/auth/me`);
    expect(init?.method).toBe("GET");
    expect(init?.headers).toMatchObject({ Accept: "application/json", Authorization: `Bearer ${TOKEN}` });
    expect(init?.credentials).toBe("omit");
  });

  it("reads the token on every request, and sends no Authorization header without one", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({}));
    let token: string | null = null;
    const client = createApiClient({ getToken: () => token, fetchImpl });

    await client.get("/meta");
    token = TOKEN;
    await client.get("/meta");

    expect(fetchImpl.mock.calls[0]![1]?.headers).not.toHaveProperty("Authorization");
    expect(fetchImpl.mock.calls[1]![1]?.headers).toHaveProperty("Authorization", `Bearer ${TOKEN}`);
  });

  it("puts query values in the URL, leaving out null and undefined, and never the token", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({}));
    const client = createApiClient({ getToken: () => TOKEN, fetchImpl });

    await client.get("/transactions", { query: { page: 2, completed: false, corridor: undefined, policy: null } });

    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toBe(`${window.location.origin}/api/v1/transactions?page=2&completed=false`);
    expect(url).not.toContain(TOKEN);
  });

  it("sends a POST as JSON", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ id: "x" }, { status: 201 }));
    const client = createApiClient({ getToken: () => TOKEN, fetchImpl });

    await expect(client.post("/transactions", { amountUsd: 10 })).resolves.toEqual({ id: "x" });

    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(init?.body).toBe('{"amountUsd":10}');
  });

  it("refuses a path that could name another origin, so the token can't leave", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({}));
    const client = createApiClient({ getToken: () => TOKEN, fetchImpl });

    for (const path of ["https://evil.example/x", "//evil.example/x", "auth/me", "/a\\b", "/x://y"]) {
      await expect(client.get(path)).rejects.toThrow(TypeError);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes an abort through unchanged", async () => {
    const abort = new DOMException("aborted", "AbortError");
    const client = createApiClient({ getToken: () => null, fetchImpl: fakeFetch(() => Promise.reject(abort)) });
    await expect(client.get("/meta")).rejects.toBe(abort);
  });
});

describe("API client errors", () => {
  it("parses the standard error envelope", async () => {
    const body = {
      error: {
        code: "VALIDATION_ERROR",
        message: "Request failed validation.",
        details: { errors: [{ field: "amountUsd", message: "Must be positive." }, { message: "Form-level." }] },
        requestId: "req-1",
      },
    };
    const client = createApiClient({ getToken: () => TOKEN, fetchImpl: fakeFetch(() => jsonResponse(body, { status: 422 })) });

    const error = await failureOf(client.post("/transactions", {}));

    expect(error).toMatchObject({ status: 422, code: "VALIDATION_ERROR", message: "Request failed validation.", requestId: "req-1" });
    expect(error.details.errors).toEqual(body.error.details.errors);
  });

  it("uses the X-Request-Id header when the body has no request ID, and keeps unknown codes as they are", async () => {
    const body = { error: { code: "SOMETHING_NEW", message: "m" } };
    const response = () => jsonResponse(body, { status: 418, headers: { "X-Request-Id": "hdr-1" } });
    const client = createApiClient({ getToken: () => null, fetchImpl: fakeFetch(response) });

    const error = await failureOf(client.get("/meta"));

    expect(error).toMatchObject({ status: 418, code: "SOMETHING_NEW", requestId: "hdr-1", details: {} });
  });

  it("turns an error with no envelope (a proxy page) into HTTP_<status>", async () => {
    const response = () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "X-Request-Id": "p-1" } });
    const client = createApiClient({ getToken: () => null, fetchImpl: fakeFetch(response) });

    const error = await failureOf(client.get("/meta"));

    expect(error).toMatchObject({ status: 502, code: "HTTP_502", requestId: "p-1" });
    expect(error.message).not.toContain("Bad gateway");
  });

  it("reads Retry-After as whole seconds, and ignores any other form", async () => {
    const make = (value: string) => () =>
      jsonResponse({ error: { code: "ENGINE_BUSY", message: "Busy." } }, { status: 503, headers: { "Retry-After": value } });

    const seconds = await failureOf(createApiClient({ getToken: () => null, fetchImpl: fakeFetch(make("7")) }).get("/meta"));
    const date = await failureOf(
      createApiClient({ getToken: () => null, fetchImpl: fakeFetch(make("Wed, 21 Oct 2026 07:28:00 GMT")) }).get("/meta"),
    );

    expect(seconds.retryAfterSeconds).toBe(7);
    expect(date.retryAfterSeconds).toBeNull();
  });

  it("reports an unreachable server as NETWORK_ERROR with status 0", async () => {
    const client = createApiClient({ getToken: () => null, fetchImpl: fakeFetch(() => Promise.reject(new TypeError("Failed to fetch"))) });
    expect(await failureOf(client.get("/meta"))).toMatchObject({ status: 0, code: NETWORK_ERROR });
  });

  it("reports a 200 whose body isn't JSON as INVALID_RESPONSE", async () => {
    const client = createApiClient({ getToken: () => null, fetchImpl: fakeFetch(() => new Response("not json", { status: 200 })) });
    expect(await failureOf(client.get("/meta"))).toMatchObject({ status: 200, code: INVALID_RESPONSE });
  });

  it("never puts the token in an error", async () => {
    const client = createApiClient({ getToken: () => TOKEN, fetchImpl: fakeFetch(() => Promise.reject(new Error(`boom ${TOKEN}`))) });
    const error = await failureOf(client.get("/meta"));
    expect(JSON.stringify({ message: error.message, details: error.details, code: error.code })).not.toContain(TOKEN);
  });
});

describe("API client 401 and 403", () => {
  const unauthenticated = () =>
    jsonResponse({ error: { code: "UNAUTHENTICATED", message: "Missing or invalid token." } }, { status: 401 });

  it("tells the caller the session is over on a 401 to a request that carried a token", async () => {
    const onUnauthorized = vi.fn();
    const client = createApiClient({ getToken: () => TOKEN, onUnauthorized, fetchImpl: fakeFetch(unauthenticated) });

    expect(await failureOf(client.get("/meta"))).toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("does not, when the request carried no token", async () => {
    const onUnauthorized = vi.fn();
    const client = createApiClient({ getToken: () => null, onUnauthorized, fetchImpl: fakeFetch(unauthenticated) });

    await failureOf(client.get("/meta"));
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("does not on a 403 FORBIDDEN_POLICY, which is not a sign-out", async () => {
    const onUnauthorized = vi.fn();
    const forbidden = () => jsonResponse({ error: { code: "FORBIDDEN_POLICY", message: "No." } }, { status: 403 });
    const client = createApiClient({ getToken: () => TOKEN, onUnauthorized, fetchImpl: fakeFetch(forbidden) });

    expect(await failureOf(client.post("/transactions", {}))).toMatchObject({ status: 403, code: "FORBIDDEN_POLICY" });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe("API client never retries", () => {
  it.each([
    ["a 503", () => jsonResponse({ error: { code: "ENGINE_BUSY", message: "Busy." } }, { status: 503, headers: { "Retry-After": "1" } })],
    ["a 504", () => jsonResponse({ error: { code: "ENGINE_TIMEOUT", message: "Late." } }, { status: 504 })],
    ["a network failure", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("sends a POST once after %s", async (_name, respond) => {
    const fetchImpl = fakeFetch(respond);
    const client = createApiClient({ getToken: () => TOKEN, fetchImpl });

    await failureOf(client.post("/transactions", { amountUsd: 1 }));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends a failing GET once too", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ error: { code: "INTERNAL_ERROR", message: "x" } }, { status: 500 }));
    await failureOf(createApiClient({ getToken: () => null, fetchImpl }).get("/meta"));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("API client against MSW and the contract fixtures", () => {
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  it("reads the analyst identity", async () => {
    const client = createApiClient({ getToken: () => MOCK_ANALYST_TOKEN });
    const me = await client.get<unknown>("/auth/me");
    expect(isMeResponse(me)).toBe(true);
    expect(me).toMatchObject({ role: "analyst", email: "analyst@example.test", permissions: { experimentalPolicies: true } });
  });

  it("gets the contract's 401 for an unknown token", async () => {
    const client = createApiClient({ getToken: () => "nope" });
    expect(await failureOf(client.get("/auth/me"))).toMatchObject({ status: 401, code: "UNAUTHENTICATED", message: "Missing or invalid token." });
  });

  it("works through the real global fetch with a handler override", async () => {
    server.use(http.get("*/api/v1/meta", () => HttpResponse.json({ inferenceMode: "live" })));
    await expect(createApiClient({ getToken: () => MOCK_ANALYST_TOKEN }).get("/meta")).resolves.toEqual({ inferenceMode: "live" });
  });
});

describe("response shape checks", () => {
  it("accepts the envelope and ignores extra fields", () => {
    expect(isErrorEnvelope({ error: { code: "A", message: "b", extra: 1 }, other: 2 })).toBe(true);
    expect(isErrorEnvelope({ error: { code: "A" } })).toBe(false);
    expect(isErrorEnvelope(null)).toBe(false);
  });

  it("rejects an identity the UI can't rely on", () => {
    const base = { userId: "u", email: "e@x.test", role: "viewer", authMode: "dev", permissions: { experimentalPolicies: false } };
    expect(isMeResponse(base)).toBe(true);
    expect(isMeResponse({ ...base, extra: true })).toBe(true);
    expect(isMeResponse({ ...base, role: "admin" })).toBe(false);
    expect(isMeResponse({ ...base, email: undefined })).toBe(false);
    expect(isMeResponse({ ...base, permissions: null })).toBe(false);
  });
});
