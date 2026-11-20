import type { ReactNode } from "react";
import { cx } from "../../lib/cx";
import { Icon } from "./Icon";

export type NoticeTone = "info" | "warning" | "danger" | "success";

const tones: Record<NoticeTone, { box: string; icon: string; name: "info" | "alert" | "check" }> = {
  // Surface steps and 1px borders only; status colour stays on the border and
  // icon, never as a fill (DESIGN.md: no chromatic accents).
  info: { box: "border-line-subtle bg-surface-card", icon: "text-ink-muted", name: "info" },
  warning: { box: "border-status-warning/40 bg-surface-card", icon: "text-status-warning", name: "alert" },
  danger: { box: "border-status-danger/40 bg-surface-card", icon: "text-status-danger", name: "alert" },
  success: { box: "border-status-success/40 bg-surface-card", icon: "text-status-success", name: "check" },
};

type NoticeProps = {
  tone?: NoticeTone;
  title?: string;
  children?: ReactNode;
  /** "status" for polite updates, "alert" for errors that need attention now. */
  role?: "status" | "alert";
  className?: string;
};

/** Inline message for loading results, errors, warnings and confirmations. */
export function Notice({ tone = "info", title, children, role, className }: NoticeProps) {
  const t = tones[tone];
  return (
    <div role={role} className={cx("flex gap-3 rounded-card border px-4 py-3.5", t.box, className)}>
      <Icon name={t.name} size={18} className={cx("mt-0.5 shrink-0", t.icon)} />
      <div className="min-w-0 space-y-1 text-ui">
        {title ? <p className="font-medium text-ink-body">{title}</p> : null}
        {children ? <div className="text-ink-secondary">{children}</div> : null}
      </div>
    </div>
  );
}
