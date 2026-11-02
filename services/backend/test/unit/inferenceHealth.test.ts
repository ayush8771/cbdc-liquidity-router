import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { createApp } from "../../src/app.js";
import type { InferenceMode } from "../../src/config/config.js";
import {
  createInferenceClient,
  type InferenceClient,
  type InferenceHealthResponse,
} from "../../src/inferenceClient/client.js";
import { inferenceInvalid, inferenceUnavailable } from "../../src/inferenceClient/errors.js";
import { createInferenceHealthProbe } from "../../src/inferenceClient/health.js";
import { captureLogger, silentLogger, startServer } from "../helpers/server.js";

// Health bodies here are test data shaped after API contract §2.1, not fixtures.
const body = (ready: unknown, status: unknown = "ok") => ({ status, ready, checks: {}, time: "t" });
const notReadyEnvelope = { error: { code: "NOT_READY", message: "m", details: {}, request_id: "x" } };

/** A client whose health() answers or throws as given, recording each call. */
function fakeClient(
  answer: InferenceHealthResponse | Error,
  mode: InferenceMode = "live",
): { client: InferenceClient; calls: Array<string | undefined> } {
  const calls: Array<string | undefined> = [];
  const unused = async (): Promise<never> => assert.fail("only health() may be called");
  const client: InferenceClient = {
    mode,
    get: unused,
    post: unused,
    async health({ requestId } = {}) {
      calls.push(requestId);
      if (answer instanceof Error) throw answer;
      return structuredClone(answer);
    },
  };
  return { client, calls };
}

describe("inference health probe", () => {
  const outcomes: Array<[string, InferenceHealthResponse, string, string]> = [
    ["200, ready, ok", { httpStatus: 200, body: body(true, "ok") }, "ok", "ok"],
    ["200, ready, degraded", { httpStatus: 200, body: body(true, "degraded") }, "degraded", "degraded"],
    ["503, not ready (status ok)", { httpStatus: 503, body: body(false, "ok") }, "unavailable", "not_ready"],
    ["503, not ready (status degraded)", { httpStatus: 503, body: body(false, "degraded") }, "unavailable", "not_ready"],
    ["503, NOT_READY envelope", { httpStatus: 503, body: notReadyEnvelope }, "unavailable", "not_ready"],
    ["200 with ready false", { httpStatus: 200, body: body(false) }, "unavailable", "invalid_response"],
    ["503 with ready true", { httpStatus: 503, body: body(true) }, "unavailable", "invalid_response"],
    ["200 with an unknown status", { httpStatus: 200, body: body(true, "fine") }, "unavailable", "invalid_response"],
    ["200 without ready", { httpStatus: 200, body: { status: "ok" } }, "unavailable", "invalid_response"],
    ["200 with ready as a string", { httpStatus: 200, body: body("true") }, "unavailable", "invalid_response"],
    ["503, ready false without a status", { httpStatus: 503, body: { ready: false } }, "unavailable", "invalid_response"],
    [
      "503, another error envelope",
      { httpStatus: 503, body: { error: { code: "ENGINE_BUSY", message: "m" } } },
      "unavailable",
      "invalid_response",
    ],
    [
      "503, NOT_READY envelope without a message",
      { httpStatus: 503, body: { error: { code: "NOT_READY" } } },
      "unavailable",
      "invalid_response",
    ],
    ["503, empty object", { httpStatus: 503, body: {} }, "unavailable", "invalid_response"],
  ];
  for (const [label, answer, expected, reason] of outcomes) {
    it(`reports ${expected} for ${label}`, async () => {
      const capture = captureLogger();
      const { client } = fakeClient(answer);
      assert.equal(await createInferenceHealthProbe(client, capture.logger).check(), expected);
      assert.equal(capture.entries()[0]!.reason, reason);
    });
  }

  const failures: Array<[string, Error, string]> = [
    ["a timeout", inferenceUnavailable("timeout"), "timeout"],
    ["an unreachable service", inferenceUnavailable("unreachable"), "unreachable"],
    ["an unsupported status (5xx)", inferenceInvalid("upstream_5xx", 500), "upstream_5xx"],
    ["an unsupported status (4xx)", inferenceInvalid("upstream_4xx", 404), "upstream_4xx"],
    ["an invalid response", inferenceInvalid("invalid_response", 200), "invalid_response"],
    ["an unexpected error", new Error("secret internal detail"), "error"],
  ];
  for (const [label, error, reason] of failures) {
    it(`reports unavailable for ${label}, without throwing`, async () => {
      const capture = captureLogger();
      const { client } = fakeClient(error);
      assert.equal(await createInferenceHealthProbe(client, capture.logger).check(), "unavailable");
      assert.deepEqual(capture.entries().map(({ level, msg, inference, reason: r }) => ({ level, msg, inference, reason: r })), [
        { level: "warn", msg: "inference status", inference: "unavailable", reason },
      ]);
      assert.doesNotMatch(capture.lines.join("\n"), /secret internal detail/);
    });
  }

  it("reports unavailable without a client", async () => {
    const capture = captureLogger();
    assert.equal(await createInferenceHealthProbe(undefined, capture.logger).check(), "unavailable");
    assert.equal(capture.entries()[0]!.reason, "not_configured");
  });

  it("reports mock in mock mode without calling health()", async () => {
    const { client, calls } = fakeClient({ httpStatus: 200, body: body(true) }, "mock");
    const capture = captureLogger();
    assert.equal(await createInferenceHealthProbe(client, capture.logger).check("r"), "mock");
    assert.deepEqual(calls, []);
    assert.equal(capture.entries()[0]!.level, "info");
    assert.equal(capture.entries()[0]!.reason, "mock");
  });

  it("passes the request ID to health()", async () => {
    const { client, calls } = fakeClient({ httpStatus: 200, body: body(true) });
    const probe = createInferenceHealthProbe(client, silentLogger);
    await probe.check("req-1");
    await probe.check();
    assert.deepEqual(calls, ["req-1", undefined]);
  });

  it("logs only status or reason changes, with safe fields only", async () => {
    let answer: InferenceHealthResponse | Error = { httpStatus: 200, body: { ...body(true), marker: "body-marker" } };
    const capture = captureLogger();
    const client: InferenceClient = {
      ...fakeClient(answer).client,
      async health() {
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
    const probe = createInferenceHealthProbe(client, capture.logger);
    await probe.check();
    await probe.check();
    answer = { httpStatus: 200, body: body(true, "degraded") };
    await probe.check();
    answer = inferenceUnavailable("timeout");
    await probe.check();
    await probe.check();
    answer = inferenceUnavailable("unreachable");
    await probe.check();
    answer = { httpStatus: 200, body: body(true) };
    await probe.check();

    assert.deepEqual(capture.entries().map(({ time: _time, ...rest }) => rest), [
      { level: "info", msg: "inference status", inference: "ok", reason: "ok" },
      { level: "warn", msg: "inference status", inference: "degraded", reason: "degraded" },
      { level: "warn", msg: "inference status", inference: "unavailable", reason: "timeout" },
      { level: "warn", msg: "inference status", inference: "unavailable", reason: "unreachable" },
      { level: "info", msg: "inference status", inference: "ok", reason: "ok" },
    ]);
    assert.doesNotMatch(capture.lines.join("\n"), /body-marker/);
  });
});

// The real client and probe behind GET /api/v1/health, against a fake inference service.
describe("GET /api/v1/health with the inference client", () => {
  const leaky = "Traceback: postgresql://user:pass@db token=abc";
  let requests: Array<{ url: string; headers: Record<string, unknown> }> = [];
  let respond: (res: ServerResponse) => void;
  const fake = createServer((req, res) => {
    requests.push({ url: req.url ?? "", headers: req.headers });
    respond(res);
  });
  let fakeUrl: string;
  const database = { check: async () => "ok" as const };

  const send = (res: ServerResponse, status: number, payload: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  async function health(
    mode: InferenceMode,
    options: { timeoutMs?: number; headers?: Record<string, string>; mockHandler?: () => undefined } = {},
  ): Promise<{ status: number; text: string; body: Record<string, string> }> {
    const client = createInferenceClient(
      { url: fakeUrl, mode, timeoutMs: options.timeoutMs ?? 2000 },
      { logger: silentLogger, mockHandler: options.mockHandler },
    );
    const inference = createInferenceHealthProbe(client, silentLogger);
    const server = await startServer(createApp({ logger: silentLogger, database, inference }));
    try {
      const res = await fetch(`${server.baseUrl}/api/v1/health`, { headers: options.headers });
      const text = await res.text();
      return { status: res.status, text, body: JSON.parse(text) as Record<string, string> };
    } finally {
      await server.close();
    }
  }

  before(async () => {
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  });

  after(async () => {
    fake.closeAllConnections();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  });

  beforeEach(() => {
    requests = [];
  });

  it("reports ok when inference is ready and ok, forwarding the request ID", async () => {
    respond = (res) => send(res, 200, { ...body(true), engine_pool: { workers: 2 }, note: leaky });
    const res = await health("live", { headers: { "X-Request-Id": "health-req" } });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), ["status", "database", "inference", "authMode", "time"]);
    assert.equal(res.body.inference, "ok");
    assert.equal(res.body.status, "ok");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, "/v1/health");
    assert.equal(requests[0]!.headers["x-request-id"], "health-req");
    assert.doesNotMatch(res.text, /Traceback|postgresql|token|engine_pool|workers/);
  });

  it("reports degraded when inference is ready but degraded", async () => {
    respond = (res) => send(res, 200, body(true, "degraded"));
    const res = await health("live");
    assert.equal(res.status, 200);
    assert.equal(res.body.inference, "degraded");
    assert.equal(res.body.status, "degraded");
  });

  for (const [label, payload] of [
    ["a not-ready health body", { ...body(false), note: leaky }],
    ["a NOT_READY envelope", { error: { code: "NOT_READY", message: leaky, details: { trace: leaky } } }],
  ] as const) {
    it(`reports unavailable for an HTTP 503 with ${label}, exposing nothing from it`, async () => {
      respond = (res) => send(res, 503, payload);
      const res = await health("live");
      assert.equal(res.status, 200);
      assert.equal(res.body.inference, "unavailable");
      assert.equal(res.body.status, "degraded");
      assert.doesNotMatch(res.text, /Traceback|postgresql|token|NOT_READY|ready/);
    });
  }

  it("reports unavailable for an HTTP 500, exposing nothing from it", async () => {
    respond = (res) => send(res, 500, { error: { code: "INTERNAL_ERROR", message: leaky } });
    const res = await health("live");
    assert.equal(res.status, 200);
    assert.equal(res.body.inference, "unavailable");
    assert.doesNotMatch(res.text, /Traceback|INTERNAL_ERROR|INFERENCE_ERROR/);
  });

  it("uses INFERENCE_TIMEOUT_MS as the health timeout", async () => {
    respond = (res) => setTimeout(() => send(res, 200, body(true)), 600);
    const started = Date.now();
    const res = await health("live", { timeoutMs: 50 });
    assert.ok(Date.now() - started < 500, "health must not wait past the configured timeout");
    assert.equal(res.status, 200);
    assert.equal(res.body.inference, "unavailable");
    assert.equal(res.body.status, "degraded");
  });

  it("reports mock in mock mode with zero network calls, even with a mock handler", async () => {
    respond = (res) => send(res, 200, body(true));
    const res = await health("mock", { mockHandler: () => undefined });
    assert.equal(res.status, 200);
    assert.equal(res.body.inference, "mock");
    // §3.9: status is ok only when database and inference are both ok.
    assert.equal(res.body.status, "degraded");
    assert.equal(requests.length, 0);
  });
});
