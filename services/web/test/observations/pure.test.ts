import { describe, expect, it } from "vitest";
import { freshnessOf, msUntilNextChange, valueFreshness } from "../../src/features/observations/freshness";
import { observationsFlagFromEnv } from "../../src/features/observations/flags";
import { MAX_SSE_BYTES, SseParser, utf8Bytes } from "../../src/features/observations/sseParser";
import type { ObservationValue, Profile } from "../../src/features/observations/types";
import { daysInMonth, decodeMessage, isAd4Timestamp, parseProfile } from "../../src/features/observations/validate";
import { freshValues, heartbeat, makeEvent, makeValue, PAIR_LIST, PROFILE, snapshot, update } from "./fixtures";

const profile: Profile = parseProfile(PROFILE) as Profile;
const ctx0 = { lastSeq: 0, profile: null };
const ctx1 = { lastSeq: 1, profile };
const json = (o: unknown) => JSON.stringify(o);

describe("observations flag", () => {
  it("is on only for exactly 'on'", () => {
    expect(observationsFlagFromEnv("on")).toBe(true);
    for (const v of [undefined, "", "ON", "true", "1", "off", null]) expect(observationsFlagFromEnv(v)).toBe(false);
  });
});

describe("freshness boundaries (AD-1 §3.3.3)", () => {
  it("takes the lower state at each boundary", () => {
    expect(freshnessOf(0, profile)).toBe("fresh");
    expect(freshnessOf(6000, profile)).toBe("fresh");
    expect(freshnessOf(6000.001, profile)).toBe("stale");
    expect(freshnessOf(30000, profile)).toBe("stale");
    expect(freshnessOf(30000.001, profile)).toBe("unavailable");
  });
  it("counts a negative age as 0", () => expect(freshnessOf(-500, profile)).toBe("fresh"));

  const value = (over: Partial<ObservationValue> = {}): ObservationValue => ({
    base: "USD", quote: "INR", rate: "1.2", sourceId: "synthetic.fx", ageAtReceiptMs: 1000, receivedAtMs: 100, unavailable: false, ...over,
  });
  it("advances age by elapsed monotonic time only", () => {
    expect(valueFreshness(value(), profile, 100 + 5000)).toBe("fresh"); // age 6000
    expect(valueFreshness(value(), profile, 100 + 5001)).toBe("stale");
    expect(valueFreshness(value(), profile, 100 + 29000)).toBe("stale"); // age 30000
    expect(valueFreshness(value(), profile, 100 + 29001)).toBe("unavailable");
  });
  it("never improves an unavailable value", () => {
    expect(valueFreshness(value({ unavailable: true, rate: null, ageAtReceiptMs: null }), profile, 100)).toBe("unavailable");
  });
  it("schedules the next change one millisecond past the boundary", () => {
    expect(msUntilNextChange([value()], profile, 100, 1000)).toBe(1000); // capped
    expect(msUntilNextChange([value({ ageAtReceiptMs: 5500 })], profile, 100, 1000)).toBe(501);
    expect(msUntilNextChange([value({ unavailable: true })], profile, 100, 1000)).toBe(1000);
  });
});

describe("SSE parser (AD-1 §3.3.3 wire parsing)", () => {
  const feed = (chunks: string[]) => {
    const p = new SseParser();
    return chunks.flatMap((c) => p.feed(c).events);
  };
  it("parses an event and strips one space after the colon", () => {
    expect(feed(["event: update\ndata:  x\n\n"])).toEqual([{ event: "update", data: " x" }]);
  });
  it("accepts \\r\\n, \\n and lone \\r, also split across chunks", () => {
    expect(feed(["event: a\r\ndata: 1\r\n\r\n", "event: b\ndata: 2\n\n", "event: c\rdata: 3\r\r"]).map((e) => e.event)).toEqual(["a", "b", "c"]);
    expect(feed(["event: a\r", "\ndata: 1\r", "\n\r", "\n"])).toEqual([{ event: "a", data: "1" }]);
  });
  it("handles a chunk boundary anywhere, one character at a time", () => {
    const text = 'event: update\ndata: {"a":"é"}\n\n';
    expect(feed([...text])).toEqual([{ event: "update", data: '{"a":"é"}' }]);
  });
  it("joins several data lines with a newline", () => {
    expect(feed(["data: a\ndata: b\n\n"])).toEqual([{ event: "message", data: "a\nb" }]);
  });
  it("ignores comments, id, retry and unknown fields, and dispatches nothing without data", () => {
    expect(feed([": keep-alive\nid: 7\nretry: 5\nfoo: bar\n\n"])).toEqual([]);
    expect(feed([": c\nevent: x\ndata: 1\n\n"])).toEqual([{ event: "x", data: "1" }]);
  });
  it("discards a partial event at the end of the stream", () => {
    expect(feed(["event: a\ndata: 1\n"])).toEqual([]);
  });
  it("reports overflow for an oversized event or an unterminated line, and stays stopped", () => {
    const p = new SseParser();
    expect(p.feed("data: " + "x".repeat(MAX_SSE_BYTES) + "\n\n").overflow).toBe(true);
    expect(p.feed("data: 1\n\n")).toEqual({ events: [], overflow: true });
    const q = new SseParser();
    expect(q.feed("x".repeat(MAX_SSE_BYTES + 1)).overflow).toBe(true);
  });
});

describe("profile validation", () => {
  it("accepts the slice profile", () => expect(profile).toMatchObject({ staleAfterMs: 6000, unavailableAfterMs: 30000, liveMaxAgeMs: null }));
  it.each([
    ["a null unavailable_after_ms", { ...PROFILE, unavailable_after_ms: null }],
    ["a missing field", { ...PROFILE, stale_after_ms: undefined }],
    ["a zero threshold", { ...PROFILE, stale_after_ms: 0 }],
    ["a non-integer", { ...PROFILE, stale_after_ms: 6000.5 }],
    ["stale above unavailable", { ...PROFILE, stale_after_ms: 40000 }],
    ["live_max above stale", { ...PROFILE, live_max_age_ms: 7000 }],
    ["not an object", 5],
  ])("rejects %s", (_name, raw) => expect(parseProfile(raw)).toBeNull());
});

describe("message decoding: protocol faults", () => {
  const snap = () => json(snapshot());
  it("accepts a valid snapshot, update and heartbeat", () => {
    const s = decodeMessage("snapshot", snap(), ctx0);
    expect(s.kind).toBe("snapshot");
    expect(decodeMessage("update", json(update(2, makeValue("USD", "INR", 0, "fresh", "9.9"))), ctx1).kind).toBe("update");
    expect(decodeMessage("heartbeat", json(heartbeat(2, "outage")), ctx1)).toMatchObject({ kind: "heartbeat", source: { status: "outage" } });
  });
  it.each([
    ["not JSON", "snapshot", "{nope", ctx0],
    ["not an object", "snapshot", "[1]", ctx0],
    ["no protocol_version", "snapshot", json({ ...snapshot(), protocol_version: undefined }), ctx0],
    ["a malformed version", "snapshot", json({ ...snapshot(), protocol_version: "one" }), ctx0],
    ["a type that differs from the event name", "update", snap(), ctx0],
    ["a first stream_seq other than 1", "snapshot", json(snapshot(2)), ctx0],
    ["a stream_seq gap", "heartbeat", json(heartbeat(5)), ctx1],
    ["a repeated stream_seq", "heartbeat", json(heartbeat(1)), ctx1],
    ["a fractional stream_seq", "heartbeat", json({ ...heartbeat(2), stream_seq: 2.5 }), ctx1],
    ["a bad server_time", "heartbeat", json({ ...heartbeat(2), server_time: "yesterday" }), ctx1],
    ["an unknown source status", "heartbeat", json({ ...heartbeat(2), source: { source_id: "synthetic.fx", status: "great" } }), ctx1],
    ["a first message that is not a snapshot", "heartbeat", json(heartbeat(1)), ctx0],
    ["a second snapshot", "snapshot", json(snapshot(2)), ctx1],
    ["an update before a snapshot's profile", "update", json(update(2, makeValue("USD", "INR", 0, "fresh"))), { lastSeq: 1, profile: null }],
    ["a snapshot without a profile", "snapshot", json({ ...snapshot(), profile: undefined }), ctx0],
    ["a snapshot with a null unavailable threshold", "snapshot", json(snapshot(1, freshValues(), { profile: { ...PROFILE, unavailable_after_ms: null } })), ctx0],
    ["three values", "snapshot", json(snapshot(1, freshValues().slice(0, 3))), ctx0],
    ["values out of order", "snapshot", json(snapshot(1, [...freshValues()].reverse())), ctx0],
    ["an update outside the allowlist", "update", json(update(2, makeValue("USD", "JPY", 0, "fresh"))), ctx1],
    ["a freshness that disagrees with the age", "snapshot", json(snapshot(1, freshValues(7000))), ctx0],
    ["an unknown freshness", "update", json(update(2, makeValue("USD", "INR", 0, "great"))), ctx1],
    ["an event with no numeric age", "update", json(update(2, { ...makeValue("USD", "INR", 0, "fresh"), age_ms: "0" })), ctx1],
    ["an unavailable value that still has an age", "update", json(update(2, { ...makeValue("USD", "INR", 5, "unavailable"), event: null })), ctx1],
  ])("faults on %s", (_n, name, data, ctx) => {
    expect(decodeMessage(name as string, data as string, ctx as typeof ctx0).kind).toBe("fault");
  });

  it("stops, without a fault, on an unknown major version", () => {
    expect(decodeMessage("snapshot", json({ ...snapshot(), protocol_version: "2.0" }), ctx0)).toEqual({ kind: "stop", reason: "unsupported_version" });
  });
  it("ignores an unknown type and unknown fields, but still checks and counts stream_seq", () => {
    expect(decodeMessage("notice", json({ ...heartbeat(2), type: "notice", extra: 1 }), ctx1)).toEqual({ kind: "ignored", seq: 2 });
    expect(decodeMessage("notice", json({ ...heartbeat(4), type: "notice" }), ctx1).kind).toBe("fault");
    expect(decodeMessage("heartbeat", json({ ...heartbeat(2), extra: { a: 1 } }), ctx1).kind).toBe("heartbeat");
  });
  it("faults on an unknown first message type", () => {
    expect(decodeMessage("notice", json({ ...heartbeat(1), type: "notice" }), ctx0).kind).toBe("fault");
  });
});

describe("message decoding: per-value checks", () => {
  const decodedValues = (values: object[]) => {
    const d = decodeMessage("snapshot", json(snapshot(1, values as never)), ctx0);
    if (d.kind !== "snapshot") throw new Error(`expected a snapshot, got ${d.kind}`);
    return d.values;
  };
  const withOne = (over: Record<string, unknown>) => {
    const values = freshValues();
    values[3] = makeValue("USD", "INR", 1000, "fresh", "5.5", over);
    return decodedValues(values);
  };

  it("keeps a valid synthetic value and its rate string unmodified", () => {
    const values = decodedValues(freshValues());
    expect(values[3]).toMatchObject({ rate: "4.2345", sourceId: "synthetic.fx", ageMs: 1000, unavailable: false });
  });
  it.each([
    ["usage other than display_only", { usage: "routing" }],
    ["a non-synthetic class", { provenance_class: "real" }],
    ["an unknown class", { provenance_class: "quantum" }],
    ["a non-synthetic transport", { source: { source_id: "synthetic.fx", transport: "poll" } }],
    ["a source_id without the synthetic prefix", { source: { source_id: "ecb.fx", transport: "synthetic" } }],
    ["a quarantined event", { validation: { status: "quarantined", reasons: [] } }],
    ["another event type", { event_type: "announcement" }],
    ["a payload for another pair", { payload: { base_currency: "EUR", quote_currency: "USD", rate: "1", rate_type: "mid" } }],
    ["a rate type other than mid", { payload: { base_currency: "USD", quote_currency: "INR", rate: "1", rate_type: "bid" } }],
    ["a non-decimal rate", { payload: { base_currency: "USD", quote_currency: "INR", rate: "1e9", rate_type: "mid" } }],
    ["a numeric rate", { payload: { base_currency: "USD", quote_currency: "INR", rate: 1.5, rate_type: "mid" } }],
  ])("withholds a value with %s, keeping the rest of the message", (_n, over) => {
    const values = withOne(over);
    expect(values[3]).toMatchObject({ rate: null, unavailable: true, withheld: true, ageMs: null, sourceId: null });
    expect(values[0]).toMatchObject({ unavailable: false, withheld: false });
  });
  it("shows a never-received value as unavailable without counting it as withheld", () => {
    const values = freshValues();
    values[0] = makeValue("AED", "MXN", null, "unavailable");
    expect(decodedValues(values)[0]).toMatchObject({ rate: null, unavailable: true, withheld: false });
  });
  it("counts a negative age as 0 and takes the boundary values at their lower state", () => {
    const values = freshValues();
    values[0] = makeValue("AED", "MXN", -300, "fresh");
    values[1] = makeValue("EUR", "USD", 6000, "fresh");
    values[2] = makeValue("GBP", "PHP", 30000, "stale");
    const out = decodedValues(values);
    expect(out[0]).toMatchObject({ ageMs: 0 });
    expect(out[1]?.unavailable).toBe(false);
    expect(out[2]?.unavailable).toBe(false);
  });
  it("renders a value older than the withdrawal threshold as unavailable with no number", () => {
    const values = freshValues();
    values[0] = makeValue("AED", "MXN", 30001, "unavailable");
    expect(decodedValues(values)[0]).toMatchObject({ rate: null, unavailable: true, withheld: false });
  });
  it("covers the four pairs from the fixture list", () => expect(PAIR_LIST).toHaveLength(4));
  it("has an envelope fixture that matches AD-4 §10", () => {
    expect(makeEvent("USD", "INR")).toMatchObject({ usage: "display_only", provenance_class: "synthetic", payload_sha256: expect.any(String) });
  });
});

describe("SSE parser: the 64 KiB limit counts UTF-8 bytes (F1)", () => {
  const event = (value: string) => `data: ${value}\n\n`;
  const overflows = (text: string) => new SseParser().feed(text).overflow;

  it("counts bytes per character: 1, 2, 3, and 4 for a surrogate pair", () => {
    expect([utf8Bytes("a"), utf8Bytes("é"), utf8Bytes("€"), utf8Bytes("😀")]).toEqual([1, 2, 3, 4]);
    for (const text of ["", "plain", "é€😀 mixed ✓", "日本語"]) expect(utf8Bytes(text)).toBe(new TextEncoder().encode(text).length);
  });

  it.each([
    ["3-byte €", "€", 21000, 22000],
    ["2-byte é", "é", 30000, 33000],
    ["4-byte emoji", "😀", 15000, 16400],
  ])("accepts %s under 64 KiB and rejects it over, though the string is shorter than 64 Ki units", (_n, ch, under, over) => {
    expect(utf8Bytes(ch.repeat(under))).toBeLessThanOrEqual(MAX_SSE_BYTES);
    expect(utf8Bytes(ch.repeat(over))).toBeGreaterThan(MAX_SSE_BYTES);
    expect(ch.repeat(over).length).toBeLessThan(MAX_SSE_BYTES); // the old unit count would have let it through
    const ok = new SseParser().feed(event(ch.repeat(under)));
    expect(ok.overflow).toBe(false);
    expect(ok.events[0]?.data).toBe(ch.repeat(under));
    expect(overflows(event(ch.repeat(over)))).toBe(true);
  });

  it("rejects an oversized non-ASCII event fed in small chunks, including a boundary inside a surrogate pair", () => {
    const text = event("😀".repeat(16400));
    const parser = new SseParser();
    let overflow = false;
    for (let i = 0; i < text.length && !overflow; i += 7) overflow = parser.feed(text.slice(i, i + 7)).overflow; // 7 units: splits pairs
    expect(overflow).toBe(true);
  });

  it("accepts the same non-ASCII event fed in small chunks when it is under the limit", () => {
    const text = event("😀".repeat(15000));
    const parser = new SseParser();
    const events = [];
    for (let i = 0; i < text.length; i += 7) events.push(...parser.feed(text.slice(i, i + 7)).events);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("😀".repeat(15000));
  });

  it("counts accumulated data across lines, so several small non-ASCII data lines can overflow", () => {
    const line = `data: ${"€".repeat(8000)}\n`; // 24 KB each
    expect(overflows(line + "\n")).toBe(false);
    expect(overflows(line + line + "\n")).toBe(false); // 48 KB
    expect(overflows(line + line + line + "\n")).toBe(true); // 72 KB, though no line is near the limit
  });

  it("counts an unterminated non-ASCII line against the buffer limit", () => {
    expect(overflows("data: " + "€".repeat(22000))).toBe(true);
    expect(overflows("data: " + "€".repeat(20000))).toBe(false);
  });

  it("keeps the ASCII behaviour, and CR, LF and CRLF still end lines", () => {
    expect(overflows(event("x".repeat(65520)))).toBe(false);
    expect(overflows(event("x".repeat(MAX_SSE_BYTES)))).toBe(true);
    const events = new SseParser().feed("event: a\r\ndata: é€\r\n\r\nevent: b\rdata: 😀\r\r").events;
    expect(events).toEqual([
      { event: "a", data: "é€" },
      { event: "b", data: "😀" },
    ]);
  });
});

describe("rate and timestamp validation match the AD-4 schema exactly (F3)", () => {
  const rateShown = (rate: string) => {
    const values = freshValues();
    values[3] = makeValue("USD", "INR", 1000, "fresh", rate);
    const d = decodeMessage("snapshot", json(snapshot(1, values)), ctx0);
    return d.kind === "snapshot" && d.values[3]?.rate === rate;
  };
  const timeAccepted = (t: string) => decodeMessage("heartbeat", json({ ...heartbeat(2), server_time: t }), ctx1).kind === "heartbeat";

  // positive_decimal: ^(0\.[0-9]*[1-9][0-9]*|[1-9][0-9]*(\.[0-9]+)?)$ and maxLength 40
  it.each(["1", "9", "10", "123456", "1.2345", "10.25", "1.0", "1.50", "0.5", "0.0001", "0.10", "0.00001", "1." + "1".repeat(38)])(
    "shows the valid rate %j",
    (rate) => expect(rateShown(rate)).toBe(true),
  );
  it.each(["0", "0.0", "0.000", "00.5", "007", "01", "1.", ".5", "-1", "-0.5", "+1", "1e3", "1E3", "1,5", " 1", "1 ", "", "NaN", "Infinity", "0x10"])(
    "withholds the rate %j that the schema forbids",
    (rate) => expect(rateShown(rate)).toBe(false),
  );
  it("allows exactly 40 characters and not 41", () => {
    expect(("1." + "1".repeat(38)).length).toBe(40);
    expect(rateShown("1." + "1".repeat(38))).toBe(true);
    expect(rateShown("1." + "1".repeat(39))).toBe(false);
    expect(rateShown("1".repeat(40))).toBe(true);
    expect(rateShown("1".repeat(41))).toBe(false);
  });
  it("withholds a rate that is not a string", () => {
    const values = freshValues();
    values[3] = {
      ...makeValue("USD", "INR", 1000, "fresh"),
      event: makeEvent("USD", "INR", "1", { payload: { base_currency: "USD", quote_currency: "INR", rate: 1.5, rate_type: "mid" } }),
    };
    const d = decodeMessage("snapshot", json(snapshot(1, values)), ctx0);
    expect(d.kind === "snapshot" && d.values[3]?.unavailable).toBe(true);
  });

  // timestamp: exactly three fractional digits, in-range month/day/hour/minute/second, and a trailing Z
  it.each(["2026-11-24T10:00:00.000Z", "2026-11-24T10:00:00.123Z", "2026-01-31T23:59:59.999Z", "2026-12-01T00:00:00.000Z"])(
    "accepts the server_time %s",
    (t) => expect(timeAccepted(t)).toBe(true),
  );
  it.each([
    "2026-11-24T10:00:00Z", // no fraction
    "2026-11-24T10:00:00.1Z",
    "2026-11-24T10:00:00.12Z",
    "2026-11-24T10:00:00.1234Z",
    "2026-11-24T10:00:00.000+00:00",
    "2026-11-24T10:00:00.000",
    "2026-11-24 10:00:00.000Z",
    "2026-13-01T10:00:00.000Z", // month 13
    "2026-00-10T10:00:00.000Z",
    "2026-11-32T10:00:00.000Z",
    "2026-11-00T10:00:00.000Z",
    "2026-11-24T24:00:00.000Z",
    "2026-11-24T10:60:00.000Z",
    "2026-11-24T10:00:60.000Z",
    "26-11-24T10:00:00.000Z",
    "",
  ])("rejects the server_time %j", (t) => expect(timeAccepted(t)).toBe(false));
});

describe("timestamp calendar validation: impossible dates cannot pass (AD-4 format kept exactly)", () => {
  const two = (n: number) => String(n).padStart(2, "0");
  const ts = (year: number, month: number, day: number, time = "10:00:00.000") =>
    `${String(year).padStart(4, "0")}-${two(month)}-${two(day)}T${time}Z`;
  const viaMessage = (t: string) => decodeMessage("heartbeat", json({ ...heartbeat(2), server_time: t }), ctx1).kind === "heartbeat";

  it("knows the length of every month, in an ordinary year and a leap year", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => daysInMonth(2026, m))).toEqual([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => daysInMonth(2024, m))).toEqual([31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
  });

  it.each([2026, 2024])("accepts the last day of every month and rejects the day after it (%i)", (year) => {
    for (let month = 1; month <= 12; month++) {
      const last = daysInMonth(year, month);
      expect(isAd4Timestamp(ts(year, month, last))).toBe(true);
      expect(isAd4Timestamp(ts(year, month, last + 1))).toBe(false); // 29 or later, per month; 32 is rejected by the pattern
      expect(isAd4Timestamp(ts(year, month, 1))).toBe(true);
    }
  });

  it.each([
    ["April", 4], ["June", 6], ["September", 9], ["November", 11],
  ])("%s has 30 days: the 30th passes and the 31st does not", (_n, month) => {
    expect(isAd4Timestamp(ts(2026, month, 30))).toBe(true);
    expect(isAd4Timestamp(ts(2026, month, 31))).toBe(false);
  });

  it.each([1, 3, 5, 7, 8, 10, 12])("month %i has 31 days", (month) => {
    expect(isAd4Timestamp(ts(2026, month, 31))).toBe(true);
  });

  it("rejects February 30 and 31 in every kind of year, leap or not", () => {
    for (const year of [2024, 2026, 2000, 1900, 2100]) {
      expect(isAd4Timestamp(ts(year, 2, 30))).toBe(false);
      expect(isAd4Timestamp(ts(year, 2, 31))).toBe(false);
    }
  });

  it.each([2000, 2004, 2024, 2096, 2400, 2028])("accepts February 29 in the leap year %i", (year) => {
    expect(isAd4Timestamp(ts(year, 2, 29))).toBe(true);
    expect(isAd4Timestamp(ts(year, 2, 28))).toBe(true);
  });

  it.each([2023, 2025, 2026, 2027, 1900, 2100, 2200, 2300, 2500])("rejects February 29 in the non-leap year %i (including century years not divisible by 400)", (year) => {
    expect(isAd4Timestamp(ts(year, 2, 29))).toBe(false);
    expect(isAd4Timestamp(ts(year, 2, 28))).toBe(true);
  });

  it("rejects day 00, day 32 and larger, and month 00 and 13 and larger", () => {
    for (const day of [0, 32, 33, 99]) expect(isAd4Timestamp(ts(2026, 11, day))).toBe(false);
    for (const month of [0, 13, 14, 99]) expect(isAd4Timestamp(ts(2026, month, 10))).toBe(false);
  });

  it.each(["00:00:00.000", "00:00:00.999", "12:30:45.500", "23:59:59.999", "23:00:00.000", "00:59:59.000"])("accepts the time %s", (time) => {
    expect(isAd4Timestamp(ts(2026, 11, 24, time))).toBe(true);
  });

  it.each([
    "24:00:00.000", // hour 24
    "25:00:00.000",
    "99:00:00.000",
    "10:60:00.000", // minute 60
    "10:99:00.000",
    "10:00:60.000", // second 60, so no leap second
    "10:00:99.000",
    "1:00:00.000", // one-digit components
    "10:0:00.000",
    "10:00:0.000",
    "10:00:00.00", // fraction not exactly three digits
    "10:00:00.0000",
    "10:00:00",
    "10-00-00.000", // wrong separators
    "-1:00:00.000",
    "aa:00:00.000",
  ])("rejects the time %s", (time) => {
    expect(isAd4Timestamp(ts(2026, 11, 24, time))).toBe(false);
  });

  it("rejects a bad calendar date even with a perfect time, and a bad time even with a perfect date", () => {
    expect(isAd4Timestamp("2026-02-30T10:00:00.000Z")).toBe(false);
    expect(isAd4Timestamp("2026-11-24T24:00:00.000Z")).toBe(false);
    expect(isAd4Timestamp("2024-02-29T23:59:59.999Z")).toBe(true);
  });

  it("keeps the exact format: no other zone, no space, no missing Z, no padding, no surrounding text", () => {
    for (const t of [
      "2024-02-29T10:00:00.000+00:00", "2024-02-29T10:00:00.000z", "2024-02-29 10:00:00.000Z", "2024-02-29T10:00:00.000",
      " 2024-02-29T10:00:00.000Z", "2024-02-29T10:00:00.000Z ", "2024-02-29T10:00:00.000Z\n", "20240229T100000.000Z", "24-02-29T10:00:00.000Z", "",
    ]) {
      expect(isAd4Timestamp(t)).toBe(false);
    }
  });

  it("is applied to server_time in a message: February 30 is a protocol fault, a leap day is fine", () => {
    expect(viaMessage("2024-02-29T10:00:00.000Z")).toBe(true);
    expect(viaMessage("2026-02-29T10:00:00.000Z")).toBe(false);
    expect(viaMessage("2026-02-30T10:00:00.000Z")).toBe(false);
    expect(viaMessage("2026-04-31T10:00:00.000Z")).toBe(false);
    expect(viaMessage("2026-11-24T23:59:60.000Z")).toBe(false);
  });
});
