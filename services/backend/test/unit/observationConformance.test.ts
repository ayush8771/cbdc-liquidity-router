import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import {
  POLL_CONTRACT_FAULT_DELAY_MS,
  POLL_INTERVAL_MS,
  PROFILE,
  type SourceProfile,
  type SourceStatus,
} from "../../src/observations/constants.js";
import { validateEnvelope, type FxEnvelope } from "../../src/observations/envelope.js";
import { evaluateValue, freshnessOf } from "../../src/observations/freshness.js";
import { classify, createPoller, type FetchOutcome } from "../../src/observations/poller.js";
import { createObservationStore, type ObservationStore } from "../../src/observations/store.js";
import { createStreamHub } from "../../src/observations/streamHub.js";
import { streamMessageProblems } from "../helpers/streamMessageVerdict.js";

// P-8 (AD-1 v0.5 §3.7): the backend's verdict on every shared fixture in
// contracts/events/fixtures/ must equal the fixture's "valid" flag, the same
// verdict infra/scripts/check_event_contracts.py gives. The files are read in
// place (never copied); a missing directory, a missing or extra file, an
// unknown verdict, an unclassified fixture or a rejection for a reason other
// than the pinned one fails here instead of skipping.
//
// Two kinds of evidence, kept apart:
//   ACTUAL BACKEND PATHS (production code decides):
//     envelope          validateEnvelope, the AD-4 trust boundary.
//     ingestion-latest  classify (the poller's real response path, which runs
//                       parseLatestResponse), then store.ingest per event; a success
//                       body is valid only if every event becomes the current value.
//     stream-message    valid fixtures are rebuilt by the real evaluateValue and the
//                       real stream hub: every value, byte for byte, in a real frame.
//   TEST-ONLY VERDICT (helpers/streamMessageVerdict.ts): Express produces stream
//     messages and has no runtime validator for them, so all 25 stream fixtures are
//     judged by a strict copy of the stream-message schema and the checker's stream
//     rules. Every frame the real hub writes here must also pass it.
//
// VALIDATION LAYERS for ingestion error responses (approved by the contract
// owners, Ayush and Nisarga, for P-8): Express acts on the HTTP status of a
// non-200 response only (AD-1 §3.1, "Express as client") and never parses its
// body. Body-schema validity of an error body (code, message, status pairing,
// closed fields) is the producer's (ingestion's) obligation, enforced by the
// shared Python checker. The backend obligation tested here is different:
// classification by status per AD-1 §3.1, and that no error body, valid or
// invalid, can ever enter the observation store or any SSE output.

const EVENTS_DIR = new URL("../../../../contracts/events/fixtures/", import.meta.url);
const quietLogger = { info() {}, warn() {}, error() {}, debug() {} } as never;

/** The exact shared fixture set this suite covers. A new or removed file must be classified here. */
const EXPECTED: Record<string, { valid: number; invalid: number }> = {
  envelope: { valid: 4, invalid: 19 },
  "ingestion-latest": { valid: 8, invalid: 17 },
  "stream-message": { valid: 6, invalid: 19 },
};

/** The validateEnvelope reason each invalid envelope fixture must be rejected with. */
const ENVELOPE_REASON: Record<string, string> = {
  "invalid_basis_none_with_timestamp.json": "schema",
  "invalid_extra_field.json": "schema",
  "invalid_impossible_date.json": "invalid_date",
  "invalid_missing_raw_sha256.json": "schema",
  "invalid_payload_changed_after_hash.json": "hash_mismatch",
  "invalid_quarantined_without_reasons.json": "schema",
  "invalid_rate_is_number.json": "schema",
  "invalid_rate_zero.json": "schema",
  "invalid_retrieved_after_emitted.json": "retrieved_after_emitted",
  // The allowlist also covers differing currencies (envelope.ts).
  "invalid_same_currencies.json": "pair_not_allowed",
  "invalid_synthetic_block_null.json": "not_synthetic",
  "invalid_synthetic_source_prefix.json": "not_synthetic",
  "invalid_synthetic_transport_mismatch.json": "not_synthetic",
  "invalid_synthetic_with_url.json": "not_synthetic",
  "invalid_timestamp_without_millis.json": "schema",
  "invalid_unknown_version.json": "schema",
  "invalid_usage_not_display_only.json": "schema",
  "invalid_validated_with_reasons.json": "schema",
  "invalid_wrong_hash.json": "hash_mismatch",
};

/** Invalid success bodies: the body-level reason (classify) or the per-event store outcome. */
const LATEST_REASON: Record<string, string> = {
  "invalid_duplicate_pair.json": "body:duplicate_pair",
  "invalid_event_with_wrong_hash.json": "event:rejected:hash_mismatch",
  "invalid_extra_field.json": "body:bad_body",
  "invalid_five_events.json": "body:too_many_events",
  "invalid_instance_id_not_uuid.json": "body:bad_body",
  "invalid_missing_events.json": "body:bad_body",
  "invalid_null_source_timestamp.json": "event:rejected:null_source_timestamp",
  "invalid_pair_outside_allowlist.json": "event:rejected:pair_not_allowed",
  "invalid_quarantined_event_served.json": "event:quarantined",
  "invalid_rate_type_not_mid.json": "event:rejected:pair_not_allowed",
  "invalid_unknown_version.json": "body:unknown_version",
  "invalid_unsorted.json": "body:unsorted",
  "invalid_wrong_source_id.json": "body:bad_body",
};

/**
 * Invalid ingestion error BODIES. Their body verdict is the producer's (see
 * VALIDATION LAYERS above); here they are asserted to be classified by status
 * and never accepted as observation data. Listed by name so nothing is waved through.
 */
const ERROR_BODY_ONLY = new Set([
  "invalid_empty_message.json",
  "invalid_internal_detail.json",
  "invalid_status_mismatch.json",
  "invalid_unknown_code.json",
]);

/** AD-1 §3.1 "Express as client": 3xx/401/403/other 4xx a contract fault (5 s); 5xx the normal interval. */
function expectedErrorVerdict(status: number): { reason: string; delayMs: number } {
  if (status === 429) throw new Error("no shared fixture uses 429; classify it explicitly if one is added");
  if (status >= 500) return { reason: "http_5xx", delayMs: POLL_INTERVAL_MS };
  if (status >= 300) return { reason: "contract_fault", delayMs: POLL_CONTRACT_FAULT_DELAY_MS };
  throw new Error(`status ${status} is not an error status`);
}

/** A substring of the problem each invalid stream fixture must be rejected for (its stated reason). */
const STREAM_PROBLEM: Record<string, string> = {
  "invalid_age_over_unavailable_with_event.json": "older than unavailable_after_ms",
  "invalid_event_wrong_hash.json": "validateEnvelope (hash_mismatch)",
  "invalid_fresh_but_age_over_stale.json": "freshness disagrees",
  "invalid_fresh_with_null_event.json": "is fresh without an event",
  "invalid_heartbeat_with_value.json": "a heartbeat has exactly",
  "invalid_missing_source.json": "a heartbeat has exactly",
  "invalid_profile_null_unavailable_after.json": "profile.unavailable_after_ms is not a positive integer",
  "invalid_profile_stale_after_unavailable.json": "stale_after_ms exceeds unavailable_after_ms",
  "invalid_protocol_version_major_2.json": "protocol_version is not 1.0",
  "invalid_server_time_format.json": "server_time is not an AD-4 timestamp",
  "invalid_snapshot_three_values.json": "values must be exactly 4",
  "invalid_snapshot_wrong_order.json": "the AD-1 §3.4 order",
  "invalid_stale_but_age_under_stale.json": "freshness disagrees",
  "invalid_stream_seq_zero.json": "stream_seq is not an integer >= 1",
  "invalid_unavailable_with_event.json": "is unavailable but carries an event or an age",
  "invalid_unknown_source_status.json": "source.status is not a known status",
  "invalid_unknown_type.json": "type matches none",
  "invalid_update_extra_field.json": "a update has exactly",
  "invalid_update_pair_mismatch.json": "value pair differs from its event's pair",
};

interface Fixture {
  file: string;
  description: string;
  valid: boolean;
  reason?: string;
  status?: number;
  instance: unknown;
}

function loadKind(kind: string): Fixture[] {
  const dir = new URL(`${kind}/`, EVENTS_DIR);
  assert.ok(existsSync(dir), `missing shared fixture directory contracts/events/fixtures/${kind}/`);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  return files.map((file) => {
    const raw = JSON.parse(readFileSync(new URL(file, dir), "utf8")) as Record<string, unknown>;
    assert.ok(typeof raw.description === "string" && "instance" in raw, `${kind}/${file}: needs description and instance`);
    assert.ok(typeof raw.valid === "boolean", `${kind}/${file}: unknown verdict ${JSON.stringify(raw.valid)}`);
    assert.ok(file.startsWith(raw.valid ? "valid_" : "invalid_"), `${kind}/${file}: name disagrees with valid=${raw.valid}`);
    if (raw.valid === false) assert.ok(typeof raw.reason === "string" && raw.reason !== "", `${kind}/${file}: needs a reason`);
    return { file, ...(raw as Omit<Fixture, "file">) };
  });
}

function checkCounts(kind: string, fixtures: Fixture[]): void {
  const valid = fixtures.filter((f) => f.valid).length;
  assert.deepEqual(
    { valid, invalid: fixtures.length - valid },
    EXPECTED[kind],
    `contracts/events/fixtures/${kind}: the fixture set changed; classify the new files in this suite`,
  );
}

const isErrorBody = (fx: Fixture) => typeof fx.instance === "object" && fx.instance !== null && "error" in fx.instance;
const invalidNames = (list: Fixture[]) => list.filter((f) => !f.valid).map((f) => f.file).sort();

const envelopes = loadKind("envelope");
const latest = loadKind("ingestion-latest");
const stream = loadKind("stream-message");

describe("shared fixture coverage (contracts/events/fixtures)", () => {
  it("covers exactly the expected fixture files (73)", () => {
    checkCounts("envelope", envelopes);
    checkCounts("ingestion-latest", latest);
    checkCounts("stream-message", stream);
    assert.equal(envelopes.length + latest.length + stream.length, 73);
    assert.equal(stream.length, 25);
  });

  it("every invalid fixture has exactly one pinned expectation, and no expectation names a missing file", () => {
    assert.deepEqual(invalidNames(envelopes), Object.keys(ENVELOPE_REASON).sort());
    assert.deepEqual(invalidNames(stream), Object.keys(STREAM_PROBLEM).sort());
    assert.deepEqual(
      invalidNames(latest),
      [...Object.keys(LATEST_REASON), ...ERROR_BODY_ONLY].sort(),
    );
    for (const name of ERROR_BODY_ONLY) {
      const fx = latest.find((f) => f.file === name)!;
      assert.ok(isErrorBody(fx), `${name} is not an error body`);
      assert.ok(Number.isInteger(fx.status), `${name}: needs an HTTP status`);
    }
    for (const name of Object.keys(LATEST_REASON)) assert.ok(!isErrorBody(latest.find((f) => f.file === name)!), name);
  });

  it("every message type and freshness state has a valid stream fixture", () => {
    const valid = stream.filter((f) => f.valid).map((f) => f.instance as Message);
    assert.deepEqual(new Set(valid.map((m) => m.type)), new Set(["snapshot", "update", "heartbeat"]));
    assert.deepEqual(new Set(valid.flatMap(valuesOf).map((v) => v.freshness)), new Set(["fresh", "stale", "unavailable"]));
  });
});

describe("envelope fixtures: validateEnvelope (actual backend path)", () => {
  for (const fx of envelopes) {
    it(`${fx.file}: ${fx.valid ? "accepted" : `rejected as ${ENVELOPE_REASON[fx.file]}`}`, () => {
      const result = validateEnvelope(fx.instance);
      if (fx.valid) assert.ok(result.ok, result.ok ? "" : `rejected (${result.reason})`);
      else assert.deepEqual(result.ok ? "accepted" : result.reason, ENVELOPE_REASON[fx.file]);
    });
  }
});

function response(status: number, body: unknown): FetchOutcome {
  return {
    kind: "response",
    status,
    contentType: "application/json; charset=utf-8",
    retryAfter: undefined,
    body: Buffer.from(JSON.stringify(body), "utf8"),
  };
}

/** The backend outcome of one success body: "accepted", "body:<reason>" or "event:<outcome>" (first refused event). */
function latestOutcome(instance: unknown): string {
  const verdict = classify(response(200, instance));
  if (!verdict.ok) return `body:${verdict.reason}`;
  const generated = Date.parse((instance as { generated_at: string }).generated_at);
  const store = createObservationStore({ logger: quietLogger, now: () => generated });
  for (const event of verdict.events) {
    const r = store.ingest(event, generated);
    if (r.kind !== "update") return `event:${r.kind === "rejected" ? `rejected:${r.reason}` : r.kind}`;
  }
  assert.equal(store.size(), verdict.events.length);
  return "accepted";
}

describe("ingestion-latest fixtures: classify + store.ingest (actual backend path)", () => {
  for (const fx of latest) {
    if (!isErrorBody(fx)) {
      it(`${fx.file}: ${fx.valid ? "accepted, every event current" : LATEST_REASON[fx.file]}`, () => {
        assert.equal(fx.status, undefined, "a success body carries no status");
        assert.equal(latestOutcome(fx.instance), fx.valid ? "accepted" : LATEST_REASON[fx.file]);
      });
    } else {
      it(`${fx.file}: status ${fx.status} classified per AD-1 §3.1, never data`, () => {
        if (!fx.valid) assert.ok(ERROR_BODY_ONLY.has(fx.file), `unclassified invalid error fixture ${fx.file}`);
        const verdict = classify(response(fx.status as number, fx.instance));
        assert.deepEqual(verdict, { ok: false, ...expectedErrorVerdict(fx.status as number) });
        // The same body under a 200 is still not observation data: it is not a latest body.
        assert.deepEqual(classify(response(200, fx.instance)), { ok: false, reason: "bad_body", delayMs: POLL_INTERVAL_MS });
      });
    }
  }
});

/** Real poller -> real store -> real hub, for one fetch outcome; returns what reached the store and SSE. */
async function pipeline(outcome: FetchOutcome) {
  const now = Date.parse("2026-11-24T10:00:01.000Z");
  const clock = { now: () => now, setTimeout: () => 0, clearTimeout() {} };
  const store: ObservationStore = createObservationStore({ logger: quietLogger, now: () => now });
  const updates: string[] = [];
  const poller = createPoller({ fetch: async () => outcome, store, logger: quietLogger, clock, onUpdate: (r) => updates.push(r.pair) });
  poller.start();
  await new Promise((resolve) => setImmediate(resolve));
  poller.stop();
  const frames: string[] = [];
  const hub = createStreamHub({
    lookup: (b, q) => store.current(b, q),
    sourceStatus: () => poller.status(),
    logger: quietLogger,
    clock,
  });
  const slot = hub.reserve("pipeline");
  assert.ok(slot.ok);
  hub.open(slot.slot, { write: (c: string) => (frames.push(c), true), end() {}, destroy() {}, on() {}, off() {} });
  for (const pair of updates) hub.publishUpdate(...(pair.split("/") as [string, string]));
  // Not awaited: the fake clock never fires the shutdown destroy timer. Frames are already written.
  void hub.shutdown();
  const messages = frames.map((f) => JSON.parse(/\ndata: (.*)\n\n$/s.exec(f)![1] as string) as Message);
  return { store, updates, messages, status: poller.status() };
}

describe("ingestion error bodies never reach the store or SSE (real poller, store and hub)", () => {
  for (const fx of latest.filter(isErrorBody)) {
    it(`${fx.file}: store empty, no update, snapshot all unavailable with no event`, async () => {
      const { store, updates, messages, status } = await pipeline(response(fx.status as number, fx.instance));
      assert.equal(store.size(), 0);
      assert.deepEqual(updates, []);
      assert.equal(status, "starting", "one failed poll does not report ok");
      assert.deepEqual(messages.map((m) => m.type), ["snapshot"]);
      for (const v of valuesOf(messages[0]!)) assert.deepEqual([v.event, v.age_ms, v.freshness], [null, null, "unavailable"]);
      assert.ok(!JSON.stringify(messages).includes('"error"'), "no part of the error body is in a frame");
      assert.deepEqual(streamMessageProblems(messages[0]), []);
    });
  }

  it("positive control: valid_four_events reaches the store and SSE through the same pipeline", async () => {
    const fx = latest.find((f) => f.file === "valid_four_events.json")!;
    const { store, updates, messages, status } = await pipeline(response(200, fx.instance));
    assert.equal(store.size(), 4);
    assert.equal(updates.length, 4);
    assert.equal(status, "ok");
    assert.deepEqual(messages.map((m) => m.type), ["snapshot", "update", "update", "update", "update"]);
    const events = (fx.instance as { events: unknown[] }).events;
    assert.deepEqual(valuesOf(messages[0]!).map((v) => v.event), events);
    for (const m of messages) assert.deepEqual(streamMessageProblems(m), []);
  });
});

type Value = { base_currency: string; quote_currency: string; event: FxEnvelope | null; age_ms: number | null; freshness: string };
type Message = {
  type: "snapshot" | "update" | "heartbeat";
  stream_seq: number;
  server_time: string;
  source: { source_id: string; status: SourceStatus };
  profile?: SourceProfile;
  values?: Value[];
  value?: Value;
};

function valuesOf(m: Message): Value[] {
  return m.values ?? (m.value ? [m.value] : []);
}

/** The real stream hub's frame for a fixture's configuration, written at clock time `nowMs`. */
function produce(m: Message, nowMs: number): Message {
  const events = new Map(
    valuesOf(m)
      .filter((v) => v.event !== null)
      .map((v) => [`${v.base_currency}/${v.quote_currency}`, v.event as FxEnvelope]),
  );
  const hub = createStreamHub({
    lookup: (b, q) => events.get(`${b}/${q}`),
    sourceStatus: () => m.source.status,
    logger: quietLogger,
    clock: { now: () => nowMs, setTimeout: () => 0, clearTimeout() {} },
    profile: m.profile ?? PROFILE,
  });
  const frames: { event: string; msg: Message }[] = [];
  const sink = {
    write(chunk: string) {
      const match = /^event: (\w+)\ndata: (.*)\n\n$/s.exec(chunk);
      assert.ok(match, "not an SSE frame");
      frames.push({ event: match[1] as string, msg: JSON.parse(match[2] as string) as Message });
      return true;
    },
    end() {},
    destroy() {},
    on() {},
    off() {},
  };
  const slot = hub.reserve("conformance");
  assert.ok(slot.ok);
  hub.open(slot.slot, sink);
  // stream_seq is per connection: heartbeats advance it to the fixture's number.
  const last = m.type === "snapshot" ? 1 : m.stream_seq;
  while (frames.length < last - 1) hub.publishHeartbeat();
  if (m.type === "update") hub.publishUpdate(m.value!.base_currency, m.value!.quote_currency);
  if (m.type === "heartbeat") hub.publishHeartbeat();
  void hub.shutdown();
  const frame = frames[last - 1];
  assert.ok(frame, `the hub wrote no frame ${last}`);
  assert.equal(frame.event, frame.msg.type, "SSE event name equals type");
  assert.deepEqual(streamMessageProblems(frame.msg), [], "every real frame passes the strict verdict");
  return frame.msg;
}

/** The clock time at which the producer gives value `v` its fixture age (server_time for an unavailable value). */
function timeFor(m: Message, v: Value): number {
  return v.event === null
    ? Date.parse(m.server_time)
    : Date.parse(v.event.timestamps.source_timestamp as string) + (v.age_ms as number);
}

describe("stream-message fixtures: strict producer verdict (test-only helper)", () => {
  for (const fx of stream) {
    it(`${fx.file}: ${fx.valid ? "valid" : "invalid"}`, () => {
      const problems = streamMessageProblems(fx.instance);
      if (fx.valid) {
        assert.deepEqual(problems, [], "valid fixture rejected");
      } else {
        const want = STREAM_PROBLEM[fx.file] as string;
        assert.ok(problems.some((p) => p.includes(want)), `expected a problem containing "${want}", got ${JSON.stringify(problems)}`);
      }
    });
  }
});

describe("stream-message fixtures: valid ones written by the real producer (actual backend path)", () => {
  for (const fx of stream.filter((f) => f.valid)) {
    const m = fx.instance as Message;
    const profile = m.profile ?? PROFILE;

    it(`${fx.file}: each value equals evaluateValue and freshnessOf at its age`, () => {
      for (const v of valuesOf(m)) {
        assert.deepEqual(evaluateValue(v.base_currency, v.quote_currency, v.event ?? undefined, timeFor(m, v), profile), v);
        if (v.age_ms !== null) assert.equal(freshnessOf(v.age_ms, profile), v.freshness);
      }
    });

    it(`${fx.file}: the hub frame equals the fixture (header at server_time, each value at its age)`, () => {
      // Header: everything but the values, written at the fixture's server_time.
      const { values: _pv, value: _pu, ...head } = produce(m, Date.parse(m.server_time));
      const { values: _fv, value: _fu, ...want } = m;
      assert.deepEqual(head, want);
      // Values: the fixture's ages differ within one snapshot, so each value is
      // taken from a real frame written at the time that gives it its age, and
      // must equal the fixture's value exactly: pair, embedded envelope, age_ms,
      // freshness and nulls.
      valuesOf(m).forEach((v, i) => {
        const frame = produce(m, timeFor(m, v));
        assert.deepEqual(valuesOf(frame)[i], v, `value ${i} (${v.base_currency}/${v.quote_currency})`);
        assert.equal(valuesOf(frame).length, valuesOf(m).length);
      });
    });
  }
});
