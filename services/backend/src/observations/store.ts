import type { Logger } from "../logger.js";
import { FUTURE_TOLERANCE_MS, PAIR_KEYS, pairKey } from "./constants.js";
import { timestampMs, validateEnvelope, type FxEnvelope } from "./envelope.js";

// The latest-observation state (AD-1 v0.5 §3.4): at most one current event
// per allowlisted pair, so at most 4 events in memory. Nothing is persisted,
// and no payload of a refused event is kept, only counters by reason and
// rate-limited log lines with the reason and, if well formed, the event_id.
//
// The first matching row applies:
//   invalid / wrong source / outside allowlist        -> rejected
//   not `validated`                                   -> quarantined (withheld)
//   source_timestamp null                             -> rejected
//   any timestamp > receive time + 1 s                -> future (withheld; never current)
//   same event_id as a current event, same content    -> duplicate (ignored)
//   same event_id as a current event, other content   -> conflict (first kept)
//   older than the pair's current                     -> late
//   same source_timestamp, different event_id         -> tie conflict (first kept)
//   newer source_timestamp                            -> becomes current: one update
// Ordering uses source_timestamp only; source_sequence and instance_id are
// never compared. The current event stays as the watermark after it becomes
// unavailable; freshness.ts withholds its number.

export type ApplyResult =
  | { kind: "update"; pair: string; event: FxEnvelope }
  | { kind: "duplicate" | "late" | "conflict" | "tie_conflict" | "future"; pair: string }
  | { kind: "quarantined"; reasons: readonly string[] }
  | { kind: "rejected"; reason: string };

export interface ObservationStore {
  /** Validates one raw event and applies it at `receivedAtMs` (Express's clock). */
  ingest(raw: unknown, receivedAtMs: number): ApplyResult;
  current(base: string, quote: string): FxEnvelope | undefined;
  /** A copy of the counters, by outcome and reason. */
  counters(): Record<string, number>;
  /** How many events are held; never more than the allowlist size. */
  size(): number;
}

export const LOG_INTERVAL_MS = 10000;

/** At most one log line per key per interval, reporting how many were suppressed. */
export function createRateLimitedLog(logger: Logger, now: () => number, intervalMs = LOG_INTERVAL_MS) {
  const last = new Map<string, { at: number; suppressed: number }>();
  return (key: string, message: string, fields: Record<string, unknown>) => {
    const t = now();
    const entry = last.get(key);
    if (entry !== undefined && t - entry.at < intervalMs) {
      entry.suppressed += 1;
      return;
    }
    const suppressed = entry?.suppressed ?? 0;
    last.set(key, { at: t, suppressed: 0 });
    logger.warn(message, suppressed > 0 ? { ...fields, suppressed } : fields);
  };
}

/** Key-order-independent serialisation, for "identical content" only (never hashed). */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createObservationStore(options: { logger: Logger; now?: () => number }): ObservationStore {
  const now = options.now ?? Date.now;
  const log = createRateLimitedLog(options.logger, now);
  const currents = new Map<string, { event: FxEnvelope; sourceMs: number; content: string }>();
  const counts = new Map<string, number>();

  const count = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);

  function refuse(category: string, reason: string, eventId: string | undefined): void {
    count(`${category}.${reason}`);
    const fields: Record<string, unknown> = { reason };
    if (eventId !== undefined) fields.eventId = eventId;
    log(`${category}:${reason}`, `observation event ${category}`, fields);
  }

  function ingest(raw: unknown, receivedAtMs: number): ApplyResult {
    const validated = validateEnvelope(raw);
    if (!validated.ok) {
      refuse("rejected", validated.reason, validated.eventId);
      return { kind: "rejected", reason: validated.reason };
    }
    const event = validated.event;
    const pair = pairKey(event.payload.base_currency, event.payload.quote_currency);

    if (event.validation.status !== "validated") {
      for (const reason of event.validation.reasons) count(`quarantined.${reason}`);
      log(`quarantined:${event.validation.reasons.join(",")}`, "observation event quarantined", {
        reasons: event.validation.reasons,
        eventId: event.event_id,
      });
      return { kind: "quarantined", reasons: event.validation.reasons };
    }

    const sourceTimestamp = event.timestamps.source_timestamp;
    if (sourceTimestamp === null) {
      refuse("rejected", "null_source_timestamp", event.event_id);
      return { kind: "rejected", reason: "null_source_timestamp" };
    }
    // validateEnvelope has already checked all three are real instants.
    const sourceMs = timestampMs(sourceTimestamp) as number;
    const limit = receivedAtMs + FUTURE_TOLERANCE_MS;
    // "Any timestamp" (§3.4): the three envelope timestamps and, when a review
    // block is present, its reviewed_at.
    const review = event.review as { reviewed_at?: string } | null;
    const stamps = [sourceMs, timestampMs(event.timestamps.retrieved_at), timestampMs(event.timestamps.emitted_at)];
    if (review !== null && typeof review.reviewed_at === "string") stamps.push(timestampMs(review.reviewed_at));
    if (stamps.some((ms) => (ms as number) > limit)) {
      refuse("withheld", "future", event.event_id);
      return { kind: "future", pair };
    }

    const content = stableStringify(event);
    for (const [key, held] of currents) {
      if (held.event.event_id !== event.event_id) continue;
      if (key === pair && held.content === content) {
        count("duplicate");
        return { kind: "duplicate", pair };
      }
      refuse("conflict", "event_id", event.event_id);
      return { kind: "conflict", pair };
    }

    const held = currents.get(pair);
    if (held !== undefined) {
      if (sourceMs < held.sourceMs) {
        count("late");
        return { kind: "late", pair };
      }
      if (sourceMs === held.sourceMs) {
        refuse("conflict", "tie", event.event_id);
        return { kind: "tie_conflict", pair };
      }
    }
    // Only allowlisted pairs reach here, so the map never exceeds 4 entries.
    if (!PAIR_KEYS.includes(pair)) throw new Error("unreachable: pair outside the allowlist");
    currents.set(pair, { event, sourceMs, content });
    count("accepted");
    return { kind: "update", pair, event };
  }

  return {
    ingest,
    current: (base, quote) => currents.get(pairKey(base, quote))?.event,
    counters: () => Object.fromEntries(counts),
    size: () => currents.size,
  };
}
