import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link, type LinkProps } from "react-router-dom";
import { cx } from "../../lib/cx";

export type ButtonVariant = "primary" | "secondary" | "tertiary";
export type ButtonSize = "md" | "sm";

const base =
  "inline-flex items-center justify-center gap-2 rounded-pill font-sans text-ui font-medium " +
  "transition-colors duration-150 disabled:cursor-not-allowed aria-disabled:cursor-not-allowed";

const variants: Record<ButtonVariant, string> = {
  // DESIGN.md "Primary Action Button": white fill, black 14px/500 text, 10px 20px.
  // The single most important action in a viewport.
  primary:
    "bg-paper-white text-black hover:bg-bone active:bg-silver " +
    "disabled:bg-graphite disabled:text-ink-disabled",
  // DESIGN.md "Ghost Outline Button": transparent, 1px white border, white text.
  secondary:
    "border border-paper-white bg-transparent text-paper-white hover:bg-paper-white/[0.06] " +
    "disabled:border-line disabled:text-ink-disabled disabled:hover:bg-transparent",
  // Minimal text action.
  tertiary:
    "bg-transparent text-ink-muted hover:text-paper-white disabled:text-ink-disabled disabled:hover:text-ink-disabled",
};

const sizes: Record<ButtonSize, Record<ButtonVariant, string>> = {
  md: { primary: "px-5 py-2.5", secondary: "px-5 py-2.5", tertiary: "px-2 py-2" },
  sm: { primary: "px-4 py-1.5", secondary: "px-4 py-1.5", tertiary: "px-1.5 py-1" },
};

export function buttonClasses(variant: ButtonVariant = "primary", size: ButtonSize = "md", className?: string) {
  return cx(base, variants[variant], sizes[size][variant], className);
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconStart?: ReactNode;
  iconEnd?: ReactNode;
};

export function Button({
  variant = "primary",
  size = "md",
  type = "button",
  className,
  iconStart,
  iconEnd,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button type={type} className={buttonClasses(variant, size, className)} {...rest}>
      {iconStart}
      {children}
      {iconEnd}
    </button>
  );
}

type ButtonLinkProps = LinkProps & { variant?: ButtonVariant; size?: ButtonSize };

/** A router link styled as a button, for navigation actions. */
export function ButtonLink({ variant = "secondary", size = "md", className, ...rest }: ButtonLinkProps) {
  return <Link className={buttonClasses(variant, size, typeof className === "string" ? className : undefined)} {...rest} />;
}
