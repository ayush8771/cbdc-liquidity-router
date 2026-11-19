import type { ReactNode } from "react";

type PageHeadingProps = {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
};

/**
 * The one h1 of an application page: Fog section eyebrow, serif title, and an
 * 18px Inter 300 lede (DESIGN.md: "whisper-quiet secondary copy").
 */
export function PageHeading({ eyebrow, title, description, actions, meta }: PageHeadingProps) {
  return (
    <header className="flex flex-col gap-6 border-b border-line-subtle pb-8 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0 max-w-3xl space-y-3">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1 className="font-serif-display text-heading-sm text-ink-primary">{title}</h1>
        {description ? <p className="text-body-sm font-light text-ink-muted">{description}</p> : null}
        {meta ? <div className="flex flex-wrap gap-2 pt-1">{meta}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-3">{actions}</div> : null}
    </header>
  );
}
