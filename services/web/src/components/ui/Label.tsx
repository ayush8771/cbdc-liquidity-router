import type { LabelHTMLAttributes } from "react";
import { cx } from "../../lib/cx";

type LabelProps = LabelHTMLAttributes<HTMLLabelElement> & { required?: boolean };

export function Label({ className, required, children, ...rest }: LabelProps) {
  return (
    <label className={cx("block text-ui font-medium text-ink-body", className)} {...rest}>
      {children}
      {required ? (
        <span className="ml-1 text-ink-muted" aria-hidden="true">
          *
        </span>
      ) : null}
    </label>
  );
}
