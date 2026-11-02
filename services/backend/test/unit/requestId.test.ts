import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createApp } from "../../src/app.js";
import { captureLogger, startServer } from "../helpers/server.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const capture = captureLogger();
let server: Awaited<ReturnType<typeof startServer>>;

describe("X-Request-Id", () => {
  // Hooks sit inside describe: Node 20.6's test runner doesn't run file-level
  // before() hooks ahead of tests in a describe block.
  before(async () => {
    server = await startServer(createApp({ logger: capture.logger }));
  });
  after(() => server.close());

  it("echoes a supplied ID on a successful response", async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/health`, { headers: { "X-Request-Id": "client-req-123" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-request-id"), "client-req-123");
  });

  it("echoes a supplied ID in the header and the error body", async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/nope`, { headers: { "x-request-id": "b1946ac9-abc" } });
    assert.equal(res.headers.get("x-request-id"), "b1946ac9-abc");
    const body = (await res.json()) as { error: { requestId: string } };
    assert.equal(body.error.requestId, "b1946ac9-abc");
  });

  it("generates a UUID when none is supplied, and uses it in the body", async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/nope`);
    const id = res.headers.get("x-request-id") ?? "";
    assert.match(id, UUID);
    const body = (await res.json()) as { error: { requestId: string } };
    assert.equal(body.error.requestId, id);
  });

  it("generates a different ID for each request", async () => {
    const a = (await fetch(`${server.baseUrl}/api/v1/health`)).headers.get("x-request-id");
    const b = (await fetch(`${server.baseUrl}/api/v1/health`)).headers.get("x-request-id");
    assert.notEqual(a, b);
  });

  for (const blank of ["", "   "]) {
    it(`treats an empty header (${JSON.stringify(blank)}) as missing`, async () => {
      const res = await fetch(`${server.baseUrl}/api/v1/health`, { headers: { "X-Request-Id": blank } });
      assert.match(res.headers.get("x-request-id") ?? "", UUID);
    });
  }

  it("records the request ID in the request log", async () => {
    await fetch(`${server.baseUrl}/api/v1/health`, { headers: { "X-Request-Id": "logged-id-1" } });
    const entry = capture.entries().find((e) => e.requestId === "logged-id-1");
    assert.ok(entry, capture.lines.join("\n"));
    assert.equal(entry.msg, "request");
    assert.equal(entry.method, "GET");
    assert.equal(entry.path, "/api/v1/health");
    assert.equal(entry.status, 200);
  });
});
