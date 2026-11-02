import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createDatabaseProbe, type PingClient } from "../../src/db/health.js";
import { attachPrismaLogging, disconnectPrismaClient, getPrismaClient } from "../../src/db/prisma.js";
import { captureLogger, silentLogger } from "../helpers/server.js";

// No test here needs a database: the probe gets fake clients, and a
// PrismaClient doesn't connect until its first query.

const SECRET_URL = "postgresql://cbdc:s3cret-pw@db.internal:5432/cbdc";

function pingClient(behaviour: () => Promise<unknown>): PingClient & { calls: number } {
  const client = {
    calls: 0,
    $queryRaw(query: TemplateStringsArray) {
      client.calls++;
      assert.equal(query.join("?"), "SELECT 1");
      return behaviour();
    },
  };
  return client;
}

function prismaError(errorCode: string, message: string): Error {
  return Object.assign(new Error(message), { name: "PrismaClientInitializationError", errorCode });
}

describe("database probe", () => {
  it("reports ok when SELECT 1 succeeds", async () => {
    const client = pingClient(async () => [{ "?column?": 1 }]);
    assert.equal(await createDatabaseProbe(client, silentLogger).check(), "ok");
    assert.equal(client.calls, 1);
  });

  it("reports unavailable, without a client, when DATABASE_URL isn't set", async () => {
    const capture = captureLogger();
    assert.equal(await createDatabaseProbe(undefined, capture.logger).check(), "unavailable");
    assert.deepEqual(
      capture.entries().map(({ level, msg, database, reason }) => ({ level, msg, database, reason })),
      [{ level: "warn", msg: "database status", database: "unavailable", reason: "not_configured" }],
    );
  });

  it("reports unavailable on a connection error, logging only the Prisma error code", async () => {
    const capture = captureLogger();
    const client = pingClient(async () => {
      throw prismaError("P1000", `Authentication failed for ${SECRET_URL}, user cbdc`);
    });
    assert.equal(await createDatabaseProbe(client, capture.logger).check(), "unavailable");
    const output = capture.lines.join("\n");
    assert.equal(capture.entries()[0]?.reason, "P1000");
    for (const secret of ["s3cret-pw", "db.internal", SECRET_URL, "Authentication failed", "cbdc"]) {
      assert.ok(!output.includes(secret), `logged ${secret}`);
    }
  });

  it("uses a request error's code, and 'error' for anything without a Prisma code", async () => {
    const coded = pingClient(async () => {
      throw Object.assign(new Error("x"), { code: "P2010" });
    });
    const capture = captureLogger();
    await createDatabaseProbe(coded, capture.logger).check();
    assert.equal(capture.entries()[0]?.reason, "P2010");

    for (const thrown of [new Error(SECRET_URL), Object.assign(new Error("y"), { code: SECRET_URL }), SECRET_URL]) {
      const other = captureLogger();
      await createDatabaseProbe(pingClient(async () => Promise.reject(thrown)), other.logger).check();
      assert.equal(other.entries()[0]?.reason, "error");
      assert.ok(!other.lines.join("\n").includes("s3cret-pw"));
    }
  });

  it("falls back to the Prisma error class name when there is no code", async () => {
    const capture = captureLogger();
    const refused = pingClient(async () => {
      throw Object.assign(new Error(`Can't reach ${SECRET_URL}`), {
        name: "PrismaClientInitializationError",
        errorCode: undefined,
      });
    });
    await createDatabaseProbe(refused, capture.logger).check();
    assert.equal(capture.entries()[0]?.reason, "PrismaClientInitializationError");
    assert.ok(!capture.lines.join("\n").includes("s3cret-pw"));

    const odd = captureLogger();
    await createDatabaseProbe(pingClient(async () => {
      throw Object.assign(new Error("z"), { name: SECRET_URL });
    }), odd.logger).check();
    assert.equal(odd.entries()[0]?.reason, "error", "an arbitrary name is not logged");
  });

  it("reports unavailable when the query exceeds the timeout", async () => {
    const capture = captureLogger();
    const hanging = pingClient(() => new Promise(() => {}));
    const started = Date.now();
    assert.equal(await createDatabaseProbe(hanging, capture.logger, 50).check(), "unavailable");
    assert.ok(Date.now() - started < 2000);
    assert.equal(capture.entries()[0]?.reason, "timeout");
  });

  it("runs at most one query at a time, even after timeouts", async () => {
    let release!: () => void;
    let released = false;
    // The first query hangs until released; later queries answer at once.
    const slow = pingClient(() =>
      released ? Promise.resolve([]) : new Promise<void>((resolve) => (release = () => ((released = true), resolve()))),
    );
    const probe = createDatabaseProbe(slow, silentLogger, 20);

    // Sequential checks after timeouts, and concurrent ones, reuse the query.
    assert.equal(await probe.check(), "unavailable");
    assert.equal(await probe.check(), "unavailable");
    const concurrent = await Promise.all([probe.check(), probe.check(), probe.check()]);
    assert.deepEqual(concurrent, ["unavailable", "unavailable", "unavailable"]);
    assert.equal(slow.calls, 1, "only one SELECT 1 was started");

    // Once it settles, the next check starts a new query.
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await probe.check(), "ok");
    assert.equal(slow.calls, 2);
  });

  it("a check waiting on the in-flight query gets its result", async () => {
    let release!: () => void;
    const slow = pingClient(() => new Promise<void>((resolve) => (release = resolve)));
    const probe = createDatabaseProbe(slow, silentLogger, 1000);
    const first = probe.check();
    const second = probe.check();
    release();
    assert.deepEqual(await Promise.all([first, second]), ["ok", "ok"]);
    assert.equal(slow.calls, 1);
  });

  it("a timed-out query that later fails causes no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let fail!: (error: Error) => void;
      const slow = pingClient(() => new Promise((_resolve, reject) => (fail = reject)));
      const probe = createDatabaseProbe(slow, silentLogger, 10);
      assert.equal(await probe.check(), "unavailable");
      fail(prismaError("P1001", `late failure for ${SECRET_URL}`));
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(unhandled, []);
      // The failed query is cleared, so the next check starts a new one.
      await probe.check();
      assert.equal(slow.calls, 2);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("logs only when the status changes", async () => {
    const capture = captureLogger();
    let up = false;
    const client = pingClient(async () => {
      if (!up) throw prismaError("P1001", "unreachable");
      return [];
    });
    const probe = createDatabaseProbe(client, capture.logger);
    await probe.check();
    await probe.check();
    up = true;
    await probe.check();
    await probe.check();
    assert.deepEqual(
      capture.entries().map(({ level, database, reason }) => [level, database, reason]),
      [
        ["warn", "unavailable", "P1001"],
        ["info", "ok", undefined],
      ],
    );
  });
});

describe("PrismaClient module", () => {
  afterEach(() => disconnectPrismaClient());

  it("creates one client and returns the same instance afterwards", () => {
    const first = getPrismaClient(SECRET_URL, silentLogger);
    assert.equal(getPrismaClient(SECRET_URL, silentLogger), first);
  });

  it("refuses a second client for a different URL", () => {
    getPrismaClient(SECRET_URL, silentLogger);
    assert.throws(
      () => getPrismaClient("postgresql://other@localhost:5432/other", silentLogger),
      (error: Error) => error.message === "PrismaClient already exists for a different DATABASE_URL",
    );
  });

  it("creates a new client after disconnecting", async () => {
    const first = getPrismaClient(SECRET_URL, silentLogger);
    await disconnectPrismaClient();
    assert.notEqual(getPrismaClient(SECRET_URL, silentLogger), first);
  });

  it("disconnecting without a client does nothing", async () => {
    await disconnectPrismaClient();
    await assert.doesNotReject(disconnectPrismaClient());
  });
});

describe("Prisma event logging", () => {
  it("logs warnings and errors without Prisma's message text", () => {
    const handlers = new Map<string, (event: unknown) => void>();
    const capture = captureLogger();
    attachPrismaLogging({ $on: (event, callback) => void handlers.set(event, callback) }, capture.logger);

    handlers.get("warn")!({ message: `warning about ${SECRET_URL}`, target: "x" });
    handlers.get("error")!({ message: `error about ${SECRET_URL}`, target: "x" });

    assert.deepEqual(
      capture.entries().map(({ level, msg }) => [level, msg]),
      [
        ["warn", "database client warning"],
        ["error", "database client error"],
      ],
    );
    assert.ok(!capture.lines.join("\n").includes("s3cret-pw"));
  });
});
