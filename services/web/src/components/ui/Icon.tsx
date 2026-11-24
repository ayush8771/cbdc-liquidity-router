import type { SVGProps } from "react";

// Monochrome line icons, drawn for this app on a 24px grid. They inherit
// currentColor and are decorative unless given a `title`.
const paths = {
  dashboard: (
    <>
      <rect x="3.5" y="3.5" width="7" height="9" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="5" rx="1.5" />
      <rect x="13.5" y="11.5" width="7" height="9" rx="1.5" />
      <rect x="3.5" y="15.5" width="7" height="5" rx="1.5" />
    </>
  ),
  route: (
    <>
      <circle cx="5.5" cy="6" r="2" />
      <circle cx="18.5" cy="18" r="2" />
      <path d="M7.5 6h6.5a3.5 3.5 0 0 1 0 7H10a3.5 3.5 0 0 0 0 7h6.5" />
    </>
  ),
  history: (
    <>
      <path d="M4 12a8 8 0 1 0 2.4-5.7" />
      <path d="M4 4.5v3.8h3.8" />
      <path d="M12 8v4.5l3 1.8" />
    </>
  ),
  compare: (
    <>
      <path d="M7 4v16" />
      <path d="M17 4v16" />
      <path d="M3.5 9h7" />
      <path d="M13.5 15h7" />
    </>
  ),
  network: (
    <>
      <circle cx="12" cy="5" r="2" />
      <circle cx="5" cy="18" r="2" />
      <circle cx="19" cy="18" r="2" />
      <path d="M11 6.8 6 16.2M13 6.8l5 9.4M7 18h10" />
    </>
  ),
  gauge: (
    <>
      <path d="M4.5 17a8 8 0 1 1 15 0" />
      <path d="M12 13.5 15.5 9" />
      <circle cx="12" cy="14" r="1" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4 21 19.5H3z" />
      <path d="M12 10v4M12 16.8h.01" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  key: (
    <>
      <circle cx="8" cy="15" r="3.5" />
      <path d="M10.5 12.5 19 4M15.5 7.5l2.5 2.5" />
    </>
  ),
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
} as const;

export type IconName = keyof typeof paths;

type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & {
  name: IconName;
  size?: number;
  title?: string;
};

export function Icon({ name, size = 18, title, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {paths[name]}
    </svg>
  );
}
