import { cx } from "../../lib/cx";

export type StatusTone = "success" | "warning" | "danger" | "neutral";

const dot: Record<StatusTone, string> = {
  success: "bg-status-success",
  warning: "bg-status-warning",
  danger: "bg-status-danger",
  neutral: "bg-steel",
};

type StatusIndicatorProps = {
  tone: StatusTone;
  label: string;
  className?: string;
};

/** A coloured dot plus a text label. Colour is never the only signal. */
export function StatusIndicator({ tone, label, className }: StatusIndicatorProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-2 rounded-pill border border-line bg-transparent px-2.5 py-1 text-meta font-medium text-ink-secondary",
        className,
      )}
    >
      <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", dot[tone])} aria-hidden="true" />
      {label}
    </span>
  );
}
