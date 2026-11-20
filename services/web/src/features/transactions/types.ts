/*
 * UI display models. They are defined by the UI, not by the API: components
 * render these, and once the shared contracts are merged (Step 0) a mapper
 * converts the generated API types into them. Do not grow these into
 * hand-written API types.
 */

/** The three routing policies the UI labels (arch §5.3). */
export type PolicyKey = "waterfall" | "cheapestFeasible" | "ppoProjected";

export type PolicyTier = "default" | "baseline" | "experimental";

export type StateModeKey = "historicalReplay" | "scenario" | "explicit";

/**
 * What the user sees in the Status column:
 * - completed: routed, allowed, fully executed;
 * - partial: routed and allowed, but not fully executed;
 * - rejected: routed, but the feasibility rules did not allow it (not an error);
 * - failed: the routing call failed, so there is no decision.
 */
export type Outcome = "completed" | "partial" | "rejected" | "failed";

export type TransactionRow = {
  id: string;
  /** ISO 8601 UTC. */
  createdAt: string;
  /** Null when no decision confirmed it (failed transactions). */
  corridor: string | null;
  amountUsd: number;
  policy: PolicyKey;
  /** Null for failed transactions. */
  policyTier: PolicyTier | null;
  outcome: Outcome;
  stateMode: StateModeKey;
  /** YYYY-MM-DD. */
  simulationDate: string;
};

export const POLICY_NAMES: Record<PolicyKey, string> = {
  waterfall: "Waterfall",
  cheapestFeasible: "Cheapest feasible",
  ppoProjected: "PPO (projected)",
};

export const STATE_MODE_NAMES: Record<StateModeKey, string> = {
  historicalReplay: "Historical replay",
  scenario: "Scenario",
  explicit: "Explicit state",
};
