import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createApp } from "../../src/app.js";
import type { DatabaseProbe, DatabaseStatus } from "../../src/db/health.js";
import type { InferenceHealthProbe, InferenceStatus } from "../../src/inferenceClient/health.js";
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

  it("returns 200 with status degraded when the database is unavailable", async () => {
    databaseStatus = "unavailable";
    const res = await fetch(`${baseUrl}/api/v1/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, string>;
    assert.equal(body.status, "degraded");
    assert.equal(body.database, "unavailable");
    assert.equal(body.inference, "unavailable");
    databaseStatus = "ok";
  });

  it("reports the database as unavailable when the app has no database", async () => {
    const plain = await startServer(createApp({ logger: silentLogger }));
    try {
      const body = (await (await fetch(`${plain.baseUrl}/api/v1/health`)).json()) as Record<string, string>;
      assert.equal(body.status, "degraded");
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

  for (const db of databaseStatuses) {
    for (const inf of inferenceStatuses) {
      const expected = db === "ok" && inf === "ok" ? "ok" : "degraded";
      it(`database ${db} + inference ${inf} -> HTTP 200, status ${expected}`, async () => {
        const { res, body } = await health({ check: async () => db }, { check: async () => inf });
        assert.equal(res.status, 200);
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
