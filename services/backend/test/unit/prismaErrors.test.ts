import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Prisma } from "@prisma/client";
import express from "express";
import { describePrismaError, isPrismaError, prismaErrorCode } from "../../src/db/errors.js";
import { errorHandler } from "../../src/middleware/errors.js";
import { requestId } from "../../src/middleware/requestId.js";
import { captureLogger, startServer } from "../helpers/server.js";

// Real Prisma 6.19.3 error classes, carrying injected database details in
// their messages (and therefore in their stack headers).

const SECRETS = ["s3cret-pw", "db.internal", "cbdc_user", "postgresql://"];
const URL = "postgresql://cbdc_user:s3cret-pw@db.internal:5432/cbdc";
const V = "6.19.3";

const prismaErrors: Array<[string, () => Error, string | undefined]> = [
  ["initialization (P1000)", () => new Prisma.PrismaClientInitializationError(`Authentication failed against ${URL}`, V, "P1000"), "P1000"],
  ["initialization without a code", () => new Prisma.PrismaClientInitializationError(`Can't reach database server at db.internal:5432`, V), undefined],
  ["known request (P2002)", () => new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on ${URL}`, { code: "P2002", clientVersion: V, meta: { target: URL } }), "P2002"],
  ["unknown request", () => new Prisma.PrismaClientUnknownRequestError(`Raw query failed: ${URL}`, { clientVersion: V }), undefined],
  ["rust panic", () => new Prisma.PrismaClientRustPanicError(`panic while connecting to ${URL}`, V), undefined],
  ["validation", () => new Prisma.PrismaClientValidationError(`Invalid invocation using ${URL}`, { clientVersion: V }), undefined],
  // A multi-line message with a line shaped like a stack frame.
  ["multi-line message", () => new Prisma.PrismaClientUnknownRequestError(`first line\n    at ${URL}\n    at cbdc_user (db.internal:5432)`, { clientVersion: V }), undefined],
];

function assertNoSecrets(text: string, where: string): void {
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `${where} contains ${secret}:\n${text}`);
}

describe("Prisma error helpers", () => {
  it("recognises Prisma errors by class name only", () => {
    for (const [, make] of prismaErrors) assert.equal(isPrismaError(make()), true);
    assert.equal(isPrismaError(new Error("x")), false);
    assert.equal(isPrismaError(Object.assign(new Error("x"), { name: "PrismaClient" })), false);
    assert.equal(isPrismaError("PrismaClientKnownRequestError"), false);
  });

  it("reads a P#### code from errorCode or code, and nothing else", () => {
    assert.equal(prismaErrorCode({ errorCode: "P1001" }), "P1001");
    assert.equal(prismaErrorCode({ code: "P2002" }), "P2002");
    assert.equal(prismaErrorCode({ code: URL }), undefined);
    assert.equal(prismaErrorCode({ code: "ECONNREFUSED" }), undefined);
    assert.equal(prismaErrorCode(null), undefined);
  });

  for (const [name, make, code] of prismaErrors) {
    it(`describes a ${name} error with name, code and frames only`, () => {
      const error = make();
      const described = describePrismaError(error);
      assert.deepEqual(Object.keys(described).sort(), code === undefined ? ["frames", "name"] : ["code", "frames", "name"]);
      assert.equal(described.name, error.name);
      assert.equal(described.code, code);
      assert.ok(described.frames.length > 0, "frames from this test file are kept");
      assert.ok(described.frames.every((f) => f.startsWith("at ")));
      assertNoSecrets(JSON.stringify(described), "description");
    });
  }

  it("logs no frames if the stack header doesn't match the message", () => {
    const error = new Prisma.PrismaClientUnknownRequestError("original", { clientVersion: V });
    error.message = `changed to ${URL}`;
    error.stack = `PrismaClientUnknownRequestError: something else\n    at ${URL}`;
    assert.deepEqual(describePrismaError(error).frames, []);
  });
});

describe("error middleware with Prisma errors", () => {
  const capture = captureLogger();
  let server: Awaited<ReturnType<typeof startServer>>;

  before(async () => {
    const app = express();
    app.use(requestId);
    prismaErrors.forEach(([, make], i) => {
      app.get(`/sync/${i}`, () => {
        throw make();
      });
      app.get(`/async/${i}`, async () => {
        await Promise.resolve();
        throw make();
      });
    });
    app.get("/plain", () => {
      throw new Error("plain failure detail");
    });
    app.use(errorHandler(capture.logger));
    server = await startServer(app);
  });
  after(() => server.close());

  for (const mode of ["sync", "async"]) {
    prismaErrors.forEach(([name, make, code], i) => {
      it(`${mode} ${name}: generic 500 envelope, safe log`, async () => {
        const requestIdValue = `prisma-${mode}-${i}`;
        const res = await fetch(`${server.baseUrl}/${mode}/${i}`, { headers: { "X-Request-Id": requestIdValue } });
        assert.equal(res.status, 500);
        assert.equal(res.headers.get("x-request-id"), requestIdValue);
        const text = await res.text();
        assert.deepEqual(JSON.parse(text), {
          error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred.", details: {}, requestId: requestIdValue },
        });
        assertNoSecrets(text, "response");

        const entries = capture.entries().filter((e) => e.requestId === requestIdValue);
        assert.equal(entries.length, 1);
        const logged = entries[0]!.error as Record<string, unknown>;
        assert.equal(logged.name, make().name);
        assert.equal(logged.code, code);
        assert.equal(logged.message, undefined);
        assert.equal(logged.stack, undefined);
        assertNoSecrets(JSON.stringify(entries[0]), "log");
      });
    });
  }

  it("never writes any injected secret to any log line", () => {
    assert.ok(capture.lines.length >= prismaErrors.length * 2);
    const prismaLines = capture.lines.filter((l) => l.includes("PrismaClient"));
    assertNoSecrets(prismaLines.join("\n"), "logs");
  });

  it("keeps logging a non-Prisma error's message and stack, unchanged", async () => {
    const res = await fetch(`${server.baseUrl}/plain`, { headers: { "X-Request-Id": "plain-1" } });
    assert.equal(res.status, 500);
    const entry = capture.entries().find((e) => e.requestId === "plain-1");
    const logged = entry?.error as Record<string, unknown>;
    assert.equal(logged.name, "Error");
    assert.equal(logged.message, "plain failure detail");
    assert.match(String(logged.stack), /^Error: plain failure detail\n\s+at /);
  });
});
