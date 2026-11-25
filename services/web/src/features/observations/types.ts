/*
 * Types and constants for the D-24 observation panel (AD-1 v0.5 §3.2-§3.4).
 * This module is isolated from routing, transaction and compare code (AD-6 B-8).
 */

/** The fixed pair allowlist, in the order a snapshot must carry it (AD-1 §3.4, P-3). */
export const PAIRS = [
  { base: "AED", quote: "MXN" },
  { base: "EUR", quote: "USD" },
  { base: "GBP", quote: "PHP" },
  { base: "USD", quote: "INR" },
] as const;

export type SourceStatus = "starting" | "ok" | "outage";
export const SOURCE_STATUSES: readonly SourceStatus[] = ["starting", "ok", "outage"];

export type Freshness = "fresh" | "stale" | "unavailable";

/** The snapshot's source profile (AD-1 §3.2). Thresholds are never defaulted by the client. */
export type Profile = {
  expectedIntervalMs: number;
  liveMaxAgeMs: number | null;
  staleAfterMs: number;
  unavailableAfterMs: number;
  clockToleranceMs: number;
};

/**
 * One pair's current value as the panel keeps it. `rate` is null when the value is
 * Unavailable: an unavailable value never carries a number.
 */
export type ObservationValue = {
  base: string;
  quote: string;
  /** The decimal string from the envelope, unmodified. Null when unavailable. */
  rate: string | null;
  sourceId: string | null;
  /** Age at the moment the message was received, in ms (negative ages already counted as 0). */
  ageAtReceiptMs: number | null;
  /** Monotonic time (performance.now) at receipt. */
  receivedAtMs: number;
  /** Set when a per-value check failed or the value arrived unavailable. */
  unavailable: boolean;
};

export type SourceState = { sourceId: string; status: SourceStatus };

/** Where the stream is. "Recoverable" phases may reconnect on their own; "stopped" never does (§3.3.2). */
export type Phase =
  | "idle"
  | "connecting"
  | "streaming"
  | "waiting" // recoverable disconnect, reconnect timer pending
  | "paused" // hidden, hiding or leaving the page
  | "offline"
  | "stopped";

export type StopReason =
  | "unauthenticated"
  | "unavailable" // 403, 404 and other 4xx
  | "unsupported_version"
  | "protocol_faults";

export type ObservationState = {
  phase: Phase;
  stopReason: StopReason | null;
  /** True while waiting out a 429 (§3.3). */
  tooManyStreams: boolean;
  source: SourceState | null;
  profile: Profile | null;
  /** Exactly the four pairs, in order, once a snapshot has been accepted; null before and after a reset. */
  values: readonly ObservationValue[] | null;
  /** Count of values withheld by the per-value checks since the panel started (§3.3.3). */
  withheld: number;
};

export const INITIAL_STATE: ObservationState = {
  phase: "idle",
  stopReason: null,
  tooManyStreams: false,
  source: null,
  profile: null,
  values: null,
  withheld: 0,
};
