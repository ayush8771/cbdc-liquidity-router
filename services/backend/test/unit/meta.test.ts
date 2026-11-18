import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createApp } from "../../src/app.js";
import { BACKEND_VERSION } from "../../src/config/backendVersion.js";
import type { DevUser } from "../../src/config/devTokens.js";
import { createInferenceCache, VERSION_REFRESH_MS } from "../../src/inferenceClient/cache.js";
import {
  createInferenceClient,
  type InferenceClient,
  type InferenceRequest,
  type MockResponse,
} from "../../src/inferenceClient/client.js";
import { newToken, sha256Hex } from "../helpers/devTokens.js";
import { captureLogger, silentLogger, startServer } from "../helpers/server.js";

// GET /api/v1/meta (API contract §3.1, §3.9). Inference answers come from a
// test mock handler (not a fixture), so there is no network.

const analystToken = newToken();
const viewerToken = newToken();
const users: DevUser[] = [
  { userId: "u-analyst-1", email: "analyst@example.test", role: "analyst", tokenSha256: sha256Hex(analystToken) },
  { userId: "u-viewer-1", email: "viewer@example.test", role: "viewer", tokenSha256: sha256Hex(viewerToken) },
];
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// Test data shaped after §2.2, with an enabled checkpoint so nested keys map too.
const engineVersion = {
  api_version: "v1",
  engine_version: "0.1.0",
  phase1_baseline_tag: "phase1-complete",
  git_commit: "bc9905e",
  default_policy: "waterfall",
  policies: [
    { policy: "waterfall", status: "default", enabled: true },
    { policy: "ppo_projected", status: "experimental", enabled: false, disabled_reason: "no approved checkpoint configured" },
  ],
  checkpoint: { checkpoint_id: "ck-1", sha256: "a".repeat(64), approved_by: "x", approved_on: "2026-11-01", source_run: "outputs/experiments/x" },
  knowledge: { knowledge_version: "2026-11-02.1", sha256: "e".repeat(64) },
  data: {
    daily_state_sha256: "1".repeat(64),
    bridge_network_sha256: "2".repeat(64),
    normalization_stats_sha256: "3".repeat(64),
    macro_risk_proxy_sha256: "4".repeat(64),
    rpw_corridor_quarterly_sha256: "5".repeat(64),
    scenarios_sha256: "6".repeat(64),
    date_range: { start: "2011-01-01", end: "2025-09-30" },
  },
  reward_weights: { lambda_latency: 1.0, lambda_risk: 1.0, lambda_unrouted: 1.0, status: "placeholder" },
  runtime: { platform: "linux-x86_64", python: "3.10.11", torch: "2.13.0+cpu", device: "cpu", lock_file: "services/x.txt" },
};
const appVersion = {
  apiVersion: "v1",
  engineVersion: "0.1.0",
  phase1BaselineTag: "phase1-complete",
  gitCommit: "bc9905e",
  defaultPolicy: "waterfall",
  policies: [
    { policy: "waterfall", status: "default", enabled: true },
    // Values are not mapped: "ppo_projected" stays as the engine sent it.
    { policy: "ppo_projected", status: "experimental", enabled: false, disabledReason: "no approved checkpoint configured" },
  ],
  checkpoint: { checkpointId: "ck-1", sha256: "a".repeat(64), approvedBy: "x", approvedOn: "2026-11-01", sourceRun: "outputs/experiments/x" },
  knowledge: { knowledgeVersion: "2026-11-02.1", sha256: "e".repeat(64) },
  data: {
    dailyStateSha256: "1".repeat(64),
    bridgeNetworkSha256: "2".repeat(64),
    normalizationStatsSha256: "3".repeat(64),
    macroRiskProxySha256: "4".repeat(64),
    rpwCorridorQuarterlySha256: "5".repeat(64),
    scenariosSha256: "6".repeat(64),
    dateRange: { start: "2011-01-01", end: "2025-09-30" },
  },
  rewardWeights: { lambdaLatency: 1.0, lambdaRisk: 1.0, lambdaUnrouted: 1.0, status: "placeholder" },
  runtime: { platform: "linux-x86_64", python: "3.10.11", torch: "2.13.0+cpu", device: "cpu", lockFile: "services/x.txt" },
};

/** A mock-mode client answering /v1/version with `answer` (a test handler, not a fixture). */
function mockClient(answer: () => MockResponse | undefined = () => ({ status: 200, body: engineVersion })) {
  const calls: InferenceRequest[] = [];
  const client = createInferenceClient(
    { url: "http://inference.invalid", mode: "mock", timeoutMs: 1000 },
    {
      logger: silentLogger,
      mockHandler: (request) => {
        calls.push(request as InferenceRequest);
        return answer();
      },
    },
  );
  return { client, calls };
}

/** A live-mode client double: mode "live", answering get() in process. */
function liveClient() {
  const calls: string[] = [];
  const client: InferenceClient = {
    mode: "live",
    async get(path) {
      calls.push(path);
      return structuredClone(engineVersion);
    },
    async post() {
      throw new Error("not used");
    },
    async health() {
      throw new Error("not used");
    },
  };
  return { client, calls };
}

async function withServer<T>(options: Parameters<typeof createApp>[0], run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = await startServer(createApp({ logger: silentLogger, users, ...options }));
  try {
    return await run(server.baseUrl);
  } finally {
    await server.close();
  }
}

async function getMeta(baseUrl: string, headers: Record<string, string> = auth(viewerToken), method = "GET") {
  const res = await fetch(`${baseUrl}/api/v1/meta`, { method, headers });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: text ? (JSON.parse(text) as Record<string, any>) : undefined };
}

describe("GET /api/v1/meta", () => {
  it("backendVersion is package.json's version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    assert.equal(BACKEND_VERSION, pkg.version);
  });

  describe("authentication", () => {
    for (const [label, headers] of [
      ["no Authorization header", {}],
      ["a malformed token", { Authorization: "Bearer not-a-token" }],
      ["an unknown token", auth(newToken())],
    ] as const) {
      it(`returns 401 UNAUTHENTICATED for ${label}, without calling inference`, async () => {
        const { client, calls } = mockClient();
        const res = await withServer({ inferenceClient: client }, (url) => getMeta(url, headers));
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
        const { client } = mockClient();
        const res = await withServer({ inferenceClient: client }, (url) => getMeta(url, auth(token)));
        assert.equal(res.status, 200);
      });
    }
  });

  describe("response", () => {
    it("is the camelCase mapping of /v1/version plus backendVersion and inferenceMode, exactly (mock mode)", async () => {
      const { client, calls } = mockClient();
      const res = await withServer({ inferenceClient: client }, (url) => getMeta(url));
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
      assert.deepEqual(res.body, { ...appVersion, backendVersion: BACKEND_VERSION, inferenceMode: "mock" });
      assert.deepEqual(Object.keys(res.body!).slice(-2), ["backendVersion", "inferenceMode"]);
      assert.deepEqual(calls.map((c) => [c.method, c.path]), [["GET", "/v1/version"]]);
    });

    it('reports inferenceMode "live" for a live client', async () => {
      const { client } = liveClient();
      const res = await withServer({ inferenceClient: client }, (url) => getMeta(url));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ...appVersion, backendVersion: BACKEND_VERSION, inferenceMode: "live" });
    });

    it("keeps and maps unknown fields", async () => {
      const { client } = mockClient(() => ({ status: 200, body: { ...engineVersion, future_field: { nested_key: "v" } } }));
      const res = await withServer({ inferenceClient: client }, (url) => getMeta(url));
      assert.deepEqual(res.body!.futureField, { nestedKey: "v" });
    });

    it("forwards the request ID to /v1/version and ignores query parameters", async () => {
      const { client, calls } = mockClient();
      const res = await withServer({ inferenceClient: client }, async (url) => {
        const r = await fetch(`${url}/api/v1/meta?x=1`, { headers: { ...auth(viewerToken), "X-Request-Id": "meta-1" } });
        return { status: r.status, body: (await r.json()) as Record<string, unknown> };
      });
      assert.equal(res.status, 200);
      assert.equal(calls[0]!.requestId, "meta-1");
      assert.equal(calls[0]!.query, undefined);
    });
  });

  describe("cache", () => {
    it("reads /v1/version once within 30 s, then again after", async () => {
      const { client, calls } = mockClient();
      const clock = { time: 0 };
      const inferenceCache = createInferenceCache(client, { now: () => clock.time });
      await withServer({ inferenceClient: client, inferenceCache }, async (url) => {
        assert.equal((await getMeta(url)).status, 200);
        clock.time = VERSION_REFRESH_MS - 1;
        assert.equal((await getMeta(url)).status, 200);
        assert.equal(calls.length, 1);
        clock.time = VERSION_REFRESH_MS;
        assert.equal((await getMeta(url)).status, 200);
        assert.equal(calls.length, 2);
      });
    });

    it("shares the cache with the calendar: one /v1/version read for both", async () => {
      const calls: string[] = [];
      const client = createInferenceClient(
        { url: "http://inference.invalid", mode: "mock", timeoutMs: 1000 },
        {
          logger: silentLogger,
          mockHandler: (request) => {
            calls.push(request.path);
            return { status: 200, body: request.path === "/v1/version" ? engineVersion : { start: "2011-01-01" } };
          },
        },
      );
      await withServer({ inferenceClient: client }, async (url) => {
        assert.equal((await getMeta(url)).status, 200);
        const cal = await fetch(`${url}/api/v1/replay/calendar`, { headers: auth(viewerToken) });
        assert.equal(cal.status, 200);
      });
      assert.deepEqual(calls, ["/v1/version", "/v1/replay/calendar"]);
    });

    it("does not cache a failed /v1/version", async () => {
      let fail = true;
      const { client, calls } = mockClient(() => (fail ? { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "x" } } } : { status: 200, body: engineVersion }));
      await withServer({ inferenceClient: client }, async (url) => {
        assert.equal((await getMeta(url)).status, 502);
        fail = false;
        assert.equal((await getMeta(url)).status, 200);
      });
      assert.equal(calls.length, 2);
    });
  });

  describe("errors", () => {
    it("returns 502 INFERENCE_ERROR for a malformed 200 /v1/version, does not cache it, and succeeds on the next request", async () => {
      let body: Record<string, unknown> = { ...engineVersion, knowledge: { knowledge_version: "x", sha256: "not-hex" } };
      const { client, calls } = mockClient(() => ({ status: 200, body }));
      const clock = { time: 0 };
      const inferenceCache = createInferenceCache(client, { now: () => clock.time });
      await withServer({ inferenceClient: client, inferenceCache }, async (url) => {
        const bad = await getMeta(url, { ...auth(viewerToken), "X-Request-Id": "bad-meta" });
        assert.equal(bad.status, 502);
        assert.deepEqual(bad.body, {
          error: {
            code: "INFERENCE_ERROR",
            message: "The inference service returned an invalid response.",
            details: {},
            requestId: "bad-meta",
          },
        });
        assert.doesNotMatch(bad.text, /not-hex/);
        // Same clock instant: retried at once, not after 30 s.
        body = engineVersion;
        const good = await getMeta(url);
        assert.equal(good.status, 200);
        assert.deepEqual(good.body, { ...appVersion, backendVersion: BACKEND_VERSION, inferenceMode: "mock" });
      });
      assert.equal(calls.length, 2);
    });

    it("returns 503 INFERENCE_UNAVAILABLE in mock mode with no handler (no fixtures exist)", async () => {
      const client = createInferenceClient(
        { url: "http://inference.invalid", mode: "mock", timeoutMs: 1000 },
        { logger: silentLogger },
      );
      const res = await withServer({ inferenceClient: client }, (url) => getMeta(url));
      assert.equal(res.status, 503);
      assert.equal(res.body!.error.code, "INFERENCE_UNAVAILABLE");
    });

    it("returns 503 INFERENCE_UNAVAILABLE without an inference client", async () => {
      const res = await withServer({}, (url) => getMeta(url, { ...auth(viewerToken), "X-Request-Id": "no-client" }));
      assert.equal(res.status, 503);
      assert.deepEqual(res.body, {
        error: { code: "INFERENCE_UNAVAILABLE", message: "The inference service is unavailable.", details: {}, requestId: "no-client" },
      });
    });

    const leaky = "Traceback: postgresql://user:pass@db";
    for (const [label, answer, status, code] of [
      ["inference 500", { status: 500, body: { error: { code: "INTERNAL_ERROR", message: leaky } } }, 502, "INFERENCE_ERROR"],
      ["a JSON array", { status: 200, body: [engineVersion] }, 502, "INFERENCE_ERROR"],
      ["JSON null", { status: 200, body: null }, 502, "INFERENCE_ERROR"],
      ["NOT_READY", { status: 503, body: { error: { code: "NOT_READY", message: leaky } } }, 503, "INFERENCE_UNAVAILABLE"],
    ] as const) {
      it(`returns ${status} ${code} for ${label}, exposing nothing from inference`, async () => {
        const { client } = mockClient(() => answer as MockResponse);
        const res = await withServer({ inferenceClient: client }, (url) => getMeta(url));
        assert.equal(res.status, status);
        assert.equal(res.body!.error.code, code);
        assert.doesNotMatch(res.text, /Traceback|postgresql/);
      });
    }

    for (const [label, body] of [
      ["two engine keys collide", { ...engineVersion, gitCommit: "x" }],
      ["the engine sends backend_version", { ...engineVersion, backend_version: "9.9.9" }],
      ["the engine sends inferenceMode", { ...engineVersion, inferenceMode: "live" }],
    ] as const) {
      it(`returns a controlled 502 INFERENCE_ERROR when ${label}, logging no key names`, async () => {
        const capture = captureLogger();
        const { client } = mockClient(() => ({ status: 200, body }));
        const server = await startServer(createApp({ logger: capture.logger, users, inferenceClient: client }));
        try {
          const res = await getMeta(server.baseUrl, { ...auth(viewerToken), "X-Request-Id": "collide" });
          assert.equal(res.status, 502);
          assert.deepEqual(res.body, {
            error: {
              code: "INFERENCE_ERROR",
              message: "The inference service returned an invalid response.",
              details: {},
              requestId: "collide",
            },
          });
        } finally {
          await server.close();
        }
        const warning = capture.entries().find((e) => e.msg === "inference response could not be mapped");
        assert.deepEqual(
          { requestId: warning?.requestId, path: warning?.path, reason: warning?.reason },
          { requestId: "collide", path: "/v1/version", reason: "key_collision" },
        );
        assert.doesNotMatch(capture.lines.join("\n"), /gitCommit|backend_version|inferenceMode"/);
      });
    }

    for (const method of ["POST", "PUT", "DELETE"]) {
      it(`returns 405 with Allow: GET, HEAD for ${method}, without calling inference`, async () => {
        const { client, calls } = mockClient();
        const res = await withServer({ inferenceClient: client }, (url) => getMeta(url, auth(analystToken), method));
        assert.equal(res.status, 405);
        assert.equal(res.headers.get("allow"), "GET, HEAD");
        assert.equal(res.body!.error.code, "METHOD_NOT_ALLOWED");
        assert.equal(calls.length, 0);
      });
    }
  });
});
