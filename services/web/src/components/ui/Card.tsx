import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";

type CardProps = HTMLAttributes<HTMLElement> & {
  as?: "section" | "div" | "article";
  /** DESIGN.md "Surfaces": "card" is Onyx (level 1), "panel" is Carbon (level 2). */
  surface?: "card" | "panel";
  padded?: boolean;
};

/** 10px radius, 1px Graphite hairline, 24px padding, no shadow. */
export function Card({ as: Tag = "section", surface = "card", padded = true, className, ...rest }: CardProps) {
  return (
    <Tag
      className={cx(
        "rounded-card border border-line-subtle",
        surface === "card" ? "bg-surface-card" : "bg-surface-panel",
        padded && "p-card",
        className,
      )}
      {...rest}
    />
  );
}

type CardHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Heading level inside the page outline. */
  level?: "h2" | "h3";
};

export function CardHeader({ title, description, actions, level: H = "h2" }: CardHeaderProps) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <H className="text-body-sm font-medium text-ink-primary">{title}</H>
        {description ? <p className="text-ui text-ink-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
