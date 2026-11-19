import { MANDATORY_LABELS } from "../../lib/labels";
import { Icon } from "../ui/Icon";

/** Persistent banner required on every screen (arch §5.3, §8). */
export function DevAuthBanner() {
  return (
    <div
      role="note"
      className="flex items-center justify-center gap-2 border-b border-status-warning/30 bg-surface-void px-4 py-2 text-center text-meta font-medium text-status-warning"
    >
      <Icon name="alert" size={14} className="shrink-0" />
      <span>{MANDATORY_LABELS.devAuthBanner}</span>
    </div>
  );
}
