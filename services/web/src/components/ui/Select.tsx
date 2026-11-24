import type { Ref, SelectHTMLAttributes } from "react";
import { cx } from "../../lib/cx";
import { Icon } from "./Icon";

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  invalid?: boolean;
  ref?: Ref<HTMLSelectElement>;
};

/**
 * Native select styled like Input: pill shape, Panel surface, Steel border.
 * Native, so keyboard and screen-reader behaviour come from the browser.
 */
export function Select({ invalid, className, children, ...rest }: SelectProps) {
  return (
    <div className="relative">
      <select
        aria-invalid={invalid || undefined}
        className={cx(
          "block w-full appearance-none rounded-pill border bg-surface-panel py-2.5 pl-5 pr-11 font-sans text-body-xs text-ink-body",
          "transition-colors duration-150 hover:border-line-strong",
          "disabled:cursor-not-allowed disabled:border-line disabled:text-ink-disabled",
          invalid ? "border-status-danger" : "border-line-control",
          className,
        )}
        {...rest}
      >
        {children}
      </select>
      <Icon
        name="chevronDown"
        size={16}
        className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-ink-muted"
      />
    </div>
  );
}
