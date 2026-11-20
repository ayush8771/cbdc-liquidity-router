import { Badge, type BadgeTone } from "../ui/Badge";
import { MANDATORY_LABELS, type MandatoryLabelKey } from "../../lib/labels";

// Experimental is the only label that warns. Default (waterfall) is a policy
// category, so it takes the Copper category style; the rest are pill tags.
const toneFor: Record<Exclude<MandatoryLabelKey, "devAuthBanner">, BadgeTone> = {
  simulated: "tag",
  userSuppliedState: "tag",
  experimental: "warning",
  placeholderWeights: "tag",
  defaultWaterfall: "category",
  syntheticVenue: "tag",
};

type MandatoryLabelProps = {
  kind: Exclude<MandatoryLabelKey, "devAuthBanner">;
  className?: string;
};

/** A required provenance or policy label (arch §5.3). Text is never reworded. */
export function MandatoryLabel({ kind, className }: MandatoryLabelProps) {
  return (
    <Badge tone={toneFor[kind]} className={className}>
      {MANDATORY_LABELS[kind]}
    </Badge>
  );
}
