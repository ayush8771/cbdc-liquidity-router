// Display formatting only. Nothing here computes a metric (arch §5.3).

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const count = new Intl.NumberFormat("en-US");
const percent = new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
// API timestamps are ISO 8601 UTC (contract §1), so they are shown in UTC.
const dateTime = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});
const dateOnly = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function formatUsd(value: number): string {
  return usd.format(value);
}

export function formatCount(value: number): string {
  return count.format(value);
}

/** A share in [0, 1] as "97.1%". */
export function formatPercent(share: number): string {
  return percent.format(share);
}

/** An ISO timestamp as "2 Nov 2026, 10:00 UTC". */
export function formatDateTime(iso: string): string {
  return `${dateTime.format(new Date(iso))} UTC`;
}

/** A YYYY-MM-DD date as "14 Jun 2024". */
export function formatDate(isoDate: string): string {
  return dateOnly.format(new Date(`${isoDate}T00:00:00Z`));
}

/**
 * A corridor such as "GBR->PHL" shown as "GBR → PHL". Display only: the
 * corridor is never derived from country codes (contract §3.2).
 */
export function formatCorridor(corridor: string): string {
  return corridor.replace("->", " → ");
}

const feeFraction = new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * A venue fee for display. The contract defines `feePct` as a fraction, so
 * 0.015 is "1.50%" and 0.0105 is "1.05%". Returns "—" for a missing or
 * non-finite value. Does not change the number it is given.
 */
export function formatFeeFraction(feePct: number | null | undefined): string {
  return typeof feePct === "number" && Number.isFinite(feePct) ? feeFraction.format(feePct) : "—";
}

/** First block of a UUID, for compact display; the full ID stays available. */
export function shortId(id: string): string {
  return id.split("-")[0] ?? id;
}
