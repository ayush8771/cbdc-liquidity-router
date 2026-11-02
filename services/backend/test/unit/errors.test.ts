import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import express from "express";
import { createApp } from "../../src/app.js";
import { ApiError, errorHandler, notFound } from "../../src/middleware/errors.js";
import { requestId } from "../../src/middleware/requestId.js";
import { captureLogger, startServer } from "../helpers/server.js";

type Envelope = { error: { code: string; message: string; details: Record<string, unknown>; requestId: string } };

const SECRET = "db-password-and-internal-detail";

async function json(res: Response): Promise<Envelope> {
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  return (await res.json()) as Envelope;
}

function assertEnvelope(body: Envelope): void {
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.deepEqual(Object.keys(body.error), ["code", "message", "details", "requestId"]);
}

describe("404 JSON responses (real app)", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  before(async () => {
    server = await startServer(createApp({ logger: captureLogger().logger }));
  });
  after(() => server.close());

  for (const [method, path] of [
    ["GET", "/api/v1/does-not-exist"],
    ["POST", "/api/v1/transactions"],
    ["DELETE", "/api/v1/health"],
    ["GET", "/"],
  ] as const) {
    it(`${method} ${path} returns the NOT_FOUND envelope`, async () => {
      const res = await fetch(`${server.baseUrl}${path}`, { method, headers: { "X-Request-Id": "nf-1" } });
      assert.equal(res.status, 404);
      const body = await json(res);
      assertEnvelope(body);
      assert.deepEqual(body.error, { code: "NOT_FOUND", message: "Unknown resource.", details: {}, requestId: "nf-1" });
    });
  }
});

describe("thrown errors", () => {
  const capture = captureLogger();
  let server: Awaited<ReturnType<typeof startServer>>;

  before(async () => {
    // A test app with the real middleware and routes that fail on purpose.
    const app = express();
    app.use(requestId);
    app.get("/sync", () => {
      throw new Error(`boom: ${SECRET}`);
    });
    app.get("/async", async () => {
      await Promise.resolve();
      throw new Error(`async boom: ${SECRET}`);
    });
    app.get("/non-error", () => {
      throw SECRET;
    });
    app.get("/api-error", () => {
      throw new ApiError(422, "VALIDATION_ERROR", "amountUsd must be > 0.", { errors: [{ field: "amountUsd" }] });
    });
    app.get("/after-headers", (_req, res) => {
      res.write("partial");
      throw new Error(`too late: ${SECRET}`);
    });
    app.use(notFound);
    app.use(errorHandler(capture.logger));
    server = await startServer(app);
  });
  after(() => server.close());

  for (const path of ["/sync", "/async", "/non-error"]) {
    it(`${path}: returns 500 INTERNAL_ERROR with no internal details`, async () => {
      const res = await fetch(`${server.baseUrl}${path}`, { headers: { "X-Request-Id": `err${path}` } });
      assert.equal(res.status, 500);
      const raw = await res.clone().text();
      const body = await json(res);
      assertEnvelope(body);
      assert.deepEqual(body.error, {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred.",
        details: {},
        requestId: `err${path}`,
      });
      assert.ok(!raw.includes(SECRET), "internal message leaked");
      assert.ok(!raw.includes("boom"), "internal message leaked");
      assert.ok(!/\bat .+:\d+:\d+/.test(raw), "stack trace leaked");
    });
  }

  it("logs the unexpected error server-side with its request ID", () => {
    const entry = capture.entries().find((e) => e.requestId === "err/sync");
    assert.ok(entry);
    assert.equal(entry.level, "error");
    assert.equal(entry.msg, "unhandled error");
    assert.match(JSON.stringify(entry.error), /boom/);
  });

  it("returns an ApiError's own status, code, message and details", async () => {
    const res = await fetch(`${server.baseUrl}/api-error`, { headers: { "X-Request-Id": "api-1" } });
    assert.equal(res.status, 422);
    const body = await json(res);
    assertEnvelope(body);
    assert.deepEqual(body.error, {
      code: "VALIDATION_ERROR",
      message: "amountUsd must be > 0.",
      details: { errors: [{ field: "amountUsd" }] },
      requestId: "api-1",
    });
    assert.ok(!capture.entries().some((e) => e.requestId === "api-1"), "expected errors are not logged as unhandled");
  });

  it("closes the connection after a late error, without leaking it to logs or output", async () => {
    // Capture console output while the request runs. Express's default error
    // handler prints the stack with console.error. process.stdout itself is
    // left alone, because the test runner reports results through it.
    const printed: string[] = [];
    const originals = { error: console.error, warn: console.warn, log: console.log };
    const record = (...args: unknown[]) => void printed.push(args.map(String).join(" "));
    console.error = record;
    console.warn = record;
    console.log = record;

    let bodyCompleted = true;
    try {
      const res = await fetch(`${server.baseUrl}/after-headers`, { headers: { "X-Request-Id": "late-1" } });
      assert.equal(res.status, 200, "headers were already sent");
      await res.text();
    } catch {
      bodyCompleted = false;
    } finally {
      console.error = originals.error;
      console.warn = originals.warn;
      console.log = originals.log;
    }

    assert.equal(bodyCompleted, false, "the response should be cut off, not completed");
    const output = printed.join("\n");
    assert.ok(!output.includes(SECRET), `secret printed:\n${output}`);
    assert.ok(!output.includes("too late"), `raw error printed:\n${output}`);

    const late = capture.entries().filter((e) => e.requestId === "late-1");
    assert.deepEqual(late.map((e) => [e.level, e.msg]), [["error", "error after response started; connection closed"]]);
    assert.deepEqual(Object.keys(late[0]!).sort(), ["level", "msg", "requestId", "time"]);
    assert.ok(!capture.lines.join("\n").includes("too late"), "raw late error logged");
  });
});
