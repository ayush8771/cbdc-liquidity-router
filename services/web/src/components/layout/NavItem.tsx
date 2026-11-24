import { NavLink } from "react-router-dom";
import { cx } from "../../lib/cx";
import { Icon, type IconName } from "../ui/Icon";

type NavItemProps = {
  to: string;
  label: string;
  icon: IconName;
  onNavigate?: () => void;
};

/**
 * DESIGN.md "Navigation Link": no background, no border; 14px Inter in Fog
 * when inactive, Paper White when active or hovered; a 2px-radius indicator.
 * In the vertical sidebar the indicator is a left bar, not an underline.
 */
export function NavItem({ to, label, icon, onNavigate }: NavItemProps) {
  return (
    <NavLink
      to={to}
      end
      onClick={onNavigate}
      className={({ isActive }) =>
        cx(
          "relative flex items-center gap-3 rounded-pill px-4 py-2.5 text-ui font-medium transition-colors duration-150",
          isActive ? "text-paper-white" : "text-ink-muted hover:text-paper-white",
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            aria-hidden="true"
            className={cx(
              "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-indicator bg-paper-white transition-opacity",
              isActive ? "opacity-100" : "opacity-0",
            )}
          />
          <Icon name={icon} size={18} />
          <span>{label}</span>
        </>
      )}
    </NavLink>
  );
}
