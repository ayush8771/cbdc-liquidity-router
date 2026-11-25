import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  classify,
  createHttpFetch,
  createPoller,
  retryAfterDelayMs,
  type FetchOutcome,
} from "../../src/observations/poller.js";
import { createObservationStore } from "../../src/observations/store.js";
import { captureLogger, silentLogger } from "../helpers/server.js";
import { FakeClock, eventAt, latestBody, sendJson, startFakeIngestion, waitFor } from "../helpers/observations.js";

const ok = (body: unknown, contentType = "application/json"): FetchOutcome => ({
  kind: "response",
  status: 200,
  contentType,
  retryAfter: undefined,
  body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
});
const status = (code: number, retryAfter?: string): FetchOutcome => ({
  kind: "response",
  status: code,
  contentType: "application/json",
  retryAfter,
  body: Buffer.from("{}"),
});

describe("poll classification (§3.1 table)", () => {
  it("a valid 200 is a success; events: [] is a success", () => {
    assert.deepEqual(classify(ok(latestBody([]))), { ok: true, events: [] });
  });

  it("accepts application/json with a charset parameter, in any letter case", () => {
    for (const type of ["application/json; charset=utf-8", "application/json;charset=UTF-8", "Application/JSON"]) {
      assert.deepEqual(classify(ok(latestBody([]), type)), { ok: true, events: [] }, type);
    }
    for (const type of ["application/jsonx", "text/json", "application/problem+json"]) {
      assert.equal(classify(ok(latestBody([]), type)).ok, false, type);
    }
  });

  it("bad body, wrong content type, invalid JSON, unknown version are failed polls at the normal interval", () => {
    for (const outcome of [
      ok("not json"),
      ok(latestBody([]), "text/html"),
      ok(latestBody([], { protocol_version: "9.0" })),
      ok([1, 2]),
      { ...ok(latestBody([])), body: Buffer.from([0xff, 0xfe]) },
    ]) {
      const v = classify(outcome);
      assert.equal(v.ok, false);
      if (!v.ok) assert.equal(v.delayMs, 500);
    }
  });

  it("3xx, 401, 403, other 4xx: contract fault, next poll after 5 s", () => {
    for (const code of [300, 301, 302, 303, 304, 307, 308, 400, 401, 403, 404, 405]) {
      assert.deepEqual(classify(status(code)), { ok: false, reason: "contract_fault", delayMs: 5000 });
    }
  });

  it("non-200 2xx is a failed poll at the normal interval (owner clarification)", () => {
    for (const code of [201, 202, 204, 206, 299]) {
      assert.deepEqual(classify(status(code)), { ok: false, reason: "bad_response", delayMs: 500 }, String(code));
    }
  });

  it("429 waits Retry-After seconds within 1–30 s, else 5 s", () => {
    assert.equal(retryAfterDelayMs(undefined), 5000);
    assert.equal(retryAfterDelayMs(""), 5000);
    assert.equal(retryAfterDelayMs("abc"), 5000);
    assert.equal(retryAfterDelayMs("-3"), 5000);
    assert.equal(retryAfterDelayMs("Wed, 21 Oct 2026 07:28:00 GMT"), 5000);
    assert.equal(retryAfterDelayMs("0"), 1000);
    assert.equal(retryAfterDelayMs("7"), 7000);
    assert.equal(retryAfterDelayMs("300"), 30000);
    assert.deepEqual(classify(status(429, "2")), { ok: false, reason: "http_429", delayMs: 2000 });
  });

  it("5xx, timeout, network error: normal interval", () => {
    for (const outcome of [status(500), status(503), { kind: "timeout" } as const, { kind: "network" } as const]) {
      const v = classify(outcome);
      assert.equal(!v.ok && v.delayMs, 500);
    }
  });
});

/** A fetch whose answers the test resolves by hand. */
function manualFetch() {
  const calls: Array<{ resolve: (o: FetchOutcome) => void; signal: AbortSignal }> = [];
  return {
    calls,
    fetch: (signal: AbortSignal) =>
      new Promise<FetchOutcome>((resolve) => {
        calls.push({ resolve, signal });
        signal.addEventListener("abort", () => resolve({ kind: "aborted" }));
      }),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("poller scheduling and source status (fake clock)", () => {
  it("never overlaps: the next poll is scheduled only after the last settles", async () => {
    const clock = new FakeClock();
    const f = manualFetch();
    const poller = createPoller({ fetch: f.fetch, store: createObservationStore({ logger: silentLogger }), logger: silentLogger, clock });
    poller.start();
    assert.equal(f.calls.length, 1);
    clock.advance(5000);
    assert.equal(f.calls.length, 1, "no second poll while one is in flight");
    assert.equal(poller.inFlight(), 1);
    f.calls[0]!.resolve(ok(latestBody([])));
    await flush();
    clock.advance(500);
    assert.equal(f.calls.length, 2);
    poller.stop();
  });

  it("starting -> ok on first success; outage after 3 consecutive failures; recovers on success", async () => {
    const clock = new FakeClock();
    const f = manualFetch();
    const statuses: string[] = [];
    const poller = createPoller({
      fetch: f.fetch,
      store: createObservationStore({ logger: silentLogger }),
      logger: silentLogger,
      clock,
      onStatus: (s) => statuses.push(s),
    });
    poller.start();
    assert.equal(poller.status(), "starting");
    f.calls[0]!.resolve(ok(latestBody([])));
    await flush();
    assert.equal(poller.status(), "ok");
    for (let i = 1; i <= 3; i += 1) {
      clock.advance(100);
      clock.advance(400);
      f.calls[i]!.resolve(status(500));
      await flush();
      assert.equal(poller.status(), i < 3 ? "ok" : "outage");
    }
    clock.advance(500);
    f.calls[4]!.resolve(ok(latestBody([])));
    await flush();
    assert.equal(poller.status(), "ok");
    assert.deepEqual(statuses, ["ok", "outage", "ok"]);
    poller.stop();
  });

  it("outage after 2 s without a success, even with fewer than 3 failures (from starting)", async () => {
    const clock = new FakeClock();
    const f = manualFetch();
    const poller = createPoller({ fetch: f.fetch, store: createObservationStore({ logger: silentLogger }), logger: silentLogger, clock });
    poller.start();
    clock.advance(1999);
    assert.equal(poller.status(), "starting");
    clock.advance(1);
    assert.equal(poller.status(), "outage");
    poller.stop();
  });

  it("outage after 2 s without a success while waiting out a 429 Retry-After", async () => {
    const clock = new FakeClock();
    const f = manualFetch();
    const poller = createPoller({ fetch: f.fetch, store: createObservationStore({ logger: silentLogger }), logger: silentLogger, clock });
    poller.start();
    f.calls[0]!.resolve(ok(latestBody([])));
    await flush();
    clock.advance(500);
    f.calls[1]!.resolve(status(429, "10"));
    await flush();
    assert.equal(poller.status(), "ok");
    clock.advance(2000);
    assert.equal(poller.status(), "outage");
    // The 429 arrived at t=500, so the next poll is due at t=10500.
    clock.advance(7999);
    assert.equal(f.calls.length, 2, "waits the full Retry-After");
    clock.advance(1);
    assert.equal(f.calls.length, 3);
    poller.stop();
  });

  it("waits 5 s after a contract fault", async () => {
    const clock = new FakeClock();
    const f = manualFetch();
    const poller = createPoller({ fetch: f.fetch, store: createObservationStore({ logger: silentLogger }), logger: silentLogger, clock });
    poller.start();
    f.calls[0]!.resolve(status(401));
    await flush();
    clock.advance(4999);
    assert.equal(f.calls.length, 1);
    clock.advance(1);
    assert.equal(f.calls.length, 2);
    poller.stop();
  });

  it("applies valid events, emitting one update each, and rejects only the invalid ones", async () => {
    const clock = new FakeClock();
    const f = manualFetch();
    const updates: string[] = [];
    const store = createObservationStore({ logger: silentLogger });
    const poller = createPoller({ fetch: f.fetch, store, logger: silentLogger, clock, onUpdate: (u) => updates.push(u.pair) });
    poller.start();
    const t = clock.now();
    const eur = eventAt(t, { base: "EUR", quote: "USD" });
    const usd = eventAt(t);
    f.calls[0]!.resolve(ok(latestBody([eur, { broken: true }, usd])));
    await flush();
    assert.deepEqual(updates, ["EUR/USD", "USD/INR"]);
    assert.equal(poller.status(), "ok", "some invalid events still make a successful poll");
    // The same events delivered again on the next two polls (normal for
    // polling): duplicates, no further update.
    for (const i of [1, 2]) {
      clock.advance(500);
      assert.equal(f.calls.length, i + 1);
      f.calls[i]!.resolve(ok(latestBody([eur, usd])));
      await flush();
    }
    assert.deepEqual(updates, ["EUR/USD", "USD/INR"], "no update for a redelivered event");
    assert.equal(store.counters().duplicate, 4);
    assert.equal(store.counters().accepted, 2);
    poller.stop();
  });

  it("stop() aborts the request in flight and clears every timer", async () => {
    const clock = new FakeClock();
    const f = manualFetch();
    const poller = createPoller({ fetch: f.fetch, store: createObservationStore({ logger: silentLogger }), logger: silentLogger, clock });
    poller.start();
    poller.stop();
    assert.equal(f.calls[0]!.signal.aborted, true);
    await flush();
    assert.equal(clock.pending(), 0);
    clock.advance(60000);
    assert.equal(f.calls.length, 1);
    poller.stop();
  });

  it("logs failure reasons once per change, without bodies", async () => {
    const clock = new FakeClock();
    const f = manualFetch();
    const capture = captureLogger();
    const poller = createPoller({ fetch: f.fetch, store: createObservationStore({ logger: silentLogger }), logger: capture.logger, clock });
    poller.start();
    for (let i = 0; i < 4; i += 1) {
      f.calls[i]!.resolve(ok("SECRET-BODY"));
      await flush();
      clock.advance(500);
    }
    const failures = capture.entries().filter((e) => e.msg === "observation poll failed");
    assert.equal(failures.length, 1);
    assert.ok(!capture.lines.join("").includes("SECRET-BODY"));
    poller.stop();
  });
});

describe("poll HTTP client against a fake ingestion server", async () => {
  const servers: Array<{ close: () => Promise<void> }> = [];
  after(async () => {
    for (const s of servers) await s.close();
  });

  async function fetchOnce(handler: Parameters<typeof startFakeIngestion>[0], deadlineMs = 400) {
    const server = await startFakeIngestion(handler);
    servers.push(server);
    const http = createHttpFetch(server.url, { deadlineMs });
    try {
      return { outcome: await http.fetch(new AbortController().signal), server };
    } finally {
      http.close();
    }
  }

  it("accepts a real response sent as application/json; charset=utf-8", async () => {
    const { outcome } = await fetchOnce((_req, res) =>
      sendJson(res, 200, latestBody([]), { "Content-Type": "application/json; charset=utf-8" }),
    );
    assert.deepEqual(classify(outcome), { ok: true, events: [] });
  });

  it("requests GET /v1/latest with no credentials or query", async () => {
    let seen: { method?: string; url?: string; auth?: string } = {};
    const { outcome } = await fetchOnce((req, res) => {
      seen = { method: req.method, url: req.url, auth: req.headers.authorization };
      sendJson(res, 200, latestBody([]));
    });
    assert.deepEqual(seen, { method: "GET", url: "/v1/latest", auth: undefined });
    assert.equal(classify(outcome).ok, true);
  });

  it("successful and empty responses", async () => {
    const { outcome } = await fetchOnce((_req, res) => sendJson(res, 200, latestBody([eventAt(Date.now())])));
    const v = classify(outcome);
    assert.equal(v.ok && v.events.length, 1);
  });

  it("invalid JSON fails the poll", async () => {
    const { outcome } = await fetchOnce((_req, res) => sendJson(res, 200, "{not json"));
    assert.equal(classify(outcome).ok, false);
  });

  it("oversized responses fail while reading (declared and chunked)", async () => {
    const big = "x".repeat(64 * 1024 + 1);
    const declared = await fetchOnce((_req, res) => sendJson(res, 200, big));
    assert.equal(declared.outcome.kind, "too_large");
    const chunked = await fetchOnce((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("x".repeat(40000));
      res.write("x".repeat(40000));
      res.end();
    });
    assert.equal(chunked.outcome.kind, "too_large");
  });

  it("exactly 64 KiB is accepted by the size cap", async () => {
    const { outcome } = await fetchOnce((_req, res) => sendJson(res, 200, " ".repeat(64 * 1024)));
    assert.equal(outcome.kind, "response");
  });

  it("a slow server hits the 400 ms deadline", async () => {
    const started = Date.now();
    const { outcome } = await fetchOnce((_req, res) => {
      setTimeout(() => sendJson(res, 200, latestBody([])), 1000);
    });
    assert.equal(outcome.kind, "timeout");
    assert.ok(Date.now() - started < 900);
  });

  it("a server that sends headers then stalls also hits the deadline", async () => {
    const { outcome } = await fetchOnce((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("{");
    });
    assert.equal(outcome.kind, "timeout");
  });

  // Owner decision (D-24): redirects are rejected, never followed, whatever the
  // Location names: the approved origin, the same path, or anywhere else. A
  // second loopback server stands in for an unapproved destination and must
  // receive nothing.
  for (const code of [301, 302, 303, 307, 308]) {
    it(`a ${code} redirect is rejected as a contract fault with no follow-up request`, async () => {
      const elsewhere = await startFakeIngestion((_req, res) => sendJson(res, 200, latestBody([])));
      servers.push(elsewhere);
      for (const location of [
        "http://ingestion:8300/v1/latest",
        "/v1/latest",
        `${elsewhere.url}/v1/latest`,
        "http://169.254.169.254/latest/meta-data/",
        "https://example.com/v1/latest",
      ]) {
        let hits = 0;
        const { outcome } = await fetchOnce((_req, res) => {
          hits += 1;
          res.writeHead(code, { Location: location, "Content-Type": "application/json" });
          res.end(JSON.stringify(latestBody([])));
        });
        assert.equal(hits, 1, `${code} -> ${location}`);
        assert.equal(outcome.kind, "response");
        if (outcome.kind === "response") assert.equal(outcome.status, code);
        assert.deepEqual(classify(outcome), { ok: false, reason: "contract_fault", delayMs: 5000 });
      }
      assert.equal(elsewhere.requests(), 0, "the redirect target was contacted");
    });
  }

  it("a real poller against a redirecting server: no follow-up, outage after 3, retries every 5 s", async () => {
    const elsewhere = await startFakeIngestion((_req, res) => sendJson(res, 200, latestBody([])));
    servers.push(elsewhere);
    const server = await startFakeIngestion((_req, res) => {
      res.writeHead(307, { Location: `${elsewhere.url}/v1/latest` });
      res.end();
    });
    servers.push(server);
    const clock = new FakeClock();
    const http = createHttpFetch(server.url);
    const poller = createPoller({
      fetch: http.fetch,
      store: createObservationStore({ logger: silentLogger }),
      logger: silentLogger,
      clock,
    });
    try {
      poller.start();
      await waitFor(() => server.requests() === 1);
      for (let n = 2; n <= 3; n += 1) {
        // The contract-fault delay is 5 s; nothing is sent before it elapses.
        await new Promise((r) => setTimeout(r, 20));
        clock.advance(4999);
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(server.requests(), n - 1);
        clock.advance(1);
        await waitFor(() => server.requests() === n);
      }
      await waitFor(() => poller.status() === "outage");
      assert.equal(poller.inFlight() <= 1, true);
      assert.equal(elsewhere.requests(), 0);
    } finally {
      poller.stop();
      http.close();
    }
  });

  it("429 carries Retry-After through", async () => {
    const { outcome } = await fetchOnce((_req, res) => sendJson(res, 429, { error: {} }, { "Retry-After": "3" }));
    assert.deepEqual(classify(outcome), { ok: false, reason: "http_429", delayMs: 3000 });
  });

  it("connection refused is a network failure", async () => {
    const server = await startFakeIngestion((_req, res) => sendJson(res, 200, {}));
    const url = server.url;
    await server.close();
    const http = createHttpFetch(url);
    const outcome = await http.fetch(new AbortController().signal);
    http.close();
    assert.equal(outcome.kind, "network");
  });

  it("abort cancels the request in flight", async () => {
    const server = await startFakeIngestion(() => {
      /* never answers */
    });
    servers.push(server);
    const http = createHttpFetch(server.url, { deadlineMs: 5000 });
    const controller = new AbortController();
    const pending = http.fetch(controller.signal);
    await waitFor(() => server.requests() === 1);
    controller.abort();
    assert.equal((await pending).kind, "aborted");
    http.close();
  });

  it("a real poller against a slow server keeps one request in flight", async () => {
    const server = await startFakeIngestion((_req, res) => {
      setTimeout(() => sendJson(res, 200, latestBody([])), 300);
    });
    servers.push(server);
    const http = createHttpFetch(server.url);
    const poller = createPoller({ fetch: http.fetch, store: createObservationStore({ logger: silentLogger }), logger: silentLogger });
    poller.start();
    // Each 300 ms answer is within the 400 ms deadline, so polls succeed back to back.
    await waitFor(() => server.requests() >= 4, 5000);
    poller.stop();
    http.close();
    assert.equal(server.maxConcurrent(), 1);
    assert.equal(poller.status(), "ok");
  });
});
