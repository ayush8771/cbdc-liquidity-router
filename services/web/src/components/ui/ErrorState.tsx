import type { ReactNode } from "react";
import { Icon } from "./Icon";

type ErrorStateProps = {
  title: string;
  message?: ReactNode;
  /** A reference the user can quote when reporting the problem, e.g. a request ID. */
  reference?: string;
  /** Usually a retry button. */
  action?: ReactNode;
};

/**
 * Panel-level error. Colour stays on the border and icon only (DESIGN.md: no
 * chromatic fills). Announced immediately with role="alert".
 */
export function ErrorState({ title, message, reference, action }: ErrorStateProps) {
  return (
    <div role="alert" className="flex flex-col items-center px-6 py-12 text-center">
      <span className="mb-5 flex h-11 w-11 items-center justify-center rounded-pill border border-status-danger/50 text-status-danger">
        <Icon name="alert" size={20} />
      </span>
      <h2 className="text-body-sm font-medium text-ink-primary">{title}</h2>
      {message ? <div className="mt-2 max-w-md text-ui text-ink-muted">{message}</div> : null}
      {reference ? (
        <p className="mt-3 text-meta text-ink-muted">
          Reference: <code className="select-all text-ink-secondary">{reference}</code>
        </p>
      ) : null}
      {action ? <div className="mt-6 flex flex-wrap justify-center gap-3">{action}</div> : null}
    </div>
  );
}
