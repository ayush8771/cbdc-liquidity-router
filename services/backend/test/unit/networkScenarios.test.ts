import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createApp } from "../../src/app.js";
import type { DevUser } from "../../src/config/devTokens.js";
import { createInferenceCache, VERSION_REFRESH_MS } from "../../src/inferenceClient/cache.js";
import {
  createInferenceClient,
  type InferenceClient,
  type InferenceRequest,
  type JsonObject,
  type MockResponse,
} from "../../src/inferenceClient/client.js";
import { newToken, sha256Hex } from "../helpers/devTokens.js";
import { captureLogger, silentLogger, startServer } from "../helpers/server.js";
import { engineVersionBody } from "../helpers/version.js";

// GET /api/v1/network (API contract §2.3, §3.1) and GET /api/v1/scenarios
// (§2.7, §3.1), both through the shared inference cache (§5). Inference
// answers come from test mock handlers or an in-process client double: no
// network. The contract fixture pairs are read only, to check the mapping.

const analystToken = newToken();
const viewerToken = newToken();
const users: DevUser[] = [
  { userId: "u-analyst-1", email: "analyst@example.test", role: "analyst", tokenSha256: sha256Hex(analystToken) },
  { userId: "u-viewer-1", email: "viewer@example.test", role: "viewer", tokenSha256: sha256Hex(viewerToken) },
];
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

function fixtureBody(side: "inference" | "app", name: string): JsonObject {
  const url = new URL(`../../../../contracts/fixtures/${side}/meta/${name}`, import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as { response: { body: JsonObject } }).response.body;
}

interface Endpoint {
  appPath: "/api/v1/network" | "/api/v1/scenarios";
  enginePath: "/v1/network" | "/v1/scenarios";
  engineBody: JsonObject;
  appBody: JsonObject;
  /** A body whose two keys map to the same camelCase name. */
  colliding: JsonObject;
}

const ENDPOINTS: Endpoint[] = [
  {
    appPath: "/api/v1/network",
    enginePath: "/v1/network",
    engineBody: fixtureBody("inference", "200_network.json"),
    appBody: fixtureBody("app", "200_network.json"),
    colliding: { ...fixtureBody("inference", "200_network.json"), maxSingleTransferUsd: 1 },
  },
  {
    appPath: "/api/v1/scenarios",
    enginePath: "/v1/scenarios",
    engineBody: fixtureBody("inference", "200_scenarios.json"),
    appBody: fixtureBody("app", "200_scenarios.json"),
    colliding: {
      scenarios: [{ scenario_id: "baseline", scenarioId: "baseline" }],
      note: "x",
    },
  },
];

type Answer = MockResponse | undefined;

/** A mock-mode client (test handler, not a fixture). /v1/version answers a valid body unless overridden. */
function mockClient(answers: Partial<Record<string, () => Answer>>) {
  const calls: InferenceRequest[] = [];
  const client = createInferenceClient(
    { url: "http://inference.invalid", mode: "mock", timeoutMs: 1000 },
    {
      logger: silentLogger,
      mockHandler: (request) => {
        calls.push(request as InferenceRequest);
        const answer = answers[request.path];
        if (answer !== undefined) return answer();
        if (request.path === "/v1/version") return { status: 200, body: engineVersionBody() };
        return undefined;
      },
    },
  );
  const count = (path: string) => calls.filter((c) => c.path === path).length;
  return { client, calls, count };
}

async function withApp<T>(
  options: Parameters<typeof createApp>[0],
  run: (get: (path: string, init?: { headers?: Record<string, string>; method?: string }) => Promise<Res>) => Promise<T>,
): Promise<T> {
  const server = await startServer(createApp({ logger: silentLogger, users, ...options }));
  try {
    return await run(async (path, init = {}) => {
      const res = await fetch(`${server.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: init.headers ?? auth(viewerToken),
      });
      const text = await res.text();
      return { status: res.status, headers: res.headers, text, body: text ? (JSON.parse(text) as Record<string, any>) : undefined };
    });
  } finally {
    await server.close();
  }
}
interface Res {
  status: number;
  headers: Headers;
  text: string;
  body: Record<string, any> | undefined;
}

for (const ep of ENDPOINTS) {
  const ok = () => ({ status: 200, body: ep.engineBody });

  describe(`GET ${ep.appPath}`, () => {
    describe("authentication and roles", () => {
      for (const [label, headers] of [
        ["no Authorization header", {}],
        ["a malformed token", { Authorization: "Bearer not-a-token" }],
        ["an unknown token", auth(newToken())],
        ["the MSW mock-viewer token", { Authorization: "Bearer mock-viewer" }],
      ] as const) {
        it(`returns 401 UNAUTHENTICATED for ${label}, without calling inference`, async () => {
          const { client, calls } = mockClient({ [ep.enginePath]: ok });
          const res = await withApp({ inferenceClient: client }, (get) => get(ep.appPath, { headers }));
          assert.equal(res.status, 401);
          assert.equal(res.body!.error.code, "UNAUTHENTICATED");
          assert.equal(calls.length, 0);
        });
      }

      for (const [role, token] of [
        ["analyst", analystToken],
        ["viewer", viewerToken],
      ] as const) {
        it(`returns 200 for a ${role}`, async () => {
          const { client } = mockClient({ [ep.enginePath]: ok });
          const res = await withApp({ inferenceClient: client }, (get) => get(ep.appPath, { headers: auth(token) }));
          assert.equal(res.status, 200);
        });
      }
    });

    describe("mapping", () => {
      it("returns exactly the app contract fixture for the inference contract fixture", async () => {
        const { client } = mockClient({ [ep.enginePath]: ok });
        const res = await withApp({ inferenceClient: client }, (get) => get(ep.appPath));
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
        assert.deepEqual(res.body, ep.appBody);
      });

      it("keeps and maps unknown fields, top level and nested, values unchanged", async () => {
        const engine = structuredClone(ep.engineBody);
        engine.future_field = { nested_key: "snake_value" };
        const list = (engine.corridors ?? engine.scenarios) as JsonObject[];
        list[0]!.extra_item_field = 1;
        const { client } = mockClient({ [ep.enginePath]: () => ({ status: 200, body: engine }) });
        const res = await withApp({ inferenceClient: client }, (get) => get(ep.appPath));
        assert.deepEqual(res.body!.futureField, { nestedKey: "snake_value" });
        const appList = (res.body!.corridors ?? res.body!.scenarios) as Array<Record<string, unknown>>;
        assert.equal(appList[0]!.extraItemField, 1);
      });

      it("calls /v1/version then the resource, forwarding the request ID, and ignores query parameters", async () => {
        const { client, calls } = mockClient({ [ep.enginePath]: ok });
        const res = await withApp({ inferenceClient: client }, (get) =>
          get(`${ep.appPath}?corridor=GBR-%3EPHL&x=1`, { headers: { ...auth(viewerToken), "X-Request-Id": "md-1" } }),
        );
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("x-request-id"), "md-1");
        assert.deepEqual(
          calls.map((c) => [c.method, c.path, c.requestId, c.query]),
          [
            ["GET", "/v1/version", "md-1", undefined],
            ["GET", ep.enginePath, "md-1", undefined],
          ],
        );
      });
    });

    describe("cache", () => {
      it("serves the second request from the cache", async () => {
        const { client, count } = mockClient({ [ep.enginePath]: ok });
        await withApp({ inferenceClient: client }, async (get) => {
          assert.equal((await get(ep.appPath)).status, 200);
          assert.deepEqual((await get(ep.appPath)).body, ep.appBody);
        });
        assert.equal(count("/v1/version"), 1);
        assert.equal(count(ep.enginePath), 1);
      });

      it("keeps the entry across a version refresh with the same fingerprint", async () => {
        const { client, count } = mockClient({ [ep.enginePath]: ok });
        const clock = { time: 0 };
        const inferenceCache = createInferenceCache(client, { now: () => clock.time });
        await withApp({ inferenceClient: client, inferenceCache }, async (get) => {
          await get(ep.appPath);
          clock.time = VERSION_REFRESH_MS;
          assert.equal((await get(ep.appPath)).status, 200);
        });
        assert.equal(count("/v1/version"), 2);
        assert.equal(count(ep.enginePath), 1);
      });

      for (const [label, change] of [
        ["engine_version", { engine_version: "0.2.0" }],
        ["data.scenarios_sha256", { data: { ...(engineVersionBody().data as JsonObject), scenarios_sha256: "f".repeat(64) } }],
        ["checkpoint null -> enabled", { checkpoint: { sha256: "a".repeat(64) } }],
      ] as const) {
        it(`re-fetches after a version fingerprint change (${label})`, async () => {
          let version = engineVersionBody();
          let serial = 0;
          const { client, count } = mockClient({
            "/v1/version": () => ({ status: 200, body: version }),
            [ep.enginePath]: () => ({ status: 200, body: { ...ep.engineBody, note: `serial-${++serial}` } }),
          });
          const clock = { time: 0 };
          const inferenceCache = createInferenceCache(client, { now: () => clock.time });
          await withApp({ inferenceClient: client, inferenceCache }, async (get) => {
            assert.equal((await get(ep.appPath)).body!.note, "serial-1");
            version = engineVersionBody(change);
            clock.time = VERSION_REFRESH_MS - 1;
            assert.equal((await get(ep.appPath)).body!.note, "serial-1"); // not refreshed yet
            clock.time = VERSION_REFRESH_MS;
            assert.equal((await get(ep.appPath)).body!.note, "serial-2");
          });
          assert.equal(count(ep.enginePath), 2);
        });
      }

      it("does not cache a failed fetch", async () => {
        let fail = true;
        const { client, count } = mockClient({
          [ep.enginePath]: () => (fail ? { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "x" } } } : ok()),
        });
        await withApp({ inferenceClient: client }, async (get) => {
          assert.equal((await get(ep.appPath)).status, 502);
          fail = false;
          assert.equal((await get(ep.appPath)).status, 200);
          assert.equal((await get(ep.appPath)).status, 200);
        });
        assert.equal(count(ep.enginePath), 2);
      });

      it("serves no cached entry after a failed version refresh", async () => {
        let versionFails = false;
        const { client, count } = mockClient({
          "/v1/version": () => (versionFails ? undefined : { status: 200, body: engineVersionBody() }),
          [ep.enginePath]: ok,
        });
        const clock = { time: 0 };
        const inferenceCache = createInferenceCache(client, { now: () => clock.time });
        await withApp({ inferenceClient: client, inferenceCache }, async (get) => {
          assert.equal((await get(ep.appPath)).status, 200);
          clock.time = VERSION_REFRESH_MS;
          versionFails = true;
          const res = await get(ep.appPath);
          assert.equal(res.status, 503);
          assert.equal(res.body!.error.code, "INFERENCE_UNAVAILABLE");
        });
        assert.equal(count(ep.enginePath), 1);
      });

      it("shares one version and one resource fetch between concurrent requests", async () => {
        // A client double whose answers wait until released, so the requests overlap.
        const calls: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const client: InferenceClient = {
          mode: "live",
          async get(path) {
            calls.push(path);
            await gate;
            return path === "/v1/version" ? engineVersionBody() : structuredClone(ep.engineBody);
          },
          async post() {
            throw new Error("not used");
          },
          async health() {
            throw new Error("not used");
          },
        };
        await withApp({ inferenceClient: client }, async (get) => {
          const pending = [get(ep.appPath), get(ep.appPath), get(ep.appPath)];
          await new Promise((resolve) => setTimeout(resolve, 50));
          release();
          for (const res of await Promise.all(pending)) assert.deepEqual(res.body, ep.appBody);
        });
        assert.deepEqual(calls, ["/v1/version", ep.enginePath]);
      });
    });

    describe("malformed responses", () => {
      const leaky = "Traceback: postgresql://user:pass@db";
      for (const [label, answer] of [
        ["a JSON array", { status: 200, body: [ep.engineBody] }],
        ["JSON null", { status: 200, body: null }],
        ["a JSON string", { status: 200, body: leaky }],
      ] as const) {
        it(`returns 502 INFERENCE_ERROR for ${label}, and doesn't cache it`, async () => {
          let bad = true;
          const { client, count } = mockClient({ [ep.enginePath]: () => (bad ? (answer as MockResponse) : ok()) });
          await withApp({ inferenceClient: client }, async (get) => {
            const res = await get(ep.appPath, { headers: { ...auth(viewerToken), "X-Request-Id": "bad-1" } });
            assert.equal(res.status, 502);
            assert.deepEqual(res.body, {
              error: {
                code: "INFERENCE_ERROR",
                message: "The inference service returned an invalid response.",
                details: {},
                requestId: "bad-1",
              },
            });
            assert.doesNotMatch(res.text, /Traceback|postgresql/);
            bad = false;
            assert.equal((await get(ep.appPath)).status, 200);
          });
          assert.equal(count(ep.enginePath), 2);
        });
      }

      it("returns a controlled 502 INFERENCE_ERROR when two keys collide, logging no key names", async () => {
        const capture = captureLogger();
        const { client } = mockClient({ [ep.enginePath]: () => ({ status: 200, body: ep.colliding }) });
        const server = await startServer(createApp({ logger: capture.logger, users, inferenceClient: client }));
        try {
          const res = await fetch(`${server.baseUrl}${ep.appPath}`, { headers: { ...auth(viewerToken), "X-Request-Id": "collide" } });
          assert.equal(res.status, 502);
          assert.equal(((await res.json()) as { error: { code: string } }).error.code, "INFERENCE_ERROR");
        } finally {
          await server.close();
        }
        const warning = capture.entries().find((e) => e.msg === "inference response could not be mapped");
        assert.deepEqual(
          { requestId: warning?.requestId, path: warning?.path, reason: warning?.reason },
          { requestId: "collide", path: ep.enginePath, reason: "key_collision" },
        );
        assert.doesNotMatch(capture.lines.join("\n"), /maxSingleTransferUsd|max_single_transfer_usd|scenarioId|scenario_id/);
      });

      it("returns 502 for a malformed 200 /v1/version without fetching the resource", async () => {
        const { client, count } = mockClient({
          "/v1/version": () => ({ status: 200, body: engineVersionBody({ git_commit: "" }) }),
          [ep.enginePath]: ok,
        });
        const res = await withApp({ inferenceClient: client }, (get) => get(ep.appPath));
        assert.equal(res.status, 502);
        assert.equal(res.body!.error.code, "INFERENCE_ERROR");
        assert.equal(count(ep.enginePath), 0);
      });
    });

    describe("inference failures", () => {
      const leaky = "Traceback: postgresql://user:pass@db";
      for (const [label, answer, status, code, cause] of [
        ["inference 500", { status: 500, body: { error: { code: "INTERNAL_ERROR", message: leaky } } }, 502, "INFERENCE_ERROR", undefined],
        ["inference 404", { status: 404, body: { error: { code: "NOT_FOUND", message: leaky } } }, 502, "INFERENCE_ERROR", undefined],
        ["NOT_READY", { status: 503, body: { error: { code: "NOT_READY", message: leaky } }, retryAfter: "3" }, 503, "INFERENCE_UNAVAILABLE", "NOT_READY"],
      ] as const) {
        it(`returns ${status} ${code} for ${label}, exposing nothing from inference`, async () => {
          const { client } = mockClient({ [ep.enginePath]: () => answer as MockResponse });
          const res = await withApp({ inferenceClient: client }, (get) => get(ep.appPath));
          assert.equal(res.status, status);
          assert.equal(res.body!.error.code, code);
          assert.deepEqual(res.body!.error.details, cause === undefined ? {} : { cause });
          if (cause !== undefined) assert.equal(res.headers.get("retry-after"), "3");
          assert.doesNotMatch(res.text, /Traceback|postgresql|INTERNAL_ERROR/);
        });
      }

      it("returns 503 INFERENCE_UNAVAILABLE in mock mode with no handler (no fixtures are loaded)", async () => {
        const client = createInferenceClient({ url: "http://inference.invalid", mode: "mock", timeoutMs: 1000 }, { logger: silentLogger });
        const res = await withApp({ inferenceClient: client }, (get) => get(ep.appPath));
        assert.equal(res.status, 503);
        assert.equal(res.body!.error.code, "INFERENCE_UNAVAILABLE");
      });

      it("returns 503 INFERENCE_UNAVAILABLE without an inference client", async () => {
        const res = await withApp({}, (get) => get(ep.appPath, { headers: { ...auth(viewerToken), "X-Request-Id": "no-client" } }));
        assert.equal(res.status, 503);
        assert.deepEqual(res.body, {
          error: { code: "INFERENCE_UNAVAILABLE", message: "The inference service is unavailable.", details: {}, requestId: "no-client" },
        });
      });
    });

    describe("methods", () => {
      it("answers HEAD with 200 and no body", async () => {
        const { client } = mockClient({ [ep.enginePath]: ok });
        const res = await withApp({ inferenceClient: client }, (get) => get(ep.appPath, { method: "HEAD" }));
        assert.equal(res.status, 200);
        assert.equal(res.text, "");
      });

      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
        it(`returns 401 without a token, then 405 with Allow: GET, HEAD for ${method} with one (§10 Q14), without calling inference`, async () => {
          const { client, calls } = mockClient({ [ep.enginePath]: ok });
          const anon = await withApp({ inferenceClient: client }, (get) => get(ep.appPath, { method, headers: {} }));
          assert.equal(anon.status, 401);
          assert.equal(anon.headers.get("allow"), null);
          const res = await withApp({ inferenceClient: client }, (get) => get(ep.appPath, { method }));
          assert.equal(res.status, 405);
          assert.equal(res.headers.get("allow"), "GET, HEAD");
          assert.equal(res.body!.error.code, "METHOD_NOT_ALLOWED");
          assert.equal(calls.length, 0);
        });
      }
    });
  });
}

describe("network and scenarios share one cache", () => {
  it("one /v1/version read serves both, and a fingerprint change re-fetches both", async () => {
    let version = engineVersionBody();
    const { client, count } = mockClient({
      "/v1/version": () => ({ status: 200, body: version }),
      "/v1/network": () => ({ status: 200, body: ENDPOINTS[0]!.engineBody }),
      "/v1/scenarios": () => ({ status: 200, body: ENDPOINTS[1]!.engineBody }),
    });
    const clock = { time: 0 };
    const inferenceCache = createInferenceCache(client, { now: () => clock.time });
    await withApp({ inferenceClient: client, inferenceCache }, async (get) => {
      assert.equal((await get("/api/v1/network")).status, 200);
      assert.equal((await get("/api/v1/scenarios")).status, 200);
      assert.equal(count("/v1/version"), 1);
      version = engineVersionBody({ git_commit: "fffffff" });
      clock.time = VERSION_REFRESH_MS;
      assert.equal((await get("/api/v1/network")).status, 200);
      assert.equal((await get("/api/v1/scenarios")).status, 200);
    });
    assert.equal(count("/v1/version"), 2);
    assert.equal(count("/v1/network"), 2);
    assert.equal(count("/v1/scenarios"), 2);
  });
});
