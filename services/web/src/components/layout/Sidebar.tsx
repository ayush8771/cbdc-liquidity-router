import { NAVIGATION } from "../../app/navigation";
import { ButtonLink } from "../ui/Button";
import { NavItem } from "./NavItem";
import { Wordmark } from "./Wordmark";

type SidebarNavProps = { onNavigate?: () => void };

/** The navigation list, shared by the desktop sidebar and the mobile menu. */
export function SidebarNav({ onNavigate }: SidebarNavProps) {
  return (
    <ul className="space-y-1">
      {NAVIGATION.map((item) => (
        <li key={item.to}>
          <NavItem {...item} onNavigate={onNavigate} />
        </li>
      ))}
    </ul>
  );
}

/** Session area. Nothing here claims a signed-in user until auth is wired to /api/v1/auth/me. */
export function SessionPanel() {
  return (
    <div className="space-y-3 rounded-card border border-line-subtle bg-surface-card p-4">
      <p className="text-meta text-ink-muted">Not signed in. The session will be checked once the API is connected.</p>
      <ButtonLink to="/sign-in" variant="secondary" size="sm" className="w-full">
        Sign in
      </ButtonLink>
    </div>
  );
}

/** Fixed left sidebar, shown from the lg breakpoint. */
export function Sidebar() {
  return (
    <aside className="hidden w-sidebar shrink-0 border-r border-line-subtle bg-surface-card lg:flex lg:flex-col">
      <div className="px-6 pb-6 pt-7">
        <Wordmark />
      </div>
      <nav aria-label="Main" className="flex-1 overflow-y-auto px-3">
        <SidebarNav />
      </nav>
      <div className="p-4">
        <SessionPanel />
      </div>
    </aside>
  );
}
