import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

type EmptyStateProps = {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
};

/** Centred message for a panel with nothing to show yet. */
export function EmptyState({ icon = "info", title, children, actions }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      {/* DESIGN.md "Elevation": icon wells use the 1px white/20% ring. */}
      <span className="mb-5 flex h-11 w-11 items-center justify-center rounded-pill bg-surface-panel text-ink-muted shadow-subtle">
        <Icon name={icon} size={20} />
      </span>
      <h2 className="text-body-sm font-medium text-ink-primary">{title}</h2>
      {children ? <div className="mt-2 max-w-md text-ui text-ink-muted">{children}</div> : null}
      {actions ? <div className="mt-6 flex flex-wrap justify-center gap-3">{actions}</div> : null}
    </div>
  );
}
