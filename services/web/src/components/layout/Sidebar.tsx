import { NAVIGATION } from "../../app/navigation";
import { useAuth } from "../../auth/AuthContext";
import { Button, ButtonLink } from "../ui/Button";
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

/** Session area. It names the user only after GET /api/v1/auth/me has accepted the token. */
export function SessionPanel() {
  const { status, user, signOut } = useAuth();

  if (status === "signedIn" && user) {
    return (
      <div className="space-y-3 rounded-card border border-line-subtle bg-surface-card p-4">
        <div className="space-y-1">
          <p className="text-meta text-ink-muted">Signed in as</p>
          <p className="break-all text-ui text-ink-body">{user.email}</p>
          <p className="text-meta text-ink-muted">
            Role: <span className="text-ink-body">{user.role}</span>
          </p>
        </div>
        <Button variant="secondary" size="sm" className="w-full" onClick={signOut}>
          Sign out
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-card border border-line-subtle bg-surface-card p-4">
      <p className="text-meta text-ink-muted">
        {status === "restoring" ? "Checking your session…" : "Not signed in."}
      </p>
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
