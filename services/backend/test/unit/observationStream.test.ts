import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { createApp } from "../../src/app.js";
import type { DevUser } from "../../src/config/devTokens.js";
import { PROFILE, type SourceProfile, type SourceStatus } from "../../src/observations/constants.js";
import type { FxEnvelope } from "../../src/observations/envelope.js";
import { ProfileError, evaluateAll, freshnessOf } from "../../src/observations/freshness.js";
import { createObservationService } from "../../src/observations/service.js";
import { createObservationStore } from "../../src/observations/store.js";
import { createStreamHub, encodeFrame } from "../../src/observations/streamHub.js";
import { newToken, sha256Hex } from "../helpers/devTokens.js";
import { captureLogger, silentLogger } from "../helpers/server.js";
import {
  FakeClock,
  FakeSink,
  eventAt,
  latestBody,
  openStream,
  sendJson,
  startFakeIngestion,
  waitFor,
} from "../helpers/observations.js";

const PATH = "/api/rt/v1/observations/stream";

function hubWith(clock: FakeClock, status: SourceStatus = "ok") {
  const store = createObservationStore({ logger: silentLogger, now: () => clock.now() });
  let sourceStatus = status;
  const hub = createStreamHub({
    lookup: (b, q) => store.current(b, q),
    sourceStatus: () => sourceStatus,
    logger: silentLogger,
    clock,
  });
  return { hub, store, setStatus: (s: SourceStatus) => (sourceStatus = s) };
}

function openSink(hub: ReturnType<typeof createStreamHub>, user = "u1") {
  const r = hub.reserve(user);
  assert.ok(r.ok);
  const sink = new FakeSink();
  hub.open(r.slot, sink);
  return sink;
}

/** The §3.3.3 checks a conforming client applies, re-run on everything the server sends. */
function assertConforming(messages: Array<{ event: string; data: Record<string, any> }>) {
  assert.equal(messages[0]?.event, "snapshot");
  messages.forEach((m, i) => {
    const d = m.data as Record<string, any>;
    assert.equal(d.protocol_version, "1.0");
    assert.equal(d.type, m.event);
    assert.equal(d.stream_seq, i + 1);
    assert.match(d.server_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(Object.keys(d.source), ["source_id", "status"]);
    assert.equal(d.source.source_id, "synthetic.fx");
    if (i > 0) assert.notEqual(m.event, "snapshot", "one snapshot per connection");
    const values = m.event === "snapshot" ? d.values : m.event === "update" ? [d.value] : [];
    for (const v of values) {
      if (v.freshness === "unavailable") {
        assert.equal(v.event, null);
        assert.equal(v.age_ms, null);
      } else {
        assert.ok(Number.isInteger(v.age_ms) && v.age_ms >= 0);
        assert.equal(freshnessOf(v.age_ms), v.freshness, "freshness agrees with age_ms");
        const expectedAge = Math.max(0, Date.parse(d.server_time) - Date.parse(v.event.timestamps.source_timestamp));
        assert.equal(v.age_ms, expectedAge, "age_ms is exactly server_time - source_timestamp (min 0)");
      }
    }
  });
}

describe("stream hub: message contracts (§3.2)", () => {
  it("sends exactly one snapshot first, with the profile and four values in order, even when empty", () => {
    const clock = new FakeClock();
    const { hub } = hubWith(clock, "starting");
    const sink = openSink(hub);
    const [first] = sink.messages();
    assert.equal(first!.event, "snapshot");
    assert.deepEqual(Object.keys(first!.data), ["protocol_version", "type", "stream_seq", "server_time", "source", "profile", "values"]);
    assert.deepEqual(first!.data.profile, {
      expected_interval_ms: 2000,
      live_max_age_ms: null,
      stale_after_ms: 6000,
      unavailable_after_ms: 30000,
      clock_tolerance_ms: 1000,
    });
    assert.deepEqual((first!.data.source as Record<string, unknown>).status, "starting");
    const values = first!.data.values as Array<Record<string, unknown>>;
    assert.deepEqual(values.map((v) => `${v.base_currency}/${v.quote_currency}`), ["AED/MXN", "EUR/USD", "GBP/PHP", "USD/INR"]);
    for (const v of values) assert.deepEqual([v.event, v.age_ms, v.freshness], [null, null, "unavailable"]);
    assert.ok(sink.writes[0]!.startsWith("event: snapshot\ndata: {"));
    assert.ok(!sink.writes.join("").includes("\nid:"), "no SSE id is sent");
    hub.shutdown();
  });

  it("sends an update with the unmodified envelope, age and freshness computed at write", () => {
    const clock = new FakeClock();
    const { hub, store } = hubWith(clock);
    const sink = openSink(hub);
    const event = eventAt(clock.now() - 2500, { base: "GBP", quote: "PHP" });
    store.ingest(event, clock.now());
    hub.publishUpdate("GBP", "PHP");
    const update = sink.messages()[1]!;
    assert.equal(update.event, "update");
    assert.deepEqual(Object.keys(update.data), ["protocol_version", "type", "stream_seq", "server_time", "source", "value"]);
    const value = update.data.value as Record<string, unknown>;
    assert.deepEqual(value.event, event, "envelope is sent unmodified");
    assert.equal(value.age_ms, 2500);
    assert.equal(value.freshness, "fresh");
    assertConforming(sink.messages() as never);
    hub.shutdown();
  });

  it("sends heartbeats every 15 s and at once on status change", () => {
    const clock = new FakeClock();
    const { hub, setStatus } = hubWith(clock);
    const sink = openSink(hub);
    clock.advance(14999);
    assert.equal(sink.writes.length, 1);
    clock.advance(1);
    assert.equal(sink.messages()[1]!.event, "heartbeat");
    assert.deepEqual(Object.keys(sink.messages()[1]!.data), ["protocol_version", "type", "stream_seq", "server_time", "source"]);
    setStatus("outage");
    hub.publishHeartbeat();
    const hb = sink.messages()[2]!;
    assert.equal((hb.data.source as Record<string, unknown>).status, "outage");
    clock.advance(15000);
    assert.equal(sink.messages().length, 4);
    assertConforming(sink.messages() as never);
    hub.shutdown();
  });

  it("stream_seq counts per connection, from 1", () => {
    const clock = new FakeClock();
    const { hub } = hubWith(clock);
    const a = openSink(hub, "a");
    hub.publishHeartbeat();
    const b = openSink(hub, "b");
    hub.publishHeartbeat();
    assert.deepEqual(a.messages().map((m) => m.data.stream_seq), [1, 2, 3]);
    assert.deepEqual(b.messages().map((m) => m.data.stream_seq), [1, 2]);
    hub.shutdown();
  });

  it("ages a held value through stale to unavailable at the exact boundaries", () => {
    const clock = new FakeClock();
    const { hub, store } = hubWith(clock);
    const t = clock.now();
    store.ingest(eventAt(t), t);
    const sink = openSink(hub);
    const usd = () => (sink.messages().at(-1)!.data.value as Record<string, unknown>);
    for (const [at, freshness, age] of [
      [5999, "fresh", 5999],
      [6000, "fresh", 6000],
      [6001, "stale", 6001],
      [29999, "stale", 29999],
      [30000, "stale", 30000],
      [30001, "unavailable", null],
    ] as const) {
      clock.set(t + at);
      hub.publishUpdate("USD", "INR");
      assert.deepEqual([usd().freshness, usd().age_ms], [freshness, age], `at ${at}`);
    }
    assert.equal(usd().event, null, "no number once unavailable");
    hub.shutdown();
  });

  it("refuses to construct with a profile lacking a positive unavailable_after_ms", () => {
    assert.throws(
      () =>
        createStreamHub({
          lookup: () => undefined,
          sourceStatus: () => "ok",
          logger: silentLogger,
          profile: {
            expected_interval_ms: 2000,
            live_max_age_ms: null,
            stale_after_ms: 6000,
            unavailable_after_ms: null,
            clock_tolerance_ms: 1000,
          },
        }),
      ProfileError,
    );
  });
});

// L-2: the snapshot must be evaluated with the hub's advertised profile, the
// same one used for updates, not the module default.
describe("stream hub: supplied profile governs snapshot and update freshness (L-2)", () => {
  const CUSTOM: SourceProfile = {
    expected_interval_ms: 500,
    live_max_age_ms: null,
    stale_after_ms: 1000,
    unavailable_after_ms: 5000,
    clock_tolerance_ms: 1000,
  };

  function customHub(clock: FakeClock, profile?: SourceProfile) {
    const store = createObservationStore({ logger: silentLogger, now: () => clock.now() });
    const hub = createStreamHub({
      lookup: (b, q) => store.current(b, q),
      sourceStatus: () => "ok",
      logger: silentLogger,
      clock,
      ...(profile === undefined ? {} : { profile }),
    });
    return { hub, store };
  }

  const usdInr = (values: Array<Record<string, any>>) =>
    values.find((v) => v.base_currency === "USD" && v.quote_currency === "INR")!;

  function snapshotAndUpdateAt(profile: SourceProfile | undefined, at: number) {
    const clock = new FakeClock();
    const { hub, store } = customHub(clock, profile);
    const t = clock.now();
    store.ingest(eventAt(t), t);
    clock.set(t + at);
    const sink = openSink(hub);
    hub.publishUpdate("USD", "INR");
    const [snap, upd] = sink.messages();
    hub.shutdown();
    assert.equal(snap!.event, "snapshot");
    assert.equal(upd!.event, "update");
    return { snapshot: snap!.data as Record<string, any>, update: upd!.data as Record<string, any> };
  }

  for (const [at, freshness, age] of [
    [999, "fresh", 999],
    [1000, "fresh", 1000],
    [1001, "stale", 1001],
    [4999, "stale", 4999],
    [5000, "stale", 5000],
    [5001, "unavailable", null],
  ] as const) {
    it(`non-default profile: snapshot and update agree at age ${at} (${freshness})`, () => {
      const { snapshot, update } = snapshotAndUpdateAt(CUSTOM, at);
      assert.deepEqual(snapshot.profile, CUSTOM, "advertised profile is the supplied one");
      const s = usdInr(snapshot.values);
      const u = update.value as Record<string, any>;
      assert.deepEqual([s.freshness, s.age_ms], [freshness, age], "snapshot");
      assert.deepEqual([u.freshness, u.age_ms], [freshness, age], "update");
      assert.deepEqual(s, u, "snapshot and update values are identical at the same server_time");
      if (age === null) assert.equal(s.event, null, "no event once unavailable");
      else {
        assert.ok(Number.isInteger(s.age_ms));
        assert.equal(freshnessOf(s.age_ms, snapshot.profile), s.freshness, "label agrees with advertised profile");
      }
    });
  }

  for (const [at, freshness, age] of [
    [6000, "fresh", 6000],
    [6001, "stale", 6001],
    [30000, "stale", 30000],
    [30001, "unavailable", null],
  ] as const) {
    it(`default profile unchanged: snapshot and update agree at age ${at} (${freshness})`, () => {
      const { snapshot, update } = snapshotAndUpdateAt(undefined, at);
      assert.deepEqual(snapshot.profile, { ...PROFILE });
      const s = usdInr(snapshot.values);
      assert.deepEqual([s.freshness, s.age_ms], [freshness, age], "snapshot");
      assert.deepEqual(s, update.value, "update");
    });
  }

  it("evaluateAll uses the default profile when none is given, and the supplied one otherwise", () => {
    const t = Date.parse("2026-11-24T10:00:00.000Z");
    const event = eventAt(t) as unknown as FxEnvelope;
    const lookup = (b: string, q: string) => (b === "USD" && q === "INR" ? event : undefined);
    assert.equal(usdInr(evaluateAll(lookup, t + 3000) as any).freshness, "fresh");
    assert.equal(usdInr(evaluateAll(lookup, t + 3000, CUSTOM) as any).freshness, "stale");
    assert.equal(usdInr(evaluateAll(lookup, t + 5001, CUSTOM) as any).freshness, "unavailable");
    assert.equal(usdInr(evaluateAll(lookup, t + 5001) as any).freshness, "fresh");
  });
});

describe("stream hub: limits, backpressure, cleanup (§3.5)", () => {
  it("3 per user, 20 in total; a new stream never evicts an old one", () => {
    const clock = new FakeClock();
    const { hub } = hubWith(clock);
    const sinks = [openSink(hub, "u"), openSink(hub, "u"), openSink(hub, "u")];
    assert.deepEqual(hub.reserve("u"), { ok: false, reason: "limit" });
    for (const s of sinks) assert.equal(s.destroyed, false);
    for (let i = 0; i < 17; i += 1) openSink(hub, `user${i}`);
    assert.equal(hub.stats().total, 20);
    assert.deepEqual(hub.reserve("fresh-user"), { ok: false, reason: "limit" });
    hub.shutdown();
  });

  it("releases a slot exactly once on the first of close, error or shutdown", () => {
    const clock = new FakeClock();
    const { hub } = hubWith(clock);
    const sink = openSink(hub, "u");
    sink.emit("error", new Error("x"));
    sink.emit("close");
    assert.equal(sink.destroyed, true);
    assert.deepEqual(hub.stats(), { total: 0, byUser: {}, reserved: 0 });
    const r = hub.reserve("u");
    assert.ok(r.ok);
    assert.equal(r.slot.release(), true);
    assert.equal(r.slot.release(), false);
    assert.equal(hub.stats().reserved, 0);
  });

  it("repeated connect/disconnect leaves no slot, timer or listener behind", () => {
    const clock = new FakeClock();
    const { hub } = hubWith(clock);
    for (let i = 0; i < 100; i += 1) {
      const sink = openSink(hub, "u");
      sink.emit("close");
      assert.equal(sink.listenerCount("drain") + sink.listenerCount("error"), 0);
    }
    assert.deepEqual(hub.stats(), { total: 0, byUser: {}, reserved: 0 });
    assert.equal(clock.pending(), 0);
  });

  it("on a full buffer keeps one pending update per pair and one heartbeat, newest wins, written on drain", () => {
    const clock = new FakeClock();
    const { hub, store } = hubWith(clock);
    const sink = openSink(hub);
    sink.full = true;
    hub.publishHeartbeat(); // write reports full -> blocked
    const t = clock.now();
    for (let i = 1; i <= 5; i += 1) {
      store.ingest(eventAt(t + i * 10), t + 100);
      hub.publishUpdate("USD", "INR");
      store.ingest(eventAt(t + i * 10, { base: "EUR", quote: "USD" }), t + 100);
      hub.publishUpdate("EUR", "USD");
      hub.publishHeartbeat();
    }
    assert.equal(sink.writes.length, 2, "nothing written while blocked");
    sink.full = false;
    clock.advance(100);
    sink.emit("drain");
    const after = sink.messages().slice(2);
    assert.deepEqual(after.map((m) => m.event), ["update", "update", "heartbeat"]);
    assert.deepEqual(
      after.slice(0, 2).map((m) => (m.data.value as Record<string, any>).event.timestamps.source_timestamp),
      [new Date(t + 50).toISOString(), new Date(t + 50).toISOString()],
      "newest event per pair",
    );
    assert.deepEqual(after.map((m) => m.data.stream_seq), [3, 4, 5], "seq assigned at write");
    assert.equal((after[0]!.data.value as Record<string, any>).base_currency, "EUR", "pairs in §3.4 order");
    assertConforming(sink.messages() as never);
    hub.shutdown();
  });

  it("destroys a stream with no drain within 10 s and releases its slot", () => {
    const clock = new FakeClock();
    const { hub } = hubWith(clock);
    const sink = openSink(hub);
    sink.full = true;
    hub.publishHeartbeat();
    clock.advance(9999);
    assert.equal(sink.destroyed, false);
    clock.advance(1);
    assert.equal(sink.destroyed, true);
    assert.equal(hub.stats().reserved, 0);
    assert.equal(clock.pending(), 0);
  });

  it("a slow client does not affect other clients", () => {
    const clock = new FakeClock();
    const { hub } = hubWith(clock);
    const slow = openSink(hub, "a");
    const fast = openSink(hub, "b");
    slow.full = true;
    for (let i = 0; i < 10; i += 1) hub.publishHeartbeat();
    assert.equal(fast.writes.length, 11);
    assert.equal(slow.writes.length, 2);
    hub.shutdown();
  });

  it("shutdown refuses new streams, ends all, destroys stragglers after 1 s", async () => {
    const clock = new FakeClock();
    const { hub } = hubWith(clock);
    const a = openSink(hub, "a");
    const b = openSink(hub, "b");
    const done = hub.shutdown();
    assert.deepEqual(hub.reserve("c"), { ok: false, reason: "shutting_down" });
    assert.equal(a.ended && b.ended, true);
    assert.equal(hub.stats().reserved, 0, "slots released at shutdown");
    a.emit("close");
    clock.advance(1000);
    await done;
    assert.equal(b.destroyed, true);
    assert.equal(a.destroyed, false);
  });

  it("logs open and close without tokens or payloads", () => {
    const clock = new FakeClock();
    const capture = captureLogger();
    const store = createObservationStore({ logger: silentLogger });
    store.ingest(eventAt(clock.now()), clock.now());
    const hub = createStreamHub({ lookup: (b, q) => store.current(b, q), sourceStatus: () => "ok", logger: capture.logger, clock });
    const r = hub.reserve("u1");
    assert.ok(r.ok);
    const sink = new FakeSink();
    hub.open(r.slot, sink, { requestId: "req-1" });
    sink.emit("close");
    const msgs = capture.entries().map((e) => e.msg);
    assert.deepEqual(msgs, ["observation stream opened", "observation stream closed"]);
    assert.ok(!capture.lines.join("").includes("1.2345"));
  });
});

describe("SSE data size limit (§3.2: one data line of JSON <= 64 KiB)", () => {
  it("encodeFrame allows exactly 65536 UTF-8 bytes and refuses 65537", () => {
    assert.ok(encodeFrame("update", "a".repeat(65536)));
    assert.equal(encodeFrame("update", "a".repeat(65537)), undefined);
  });

  it("measures UTF-8 bytes, not characters", () => {
    // 32768 two-byte characters = 65536 bytes: allowed.
    assert.ok(encodeFrame("update", "é".repeat(32768)));
    // 32769 characters is far below 65536 characters but 65538 bytes: refused.
    assert.equal(encodeFrame("update", "é".repeat(32769)), undefined);
    // A 4-byte character pushing 65533 ASCII bytes to 65537.
    assert.equal(encodeFrame("update", "a".repeat(65533) + "😀"), undefined);
    assert.ok(encodeFrame("update", "a".repeat(65532) + "😀"));
  });

  it("counts only the JSON payload: SSE framing is excluded (65535, 65536 accepted; 65537 refused)", () => {
    const framing = Buffer.byteLength("event: update\ndata: \n\n", "utf8"); // 22 bytes
    for (const [json, ok] of [
      ["a".repeat(65535), true],
      ["a".repeat(65536), true],
      ["é".repeat(32767) + "a", true], // 65535 bytes, multibyte
      ["é".repeat(32768), true], // 65536 bytes, multibyte
      ["a".repeat(65537), false],
      ["é".repeat(32768) + "a", false], // 65537 bytes, multibyte
    ] as const) {
      const frame = encodeFrame("update", json);
      const bytes = Buffer.byteLength(json, "utf8");
      if (ok) {
        assert.equal(frame, `event: update\ndata: ${json}\n\n`);
        // The framed text exceeds 64 KiB at the limit and is still accepted.
        assert.equal(Buffer.byteLength(frame!, "utf8"), bytes + framing);
      } else {
        assert.equal(frame, undefined, `${bytes} bytes refused`);
      }
    }
  });

  it("an update of exactly 64 KiB is delivered when the snapshot is small", () => {
    // Snapshot first with no event, then the oversized-capable event arrives.
    const clock = new FakeClock();
    let current: Record<string, any> | undefined;
    const hub = createStreamHub({
      lookup: (b, q) => (b === "USD" && q === "INR" ? (current as unknown as FxEnvelope) : undefined),
      sourceStatus: () => "ok",
      logger: silentLogger,
      clock,
    });
    const r = hub.reserve("u");
    assert.ok(r.ok);
    const sink = new FakeSink();
    hub.open(r.slot, sink);
    const make = (pad: number) => {
      const e = eventAt(clock.now()) as Record<string, any>;
      e.synthetic = { ...e.synthetic, case_id: "é".repeat(pad) }; // 2 bytes each
      return e;
    };
    current = make(0);
    hub.publishUpdate("USD", "INR");
    const dataOf = (w: string) => w.replace(/^event: update\ndata: /, "").replace(/\n\n$/, "");
    const overhead = Buffer.byteLength(dataOf(sink.writes[1]!), "utf8");
    // Fill with 2-byte characters, then top up with one ASCII byte if odd.
    // 65535 bytes: delivered.
    const below = 65535 - overhead;
    current = make(Math.floor(below / 2));
    if (below % 2 === 1) current.synthetic.case_id += "x";
    hub.publishUpdate("USD", "INR");
    assert.equal(Buffer.byteLength(dataOf(sink.writes[2]!), "utf8"), 65535);
    sink.writes.splice(2, 1); // keep the indices below unchanged
    const room = 65536 - overhead;
    current = make(Math.floor(room / 2));
    if (room % 2 === 1) current.synthetic.case_id += "x";
    hub.publishUpdate("USD", "INR");
    assert.equal(sink.writes.length, 3, "exact-limit update written");
    assert.equal(Buffer.byteLength(dataOf(sink.writes[2]!), "utf8"), 65536);
    assert.equal(Buffer.byteLength(sink.writes[2]!, "utf8"), 65536 + 22, "framing not counted");
    assert.equal(sink.destroyed, false);
    current.synthetic.case_id += "x";
    hub.publishUpdate("USD", "INR");
    assert.equal(sink.writes.length, 3, "over-limit update not written");
    assert.equal(sink.destroyed, true);
    assert.equal(hub.stats().reserved, 0);
  });
});

describe("backpressure ordering and coalescing", () => {
  it("a status change and a timer heartbeat while blocked coalesce into one heartbeat with the newest status, after updates", () => {
    const clock = new FakeClock();
    const { hub, store, setStatus } = hubWith(clock);
    const sink = openSink(hub);
    // Block 1 s before the 15 s heartbeat timer, well inside the 10 s drain deadline.
    clock.advance(14000);
    sink.full = true;
    store.ingest(eventAt(clock.now()), clock.now());
    hub.publishUpdate("USD", "INR"); // written, reports full -> blocked
    store.ingest(eventAt(clock.now() + 10, { base: "AED", quote: "MXN" }), clock.now() + 20);
    hub.publishUpdate("AED", "MXN");
    setStatus("outage");
    hub.publishHeartbeat();
    clock.advance(1000); // the timer heartbeat fires while blocked
    assert.equal(sink.destroyed, false);
    setStatus("ok");
    hub.publishHeartbeat();
    assert.equal(sink.writes.length, 2);
    sink.full = false;
    sink.emit("drain");
    const tail = sink.messages().slice(2);
    assert.deepEqual(tail.map((m) => m.event), ["update", "heartbeat"]);
    assert.equal((tail[0]!.data.value as Record<string, any>).base_currency, "AED");
    assert.equal((tail[1]!.data.source as Record<string, any>).status, "ok", "newest status wins");
    assertConforming(sink.messages() as never);
    hub.shutdown();
  });

  it("a drain that refills the buffer stops the flush and keeps the rest pending", () => {
    const clock = new FakeClock();
    const { hub, store } = hubWith(clock);
    const sink = openSink(hub);
    sink.full = true;
    hub.publishHeartbeat();
    for (const [base, quote] of [["AED", "MXN"], ["EUR", "USD"], ["GBP", "PHP"]]) {
      store.ingest(eventAt(clock.now(), { base, quote }), clock.now());
      hub.publishUpdate(base!, quote!);
    }
    // Still full on drain: only the first pending update is written.
    sink.emit("drain");
    assert.deepEqual(sink.messages().slice(2).map((m) => (m.data.value as any).base_currency), ["AED"]);
    sink.full = false;
    sink.emit("drain");
    assert.deepEqual(sink.messages().slice(2).map((m) => (m.data.value as any).base_currency), ["AED", "EUR", "GBP"]);
    assertConforming(sink.messages() as never);
    hub.shutdown();
  });
});

describe("observation service: duplicates and shutdown order (fake clock)", () => {
  function manual() {
    const calls: Array<{ resolve: (o: unknown) => void; signal: AbortSignal; onAbort: Array<() => void> }> = [];
    return {
      calls,
      fetch: (signal: AbortSignal) =>
        new Promise<any>((resolve) => {
          const entry = { resolve, signal, onAbort: [] as Array<() => void> };
          calls.push(entry);
          signal.addEventListener("abort", () => {
            for (const f of entry.onAbort) f();
            resolve({ kind: "aborted" });
          });
        }),
    };
  }
  const okBody = (events: unknown[]) => ({
    kind: "response",
    status: 200,
    contentType: "application/json",
    retryAfter: undefined,
    body: Buffer.from(JSON.stringify(latestBody(events))),
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it("repeated polls of the same events send exactly one update per accepted event", async () => {
    const clock = new FakeClock();
    const f = manual();
    const service = createObservationService({ url: "http://unused.invalid", logger: silentLogger, clock, fetch: f.fetch });
    const r = service.hub.reserve("u");
    assert.ok(r.ok);
    const sink = new FakeSink();
    service.hub.open(r.slot, sink);
    service.start();
    const event = eventAt(clock.now() - 100);
    for (let i = 0; i < 5; i += 1) {
      f.calls[i]!.resolve(okBody([event]));
      await flush();
      clock.advance(500);
    }
    assert.equal(sink.messages().filter((m) => m.event === "update").length, 1);
    assert.equal(service.store.counters().duplicate, 4);
    sink.emit("close");
    await service.shutdown();
  });

  it("shutdown refuses new streams before aborting the poll, and only then ends streams", async () => {
    const clock = new FakeClock();
    const f = manual();
    const service = createObservationService({ url: "http://unused.invalid", logger: silentLogger, clock, fetch: f.fetch });
    const r = service.hub.reserve("u");
    assert.ok(r.ok);
    const sink = new FakeSink();
    service.hub.open(r.slot, sink);
    service.start();
    assert.equal(f.calls.length, 1, "a poll is in flight");
    const atAbort: Array<{ reserve: string; ended: boolean }> = [];
    f.calls[0]!.onAbort.push(() => {
      const attempt = service.hub.reserve("other");
      atAbort.push({ reserve: attempt.ok ? "ok" : attempt.reason, ended: sink.ended });
    });
    const done = service.shutdown();
    assert.deepEqual(atAbort, [{ reserve: "shutting_down", ended: false }], "503 first, then abort, streams still open");
    assert.equal(sink.ended, true, "streams ended after polling stopped");
    assert.equal(service.hub.stats().reserved, 0);
    // The client never closes: destroyed at the 1 s deadline.
    clock.advance(999);
    assert.equal(sink.destroyed, false);
    clock.advance(1);
    await done;
    assert.equal(sink.destroyed, true);
    assert.equal(service.poller.inFlight(), 0);
    assert.equal(clock.pending(), 0, "no timer left behind");
    // Nothing is written after end (a real response would raise write-after-end).
    assert.doesNotThrow(() => {
      service.hub.publishHeartbeat();
      service.hub.publishUpdate("USD", "INR");
    });
    // A second shutdown is a no-op.
    await service.shutdown();
  });

  it("a stream that closes promptly lets shutdown finish without waiting for the deadline", async () => {
    const clock = new FakeClock();
    const f = manual();
    const service = createObservationService({ url: "http://unused.invalid", logger: silentLogger, clock, fetch: f.fetch });
    const r = service.hub.reserve("u");
    assert.ok(r.ok);
    const sink = new FakeSink();
    service.hub.open(r.slot, sink);
    const done = service.shutdown();
    sink.emit("close");
    await done;
    assert.equal(sink.destroyed, false);
  });
});

// ---------------------------------------------------------------- HTTP

const analystToken = newToken();
const viewerToken = newToken();
const users: DevUser[] = [
  { userId: "u-analyst-1", email: "analyst@example.test", role: "analyst", tokenSha256: sha256Hex(analystToken) },
  { userId: "u-viewer-1", email: "viewer@example.test", role: "viewer", tokenSha256: sha256Hex(viewerToken) },
] as DevUser[];

async function startStack(options: { limits?: { perUser?: number; total?: number }; handler?: Parameters<typeof startFakeIngestion>[0] } = {}) {
  let events: unknown[] = [];
  const ingestion = await startFakeIngestion(
    options.handler ?? ((_req, res) => sendJson(res, 200, latestBody(events))),
  );
  const inferenceCalls: string[] = [];
  const service = createObservationService({
    url: ingestion.url,
    logger: silentLogger,
    hubOptions: options.limits === undefined ? undefined : { limits: options.limits },
  });
  const app = createApp({ logger: silentLogger, users, observationStreams: service.hub });
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  service.start();
  return {
    url: base + PATH,
    base,
    service,
    ingestion,
    inferenceCalls,
    setEvents: (e: unknown[]) => (events = e),
    async close() {
      await service.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await ingestion.close();
    },
  };
}

describe("SSE endpoint over HTTP (§3.2, §3.5)", () => {
  const stacks: Array<{ close: () => Promise<void> }> = [];
  after(async () => {
    for (const s of stacks) await s.close();
  });
  const stack = async (o?: Parameters<typeof startStack>[0]) => {
    const s = await startStack(o);
    stacks.push(s);
    return s;
  };

  it("streams with the exact 200 headers, a snapshot, then updates", async () => {
    const s = await stack();
    const stream = await openStream(s.url, analystToken);
    assert.equal(stream.response.status, 200);
    assert.equal(stream.response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.equal(stream.response.headers.get("cache-control"), "no-store, no-transform");
    assert.equal(stream.response.headers.get("x-accel-buffering"), "no");
    await stream.next(1);
    assert.equal(stream.messages[0]!.event, "snapshot");
    s.setEvents([eventAt(Date.now() - 100, { base: "EUR", quote: "USD" })]);
    await stream.next(1);
    const update = stream.messages.find((m) => m.event === "update");
    assert.equal((update!.data.value as Record<string, any>).base_currency, "EUR");
    assertConforming(stream.messages as never);
    stream.abort();
    await waitFor(() => s.service.hub.stats().reserved === 0);
  });

  it("401 without or with a bad token, checked before 405 (HEAD and POST included)", async () => {
    const s = await stack();
    for (const method of ["GET", "HEAD", "POST", "DELETE"]) {
      for (const token of [undefined, newToken()]) {
        const r = await fetch(s.url, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
        assert.equal(r.status, 401, `${method} ${token ? "bad" : "no"} token`);
        if (method !== "HEAD") assert.equal(((await r.json()) as any).error.code, "UNAUTHENTICATED");
      }
    }
    assert.equal(s.service.hub.stats().reserved, 0);
  });

  it("405 for HEAD and other methods with a valid token, Allow: GET, no slot taken", async () => {
    const s = await stack();
    for (const method of ["HEAD", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
      const r = await fetch(s.url, { method, headers: { Authorization: `Bearer ${viewerToken}` } });
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.get("allow"), "GET");
      if (method !== "HEAD") {
        const body = (await r.json()) as any;
        assert.equal(body.error.code, "METHOD_NOT_ALLOWED");
        assert.ok(typeof body.error.requestId === "string");
      }
    }
    assert.equal(s.service.hub.stats().reserved, 0);
  });

  it("422 VALIDATION_ERROR for any query, without echoing it", async () => {
    const s = await stack();
    const r = await fetch(`${s.url}?since=SECRETQ`, { headers: { Authorization: `Bearer ${analystToken}` } });
    assert.equal(r.status, 422);
    const text = await r.text();
    assert.equal(JSON.parse(text).error.code, "VALIDATION_ERROR");
    assert.ok(!text.includes("SECRETQ"));
    assert.equal(s.service.hub.stats().reserved, 0);
  });

  it("error precedence is 401 -> 405 -> 422 -> 503 -> 429 (owner clarification)", async () => {
    // One global slot, held by an open stream, and new streams refused: every
    // condition is true at once, so each request shows which check wins.
    const s = await stack({ limits: { total: 1 } });
    const held = await openStream(s.url, analystToken);
    await held.next(1);
    s.service.hub.refuseNew();
    const call = async (method: string, query: boolean, token?: string) => {
      const r = await fetch(`${s.url}${query ? "?x=1" : ""}`, {
        method,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const code = method === "HEAD" ? undefined : ((await r.json()) as any).error.code;
      return { status: r.status, code };
    };
    assert.deepEqual(await call("POST", true), { status: 401, code: "UNAUTHENTICATED" });
    assert.equal((await call("HEAD", true)).status, 401);
    assert.deepEqual(await call("POST", true, viewerToken), { status: 405, code: "METHOD_NOT_ALLOWED" });
    assert.equal((await call("HEAD", true, viewerToken)).status, 405);
    assert.deepEqual(await call("GET", true, viewerToken), { status: 422, code: "VALIDATION_ERROR" });
    assert.deepEqual(await call("GET", false, viewerToken), { status: 503, code: "SHUTTING_DOWN" });
    held.abort();
    await waitFor(() => s.service.hub.stats().reserved === 0);
  });

  it("503 is not reached before 429 is due: at the limit without shutdown, 429", async () => {
    const s = await stack({ limits: { total: 1 } });
    const held = await openStream(s.url, analystToken);
    await held.next(1);
    const r = await fetch(s.url, { headers: { Authorization: `Bearer ${viewerToken}` } });
    assert.equal(r.status, 429);
    await r.body?.cancel();
    held.abort();
    await waitFor(() => s.service.hub.stats().reserved === 0);
  });

  it("a bare '?' is an empty query and streams normally (owner clarification)", async () => {
    const s = await stack();
    const url = `${s.url}?`;
    assert.ok(new URL(url).href.endsWith("?"), "the request really carries a bare '?'");
    const stream = await openStream(url, analystToken);
    assert.equal(stream.response.status, 200);
    await stream.next(1);
    assert.equal(stream.messages[0]!.event, "snapshot");
    stream.abort();
    await waitFor(() => s.service.hub.stats().reserved === 0);
  });

  it("ignores Last-Event-ID", async () => {
    const s = await stack();
    const r = await fetch(s.url, { headers: { Authorization: `Bearer ${analystToken}`, "Last-Event-ID": "5" } });
    assert.equal(r.status, 200);
    await r.body?.cancel();
    await waitFor(() => s.service.hub.stats().reserved === 0);
  });

  it("429 STREAM_LIMIT with Retry-After: 5 past 3 per user; other users unaffected", async () => {
    const s = await stack();
    const open = [];
    for (let i = 0; i < 3; i += 1) open.push(await openStream(s.url, analystToken));
    const r = await fetch(s.url, { headers: { Authorization: `Bearer ${analystToken}` } });
    assert.equal(r.status, 429);
    assert.equal(r.headers.get("retry-after"), "5");
    assert.equal(((await r.json()) as any).error.code, "STREAM_LIMIT");
    const other = await openStream(s.url, viewerToken);
    assert.equal(other.response.status, 200);
    for (const o of [...open, other]) o.abort();
    await waitFor(() => s.service.hub.stats().reserved === 0);
  });

  it("429 past the global limit", async () => {
    const s = await stack({ limits: { total: 2 } });
    const a = await openStream(s.url, analystToken);
    const b = await openStream(s.url, viewerToken);
    const r = await fetch(s.url, { headers: { Authorization: `Bearer ${viewerToken}` } });
    assert.equal(r.status, 429);
    a.abort();
    b.abort();
    await waitFor(() => s.service.hub.stats().reserved === 0);
  });

  it("disconnects free their slots; 30 connect/disconnect cycles leak nothing", async () => {
    const s = await stack();
    for (let i = 0; i < 30; i += 1) {
      const stream = await openStream(s.url, analystToken);
      await stream.next(1);
      stream.abort();
      await waitFor(() => s.service.hub.stats().reserved === 0);
    }
    const final = await Promise.all([0, 1, 2].map(() => openStream(s.url, analystToken)));
    assert.ok(final.every((f) => f.response.status === 200), "all 3 per-user slots available again");
    final.forEach((f) => f.abort());
    await waitFor(() => s.service.hub.stats().reserved === 0);
  });

  it("an ingestion outage is not an HTTP error: the stream opens and reports it", async () => {
    const s = await stack({ handler: (_req, res) => sendJson(res, 500, { error: { code: "INTERNAL_ERROR", message: "x" } }) });
    const stream = await openStream(s.url, analystToken);
    assert.equal(stream.response.status, 200);
    await stream.next(1);
    await stream.next(1, 4000); // the status-change heartbeat
    const hb = stream.messages.find((m) => m.event === "heartbeat");
    assert.equal((hb!.data.source as Record<string, unknown>).status, "outage");
    stream.abort();
  });

  it("graceful shutdown: open streams end, new ones get 503 SHUTTING_DOWN with Retry-After: 1", async () => {
    const s = await startStack();
    const stream = await openStream(s.url, analystToken);
    await stream.next(1);
    const pending = s.service.shutdown();
    await stream.ended;
    const r = await fetch(s.url, { headers: { Authorization: `Bearer ${analystToken}` } });
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("retry-after"), "1");
    assert.equal(((await r.json()) as any).error.code, "SHUTTING_DOWN");
    await pending;
    assert.equal(s.service.poller.inFlight(), 0);
    await s.close();
  });
});
