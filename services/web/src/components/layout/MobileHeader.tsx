import { useEffect, useId, useState } from "react";
import { Icon } from "../ui/Icon";
import { SessionPanel, SidebarNav } from "./Sidebar";
import { Wordmark } from "./Wordmark";

/**
 * Header with a disclosure menu, below the lg breakpoint. A disclosure (not a
 * modal) keeps keyboard and screen-reader behaviour simple: the menu sits in
 * the normal reading order directly after its button.
 */
export function MobileHeader() {
  const [open, setOpen] = useState(false);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="border-b border-line-subtle bg-surface-card lg:hidden">
      <div className="flex items-center justify-between px-4 py-3 sm:px-6">
        <Wordmark />
        <button
          type="button"
          className="inline-flex h-10 w-10 items-center justify-center rounded-pill border border-line-control text-ink-body hover:text-paper-white"
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name={open ? "close" : "menu"} size={18} />
          <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
        </button>
      </div>
      <nav id={menuId} aria-label="Main" hidden={!open} className="space-y-4 px-3 pb-4 sm:px-5">
        <SidebarNav onNavigate={() => setOpen(false)} />
        <SessionPanel />
      </nav>
    </div>
  );
}
