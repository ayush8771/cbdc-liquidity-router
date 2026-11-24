import { Link } from "react-router-dom";

/** Text-only product mark. Original to this app; no third-party branding. */
export function Wordmark({ to = "/" }: { to?: string }) {
  return (
    <Link to={to} className="inline-flex items-baseline gap-2 rounded-pill text-paper-white">
      <span aria-hidden="true" className="h-2 w-2 translate-y-[-1px] rounded-full bg-paper-white" />
      <span className="text-ui font-semibold tracking-wide">CBDC Liquidity Router</span>
    </Link>
  );
}
