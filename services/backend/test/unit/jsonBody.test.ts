import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { gzipSync } from "node:zlib";
import { after, before, describe, it } from "node:test";
import express from "express";
import { jsonBody } from "../../src/middleware/jsonBody.js";
import { errorHandler } from "../../src/middleware/errors.js";
import { requestId } from "../../src/middleware/requestId.js";
import { silentLogger, startServer } from "../helpers/server.js";

// A minimal app: POST /echo parses the body with jsonBody() and echoes it.
let server: { baseUrl: string; close: () => Promise<void> };

/** Sends raw bytes with exactly the given headers (fetch would add its own Content-Type). */
function send(
  body: string | Buffer | undefined,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
  const url = new URL(`${server.baseUrl}/echo`);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "X-Request-Id": "body-req", ...headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const json = (body: string | Buffer, extra: Record<string, string> = {}) =>
  send(body, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)), ...extra });

function malformed(res: { status: number; text: string }, message: string): void {
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.text), {
    error: { code: "MALFORMED_REQUEST", message, details: {}, requestId: "body-req" },
  });
}

describe("jsonBody middleware", () => {
  before(async () => {
    const app = express();
    app.use(requestId);
    app.post("/echo", jsonBody(), (req, res) => {
      res.json({ received: req.body as unknown });
    });
    app.use(errorHandler(silentLogger));
    server = await startServer(app);
  });

  after(async () => {
    await server.close();
  });

  it("parses a JSON object", async () => {
    const res = await json('{"amountUsd": 300000.0, "nested": {"a": [1, 2]}}');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.text), { received: { amountUsd: 300000, nested: { a: [1, 2] } } });
  });

  it("accepts a charset=utf-8 parameter and upper-case type", async () => {
    assert.equal((await json("{}", { "Content-Type": "application/json; charset=utf-8" })).status, 200);
    assert.equal((await json("{}", { "Content-Type": "Application/JSON" })).status, 200);
  });

  it("passes a top-level array on (the validator rejects it)", async () => {
    const res = await json("[1, 2]");
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.text), { received: [1, 2] });
  });

  it("keeps a __proto__ key as data without changing prototypes", async () => {
    const res = await json('{"__proto__": {"polluted": true}}');
    assert.equal(res.status, 200);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  for (const [label, body] of [
    ["truncated JSON", '{"amountUsd": '],
    ["a trailing comma", '{"a": 1,}'],
    ["single quotes", "{'a': 1}"],
    ["NaN", '{"a": NaN}'],
    ["a top-level number (strict mode)", "1"],
    ["a top-level string (strict mode)", '"text"'],
    ["a top-level null (strict mode)", "null"],
    ["only whitespace", "   "],
  ] as const) {
    it(`returns 400 MALFORMED_REQUEST for ${label}, without the parser's message`, async () => {
      const res = await json(body);
      malformed(res, "The request body is not valid JSON.");
      assert.doesNotMatch(res.text, /Unexpected|SyntaxError|position/);
    });
  }

  for (const [label, headers, body] of [
    ["no Content-Type", { "Content-Length": "2" }, "{}"],
    ["text/plain", { "Content-Type": "text/plain", "Content-Length": "2" }, "{}"],
    ["form encoding", { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": "3" }, "a=1"],
    ["application/problem+json", { "Content-Type": "application/problem+json", "Content-Length": "2" }, "{}"],
  ] as const) {
    it(`returns 400 MALFORMED_REQUEST for ${label}`, async () => {
      malformed(await send(body, headers), "The request body must be JSON sent as application/json.");
    });
  }

  it("returns 400 MALFORMED_REQUEST for an empty application/json body", async () => {
    malformed(await json(""), "The request body is not valid JSON.");
    malformed(await send("", { "Content-Type": "application/json", "Transfer-Encoding": "chunked" }), "The request body is not valid JSON.");
  });

  it("accepts a body at the 100kb limit and rejects one byte more", async () => {
    const wrap = (n: number) => `{"p":"${"x".repeat(n)}"}`;
    const limit = 100 * 1024;
    const atLimit = wrap(limit - wrap(0).length);
    assert.equal(Buffer.byteLength(atLimit), limit);
    assert.equal((await json(atLimit)).status, 200);
    malformed(await json(wrap(limit - wrap(0).length + 1)), "The request body is larger than 100kb.");
  });

  it("rejects a body over the limit sent without Content-Length (chunked)", async () => {
    const big = `{"p":"${"x".repeat(200 * 1024)}"}`;
    malformed(await send(big, { "Content-Type": "application/json", "Transfer-Encoding": "chunked" }), "The request body is larger than 100kb.");
  });

  it("rejects a charset other than UTF-8", async () => {
    malformed(await json("{}", { "Content-Type": "application/json; charset=latin1" }), "The request body must be UTF-8 JSON.");
  });

  it("rejects an unsupported content encoding, and accepts gzip", async () => {
    malformed(await json("{}", { "Content-Encoding": "x-custom" }), "The request body uses an unsupported content encoding.");
    const gz = gzipSync('{"a":1}');
    const res = await send(gz, { "Content-Type": "application/json", "Content-Encoding": "gzip", "Content-Length": String(gz.length) });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.text), { received: { a: 1 } });
  });
});
