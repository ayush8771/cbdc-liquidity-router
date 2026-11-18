// Test data for the comparison endpoints: an Application API request body and
// /v1/compare 200 bodies, based on API contract §2.9 and §3.6.
import { engineRouteResponse, type EngineOptions } from "./transactions.js";

export type EnginePolicy = "waterfall" | "cheapest_feasible" | "ppo_projected";

export const COMPARE_NOTE =
  "Single-transaction comparison under placeholder reward weights. Not evidence that one policy is better; see docs/STAGE1F_RESULTS.md.";

/** The engine's skipped[].message in these tests; the backend passes it through unchanged. */
export const ENGINE_SKIP_MESSAGE = "no approved checkpoint configured";

const STATUS = { waterfall: "default", cheapest_feasible: "baseline", ppo_projected: "experimental" } as const;

/** The §3.6 request: the §3.2 example without `policy`. */
export function comparisonBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    senderCountry: "GBR",
    receiverCountry: "PHL",
    amountUsd: 300000.0,
    state: { mode: "historicalReplay", date: "2024-06-14" },
    ...overrides,
  };
}

export interface ResultOptions {
  checkpointSha256?: string | null;
  clientReference?: string | null;
  stateMode?: EngineOptions["stateMode"];
  scenarioId?: string | null;
}

/** One /v1/compare result: the RouteResponse for a policy, with its own decision_id. */
export function engineResult(
  policy: EnginePolicy,
  { checkpointSha256 = null, clientReference = null, stateMode, scenarioId = null }: ResultOptions = {},
): Record<string, unknown> {
  const body = engineRouteResponse({ policy, policyStatus: STATUS[policy], clientReference, stateMode, scenarioId });
  return {
    ...body,
    decision_id: `sha256:${policy}`,
    provenance: {
      ...(body.provenance as Record<string, unknown>),
      checkpoint: checkpointSha256 === null ? null : { checkpoint_id: "approved-1", sha256: checkpointSha256 },
    },
  };
}

export function engineSkipped(policy: string, code = "POLICY_DISABLED", message = ENGINE_SKIP_MESSAGE) {
  return { policy, code, message };
}

/** A /v1/compare 200 body (§2.9). */
export function engineCompareResponse(
  results: Array<Record<string, unknown>>,
  skipped: Array<Record<string, unknown>> = [],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { results, skipped, same_state: true, note: COMPARE_NOTE, ...overrides };
}
