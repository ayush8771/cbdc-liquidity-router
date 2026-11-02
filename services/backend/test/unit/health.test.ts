import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createApp } from "../../src/app.js";
import type { DatabaseStatus } from "../../src/db/health.js";
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
    // No inference client exists yet, so inference can't be "ok" or "mock".
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
