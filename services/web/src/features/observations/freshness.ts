import type { Freshness, ObservationValue, Profile } from "./types";

/**
 * Freshness from an age and the connection's profile (AD-1 §3.3.3). Boundaries take the lower
 * state: exactly `staleAfterMs` is fresh, exactly `unavailableAfterMs` is stale. A negative age
 * counts as 0.
 */
export function freshnessOf(ageMs: number, profile: Pick<Profile, "staleAfterMs" | "unavailableAfterMs">): Freshness {
  const age = ageMs < 0 ? 0 : ageMs;
  if (age > profile.unavailableAfterMs) return "unavailable";
  if (age > profile.staleAfterMs) return "stale";
  return "fresh";
}

/** A value's age now: the age it had on receipt plus elapsed monotonic time, never the wall clock. */
export function currentAgeMs(value: ObservationValue, nowMs: number): number | null {
  if (value.ageAtReceiptMs === null) return null;
  return value.ageAtReceiptMs + Math.max(0, nowMs - value.receivedAtMs);
}

/** A value's state now. An unavailable value stays unavailable until a new message replaces it. */
export function valueFreshness(value: ObservationValue, profile: Profile, nowMs: number): Freshness {
  if (value.unavailable) return "unavailable";
  const age = currentAgeMs(value, nowMs);
  return age === null ? "unavailable" : freshnessOf(age, profile);
}

/**
 * Milliseconds until the next value changes state (or `cap`, whichever is sooner), so the panel
 * can re-render exactly when a threshold is crossed. The +1 is because the boundary itself still
 * belongs to the lower state.
 */
export function msUntilNextChange(values: readonly ObservationValue[], profile: Profile, nowMs: number, cap: number): number {
  let next = cap;
  for (const v of values) {
    if (v.unavailable) continue;
    const age = currentAgeMs(v, nowMs);
    if (age === null) continue;
    const state = freshnessOf(age, profile);
    if (state === "unavailable") continue;
    const threshold = state === "fresh" ? profile.staleAfterMs : profile.unavailableAfterMs;
    next = Math.min(next, Math.max(1, threshold - age + 1));
  }
  return Math.ceil(next);
}
