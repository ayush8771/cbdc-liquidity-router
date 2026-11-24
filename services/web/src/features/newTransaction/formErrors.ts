import type { FieldErrors, FormValues } from "./types";

const SIMPLE_KEYS = ["corridor", "amountUsd", "policy", "clientReference", "mode", "date", "scenarioId", "referenceDate"] as const;

/** Drops the errors of every field the user just changed, so a message never outlives its fix. */
export function withoutChangedErrors(errors: FieldErrors, prev: FormValues, next: FormValues): FieldErrors {
  const kept = { ...errors };
  for (const key of SIMPLE_KEYS) if (prev[key] !== next[key]) delete kept[key];
  if (prev.corridor !== next.corridor || prev.mode !== next.mode) {
    for (const key of Object.keys(kept)) if (key.startsWith("venues.")) delete kept[key];
  }
  next.venues.forEach((venue, i) => {
    const before = prev.venues[i];
    if (before?.liquidityUsd !== venue.liquidityUsd) delete kept[`venues.${i}.liquidityUsd`];
    if (before?.congestion !== venue.congestion) delete kept[`venues.${i}.congestion`];
  });
  return kept;
}
