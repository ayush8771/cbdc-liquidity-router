import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createApp } from "../../src/app.js";
import type { DatabaseProbe, DatabaseStatus } from "../../src/db/health.js";
import type { InferenceHealthProbe, InferenceStatus } from "../../src/inferenceClient/health.js";
import { readiness } from "../../src/routes/health.js";
import { silentLogger, startServer } from "../helpers/server.js";

let server: Server;
let baseUrl: string;
// A fake database probe whose answer each test can set.
let databaseStatus: DatabaseStatus = "ok";
const database = { check: async () => databaseStatus };

describe("GET /api/v1/health", () => {
  // Hooks sit inside describe: Node 20.6's test runner doesn't run file-level
  // before() hooks ahead of tests in a describe block.
  before(async () => {
    server = await new Promise<Server>((resolve) => {
      const s = createApp({ logger: silentLogger, database }).listen(0, "127.0.0.1", () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns every §3.9 field; degraded while inference is unavailable", async () => {
    databaseStatus = "ok";
    const res = await fetch(`${baseUrl}/api/v1/health`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);

    const body = (await res.json()) as Record<string, string>;
    assert.deepEqual(Object.keys(body), ["status", "database", "inference", "authMode", "time"]);
    // This app has no inference probe, so inference is "unavailable".
    assert.equal(body.inference, "unavailable");
    assert.equal(body.status, "degraded");
    assert.equal(body.database, "ok");
    assert.equal(body.authMode, "dev");
    assert.equal(new Date(body.time!).toISOString(), body.time);
  });

  it("returns HTTP 503 with status unavailable and the Health body when the database is unavailable (§3.9)", async () => {
    databaseStatus = "unavailable";
    const res = await fetch(`${baseUrl}/api/v1/health`);
    assert.equal(res.status, 503);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    const body = (await res.json()) as Record<string, string>;
    // The Health object, not the §4 error envelope.
    assert.deepEqual(Object.keys(body), ["status", "database", "inference", "authMode", "time"]);
    assert.equal(body.status, "unavailable");
    assert.equal(body.database, "unavailable");
    assert.equal(body.inference, "unavailable");
    databaseStatus = "ok";
  });

  it("reports the database as unavailable, with HTTP 503, when the app has no database", async () => {
    const plain = await startServer(createApp({ logger: silentLogger }));
    try {
      const res = await fetch(`${plain.baseUrl}/api/v1/health`);
      assert.equal(res.status, 503);
      const body = (await res.json()) as Record<string, string>;
      assert.equal(body.status, "unavailable");
      assert.equal(body.database, "unavailable");
    } finally {
      await plain.close();
    }
  });

  it("does not expose the X-Powered-By header", async () => {
    const res = await fetch(`${baseUrl}/api/v1/health`);
    assert.equal(res.headers.get("x-powered-by"), null);
  });

  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`${baseUrl}/api/v1/does-not-exist`);
    assert.equal(res.status, 404);
  });
});

describe("readiness (§3.9)", () => {
  it("is ok only with the database ok and inference ok or mock", () => {
    assert.deepEqual(readiness("ok", "mock"), { httpStatus: 200, status: "ok" });
    assert.deepEqual(readiness("ok", "ok"), { httpStatus: 200, status: "ok" });
    assert.deepEqual(readiness("ok", "degraded"), { httpStatus: 200, status: "degraded" });
    assert.deepEqual(readiness("unavailable", "mock"), { httpStatus: 503, status: "unavailable" });
  });
});

describe("GET /api/v1/health with an inference probe", () => {
  const databaseStatuses: DatabaseStatus[] = ["ok", "unavailable"];
  const inferenceStatuses: InferenceStatus[] = ["ok", "degraded", "unavailable", "mock"];

  async function health(database: DatabaseProbe, inference: InferenceHealthProbe, headers: Record<string, string> = {}) {
    const server = await startServer(createApp({ logger: silentLogger, database, inference }));
    try {
      const res = await fetch(`${server.baseUrl}/api/v1/health`, { headers });
      return { res, body: (await res.json()) as Record<string, string> };
    } finally {
      await server.close();
    }
  }

  // The §3.9 table, all eight combinations.
  const EXPECTED: Record<DatabaseStatus, Record<InferenceStatus, [number, string]>> = {
    ok: { ok: [200, "ok"], mock: [200, "ok"], degraded: [200, "degraded"], unavailable: [200, "degraded"] },
    unavailable: {
      ok: [503, "unavailable"],
      mock: [503, "unavailable"],
      degraded: [503, "unavailable"],
      unavailable: [503, "unavailable"],
    },
  };
  for (const db of databaseStatuses) {
    for (const inf of inferenceStatuses) {
      const [httpStatus, expected] = EXPECTED[db][inf];
      it(`database ${db} + inference ${inf} -> HTTP ${httpStatus}, status ${expected}`, async () => {
        const { res, body } = await health({ check: async () => db }, { check: async () => inf });
        assert.equal(res.status, httpStatus);
        assert.deepEqual(Object.keys(body), ["status", "database", "inference", "authMode", "time"]);
        assert.equal(body.status, expected);
        assert.equal(body.database, db);
        assert.equal(body.inference, inf);
        assert.equal(body.authMode, "dev");
      });
    }
  }

  it("is public, and passes the request ID to the inference probe", async () => {
    const seen: Array<string | undefined> = [];
    const inference = { check: async (requestId?: string) => (seen.push(requestId), "ok" as const) };
    const { res } = await health({ check: async () => "ok" }, inference, { "X-Request-Id": "probe-id" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-request-id"), "probe-id");
    assert.deepEqual(seen, ["probe-id"]);
  });

  it("runs the database and inference checks in parallel", async () => {
    const delay = 300;
    const slow = <T>(value: T) => async () => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return value;
    };
    const started = Date.now();
    const { body } = await health({ check: slow("ok" as const) }, { check: slow("ok" as const) });
    const elapsed = Date.now() - started;
    assert.equal(body.status, "ok");
    assert.ok(elapsed >= delay - 20, `took ${elapsed} ms`);
    assert.ok(elapsed < delay * 2 - 50, `took ${elapsed} ms; the checks ran one after the other`);
  });
});
