import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { createApp } from "../../src/app.js";
import type { DevUser } from "../../src/config/devTokens.js";
import { createInferenceCache, VERSION_REFRESH_MS } from "../../src/inferenceClient/cache.js";
import { createInferenceClient, type InferenceClient } from "../../src/inferenceClient/client.js";
import { newToken, sha256Hex } from "../helpers/devTokens.js";
import { engineVersionBody } from "../helpers/version.js";
import { captureLogger, silentLogger, startServer } from "../helpers/server.js";

// The calendar body is test data shaped after API contract §2.6, not a fixture.
const engineCalendar = {
  start: "2011-01-01",
  end: "2025-09-30",
  splits: {
    train: { start: "2011-01-01", end: "2021-12-31" },
    validation: { start: "2022-01-01", end: "2023-12-31" },
    test: { start: "2024-01-01", end: "2025-09-30" },
  },
  gap_buffer_days: 30,
  excluded_ranges: [
    { start: "2011-01-01", end: "2011-01-31" },
    { start: "2021-12-02", end: "2022-01-31" },
  ],
  note: "Synthetic daily bridge state. Not real CBDC telemetry. No data after 2025-09-30.",
};
const appCalendar = {
  start: "2011-01-01",
  end: "2025-09-30",
  splits: engineCalendar.splits,
  gapBufferDays: 30,
  excludedRanges: engineCalendar.excluded_ranges,
  note: engineCalendar.note,
};

const analystToken = newToken();
const viewerToken = newToken();
const users: DevUser[] = [
  { userId: "u-analyst-1", email: "analyst@example.test", role: "analyst", tokenSha256: sha256Hex(analystToken) },
  { userId: "u-viewer-1", email: "viewer@example.test", role: "viewer", tokenSha256: sha256Hex(viewerToken) },
];
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// A fake inference service. /v1/version (read first, by the shared cache) is
// answered by respondVersion, everything else by respond.
let received: Array<{ method: string; url: string; headers: IncomingHttpHeaders }> = [];
let respond: (res: ServerResponse) => void;
let respondVersion: (res: ServerResponse) => void;
const fake = createServer((req, res) => {
  received.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
  if (req.url === "/v1/version") respondVersion(res);
  else respond(res);
});
let fakeUrl: string;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function client(mode: "live" | "mock" = "live", timeoutMs = 2000): InferenceClient {
  return createInferenceClient({ url: fakeUrl, mode, timeoutMs }, { logger: silentLogger });
}

/** Calls the backend once and returns the status, headers and body text. */
async function call(
  inferenceClient: InferenceClient | undefined,
  init: { path?: string; method?: string; headers?: Record<string, string> } = {},
  logger = silentLogger,
): Promise<{ status: number; headers: Headers; text: string }> {
  const server = await startServer(createApp({ logger, users, inferenceClient }));
  try {
    const res = await fetch(`${server.baseUrl}${init.path ?? "/api/v1/replay/calendar"}`, {
      method: init.method ?? "GET",
      headers: init.headers,
    });
    return { status: res.status, headers: res.headers, text: await res.text() };
  } finally {
    await server.close();
  }
}

describe("GET /api/v1/replay/calendar", () => {
  before(async () => {
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  });

  after(async () => {
    fake.closeAllConnections();
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  });

  beforeEach(() => {
    received = [];
    respond = (res) => json(res, 200, engineCalendar);
    respondVersion = (res) => json(res, 200, engineVersionBody());
  });

  describe("authentication", () => {
    for (const [label, headers] of [
      ["no Authorization header", {}],
      ["a malformed token", { Authorization: "Bearer not-a-token" }],
      ["an unknown token", auth(newToken())],
    ] as const) {
      it(`returns 401 UNAUTHENTICATED for ${label}, without calling inference`, async () => {
        const res = await call(client(), { headers });
        assert.equal(res.status, 401);
        assert.equal((JSON.parse(res.text) as { error: { code: string } }).error.code, "UNAUTHENTICATED");
        assert.equal(received.length, 0);
      });
    }

    for (const [role, token] of [
      ["analyst", analystToken],
      ["viewer", viewerToken],
    ] as const) {
      it(`returns 200 for a ${role}`, async () => {
        const res = await call(client(), { headers: auth(token) });
        assert.equal(res.status, 200);
        assert.deepEqual(JSON.parse(res.text), appCalendar);
      });
    }
  });

  describe("inference call and mapping", () => {
    it("returns the camelCase mapping of the inference body, values unchanged", async () => {
      const res = await call(client(), { headers: auth(viewerToken) });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
      assert.deepEqual(JSON.parse(res.text), appCalendar);
    });

    it("keeps and maps unknown fields", async () => {
      respond = (res) => json(res, 200, { ...engineCalendar, future_field: { nested_value: "keep_me" } });
      const res = await call(client(), { headers: auth(viewerToken) });
      assert.deepEqual(JSON.parse(res.text), { ...appCalendar, futureField: { nestedValue: "keep_me" } });
    });

    it("calls GET /v1/version (the §5 cache check) then GET /v1/replay/calendar once each, forwarding the request ID and no Authorization", async () => {
      const res = await call(client(), { headers: { ...auth(analystToken), "X-Request-Id": "cal-req-1" } });
      assert.equal(res.headers.get("x-request-id"), "cal-req-1");
      assert.deepEqual(
        received.map((r) => [r.method, r.url]),
        [
          ["GET", "/v1/version"],
          ["GET", "/v1/replay/calendar"],
        ],
      );
      for (const r of received) {
        assert.equal(r.headers["x-request-id"], "cal-req-1");
        assert.equal(r.headers.authorization, undefined);
        assert.equal(r.headers.cookie, undefined);
      }
    });

    it("forwards the generated request ID when the caller sends none", async () => {
      const res = await call(client(), { headers: auth(viewerToken) });
      const generated = res.headers.get("x-request-id");
      assert.ok(generated);
      assert.equal(received[0]!.headers["x-request-id"], generated);
    });

    it("ignores query parameters and does not forward them", async () => {
      const res = await call(client(), {
        path: "/api/v1/replay/calendar?corridor=GBR-%3EPHL&date=2024-06-14&token=abc",
        headers: auth(viewerToken),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.text), appCalendar);
      assert.deepEqual(
        received.map((r) => r.url),
        ["/v1/version", "/v1/replay/calendar"],
      );
    });

    it("returns a controlled 502 INFERENCE_ERROR when two keys collide, logging no key names", async () => {
      respond = (res) => json(res, 200, { ...engineCalendar, gapBufferDays: 30 });
      const capture = captureLogger();
      const res = await call(client(), { headers: { ...auth(viewerToken), "X-Request-Id": "collide" } }, capture.logger);
      assert.equal(res.status, 502);
      assert.deepEqual(JSON.parse(res.text), {
        error: {
          code: "INFERENCE_ERROR",
          message: "The inference service returned an invalid response.",
          details: {},
          requestId: "collide",
        },
      });
      const warning = capture.entries().find((e) => e.msg === "inference response could not be mapped");
      assert.deepEqual(
        { requestId: warning?.requestId, path: warning?.path, reason: warning?.reason },
        { requestId: "collide", path: "/v1/replay/calendar", reason: "key_collision" },
      );
      assert.doesNotMatch(capture.lines.join("\n"), /gapBufferDays|gap_buffer_days/);
    });
  });

  describe("cache (§3.1, §5)", () => {
    // Version bodies with a controllable fingerprint field; each calendar fetch gets a serial.
    let engineVersion: Record<string, unknown> = engineVersionBody();
    let calendarSerial = 0;
    beforeEach(() => {
      engineVersion = engineVersionBody();
      calendarSerial = 0;
      respondVersion = (res) => json(res, 200, engineVersion);
      respond = (res) => json(res, 200, { ...engineCalendar, note: `serial-${++calendarSerial}` });
    });

    async function sharedApp() {
      const clock = { time: 0 };
      const inferenceClient = client();
      const inferenceCache = createInferenceCache(inferenceClient, { now: () => clock.time });
      const server = await startServer(createApp({ logger: silentLogger, users, inferenceClient, inferenceCache }));
      const get = async () => {
        const res = await fetch(`${server.baseUrl}/api/v1/replay/calendar`, { headers: auth(viewerToken) });
        const text = await res.text();
        return { status: res.status, body: JSON.parse(text) as Record<string, any> };
      };
      return { clock, get, close: server.close };
    }
    const urls = () => received.map((r) => r.url);

    it("serves the calendar from the cache on the second call", async () => {
      const app = await sharedApp();
      try {
        const first = await app.get();
        const second = await app.get();
        assert.equal(first.status, 200);
        assert.deepEqual(second.body, first.body);
        assert.equal(second.body.note, "serial-1");
        assert.deepEqual(urls(), ["/v1/version", "/v1/replay/calendar"]);
      } finally {
        await app.close();
      }
    });

    it("re-checks the version after 30 s and keeps the calendar when the fingerprint is unchanged", async () => {
      const app = await sharedApp();
      try {
        await app.get();
        app.clock.time = VERSION_REFRESH_MS - 1;
        await app.get();
        assert.deepEqual(urls(), ["/v1/version", "/v1/replay/calendar"]);
        app.clock.time = VERSION_REFRESH_MS;
        assert.equal((await app.get()).body.note, "serial-1");
        assert.deepEqual(urls(), ["/v1/version", "/v1/replay/calendar", "/v1/version"]);
      } finally {
        await app.close();
      }
    });

    it("re-fetches the calendar when the fingerprint changes", async () => {
      const app = await sharedApp();
      try {
        await app.get();
        engineVersion = engineVersionBody({ engine_version: "0.2.0" });
        app.clock.time = VERSION_REFRESH_MS;
        assert.equal((await app.get()).body.note, "serial-2");
        assert.deepEqual(urls(), ["/v1/version", "/v1/replay/calendar", "/v1/version", "/v1/replay/calendar"]);
      } finally {
        await app.close();
      }
    });

    it("serves no cached calendar after a failed version refresh", async () => {
      const app = await sharedApp();
      try {
        await app.get();
        respondVersion = (res) => json(res, 500, { error: { code: "INTERNAL_ERROR", message: "x" } });
        app.clock.time = VERSION_REFRESH_MS;
        const res = await app.get();
        assert.equal(res.status, 502);
        assert.equal(res.body.error.code, "INFERENCE_ERROR");
        assert.deepEqual(urls(), ["/v1/version", "/v1/replay/calendar", "/v1/version"]);
      } finally {
        await app.close();
      }
    });

    it("returns 502 for a malformed 200 /v1/version without fetching the calendar, and retries at once", async () => {
      const app = await sharedApp();
      try {
        respondVersion = (res) => json(res, 200, engineVersionBody({ checkpoint: "not-an-object" }));
        const bad = await app.get();
        assert.equal(bad.status, 502);
        assert.equal(bad.body.error.code, "INFERENCE_ERROR");
        assert.deepEqual(urls(), ["/v1/version"]);
        respondVersion = (res) => json(res, 200, engineVersion);
        const good = await app.get();
        assert.equal(good.status, 200);
        assert.equal(good.body.note, "serial-1");
        assert.deepEqual(urls(), ["/v1/version", "/v1/version", "/v1/replay/calendar"]);
      } finally {
        await app.close();
      }
    });

    it("serves no cached calendar after a malformed version refresh, and recovers on the next request", async () => {
      const app = await sharedApp();
      try {
        await app.get();
        app.clock.time = VERSION_REFRESH_MS;
        respondVersion = (res) => json(res, 200, engineVersionBody({ engine_version: "" }));
        assert.equal((await app.get()).status, 502);
        respondVersion = (res) => json(res, 200, engineVersion);
        const good = await app.get();
        assert.equal(good.status, 200);
        assert.equal(good.body.note, "serial-1"); // same fingerprint, so the cached calendar is valid again
        assert.deepEqual(urls(), ["/v1/version", "/v1/replay/calendar", "/v1/version", "/v1/version"]);
      } finally {
        await app.close();
      }
    });

    it("does not cache a failed calendar fetch", async () => {
      const app = await sharedApp();
      try {
        respond = (res) => json(res, 500, { error: { code: "INTERNAL_ERROR", message: "x" } });
        assert.equal((await app.get()).status, 502);
        respond = (res) => json(res, 200, engineCalendar);
        assert.equal((await app.get()).status, 200);
        assert.deepEqual(urls(), ["/v1/version", "/v1/replay/calendar", "/v1/replay/calendar"]);
      } finally {
        await app.close();
      }
    });

    it("shares one version and one calendar fetch between concurrent requests", async () => {
      const app = await sharedApp();
      try {
        const results = await Promise.all([app.get(), app.get(), app.get()]);
        for (const r of results) assert.equal(r.body.note, "serial-1");
        assert.deepEqual(urls(), ["/v1/version", "/v1/replay/calendar"]);
      } finally {
        await app.close();
      }
    });

    it("caches mock-mode answers too, with no fixtures (a test handler)", async () => {
      const paths: string[] = [];
      const mock = createInferenceClient(
        { url: fakeUrl, mode: "mock", timeoutMs: 1000 },
        {
          logger: silentLogger,
          mockHandler: (request) => {
            paths.push(request.path);
            return { status: 200, body: request.path === "/v1/version" ? engineVersion : engineCalendar };
          },
        },
      );
      // One app (one cache) for both requests.
      const server = await startServer(createApp({ logger: silentLogger, users, inferenceClient: mock }));
      try {
        for (let i = 0; i < 2; i += 1) {
          const res = await fetch(`${server.baseUrl}/api/v1/replay/calendar`, { headers: auth(viewerToken) });
          assert.equal(res.status, 200);
          assert.deepEqual(await res.json(), appCalendar);
        }
      } finally {
        await server.close();
      }
      assert.deepEqual(paths, ["/v1/version", "/v1/replay/calendar"]);
      assert.equal(received.length, 0);
    });
  });

  describe("errors", () => {
    const leaky = "Traceback: postgresql://user:pass@db token=abc";
    const cases: Array<[string, (res: ServerResponse) => void, number, string, number?]> = [
      ["inference 500", (res) => json(res, 500, { error: { code: "INTERNAL_ERROR", message: leaky } }), 502, "INFERENCE_ERROR"],
      ["a non-JSON body", (res) => res.writeHead(200, { "Content-Type": "text/html" }).end(leaky), 502, "INFERENCE_ERROR"],
      ["a JSON array", (res) => json(res, 200, [engineCalendar]), 502, "INFERENCE_ERROR"],
      ["JSON null", (res) => json(res, 200, null), 502, "INFERENCE_ERROR"],
      ["a timeout", (res) => setTimeout(() => json(res, 200, engineCalendar), 500), 503, "INFERENCE_UNAVAILABLE", 50],
    ];
    for (const [label, handler, status, code, timeoutMs] of cases) {
      it(`returns ${status} ${code} for ${label}, exposing nothing from inference`, async () => {
        respond = handler;
        const res = await call(client("live", timeoutMs), { headers: { ...auth(viewerToken), "X-Request-Id": "err-req" } });
        assert.equal(res.status, status);
        const body = JSON.parse(res.text) as { error: Record<string, unknown> };
        assert.equal(body.error.code, code);
        assert.deepEqual(body.error.details, {});
        assert.equal(body.error.requestId, "err-req");
        assert.doesNotMatch(res.text, /Traceback|postgresql|token=|NOT_READY|INTERNAL_ERROR/);
      });
    }

    it("returns 503 INFERENCE_UNAVAILABLE with cause NOT_READY and Retry-After for inference NOT_READY", async () => {
      respond = (res) => {
        res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "3" });
        res.end(JSON.stringify({ error: { code: "NOT_READY", message: leaky, details: { trace: leaky } } }));
      };
      const res = await call(client("live"), { headers: { ...auth(viewerToken), "X-Request-Id": "err-req" } });
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("retry-after"), "3");
      assert.deepEqual(JSON.parse(res.text), {
        error: {
          code: "INFERENCE_UNAVAILABLE",
          message: "The inference service is unavailable.",
          details: { cause: "NOT_READY" },
          requestId: "err-req",
        },
      });
      assert.doesNotMatch(res.text, /Traceback|postgresql|token=/);
    });

    it("returns 503 INFERENCE_UNAVAILABLE when inference is unreachable", async () => {
      const closed = createServer();
      await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
      const { port } = closed.address() as AddressInfo;
      await new Promise<void>((resolve) => closed.close(() => resolve()));
      const unreachable = createInferenceClient(
        { url: `http://127.0.0.1:${port}`, mode: "live", timeoutMs: 2000 },
        { logger: silentLogger },
      );
      const res = await call(unreachable, { headers: auth(viewerToken) });
      assert.equal(res.status, 503);
      assert.equal((JSON.parse(res.text) as { error: { code: string } }).error.code, "INFERENCE_UNAVAILABLE");
    });

    it("returns 503 INFERENCE_UNAVAILABLE in mock mode, with zero network calls", async () => {
      const res = await call(client("mock"), { headers: auth(viewerToken) });
      assert.equal(res.status, 503);
      assert.equal((JSON.parse(res.text) as { error: { code: string } }).error.code, "INFERENCE_UNAVAILABLE");
      assert.equal(received.length, 0);
    });

    it("returns 503 INFERENCE_UNAVAILABLE without an inference client", async () => {
      const res = await call(undefined, { headers: { ...auth(viewerToken), "X-Request-Id": "no-client" } });
      assert.equal(res.status, 503);
      assert.deepEqual(JSON.parse(res.text), {
        error: {
          code: "INFERENCE_UNAVAILABLE",
          message: "The inference service is unavailable.",
          details: {},
          requestId: "no-client",
        },
      });
      assert.equal(received.length, 0);
    });

    for (const method of ["POST", "PUT", "DELETE"]) {
      it(`returns 405 METHOD_NOT_ALLOWED with Allow for ${method}, without calling inference`, async () => {
        const res = await call(client(), { method, headers: auth(analystToken) });
        assert.equal(res.status, 405);
        assert.equal(res.headers.get("allow"), "GET, HEAD");
        assert.equal((JSON.parse(res.text) as { error: { code: string } }).error.code, "METHOD_NOT_ALLOWED");
        assert.equal(received.length, 0);
      });
    }
  });
});
