import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CanonicalizationError, canonicalize, payloadSha256 } from "../../src/observations/canonical.js";
import { timestampMs, validateEnvelope } from "../../src/observations/envelope.js";
import { parseLatestResponse } from "../../src/observations/latestResponse.js";
import { latestBody, makeEvent } from "../helpers/observations.js";

type Obj = Record<string, any>;
const clone = (v: Obj): Obj => JSON.parse(JSON.stringify(v)) as Obj;

function rejected(event: unknown): string | undefined {
  const r = validateEnvelope(event);
  return r.ok ? undefined : r.reason;
}

describe("UUID letter case (owner clarification, bounded by the AD-4 schema)", () => {
  const upper = "ABCDEF01-2345-4678-89AB-CDEF01234567";

  it("accepts an uppercase instance_id, reports it lowercased, and leaves the body untouched", () => {
    const body = latestBody([], { instance_id: upper });
    const snapshot = JSON.stringify(body);
    const r = parseLatestResponse(body);
    assert.ok(r.ok);
    assert.equal(r.instanceId, upper.toLowerCase());
    assert.equal(r.instanceId, (parseLatestResponse(latestBody([], { instance_id: upper.toLowerCase() })) as { instanceId: string }).instanceId);
    assert.equal(JSON.stringify(body), snapshot);
    assert.equal(body.instance_id, upper);
  });

  it("still rejects an uppercase event_id or supersedes: AD-4 $defs.uuid is lowercase-only", () => {
    const event = makeEvent();
    assert.equal(rejected({ ...event, event_id: upper }), "schema");
    assert.equal(rejected({ ...event, supersedes: upper }), "schema");
  });
});

describe("observation canonical hash (RFC 8785 subset, P-9)", () => {
  it("reproduces the AD-4 §10 example hash", () => {
    const hash = payloadSha256("fx_rate", { base_currency: "USD", quote_currency: "INR", rate: "1.2345", rate_type: "mid" });
    assert.equal(hash, "22fe8747cb6a035235c3ad84c45c5214d271941c784a5a2e4cc0c8c048798ca4");
  });

  it("is independent of key order", () => {
    const a = payloadSha256("fx_rate", { rate_type: "mid", rate: "1.2345", quote_currency: "INR", base_currency: "USD" });
    assert.equal(a, "22fe8747cb6a035235c3ad84c45c5214d271941c784a5a2e4cc0c8c048798ca4");
  });

  it("emits sorted keys with no whitespace", () => {
    assert.equal(canonicalize({ b: "2", a: { d: "x", c: "y" } }), '{"a":{"c":"y","d":"x"},"b":"2"}');
    assert.equal(canonicalize({ q: 'a"b\\c' }), '{"q":"a\\"b\\\\c"}');
  });

  it("keeps trailing zeros: rates are strings, so 1.2340 and 1.234 hash differently", () => {
    const p = (rate: string) => payloadSha256("fx_rate", { base_currency: "USD", quote_currency: "INR", rate, rate_type: "mid" });
    assert.notEqual(p("1.2340"), p("1.234"));
  });

  it("refuses anything outside objects and printable ASCII strings", () => {
    for (const bad of [1, true, null, ["a"], { a: 1 }, { a: "é" }, { a: "\n" }]) {
      assert.throws(() => canonicalize(bad), CanonicalizationError);
    }
  });
});

describe("observation envelope validation (AD-4 v0.2, AD-1 v0.5 §3.4)", () => {
  it("accepts a valid synthetic fx_rate envelope for each allowlisted pair", () => {
    for (const [base, quote] of [["AED", "MXN"], ["EUR", "USD"], ["GBP", "PHP"], ["USD", "INR"]] as const) {
      const r = validateEnvelope(makeEvent({ base, quote }));
      assert.equal(r.ok, true, `${base}/${quote}`);
    }
  });

  it("accepts a well-formed quarantined envelope (withheld later by the store)", () => {
    assert.equal(validateEnvelope(makeEvent({ status: "quarantined" })).ok, true);
  });

  it("rejects pairs outside the allowlist, inverted pairs and other rate types", () => {
    assert.equal(rejected(makeEvent({ base: "INR", quote: "USD" })), "pair_not_allowed");
    assert.equal(rejected(makeEvent({ base: "USD", quote: "JPY" })), "pair_not_allowed");
    const bid = clone(makeEvent());
    bid.payload.rate_type = "bid";
    bid.payload_sha256 = payloadSha256("fx_rate", bid.payload);
    assert.equal(rejected(bid), "pair_not_allowed");
  });

  it("rejects a wrong or altered payload hash", () => {
    const e = clone(makeEvent());
    e.payload.rate = "9.9999";
    assert.equal(rejected(e), "hash_mismatch");
    const f = clone(makeEvent());
    f.payload_sha256 = "0".repeat(64);
    assert.equal(rejected(f), "hash_mismatch");
  });

  it("rejects non-synthetic or mismatched synthetic markers", () => {
    const cases: Array<(e: Obj) => void> = [
      (e) => (e.provenance_class = "real"),
      (e) => (e.source.transport = "poll"),
      (e) => (e.source.source_id = "synthetic.other"),
      (e) => (e.source.source_id = "provider.fx"),
      (e) => (e.synthetic = null),
      (e) => (e.source.source_url = "https://example.test/x"),
      (e) => (e.source.gate3_decision_ref = "G3-1"),
    ];
    for (const mutate of cases) {
      const e = clone(makeEvent());
      mutate(e);
      assert.equal(rejected(e), "not_synthetic", mutate.toString());
    }
  });

  it("rejects other event types even when well formed", () => {
    const e = clone(makeEvent());
    e.event_type = "bank_holiday";
    assert.equal(rejected(e), "unsupported_event_type");
  });

  it("rejects schema violations at every level (closed schema)", () => {
    const cases: Array<(e: Obj) => void> = [
      (e) => (e.extra = 1),
      (e) => delete e.raw_sha256,
      (e) => (e.schema_version = "1.1"),
      (e) => (e.schema_version = "2.0"),
      (e) => (e.event_id = "not-a-uuid"),
      (e) => (e.event_id = "00000000-0000-0000-8000-000000000001"),
      (e) => (e.usage = "routing_input"),
      (e) => (e.source.extra = null),
      (e) => (e.payload.extra = "x"),
      (e) => (e.payload.rate = "0"),
      (e) => (e.payload.rate = "-1.2"),
      (e) => (e.payload.rate = 1.2),
      (e) => (e.payload.rate = "01.2"),
      (e) => (e.payload.base_currency = "usd"),
      (e) => (e.timestamps.source_timestamp = "2026-11-24T10:00:00Z"),
      (e) => (e.timestamps.source_timestamp = "2026-11-24T10:00:00.000+00:00"),
      (e) => (e.timestamps.source_timestamp_basis = "none"),
      (e) => (e.validation.status = "rejected"),
      (e) => (e.validation.reasons = ["FUTURE_SOURCE_TIMESTAMP"]),
      (e) => ((e.validation.status = "quarantined"), (e.validation.reasons = [])),
      (e) => ((e.validation.status = "quarantined"), (e.validation.reasons = ["UNKNOWN"])),
      (e) => (e.synthetic.seed = -1),
      (e) => (e.synthetic.seed = 1.5),
      (e) => (e.synthetic.case_id = ""),
      (e) => (e.source_sequence = ""),
      (e) => (e.derived_from = ["x"]),
      (e) => (e.derivation = "method"),
      (e) => (e.supersedes = "nope"),
      (e) => (e.raw_sha256 = "ABC"),
      (e) => (e.review = { reviewer_ref: "r1", reviewed_at: "2026-11-24T10:00:00.000Z" }),
    ];
    for (const mutate of cases) {
      const e = clone(makeEvent());
      mutate(e);
      assert.equal(rejected(e), "schema", mutate.toString());
    }
    for (const bad of [null, [], "x", 1]) assert.equal(rejected(bad), "schema");
  });

  it("rejects impossible calendar dates and retrieved_at after emitted_at", () => {
    assert.equal(rejected(makeEvent({ sourceTimestamp: "2026-02-30T10:00:00.000Z" })), "invalid_date");
    assert.equal(rejected(makeEvent({ retrievedAt: "2026-04-31T10:00:00.000Z" })), "invalid_date");
    assert.equal(
      rejected(makeEvent({ retrievedAt: "2026-11-24T10:00:00.070Z", emittedAt: "2026-11-24T10:00:00.060Z" })),
      "retrieved_after_emitted",
    );
    assert.equal(timestampMs("2024-02-29T00:00:00.000Z"), Date.UTC(2024, 1, 29));
    assert.equal(timestampMs("2025-02-29T00:00:00.000Z"), undefined);
  });

  it("passes a null source_timestamp (basis none) to the store, which rejects it", () => {
    assert.equal(validateEnvelope(makeEvent({ sourceTimestamp: null })).ok, true);
  });

  it("reports the event_id of a rejected event only when well formed", () => {
    const e = clone(makeEvent({ eventId: "00000000-0000-5000-8000-0000000000aa" }));
    e.payload_sha256 = "0".repeat(64);
    assert.deepEqual(validateEnvelope(e), { ok: false, reason: "hash_mismatch", eventId: "00000000-0000-5000-8000-0000000000aa" });
    const f = clone(e);
    f.event_id = "bad";
    assert.deepEqual(validateEnvelope(f), { ok: false, reason: "schema" });
  });
});

describe("/v1/latest response parsing (AD-1 v0.5 §3.1)", () => {
  const ev = (base: string, quote: string) => makeEvent({ base, quote });

  it("accepts the empty state and a sorted response", () => {
    assert.equal(parseLatestResponse(latestBody([])).ok, true);
    const r = parseLatestResponse(latestBody([ev("AED", "MXN"), ev("EUR", "USD"), ev("GBP", "PHP"), ev("USD", "INR")]));
    assert.equal(r.ok, true);
  });

  it("rejects the whole response for a bad body, unknown version, duplicate pair or more than 4 events", () => {
    const reason = (b: unknown) => {
      const r = parseLatestResponse(b);
      return r.ok ? "ok" : r.reason;
    };
    assert.equal(reason([]), "bad_body");
    assert.equal(reason(latestBody([], { protocol_version: "2.0" })), "unknown_version");
    assert.equal(reason(latestBody([], { extra: 1 })), "bad_body");
    assert.equal(reason(latestBody([], { source_id: "synthetic.other" })), "bad_body");
    assert.equal(reason(latestBody([], { instance_id: "x" })), "bad_body");
    assert.equal(reason(latestBody([], { instance_id: "11111111-1111-4111-7111-111111111111" })), "bad_body");
    assert.equal(reason(latestBody([], { generated_at: "2026-11-24T10:00:00Z" })), "bad_body");
    assert.equal(reason(latestBody([], { events: {} })), "bad_body");
    const { events: _omit, ...missing } = latestBody([]);
    assert.equal(reason(missing), "bad_body");
    assert.equal(reason(latestBody([ev("USD", "INR"), ev("USD", "INR")])), "duplicate_pair");
    assert.equal(reason(latestBody([ev("AED", "MXN"), ev("EUR", "USD"), ev("GBP", "PHP"), ev("USD", "INR"), ev("USD", "JPY")])), "too_many_events");
    assert.equal(reason(latestBody([ev("USD", "INR"), ev("AED", "MXN")])), "unsorted");
  });

  it("returns individually invalid events for per-event rejection", () => {
    const r = parseLatestResponse(latestBody([{ junk: true }, ev("USD", "INR")]));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.events.length, 2);
  });
});
