/*
 * UI display model for the Compare screen. Defined by the UI: the components
 * render these, and compareApi.ts converts the API's comparison into them. The
 * names follow contract §3.6, but this is not the API type.
 *
 * Nothing here ranks, scores or picks anything. The policies stay in the order
 * they were requested in, and every number is the one the engine returned,
 * under placeholder reward weights.
 */
import type { AllocationView, WarningView } from "../transactions/detailTypes";
import type { Outcome, PolicyKey, PolicyTier } from "../transactions/types";

export type ComparedAllocationView = AllocationView & {
  /** The PPO policy's share before the capacity projection; null for the other policies. */
  shareBeforeProjection: number | null;
};

export type ComparedDecisionView = {
  decisionId: string;
  policy: PolicyKey;
  policyTier: PolicyTier;
  /** Derived the way the History derives it: completed, partial or rejected. */
  outcome: Exclude<Outcome, "failed">;
  feasibility: { allowed: boolean; reason: string | null };
  totals: {
    requestedUsd: number;
    executedUsd: number;
    /** Amount minus executed. */
    unroutedAmountBasedUsd: number;
    completionRatio: number;
    bridgesUsed: number;
  };
  /** Reward, latency and risk are under these weights, which are placeholders. */
  metrics: {
    feeCostUsd: number;
    latencyTerm: number;
    riskTerm: number;
    rewardAmountBased: number;
    weightsStatus: string;
  };
  /** True when the PPO policy's allocation was adjusted to the venues' capacity. */
  projectionApplied: boolean;
  allocations: ComparedAllocationView[];
  warnings: WarningView[];
};

/** One column of the comparison: a policy that ran, or one the engine skipped. */
export type PolicyColumnView =
  | { kind: "result"; policy: PolicyKey; decision: ComparedDecisionView }
  /** `message` is the engine's own text, unchanged (contract §3.6). A skipped policy is a result, not an error. */
  | { kind: "skipped"; policy: PolicyKey; code: string; message: string };

export type ComparisonView = {
  id: string;
  createdAt: string;
  transaction: {
    senderCountry: string;
    receiverCountry: string;
    /** Null only when every policy was skipped. */
    corridor: string | null;
    amountUsd: number;
    simulationDate: string;
    clientReference: string | null;
  };
  stateMode: string;
  /** One column per requested policy, in the order they were requested. */
  columns: PolicyColumnView[];
  /** The API's own note about what a comparison is and isn't. Always shown as written. */
  note: string;
};
