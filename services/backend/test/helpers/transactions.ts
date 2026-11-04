// Test data for POST /api/v1/transactions: an Application API request body
// and the matching /v1/route 200 bodies, based on API contract §2.8 and §3.2.

/** The six scenario IDs confirmed by Dev A (API contract §1), engine spelling. */
export const SCENARIO_IDS = [
  "baseline",
  "liquidity_minus30",
  "liquidity_minus50",
  "cheapest_venue_outage",
  "congestion_x2",
  "combined_stress",
] as const;

/** The §3.2 request example, without clientReference. */
export function requestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    senderCountry: "GBR",
    receiverCountry: "PHL",
    amountUsd: 300000.0,
    state: { mode: "historicalReplay", date: "2024-06-14" },
    policy: "waterfall",
    ...overrides,
  };
}

export interface EngineOptions {
  policy?: "waterfall" | "cheapest_feasible" | "ppo_projected";
  policyStatus?: "default" | "baseline" | "experimental";
  stateMode?: "historical_replay" | "scenario" | "explicit";
  scenarioId?: string | null;
  clientReference?: string | null;
}

/** The §2.8 RouteResponse example (three allocations), adjusted to the request. */
export function engineRouteResponse(options: EngineOptions = {}): Record<string, unknown> {
  const stateMode = options.stateMode ?? "historical_replay";
  return {
    decision_id: "sha256:9f2c",
    policy: options.policy ?? "waterfall",
    policy_status: options.policyStatus ?? "default",
    transaction: {
      sender_country: "GBR",
      receiver_country: "PHL",
      amount_usd: 300000.0,
      corridor: "GBR->PHL",
      simulation_date: "2024-06-14",
      client_reference: options.clientReference ?? null,
    },
    feasibility: { allowed: true, reason: null, decisive_fact_ids: [], knowledge_version: "2026-11-02.1" },
    allocations: [
      { slot: 0, bridge_uid: "GBR->PHL#0", data_source_tag: "real_static_bridge", fee_pct: 0.02, liquidity_usd: 412345.6,
        congestion: 0.31, risk: 0.087, share_requested: 0.5, amount_requested_usd: 150000.0, amount_executed_usd: 150000.0,
        amount_clipped_usd: 0.0, share_before_projection: null },
      { slot: 1, bridge_uid: "GBR->PHL#1", data_source_tag: "synthetic_bridge_expansion", fee_pct: 0.014, liquidity_usd: 150000.0,
        congestion: 0.22, risk: 0.087, share_requested: 0.5, amount_requested_usd: 150000.0, amount_executed_usd: 150000.0,
        amount_clipped_usd: 0.0, share_before_projection: null },
      { slot: 2, bridge_uid: "GBR->PHL#2", data_source_tag: "synthetic_bridge_expansion", fee_pct: 0.03, liquidity_usd: 85000.0,
        congestion: 0.48, risk: 0.087, share_requested: 0.0, amount_requested_usd: 0.0, amount_executed_usd: 0.0,
        amount_clipped_usd: 0.0, share_before_projection: null },
    ],
    totals: { amount_usd: 300000.0, requested_usd: 300000.0, executed_usd: 300000.0, unrouted_env_usd: 0.0,
      unrouted_amount_based_usd: 0.0, completion_ratio: 1.0, completed: true, bridges_used: 2 },
    metrics: { fee_cost_usd: 5100.0, baseline_cost_pct: 0.0612, cost_term: 0.0442, latency_term: 0.265, risk_term: 0.087,
      unrouted_term_env: 0.0, unrouted_term_amount_based: 0.0, reward_env: -0.3078, reward_amount_based: -0.3078,
      reward_weights: { lambda_latency: 1.0, lambda_risk: 1.0, lambda_unrouted: 1.0, status: "placeholder" } },
    diagnostics: { regime: "splitting_needed", combined_liquidity_usd: 647345.6, projection_applied: false },
    provenance: { state_mode: stateMode, state_date: "2024-06-14", split: "test", scenario_id: options.scenarioId ?? null,
      values_provenance: stateMode === "scenario" ? "synthetic_scenario" : stateMode === "explicit" ? "user_supplied_synthetic" : "synthetic_simulation",
      engine_version: "0.1.0", git_commit: "bc9905e", knowledge_sha256: "<hex>",
      daily_state_sha256: "<hex>", state_frame_sha256: "<hex>", checkpoint: null, device: "cpu", platform: "linux-x86_64" },
    warnings: [],
  };
}

/**
 * A regulatory rejection as §2.8 defines it: HTTP 200, allowed false, no
 * allocations, requested and executed 0, and the full metrics object with
 * fee_cost_usd 0, execution costs 0, reward_env 0 and reward_amount_based
 * -lambda_unrouted. unrouted_env_usd is 0 (requested - executed) and
 * unrouted_amount_based_usd is the full amount, deliberately.
 */
export function engineRegulatoryRejection(): Record<string, unknown> {
  return {
    ...engineRouteResponse(),
    feasibility: { allowed: false, reason: "amount exceeds the regulatory cap", decisive_fact_ids: ["cap-500k"],
      knowledge_version: "2026-11-02.1" },
    allocations: [],
    totals: { amount_usd: 300000.0, requested_usd: 0.0, executed_usd: 0.0, unrouted_env_usd: 0.0,
      unrouted_amount_based_usd: 300000.0, completion_ratio: 0.0, completed: false, bridges_used: 0 },
    metrics: { fee_cost_usd: 0.0, baseline_cost_pct: 0.0612, cost_term: 0.0, latency_term: 0.0, risk_term: 0.0,
      unrouted_term_env: 0.0, unrouted_term_amount_based: 1.0, reward_env: 0.0, reward_amount_based: -1.0,
      reward_weights: { lambda_latency: 1.0, lambda_risk: 1.0, lambda_unrouted: 1.0, status: "placeholder" } },
  };
}

/** An inference error envelope (§4). */
export function engineError(code: string, message = "upstream message"): Record<string, unknown> {
  return { error: { code, message, details: {}, request_id: "inference-request-id" } };
}

/**
 * The §2.10 ExplainResponse example, with the decision_id of
 * engineRouteResponse(), so it matches a decision saved from that body.
 */
export function engineExplainResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision_id: "sha256:9f2c",
    policy: "waterfall",
    summary: "Routed 100% of $300,000 across 2 venues in fee order, each filled up to its simulated liquidity.",
    feasibility: {
      allowed: true,
      reason: null,
      active_facts: [
        { fact_id: "global_max_single_transfer_usd", rule_type: "max_single_transfer_usd", value: 500000.0,
          provenance_tag: "project_assumption", verified: false, source: "Frozen project constraint ... Not a real regulation." },
      ],
      provider: "StaticMemoryProvider",
    },
    venue_explanations: [
      { bridge_uid: "GBR->PHL#1", outcome: "used", reason_code: "CHEAPEST_FILLED_TO_LIQUIDITY",
        text: "Lowest fee (1.40%). Filled to its simulated liquidity of $150,000." },
      { bridge_uid: "GBR->PHL#0", outcome: "used", reason_code: "NEXT_CHEAPEST_REMAINDER",
        text: "Next-lowest fee (2.00%). Took the remaining $150,000." },
      { bridge_uid: "GBR->PHL#2", outcome: "unused", reason_code: "AMOUNT_EXHAUSTED",
        text: "Not needed: the amount was fully routed by cheaper venues." },
    ],
    policy_notes: [],
    semantic_context: null,
    limitations: [
      "Bridge liquidity and congestion are synthetic simulation values.",
      "Reward weights are uncalibrated placeholders.",
      "The only regulatory fact is an assumed $500K cap, not a real regulation.",
      "Each transaction is independent; routing does not deplete liquidity for later transactions.",
    ],
    ...overrides,
  };
}

/** The camelCase Explanation (app OpenAPI) for engineExplainResponse(), without transactionId. */
export function appExplanation(): Record<string, unknown> {
  return {
    decisionId: "sha256:9f2c",
    policy: "waterfall",
    summary: "Routed 100% of $300,000 across 2 venues in fee order, each filled up to its simulated liquidity.",
    feasibility: {
      allowed: true,
      reason: null,
      activeFacts: [
        { factId: "global_max_single_transfer_usd", ruleType: "max_single_transfer_usd", value: 500000.0,
          provenanceTag: "project_assumption", verified: false, source: "Frozen project constraint ... Not a real regulation." },
      ],
      provider: "StaticMemoryProvider",
    },
    venueExplanations: [
      { bridgeUid: "GBR->PHL#1", outcome: "used", reasonCode: "CHEAPEST_FILLED_TO_LIQUIDITY",
        text: "Lowest fee (1.40%). Filled to its simulated liquidity of $150,000." },
      { bridgeUid: "GBR->PHL#0", outcome: "used", reasonCode: "NEXT_CHEAPEST_REMAINDER",
        text: "Next-lowest fee (2.00%). Took the remaining $150,000." },
      { bridgeUid: "GBR->PHL#2", outcome: "unused", reasonCode: "AMOUNT_EXHAUSTED",
        text: "Not needed: the amount was fully routed by cheaper venues." },
    ],
    policyNotes: [],
    semanticContext: null,
    limitations: [
      "Bridge liquidity and congestion are synthetic simulation values.",
      "Reward weights are uncalibrated placeholders.",
      "The only regulatory fact is an assumed $500K cap, not a real regulation.",
      "Each transaction is independent; routing does not deplete liquidity for later transactions.",
    ],
  };
}
