import { Badge, type BadgeTone } from "../../components/ui/Badge";
import type { Outcome } from "./types";

const DISPLAY: Record<Outcome, { label: string; tone: BadgeTone }> = {
  completed: { label: "Completed", tone: "success" },
  partial: { label: "Partial", tone: "warning" },
  // A feasibility rejection is a valid routing result, not an error (contract §2.8).
  rejected: { label: "Rejected", tone: "tag" },
  failed: { label: "Failed", tone: "danger" },
};

/** Status pill; the text carries the meaning, so colour is never the only signal. */
export function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  const { label, tone } = DISPLAY[outcome];
  return <Badge tone={tone}>{label}</Badge>;
}
