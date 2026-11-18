import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InvalidRouteResponseError,
  mapRouteResponse,
  POLICY_FROM_ENGINE,
  STATE_MODE_FROM_ENGINE,
} from "../../src/mappers/routeResponse.js";
import { InferenceError } from "../../src/inferenceClient/errors.js";
import { validateTransactionRequest, type TransactionRequest } from "../../src/validation/transactionRequest.js";

// API contract §2.8's RouteResponse example (all three allocations), as test data.
function engineExample(): Record<string, unknown> {
  return {
    decision_id: "sha256:9f2c",
    policy: "waterfall",
    policy_status: "default",
    transaction: {
      sender_country: "GBR",
      receiver_country: "PHL",
      amount_usd: 300000.0,
      corridor: "GBR->PHL",
      simulation_date: "2024-06-14",
      client_reference: null,
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
    provenance: { state_mode: "historical_replay", state_date: "2024-06-14", split: "test", scenario_id: null,
      values_provenance: "synthetic_simulation", engine_version: "0.1.0", git_commit: "bc9905e", knowledge_sha256: "<hex>",
      daily_state_sha256: "<hex>", state_frame_sha256: "<hex>", checkpoint: null, device: "cpu", platform: "linux-x86_64" },
    warnings: [],
  };
}

function request(body: Record<string, unknown> = {}): TransactionRequest {
  const result = validateTransactionRequest({
    senderCountry: "GBR",
    receiverCountry: "PHL",
    amountUsd: 300000.0,
    state: { mode: "historicalReplay", date: "2024-06-14" },
    ...body,
  });
  assert.ok(result.ok);
  return result.value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function problemsOf(body: Record<string, unknown>, req: TransactionRequest = request()): string[] {
  try {
    mapRouteResponse(body, req);
  } catch (error) {
    assert.ok(error instanceof InvalidRouteResponseError, `expected InvalidRouteResponseError, got ${String(error)}`);
    return [...error.problems];
  }
  assert.fail("expected the response to be rejected");
}

const set = (body: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> => {
  const keys = path.split(".");
  let target = body as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
  if (value === undefined) delete target[keys.at(-1)!];
  else target[keys.at(-1)!] = value;
  return body;
};

describe("mapRouteResponse: the contract examples", () => {
  it("maps the §2.8 example to the §3.2 transaction and decision", () => {
    const { transaction, decision } = mapRouteResponse(engineExample(), request());
    assert.deepEqual(transaction, {
      senderCountry: "GBR", receiverCountry: "PHL", amountUsd: 300000.0, corridor: "GBR->PHL",
      simulationDate: "2024-06-14", clientReference: null,
    });
    assert.deepEqual(decision, {
      decisionId: "sha256:9f2c",
      policy: "waterfall",
      policyStatus: "default",
      feasibility: { allowed: true, reason: null, decisiveFactIds: [], knowledgeVersion: "2026-11-02.1" },
      allocations: [
        { slot: 0, bridgeUid: "GBR->PHL#0", dataSourceTag: "real_static_bridge", feePct: 0.02, liquidityUsd: 412345.6,
          congestion: 0.31, risk: 0.087, shareRequested: 0.5, amountRequestedUsd: 150000.0, amountExecutedUsd: 150000.0,
          amountClippedUsd: 0.0, shareBeforeProjection: null },
        { slot: 1, bridgeUid: "GBR->PHL#1", dataSourceTag: "synthetic_bridge_expansion", feePct: 0.014, liquidityUsd: 150000.0,
          congestion: 0.22, risk: 0.087, shareRequested: 0.5, amountRequestedUsd: 150000.0, amountExecutedUsd: 150000.0,
          amountClippedUsd: 0.0, shareBeforeProjection: null },
        { slot: 2, bridgeUid: "GBR->PHL#2", dataSourceTag: "synthetic_bridge_expansion", feePct: 0.03, liquidityUsd: 85000.0,
          congestion: 0.48, risk: 0.087, shareRequested: 0.0, amountRequestedUsd: 0.0, amountExecutedUsd: 0.0,
          amountClippedUsd: 0.0, shareBeforeProjection: null },
      ],
      totals: { amountUsd: 300000.0, requestedUsd: 300000.0, executedUsd: 300000.0, unroutedEnvUsd: 0.0,
        unroutedAmountBasedUsd: 0.0, completionRatio: 1.0, completed: true, bridgesUsed: 2 },
      metrics: { feeCostUsd: 5100.0, baselineCostPct: 0.0612, costTerm: 0.0442, latencyTerm: 0.265, riskTerm: 0.087,
        unroutedTermEnv: 0.0, unroutedTermAmountBased: 0.0, rewardEnv: -0.3078, rewardAmountBased: -0.3078,
        rewardWeights: { lambdaLatency: 1.0, lambdaRisk: 1.0, lambdaUnrouted: 1.0, status: "placeholder" } },
      diagnostics: { regime: "splitting_needed", combinedLiquidityUsd: 647345.6, projectionApplied: false },
      provenance: { stateMode: "historicalReplay", stateDate: "2024-06-14", split: "test", scenarioId: null,
        valuesProvenance: "synthetic_simulation", engineVersion: "0.1.0", gitCommit: "bc9905e", knowledgeSha256: "<hex>",
        dailyStateSha256: "<hex>", stateFrameSha256: "<hex>", checkpoint: null, device: "cpu", platform: "linux-x86_64" },
      warnings: [],
    });
    // §3.2's key order: transaction separate, decision without it.
    assert.equal("transaction" in decision, false);
  });

  it("builds the RoutingDecision and Allocation column values, copied not computed", () => {
    const { columns } = mapRouteResponse(engineExample(), request());
    assert.equal(columns.corridor, "GBR->PHL");
    assert.deepEqual(columns.decision, {
      decisionId: "sha256:9f2c", policy: "waterfall", policyStatus: "default", allowed: true, completed: true,
      completionRatio: 1.0, executedUsd: 300000.0, unroutedEnvUsd: 0.0, unroutedAmountBasedUsd: 0.0,
      rewardEnv: -0.3078, rewardAmountBased: -0.3078, latencyTerm: 0.265, riskTerm: 0.087, feeCostUsd: 5100.0,
      valuesProvenance: "synthetic_simulation", stateFrameSha256: "<hex>", checkpointSha256: null,
      knowledgeSha256: "<hex>", gitCommit: "bc9905e",
    });
    assert.deepEqual(columns.allocations[2], {
      slot: 2, bridgeUid: "GBR->PHL#2", shareRequested: 0.0, amountRequestedUsd: 0.0, amountExecutedUsd: 0.0,
      amountClippedUsd: 0.0, liquidityUsd: 85000.0, congestion: 0.48, risk: 0.087, shareBeforeProjection: null,
    });
    assert.equal(columns.allocations.length, 3);
  });

  it("copies inconsistent numbers as they are, never recomputing them", () => {
    const body = engineExample();
    set(body, "totals.executed_usd", 1.0); // allocations sum to 300000; the engine's figure wins
    set(body, "totals.completion_ratio", 0.123);
    const { columns } = mapRouteResponse(body, request());
    assert.equal(columns.decision.executedUsd, 1.0);
    assert.equal(columns.decision.completionRatio, 0.123);
  });
});

describe("mapRouteResponse: enum values and unchanged values", () => {
  it("maps every policy (§3.2)", () => {
    assert.deepEqual(POLICY_FROM_ENGINE, { waterfall: "waterfall", cheapest_feasible: "cheapestFeasible", ppo_projected: "ppoProjected" });
    const body = set(set(engineExample(), "policy", "cheapest_feasible"), "policy_status", "baseline");
    const mapped = mapRouteResponse(body, request({ policy: "cheapestFeasible" }));
    assert.equal(mapped.decision.policy, "cheapestFeasible");
    assert.equal(mapped.decision.policyStatus, "baseline");
    assert.equal(mapped.columns.decision.policy, "cheapestFeasible");
  });

  it("maps every state mode, keeping scenario_id unchanged (convention pending)", () => {
    assert.deepEqual(STATE_MODE_FROM_ENGINE, { historical_replay: "historicalReplay", scenario: "scenario", explicit: "explicit" });
    const body = engineExample();
    set(body, "provenance.state_mode", "scenario");
    set(body, "provenance.scenario_id", "cheapest_venue_outage");
    set(body, "provenance.values_provenance", "synthetic_scenario");
    const mapped = mapRouteResponse(body, request({ state: { mode: "scenario", date: "2024-06-14", scenarioId: "cheapest_venue_outage" } }));
    const provenance = mapped.decision.provenance as Record<string, unknown>;
    assert.equal(provenance.stateMode, "scenario");
    assert.equal(provenance.scenarioId, "cheapest_venue_outage");
    assert.equal(provenance.valuesProvenance, "synthetic_scenario");
  });

  it("keeps IDs, codes, tags, reason strings and other values unchanged", () => {
    const body = engineExample();
    set(body, "feasibility.allowed", false);
    set(body, "feasibility.reason", "amount_exceeds_cap: amount_usd 900000.0 > 500000.0");
    set(body, "feasibility.decisive_fact_ids", ["cap_single_transfer_usd"]);
    set(body, "warnings", [{ code: "PARTIAL_COMPLETION", message: "completed is false" }, { code: "SYNTHETIC_COST_ANCHOR", message: "m" }]);
    const decision = mapRouteResponse(body, request()).decision as Record<string, Record<string, unknown>>;
    assert.equal(decision.feasibility!.reason, "amount_exceeds_cap: amount_usd 900000.0 > 500000.0");
    assert.deepEqual(decision.feasibility!.decisiveFactIds, ["cap_single_transfer_usd"]);
    assert.deepEqual(decision.warnings, [{ code: "PARTIAL_COMPLETION", message: "completed is false" }, { code: "SYNTHETIC_COST_ANCHOR", message: "m" }]);
    assert.equal(decision.diagnostics!.regime, "splitting_needed");
    assert.equal(decision.provenance!.split, "test");
    assert.equal((decision.allocations as unknown as Array<Record<string, unknown>>)[1]!.dataSourceTag, "synthetic_bridge_expansion");
    assert.equal((decision.allocations as unknown as Array<Record<string, unknown>>)[1]!.bridgeUid, "GBR->PHL#1");
  });

  it("keeps unknown fields at every level, mapped to camelCase", () => {
    const body = engineExample();
    body.future_field = { nested_value: "keep_me" };
    set(body, "totals.new_total", 7);
    (body.allocations as Array<Record<string, unknown>>)[0]!.extra_info = [{ some_key: 1 }];
    set(body, "transaction.new_echo", "x");
    const mapped = mapRouteResponse(body, request());
    assert.deepEqual(mapped.decision.futureField, { nestedValue: "keep_me" });
    assert.equal((mapped.decision.totals as Record<string, unknown>).newTotal, 7);
    assert.deepEqual(((mapped.decision.allocations as Array<Record<string, unknown>>)[0]!).extraInfo, [{ someKey: 1 }]);
    assert.equal(mapped.transaction.newEcho, "x");
  });
});

describe("mapRouteResponse: special cases", () => {
  // The §2.8 regulatory rejection: full metrics, fee and execution costs 0.
  function rejection(): Record<string, unknown> {
    const body = engineExample();
    set(body, "feasibility.allowed", false);
    set(body, "feasibility.reason", "amount exceeds cap");
    set(body, "allocations", []);
    set(body, "totals", { amount_usd: 900000.0, requested_usd: 0.0, executed_usd: 0.0, unrouted_env_usd: 0.0,
      unrouted_amount_based_usd: 900000.0, completion_ratio: 0.0, completed: false, bridges_used: 0 });
    set(body, "transaction.amount_usd", 900000.0);
    set(body, "metrics", { fee_cost_usd: 0.0, baseline_cost_pct: 0.0612, cost_term: 0.0, latency_term: 0.0, risk_term: 0.0,
      unrouted_term_env: 0.0, unrouted_term_amount_based: 1.0, reward_env: 0.0, reward_amount_based: -1.0,
      reward_weights: { lambda_latency: 1.0, lambda_risk: 1.0, lambda_unrouted: 1.0, status: "placeholder" } });
    return body;
  }

  it("maps a regulatory rejection with its full metrics, feeCostUsd 0 (§2.8)", () => {
    const mapped = mapRouteResponse(rejection(), request({ amountUsd: 900000.0 }));
    assert.deepEqual(mapped.columns.allocations, []);
    assert.equal(mapped.columns.decision.allowed, false);
    assert.equal(mapped.columns.decision.completed, false);
    const d = mapped.columns.decision;
    assert.deepEqual(
      [d.feeCostUsd, d.latencyTerm, d.riskTerm, d.rewardEnv, d.rewardAmountBased],
      [0, 0, 0, 0, -1],
    );
    assert.equal((mapped.decision.metrics as Record<string, unknown>).unroutedTermAmountBased, 1.0);
    assert.deepEqual(mapped.decision.allocations, []);
  });

  for (const [label, metrics] of [
    ["missing", undefined],
    ["null", null],
    ["an array", []],
    ["a number", 0],
  ] as const) {
    it(`rejects ${label} metrics, on an allowed decision and on a regulatory rejection`, () => {
      assert.deepEqual(problemsOf(set(engineExample(), "metrics", metrics)), ["metrics: must be an object"]);
      assert.deepEqual(problemsOf(set(rejection(), "metrics", metrics), request({ amountUsd: 900000.0 })), [
        "metrics: must be an object",
      ]);
    });
  }

  const METRIC_KEYS = [
    "fee_cost_usd", "baseline_cost_pct", "cost_term", "latency_term", "risk_term",
    "unrouted_term_env", "unrouted_term_amount_based", "reward_env", "reward_amount_based",
  ];
  for (const key of METRIC_KEYS) {
    for (const [label, value] of [["missing", undefined], ["null", null], ["a string", "1"], ["NaN", Number.NaN], ["true", true]] as const) {
      it(`rejects metrics.${key} that is ${label}`, () => {
        assert.deepEqual(problemsOf(set(engineExample(), `metrics.${key}`, value)), [`metrics.${key}: must be a finite number`]);
      });
    }
  }

  for (const [label, value] of [["missing", undefined], ["null", null], ["an array", []], ["a string", "placeholder"]] as const) {
    it(`rejects metrics.reward_weights that is ${label}`, () => {
      assert.deepEqual(problemsOf(set(engineExample(), "metrics.reward_weights", value)), [
        "metrics.reward_weights: must be an object",
      ]);
    });
  }

  for (const key of ["lambda_latency", "lambda_risk", "lambda_unrouted"]) {
    for (const value of [undefined, null, "1.0"]) {
      it(`rejects metrics.reward_weights.${key} = ${JSON.stringify(value) ?? "missing"}`, () => {
        assert.deepEqual(problemsOf(set(engineExample(), `metrics.reward_weights.${key}`, value)), [
          `metrics.reward_weights.${key}: must be a finite number`,
        ]);
      });
    }
  }

  for (const value of [undefined, null, "", 1, true, "calibrated", "Placeholder", "PLACEHOLDER", " placeholder", "placeholder ", "placeholder\n", ["placeholder"], { value: "placeholder" }]) {
    it(`rejects metrics.reward_weights.status = ${JSON.stringify(value) ?? "missing"}`, () => {
      assert.deepEqual(problemsOf(set(engineExample(), "metrics.reward_weights.status", value)), [
        'metrics.reward_weights.status: must be "placeholder"',
      ]);
    });
  }

  it('accepts metrics.reward_weights.status "placeholder", on an allowed decision and a rejection', () => {
    assert.equal(mapRouteResponse(engineExample(), request()).columns.decision.allowed, true);
    assert.equal(mapRouteResponse(rejection(), request({ amountUsd: 900000.0 })).columns.decision.allowed, false);
  });

  it("rejects a regulatory rejection whose reward_weights.status isn't placeholder", () => {
    assert.deepEqual(problemsOf(set(rejection(), "metrics.reward_weights.status", "calibrated"), request({ amountUsd: 900000.0 })), [
      'metrics.reward_weights.status: must be "placeholder"',
    ]);
  });

  it("reports every metrics problem at once", () => {
    const body = engineExample();
    set(body, "metrics.fee_cost_usd", null);
    set(body, "metrics.cost_term", undefined);
    set(body, "metrics.reward_weights.status", undefined);
    assert.deepEqual(problemsOf(body), [
      "metrics.fee_cost_usd: must be a finite number",
      "metrics.cost_term: must be a finite number",
      'metrics.reward_weights.status: must be "placeholder"',
    ]);
  });

  it("copies metrics.fee_cost_usd to feeCostUsd, including 0", () => {
    assert.equal(mapRouteResponse(set(engineExample(), "metrics.fee_cost_usd", 0), request()).columns.decision.feeCostUsd, 0);
    assert.equal(mapRouteResponse(engineExample(), request()).columns.decision.feeCostUsd, 5100.0);
  });

  it("maps a PPO projection with share_before_projection and a checkpoint", () => {
    const body = engineExample();
    set(body, "policy", "ppo_projected");
    set(body, "policy_status", "experimental");
    (body.allocations as Array<Record<string, unknown>>).forEach((a, i) => (a.share_before_projection = [0.62, 0.38, 0.0][i]));
    set(body, "diagnostics.projection_applied", true);
    set(body, "provenance.checkpoint", { checkpoint_id: "seed42", sha256: "abc123", approved_by: "owner", approved_on: "2026-11-02",
      source_run: "outputs/experiments/x" });
    set(body, "warnings", [{ code: "EXPERIMENTAL_POLICY", message: "m" }]);
    const mapped = mapRouteResponse(body, request({ policy: "ppoProjected" }));
    assert.equal(mapped.decision.policy, "ppoProjected");
    assert.equal(mapped.columns.decision.policyStatus, "experimental");
    assert.equal(mapped.columns.decision.checkpointSha256, "abc123");
    assert.deepEqual(mapped.columns.allocations.map((a) => a.shareBeforeProjection), [0.62, 0.38, 0.0]);
    assert.deepEqual((mapped.decision.provenance as Record<string, unknown>).checkpoint, {
      checkpointId: "seed42", sha256: "abc123", approvedBy: "owner", approvedOn: "2026-11-02", sourceRun: "outputs/experiments/x",
    });
  });

  it("maps a null checkpoint to a null column", () => {
    assert.equal(mapRouteResponse(engineExample(), request()).columns.decision.checkpointSha256, null);
  });

  it("checks an explicit state's reference date and a client reference against the request", () => {
    const body = engineExample();
    set(body, "provenance.state_mode", "explicit");
    set(body, "provenance.values_provenance", "user_supplied_synthetic");
    set(body, "transaction.simulation_date", "2023-03-01");
    set(body, "transaction.client_reference", "ref-1");
    const req = request({
      clientReference: "ref-1",
      state: { mode: "explicit", referenceDate: "2023-03-01", venues: [{ bridgeUid: "GBR->PHL#0", liquidityUsd: 1, congestion: 0 }] },
    });
    const mapped = mapRouteResponse(body, req);
    assert.equal((mapped.decision.provenance as Record<string, unknown>).stateMode, "explicit");
    assert.equal(mapped.transaction.clientReference, "ref-1");
  });
});

describe("mapRouteResponse: rejections", () => {
  it("rejects a policy that differs from the requested one, as a 502 INFERENCE_ERROR", () => {
    const body = set(engineExample(), "policy", "cheapest_feasible");
    let caught: unknown;
    try {
      mapRouteResponse(body, request({ policy: "waterfall" }));
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof InvalidRouteResponseError);
    assert.ok(caught instanceof InferenceError);
    assert.equal(caught.status, 502);
    assert.equal(caught.code, "INFERENCE_ERROR");
    assert.equal(caught.message, "The inference service returned an invalid response.");
    assert.deepEqual(caught.details, {});
    assert.equal(caught.failure, "invalid_response");
    assert.equal(caught.upstreamStatus, 200);
    assert.deepEqual(caught.problems, ["policy: differs from the requested policy"]);
  });

  it("rejects responses that don't echo the request", () => {
    const cases: Array<[string, unknown, string]> = [
      ["transaction.sender_country", "USA", "transaction.sender_country: differs from the request"],
      ["transaction.receiver_country", "IND", "transaction.receiver_country: differs from the request"],
      ["transaction.amount_usd", 300000.01, "transaction.amount_usd: differs from the request"],
      ["transaction.simulation_date", "2024-06-15", "transaction.simulation_date: differs from the request"],
      ["transaction.client_reference", "someone-else", "transaction.client_reference: differs from the request"],
      ["transaction.client_reference", undefined, "transaction.client_reference: differs from the request"],
      ["provenance.state_mode", "scenario", "provenance.state_mode: differs from the requested state mode"],
    ];
    for (const [path, value, expected] of cases) {
      assert.deepEqual(problemsOf(set(engineExample(), path, value)), [expected], path);
    }
  });

  it("rejects missing required fields, naming each path", () => {
    const required = [
      "decision_id", "policy", "policy_status", "transaction", "transaction.corridor", "feasibility", "feasibility.allowed",
      "totals", "totals.completed", "totals.completion_ratio", "totals.executed_usd", "totals.unrouted_env_usd",
      "totals.unrouted_amount_based_usd", "provenance", "provenance.state_mode", "provenance.values_provenance",
      "provenance.state_frame_sha256", "provenance.knowledge_sha256", "provenance.git_commit", "provenance.checkpoint",
      "allocations",
    ];
    for (const path of required) {
      const problems = problemsOf(set(engineExample(), path, undefined));
      assert.ok(problems.some((p) => p.startsWith(`${path}:`) || (path === "transaction" && p.startsWith("transaction"))), `${path}: ${problems.join("; ")}`);
    }
  });

  it("rejects wrong types and unknown enum values", () => {
    const cases: Array<[string, unknown]> = [
      ["decision_id", ""],
      ["decision_id", 1],
      ["policy", "Waterfall"],
      ["policy", "constructor"],
      ["policy_status", "beta"],
      ["feasibility.allowed", "true"],
      ["totals.completed", 1],
      ["totals.completion_ratio", "1.0"],
      ["totals.executed_usd", null],
      ["metrics", []],
      ["metrics.reward_env", "x"],
      ["metrics.risk_term", {}],
      ["provenance.state_mode", "historicalReplay"],
      ["provenance.values_provenance", "real"],
      ["provenance.checkpoint", { checkpoint_id: "x" }],
      ["provenance.checkpoint", "abc"],
      ["allocations", {}],
    ];
    for (const [path, value] of cases) {
      const problems = problemsOf(set(engineExample(), path, value));
      assert.equal(problems.length, 1, `${path}=${JSON.stringify(value)}: ${problems.join("; ")}`);
      assert.ok(problems[0]!.startsWith(path), `${path}: ${problems[0]}`);
    }
  });

  it("rejects bad allocation entries and repeated slots", () => {
    const allocation = (engineExample().allocations as Array<Record<string, unknown>>)[0]!;
    const cases: Array<[unknown[], string[]]> = [
      [["x"], ["allocations[0]: must be an object"]],
      [[{ ...allocation, slot: -1 }], ["allocations[0].slot: must be a whole number"]],
      [[{ ...allocation, slot: 1.5 }], ["allocations[0].slot: must be a whole number"]],
      [[{ ...allocation, bridge_uid: "" }], ["allocations[0].bridge_uid: must be a non-empty string"]],
      [[{ ...allocation, amount_executed_usd: "150000" }], ["allocations[0].amount_executed_usd: must be a finite number"]],
      [[{ ...allocation, share_before_projection: "0.5" }], ["allocations[0].share_before_projection: must be a finite number"]],
      [[{ ...allocation, risk: undefined }], ["allocations[0].risk: must be a finite number"]],
      [[allocation, { ...allocation }], ["allocations[1].slot: is repeated"]],
    ];
    for (const [allocations, expected] of cases) {
      assert.deepEqual(problemsOf(set(engineExample(), "allocations", allocations)), expected);
    }
  });

  it("reports every problem at once, by path, without values", () => {
    const body = engineExample();
    set(body, "decision_id", "secret-looking-value-1");
    set(body, "decision_id", undefined);
    set(body, "policy_status", "secret-looking-value-2");
    set(body, "totals.completed", "secret-looking-value-3");
    const problems = problemsOf(body);
    assert.deepEqual(problems, ["decision_id: must be a non-empty string", "policy_status: has an unknown value", "totals.completed: must be a boolean"]);
    assert.doesNotMatch(problems.join(" "), /secret-looking/);
  });

  it("rejects keys that collide when mapped to camelCase", () => {
    const body = engineExample();
    body.decisionId = "duplicate";
    assert.deepEqual(problemsOf(body), ["(keys): two keys map to the same camelCase name"]);
  });
});

describe("mapRouteResponse: immutability", () => {
  it("never mutates the engine response, which stays storable verbatim", () => {
    const body = deepFreeze(engineExample());
    const before = structuredClone(body);
    const mapped = mapRouteResponse(body, request()); // a frozen input would throw on any write
    assert.deepEqual(body, before);
    (mapped.decision.provenance as Record<string, unknown>).stateMode = "changed";
    (mapped.decision.allocations as Array<Record<string, unknown>>)[0]!.slot = 99;
    mapped.columns.allocations[0]!.slot = 99;
    assert.deepEqual(body, before);
  });

  it("doesn't mutate the request either", () => {
    const req = deepFreeze(request());
    assert.doesNotThrow(() => mapRouteResponse(engineExample(), req));
  });
});
