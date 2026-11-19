import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  createInferenceCache,
  VERSION_REFRESH_MS,
  versionFingerprint,
  type CachedResourcePath,
  type InferenceCache,
} from "../../src/inferenceClient/cache.js";
import { createInferenceClient, type InferenceClient, type JsonObject } from "../../src/inferenceClient/client.js";
import { InferenceError, inferenceUnavailable } from "../../src/inferenceClient/errors.js";
import { InvalidVersionResponseError } from "../../src/mappers/versionResponse.js";
import { captureLogger, silentLogger } from "../helpers/server.js";

// The shared inference GET cache (API contract §3.1, §5), against a fake client
// and a fake clock: no network and no real waiting.

// Test data shaped after §2.2, not a fixture.
function versionBody(): JsonObject {
  return {
    api_version: "v1",
    engine_version: "0.1.0",
    phase1_baseline_tag: "phase1-complete",
    git_commit: "bc9905e",
    default_policy: "waterfall",
    policies: [{ policy: "waterfall", status: "default", enabled: true }],
    checkpoint: null,
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
    runtime: { platform: "linux-x86_64", python: "3.10.11", torch: "2.13.0+cpu", device: "cpu", lock_file: "x" },
  };
}

const RESOURCES: CachedResourcePath[] = ["/v1/network", "/v1/replay/calendar", "/v1/scenarios"];

/** A deferred answer, resolved or rejected by the test. */
interface Pending {
  path: string;
  requestId: string | undefined;
  resolve: (body: JsonObject) => void;
  reject: (error: Error) => void;
}

/**
 * A fake client. By default each GET answers at once from `answer`; with
 * `manual` set, each call waits in `pending` until the test settles it.
 */
function fakeClient() {
  const calls: Array<{ path: string; requestId: string | undefined }> = [];
  const pending: Pending[] = [];
  const state = {
    manual: false,
    version: versionBody(),
    // Resource bodies carry a counter, so a re-fetch is visible.
    served: 0,
    fail: new Set<string>(),
  };
  const client: InferenceClient = {
    mode: "live",
    async get(path, { requestId } = {}) {
      calls.push({ path, requestId });
      if (state.manual) {
        return new Promise<JsonObject>((resolve, reject) => pending.push({ path, requestId, resolve, reject }));
      }
      if (state.fail.has(path)) throw inferenceUnavailable("unreachable");
      if (path === "/v1/version") return structuredClone(state.version);
      state.served += 1;
      return { path, serial: state.served };
    },
    async post() {
      throw new Error("not used");
    },
    async health() {
      throw new Error("not used");
    },
  };
  const count = (path: string) => calls.filter((c) => c.path === path).length;
  return { client, calls, pending, state, count };
}

function fakeClock(start = 1_000_000) {
  const clock = { time: start, now: () => clock.time, advance: (ms: number) => (clock.time += ms) };
  return clock;
}

describe("inference cache: version", () => {
  let fake: ReturnType<typeof fakeClient>;
  let clock: ReturnType<typeof fakeClock>;
  let cache: InferenceCache;
  beforeEach(() => {
    fake = fakeClient();
    clock = fakeClock();
    cache = createInferenceCache(fake.client, { now: clock.now });
  });

  it("fetches nothing until first used (lazy)", () => {
    assert.equal(fake.calls.length, 0);
  });

  it("fetches /v1/version on first use, then serves it from the cache", async () => {
    assert.deepEqual(await cache.version("r1"), versionBody());
    assert.deepEqual(await cache.version("r2"), versionBody());
    assert.deepEqual(fake.calls, [{ path: "/v1/version", requestId: "r1" }]);
  });

  it("refreshes after exactly 30 seconds, and not before", async () => {
    assert.equal(VERSION_REFRESH_MS, 30_000);
    await cache.version();
    clock.advance(29_999);
    await cache.version();
    assert.equal(fake.count("/v1/version"), 1);
    clock.advance(1);
    await cache.version();
    assert.equal(fake.count("/v1/version"), 2);
    // The interval restarts from the refresh.
    clock.advance(29_999);
    await cache.version();
    assert.equal(fake.count("/v1/version"), 2);
  });

  it("returns copies, so a caller can't change the cached body", async () => {
    const first = await cache.version();
    (first.data as JsonObject).daily_state_sha256 = "changed";
    first.git_commit = "changed";
    assert.deepEqual(await cache.version(), versionBody());
  });

  it("does not cache a failed fetch, and propagates the error", async () => {
    fake.state.fail.add("/v1/version");
    await assert.rejects(cache.version(), (e) => e instanceof InferenceError && e.code === "INFERENCE_UNAVAILABLE");
    await assert.rejects(cache.version(), InferenceError);
    assert.equal(fake.count("/v1/version"), 2);
    fake.state.fail.delete("/v1/version");
    assert.deepEqual(await cache.version(), versionBody());
    assert.equal(fake.count("/v1/version"), 3);
  });

  it("propagates a failed refresh instead of serving the expired version", async () => {
    await cache.version();
    clock.advance(VERSION_REFRESH_MS);
    fake.state.fail.add("/v1/version");
    await assert.rejects(cache.version(), InferenceError);
  });

  it("shares one in-flight fetch between concurrent callers", async () => {
    fake.state.manual = true;
    const callers = [cache.version("a"), cache.version("b"), cache.version("c")];
    await Promise.resolve();
    assert.equal(fake.pending.length, 1);
    assert.equal(fake.pending[0]!.requestId, "a"); // the first caller's request ID
    fake.pending[0]!.resolve(versionBody());
    for (const body of await Promise.all(callers)) assert.deepEqual(body, versionBody());
    assert.equal(fake.count("/v1/version"), 1);
  });

  it("shares a failing in-flight fetch too, then retries on the next call", async () => {
    fake.state.manual = true;
    const callers = [cache.version(), cache.version()];
    await Promise.resolve();
    fake.pending[0]!.reject(inferenceUnavailable("timeout"));
    for (const result of await Promise.allSettled(callers)) assert.equal(result.status, "rejected");
    const next = cache.version();
    await Promise.resolve();
    assert.equal(fake.pending.length, 2);
    fake.pending[1]!.resolve(versionBody());
    assert.deepEqual(await next, versionBody());
  });
});

describe("inference cache: resources", () => {
  let fake: ReturnType<typeof fakeClient>;
  let clock: ReturnType<typeof fakeClock>;
  let cache: InferenceCache;
  beforeEach(() => {
    fake = fakeClient();
    clock = fakeClock();
    cache = createInferenceCache(fake.client, { now: clock.now });
  });

  for (const path of RESOURCES) {
    it(`${path}: checks the version first, fetches once, then serves from the cache`, async () => {
      const first = await cache.get(path, "r1");
      assert.deepEqual(await cache.get(path, "r2"), first);
      assert.deepEqual(fake.calls, [
        { path: "/v1/version", requestId: "r1" },
        { path, requestId: "r1" },
      ]);
    });
  }

  it("caches each resource separately", async () => {
    for (const path of RESOURCES) await cache.get(path);
    for (const path of RESOURCES) await cache.get(path);
    for (const path of RESOURCES) assert.equal(fake.count(path), 1);
    assert.equal(fake.count("/v1/version"), 1);
  });

  it("keeps resources across a refresh when the fingerprint is unchanged", async () => {
    for (const path of RESOURCES) await cache.get(path);
    clock.advance(VERSION_REFRESH_MS);
    // Fields outside the fingerprint may change without invalidating anything.
    fake.state.version.api_version = "v1-other";
    fake.state.version.policies = [];
    fake.state.version.runtime = { device: "cuda" };
    (fake.state.version.data as JsonObject).date_range = { start: "2011-01-01", end: "2026-01-01" };
    (fake.state.version.knowledge as JsonObject).knowledge_version = "other";
    for (const path of RESOURCES) await cache.get(path);
    assert.equal(fake.count("/v1/version"), 2);
    for (const path of RESOURCES) assert.equal(fake.count(path), 1);
    // The refreshed version body is served, though.
    assert.equal((await cache.version()).api_version, "v1-other");
  });

  it("invalidates all three resources when the fingerprint changes", async () => {
    const before = new Map<string, JsonObject>();
    for (const path of RESOURCES) before.set(path, await cache.get(path));
    clock.advance(VERSION_REFRESH_MS);
    fake.state.version.engine_version = "0.2.0";
    for (const path of RESOURCES) {
      const after = await cache.get(path);
      assert.notDeepEqual(after, before.get(path), path);
      assert.equal(fake.count(path), 2, path);
    }
    // And they are cached again under the new fingerprint.
    for (const path of RESOURCES) await cache.get(path);
    for (const path of RESOURCES) assert.equal(fake.count(path), 2, path);
  });

  it("invalidates when cache.version() performs the refresh, not only get()", async () => {
    await cache.get("/v1/scenarios");
    clock.advance(VERSION_REFRESH_MS);
    fake.state.version.git_commit = "fffffff";
    await cache.version();
    await cache.get("/v1/scenarios");
    assert.equal(fake.count("/v1/scenarios"), 2);
  });

  it("serves no cached resource when the version refresh fails, and keeps failing until it succeeds", async () => {
    for (const path of RESOURCES) await cache.get(path);
    clock.advance(VERSION_REFRESH_MS);
    fake.state.fail.add("/v1/version");
    for (const path of RESOURCES) {
      await assert.rejects(cache.get(path), (e) => e instanceof InferenceError && e.code === "INFERENCE_UNAVAILABLE");
    }
    for (const path of RESOURCES) assert.equal(fake.count(path), 1, "no resource fetch after a failed refresh");
    fake.state.fail.delete("/v1/version");
    for (const path of RESOURCES) await cache.get(path);
    // Same fingerprint after recovery, so the entries are still valid.
    for (const path of RESOURCES) assert.equal(fake.count(path), 1);
  });

  it("does not cache a failed resource fetch", async () => {
    fake.state.fail.add("/v1/network");
    await assert.rejects(cache.get("/v1/network"), InferenceError);
    await assert.rejects(cache.get("/v1/network"), InferenceError);
    assert.equal(fake.count("/v1/network"), 2);
    fake.state.fail.delete("/v1/network");
    await cache.get("/v1/network");
    await cache.get("/v1/network");
    assert.equal(fake.count("/v1/network"), 3);
    assert.equal(fake.count("/v1/version"), 1);
  });

  it("shares one in-flight fetch per resource between concurrent callers", async () => {
    await cache.version(); // version cached, so callers go straight to the resource
    fake.state.manual = true;
    const callers = [cache.get("/v1/network", "a"), cache.get("/v1/network", "b"), cache.get("/v1/scenarios", "c")];
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      fake.pending.map((p) => [p.path, p.requestId]),
      [
        ["/v1/network", "a"],
        ["/v1/scenarios", "c"],
      ],
    );
    fake.pending[0]!.resolve({ net: 1 });
    fake.pending[1]!.resolve({ scen: 1 });
    assert.deepEqual(await Promise.all(callers), [{ net: 1 }, { net: 1 }, { scen: 1 }]);
  });

  it("shares the version fetch between concurrent resource callers", async () => {
    fake.state.manual = true;
    const callers = [cache.get("/v1/network"), cache.get("/v1/replay/calendar"), cache.version()];
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(fake.pending.map((p) => p.path), ["/v1/version"]);
    fake.pending[0]!.resolve(versionBody());
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(fake.pending.slice(1).map((p) => p.path), ["/v1/network", "/v1/replay/calendar"]);
    fake.pending[1]!.resolve({ net: 1 });
    fake.pending[2]!.resolve({ cal: 1 });
    assert.deepEqual(await Promise.all(callers), [{ net: 1 }, { cal: 1 }, versionBody()]);
  });

  it("does not store a resource fetched under a fingerprint that changed mid-fetch", async () => {
    await cache.version();
    fake.state.manual = true;
    const slow = cache.get("/v1/network");
    await new Promise((resolve) => setImmediate(resolve));
    // A version refresh with a new fingerprint completes while the fetch is in flight.
    clock.advance(VERSION_REFRESH_MS);
    const refresh = cache.version();
    await new Promise((resolve) => setImmediate(resolve));
    const changed = versionBody();
    changed.engine_version = "0.2.0";
    fake.pending[1]!.resolve(changed);
    await refresh;
    fake.pending[0]!.resolve({ net: "old" });
    assert.deepEqual(await slow, { net: "old" }); // its own caller still gets it
    const fresh = cache.get("/v1/network");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fake.pending.length, 3, "re-fetched, not served from the old fingerprint");
    fake.pending[2]!.resolve({ net: "new" });
    assert.deepEqual(await fresh, { net: "new" });
  });

  it("returns copies of resources", async () => {
    const first = await cache.get("/v1/network");
    first.serial = 999;
    assert.notEqual((await cache.get("/v1/network")).serial, 999);
  });
});

describe("versionFingerprint (§5)", () => {
  // Each mutation changes exactly one of the eleven fields.
  const changes: Array<[string, (v: JsonObject) => void]> = [
    ["git_commit", (v) => (v.git_commit = "0000000")],
    ["engine_version", (v) => (v.engine_version = "0.1.1")],
    ["reward_weights.lambda_latency", (v) => ((v.reward_weights as JsonObject).lambda_latency = 2.0)],
    ["reward_weights.lambda_risk", (v) => ((v.reward_weights as JsonObject).lambda_risk = 0.5)],
    ["reward_weights.lambda_unrouted", (v) => ((v.reward_weights as JsonObject).lambda_unrouted = 1.5)],
    ["reward_weights.status", (v) => ((v.reward_weights as JsonObject).status = "calibrated")],
    ["reward_weights (added key)", (v) => ((v.reward_weights as JsonObject).lambda_new = 1.0)],
    ["knowledge.sha256", (v) => ((v.knowledge as JsonObject).sha256 = "c".repeat(64))],
    ["data.daily_state_sha256", (v) => ((v.data as JsonObject).daily_state_sha256 = "f".repeat(64))],
    ["data.bridge_network_sha256", (v) => ((v.data as JsonObject).bridge_network_sha256 = "f".repeat(64))],
    ["data.normalization_stats_sha256", (v) => ((v.data as JsonObject).normalization_stats_sha256 = "f".repeat(64))],
    ["data.macro_risk_proxy_sha256", (v) => ((v.data as JsonObject).macro_risk_proxy_sha256 = "f".repeat(64))],
    ["data.rpw_corridor_quarterly_sha256", (v) => ((v.data as JsonObject).rpw_corridor_quarterly_sha256 = "f".repeat(64))],
    ["data.scenarios_sha256", (v) => ((v.data as JsonObject).scenarios_sha256 = "f".repeat(64))],
    ["checkpoint null -> enabled", (v) => (v.checkpoint = { checkpoint_id: "c", sha256: "a".repeat(64) })],
  ];
  for (const [label, change] of changes) {
    it(`changes with ${label}`, () => {
      const changed = versionBody();
      change(changed);
      assert.notEqual(versionFingerprint(changed), versionFingerprint(versionBody()));
    });
  }

  it("changes with checkpoint enabled -> null, and with checkpoint.sha256", () => {
    const enabled = { ...versionBody(), checkpoint: { checkpoint_id: "c", sha256: "a".repeat(64) } };
    const other = { ...versionBody(), checkpoint: { checkpoint_id: "c", sha256: "b".repeat(64) } };
    assert.notEqual(versionFingerprint(enabled), versionFingerprint(versionBody()));
    assert.notEqual(versionFingerprint(enabled), versionFingerprint(other));
  });

  it("ignores other checkpoint fields, and every field outside the eleven", () => {
    const a = { ...versionBody(), checkpoint: { checkpoint_id: "c1", sha256: "a".repeat(64), approved_by: "x" } };
    const b = { ...versionBody(), checkpoint: { checkpoint_id: "c2", sha256: "a".repeat(64), approved_by: "y" } };
    assert.equal(versionFingerprint(a), versionFingerprint(b));
    const c = versionBody();
    c.api_version = "v2";
    c.phase1_baseline_tag = "other";
    c.default_policy = "cheapest_feasible";
    c.policies = [];
    c.runtime = {};
    (c.knowledge as JsonObject).knowledge_version = "other";
    (c.data as JsonObject).date_range = {};
    assert.equal(versionFingerprint(c), versionFingerprint(versionBody()));
  });

  it("ignores key order inside reward_weights", () => {
    const reordered = versionBody();
    reordered.reward_weights = { status: "placeholder", lambda_unrouted: 1.0, lambda_risk: 1.0, lambda_latency: 1.0 };
    assert.equal(versionFingerprint(reordered), versionFingerprint(versionBody()));
  });

  it("keeps a missing field distinct from null", () => {
    const missing = versionBody();
    delete missing.checkpoint;
    assert.notEqual(versionFingerprint(missing), versionFingerprint(versionBody()));
  });

  it("invalidates cached resources for every listed change, end to end", async () => {
    for (const [label, change] of [
      ...changes,
      ["checkpoint enabled -> null", (v: JsonObject) => (v.checkpoint = null)] as [string, (v: JsonObject) => void],
    ]) {
      const fake = fakeClient();
      const clock = fakeClock();
      const cache = createInferenceCache(fake.client, { now: clock.now });
      if (label === "checkpoint enabled -> null") fake.state.version.checkpoint = { sha256: "a".repeat(64) };
      for (const path of RESOURCES) await cache.get(path);
      clock.advance(VERSION_REFRESH_MS);
      change(fake.state.version);
      for (const path of RESOURCES) await cache.get(path);
      for (const path of RESOURCES) assert.equal(fake.count(path), 2, `${label}: ${path}`);
    }
  });
});

describe("inference cache in mock mode", () => {
  it("caches through the mock client, with no fixtures: failures propagate and aren't cached", async () => {
    // No mock handler: the client answers every call with INFERENCE_UNAVAILABLE.
    const client = createInferenceClient(
      { url: "http://inference.invalid", mode: "mock", timeoutMs: 1000 },
      { logger: silentLogger },
    );
    const cache = createInferenceCache(client);
    await assert.rejects(cache.version(), (e) => e instanceof InferenceError && e.code === "INFERENCE_UNAVAILABLE");
    await assert.rejects(cache.get("/v1/network"), (e) => e instanceof InferenceError && e.code === "INFERENCE_UNAVAILABLE");
  });

  it("caches mock answers the same way as live ones", async () => {
    const paths: string[] = [];
    const client = createInferenceClient(
      { url: "http://inference.invalid", mode: "mock", timeoutMs: 1000 },
      {
        logger: silentLogger,
        // A test handler, not a fixture.
        mockHandler: (request) => {
          paths.push(request.path);
          return { status: 200, body: request.path === "/v1/version" ? versionBody() : { path: request.path } };
        },
      },
    );
    const clock = fakeClock();
    const cache = createInferenceCache(client, { now: clock.now });
    await cache.get("/v1/scenarios");
    await cache.get("/v1/scenarios");
    clock.advance(VERSION_REFRESH_MS);
    await cache.get("/v1/scenarios");
    assert.deepEqual(paths, ["/v1/version", "/v1/scenarios", "/v1/version"]);
  });
});

describe("inference cache: malformed /v1/version 200 bodies", () => {
  const malformed = (): JsonObject => {
    const body = versionBody();
    delete (body.data as JsonObject).scenarios_sha256;
    return body;
  };
  const isInvalid = (e: unknown) =>
    e instanceof InvalidVersionResponseError && e.status === 502 && e.code === "INFERENCE_ERROR";

  it("rejects a malformed first response with 502 INFERENCE_ERROR, does not cache it, and retries at once", async () => {
    const fake = fakeClient();
    const clock = fakeClock();
    const cache = createInferenceCache(fake.client, { now: clock.now });
    fake.state.version = malformed();
    await assert.rejects(cache.version(), isInvalid);
    // Same instant: no 30 s wait before the retry.
    await assert.rejects(cache.version(), isInvalid);
    assert.equal(fake.count("/v1/version"), 2);
    fake.state.version = versionBody();
    assert.deepEqual(await cache.version(), versionBody());
    assert.equal(fake.count("/v1/version"), 3);
    // The valid body is cached normally.
    await cache.version();
    assert.equal(fake.count("/v1/version"), 3);
  });

  it("fetches no resource when the version is malformed, then serves them after a valid retry", async () => {
    const fake = fakeClient();
    const cache = createInferenceCache(fake.client, { now: fakeClock().now });
    fake.state.version = malformed();
    for (const path of RESOURCES) await assert.rejects(cache.get(path), isInvalid);
    for (const path of RESOURCES) assert.equal(fake.count(path), 0, path);
    fake.state.version = versionBody();
    for (const path of RESOURCES) await cache.get(path);
    for (const path of RESOURCES) assert.equal(fake.count(path), 1, path);
  });

  it("on a malformed refresh: serves neither the old version nor cached resources, and retries at once", async () => {
    const fake = fakeClient();
    const clock = fakeClock();
    const cache = createInferenceCache(fake.client, { now: clock.now });
    for (const path of RESOURCES) await cache.get(path);
    clock.advance(VERSION_REFRESH_MS);
    fake.state.version = malformed();
    await assert.rejects(cache.version(), isInvalid);
    for (const path of RESOURCES) await assert.rejects(cache.get(path), isInvalid);
    assert.equal(fake.count("/v1/version"), 5);
    // A valid retry, with the old fingerprint: the resources stay valid.
    fake.state.version = versionBody();
    for (const path of RESOURCES) await cache.get(path);
    assert.equal(fake.count("/v1/version"), 6);
    for (const path of RESOURCES) assert.equal(fake.count(path), 1, path);
  });

  it("a malformed body never becomes the fingerprint baseline", async () => {
    const fake = fakeClient();
    const clock = fakeClock();
    const cache = createInferenceCache(fake.client, { now: clock.now });
    await cache.get("/v1/network");
    clock.advance(VERSION_REFRESH_MS);
    fake.state.version = malformed();
    await assert.rejects(cache.get("/v1/network"), isInvalid);
    // The next valid body is compared with the last valid one (unchanged), not the malformed one.
    fake.state.version = versionBody();
    await cache.get("/v1/network");
    assert.equal(fake.count("/v1/network"), 1);
  });

  it("shares a malformed in-flight fetch between concurrent callers, all rejected", async () => {
    const fake = fakeClient();
    const cache = createInferenceCache(fake.client, { now: fakeClock().now });
    fake.state.manual = true;
    const callers = [cache.version(), cache.get("/v1/network"), cache.version()];
    await Promise.resolve();
    assert.equal(fake.pending.length, 1);
    fake.pending[0]!.resolve(malformed());
    for (const result of await Promise.allSettled(callers)) {
      assert.equal(result.status, "rejected");
      assert.ok(isInvalid((result as PromiseRejectedResult).reason));
    }
    assert.equal(fake.count("/v1/network"), 0);
  });

  it("logs the rejected field paths, never values", async () => {
    const fake = fakeClient();
    const capture = captureLogger();
    const cache = createInferenceCache(fake.client, { now: fakeClock().now, logger: capture.logger });
    fake.state.version = { ...versionBody(), git_commit: "", checkpoint: { sha256: "SECRET-VALUE" } };
    await assert.rejects(cache.version("bad-version"), isInvalid);
    const entry = capture.entries().find((e) => e.msg === "inference response rejected");
    assert.deepEqual(
      { requestId: entry?.requestId, path: entry?.path, problems: entry?.problems },
      { requestId: "bad-version", path: "/v1/version", problems: ["git_commit", "checkpoint.sha256"] },
    );
    assert.doesNotMatch(capture.lines.join("\n"), /SECRET-VALUE/);
  });
});
