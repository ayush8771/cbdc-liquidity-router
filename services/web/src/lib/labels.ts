/**
 * Mandatory UI labels, exactly as written in docs/PHASE2_ARCHITECTURE.md §5.3.
 * Do not reword them; test/labels.test.ts checks the exact strings.
 */
export const MANDATORY_LABELS = {
  /** Liquidity, congestion and risk values. */
  simulated: "Simulated",
  /** Explicit states (valuesProvenance "user_supplied_synthetic"). */
  userSuppliedState: "User-supplied synthetic state",
  /** The ppoProjected policy (policyStatus "experimental"). */
  experimental: "Experimental",
  /** Reward weights (rewardWeights.status "placeholder"). */
  placeholderWeights: "Placeholder weights",
  /** The default policy (policyStatus "default"). */
  defaultWaterfall: "Default (waterfall)",
  /** Venues tagged "synthetic_bridge_expansion". */
  syntheticVenue: "Synthetic venue",
  /** Persistent banner (arch §5.3, §8). */
  devAuthBanner: "Development authentication — not secure",
} as const;

export type MandatoryLabelKey = keyof typeof MANDATORY_LABELS;

/**
 * Arch §5.3 and §9.3 require the UI to state that replay transactions don't
 * consume liquidity. The exact wording is not fixed by the docs.
 */
export const NO_LIQUIDITY_CARRY_OVER =
  "Replay transactions don't consume liquidity: each transaction is routed independently against the same state.";
