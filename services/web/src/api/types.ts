/*
 * API types for the parts of the Application API this client uses so far.
 * Source: docs/PHASE2_API_CONTRACT.md (approved v0.4, normative), §3.0 and §4.
 * The OpenAPI files in contracts/ are still DRAFT and were not used as the
 * source. Types for other endpoints are added with the screens that use them.
 *
 * These describe the wire format (camelCase, as the backend sends it). Screens
 * do not render these directly: a mapper turns them into UI display models.
 */

/** Contract §3.0. Only an analyst may request `ppoProjected`. */
export type Role = "viewer" | "analyst";

/** `GET /api/v1/auth/me`, HTTP 200 (contract §3.0). */
export type MeResponse = {
  userId: string;
  email: string;
  role: Role;
  authMode: "dev";
  permissions: { experimentalPolicies: boolean };
};

/**
 * Error `code` values in the contract's §4 table, plus the two this client
 * raises itself (see ApiError). At run time an unknown code is handled by its
 * HTTP status and never rejected (contract §1), so `ApiError.code` is a string.
 */
export const CONTRACT_ERROR_CODES = [
  "MALFORMED_REQUEST",
  "UNAUTHENTICATED",
  "FORBIDDEN_POLICY",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "DECISION_MISMATCH",
  "POLICY_DISABLED",
  "TRANSACTION_FAILED",
  "VALIDATION_ERROR",
  "UNSUPPORTED_CORRIDOR",
  "INVALID_AMOUNT",
  "DATE_OUT_OF_RANGE",
  "DATE_IN_GAP_BUFFER",
  "UNKNOWN_SCENARIO",
  "STATE_VENUE_MISMATCH",
  "INVALID_STATE_VALUE",
  "POLICY_UNAVAILABLE_FOR_STATE",
  "INTERNAL_ERROR",
  "INFERENCE_ERROR",
  "INFERENCE_UNAVAILABLE",
  "ENGINE_BUSY",
  "ENGINE_TIMEOUT",
] as const;

/** `details` of an error body (contract §4). Everything in it is optional. */
export type ApiErrorDetails = {
  /** VALIDATION_ERROR: every problem at once. A form-level problem omits `field`. */
  errors?: { field?: string; message: string }[];
  /** Other 422 codes may name a single field. */
  field?: string;
  /** A failed POST /transactions that was saved (§3.2). */
  transactionId?: string;
  /** 503 INFERENCE_UNAVAILABLE: "NOT_READY" means the engine is still starting up. */
  cause?: string;
  [key: string]: unknown;
};

/** The one error body both APIs use; the app API spells the ID `requestId` (contract §4). */
export type ErrorEnvelope = {
  error: {
    code: string;
    message: string;
    details?: ApiErrorDetails;
    requestId?: string;
  };
};

/** Runtime check for an error body. Extra fields are ignored. */
export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return typeof code === "string" && typeof message === "string";
}

// ---------- shared shape-check helpers ----------

const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
const isNonNegative = (v: unknown): v is number => isNumber(v) && v >= 0;
const isWholeNumber = (v: unknown): v is number => isNonNegative(v) && Number.isSafeInteger(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const orNull = (check: (v: unknown) => boolean) => (v: unknown) => v === null || check(v);
const listOf = (check: (v: unknown) => boolean) => (v: unknown) => Array.isArray(v) && v.every(check);
const shape = (fields: Record<string, (v: unknown) => boolean>) => (v: unknown) =>
  isObject(v) && Object.entries(fields).every(([key, check]) => check(v[key]));

// ---------- POST /api/v1/comparisons and GET /api/v1/comparisons/:id (contract §3.6) ----------

/**
 * One policy's result in a comparison: the same Decision a routed transaction
 * has, with the parts the comparison puts side by side (metrics, whether the
 * capacity projection was applied, and each allocation's pre-projection share).
 * Reward, latency and risk are under placeholder weights (`rewardWeights.status`).
 */
export type ApiComparedDecision = Omit<ApiDecision, "allocations" | "diagnostics"> & {
  allocations: (ApiAllocation & { shareBeforeProjection: number | null })[];
  diagnostics: { regime: string; projectionApplied: boolean };
  metrics: {
    feeCostUsd: number;
    latencyTerm: number;
    riskTerm: number;
    rewardAmountBased: number;
    rewardWeights: { status: string };
  };
};

export type ApiComparison = {
  id: string;
  createdAt: string;
  createdBy?: string;
  transaction: {
    senderCountry: string;
    receiverCountry: string;
    corridor: string | null;
    amountUsd: number;
    simulationDate: string;
    clientReference: string | null;
  };
  /** The effective state the comparison used. Only `mode` is read; its other fields are shown from the results. */
  state: { mode: string; [key: string]: unknown };
  /** The resolved canonical policy list, in the order requested. */
  policies: string[];
  results: ApiComparedDecision[];
  skipped: { policy: string; code: string; message: string }[];
  sameState: boolean;
  note: string;
};

const isComparedDecisionShape = shape({
  decisionId: isString,
  policy: isString,
  policyStatus: isString,
  feasibility: shape({
    allowed: isBoolean,
    reason: orNull(isString),
    decisiveFactIds: listOf(isString),
    knowledgeVersion: isString,
  }),
  allocations: listOf(
    shape({
      bridgeUid: isString,
      dataSourceTag: isString,
      feePct: isNumber,
      liquidityUsd: isNumber,
      shareRequested: isNumber,
      amountRequestedUsd: isNumber,
      amountExecutedUsd: isNumber,
      amountClippedUsd: isNumber,
      shareBeforeProjection: orNull(isNumber),
    }),
  ),
  totals: shape({
    requestedUsd: isNumber,
    executedUsd: isNumber,
    unroutedAmountBasedUsd: isNumber,
    completionRatio: isNumber,
    completed: isBoolean,
    bridgesUsed: isNumber,
  }),
  diagnostics: shape({ regime: isString, projectionApplied: isBoolean }),
  metrics: shape({
    feeCostUsd: isNumber,
    latencyTerm: isNumber,
    riskTerm: isNumber,
    rewardAmountBased: isNumber,
    rewardWeights: shape({ status: isString }),
  }),
  provenance: shape({ stateMode: isString }),
  warnings: listOf(shape({ code: isString, message: isString })),
});

const isComparisonShape = shape({
  id: isString,
  createdAt: isString,
  transaction: shape({
    senderCountry: isString,
    receiverCountry: isString,
    corridor: orNull(isString),
    amountUsd: isNumber,
    simulationDate: isString,
    clientReference: orNull(isString),
  }),
  state: (v) => isObject(v) && isString(v.mode),
  policies: listOf(isString),
  results: listOf(isComparedDecisionShape),
  skipped: listOf(shape({ policy: isString, code: isString, message: isString })),
  sameState: isBoolean,
  note: isString,
});

/**
 * Strict check of a comparison. Beyond the field types it refuses a record that
 * contradicts itself, because the page lays its results side by side as fact:
 * - no policies, or a policy listed twice;
 * - a policy that has both a result and a skipped entry, neither, or twice;
 * - a result or skipped entry for a policy that wasn't requested, or results that
 *   aren't in the order of `policies` (the page shows them in that order);
 * - a result whose own `policy` isn't the one it stands for;
 * - `sameState` not true (contract §3.6: every policy ran on one state);
 * - a corridor where nothing ran, or none where something did.
 * Unknown extra fields are ignored (contract §1).
 */
export function isApiComparison(value: unknown): value is ApiComparison {
  if (!isComparisonShape(value)) return false;
  const c = value as unknown as ApiComparison;
  if (c.policies.length === 0 || new Set(c.policies).size !== c.policies.length) return false;
  if (c.sameState !== true) return false;

  const ran = c.results.map((r) => r.policy);
  const skipped = c.skipped.map((s) => s.policy);
  if (new Set(ran).size !== ran.length || new Set(skipped).size !== skipped.length) return false;
  if (ran.some((p) => skipped.includes(p))) return false;
  if (ran.length + skipped.length !== c.policies.length) return false;
  if (![...ran, ...skipped].every((p) => c.policies.includes(p))) return false;
  // Results follow the order of `policies`.
  if (c.policies.filter((p) => ran.includes(p)).join("\u0000") !== ran.join("\u0000")) return false;

  return c.results.length === 0 ? c.transaction.corridor === null : c.transaction.corridor !== null;
}

// ---------- GET /api/v1/replay/calendar (contract §2.6, §3.1) ----------

/**
 * The dates the engine accepts. `excludedRanges` lists every range it rejects
 * (the data's own ends and 30 days either side of each split boundary), and
 * `start` / `end` bound the data. Dates are `YYYY-MM-DD`. The body also has the
 * splits, the gap-buffer length and a note; the monitor reads none of them.
 */
export type ApiCalendar = {
  start: string;
  end: string;
  excludedRanges: { start: string; end: string }[];
};

/** YYYY-MM-DD naming a real calendar day. */
export function isCalendarDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const isCalendarShape = shape({
  start: isCalendarDay,
  end: isCalendarDay,
  excludedRanges: listOf(shape({ start: isCalendarDay, end: isCalendarDay })),
});

/**
 * Strict check: real dates, `start` not after `end`, and every excluded range
 * well-formed (its start not after its end). A calendar that contradicts
 * itself is refused, because the default date is chosen from it.
 */
export function isApiCalendar(value: unknown): value is ApiCalendar {
  if (!isCalendarShape(value)) return false;
  const calendar = value as unknown as ApiCalendar;
  return calendar.start <= calendar.end && calendar.excludedRanges.every((r) => r.start <= r.end);
}

// ---------- GET /api/v1/state (contract §2.5, §3.7) ----------

/**
 * One corridor's simulated state on one date. `history` (only with
 * `includeHistory=true`, which the monitor doesn't ask for) is not typed or
 * read. `congestion` is a raw number with no stated scale; `feePct` is a
 * fraction; `corridorRisk` and `baselineCostPct` are shown as the API gives them.
 */
export type ApiState = {
  corridor: string;
  state: { mode: string; date: string; split: string; scenarioId: string | null };
  corridorRisk: number;
  baselineCostPct: number;
  venues: {
    slot: number;
    bridgeUid: string;
    feePct: number;
    liquidityUsd: number;
    congestion: number;
    dataSourceTag: string;
    valuesProvenance: string;
  }[];
  warnings: { code: string; message: string }[];
};

const isStateShape = shape({
  corridor: isString,
  state: shape({ mode: isString, date: isCalendarDay, split: isString, scenarioId: orNull(isString) }),
  corridorRisk: isNonNegative,
  baselineCostPct: isNumber,
  venues: listOf(
    shape({
      slot: isWholeNumber,
      bridgeUid: isString,
      feePct: isNonNegative,
      liquidityUsd: isNonNegative,
      congestion: isNonNegative,
      dataSourceTag: isString,
      valuesProvenance: isString,
    }),
  ),
  warnings: listOf(shape({ code: isString, message: isString })),
});

/**
 * Strict check: the field types, no negative liquidity, congestion, fee or
 * risk, a real date, and no repeated venue or slot (each is a row). A state
 * with no venues is accepted and shown as such. Unknown extra fields are
 * ignored (contract §1).
 */
export function isApiState(value: unknown): value is ApiState {
  if (!isStateShape(value)) return false;
  const s = value as unknown as ApiState;
  const ids = s.venues.map((v) => v.bridgeUid);
  const slots = s.venues.map((v) => v.slot);
  return new Set(ids).size === ids.length && new Set(slots).size === slots.length;
}

// ---------- GET /api/v1/scenarios and GET /api/v1/meta (contract §3.1, §3.9) ----------

/**
 * The scenarios the New Transaction form offers. The body also carries each
 * scenario's multipliers and a note; the form uses neither, so neither is
 * required here. Extra fields are ignored (contract §1).
 */
export type ApiScenarios = { scenarios: { scenarioId: string; description: string }[] };

const isScenariosShape = shape({ scenarios: listOf(shape({ scenarioId: isString, description: isString })) });

/** Strict check: each scenario has an ID and a description, and no ID is repeated (it is the option's key). */
export function isApiScenarios(value: unknown): value is ApiScenarios {
  if (!isScenariosShape(value)) return false;
  const ids = (value as unknown as ApiScenarios).scenarios.map((s) => s.scenarioId);
  return new Set(ids).size === ids.length;
}

/**
 * The part of `/meta` the form reads: which policies exist and whether each is
 * enabled. `disabledReason` is present when a policy is disabled. The rest of
 * the body (versions, hashes, reward weights) is not read here.
 */
export type ApiMetaPolicies = {
  policies: { policy: string; status: string; enabled: boolean; disabledReason?: string }[];
};

const isMetaShape = shape({
  policies: listOf(
    (p) =>
      shape({ policy: isString, status: isString, enabled: isBoolean })(p) &&
      (!Object.hasOwn(p as object, "disabledReason") || isString((p as { disabledReason: unknown }).disabledReason)),
  ),
});

/** Strict check: at least one policy, each with a tier and an enabled flag, none repeated. */
export function isApiMetaPolicies(value: unknown): value is ApiMetaPolicies {
  if (!isMetaShape(value)) return false;
  const policies = (value as unknown as ApiMetaPolicies).policies.map((p) => p.policy);
  return policies.length > 0 && new Set(policies).size === policies.length;
}

// ---------- GET /api/v1/dashboard/summary (contract §3.8) ----------

/**
 * Aggregates over stored decisions. A count of `0` and a `null` rate or mean are
 * different things: null is "not available" (the denominator was zero), never zero.
 * `policy` is `string`: an unknown value is shown as written (contract §1).
 * `meanFeeCostPct` is already a percentage number (1.4 means 1.4%).
 */
export type ApiDashboardSummary = {
  window: { from: string | null; to: string | null };
  totals: { transactions: number; routed: number; failed: number; rejectedByFeasibility: number };
  byPolicy: {
    policy: string;
    count: number;
    allowedRouted: number;
    completionRate: number | null;
    meanRewardAmountBased: number | null;
    meanFeeCostPct: number | null;
    meanLatencyTerm: number | null;
    meanRiskTerm: number | null;
  }[];
  byCorridor: { corridor: string; routed: number; allowedRouted: number; completionRate: number | null }[];
  note: string;
};

const isCount = (v: unknown): v is number => isNumber(v) && Number.isSafeInteger(v) && v >= 0;
const isRate = (v: unknown): v is number => isNumber(v) && v >= 0 && v <= 1;

const isSummaryShape = shape({
  window: shape({ from: orNull(isString), to: orNull(isString) }),
  totals: shape({ transactions: isCount, routed: isCount, failed: isCount, rejectedByFeasibility: isCount }),
  byPolicy: listOf(
    shape({
      policy: isString,
      count: isCount,
      allowedRouted: isCount,
      completionRate: orNull(isRate),
      meanRewardAmountBased: orNull(isNumber),
      meanFeeCostPct: orNull(isNonNegative),
      meanLatencyTerm: orNull(isNumber),
      meanRiskTerm: orNull(isNumber),
    }),
  ),
  byCorridor: listOf(
    shape({ corridor: isString, routed: isCount, allowedRouted: isCount, completionRate: orNull(isRate) }),
  ),
  note: isString,
});

/**
 * Strict runtime check of the summary. Beyond the field types it refuses a
 * summary that contradicts itself, because the page would show it as fact:
 * - routed + failed is not the transaction total, or more were rejected than routed;
 * - a group has more allowed-routed decisions than requests (policy) or routed ones (corridor);
 * - a completion rate where nothing was allowed (the contract makes it null), or none where something was;
 * - a mean where nothing was allowed;
 * - a policy or corridor listed twice.
 * Unknown extra fields are ignored (contract §1).
 */
export function isApiDashboardSummary(value: unknown): value is ApiDashboardSummary {
  if (!isSummaryShape(value)) return false;
  const s = value as unknown as ApiDashboardSummary;
  if (s.totals.routed + s.totals.failed !== s.totals.transactions) return false;
  if (s.totals.rejectedByFeasibility > s.totals.routed) return false;

  const policies = s.byPolicy.map((p) => p.policy);
  const corridors = s.byCorridor.map((c) => c.corridor);
  if (new Set(policies).size !== policies.length || new Set(corridors).size !== corridors.length) return false;

  const rateAgrees = (allowed: number, rate: number | null) => (allowed === 0 ? rate === null : rate !== null);
  const policiesOk = s.byPolicy.every(
    (p) =>
      p.allowedRouted <= p.count &&
      rateAgrees(p.allowedRouted, p.completionRate) &&
      (p.allowedRouted > 0 ||
        (p.meanRewardAmountBased === null &&
          p.meanFeeCostPct === null &&
          p.meanLatencyTerm === null &&
          p.meanRiskTerm === null)),
  );
  const corridorsOk = s.byCorridor.every(
    (c) => c.allowedRouted <= c.routed && rateAgrees(c.allowedRouted, c.completionRate),
  );
  return policiesOk && corridorsOk;
}

// ---------- GET /api/v1/network (contract §2.3, §3.1) ----------

/**
 * The supported corridors and their venues: static reference data. `feePct` is
 * a fraction (0.015 is 1.5%) and `baselineCapacityUsd` is reference metadata,
 * not live liquidity. `dataSourceTag` and the provenance are `string`: an
 * unknown value is shown as written (contract §1).
 */
export type ApiNetwork = {
  corridors: {
    corridor: string;
    senderCountry: string;
    receiverCountry: string;
    venues: {
      slot: number;
      bridgeUid: string;
      feePct: number;
      baselineCapacityUsd: number;
      dataSourceTag: string;
    }[];
  }[];
  maxSingleTransferUsd: number;
  maxSingleTransferProvenance: string;
};

const isNetworkShape = shape({
  corridors: listOf(
    shape({
      corridor: isString,
      senderCountry: isString,
      receiverCountry: isString,
      venues: listOf(
        shape({
          slot: isWholeNumber,
          bridgeUid: isString,
          feePct: isNonNegative,
          baselineCapacityUsd: isNonNegative,
          dataSourceTag: isString,
        }),
      ),
    }),
  ),
  maxSingleTransferUsd: isNonNegative,
  maxSingleTransferProvenance: isString,
});

/**
 * Strict runtime check of the network body. Beyond the field types it refuses
 * what the screen cannot show faithfully: a negative or non-finite fee or
 * capacity, a slot that isn't a whole number, and a repeated corridor or venue
 * ID (each is a row key). Unknown extra fields are ignored (contract §1).
 */
export function isApiNetwork(value: unknown): value is ApiNetwork {
  if (!isNetworkShape(value)) return false;
  const network = value as unknown as ApiNetwork;
  const corridors = network.corridors.map((c) => c.corridor);
  const venues = network.corridors.flatMap((c) => c.venues.map((v) => v.bridgeUid));
  return new Set(corridors).size === corridors.length && new Set(venues).size === venues.length;
}

// ---------- GET /api/v1/transactions/:id (contract §3.4) ----------

/**
 * The fields of one stored transaction that the Transaction Detail screen
 * reads (contract §3.2 / §3.4). The backend sends more (metrics, provenance
 * details, allocation congestion and risk, `createdBy`); those are neither
 * typed nor required here, and unknown fields are ignored (contract §1).
 * As in the list, enum fields are `string`: an unknown value is handled
 * generically, never a reason to reject the response.
 *
 * A failed transaction has `status: "failed"`, `decision: null`, `corridor: null`
 * and a `failure`; it carries no policy and no state mode of its own.
 */
export type ApiAllocation = {
  bridgeUid: string;
  dataSourceTag: string;
  feePct: number;
  liquidityUsd: number;
  shareRequested: number;
  amountRequestedUsd: number;
  amountExecutedUsd: number;
  amountClippedUsd: number;
};

export type ApiDecision = {
  decisionId: string;
  policy: string;
  policyStatus: string;
  feasibility: { allowed: boolean; reason: string | null; decisiveFactIds: string[]; knowledgeVersion: string };
  allocations: ApiAllocation[];
  totals: {
    requestedUsd: number;
    executedUsd: number;
    unroutedAmountBasedUsd: number;
    completionRatio: number;
    completed: boolean;
    bridgesUsed: number;
  };
  diagnostics: { regime: string };
  provenance: { stateMode: string };
  warnings: { code: string; message: string }[];
};

export type TransactionRecord = {
  id: string;
  createdAt: string;
  status: string;
  transaction: {
    senderCountry: string;
    receiverCountry: string;
    corridor: string | null;
    amountUsd: number;
    simulationDate: string;
    clientReference: string | null;
  };
  failure: { code: string; message: string } | null;
  decision: ApiDecision | null;
};

const isApiDecision = shape({
  decisionId: isString,
  policy: isString,
  policyStatus: isString,
  feasibility: shape({
    allowed: isBoolean,
    reason: orNull(isString),
    decisiveFactIds: listOf(isString),
    knowledgeVersion: isString,
  }),
  allocations: listOf(
    shape({
      bridgeUid: isString,
      dataSourceTag: isString,
      feePct: isNumber,
      liquidityUsd: isNumber,
      shareRequested: isNumber,
      amountRequestedUsd: isNumber,
      amountExecutedUsd: isNumber,
      amountClippedUsd: isNumber,
    }),
  ),
  totals: shape({
    requestedUsd: isNumber,
    executedUsd: isNumber,
    unroutedAmountBasedUsd: isNumber,
    completionRatio: isNumber,
    completed: isBoolean,
    bridgesUsed: isNumber,
  }),
  diagnostics: shape({ regime: isString }),
  provenance: shape({ stateMode: isString }),
  warnings: listOf(shape({ code: isString, message: isString })),
});

const isRecordShape = shape({
  id: isString,
  createdAt: isString,
  status: isString,
  transaction: shape({
    senderCountry: isString,
    receiverCountry: isString,
    corridor: orNull(isString),
    amountUsd: isNumber,
    simulationDate: isString,
    clientReference: orNull(isString),
  }),
  failure: orNull(shape({ code: isString, message: isString })),
  decision: orNull(isApiDecision),
});

/** Runtime check of what the detail screen reads. A routed transaction without a decision is not a valid record. */
export function isTransactionRecord(value: unknown): value is TransactionRecord {
  if (!isRecordShape(value)) return false;
  const record = value as unknown as TransactionRecord;
  return record.status === "failed" || record.decision !== null;
}

// ---------- GET /api/v1/transactions/:id/explanation (contract §3.5) ----------

/** The camelCase `/v1/explain` body plus `transactionId`. `semanticContext` is always null in v1 and is not read. */
export type ApiExplanation = {
  transactionId: string;
  decisionId: string;
  policy: string;
  summary: string;
  feasibility: {
    allowed: boolean;
    reason: string | null;
    activeFacts: {
      factId: string;
      ruleType: string;
      value: unknown;
      provenanceTag: string;
      verified: boolean;
      source: string;
    }[];
    provider: string;
  };
  venueExplanations: { bridgeUid: string; outcome: string; reasonCode: string; text: string }[];
  policyNotes: string[];
  limitations: string[];
};

const isExplanationShape = shape({
  transactionId: isString,
  decisionId: isString,
  policy: isString,
  summary: isString,
  feasibility: shape({
    allowed: isBoolean,
    reason: orNull(isString),
    // `value` has no type in the contract; it only has to be present.
    activeFacts: listOf(
      (fact) =>
        isObject(fact) &&
        Object.hasOwn(fact, "value") &&
        isString(fact.factId) &&
        isString(fact.ruleType) &&
        isString(fact.provenanceTag) &&
        isBoolean(fact.verified) &&
        isString(fact.source),
    ),
    provider: isString,
  }),
  venueExplanations: listOf(shape({ bridgeUid: isString, outcome: isString, reasonCode: isString, text: isString })),
  policyNotes: listOf(isString),
  limitations: listOf(isString),
});

export function isApiExplanation(value: unknown): value is ApiExplanation {
  return isExplanationShape(value);
}

// ---------- GET /api/v1/transactions (contract §3.3) ----------

/**
 * One row of the history list (contract §3.3). For a `failed` transaction the
 * fields that come from a decision (`corridor`, `policyStatus`, `allowed`,
 * `completed`, `completionRatio`, `executedUsd`, `rewardAmountBased`) are null;
 * `policy` is then the requested policy.
 *
 * Enum fields are typed `string` on purpose: at run time a consumer meets an
 * unknown value generically and never rejects the response for it (contract §1).
 * Documented values: policy `waterfall | cheapestFeasible | ppoProjected`;
 * policyStatus `default | baseline | experimental`; status `routed | failed`;
 * stateMode `historicalReplay | scenario | explicit`.
 */
export type TransactionSummary = {
  id: string;
  createdAt: string;
  createdBy?: string;
  corridor: string | null;
  amountUsd: number;
  simulationDate: string;
  stateMode: string;
  policy: string;
  policyStatus: string | null;
  status: string;
  allowed: boolean | null;
  completed: boolean | null;
  completionRatio: number | null;
  executedUsd: number | null;
  rewardAmountBased?: number | null;
};

export type TransactionPage = {
  items: TransactionSummary[];
  page: number;
  pageSize: number;
  total: number;
};

const SUMMARY_FIELDS: Record<string, (v: unknown) => boolean> = {
  id: isString,
  createdAt: isString,
  corridor: orNull(isString),
  amountUsd: isNumber,
  simulationDate: isString,
  stateMode: isString,
  policy: isString,
  policyStatus: orNull(isString),
  status: isString,
  allowed: orNull(isBoolean),
  completed: orNull(isBoolean),
  completionRatio: orNull(isNumber),
  executedUsd: orNull(isNumber),
};

/**
 * Runtime check of the fields the History screen reads. `createdBy` and
 * `rewardAmountBased` are not used by it, so they are not required here; extra
 * fields are ignored (contract §1).
 */
export function isTransactionPage(value: unknown): value is TransactionPage {
  if (typeof value !== "object" || value === null) return false;
  const page = value as Record<string, unknown>;
  if (!Array.isArray(page.items)) return false;
  if (!Number.isSafeInteger(page.page) || !Number.isSafeInteger(page.pageSize) || !Number.isSafeInteger(page.total)) {
    return false;
  }
  return page.items.every(
    (row) =>
      typeof row === "object" &&
      row !== null &&
      Object.entries(SUMMARY_FIELDS).every(([key, check]) => check((row as Record<string, unknown>)[key])),
  );
}

/**
 * Runtime check for a /auth/me body. Unknown fields are ignored (contract §1),
 * but a body the UI can't rely on (no email, an unknown role) is not accepted
 * as a session.
 */
export function isMeResponse(value: unknown): value is MeResponse {
  if (typeof value !== "object" || value === null) return false;
  const me = value as Partial<Record<keyof MeResponse, unknown>>;
  return (
    typeof me.userId === "string" &&
    typeof me.email === "string" &&
    (me.role === "viewer" || me.role === "analyst") &&
    typeof me.permissions === "object" &&
    me.permissions !== null
  );
}
