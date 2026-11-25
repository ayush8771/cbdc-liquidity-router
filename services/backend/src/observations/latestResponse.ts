import { MAX_EVENTS_PER_RESPONSE, PROTOCOL_VERSION, SOURCE_ID } from "./constants.js";
import { timestampMs } from "./envelope.js";

// The body of ingestion's `GET /v1/latest` 200 response (AD-1 v0.5 §3.1).
// Closed schema, all fields required. A bad body, an unknown version, a
// duplicate pair or more than 4 events rejects the whole response. Events are
// returned unvalidated: each is validated on its own (§3.4), so one invalid
// event rejects only itself.

const KEYS = ["protocol_version", "instance_id", "source_id", "generated_at", "events"];
// AD-1 §3.1 says only "UUID" for instance_id, so a valid UUID in either letter
// case is accepted (owner clarification) and reported lowercased for any
// comparison. The body itself is not modified. Envelope UUIDs (event_id,
// supersedes, derived_from) stay lowercase-only: the AD-4 schema requires it.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type LatestResponseResult =
  | { ok: true; instanceId: string; events: unknown[] }
  | { ok: false; reason: "bad_body" | "unknown_version" | "duplicate_pair" | "too_many_events" | "unsorted" };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The event's (base, quote), when its payload names them as strings. */
function pairOf(event: unknown): [string, string] | undefined {
  if (!isObject(event) || !isObject(event.payload)) return undefined;
  const { base_currency: base, quote_currency: quote } = event.payload;
  return typeof base === "string" && typeof quote === "string" ? [base, quote] : undefined;
}

export function parseLatestResponse(body: unknown): LatestResponseResult {
  if (!isObject(body)) return { ok: false, reason: "bad_body" };
  // The version is checked before the rest, so a future version is reported as such.
  if (Object.prototype.hasOwnProperty.call(body, "protocol_version") && body.protocol_version !== PROTOCOL_VERSION) {
    return { ok: false, reason: "unknown_version" };
  }
  const keys = Object.keys(body);
  if (keys.length !== KEYS.length || !KEYS.every((k) => Object.prototype.hasOwnProperty.call(body, k))) {
    return { ok: false, reason: "bad_body" };
  }
  if (typeof body.instance_id !== "string" || !UUID.test(body.instance_id)) return { ok: false, reason: "bad_body" };
  if (body.source_id !== SOURCE_ID) return { ok: false, reason: "bad_body" };
  if (typeof body.generated_at !== "string" || timestampMs(body.generated_at) === undefined) {
    return { ok: false, reason: "bad_body" };
  }
  const events = body.events;
  if (!Array.isArray(events)) return { ok: false, reason: "bad_body" };
  if (events.length > MAX_EVENTS_PER_RESPONSE) return { ok: false, reason: "too_many_events" };

  // At most one event per pair, sorted by base then quote. Events whose pair
  // can't be read are left to per-event validation, which rejects them.
  const seen = new Set<string>();
  let previous: string | undefined;
  for (const event of events) {
    const pair = pairOf(event);
    if (pair === undefined) continue;
    const key = `${pair[0]}/${pair[1]}`;
    if (seen.has(key)) return { ok: false, reason: "duplicate_pair" };
    seen.add(key);
    const sortKey = `${pair[0]}\u0000${pair[1]}`;
    if (previous !== undefined && sortKey < previous) return { ok: false, reason: "unsorted" };
    previous = sortKey;
  }
  return { ok: true, instanceId: body.instance_id.toLowerCase(), events };
}
