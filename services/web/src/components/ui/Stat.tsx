import type { ReactNode } from "react";
import { cx } from "../../lib/cx";

type StatProps = {
  /** Already formatted for display, e.g. "97.1%". */
  value: string;
  label: string;
  /** "md" is 44px, "sm" 28px: the serif is never used below 28px. */
  size?: "sm" | "md";
  /** Optional line under the label, e.g. a denominator or a provenance badge. */
  meta?: ReactNode;
};

/** DESIGN.md "Stat Display": serif number in white, 14px Inter caption in Fog. */
export function Stat({ value, label, size = "md", meta }: StatProps) {
  return (
    <div className="space-y-1.5">
      <p
        className={cx(
          // No tabular-nums: equal-width digits look uneven on a large standalone number.
          "font-serif-display text-ink-primary",
          size === "md" ? "text-heading-sm" : "text-title",
        )}
      >
        {value}
      </p>
      <p className="text-ui text-ink-muted">{label}</p>
      {meta ? <div className="pt-1">{meta}</div> : null}
    </div>
  );
}
