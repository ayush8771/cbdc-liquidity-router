/*
 * UI display model for the Transaction Detail page. Defined by the UI, like
 * ./types.ts: components render these, and once the shared contracts are
 * merged a mapper converts the generated API types into them. The field names
 * follow the rev 5 contract's TransactionRecord (camelCase) so that mapper
 * stays a straight copy, but this is not the API type and must not become one.
 *
 * What the mapper has to handle: `decision` is null for a failed transaction
 * (status "failed"), and such a transaction has no decision ID either. Every
 * decision that does exist has a non-null `decisionId`: the contract requires
 * it, as "sha256:" followed by 64 lowercase hex digits.
 */
import type { Outcome, PolicyKey, PolicyTier, StateModeKey } from "./types";

export type DataSourceTag = "real_static_bridge" | "synthetic_bridge_expansion" | "synthetic_no_real_anchor";

export type Regime = "below_cheapest" | "near_boundary" | "splitting_needed" | "exceeds_combined";

export type WarningView = {
  /** Shown as written; an unknown code is displayed, never dropped. */
  code: string;
  message: string;
};

export type AllocationView = {
  bridgeUid: string;
  dataSourceTag: DataSourceTag;
  /** A fraction, as the contract defines `feePct`: 0.015 is 1.5%. Converted only for display. */
  feePct: number;
  liquidityUsd: number;
  /** Share of the amount the policy asked this venue for, 0 to 1. */
  shareRequested: number;
  amountRequestedUsd: number;
  amountExecutedUsd: number;
  amountClippedUsd: number;
};

export type DecisionView = {
  /** Required and never null in the contract: "sha256:" and 64 lowercase hex digits. */
  decisionId: string;
  feasibility: {
    allowed: boolean;
    reason: string | null;
    decisiveFactIds: string[];
    knowledgeVersion: string;
  };
  /** Empty for a regulatory rejection. */
  allocations: AllocationView[];
  totals: {
    requestedUsd: number;
    executedUsd: number;
    /**
     * Amount minus executed. The page uses this, not the environment's own
     * unrouted figure, which hides amounts that were never requested.
     */
    unroutedAmountBasedUsd: number;
    /** 0 to 1. */
    completionRatio: number;
    completed: boolean;
    bridgesUsed: number;
  };
  regime: string;
  warnings: WarningView[];
};

export type TransactionDetailView = {
  id: string;
  /** ISO 8601 UTC. */
  createdAt: string;
  status: "routed" | "failed";
  /** Same classification as the history list: failed, rejected, partial or completed. */
  outcome: Outcome;
  /** Null when no engine result confirmed it. Never derived from the country codes. */
  corridor: string | null;
  senderCountry: string;
  receiverCountry: string;
  /** The requested amount. */
  amountUsd: number;
  /** YYYY-MM-DD. */
  simulationDate: string;
  stateMode: StateModeKey;
  policy: PolicyKey;
  /** Null for a failed transaction. */
  policyTier: PolicyTier | null;
  clientReference: string | null;
  /** Set when status is "failed": the error code and the backend's fixed message. */
  failure: { code: string; message: string } | null;
  /** Null when status is "failed". */
  decision: DecisionView | null;
};

export const REGIME_NAMES: Record<string, string> = {
  below_cheapest: "Below cheapest venue",
  near_boundary: "Near boundary",
  splitting_needed: "Splitting needed",
  exceeds_combined: "Exceeds combined liquidity",
};
