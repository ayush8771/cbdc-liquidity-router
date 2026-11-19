import { cx } from "../../lib/cx";

/** A grey placeholder block. Decorative: pair it with LoadingState for the announcement. */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cx("block animate-pulse rounded-card bg-surface-floating", className)} />;
}

type LoadingStateProps = {
  /** Announced to screen readers, e.g. "Loading transactions". */
  label: string;
  /** Number of placeholder rows to draw. */
  rows?: number;
  /**
   * Set false when another LoadingState on the page already announces, so a
   * screen reader hears "loading" once rather than once per panel.
   */
  announce?: boolean;
};

/** Placeholder rows plus a polite status message for assistive technology. */
export function LoadingState({ label, rows = 4, announce = true }: LoadingStateProps) {
  if (!announce) {
    return (
      <div aria-hidden="true" className="space-y-3 py-2">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className={cx("h-4", i % 3 === 2 ? "w-2/3" : "w-full")} />
        ))}
      </div>
    );
  }
  return (
    <div role="status" aria-live="polite" className="space-y-3 py-2">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cx("h-4", i % 3 === 2 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}
