import type { HTMLAttributes } from "react";
import { cx } from "../../lib/cx";

export type BadgeTone = "tag" | "category" | "success" | "warning" | "danger";

// DESIGN.md "Pill Tag Button": transparent, 1px Steel border, white text,
// 6px 10px. "Status Badge": transparent, 1px toned border, toned 12px/500
// text, 2px vertical padding. Copper is for category labels only.
const tones: Record<BadgeTone, string> = {
  tag: "border-line-control text-paper-white py-1.5",
  category: "border-copper/60 text-accent py-1.5",
  success: "border-status-success/60 text-status-success py-0.5",
  warning: "border-status-warning/60 text-status-warning py-0.5",
  danger: "border-status-danger/60 text-status-danger py-0.5",
};

type BadgeProps = HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone };

/** Pill tag for categories, provenance and policy labels, and status badges. */
export function Badge({ tone = "tag", className, ...rest }: BadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill border bg-transparent px-2.5 text-meta font-medium leading-none",
        tones[tone],
        className,
      )}
      {...rest}
    />
  );
}
