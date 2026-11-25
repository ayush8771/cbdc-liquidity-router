import { PAIRS, SOURCE_ID } from "../../src/observations/constants.js";
import { validateEnvelope } from "../../src/observations/envelope.js";

// Test-only, strict PRODUCER verdict for one `data:` payload of the observation
// stream (AD-1 v0.5 §3.2, §3.3.3; P-8). Express produces these messages and
// has no runtime validator for them, so the shared stream-message fixtures are
// judged here. It mirrors, rule for rule and without relaxation:
//   - contracts/events/stream-message.v1.schema.json (closed at every level), and
//   - the "stream" semantic rules of infra/scripts/check_event_contracts.py.
// Embedded events are judged by the backend's own validateEnvelope (AD-4 schema,
// hash, real dates, retrieved <= emitted, the slice's source, pair and rate
// type) plus the two slice rules the store applies: validated only, and a
// source timestamp. It returns every problem found; an empty list is "valid".
// It is in no image: the Dockerfile copies src/ only into runtime stages.

type Obj = Record<string, unknown>;

const MAX_SAFE = 9007199254740991;
const TYPES = ["snapshot", "update", "heartbeat"] as const;
const KEYS: Record<(typeof TYPES)[number], readonly string[]> = {
  snapshot: ["protocol_version", "type", "stream_seq", "server_time", "source", "profile", "values"],
  update: ["protocol_version", "type", "stream_seq", "server_time", "source", "value"],
  heartbeat: ["protocol_version", "type", "stream_seq", "server_time", "source"],
};
const PROFILE_KEYS = [
  "expected_interval_ms",
  "live_max_age_ms",
  "stale_after_ms",
  "unavailable_after_ms",
  "clock_tolerance_ms",
] as const;
const VALUE_KEYS = ["base_currency", "quote_currency", "event", "age_ms", "freshness"] as const;
const STATUSES = ["starting", "ok", "outage"];
const FRESHNESS = ["fresh", "stale", "unavailable"];
// The envelope schema's $defs/timestamp, which server_time references.
const TIMESTAMP =
  /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/;
const CURRENCY = /^[A-Z]{3}$/;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Obj, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(value, k));
}

function intIn(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= MAX_SAFE;
}

interface Profile {
  stale_after_ms: number;
  unavailable_after_ms: number;
  live_max_age_ms: number | null;
}

/** Schema problems of $defs/profile. */
function profileSchema(p: unknown): string[] {
  if (!isObject(p) || !exactKeys(p, PROFILE_KEYS)) return ["schema: profile is not the closed five-field object"];
  const out: string[] = [];
  for (const k of ["expected_interval_ms", "stale_after_ms", "unavailable_after_ms", "clock_tolerance_ms"] as const) {
    if (!intIn(p[k], 1)) out.push(`schema: profile.${k} is not a positive integer`);
  }
  if (p.live_max_age_ms !== null && !intIn(p.live_max_age_ms, 1)) {
    out.push("schema: profile.live_max_age_ms is neither null nor a positive integer");
  }
  return out;
}

/** Schema problems of $defs/value (the embedded event is judged semantically, below). */
function valueSchema(v: unknown, where: string): string[] {
  if (!isObject(v) || !exactKeys(v, VALUE_KEYS)) return [`schema: ${where} is not the closed five-field object`];
  const out: string[] = [];
  if (typeof v.base_currency !== "string" || !CURRENCY.test(v.base_currency)) out.push(`schema: ${where}.base_currency`);
  if (typeof v.quote_currency !== "string" || !CURRENCY.test(v.quote_currency)) out.push(`schema: ${where}.quote_currency`);
  if (v.event !== null && !isObject(v.event)) out.push(`schema: ${where}.event is neither null nor an object`);
  if (v.age_ms !== null && !intIn(v.age_ms, 0)) out.push(`schema: ${where}.age_ms is neither null nor a non-negative integer`);
  if (!FRESHNESS.includes(v.freshness as string)) out.push(`schema: ${where}.freshness is not a known state`);
  if (v.freshness === "unavailable") {
    if (v.event !== null || v.age_ms !== null) out.push(`schema: ${where} is unavailable but carries an event or an age`);
  } else if (!isObject(v.event) || typeof v.age_ms !== "number") {
    out.push(`schema: ${where} is ${String(v.freshness)} without an event and an age`);
  }
  return out;
}

/** The checker's event_problems: AD-4 envelope rules plus the slice rules. */
function eventProblems(event: Obj, where: string): string[] {
  const result = validateEnvelope(event);
  if (!result.ok) return [`${where}.event: rejected by validateEnvelope (${result.reason})`];
  const out: string[] = [];
  if (result.event.validation.status !== "validated") out.push(`${where}.event: slice: a quarantined event is never served`);
  if (result.event.timestamps.source_timestamp === null) out.push(`${where}.event: slice: source_timestamp is null`);
  return out;
}

/** The checker's value_problems (semantic; runs only on a schema-valid message). */
function valueProblems(v: Obj, profile: Profile | null, where: string): string[] {
  if (v.event === null) return [];
  const event = v.event as Obj;
  const out = eventProblems(event, where);
  const payload = event.payload as Obj;
  if (payload.base_currency !== v.base_currency || payload.quote_currency !== v.quote_currency) {
    out.push(`${where}: value pair differs from its event's pair`);
  }
  if (profile !== null && v.age_ms !== null) {
    const age = v.age_ms as number;
    if (age > profile.unavailable_after_ms) {
      out.push(`${where}: a value older than unavailable_after_ms must be unavailable, with no number`);
    } else if (age > profile.stale_after_ms !== (v.freshness === "stale")) {
      out.push(`${where}: freshness disagrees with age_ms and stale_after_ms (exactly stale_after_ms is fresh)`);
    }
  }
  return out;
}

export function streamMessageProblems(message: unknown): string[] {
  if (!isObject(message)) return ["schema: (root) is not an object"];
  const type = message.type;
  if (!TYPES.includes(type as (typeof TYPES)[number])) return ["schema: type matches none of snapshot, update, heartbeat"];
  const t = type as (typeof TYPES)[number];
  if (!exactKeys(message, KEYS[t])) return [`schema: a ${t} has exactly ${KEYS[t].join(", ")}`];

  const out: string[] = [];
  if (message.protocol_version !== "1.0") out.push("schema: protocol_version is not 1.0");
  if (!intIn(message.stream_seq, 1)) out.push("schema: stream_seq is not an integer >= 1");
  if (typeof message.server_time !== "string" || !TIMESTAMP.test(message.server_time)) {
    out.push("schema: server_time is not an AD-4 timestamp");
  }
  const source = message.source;
  if (!isObject(source) || !exactKeys(source, ["source_id", "status"])) {
    out.push("schema: source is not the closed {source_id, status} object");
  } else {
    if (source.source_id !== SOURCE_ID) out.push("schema: source.source_id is not synthetic.fx");
    if (!STATUSES.includes(source.status as string)) out.push("schema: source.status is not a known status");
  }
  if (t === "snapshot") {
    out.push(...profileSchema(message.profile));
    const values = message.values;
    if (!Array.isArray(values) || values.length !== PAIRS.length) {
      out.push(`schema: values must be exactly ${PAIRS.length} items`);
    } else {
      values.forEach((v, i) => {
        out.push(...valueSchema(v, `values/${i}`));
        const [base, quote] = PAIRS[i] as readonly [string, string];
        if (isObject(v) && (v.base_currency !== base || v.quote_currency !== quote)) {
          out.push(`schema: values/${i} must be ${base}/${quote} (the AD-1 §3.4 order)`);
        }
      });
    }
  } else if (t === "update") {
    out.push(...valueSchema(message.value, "value"));
  }
  // As in the shared checker, semantic rules run only on a schema-valid message.
  if (out.length > 0) return out;

  if (t === "snapshot") {
    const p = message.profile as unknown as Profile;
    if (p.stale_after_ms > p.unavailable_after_ms) out.push("profile: stale_after_ms exceeds unavailable_after_ms");
    if (p.live_max_age_ms !== null && p.live_max_age_ms > p.stale_after_ms) {
      out.push("profile: live_max_age_ms exceeds stale_after_ms");
    }
    (message.values as Obj[]).forEach((v, i) => out.push(...valueProblems(v, p, `values/${i}`)));
  } else if (t === "update") {
    out.push(...valueProblems(message.value as Obj, null, "value"));
  }
  return out;
}
