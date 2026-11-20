import { MandatoryLabel } from "../../components/labels/MandatoryLabel";
import { POLICY_NAMES, type PolicyKey, type PolicyTier } from "./types";

/**
 * Policy with its required label (arch §5.3): the default policy reads
 * "Default (waterfall)", and ppoProjected carries "Experimental". A failed
 * transaction has no confirmed tier, so only the requested policy is shown.
 */
export function PolicyCell({ policy, tier }: { policy: PolicyKey; tier: PolicyTier | null }) {
  if (policy === "waterfall" && tier === "default") return <MandatoryLabel kind="defaultWaterfall" />;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {/* An unknown policy name from the API is shown as written (contract §1). */}
      <span>{POLICY_NAMES[policy] ?? policy}</span>
      {tier === "experimental" ? <MandatoryLabel kind="experimental" /> : null}
    </span>
  );
}
