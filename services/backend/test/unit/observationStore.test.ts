import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROFILE } from "../../src/observations/constants.js";
import type { FxEnvelope } from "../../src/observations/envelope.js";
import {
  ProfileError,
  ageMs,
  assertServableProfile,
  evaluateAll,
  evaluateValue,
  formatServerTime,
  freshnessOf,
} from "../../src/observations/freshness.js";
import { createObservationStore, createRateLimitedLog } from "../../src/observations/store.js";
import { captureLogger, silentLogger } from "../helpers/server.js";
import { eventAt, iso, makeEvent, uuid } from "../helpers/observations.js";

const T0 = Date.parse("2026-11-24T10:00:00.000Z");

function store() {
  return createObservationStore({ logger: silentLogger, now: () => T0 });
}

describe("observation store: ordering, duplicates, conflicts (§3.4)", () => {
  it("accepts a newer event as current and emits an update", () => {
    const s = store();
    const r = s.ingest(eventAt(T0), T0 + 50);
    assert.equal(r.kind, "update");
    assert.equal(s.current("USD", "INR")?.timestamps.source_timestamp, iso(T0));
    const r2 = s.ingest(eventAt(T0 + 2000), T0 + 2050);
    assert.equal(r2.kind, "update");
    assert.equal(s.current("USD", "INR")?.timestamps.source_timestamp, iso(T0 + 2000));
  });

  it("ignores an identical redelivery as a duplicate", () => {
    const s = store();
    const e = eventAt(T0);
    s.ingest(e, T0);
    assert.equal(s.ingest(JSON.parse(JSON.stringify(e)), T0 + 500).kind, "duplicate");
    assert.equal(s.counters().duplicate, 1);
  });

  it("treats the same event_id with different content as a conflict and keeps the first", () => {
    const s = store();
    const id = uuid();
    s.ingest(eventAt(T0, { eventId: id, rate: "1.0" }), T0);
    assert.equal(s.ingest(eventAt(T0 + 2000, { eventId: id, rate: "2.0" }), T0 + 2000).kind, "conflict");
    assert.equal(s.current("USD", "INR")?.payload.rate, "1.0");
    // Same id reused for another pair is a conflict too.
    assert.equal(s.ingest(eventAt(T0, { eventId: id, base: "EUR", quote: "USD" }), T0).kind, "conflict");
    assert.equal(s.current("EUR", "USD"), undefined);
    assert.equal(s.counters()["conflict.event_id"], 2);
  });

  it("ignores an older (out-of-order) event as late", () => {
    const s = store();
    s.ingest(eventAt(T0 + 2000), T0 + 2000);
    assert.equal(s.ingest(eventAt(T0), T0 + 2100).kind, "late");
    assert.equal(s.current("USD", "INR")?.timestamps.source_timestamp, iso(T0 + 2000));
    assert.equal(s.counters().late, 1);
  });

  it("keeps the first event on an equal source_timestamp with a different event_id", () => {
    const s = store();
    const first = eventAt(T0, { rate: "1.0" });
    s.ingest(first, T0);
    assert.equal(s.ingest(eventAt(T0, { rate: "2.0" }), T0).kind, "tie_conflict");
    assert.equal(s.current("USD", "INR")?.event_id, first.event_id);
  });

  it("orders by source_timestamp only, never by source_sequence (restart, clock moved back)", () => {
    const s = store();
    s.ingest(eventAt(T0 + 4000, { sequence: "900" }), T0 + 4000);
    // A restarted generator: lower sequence but newer timestamp wins.
    assert.equal(s.ingest(eventAt(T0 + 6000, { sequence: "1" }), T0 + 6000).kind, "update");
    // Clock moved back: higher sequence, older timestamp is late.
    assert.equal(s.ingest(eventAt(T0 + 1000, { sequence: "5000" }), T0 + 6100).kind, "late");
  });

  it("withholds quarantined events, counting by reason", () => {
    const s = store();
    const r = s.ingest(eventAt(T0, { status: "quarantined", reasons: ["FUTURE_SOURCE_TIMESTAMP"] }), T0);
    assert.equal(r.kind, "quarantined");
    assert.equal(s.current("USD", "INR"), undefined);
    assert.equal(s.counters()["quarantined.FUTURE_SOURCE_TIMESTAMP"], 1);
  });

  it("rejects a null source_timestamp", () => {
    const s = store();
    assert.deepEqual(s.ingest(makeEvent({ sourceTimestamp: null }), T0), { kind: "rejected", reason: "null_source_timestamp" });
    assert.equal(s.size(), 0);
  });

  it("withholds events more than 1 s in the future; exactly 1 s is accepted", () => {
    const s = store();
    assert.equal(s.ingest(eventAt(T0 + 1001), T0).kind, "future");
    assert.equal(s.ingest(makeEvent({ sourceTimestamp: iso(T0), retrievedAt: iso(T0), emittedAt: iso(T0 + 1001) }), T0).kind, "future");
    assert.equal(s.size(), 0);
    assert.equal(s.ingest(eventAt(T0 + 1000), T0).kind, "update");
  });

  it("includes review.reviewed_at, when present, in the future check (§3.4 'any timestamp')", () => {
    const reviewed = (reviewedAtMs: number) => ({
      ...eventAt(T0),
      review: { reviewer_ref: "rev-1", reviewed_at: iso(reviewedAtMs) },
      supersedes: uuid(),
    });
    const s = store();
    assert.equal(s.ingest(reviewed(T0 + 1001), T0).kind, "future");
    assert.equal(s.size(), 0);
    assert.equal(s.counters()["withheld.future"], 1);
    assert.equal(s.ingest(reviewed(T0 + 1000), T0).kind, "update", "exactly 1 s is within tolerance");
    // A past review time with a valid envelope is unaffected.
    assert.equal(s.ingest({ ...reviewed(T0 - 5000), ...{ timestamps: (eventAt(T0 + 500) as any).timestamps } }, T0).kind, "update");
  });

  it("a future event never becomes current, so it cannot block later valid events", () => {
    const s = store();
    s.ingest(eventAt(T0 + 60000), T0);
    assert.equal(s.ingest(eventAt(T0 + 100), T0 + 200).kind, "update");
  });

  it("rejects invalid, wrong-source and non-allowlisted events, keeping only counters", () => {
    const s = store();
    assert.equal(s.ingest({ nope: 1 }, T0).kind, "rejected");
    assert.equal(s.ingest(eventAt(T0, { base: "USD", quote: "JPY" }), T0).kind, "rejected");
    assert.equal(s.size(), 0);
    assert.equal(s.counters()["rejected.schema"], 1);
    assert.equal(s.counters()["rejected.pair_not_allowed"], 1);
  });

  it("is bounded: never more than one event per allowlisted pair (4)", () => {
    const s = store();
    let t = T0;
    for (let i = 0; i < 200; i += 1) {
      for (const [base, quote] of [["AED", "MXN"], ["EUR", "USD"], ["GBP", "PHP"], ["USD", "INR"], ["USD", "JPY"]]) {
        s.ingest(eventAt(t, { base, quote }), t);
      }
      t += 500;
    }
    assert.equal(s.size(), 4);
  });

  it("logs refusals at a limited rate without payloads", () => {
    const capture = captureLogger();
    let now = T0;
    const s = createObservationStore({ logger: capture.logger, now: () => now });
    for (let i = 0; i < 5; i += 1) s.ingest(eventAt(T0 + 5000 + i), T0);
    now += 10000;
    s.ingest(eventAt(T0 + 9000), T0);
    const lines = capture.entries();
    assert.equal(lines.length, 2);
    assert.equal(lines[1]!.suppressed, 4);
    assert.ok(!capture.lines.join("\n").includes("1.2345"), "no payload is logged");
  });

  it("rate-limited log respects its interval per key", () => {
    const capture = captureLogger();
    let now = 0;
    const log = createRateLimitedLog(capture.logger, () => now, 1000);
    log("a", "m", {});
    log("a", "m", {});
    log("b", "m", {});
    now = 1000;
    log("a", "m", {});
    assert.equal(capture.lines.length, 3);
  });
});

describe("observation freshness (§3.3): age and label from one integer", () => {
  const event = eventAt(T0) as unknown as FxEnvelope;

  const cases: Array<[number, string]> = [
    [0, "fresh"],
    [5999, "fresh"],
    [6000, "fresh"],
    [6001, "stale"],
    [29999, "stale"],
    [30000, "stale"],
    [30001, "unavailable"],
  ];
  for (const [age, expected] of cases) {
    it(`age ${age} ms is ${expected}`, () => {
      assert.equal(freshnessOf(age), expected);
      const v = evaluateValue("USD", "INR", event, T0 + age);
      assert.equal(v.freshness, expected);
      if (expected === "unavailable") {
        assert.equal(v.event, null);
        assert.equal(v.age_ms, null);
      } else {
        assert.equal(v.age_ms, age);
        assert.equal(freshnessOf(v.age_ms as number), v.freshness, "label agrees with the sent age");
        assert.ok(Number.isInteger(v.age_ms));
      }
    });
  }

  it("server_time and age come from the same integer instant", () => {
    const at = T0 + 6000;
    const v = evaluateValue("USD", "INR", event, at);
    assert.equal(Date.parse(formatServerTime(at)) - Date.parse(event.timestamps.source_timestamp as string), v.age_ms);
  });

  it("counts a negative age as 0", () => {
    assert.equal(ageMs(T0 + 800, T0), 0);
    const v = evaluateValue("USD", "INR", eventAt(T0 + 800) as unknown as FxEnvelope, T0);
    assert.deepEqual([v.age_ms, v.freshness], [0, "fresh"]);
  });

  it("a never-received pair is unavailable with null event and age", () => {
    assert.deepEqual(evaluateValue("AED", "MXN", undefined, T0), {
      base_currency: "AED",
      quote_currency: "MXN",
      event: null,
      age_ms: null,
      freshness: "unavailable",
    });
  });

  it("evaluateAll returns exactly the four pairs in §3.4 order", () => {
    const values = evaluateAll(() => undefined, T0);
    assert.deepEqual(values.map((v) => `${v.base_currency}/${v.quote_currency}`), ["AED/MXN", "EUR/USD", "GBP/PHP", "USD/INR"]);
  });

  it("an ingestion outage does not refresh age: only a newer event can", () => {
    const s = store();
    s.ingest(eventAt(T0), T0);
    // Repeated deliveries of the same event (as during polling, or after recovery)
    // leave the age measured from its own source_timestamp.
    for (let i = 1; i <= 70; i += 1) s.ingest(eventAt(T0, { eventId: s.current("USD", "INR")!.event_id }), T0 + i * 500);
    const v = evaluateValue("USD", "INR", s.current("USD", "INR"), T0 + 35000);
    assert.equal(v.freshness, "unavailable");
    // The watermark remains: an older event is still late after unavailability.
    assert.equal(s.ingest(eventAt(T0 - 1000), T0 + 35000).kind, "late");
  });
});

describe("profile servability (§3.2, v0.5)", () => {
  it("the slice profile is servable", () => {
    assert.doesNotThrow(() => assertServableProfile(PROFILE));
    assert.equal(PROFILE.unavailable_after_ms, 30000);
    assert.equal(PROFILE.live_max_age_ms, null);
  });

  it("refuses a null or non-positive unavailable_after_ms and out-of-order thresholds", () => {
    assert.throws(() => assertServableProfile({ ...PROFILE, unavailable_after_ms: null }), ProfileError);
    assert.throws(() => assertServableProfile({ ...PROFILE, unavailable_after_ms: 0 }), ProfileError);
    assert.throws(() => assertServableProfile({ ...PROFILE, stale_after_ms: 1.5 }), ProfileError);
    assert.throws(() => assertServableProfile({ ...PROFILE, stale_after_ms: 40000 }), ProfileError);
    assert.throws(() => assertServableProfile({ ...PROFILE, live_max_age_ms: 7000 }), ProfileError);
  });
});
