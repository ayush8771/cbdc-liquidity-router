import type { InputHTMLAttributes, Ref } from "react";
import { cx } from "../../lib/cx";

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
  ref?: Ref<HTMLInputElement>;
};

/**
 * Pill text input on the Panel surface (DESIGN.md "Surfaces": input
 * backgrounds). The Steel border, the export's control-outline colour, gives
 * a 3:1 boundary (WCAG 1.4.11); a white border is kept for the export's
 * single hero email field and would be too loud on every form control.
 */
export function Input({ invalid, className, ...rest }: InputProps) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cx(
        "block w-full rounded-pill border bg-surface-panel px-5 py-2.5 font-sans text-body-xs text-ink-body",
        "placeholder:text-ink-subtle transition-colors duration-150",
        "hover:border-line-strong disabled:cursor-not-allowed disabled:border-line disabled:text-ink-disabled",
        invalid ? "border-status-danger" : "border-line-control",
        className,
      )}
      {...rest}
    />
  );
}
