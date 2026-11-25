import { freshnessOf } from "./freshness";
import { PAIRS, SOURCE_STATUSES, type Freshness, type Profile, type SourceState, type SourceStatus } from "./types";

/*
 * Client-side validation of one stream message (AD-1 v0.5 §3.3.3). The client trusts nothing it
 * is sent: a message that breaks the protocol is a *fault*; a single value that fails its
 * per-value checks is *withheld* (shown Unavailable, no number) and the rest of the message is used.
 * The client never re-derives a rate and never checks `payload_sha256`: Express owns that (§3.4).
 */

/** A value as decoded from a message, before the controller stamps its receipt time. */
export type DecodedValue = {
  base: string;
  quote: string;
  rate: string | null;
  sourceId: string | null;
  ageMs: number | null;
  unavailable: boolean;
  /** True when a per-value check failed (as opposed to the server saying it is unavailable). */
  withheld: boolean;
};

export type Decoded =
  | { kind: "fault"; reason: string }
  | { kind: "stop"; reason: "unsupported_version" }
  /** An unknown `type`: ignored, but its `stream_seq` was checked and counts. */
  | { kind: "ignored"; seq: number }
  | { kind: "snapshot"; seq: number; source: SourceState; profile: Profile; values: DecodedValue[] }
  | { kind: "update"; seq: number; source: SourceState; value: DecodedValue }
  | { kind: "heartbeat"; seq: number; source: SourceState };

export type DecodeContext = {
  /** The last `stream_seq` accepted on this connection; 0 before the first message. */
  lastSeq: number;
  /** The current connection's profile, null until its snapshot was accepted. */
  profile: Profile | null;
};

const fault = (reason: string): Decoded => ({ kind: "fault", reason });

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// Exactly the AD-4 schema's `$defs.timestamp` and `$defs.positive_decimal` (contracts/events/event-envelope.v1.schema.json).
const TIMESTAMP = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/;
const RATE = /^(0\.[0-9]*[1-9][0-9]*|[1-9][0-9]*(\.[0-9]+)?)$/;
const RATE_MAX_LENGTH = 40;

/** Days in a month of the proleptic Gregorian calendar: a year is a leap year if divisible by 4, except centuries not divisible by 400. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * An AD-4 timestamp: the schema's exact format (three fractional digits, a trailing Z, month 01-12, hour 00-23,
 * minute and second 00-59) AND a date that exists. The schema pattern alone lets 02-30 or a non-leap 02-29
 * through, so the day is checked against the month's real length (AD-1 §3.4: "real dates"). It does not
 * depend on how an engine's `Date.parse` treats an impossible date.
 */
export function isAd4Timestamp(text: string): boolean {
  if (!TIMESTAMP.test(text)) return false;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  return day <= daysInMonth(year, month);
}
const VERSION = /^(\d+)\.(\d+)$/;

const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** The snapshot's profile. Null thresholds, missing fields and wrong ordering are all faults; nothing is guessed. */
export function parseProfile(raw: unknown): Profile | null {
  if (!isObj(raw)) return null;
  const { expected_interval_ms: e, live_max_age_ms: l, stale_after_ms: s, unavailable_after_ms: u, clock_tolerance_ms: c } = raw;
  if (!isPositiveInt(e) || !isPositiveInt(s) || !isPositiveInt(u) || !isPositiveInt(c)) return null;
  if (l !== null && !(typeof l === "number" && Number.isInteger(l) && l > 0)) return null;
  if (l !== null && l > s) return null;
  if (s > u) return null;
  return { expectedIntervalMs: e, liveMaxAgeMs: l, staleAfterMs: s, unavailableAfterMs: u, clockToleranceMs: c };
}

function parseSource(raw: unknown): SourceState | null {
  if (!isObj(raw)) return null;
  const { source_id: id, status } = raw;
  if (typeof id !== "string" || id === "") return null;
  if (typeof status !== "string" || !SOURCE_STATUSES.includes(status as SourceStatus)) return null;
  return { sourceId: id, status: status as SourceStatus };
}

/** The per-value checks (§3.3.3): anything else is withheld, never relabelled. */
function eventIsShowable(event: Obj, base: string, quote: string): string | null {
  if (event.event_type !== "fx_rate") return null;
  if (event.usage !== "display_only") return null;
  if (event.provenance_class !== "synthetic") return null;
  const source = event.source;
  if (!isObj(source) || source.transport !== "synthetic") return null;
  if (typeof source.source_id !== "string" || !source.source_id.startsWith("synthetic.")) return null;
  const validation = event.validation;
  if (!isObj(validation) || validation.status !== "validated") return null;
  const payload = event.payload;
  if (!isObj(payload)) return null;
  if (payload.base_currency !== base || payload.quote_currency !== quote || payload.rate_type !== "mid") return null;
  if (typeof payload.rate !== "string" || payload.rate.length > RATE_MAX_LENGTH || !RATE.test(payload.rate)) return null;
  return payload.rate;
}

function decodeValue(raw: unknown, profile: Profile): DecodedValue | { fault: string } {
  if (!isObj(raw)) return { fault: "value is not an object" };
  const { base_currency: base, quote_currency: quote, event, age_ms: age, freshness } = raw;
  if (typeof base !== "string" || typeof quote !== "string") return { fault: "value has no currencies" };
  if (freshness !== "fresh" && freshness !== "stale" && freshness !== "unavailable") return { fault: "unknown freshness" };
  const unavailable = (withheld: boolean): DecodedValue => ({
    base, quote, rate: null, sourceId: null, ageMs: null, unavailable: true, withheld,
  });

  if (event === null) {
    if (age !== null || freshness !== "unavailable") return { fault: "a value with no event must be unavailable with no age" };
    return unavailable(false);
  }
  if (!isObj(event)) return { fault: "event is not an object" };
  if (typeof age !== "number" || !Number.isFinite(age)) return { fault: "event has no usable age" };

  const rate = eventIsShowable(event, base, quote);
  if (rate === null) return unavailable(true);

  const ageMs = age < 0 ? 0 : age;
  const recomputed: Freshness = freshnessOf(ageMs, profile);
  if (recomputed !== freshness) return { fault: "freshness disagrees with the age and profile" };
  if (recomputed === "unavailable") return unavailable(false);
  return { base, quote, rate, sourceId: (event.source as Obj).source_id as string, ageMs, unavailable: false, withheld: false };
}

/**
 * Decodes one SSE event. `eventName` is the SSE `event:` name (or "message" when absent), `data`
 * the joined data lines. Returns a fault, a stop, or the checked message.
 */
export function decodeMessage(eventName: string, data: string, ctx: DecodeContext): Decoded {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return fault("data is not JSON");
  }
  if (!isObj(parsed)) return fault("data is not a JSON object");

  const version = parsed.protocol_version;
  if (typeof version !== "string") return fault("protocol_version missing or not a string");
  const match = VERSION.exec(version);
  if (!match) return fault("protocol_version is not major.minor");
  if (match[1] !== "1") return { kind: "stop", reason: "unsupported_version" };

  const type = parsed.type;
  if (typeof type !== "string") return fault("type missing or not a string");
  if (type !== eventName) return fault("type does not match the SSE event name");

  const seq = parsed.stream_seq;
  if (typeof seq !== "number" || !Number.isInteger(seq)) return fault("stream_seq is not an integer");
  if (seq !== ctx.lastSeq + 1) return fault(ctx.lastSeq === 0 ? "first stream_seq is not 1" : "stream_seq gap or repeat");

  const serverTime = parsed.server_time;
  if (typeof serverTime !== "string" || !isAd4Timestamp(serverTime)) {
    return fault("server_time is not a timestamp");
  }
  const source = parseSource(parsed.source);
  if (!source) return fault("source missing or malformed");

  if (ctx.lastSeq === 0 && type !== "snapshot") return fault("the first message is not a snapshot");

  if (type === "heartbeat") return { kind: "heartbeat", seq, source };

  if (type === "snapshot") {
    if (ctx.lastSeq !== 0) return fault("a second snapshot on one connection");
    const profile = parseProfile(parsed.profile);
    if (!profile) return fault("profile missing, malformed, out of order or without a withdrawal threshold");
    const rawValues = parsed.values;
    if (!Array.isArray(rawValues) || rawValues.length !== PAIRS.length) return fault("snapshot does not carry exactly four values");
    const values: DecodedValue[] = [];
    for (let i = 0; i < PAIRS.length; i++) {
      const decoded = decodeValue(rawValues[i], profile);
      if ("fault" in decoded) return fault(decoded.fault);
      const pair = PAIRS[i] as (typeof PAIRS)[number];
      if (decoded.base !== pair.base || decoded.quote !== pair.quote) return fault("values are not the four pairs in order");
      values.push(decoded);
    }
    return { kind: "snapshot", seq, source, profile, values };
  }

  if (type === "update") {
    if (!ctx.profile) return fault("an update before a snapshot");
    const decoded = decodeValue(parsed.value, ctx.profile);
    if ("fault" in decoded) return fault(decoded.fault);
    if (!PAIRS.some((p) => p.base === decoded.base && p.quote === decoded.quote)) return fault("an update for a pair outside the allowlist");
    return { kind: "update", seq, source, value: decoded };
  }

  return { kind: "ignored", seq };
}
