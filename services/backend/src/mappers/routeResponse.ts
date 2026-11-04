import type { Policy, PolicyStatus, ValuesProvenance } from "@prisma/client";
import { InferenceError } from "../inferenceClient/errors.js";
import type { StateSpec, TransactionRequest } from "../validation/transactionRequest.js";
import { KeyCollisionError, toCamelCase } from "./camelCase.js";

// The inference RouteResponse (API contract §2.8) as the Application API
// `transaction` and `decision` (§3.2), plus the normalised column values for
// RoutingDecision and Allocation (§6.3). Values are copied, never computed:
// no allocation, total, metric or feasibility is derived here.
//
// - Mapping: keys become camelCase (toCamelCase), so unknown fields are kept
//   (§1: producers may add optional fields). `decision` is the response
//   without `transaction`, which becomes the top-level `transaction` (§3.2).
// - Enum values mapped (§3.2): policy (cheapest_feasible -> cheapestFeasible,
//   ppo_projected -> ppoProjected) and provenance.state_mode
//   (historical_replay -> historicalReplay). Everything else is unchanged:
//   IDs, codes, tags, bridge_uid, values_provenance, split, regime,
//   policy_status, warning codes, reason strings and scenario_id (its
//   convention is pending confirmation; see routeRequest.ts).
// - Validation covers only what persistence and the response rely on; see
//   the field list in validate(). Anything missing, of the wrong type or
//   inconsistent with the request throws InvalidRouteResponseError, a 502
//   INFERENCE_ERROR that names field paths (for logs), never values.
// - The input is never mutated, so the caller can store it verbatim as
//   engineResponse (§6.1).
//
// - metrics is required on every 200, including a regulatory rejection, with
//   every §2.8 field a finite number (reward_weights: three lambda_* numbers
//   and status exactly "placeholder"). Anything else is an invalid body.
//   Calibrated weights would need a contract change and this check updated.
//
// ASSUMPTIONS about fields §2.8 doesn't pin down (to confirm with Dev A):
// - provenance.checkpoint is null or an object with a sha256 string (the
//   §2.2 checkpoint shape).
// - transaction echoes the request: same sender, receiver, amount and
//   client_reference (null when none was sent), and simulation_date equal to
//   state.date or state.reference_date (§2.8). provenance.state_mode equals
//   the requested mode.
// - transaction.corridor is a non-empty string on every 200 response.
// - allocation slots are whole numbers, unique within a response (the
//   Allocation table's unique key).

export const POLICY_FROM_ENGINE: Readonly<Record<string, Policy>> = Object.freeze({
  waterfall: "waterfall",
  cheapest_feasible: "cheapestFeasible",
  ppo_projected: "ppoProjected",
});

export const STATE_MODE_FROM_ENGINE: Readonly<Record<string, StateSpec["mode"]>> = Object.freeze({
  historical_replay: "historicalReplay",
  scenario: "scenario",
  explicit: "explicit",
});

const POLICY_STATUSES: readonly PolicyStatus[] = ["default", "baseline", "experimental"];

// §2.8 metrics fields that have no column but must still be present, finite
// numbers. The stored ones (fee_cost_usd, latency_term, risk_term, reward_env,
// reward_amount_based) are read in validate().
const METRIC_NUMBERS_NOT_STORED = ["baseline_cost_pct", "cost_term", "unrouted_term_env", "unrouted_term_amount_based"];
const REWARD_WEIGHT_NUMBERS = ["lambda_latency", "lambda_risk", "lambda_unrouted"];
/** The only reward_weights.status §2.8 allows: the weights are uncalibrated. */
export const REWARD_WEIGHTS_STATUS = "placeholder";
const VALUES_PROVENANCES: readonly ValuesProvenance[] = [
  "synthetic_simulation",
  "synthetic_scenario",
  "user_supplied_synthetic",
];

export interface DecisionColumns {
  decisionId: string;
  policy: Policy;
  policyStatus: PolicyStatus;
  allowed: boolean;
  completed: boolean;
  completionRatio: number;
  executedUsd: number;
  unroutedEnvUsd: number;
  unroutedAmountBasedUsd: number;
  // Always set for new rows (metrics is required, §2.8). The database columns
  // stay nullable for rows saved before this rule.
  rewardEnv: number;
  rewardAmountBased: number;
  latencyTerm: number;
  riskTerm: number;
  /** metrics.fee_cost_usd, copied (§2.8, §3.8). */
  feeCostUsd: number;
  valuesProvenance: ValuesProvenance;
  stateFrameSha256: string;
  checkpointSha256: string | null;
  knowledgeSha256: string;
  gitCommit: string;
}

export interface AllocationColumns {
  slot: number;
  bridgeUid: string;
  shareRequested: number;
  amountRequestedUsd: number;
  amountExecutedUsd: number;
  amountClippedUsd: number;
  liquidityUsd: number;
  congestion: number;
  risk: number;
  shareBeforeProjection: number | null;
}

export interface MappedRouteResponse {
  /** §3.2 response `transaction`. */
  transaction: Record<string, unknown>;
  /** §3.2 response `decision`. */
  decision: Record<string, unknown>;
  columns: {
    /** TransactionRequest.corridor, from the engine (§6.3). */
    corridor: string;
    decision: DecisionColumns;
    allocations: AllocationColumns[];
  };
}

export class InvalidRouteResponseError extends InferenceError {
  /** Field paths and what was wrong, for logs. Never contains values. */
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(502, "INFERENCE_ERROR", "The inference service returned an invalid response.", "invalid_response", {
      upstreamStatus: 200,
    });
    this.name = "InvalidRouteResponseError";
    this.problems = problems;
  }
}

type JsonObject = Record<string, unknown>;

/**
 * Validates `body` (a /v1/route 200 body) against the request that produced
 * it, and maps it. Throws InvalidRouteResponseError when it can't be used.
 */
export function mapRouteResponse(body: JsonObject, request: TransactionRequest): MappedRouteResponse {
  const columns = validate(body, request);

  let transaction: unknown;
  let decision: unknown;
  try {
    const { transaction: engineTransaction, ...rest } = body;
    transaction = toCamelCase(engineTransaction);
    decision = toCamelCase(rest);
  } catch (error) {
    if (error instanceof KeyCollisionError) {
      throw new InvalidRouteResponseError(["(keys): two keys map to the same camelCase name"]);
    }
    throw error;
  }
  const mapped = decision as JsonObject;
  mapped.policy = columns.decision.policy;
  const provenance = mapped.provenance as JsonObject;
  provenance.stateMode = STATE_MODE_FROM_ENGINE[(body.provenance as JsonObject).state_mode as string];

  return { transaction: transaction as JsonObject, decision: mapped, columns };
}

function validate(body: JsonObject, request: TransactionRequest): MappedRouteResponse["columns"] {
  const problems: string[] = [];
  const problem = (path: string, what: string): undefined => {
    problems.push(`${path}: ${what}`);
    return undefined;
  };
  const object = (value: unknown, path: string): JsonObject | undefined =>
    isObject(value) ? value : problem(path, "must be an object");
  const string = (value: unknown, path: string): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : problem(path, "must be a non-empty string");
  const number = (value: unknown, path: string): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : problem(path, "must be a finite number");
  const nullableNumber = (value: unknown, path: string): number | null | undefined =>
    value === null ? null : number(value, path);
  const boolean = (value: unknown, path: string): boolean | undefined =>
    typeof value === "boolean" ? value : problem(path, "must be a boolean");
  const oneOf = <T extends string>(value: unknown, allowed: readonly T[], path: string): T | undefined =>
    typeof value === "string" && (allowed as readonly string[]).includes(value)
      ? (value as T)
      : problem(path, "has an unknown value");

  // Top level.
  const decisionId = string(body.decision_id, "decision_id");
  const enginePolicy = body.policy;
  let policy: Policy | undefined;
  if (typeof enginePolicy === "string" && Object.hasOwn(POLICY_FROM_ENGINE, enginePolicy)) {
    policy = POLICY_FROM_ENGINE[enginePolicy];
    if (policy !== request.policy) problem("policy", "differs from the requested policy");
  } else {
    problem("policy", "has an unknown value");
  }
  const policyStatus = oneOf(body.policy_status, POLICY_STATUSES, "policy_status");

  // transaction: the request echoed back, plus corridor and simulation_date.
  let corridor: string | undefined;
  const transaction = object(body.transaction, "transaction");
  if (transaction) {
    corridor = string(transaction.corridor, "transaction.corridor");
    const simulationDate = request.state.mode === "explicit" ? request.state.referenceDate : request.state.date;
    const echoes: Array<[string, unknown]> = [
      ["sender_country", request.senderCountry],
      ["receiver_country", request.receiverCountry],
      ["amount_usd", request.amountUsd],
      ["simulation_date", simulationDate],
      ["client_reference", request.clientReference],
    ];
    for (const [key, expected] of echoes) {
      if (transaction[key] !== expected) problem(`transaction.${key}`, "differs from the request");
    }
  }

  const feasibility = object(body.feasibility, "feasibility");
  const allowed = feasibility && boolean(feasibility.allowed, "feasibility.allowed");

  const totals = object(body.totals, "totals");
  const completed = totals && boolean(totals.completed, "totals.completed");
  const completionRatio = totals && number(totals.completion_ratio, "totals.completion_ratio");
  const executedUsd = totals && number(totals.executed_usd, "totals.executed_usd");
  const unroutedEnvUsd = totals && number(totals.unrouted_env_usd, "totals.unrouted_env_usd");
  const unroutedAmountBasedUsd = totals && number(totals.unrouted_amount_based_usd, "totals.unrouted_amount_based_usd");

  // metrics: always present, every field non-null, including on a regulatory
  // rejection (§2.8). Missing, null or mistyped values make the body invalid.
  let rewardEnv: number | undefined;
  let rewardAmountBased: number | undefined;
  let latencyTerm: number | undefined;
  let riskTerm: number | undefined;
  let feeCostUsd: number | undefined;
  const metrics = object(body.metrics, "metrics");
  if (metrics) {
    const metric = (key: string) => number(metrics[key], `metrics.${key}`);
    feeCostUsd = metric("fee_cost_usd");
    latencyTerm = metric("latency_term");
    riskTerm = metric("risk_term");
    rewardEnv = metric("reward_env");
    rewardAmountBased = metric("reward_amount_based");
    // Checked, not stored as columns: they stay in engineResponse and decision.
    for (const key of METRIC_NUMBERS_NOT_STORED) metric(key);
    const weights = object(metrics.reward_weights, "metrics.reward_weights");
    if (weights) {
      for (const key of REWARD_WEIGHT_NUMBERS) number(weights[key], `metrics.reward_weights.${key}`);
      // §2.8: "The weights are always included, with status: placeholder".
      if (weights.status !== REWARD_WEIGHTS_STATUS) problem("metrics.reward_weights.status", 'must be "placeholder"');
    }
  }

  const provenance = object(body.provenance, "provenance");
  let valuesProvenance: ValuesProvenance | undefined;
  let stateFrameSha256: string | undefined;
  let knowledgeSha256: string | undefined;
  let gitCommit: string | undefined;
  let checkpointSha256: string | null | undefined;
  if (provenance) {
    const mode = provenance.state_mode;
    if (typeof mode !== "string" || !Object.hasOwn(STATE_MODE_FROM_ENGINE, mode)) {
      problem("provenance.state_mode", "has an unknown value");
    } else if (STATE_MODE_FROM_ENGINE[mode] !== request.state.mode) {
      problem("provenance.state_mode", "differs from the requested state mode");
    }
    valuesProvenance = oneOf(provenance.values_provenance, VALUES_PROVENANCES, "provenance.values_provenance");
    stateFrameSha256 = string(provenance.state_frame_sha256, "provenance.state_frame_sha256");
    knowledgeSha256 = string(provenance.knowledge_sha256, "provenance.knowledge_sha256");
    gitCommit = string(provenance.git_commit, "provenance.git_commit");
    if (provenance.checkpoint === null) checkpointSha256 = null;
    else {
      const checkpoint = object(provenance.checkpoint, "provenance.checkpoint");
      checkpointSha256 = checkpoint && string(checkpoint.sha256, "provenance.checkpoint.sha256");
    }
  }

  // allocations: one column set per entry; slots unique.
  const allocations: AllocationColumns[] = [];
  if (!Array.isArray(body.allocations)) problem("allocations", "must be an array");
  else {
    const slots = new Set<number>();
    body.allocations.forEach((entry, i) => {
      const path = `allocations[${i}]`;
      const a = object(entry, path);
      if (!a) return;
      const slot =
        Number.isInteger(a.slot) && (a.slot as number) >= 0
          ? (a.slot as number)
          : problem(`${path}.slot`, "must be a whole number");
      if (slot !== undefined) {
        if (slots.has(slot)) problem(`${path}.slot`, "is repeated");
        slots.add(slot);
      }
      const columns = {
        slot,
        bridgeUid: string(a.bridge_uid, `${path}.bridge_uid`),
        shareRequested: number(a.share_requested, `${path}.share_requested`),
        amountRequestedUsd: number(a.amount_requested_usd, `${path}.amount_requested_usd`),
        amountExecutedUsd: number(a.amount_executed_usd, `${path}.amount_executed_usd`),
        amountClippedUsd: number(a.amount_clipped_usd, `${path}.amount_clipped_usd`),
        liquidityUsd: number(a.liquidity_usd, `${path}.liquidity_usd`),
        congestion: number(a.congestion, `${path}.congestion`),
        risk: number(a.risk, `${path}.risk`),
        shareBeforeProjection: nullableNumber(a.share_before_projection, `${path}.share_before_projection`),
      };
      if (Object.values(columns).every((v) => v !== undefined)) allocations.push(columns as AllocationColumns);
    });
  }

  if (problems.length > 0) throw new InvalidRouteResponseError(problems);
  return {
    corridor: corridor!,
    allocations,
    decision: {
      decisionId: decisionId!,
      policy: policy!,
      policyStatus: policyStatus!,
      allowed: allowed!,
      completed: completed!,
      completionRatio: completionRatio!,
      executedUsd: executedUsd!,
      unroutedEnvUsd: unroutedEnvUsd!,
      unroutedAmountBasedUsd: unroutedAmountBasedUsd!,
      rewardEnv: rewardEnv!,
      rewardAmountBased: rewardAmountBased!,
      latencyTerm: latencyTerm!,
      riskTerm: riskTerm!,
      feeCostUsd: feeCostUsd!,
      valuesProvenance: valuesProvenance!,
      stateFrameSha256: stateFrameSha256!,
      checkpointSha256: checkpointSha256!,
      knowledgeSha256: knowledgeSha256!,
      gitCommit: gitCommit!,
    },
  };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
