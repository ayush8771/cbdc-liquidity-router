import { payloadSha256 } from "./canonical.js";
import { PAIR_KEYS, RATE_TYPE, SOURCE_ID, pairKey } from "./constants.js";

// Strict, hand-written validation of one AD-4 v1 envelope, as the first
// downstream trust boundary (AD-4 §6, §9; AD-1 v0.5 §3.4, §3.7 P-9). The
// backend has no JSON Schema library, and none is added.
//
// Only synthetic `fx_rate` events from `synthetic.fx` for an allowlisted pair
// are accepted in this slice. Every other AD-4-valid envelope (other types,
// other provenance classes) is rejected here, so this validator implements
// the closed AD-4 schema for that subset and rejects everything else. The
// verdict is accept or reject; it never repairs or rewrites an event.
//
// A validated result says nothing about `validation.status`: a well-formed
// `quarantined` envelope passes here and is withheld by the store (§3.4).

export type RejectReason =
  | "schema"
  | "unsupported_event_type"
  | "not_synthetic"
  | "pair_not_allowed"
  | "invalid_date"
  | "retrieved_after_emitted"
  | "hash_mismatch";

export interface FxPayload {
  base_currency: string;
  quote_currency: string;
  rate: string;
  rate_type: string;
}

export interface FxEnvelope {
  schema_version: "1.0";
  event_id: string;
  event_type: "fx_rate";
  usage: "display_only";
  source: { source_id: string; transport: "synthetic"; source_url: null; gate3_decision_ref: null };
  provenance_class: "synthetic";
  derived_from: string[];
  derivation: string | null;
  timestamps: {
    source_timestamp: string | null;
    source_timestamp_basis: "observed" | "published" | "none";
    retrieved_at: string;
    emitted_at: string;
  };
  source_sequence: string | null;
  payload: FxPayload;
  payload_sha256: string;
  raw_sha256: string | null;
  validation: { status: "validated" | "quarantined"; reasons: string[] };
  extraction: unknown;
  review: unknown;
  supersedes: string | null;
  synthetic: { generator_version: string; seed: number; case_id: string };
}

export type EnvelopeResult =
  | { ok: true; event: FxEnvelope }
  | { ok: false; reason: RejectReason; eventId?: string };

const ENVELOPE_KEYS = [
  "schema_version",
  "event_id",
  "event_type",
  "usage",
  "source",
  "provenance_class",
  "derived_from",
  "derivation",
  "timestamps",
  "source_sequence",
  "payload",
  "payload_sha256",
  "raw_sha256",
  "validation",
  "extraction",
  "review",
  "supersedes",
  "synthetic",
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TIMESTAMP =
  /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/;
const SOURCE_ID_PATTERN = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
const CURRENCY = /^[A-Z]{3}$/;
const POSITIVE_DECIMAL = /^(0\.[0-9]*[1-9][0-9]*|[1-9][0-9]*(\.[0-9]+)?)$/;
const EVENT_TYPES = ["fx_rate", "economic_indicator", "announcement", "bank_holiday"];
const TRANSPORTS = ["websocket", "poll", "scheduled", "manual", "synthetic"];
const PROVENANCE = ["real", "derived", "synthetic", "assumed"];
const QUARANTINE_REASONS = ["FUTURE_SOURCE_TIMESTAMP", "VALUE_OUT_OF_RANGE", "VALUE_JUMP", "REVIEW_REQUIRED"];
const RATE_TYPES = ["bid", "ask", "mid", "reference"];
const MAX_SAFE = 9007199254740991;

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exactly these keys: the AD-4 schema is closed at every level. */
function hasExactKeys(value: Obj, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(value, k));
}

function isString(value: unknown, pattern?: RegExp): value is string {
  return typeof value === "string" && (pattern === undefined || pattern.test(value));
}

/** JSON Schema string lengths count code points, not UTF-16 units. */
function codePoints(value: string): number {
  let n = 0;
  for (const _ of value) n += 1;
  return n;
}

function isText(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && codePoints(value) >= min && codePoints(value) <= max;
}

const isText200 = (value: unknown): value is string => isText(value, 1, 200);
const isUuid = (value: unknown): value is string => isString(value, UUID);
const isTimestamp = (value: unknown): value is string => isString(value, TIMESTAMP);
const isNullOr = (value: unknown, check: (v: unknown) => boolean): boolean => value === null || check(value);

/** Milliseconds since the epoch for an AD-4 timestamp that names a real calendar instant, else undefined. */
export function timestampMs(value: string): number | undefined {
  if (!TIMESTAMP.test(value)) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  // Date.parse rolls over impossible dates (2026-02-30 -> 2026-03-02); the
  // round trip catches it, since the format already has exactly 3 digits.
  return new Date(ms).toISOString() === value ? ms : undefined;
}

/** Structure and types of the closed AD-4 v1 schema (fx_rate payload checked separately). */
function checkSchema(e: Obj): boolean {
  if (!hasExactKeys(e, ENVELOPE_KEYS)) return false;
  if (e.schema_version !== "1.0") return false;
  if (!isUuid(e.event_id)) return false;
  if (!EVENT_TYPES.includes(e.event_type as string)) return false;
  if (e.usage !== "display_only") return false;

  const s = e.source;
  if (!isObject(s) || !hasExactKeys(s, ["source_id", "transport", "source_url", "gate3_decision_ref"])) return false;
  if (!isString(s.source_id, SOURCE_ID_PATTERN) || s.source_id.length > 100) return false;
  if (!TRANSPORTS.includes(s.transport as string)) return false;
  if (!isNullOr(s.source_url, (v) => isString(v) && v.length <= 2000 && /^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/.test(v)))
    return false;
  if (!isNullOr(s.gate3_decision_ref, isText200)) return false;

  if (!PROVENANCE.includes(e.provenance_class as string)) return false;
  const derivedFrom = e.derived_from;
  if (!Array.isArray(derivedFrom) || derivedFrom.length > 50 || !derivedFrom.every(isUuid)) return false;
  if (new Set(derivedFrom).size !== derivedFrom.length) return false;
  if (!isNullOr(e.derivation, isText200)) return false;
  // A derivation names its inputs and method together.
  if (derivedFrom.length > 0 ? typeof e.derivation !== "string" : e.derivation !== null) return false;

  const t = e.timestamps;
  if (!isObject(t) || !hasExactKeys(t, ["source_timestamp", "source_timestamp_basis", "retrieved_at", "emitted_at"]))
    return false;
  if (!isNullOr(t.source_timestamp, isTimestamp)) return false;
  if (t.source_timestamp === null ? t.source_timestamp_basis !== "none" : !["observed", "published"].includes(t.source_timestamp_basis as string))
    return false;
  if (!isTimestamp(t.retrieved_at) || !isTimestamp(t.emitted_at)) return false;

  if (!isNullOr(e.source_sequence, (v) => isText(v, 1, 100))) return false;
  if (!isObject(e.payload)) return false;
  if (!isString(e.payload_sha256, SHA256)) return false;
  if (!isNullOr(e.raw_sha256, (v) => isString(v, SHA256))) return false;

  const v = e.validation;
  if (!isObject(v) || !hasExactKeys(v, ["status", "reasons"])) return false;
  if (v.status !== "validated" && v.status !== "quarantined") return false;
  const reasons = v.reasons;
  if (!Array.isArray(reasons) || !reasons.every((r) => QUARANTINE_REASONS.includes(r as string))) return false;
  if (new Set(reasons).size !== reasons.length) return false;
  if (v.status === "validated" ? reasons.length !== 0 : reasons.length < 1) return false;

  const x = e.extraction;
  if (x !== null) {
    if (!isObject(x) || !hasExactKeys(x, ["tool", "tool_version", "status", "confidence"])) return false;
    if (!isText200(x.tool) || !isText200(x.tool_version)) return false;
    if (x.status !== "complete" && x.status !== "partial") return false;
    if (typeof x.confidence !== "number" || !Number.isFinite(x.confidence) || x.confidence < 0 || x.confidence > 1)
      return false;
  }
  const r = e.review;
  if (r !== null) {
    if (!isObject(r) || !hasExactKeys(r, ["reviewer_ref", "reviewed_at"])) return false;
    if (!isText200(r.reviewer_ref) || !isTimestamp(r.reviewed_at)) return false;
    // A review approval is a new, validated event that supersedes the reviewed one.
    if (typeof e.supersedes !== "string" || v.status !== "validated") return false;
  }
  // Announcements and extracted items are validated only after human review.
  if ((e.event_type === "announcement" || x !== null) && v.status === "validated" && r === null) return false;
  if (!isNullOr(e.supersedes, isUuid)) return false;

  const y = e.synthetic;
  if (y !== null) {
    if (!isObject(y) || !hasExactKeys(y, ["generator_version", "seed", "case_id"])) return false;
    if (!isText200(y.generator_version) || !isText200(y.case_id)) return false;
    if (typeof y.seed !== "number" || !Number.isInteger(y.seed) || y.seed < 0 || y.seed > MAX_SAFE) return false;
  }
  return true;
}

function checkFxPayload(p: Obj): boolean {
  if (!hasExactKeys(p, ["base_currency", "quote_currency", "rate", "rate_type"])) return false;
  if (!isString(p.base_currency, CURRENCY) || !isString(p.quote_currency, CURRENCY)) return false;
  if (!isString(p.rate, POSITIVE_DECIMAL) || p.rate.length > 40) return false;
  return RATE_TYPES.includes(p.rate_type as string);
}

/** All four synthetic markers agree (AD-4 §3.2), and the source is this slice's. */
function isSyntheticFxSource(e: Obj): boolean {
  const s = e.source as Obj;
  return (
    e.provenance_class === "synthetic" &&
    s.transport === "synthetic" &&
    s.source_id === SOURCE_ID &&
    s.source_url === null &&
    s.gate3_decision_ref === null &&
    isObject(e.synthetic)
  );
}

export function validateEnvelope(value: unknown): EnvelopeResult {
  if (!isObject(value)) return { ok: false, reason: "schema" };
  // The event_id is reported only if well formed (§3.4 quarantine logging).
  const eventId = isUuid(value.event_id) ? value.event_id : undefined;
  const fail = (reason: RejectReason): EnvelopeResult =>
    eventId === undefined ? { ok: false, reason } : { ok: false, reason, eventId };

  if (!checkSchema(value)) return fail("schema");
  if (value.event_type !== "fx_rate") return fail("unsupported_event_type");
  if (!checkFxPayload(value.payload as Obj)) return fail("schema");
  if (!isSyntheticFxSource(value)) return fail("not_synthetic");

  const p = value.payload as unknown as FxPayload;
  // The allowlist also covers ISO 4217 membership and differing currencies.
  if (!PAIR_KEYS.includes(pairKey(p.base_currency, p.quote_currency)) || p.rate_type !== RATE_TYPE) {
    return fail("pair_not_allowed");
  }

  const t = value.timestamps as FxEnvelope["timestamps"];
  const retrieved = timestampMs(t.retrieved_at);
  const emitted = timestampMs(t.emitted_at);
  const source = t.source_timestamp === null ? null : timestampMs(t.source_timestamp);
  const review = value.review === null ? null : timestampMs((value.review as Obj).reviewed_at as string);
  if (retrieved === undefined || emitted === undefined || source === undefined || review === undefined) {
    return fail("invalid_date");
  }
  if (retrieved > emitted) return fail("retrieved_after_emitted");

  if (payloadSha256("fx_rate", value.payload) !== value.payload_sha256) return fail("hash_mismatch");

  return { ok: true, event: value as unknown as FxEnvelope };
}
