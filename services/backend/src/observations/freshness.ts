import { PAIRS, PROFILE, type Freshness, type SourceProfile } from "./constants.js";
import type { FxEnvelope } from "./envelope.js";

// Freshness, evaluated by Express on its own clock (AD-1 v0.5 §3.3; AD-4 §7).
// The integer age is computed once, at the message's `server_time`, and the
// label is derived from that same integer, so `age_ms` and `freshness` can
// never disagree with the client's recomputation from the sent profile.
//
//   age <= stale_after_ms             -> fresh   (exactly 6000 is fresh)
//   age <= unavailable_after_ms       -> stale   (exactly 30000 is stale)
//   otherwise                         -> unavailable: no event, no age
// A negative age (a timestamp within the 1 s future tolerance) counts as 0.

export interface ObservationValue {
  base_currency: string;
  quote_currency: string;
  event: FxEnvelope | null;
  age_ms: number | null;
  freshness: Freshness;
}

/** Thrown when a profile would be served without a positive withdrawal threshold (§3.2). */
export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * The §3.3.3 profile rules, applied on the server too: every threshold a
 * positive integer, `unavailable_after_ms` never null in this slice, and
 * live_max_age_ms <= stale_after_ms <= unavailable_after_ms where set.
 */
export function assertServableProfile(profile: SourceProfile): void {
  const { expected_interval_ms, live_max_age_ms, stale_after_ms, unavailable_after_ms, clock_tolerance_ms } = profile;
  if (![expected_interval_ms, stale_after_ms, clock_tolerance_ms, unavailable_after_ms].every(positiveInteger)) {
    throw new ProfileError("profile thresholds must be positive integers; unavailable_after_ms may not be null");
  }
  if (live_max_age_ms !== null && (!positiveInteger(live_max_age_ms) || live_max_age_ms > stale_after_ms)) {
    throw new ProfileError("live_max_age_ms must be a positive integer no greater than stale_after_ms");
  }
  if (stale_after_ms > (unavailable_after_ms as number)) {
    throw new ProfileError("stale_after_ms must not exceed unavailable_after_ms");
  }
}

/** Integer age in ms at `serverTimeMs`; negative counts as 0. */
export function ageMs(sourceTimestampMs: number, serverTimeMs: number): number {
  return Math.max(0, Math.trunc(serverTimeMs) - Math.trunc(sourceTimestampMs));
}

export function freshnessOf(age: number, profile: SourceProfile = PROFILE): Freshness {
  if (age <= profile.stale_after_ms) return "fresh";
  if (age <= (profile.unavailable_after_ms as number)) return "stale";
  return "unavailable";
}

/** One §3.2 `value` for a pair, evaluated at `serverTimeMs`. */
export function evaluateValue(
  base: string,
  quote: string,
  event: FxEnvelope | undefined,
  serverTimeMs: number,
  profile: SourceProfile = PROFILE,
): ObservationValue {
  const unavailable: ObservationValue = {
    base_currency: base,
    quote_currency: quote,
    event: null,
    age_ms: null,
    freshness: "unavailable",
  };
  const sourceTimestamp = event?.timestamps.source_timestamp;
  if (event === undefined || sourceTimestamp === null || sourceTimestamp === undefined) return unavailable;
  const age = ageMs(Date.parse(sourceTimestamp), serverTimeMs);
  const freshness = freshnessOf(age, profile);
  // An unavailable value carries no number (AD-4 §8.1).
  if (freshness === "unavailable") return unavailable;
  return { base_currency: base, quote_currency: quote, event, age_ms: age, freshness };
}

/** All four values in the §3.4 order. */
export function evaluateAll(
  lookup: (base: string, quote: string) => FxEnvelope | undefined,
  serverTimeMs: number,
): ObservationValue[] {
  return PAIRS.map(([base, quote]) => evaluateValue(base, quote, lookup(base, quote), serverTimeMs));
}

/** AD-4 timestamp form of a server time: UTC, three fractional digits, Z. */
export function formatServerTime(ms: number): string {
  return new Date(Math.trunc(ms)).toISOString();
}
