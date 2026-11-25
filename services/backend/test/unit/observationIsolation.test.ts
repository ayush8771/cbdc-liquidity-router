import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { API_ROUTES, createApp } from "../../src/app.js";
import { ConfigError, loadConfig } from "../../src/config/config.js";
import type { DevUser } from "../../src/config/devTokens.js";
import { createInferenceClient, type InferenceRequest, type JsonObject } from "../../src/inferenceClient/client.js";
import { createShutdown } from "../../src/lifecycle.js";
import { createObservationService } from "../../src/observations/service.js";
import { makeTempDir, newToken, sha256Hex, validTokenFile } from "../helpers/devTokens.js";
import { captureLogger, silentLogger, startServer } from "../helpers/server.js";
import { eventAt, latestBody, openStream, sendJson, startFakeIngestion, waitFor } from "../helpers/observations.js";

// AD-6 boundary checks for the D-24 observation module (B-3 / T-4, T-2, and
// the T-1 idea at the Express level), feature-off backward compatibility, and
// the additive config and lifecycle hooks.

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const STREAM_PATH = "/api/rt/v1/observations/stream";

// ---------------------------------------------------------------- B-3 / T-4

/** Directories under src/ that are routing, mapper, inference-client or database code. */
const ENGINE_SIDE = ["inferenceClient", "mappers", "db", "routes", "validation"];
/** The only files allowed to compose both sides (AD-1 §1). */
const COMPOSERS = ["app.ts", "server.ts"];

function importsOf(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) specs.push((m[1] ?? m[2] ?? m[3])!);
  return specs;
}

/** Resolves a relative specifier to a path under src/, e.g. "observations/store.ts". */
function resolveSpec(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const abs = path.resolve(path.dirname(path.join(SRC, fromFile)), spec);
  return path.relative(SRC, abs).split(path.sep).join("/").replace(/\.js$/, ".ts");
}

/** Boundary violations in one file's source. Exported for the deliberate-violation test. */
function violations(file: string, source: string): string[] {
  const out: string[] = [];
  const inObservations = file.startsWith("observations/");
  for (const spec of importsOf(source)) {
    const target = resolveSpec(file, spec);
    if (inObservations) {
      if (target === undefined) {
        // Only Node built-ins and express types are allowed from packages.
        if (!spec.startsWith("node:") && spec !== "express") out.push(`${file} -> ${spec}`);
        continue;
      }
      if (ENGINE_SIDE.some((dir) => target.startsWith(`${dir}/`))) out.push(`${file} -> ${target}`);
      if (target.startsWith("config/")) out.push(`${file} -> ${target}`);
    } else if (target?.startsWith("observations/") && !COMPOSERS.includes(file)) {
      out.push(`${file} -> ${target}`);
    }
  }
  return out;
}

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.split(path.sep).join("/"));
}

describe("AD-6 B-3 import boundary (T-4)", () => {
  it("observation modules import no routing, mapper, inference, database or config code, and nothing else imports them", () => {
    const found = sourceFiles().flatMap((file) => violations(file, readFileSync(path.join(SRC, file), "utf8")));
    assert.deepEqual(found, []);
  });

  it("the scan covers every observation module and resolves every relative import to a real file", () => {
    const files = sourceFiles().filter((f) => f.startsWith("observations/")).sort();
    assert.deepEqual(files, [
      "observations/canonical.ts",
      "observations/constants.ts",
      "observations/envelope.ts",
      "observations/freshness.ts",
      "observations/latestResponse.ts",
      "observations/poller.ts",
      "observations/route.ts",
      "observations/service.ts",
      "observations/store.ts",
      "observations/streamHub.ts",
    ]);
    const all = new Set(sourceFiles());
    for (const f of files) {
      for (const spec of importsOf(readFileSync(path.join(SRC, f), "utf8"))) {
        const target = resolveSpec(f, spec);
        if (target !== undefined) assert.ok(all.has(target), `${f}: unresolved ${spec}`);
      }
    }
    // The scanner really parses imports: route.ts's known imports are found.
    const routeImports = importsOf(readFileSync(path.join(SRC, "observations/route.ts"), "utf8"));
    assert.ok(routeImports.includes("../auth/devAuth.js"));
    assert.ok(routeImports.includes("./streamHub.js"));
    // And app.ts, a composer, does import the module.
    assert.ok(importsOf(readFileSync(path.join(SRC, "app.ts"), "utf8")).includes("./observations/route.js"));
  });

  it("detects a deliberate violation in each direction", () => {
    assert.deepEqual(violations("observations/store.ts", 'import { x } from "../inferenceClient/client.js";'), [
      "observations/store.ts -> inferenceClient/client.ts",
    ]);
    assert.deepEqual(violations("observations/store.ts", 'import type { X } from "../mappers/routeRequest.js";'), [
      "observations/store.ts -> mappers/routeRequest.ts",
    ]);
    assert.deepEqual(violations("observations/store.ts", 'const m = await import("../db/prisma.js");'), [
      "observations/store.ts -> db/prisma.ts",
    ]);
    assert.deepEqual(violations("observations/x.ts", 'import { PrismaClient } from "@prisma/client";'), [
      "observations/x.ts -> @prisma/client",
    ]);
    assert.deepEqual(violations("routes/transactions.ts", 'import { PAIRS } from "../observations/constants.js";'), [
      "routes/transactions.ts -> observations/constants.ts",
    ]);
    assert.deepEqual(violations("mappers/routeRequest.ts", 'export * from "../observations/store.js";'), [
      "mappers/routeRequest.ts -> observations/store.ts",
    ]);
    assert.deepEqual(violations("app.ts", 'import { observationStream } from "./observations/route.js";'), []);
    // Multi-line imports, config access and side-effect imports are caught too.
    assert.deepEqual(
      violations("observations/poller.ts", 'import {\n  createInferenceClient,\n  type InferenceClient,\n} from "../inferenceClient/client.js";'),
      ["observations/poller.ts -> inferenceClient/client.ts"],
    );
    assert.deepEqual(violations("observations/service.ts", 'import { loadConfig } from "../config/config.js";'), [
      "observations/service.ts -> config/config.ts",
    ]);
    assert.deepEqual(violations("db/prisma.ts", 'import "../observations/service.js";'), [
      "db/prisma.ts -> observations/service.ts",
    ]);
  });
});

// ---------------------------------------------------------------- feature off

describe("feature off (no OBSERVATIONS_URL): backward compatible", () => {
  const token = newToken();
  const users: DevUser[] = [
    { userId: "u-analyst-1", email: "analyst@example.test", role: "analyst", tokenSha256: sha256Hex(token) },
  ];

  it("the stream route is not registered: 404 with and without a token, for every method", async () => {
    const server = await startServer(createApp({ logger: silentLogger, users }));
    try {
      for (const method of ["GET", "HEAD", "POST"]) {
        for (const headers of [{}, { Authorization: `Bearer ${token}` }] as Array<Record<string, string>>) {
          const r = await fetch(server.baseUrl + STREAM_PATH, { method, headers });
          assert.equal(r.status, 404, `${method}`);
          if (method !== "HEAD") assert.equal(((await r.json()) as any).error.code, "NOT_FOUND");
        }
      }
    } finally {
      await server.close();
    }
  });

  it("API_ROUTES and the v0.4 surface are unchanged", () => {
    assert.ok(Object.keys(API_ROUTES).every((p) => p.startsWith("/api/v1/")));
    assert.equal(Object.keys(API_ROUTES).length, 14);
  });

  it("config: observations is undefined unless OBSERVATIONS_URL is set (blank counts as unset)", () => {
    const tmp = makeTempDir();
    try {
      const file = tmp.write("dev-tokens.json", validTokenFile());
      const env = { AUTH_MODE: "dev", DEV_TOKENS_FILE: file };
      assert.equal(loadConfig(env).observations, undefined);
      assert.equal(loadConfig({ ...env, OBSERVATIONS_URL: "  " }).observations, undefined);
      // The single approved origin (owner decision, D-24), stored normalized.
      for (const ok of ["http://ingestion:8300", "http://ingestion:8300/", "HTTP://Ingestion:8300", " http://ingestion:8300 "]) {
        assert.deepEqual(loadConfig({ ...env, OBSERVATIONS_URL: ok }).observations, { url: "http://ingestion:8300" }, ok);
      }
    } finally {
      tmp.cleanup();
    }
  });

  it("config: rejects every destination but http://ingestion:8300, without echoing the value", () => {
    const tmp = makeTempDir();
    try {
      const file = tmp.write("dev-tokens.json", validTokenFile());
      for (const bad of [
        // Protocols other than http.
        "https://ingestion:8300",
        "ftp://ingestion:8300",
        "ws://ingestion:8300",
        "file:///SECRETPATH",
        "ingestion:8300",
        "//ingestion:8300",
        "not a url",
        // Wrong or omitted ports.
        "http://ingestion",
        "http://ingestion:80",
        "http://ingestion:8080",
        "http://ingestion:8301",
        "http://ingestion:08300",
        "http://ingestion:",
        "http://ingestion:8300:8300",
        // Unapproved, external, look-alike and suffixed hostnames.
        "http://SECRETHOST:8300",
        "http://example.com:8300",
        "http://ingestion.example.com:8300",
        "http://ingestion.:8300",
        "http://ingestion..:8300",
        "http://ingestion.internal:8300",
        "http://my-ingestion:8300",
        "http://ingestion-1:8300",
        "http://ingestlon:8300",
        "http://1ngestion:8300",
        "http://ingestion_:8300",
        "http://xn--ingestion-:8300",
        // Loopback and IP-address destinations: no runtime exception.
        "http://localhost:8300",
        "http://127.0.0.1:8300",
        "http://127.1:8300",
        "http://2130706433:8300",
        "http://0x7f000001:8300",
        "http://0.0.0.0:8300",
        "http://10.0.0.5:8300",
        "http://169.254.169.254:8300",
        "http://[::1]:8300",
        "http://[::ffff:127.0.0.1]:8300",
        // Encoded, Unicode and malformed bypass attempts.
        "http://%69ngestion:8300",
        "http://ingestion%2e:8300",
        "http://ingestion%00:8300",
        "http://ingest%C4%B1on:8300",
        "http://ingestıon:8300",
        "http://ｉngestion:8300",
        "http://ingestion\t:8300",
        "http://ingestion\n:8300",
        "http:\\\\ingestion:8300",
        "http:/ingestion:8300",
        "http:///ingestion:8300",
        "http://ingestion:8300\\",
        "http://ingestion:8300@evil.example",
        "http://evil.example#@ingestion:8300",
        "http://evil.example?@ingestion:8300",
        // Credentials, paths, queries and fragments on the approved origin.
        "http://user:SECRETPW@ingestion:8300",
        "http://SECRETUSER@ingestion:8300",
        "http://@ingestion:8300",
        "http://ingestion:8300/?SECRETQ=1",
        "http://ingestion:8300/#SECRETF",
        "http://ingestion:8300/SECRETPATH",
        "http://ingestion:8300/v1/",
        "http://ingestion:8300/v1/latest",
        "http://ingestion:8300/.",
        "http://ingestion:8300//",
        "http://ingestion:8300\\SECRETPATH",
        "http://ingestion:8300?",
        "http://ingestion:8300#",
      ]) {
        try {
          loadConfig({ AUTH_MODE: "dev", DEV_TOKENS_FILE: file, OBSERVATIONS_URL: bad });
          assert.fail(`accepted ${JSON.stringify(bad)}`);
        } catch (error) {
          assert.ok(error instanceof ConfigError, String(error));
          assert.equal(error.problems.length, 1, bad);
          assert.match(error.problems[0]!, /^OBSERVATIONS_URL /);
          assert.ok(!/SECRET/.test(error.message), bad);
        }
      }
    } finally {
      tmp.cleanup();
    }
  });

  it("config: no environment, NODE_ENV or allow-list bypass of the destination check", () => {
    const tmp = makeTempDir();
    try {
      const file = tmp.write("dev-tokens.json", validTokenFile());
      for (const extra of [
        { NODE_ENV: "test" },
        { NODE_ENV: "development" },
        { OBSERVATIONS_ALLOW_LOOPBACK: "1" },
        { OBSERVATIONS_ALLOWED_HOSTS: "127.0.0.1,localhost" },
      ] as Array<Record<string, string>>) {
        assert.throws(
          () => loadConfig({ AUTH_MODE: "dev", DEV_TOKENS_FILE: file, OBSERVATIONS_URL: "http://127.0.0.1:8300", ...extra }),
          ConfigError,
          JSON.stringify(extra),
        );
      }
    } finally {
      tmp.cleanup();
    }
  });

});

// ---------------------------------------------------------------- T-2 / T-1

function stateFixture(): { query: Record<string, string>; body: JsonObject } {
  const url = new URL("../../../../contracts/fixtures/inference/state/200_replay_gbr_phl.json", import.meta.url);
  const parsed = JSON.parse(readFileSync(url, "utf8")) as { request: { query: Record<string, string> }; response: { body: JsonObject } };
  return { query: parsed.request.query, body: parsed.response.body };
}

describe("observations never reach inference or routing (AD-6 T-1, T-2)", () => {
  const token = newToken();
  const users: DevUser[] = [
    { userId: "u-analyst-1", email: "analyst@example.test", role: "analyst", tokenSha256: sha256Hex(token) },
  ];
  const STATE_PATH = "/api/v1/state?corridor=GBR-%3EPHL&mode=historicalReplay&date=2024-06-14";
  const cleanups: Array<() => Promise<void>> = [];
  after(async () => {
    for (const c of cleanups) await c();
  });

  async function stack(withObservations: boolean, events: () => unknown[]) {
    const calls: InferenceRequest[] = [];
    const fixture = stateFixture();
    const client = createInferenceClient(
      { url: "http://inference.invalid", mode: "mock", timeoutMs: 1000 },
      {
        logger: silentLogger,
        mockHandler: (request) => {
          calls.push(request as InferenceRequest);
          return request.path === "/v1/state" ? { status: 200, body: fixture.body } : undefined;
        },
      },
    );
    let service: ReturnType<typeof createObservationService> | undefined;
    let ingestion: Awaited<ReturnType<typeof startFakeIngestion>> | undefined;
    if (withObservations) {
      ingestion = await startFakeIngestion((_req, res) => sendJson(res, 200, latestBody(events())));
      service = createObservationService({ url: ingestion.url, logger: silentLogger });
    }
    const server = await startServer(
      createApp({ logger: silentLogger, users, inferenceClient: client, observationStreams: service?.hub }),
    );
    service?.start();
    const close = async () => {
      await service?.shutdown();
      await server.close();
      await ingestion?.close();
    };
    cleanups.push(close);
    return { calls, server, service, ingestion, close };
  }

  it("a burst of events and open streams cause zero inference calls (T-2)", async () => {
    let t = Date.now();
    const s = await stack(true, () => {
      t += 1;
      return [eventAt(t - 50, { base: "AED", quote: "MXN" }), eventAt(t - 50, { base: "USD", quote: "INR" })];
    });
    const stream = await openStream(s.server.baseUrl + STREAM_PATH, token);
    await stream.next(5, 5000);
    assert.ok(stream.messages.filter((m) => m.event === "update").length >= 2);
    assert.deepEqual(s.calls, [], "no inference request of any kind");
    stream.abort();
    await waitFor(() => s.service!.hub.stats().reserved === 0);
  });

  it("routing-side responses and inference requests are identical with observations off, normal, extreme and malformed (T-1 at Express)", async () => {
    const off = await stack(false, () => []);
    const baseline = await fetch(off.server.baseUrl + STATE_PATH, { headers: { Authorization: `Bearer ${token}` } });
    const baselineBody = await baseline.text();
    assert.equal(baseline.status, 200);

    const feeds: Array<() => unknown[]> = [
      () => [eventAt(Date.now() - 10)],
      () => [eventAt(Date.now() - 10, { rate: "999999999.999999" })],
      () => [{ junk: true }],
    ];
    for (const feed of feeds) {
      const on = await stack(true, feed);
      const stream = await openStream(on.server.baseUrl + STREAM_PATH, token);
      await stream.next(1);
      // At least two completed polls have been applied (bounded wait, no fixed sleep).
      const seen = on.ingestion!.requests();
      await waitFor(() => on.ingestion!.requests() >= seen + 2 && on.service!.poller.inFlight() === 0, 4000);
      const r = await fetch(on.server.baseUrl + STATE_PATH, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(r.status, 200);
      assert.equal(await r.text(), baselineBody);
      // requestId is a fresh random ID per HTTP request; everything else must match.
      const strip = (calls: InferenceRequest[]) => calls.map(({ requestId: _id, ...rest }) => rest);
      assert.deepEqual(strip(on.calls), strip(off.calls), "same inference requests");
      stream.abort();
      await on.close();
    }
  });

  it("an observation outage does not block routing-side requests (AD6-Q2)", async () => {
    const ingestion = await startFakeIngestion((_req, res) => sendJson(res, 503, { error: { code: "NOT_READY", message: "x" } }));
    const service = createObservationService({ url: ingestion.url, logger: silentLogger });
    const client = createInferenceClient(
      { url: "http://inference.invalid", mode: "mock", timeoutMs: 1000 },
      { logger: silentLogger, mockHandler: (req) => (req.path === "/v1/state" ? { status: 200, body: stateFixture().body } : undefined) },
    );
    const server = await startServer(createApp({ logger: silentLogger, users, inferenceClient: client, observationStreams: service.hub }));
    service.start();
    try {
      await waitFor(() => service.poller.status() === "outage", 4000);
      const r = await fetch(server.baseUrl + STATE_PATH, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(r.status, 200);
      const h = await fetch(server.baseUrl + "/api/v1/health/live");
      assert.equal(h.status, 200, "liveness is unaffected");
    } finally {
      await service.shutdown();
      await server.close();
      await ingestion.close();
    }
  });
});

// ---------------------------------------------------------------- lifecycle

describe("lifecycle pre-close hook (additive, §3.5)", () => {
  const fakeServer = (events: string[]) => ({
    close(callback?: (error?: Error) => void) {
      events.push("server.close");
      setTimeout(() => callback?.(), 0);
      return this as never;
    },
    closeIdleConnections() {
      events.push("server.closeIdleConnections");
    },
  });

  it("runs before server.close, then the existing sequence, exit 0", async () => {
    const events: string[] = [];
    const shutdown = createShutdown({
      server: fakeServer(events),
      disconnect: async () => void events.push("disconnect"),
      logger: silentLogger,
      exit: (code) => void events.push(`exit ${code}`),
      beforeClose: async () => void events.push("beforeClose"),
    });
    await shutdown("SIGTERM");
    assert.deepEqual(events, ["beforeClose", "server.close", "server.closeIdleConnections", "disconnect", "exit 0"]);
  });

  it("a failing hook is logged without its message and does not stop the shutdown", async () => {
    const events: string[] = [];
    const capture = captureLogger();
    const shutdown = createShutdown({
      server: fakeServer(events),
      disconnect: async () => void events.push("disconnect"),
      logger: capture.logger,
      exit: (code) => void events.push(`exit ${code}`),
      beforeClose: async () => {
        throw new Error("SECRET-DETAIL");
      },
    });
    await shutdown("SIGTERM");
    assert.deepEqual(events.slice(-2), ["disconnect", "exit 0"]);
    assert.ok(!capture.lines.join("").includes("SECRET-DETAIL"));
  });

  it("a real server with an open stream shuts down cleanly with exit 0 well before the 10 s forced exit", async () => {
    const token = newToken();
    const users: DevUser[] = [{ userId: "u1", email: "a@example.test", role: "analyst", tokenSha256: sha256Hex(token) }];
    const ingestion = await startFakeIngestion((_req, res) => sendJson(res, 200, latestBody([])));
    const service = createObservationService({ url: ingestion.url, logger: silentLogger });
    const app = createApp({ logger: silentLogger, users, observationStreams: service.hub });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    service.start();
    const port = (server.address() as { port: number }).port;
    const stream = await openStream(`http://127.0.0.1:${port}${STREAM_PATH}`, token);
    await stream.next(1);
    const exits: number[] = [];
    const started = Date.now();
    await createShutdown({
      server,
      disconnect: async () => {},
      logger: silentLogger,
      exit: (code) => void exits.push(code),
      beforeClose: () => service.shutdown(),
    })("SIGTERM");
    assert.deepEqual(exits, [0]);
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
    assert.equal(service.hub.stats().reserved, 0);
    await ingestion.close();
  });
});
