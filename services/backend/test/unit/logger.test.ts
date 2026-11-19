import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import express from "express";
import { createApp } from "../../src/app.js";
import { createLogger, REDACTED, redact, type LogLevel } from "../../src/logger.js";
import { errorHandler } from "../../src/middleware/errors.js";
import { requestId } from "../../src/middleware/requestId.js";
import { requestLogger } from "../../src/middleware/requestLogger.js";
import { newToken, sha256Hex } from "../helpers/devTokens.js";
import { captureLogger, startServer } from "../helpers/server.js";

describe("logger", () => {
  it("writes one JSON line with time, level, message and fields", () => {
    const written: Array<[string, LogLevel]> = [];
    createLogger((line, level) => written.push([line, level])).warn("hello", { a: 1 });
    assert.equal(written.length, 1);
    const [line, level] = written[0]!;
    assert.equal(level, "warn");
    const entry = JSON.parse(line) as Record<string, unknown>;
    assert.equal(entry.level, "warn");
    assert.equal(entry.msg, "hello");
    assert.equal(entry.a, 1);
    assert.equal(new Date(entry.time as string).toISOString(), entry.time);
  });

  it("passes the level to the writer for info and error", () => {
    const levels: LogLevel[] = [];
    const logger = createLogger((_line, level) => levels.push(level));
    logger.info("i");
    logger.error("e");
    assert.deepEqual(levels, ["info", "error"]);
  });
});

describe("redaction", () => {
  const token = newToken();
  const hash = sha256Hex(token);

  it("redacts Authorization in any letter case, at any depth", () => {
    const input = {
      Authorization: `Bearer ${token}`,
      headers: { authorization: `Bearer ${token}`, "x-request-id": "r1" },
      list: [{ AUTHORIZATION: token }],
    };
    assert.deepEqual(redact(input), {
      Authorization: REDACTED,
      headers: { authorization: REDACTED, "x-request-id": "r1" },
      list: [{ AUTHORIZATION: REDACTED }],
    });
  });

  it("redacts token and tokenSha256 fields", () => {
    assert.deepEqual(redact({ token, tokenSha256: hash, userId: "u-1" }), {
      token: REDACTED,
      tokenSha256: REDACTED,
      userId: "u-1",
    });
  });

  it("does not modify the input object", () => {
    const input = { headers: { authorization: "Bearer x" } };
    redact(input);
    assert.equal(input.headers.authorization, "Bearer x");
  });

  it("handles circular references", () => {
    const input: Record<string, unknown> = { authorization: "x" };
    input.self = input;
    assert.deepEqual(redact(input), { authorization: REDACTED, self: "[Circular]" });
  });

  it("keeps secrets out of written log lines", () => {
    const capture = captureLogger();
    capture.logger.info("incoming", { headers: { Authorization: `Bearer ${token}` }, user: { tokenSha256: hash } });
    const output = capture.lines.join("\n");
    assert.ok(!output.includes(token));
    assert.ok(!output.includes(hash));
    assert.ok(output.includes(REDACTED));
  });
});

describe("request logging never records Authorization", () => {
  const token = newToken();
  const capture = captureLogger();
  let real: Awaited<ReturnType<typeof startServer>>;
  let failing: Awaited<ReturnType<typeof startServer>>;

  before(async () => {
    real = await startServer(createApp({ logger: capture.logger }));
    // An app whose route logs the request headers and then fails, to cover the
    // redaction and the unhandled-error path together.
    const app = express();
    app.use(requestId);
    app.use(requestLogger(capture.logger));
    app.get("/fail", (req) => {
      capture.logger.info("headers", { headers: req.headers });
      throw new Error("failure");
    });
    app.use(errorHandler(capture.logger));
    failing = await startServer(app);
  });
  after(async () => {
    await real.close();
    await failing.close();
  });

  it("omits the token from every log line", async () => {
    const headers = { Authorization: `Bearer ${token}` };
    await fetch(`${real.baseUrl}/api/v1/health`, { headers });
    await fetch(`${real.baseUrl}/api/v1/unknown?token=${token}`, { headers });
    await fetch(`${failing.baseUrl}/fail`, { headers });

    const output = capture.lines.join("\n");
    assert.ok(capture.lines.length >= 4, output);
    assert.ok(!output.includes(token), `token leaked:\n${output}`);
    assert.ok(!output.includes("Bearer"), `Authorization leaked:\n${output}`);
    const headerEntry = capture.entries().find((e) => e.msg === "headers");
    assert.equal((headerEntry?.headers as Record<string, unknown>).authorization, REDACTED);
  });

  it("logs the path without its query string", () => {
    const entry = capture.entries().find((e) => e.msg === "request" && e.status === 404);
    assert.equal(entry?.path, "/api/v1/unknown");
  });
});
