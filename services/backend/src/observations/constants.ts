// Fixed values for the D-24 synthetic FX observation slice (AD-1 component
// view v0.5 §3; AD-4 v0.2). Nothing here is configurable at run time.
//
// Isolation (AD-6 B-3): modules under src/observations/ must not import, or be
// imported by, routing, mapper, inference-client or database code. Only
// app.ts and server.ts compose both. A test enforces this.

export const PROTOCOL_VERSION = "1.0";
export const SOURCE_ID = "synthetic.fx";
export const INGESTION_PATH = "/v1/latest";
export const STREAM_PATH = "/api/rt/v1/observations/stream";

/** The §3.4 allowlist, in its fixed order. Only `mid` rates are accepted. */
export const PAIRS: ReadonlyArray<readonly [base: string, quote: string]> = Object.freeze([
  Object.freeze(["AED", "MXN"] as const),
  Object.freeze(["EUR", "USD"] as const),
  Object.freeze(["GBP", "PHP"] as const),
  Object.freeze(["USD", "INR"] as const),
]);
export const RATE_TYPE = "mid";

export function pairKey(base: string, quote: string): string {
  return `${base}/${quote}`;
}
export const PAIR_KEYS: readonly string[] = Object.freeze(PAIRS.map(([b, q]) => pairKey(b, q)));

/** The source profile sent in every snapshot (§3.2). */
export interface SourceProfile {
  expected_interval_ms: number;
  live_max_age_ms: number | null;
  stale_after_ms: number;
  unavailable_after_ms: number | null;
  clock_tolerance_ms: number;
}

export const PROFILE: Readonly<SourceProfile> = Object.freeze({
  expected_interval_ms: 2000,
  live_max_age_ms: null,
  stale_after_ms: 6000,
  unavailable_after_ms: 30000,
  clock_tolerance_ms: 1000,
});

/** §3.1: polling. */
export const POLL_INTERVAL_MS = 500;
export const POLL_DEADLINE_MS = 400;
export const POLL_MAX_BODY_BYTES = 64 * 1024;
export const POLL_CONTRACT_FAULT_DELAY_MS = 5000;
export const POLL_RETRY_AFTER_DEFAULT_MS = 5000;
export const POLL_RETRY_AFTER_MIN_MS = 1000;
export const POLL_RETRY_AFTER_MAX_MS = 30000;
export const OUTAGE_AFTER_FAILURES = 3;
export const OUTAGE_AFTER_MS = 2000;
export const MAX_EVENTS_PER_RESPONSE = 4;

/** §3.4: a timestamp more than this after receive time is withheld as future. */
export const FUTURE_TOLERANCE_MS = 1000;

/** §3.2, §3.5: streams. */
export const HEARTBEAT_INTERVAL_MS = 15000;
export const MAX_STREAMS_PER_USER = 3;
export const MAX_STREAMS_TOTAL = 20;
export const DRAIN_TIMEOUT_MS = 10000;
export const SHUTDOWN_DESTROY_AFTER_MS = 1000;
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const STREAM_LIMIT_RETRY_AFTER = "5";
export const SHUTTING_DOWN_RETRY_AFTER = "1";

export type SourceStatus = "starting" | "ok" | "outage";
export type Freshness = "fresh" | "stale" | "unavailable";
