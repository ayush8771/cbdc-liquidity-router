import type { InputHTMLAttributes, SVGProps } from "react";
import { Input } from "../../components/ui/Input";
import { cx } from "../../lib/cx";

// Local icons: the shared Icon component is deliberately not modified.
function EyeIcon({ off, ...rest }: SVGProps<SVGSVGElement> & { off?: boolean }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
      {off ? <path d="M4 4l16 16" /> : null}
    </svg>
  );
}

type TokenFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  invalid?: boolean;
  /** Whether the token is currently shown in plain text. Owned by the page, so it can reset on submit. */
  revealed: boolean;
  onRevealedChange: (revealed: boolean) => void;
};

/**
 * The token input with a Show/Hide control.
 *
 * Desktop only (1024px and up): below `lg` the control is `display: none`, so
 * it is not shown, not focusable and not announced, and the input is exactly
 * what it was. The input itself is the shared Input, unchanged; the only
 * additions are a wrapper and a desktop-only right padding that makes room for
 * the button.
 *
 * The token stays in the caller's component state: it is not stored, sent or
 * written to the URL here.
 */
export function TokenField({ revealed, onRevealedChange, invalid, className, ...rest }: TokenFieldProps) {
  return (
    <div className="relative">
      <Input
        {...rest}
        invalid={invalid}
        type={revealed ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="off"
        className={cx("lg:pr-28", className)}
      />
      <button
        type="button"
        aria-controls={rest.id}
        aria-label={revealed ? "Hide token" : "Show token"}
        onClick={() => onRevealedChange(!revealed)}
        className="absolute right-2 top-1/2 hidden -translate-y-1/2 items-center gap-1.5 rounded-pill px-3 py-1.5 text-ui font-medium text-ink-muted transition-colors duration-150 hover:text-paper-white lg:inline-flex"
      >
        <EyeIcon off={revealed} />
        <span>{revealed ? "Hide" : "Show"}</span>
      </button>
    </div>
  );
}
