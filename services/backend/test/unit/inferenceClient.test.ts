import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import type { Config } from "../../src/config/config.js";
import {
  createInferenceClient,
  type InferenceClient,
  type InferenceRequest,
  type MockHandler,
} from "../../src/inferenceClient/client.js";
import { InferenceError, PASSTHROUGH_CODES } from "../../src/inferenceClient/errors.js";
import { errorHandler } from "../../src/middleware/errors.js";
import { requestId } from "../../src/middleware/requestId.js";
import { captureLogger, silentLogger, startServer } from "../helpers/server.js";

// The bodies below are test data only. They are not contract fixtures and say
// nothing about the real inference response schemas.

interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

// A fake inference service: records each request and answers with `respond`.
let received: Received[] = [];
let respond: (res: ServerResponse, req: Received) => void;
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const entry = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
    received.push(entry);
    respond(res, entry);
  });
});
let fakeUrl: string;

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function envelope(code: string, message = "test message", details: Record<string, unknown> = {}): unknown {
  return { error: { code, message, details, request_id: "upstream-id" } };
}

function liveClient(overrides: Partial<Config["inference"]> = {}, logger = silentLogger): InferenceClient {
  return createInferenceClient({ url: fakeUrl, mode: "live", timeoutMs: 2000, ...overrides }, { logger });
}

async function rejectsWith(
  promise: Promise<unknown>,
  expected: { status: number; code: string; failure: string; upstreamStatus?: number },
): Promise<InferenceError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof InferenceError, `expected InferenceError, got ${String(error)}`);
    assert.equal(error.status, expected.status);
    assert.equal(error.code, expected.code);
    assert.equal(error.failure, expected.failure);
    if ("upstreamStatus" in expected) assert.equal(error.upstreamStatus, expected.upstreamStatus);
    return error;
  }
  assert.fail("expected the call to reject");
}

/** A port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

describe("inference client", () => {
  before(async () => {
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  });

  after(async () => {
    fake.closeAllConnections();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  });

  beforeEach(() => {
    received = [];
    respond = (res) => json(res, 200, { ok: true });
  });

  describe("live mode: requests", () => {
    it("GET sends the path and query, and returns the JSON body unchanged", async () => {
      respond = (res) => json(res, 200, { snake_case_field: 1, nested: { a: [1, 2] } });
      const body = await liveClient().get("/v1/state", {
        query: { corridor: "GBR->PHL", include_history: true, date: undefined },
      });
      assert.deepEqual(body, { snake_case_field: 1, nested: { a: [1, 2] } });
      assert.equal(received.length, 1);
      assert.equal(received[0]!.method, "GET");
      const url = new URL(received[0]!.url, fakeUrl);
      assert.equal(url.pathname, "/v1/state");
      assert.deepEqual([...url.searchParams], [["corridor", "GBR->PHL"], ["include_history", "true"]]);
      assert.equal(received[0]!.body, "");
    });

    it("POST sends the body as JSON", async () => {
      await liveClient().post("/v1/route", { policy: "waterfall", amount_usd: 1000.5 });
      assert.equal(received[0]!.method, "POST");
      assert.equal(received[0]!.url, "/v1/route");
      assert.match(received[0]!.headers["content-type"] ?? "", /^application\/json/);
      assert.deepEqual(JSON.parse(received[0]!.body), { policy: "waterfall", amount_usd: 1000.5 });
    });

    it("forwards X-Request-Id when supplied, and sends none otherwise", async () => {
      const client = liveClient();
      await client.get("/v1/version", { requestId: "req-123" });
      await client.post("/v1/route", {}, { requestId: "req-456" });
      await client.get("/v1/version");
      await client.post("/v1/route", {}, { requestId: "" });
      assert.equal(received[0]!.headers["x-request-id"], "req-123");
      assert.equal(received[1]!.headers["x-request-id"], "req-456");
      assert.equal(received[2]!.headers["x-request-id"], undefined);
      assert.equal(received[3]!.headers["x-request-id"], undefined);
    });

    it("never sends Authorization, a cookie or a token", async () => {
      const client = liveClient();
      await client.get("/v1/network", { requestId: "r" });
      await client.post("/v1/compare", { policies: ["waterfall"] }, { requestId: "r" });
      for (const entry of received) {
        for (const name of ["authorization", "cookie", "proxy-authorization"]) {
          assert.equal(entry.headers[name], undefined, `${name} must not be sent`);
        }
        assert.doesNotMatch(JSON.stringify(entry.headers), /bearer|token/i);
      }
    });

    it("joins the configured base URL and path", async () => {
      // config.ts strips a trailing slash, so the base never ends in one.
      await liveClient({ url: `${fakeUrl}/prefix` }).get("/v1/health");
      assert.equal(received[0]!.url, "/prefix/v1/health");
    });

    it("refuses undocumented paths and the wrong method without calling inference", async () => {
      const client = liveClient();
      const untyped = client as unknown as {
        get(path: string): Promise<unknown>;
        post(path: string, body: object): Promise<unknown>;
      };
      await assert.rejects(untyped.get("/v1/route"), (e) => !(e instanceof InferenceError));
      await assert.rejects(untyped.post("/v1/health", {}), (e) => !(e instanceof InferenceError));
      await assert.rejects(untyped.get("/v2/anything"), /Not a documented inference endpoint/);
      assert.equal(received.length, 0);
    });
  });

  describe("live mode: timeouts, unreachability and retries", () => {
    it("fails with 503 INFERENCE_UNAVAILABLE when no response arrives in time", async () => {
      respond = (res) => setTimeout(() => json(res, 200, {}), 500);
      const started = Date.now();
      await rejectsWith(liveClient({ timeoutMs: 50 }).post("/v1/route", {}), {
        status: 503,
        code: "INFERENCE_UNAVAILABLE",
        failure: "timeout",
      });
      assert.ok(Date.now() - started < 450, "the timeout must not wait for the response");
    });

    it("applies the timeout to the response body too", async () => {
      respond = (res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"partial":');
        setTimeout(() => res.end("1}"), 500);
      };
      await rejectsWith(liveClient({ timeoutMs: 50 }).get("/v1/version"), {
        status: 503,
        code: "INFERENCE_UNAVAILABLE",
        failure: "timeout",
      });
    });

    it("fails with 503 INFERENCE_UNAVAILABLE when inference is unreachable", async () => {
      const client = liveClient({ url: `http://127.0.0.1:${await closedPort()}` });
      await rejectsWith(client.post("/v1/route", {}), {
        status: 503,
        code: "INFERENCE_UNAVAILABLE",
        failure: "unreachable",
        upstreamStatus: undefined,
      });
    });

    it("fails with 503 when the connection is reset, and never retries a POST", async () => {
      respond = (res) => res.socket?.destroy();
      await rejectsWith(liveClient().post("/v1/route", {}), {
        status: 503,
        code: "INFERENCE_UNAVAILABLE",
        failure: "unreachable",
      });
      assert.equal(received.length, 1);
    });

    it("never retries a POST after a timeout or a server error", async () => {
      respond = (res) => setTimeout(() => json(res, 200, {}), 300);
      await assert.rejects(liveClient({ timeoutMs: 30 }).post("/v1/explain", {}));
      respond = (res) => json(res, 500, envelope("INTERNAL_ERROR"));
      await assert.rejects(liveClient().post("/v1/compare", {}));
      respond = (res) => json(res, 503, envelope("ENGINE_BUSY"), { "Retry-After": "1" });
      await assert.rejects(liveClient().post("/v1/route", {}));
      // Give a retry, if there were one, time to arrive.
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.deepEqual(
        received.map((r) => r.url),
        ["/v1/explain", "/v1/compare", "/v1/route"],
      );
    });

    it("does not retry a GET either (not implemented yet)", async () => {
      respond = (res) => json(res, 500, envelope("INTERNAL_ERROR"));
      await assert.rejects(liveClient().get("/v1/version"));
      assert.equal(received.length, 1);
    });
  });

  describe("live mode: error mapping (API contract §3.2, §4)", () => {
    // Documented pass-through: engine validation errors (422, §3.2), and
    // ENGINE_BUSY and ENGINE_TIMEOUT (§4).
    const passthrough: Array<[string, number]> = [
      ["VALIDATION_ERROR", 422],
      ["UNSUPPORTED_CORRIDOR", 422],
      ["INVALID_AMOUNT", 422],
      ["DATE_OUT_OF_RANGE", 422],
      ["DATE_IN_GAP_BUFFER", 422],
      ["UNKNOWN_SCENARIO", 422],
      ["STATE_VENUE_MISMATCH", 422],
      ["INVALID_STATE_VALUE", 422],
      ["POLICY_UNAVAILABLE_FOR_STATE", 422],
      ["ENGINE_BUSY", 503],
      ["ENGINE_TIMEOUT", 504],
    ];
    for (const [code, status] of passthrough) {
      it(`keeps ${status} ${code} but not the inference message or details`, async () => {
        respond = (res) =>
          json(res, status, envelope(code, `upstream message for ${code}`, { field: "state.date", errors: [{ x: 1 }] }));
        const error = await rejectsWith(liveClient().post("/v1/route", {}), {
          status,
          code,
          failure: "upstream_error",
          upstreamStatus: status,
        });
        assert.equal(error.message, PASSTHROUGH_CODES[code]!.message);
        assert.doesNotMatch(error.message, /upstream message/);
        assert.deepEqual(error.details, {});
      });
    }

    it("passes through exactly the documented codes", () => {
      assert.deepEqual(Object.keys(PASSTHROUGH_CODES).sort(), passthrough.map(([code]) => code).sort());
    });

    it("keeps Retry-After from ENGINE_BUSY on the error only", async () => {
      respond = (res) => json(res, 503, envelope("ENGINE_BUSY"), { "Retry-After": "2" });
      const error = await rejectsWith(liveClient().post("/v1/route", {}), {
        status: 503,
        code: "ENGINE_BUSY",
        failure: "upstream_error",
      });
      assert.equal(error.retryAfter, "2");
    });

    it("accepts an envelope without details", async () => {
      respond = (res) => json(res, 422, { error: { code: "INVALID_AMOUNT", message: "m" } });
      const error = await rejectsWith(liveClient().post("/v1/route", {}), {
        status: 422,
        code: "INVALID_AMOUNT",
        failure: "upstream_error",
      });
      assert.deepEqual(error.details, {});
    });

    // Documented inference codes without a pass-through rule (provisional).
    for (const [code, status] of [
      ["NOT_FOUND", 404],
      ["POLICY_DISABLED", 409],
      ["MALFORMED_REQUEST", 400],
    ] as const) {
      it(`maps ${status} ${code} to 502 INFERENCE_ERROR`, async () => {
        respond = (res) => json(res, status, envelope(code, "upstream message", { field: "x" }));
        const error = await rejectsWith(liveClient().post("/v1/route", {}), {
          status: 502,
          code: "INFERENCE_ERROR",
          failure: "upstream_4xx",
          upstreamStatus: status,
        });
        assert.equal(error.upstreamCode, code);
        assert.equal(error.message, "The inference service returned an invalid response.");
        assert.deepEqual(error.details, {});
      });
    }

    const mappedTo502: Array<[string, number, unknown]> = [
      ["INTERNAL_ERROR", 500, envelope("INTERNAL_ERROR")],
      ["NOT_READY", 503, envelope("NOT_READY")],
      ["a 502 from a proxy", 502, "<html>Bad gateway</html>"],
      ["a 5xx with no body", 500, undefined],
    ];
    for (const [label, status, body] of mappedTo502) {
      it(`maps ${status} ${label} to 502 INFERENCE_ERROR`, async () => {
        respond = (res) => {
          if (typeof body === "string") {
            res.writeHead(status, { "Content-Type": "text/html" });
            res.end(body);
          } else if (body === undefined) {
            res.writeHead(status).end();
          } else {
            json(res, status, body);
          }
        };
        const error = await rejectsWith(liveClient().post("/v1/route", {}), {
          status: 502,
          code: "INFERENCE_ERROR",
          failure: "upstream_5xx",
          upstreamStatus: status,
        });
        // Nothing from the inference body is passed on.
        assert.equal(error.message, "The inference service returned an invalid response.");
        assert.deepEqual(error.details, {});
      });
    }

    const unmapped: Array<[string, number, unknown, string]> = [
      ["an undocumented code", 418, envelope("TEAPOT"), "upstream_4xx"],
      ["a pass-through code with the wrong status", 400, envelope("ENGINE_BUSY"), "upstream_4xx"],
      ["a 422 with an undocumented code", 422, envelope("SOMETHING_NEW"), "upstream_4xx"],
      ["an inherited property name as code", 422, envelope("constructor"), "upstream_4xx"],
      ["a 4xx without an envelope", 422, { detail: "FastAPI default" }, "invalid_response"],
      [
        "an envelope whose details is not an object",
        422,
        { error: { code: "INVALID_AMOUNT", message: "m", details: [] } },
        "invalid_response",
      ],
      ["an envelope without a message", 422, { error: { code: "INVALID_AMOUNT" } }, "invalid_response"],
    ];
    for (const [label, status, body, failure] of unmapped) {
      it(`maps ${label} to 502 INFERENCE_ERROR`, async () => {
        respond = (res) => json(res, status, body);
        const error = await rejectsWith(liveClient().post("/v1/route", {}), {
          status: 502,
          code: "INFERENCE_ERROR",
          failure,
          upstreamStatus: status,
        });
        assert.deepEqual(error.details, {});
      });
    }

    it("records the inference code only when it looks like a code", async () => {
      respond = (res) => json(res, 418, envelope("not a code: free text"));
      const error = await rejectsWith(liveClient().post("/v1/route", {}), {
        status: 502,
        code: "INFERENCE_ERROR",
        failure: "upstream_4xx",
      });
      assert.equal(error.upstreamCode, undefined);
    });
  });

  describe("live mode: invalid success responses", () => {
    const cases: Array<[string, (res: ServerResponse) => void]> = [
      ["a non-JSON content type", (res) => res.writeHead(200, { "Content-Type": "text/plain" }).end("{}")],
      ["no content type", (res) => res.writeHead(200).end("{}")],
      ["invalid JSON", (res) => res.writeHead(200, { "Content-Type": "application/json" }).end("{nope")],
      ["an empty body", (res) => res.writeHead(200, { "Content-Type": "application/json" }).end()],
      ["a JSON array", (res) => json(res, 200, [1, 2])],
      ["JSON null", (res) => json(res, 200, null)],
      ["a JSON string", (res) => json(res, 200, "ok")],
      ["HTTP 201", (res) => json(res, 201, {})],
      ["HTTP 204", (res) => res.writeHead(204).end()],
    ];
    for (const [label, handler] of cases) {
      it(`maps ${label} to 502 INFERENCE_ERROR`, async () => {
        respond = handler;
        await rejectsWith(liveClient().get("/v1/version"), {
          status: 502,
          code: "INFERENCE_ERROR",
          failure: "invalid_response",
        });
      });
    }

    it("does not follow redirects", async () => {
      respond = (res, req) => {
        if (req.url === "/v1/version") res.writeHead(302, { Location: "/elsewhere" }).end();
        else json(res, 200, { followed: true });
      };
      await rejectsWith(liveClient().get("/v1/version", { requestId: "r" }), {
        status: 502,
        code: "INFERENCE_ERROR",
        failure: "invalid_response",
        upstreamStatus: 302,
      });
      assert.deepEqual(
        received.map((r) => r.url),
        ["/v1/version"],
      );
    });

    it("accepts a JSON content type with a charset", async () => {
      respond = (res) => res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end('{"a":1}');
      assert.deepEqual(await liveClient().get("/v1/version"), { a: 1 });
    });
  });

  describe("health()", () => {
    const healthBody = (ready: boolean, status = "ok") => ({ status, ready, checks: {}, time: "t" });

    it("returns HTTP 200 and its body", async () => {
      respond = (res) => json(res, 200, healthBody(true));
      assert.deepEqual(await liveClient().health(), { httpStatus: 200, body: healthBody(true) });
      assert.equal(received[0]!.method, "GET");
      assert.equal(received[0]!.url, "/v1/health");
    });

    it("returns HTTP 503 with its body instead of throwing", async () => {
      respond = (res) => json(res, 503, healthBody(false));
      assert.deepEqual(await liveClient().health(), { httpStatus: 503, body: healthBody(false) });
      respond = (res) => json(res, 503, envelope("NOT_READY"), { "Retry-After": "5" });
      assert.deepEqual(await liveClient().health(), { httpStatus: 503, body: envelope("NOT_READY") });
    });

    it("forwards X-Request-Id and sends no Authorization", async () => {
      await liveClient().health({ requestId: "health-id" });
      assert.equal(received[0]!.headers["x-request-id"], "health-id");
      assert.equal(received[0]!.headers.authorization, undefined);
    });

    for (const [label, failure, handler] of [
      ["HTTP 500", "upstream_5xx", (res: ServerResponse) => json(res, 500, envelope("INTERNAL_ERROR"))],
      ["HTTP 502", "upstream_5xx", (res: ServerResponse) => json(res, 502, healthBody(false))],
      ["HTTP 404", "upstream_4xx", (res: ServerResponse) => json(res, 404, envelope("NOT_FOUND"))],
      ["HTTP 302", "invalid_response", (res: ServerResponse) => res.writeHead(302, { Location: "/x" }).end()],
      ["a non-JSON 503", "invalid_response", (res: ServerResponse) => res.writeHead(503, { "Content-Type": "text/html" }).end("<h1>down</h1>")],
      ["a JSON array", "invalid_response", (res: ServerResponse) => json(res, 200, [])],
    ] as const) {
      it(`throws INFERENCE_ERROR for ${label}`, async () => {
        respond = handler;
        await rejectsWith(liveClient().health(), { status: 502, code: "INFERENCE_ERROR", failure });
      });
    }

    it("throws INFERENCE_UNAVAILABLE on timeout and when unreachable", async () => {
      respond = (res) => setTimeout(() => json(res, 200, healthBody(true)), 500);
      await rejectsWith(liveClient({ timeoutMs: 50 }).health(), {
        status: 503,
        code: "INFERENCE_UNAVAILABLE",
        failure: "timeout",
      });
      const closed = liveClient({ url: `http://127.0.0.1:${await closedPort()}` });
      await rejectsWith(closed.health(), { status: 503, code: "INFERENCE_UNAVAILABLE", failure: "unreachable" });
    });

    it("does not log, leaving that to the health probe", async () => {
      const capture = captureLogger();
      respond = (res) => json(res, 500, envelope("INTERNAL_ERROR"));
      await assert.rejects(liveClient({}, capture.logger).health());
      assert.deepEqual(capture.lines, []);
    });

    it("leaves get() strict: a 503 from /v1/health still throws 502", async () => {
      respond = (res) => json(res, 503, healthBody(false));
      await rejectsWith(liveClient().get("/v1/health"), {
        status: 502,
        code: "INFERENCE_ERROR",
        failure: "upstream_5xx",
        upstreamStatus: 503,
      });
    });

    it("leaves other endpoints strict: a 503 health-shaped body or NOT_READY still throws", async () => {
      const client = liveClient();
      respond = (res) => json(res, 503, healthBody(false));
      await rejectsWith(client.get("/v1/version"), { status: 502, code: "INFERENCE_ERROR", failure: "upstream_5xx" });
      respond = (res) => json(res, 503, envelope("NOT_READY"));
      await rejectsWith(client.post("/v1/route", {}), { status: 502, code: "INFERENCE_ERROR", failure: "upstream_5xx" });
      respond = (res) => json(res, 503, envelope("ENGINE_BUSY"));
      await rejectsWith(client.post("/v1/route", {}), { status: 503, code: "ENGINE_BUSY", failure: "upstream_error" });
    });
  });

  describe("mock mode", () => {
    function mockClient(mockHandler?: MockHandler, logger = silentLogger): InferenceClient {
      // The URL points at the fake service, to prove that mock mode never calls it.
      return createInferenceClient({ url: fakeUrl, mode: "mock", timeoutMs: 2000 }, { logger, mockHandler });
    }

    it("reports its mode", () => {
      assert.equal(mockClient().mode, "mock");
      assert.equal(liveClient().mode, "live");
    });

    it("fails with 503 INFERENCE_UNAVAILABLE when no mock response exists, without any network call", async () => {
      const client = mockClient();
      await rejectsWith(client.get("/v1/version"), {
        status: 503,
        code: "INFERENCE_UNAVAILABLE",
        failure: "mock_unavailable",
      });
      await rejectsWith(client.post("/v1/route", {}), {
        status: 503,
        code: "INFERENCE_UNAVAILABLE",
        failure: "mock_unavailable",
      });
      await rejectsWith(
        mockClient(() => undefined).get("/v1/network"),
        { status: 503, code: "INFERENCE_UNAVAILABLE", failure: "mock_unavailable" },
      );
      assert.equal(received.length, 0);
    });

    it("answers from the handler, which sees the request", async () => {
      const seen: InferenceRequest[] = [];
      const client = mockClient((request) => {
        seen.push(request);
        return { status: 200, body: { from: "mock" } };
      });
      assert.deepEqual(await client.post("/v1/route", { a: 1 }, { requestId: "r1" }), { from: "mock" });
      assert.deepEqual(await client.get("/v1/state", { query: { corridor: "USA->IND" } }), { from: "mock" });
      assert.deepEqual(seen[0], { method: "POST", path: "/v1/route", body: { a: 1 }, requestId: "r1" });
      assert.deepEqual(seen[1], { method: "GET", path: "/v1/state", query: { corridor: "USA->IND" }, requestId: undefined });
      assert.equal(received.length, 0);
    });

    it("isolates the handler's objects from the caller's", async () => {
      const stored = { nested: { value: 1 } };
      const client = mockClient((request) => {
        (request.body as { a: number }).a = 99;
        return { status: 200, body: stored };
      });
      const sent = { a: 1 };
      const result = (await client.post("/v1/route", sent)) as { nested: { value: number } };
      result.nested.value = 2;
      assert.equal(sent.a, 1);
      assert.equal(stored.nested.value, 1);
    });

    it("maps mock answers exactly as live ones", async () => {
      await rejectsWith(
        mockClient(() => ({ status: 422, body: envelope("INVALID_AMOUNT") })).post("/v1/route", {}),
        { status: 422, code: "INVALID_AMOUNT", failure: "upstream_error" },
      );
      const busy = await rejectsWith(
        mockClient(() => ({ status: 503, body: envelope("ENGINE_BUSY"), retryAfter: "3" })).post("/v1/route", {}),
        { status: 503, code: "ENGINE_BUSY", failure: "upstream_error" },
      );
      assert.equal(busy.retryAfter, "3");
      await rejectsWith(mockClient(() => ({ status: 500, body: envelope("INTERNAL_ERROR") })).get("/v1/version"), {
        status: 502,
        code: "INFERENCE_ERROR",
        failure: "upstream_5xx",
      });
      await rejectsWith(mockClient(() => ({ status: 200, body: [] })).get("/v1/version"), {
        status: 502,
        code: "INFERENCE_ERROR",
        failure: "invalid_response",
      });
    });
  });

  describe("logging", () => {
    it("logs failures with request metadata only, never bodies or query values", async () => {
      const capture = captureLogger();
      respond = (res) => json(res, 500, envelope("INTERNAL_ERROR", "engine secret-ish detail"));
      await assert.rejects(
        liveClient({}, capture.logger).post("/v1/route", { marker: "body-marker" }, { requestId: "req-log" }),
      );
      respond = (res) => json(res, 422, envelope("INVALID_AMOUNT"));
      await assert.rejects(
        liveClient({}, capture.logger).get("/v1/state", { query: { corridor: "query-marker" }, requestId: "req-log2" }),
      );

      const [failure, upstream] = capture.entries();
      assert.equal(failure!.level, "warn");
      assert.equal(failure!.msg, "inference request failed");
      assert.equal(failure!.requestId, "req-log");
      assert.equal(failure!.method, "POST");
      assert.equal(failure!.path, "/v1/route");
      assert.equal(failure!.failure, "upstream_5xx");
      assert.equal(failure!.code, "INFERENCE_ERROR");
      assert.equal(failure!.upstreamStatus, 500);
      assert.equal(failure!.upstreamCode, "INTERNAL_ERROR");
      assert.equal(typeof failure!.durationMs, "number");
      // An error passed through from inference is usually the caller's input.
      assert.equal(upstream!.level, "info");
      assert.equal(upstream!.code, "INVALID_AMOUNT");
      assert.equal(upstream!.upstreamCode, "INVALID_AMOUNT");
      for (const line of capture.lines) {
        assert.doesNotMatch(line, /body-marker|query-marker|secret-ish/);
      }
    });

    it("logs nothing for a successful call", async () => {
      const capture = captureLogger();
      await liveClient({}, capture.logger).get("/v1/version");
      assert.deepEqual(capture.lines, []);
    });
  });

  describe("through the Application API error handler", () => {
    // Upstream text that must never reach the client.
    const leaky = "Traceback (most recent call last): postgresql://user:pass@db/x token=abc";

    async function probe(headers: Record<string, string> = {}): Promise<{ res: Response; text: string }> {
      const client = liveClient();
      const app = express();
      app.use(requestId);
      app.get("/probe", async (req, _res, next) => {
        try {
          await client.post("/v1/route", {}, { requestId: req.requestId });
        } catch (error) {
          next(error);
        }
      });
      app.use(errorHandler(silentLogger));
      const server = await startServer(app);
      try {
        const res = await fetch(`${server.baseUrl}/probe`, { headers });
        return { res, text: await res.text() };
      } finally {
        await server.close();
      }
    }

    it("renders a 422 with the documented code, the backend's message and requestId, and empty details", async () => {
      respond = (res) => json(res, 422, envelope("DATE_IN_GAP_BUFFER", leaky, { field: "state.date", trace: leaky }));
      const { res, text } = await probe({ "X-Request-Id": "caller-id", Authorization: `Bearer ${"a".repeat(64)}` });
      assert.equal(res.status, 422);
      assert.equal(res.headers.get("x-request-id"), "caller-id");
      assert.deepEqual(JSON.parse(text), {
        error: {
          code: "DATE_IN_GAP_BUFFER",
          message: "The date falls within a gap buffer.",
          details: {},
          requestId: "caller-id",
        },
      });
      assert.doesNotMatch(text, /Traceback|postgresql|token|upstream-id|request_id/);
      assert.equal(received[0]!.headers["x-request-id"], "caller-id");
      assert.equal(received[0]!.headers.authorization, undefined);
    });

    it("does not send Retry-After with ENGINE_BUSY", async () => {
      respond = (res) => json(res, 503, envelope("ENGINE_BUSY", leaky), { "Retry-After": "5" });
      const { res, text } = await probe();
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("retry-after"), null);
      const body = JSON.parse(text) as { error: Record<string, unknown> };
      assert.equal(body.error.code, "ENGINE_BUSY");
      assert.equal(body.error.message, "The routing engine is busy. Try again later.");
      assert.deepEqual(body.error.details, {});
    });

    for (const [code, status] of [
      ["POLICY_DISABLED", 409],
      ["NOT_FOUND", 404],
      ["INTERNAL_ERROR", 500],
    ] as const) {
      it(`renders ${status} ${code} as a generic 502 INFERENCE_ERROR`, async () => {
        respond = (res) => json(res, status, envelope(code, leaky, { trace: leaky }));
        const { res, text } = await probe({ "X-Request-Id": "caller-id" });
        assert.equal(res.status, 502);
        assert.deepEqual(JSON.parse(text), {
          error: {
            code: "INFERENCE_ERROR",
            message: "The inference service returned an invalid response.",
            details: {},
            requestId: "caller-id",
          },
        });
        assert.doesNotMatch(text, new RegExp(code));
      });
    }
  });
});
