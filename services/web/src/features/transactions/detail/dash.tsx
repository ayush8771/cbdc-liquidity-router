import type { ReactNode } from "react";

/** "—" for a value that isn't available, with a text alternative for screen readers. */
export function Dash() {
  return (
    <span className="text-ink-muted">
      <span aria-hidden="true">—</span>
      <span className="sr-only">Not available</span>
    </span>
  );
}

/** The value, or "—" when it is null, undefined or empty. */
export function orDash(value: ReactNode): ReactNode {
  return value === null || value === undefined || value === "" ? <Dash /> : value;
}
