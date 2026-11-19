/*
 * PREVIEW ONLY — a stand-in for POST /api/v1/transactions. It decides nothing
 * the real engine decides: its liquidity, fees and rules are illustrative, and
 * every result it returns is labelled as a preview result by the page. Live
 * creation is blocked until the engine returns a decision ID, so nothing here
 * talks to the network.
 *
 * To integrate: replace `submitPreviewTransaction` with a call to the API
 * client that returns the same `SubmitResult`, and delete this file and
 * ./previewReference.ts. The page only depends on that one function.
 *
 * Outcomes follow the inputs, so each can be reached from the form:
 * - an amount over the cap is rejected by the feasibility rules (a result);
 * - a low-liquidity scenario or explicit state gives a partial completion;
 * - a date outside 2011-01-01..2025-09-30, an unknown scenario, a venue that
 *   isn't in the corridor, or a negative explicit value gives a 4xx error;
 * - `?mock=validation|busy|timeout|unavailable|notready|error` forces a failure.
 *   `notready` is the engine still starting up: a 503 INFERENCE_UNAVAILABLE with
 *   `details.cause: "NOT_READY"`.
 * Persisted 5xx failures carry `details.transactionId`; 4xx failures do not,
 * because nothing was saved. Nothing is retried.
 */
import type { AllocationView, DecisionView, TransactionDetailView, WarningView } from "../features/transactions/detailTypes";
import type { PolicyKey, PolicyTier } from "../features/transactions/types";
import type { ServerError, SubmitResult, TransactionPayload } from "../features/newTransaction/types";
import { PREVIEW_ENGINE_MODEL, PREVIEW_REFERENCE } from "./previewReference";

export const MOCK_FAILURES = ["validation", "busy", "timeout", "unavailable", "error", "notready"] as const;
export type MockFailure = (typeof MOCK_FAILURES)[number];

/** ?mock=<failure>, or null. Unknown values are ignored. */
export function readMockFailure(params: URLSearchParams): MockFailure | null {
  const value = params.get("mock") ?? "";
  return (MOCK_FAILURES as readonly string[]).includes(value) ? (value as MockFailure) : null;
}

export const MOCK_DELAY_MS = 700;

type SubmitOptions = {
  /** Forces this failure instead of computing a result. */
  failure?: MockFailure | null;
  delayMs?: number;
};

// ---------- small deterministic helpers ----------

let submissions = 0;

function fnv(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A stable stream of hex digits from a seed. */
function hexStream(seed: number) {
  let a = seed;
  return (n: number) =>
    Array.from({ length: n }, () => {
      a = (Math.imul(a ^ (a >>> 15), 0x2c1b3c6d) + 0x297a2d39) | 0;
      return ((a >>> 12) & 15).toString(16);
    }).join("");
}

function newIds(payload: TransactionPayload) {
  submissions += 1;
  const hex = hexStream(fnv(`${JSON.stringify(payload)}#${submissions}`));
  const uuid = `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
  return { uuid, requestId: `preview-${hex(12)}`, decisionId: `sha256:${hex(64)}` };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const DATE_MIN = PREVIEW_ENGINE_MODEL.dateRange.start;
const DATE_MAX = PREVIEW_ENGINE_MODEL.dateRange.end;

function error(status: number, code: string, message: string, requestId: string, details: ServerError["details"] = {}): SubmitResult {
  return { kind: "error", error: { status, code, message, details, requestId } };
}

// ---------- forced failures ----------

function forcedFailure(failure: MockFailure, payload: TransactionPayload): SubmitResult {
  const { uuid, requestId } = newIds(payload);
  switch (failure) {
    case "validation":
      return error(422, "VALIDATION_ERROR", "Request failed validation.", requestId, {
        errors: [
          { field: "amountUsd", message: "Preview validation message for the amount." },
          { message: "Preview validation message that belongs to no single field." },
        ],
      });
    case "busy":
      return error(503, "ENGINE_BUSY", "The routing engine is busy. Try again later.", requestId, { transactionId: uuid });
    case "timeout":
      return error(504, "ENGINE_TIMEOUT", "The routing engine did not answer in time.", requestId, { transactionId: uuid });
    case "unavailable":
      return error(503, "INFERENCE_UNAVAILABLE", "The inference service is unavailable.", requestId, { transactionId: uuid });
    case "notready":
      // The same 503 INFERENCE_UNAVAILABLE, with the optional `details.cause` the contract adds when the
      // engine answered NOT_READY (still starting up). It is persisted as failed, like the other 5xx ones.
      // No Retry-After is modelled: whether the backend forwards it is still an open question.
      return error(503, "INFERENCE_UNAVAILABLE", "The inference service is unavailable.", requestId, {
        transactionId: uuid,
        cause: "NOT_READY",
      });
    case "error":
      return error(502, "INFERENCE_ERROR", "The inference service returned an error.", requestId, { transactionId: uuid });
  }
}

// ---------- the stand-in engine ----------

const TIER: Record<PolicyKey, PolicyTier> = { waterfall: "default", cheapestFeasible: "baseline", ppoProjected: "experimental" };

function regimeFor(amount: number, liquidity: number[]): string {
  const cheapest = liquidity[0] ?? 0;
  if (amount > liquidity.reduce((s, l) => s + l, 0)) return "exceeds_combined";
  if (amount <= cheapest * 0.9) return "below_cheapest";
  if (amount <= cheapest * 1.1) return "near_boundary";
  return "splitting_needed";
}

function compute(payload: TransactionPayload): SubmitResult {
  const { uuid, requestId, decisionId } = newIds(payload);
  const reject = (status: number, code: string, message: string) => error(status, code, message, requestId);

  if (payload.policy === "ppoProjected") {
    return reject(409, "POLICY_DISABLED", "ppoProjected is disabled: no approved checkpoint configured.");
  }
  if (!(payload.amountUsd > 0) || !Number.isFinite(payload.amountUsd)) {
    return reject(422, "INVALID_AMOUNT", "The amount must be greater than 0 and finite.");
  }
  const corridor = PREVIEW_REFERENCE.corridors.find(
    (c) => c.senderCountry === payload.senderCountry && c.receiverCountry === payload.receiverCountry,
  );
  if (!corridor) return reject(422, "UNSUPPORTED_CORRIDOR", "This corridor is not supported.");

  const { state } = payload;
  const date = state.mode === "explicit" ? state.referenceDate : state.date;
  if (date < DATE_MIN || date > DATE_MAX) {
    return reject(422, "DATE_OUT_OF_RANGE", `The date ${date} is outside the available data.`);
  }

  // Venues in fee order, cheapest first. Slot order is kept for display.
  const byFee = [...corridor.venues].sort((a, b) => a.feePct - b.feePct);
  const cheapestUid = byFee[0]?.bridgeUid;
  let liquidityByUid: Record<string, number> = {};

  if (state.mode === "explicit") {
    const known = new Set(corridor.venues.map((v) => v.bridgeUid));
    const given = new Set(state.venues.map((v) => v.bridgeUid));
    if (given.size !== state.venues.length || state.venues.some((v) => !known.has(v.bridgeUid)) || given.size === 0) {
      return reject(422, "STATE_VENUE_MISMATCH", "The venues don't match the corridor's venues.");
    }
    if (state.venues.some((v) => v.liquidityUsd < 0 || v.congestion < 0)) {
      return reject(422, "INVALID_STATE_VALUE", "A liquidity or congestion value is not allowed.");
    }
    liquidityByUid = Object.fromEntries(state.venues.map((v) => [v.bridgeUid, v.liquidityUsd]));
  } else {
    const dayFactor = 0.5 + (fnv(date) % 50) / 100; // 0.50 to 0.99, so replay dates differ
    let liquidityMultiplier = 1;
    let cheapestMultiplier = 1;
    if (state.mode === "scenario") {
      const multipliers = PREVIEW_ENGINE_MODEL.scenarioMultipliers[state.scenarioId];
      if (!multipliers) return reject(422, "UNKNOWN_SCENARIO", `Unknown scenario "${state.scenarioId}".`);
      liquidityMultiplier = multipliers.liquidity;
      cheapestMultiplier = multipliers.cheapest;
    }
    for (const v of corridor.venues) {
      const base = PREVIEW_ENGINE_MODEL.baselineCapacityUsd[v.bridgeUid] ?? 0;
      liquidityByUid[v.bridgeUid] = round2(base * dayFactor * liquidityMultiplier * (v.bridgeUid === cheapestUid ? cheapestMultiplier : 1));
    }
  }

  const A = payload.amountUsd;
  const warnings: WarningView[] = [];
  if (corridor.corridor === "ARE->MEX") {
    warnings.push({ code: "SYNTHETIC_COST_ANCHOR", message: "The cost baseline for this corridor is a synthetic anchor." });
  }

  const detail = (decision: DecisionView, outcome: TransactionDetailView["outcome"]): SubmitResult => ({
    kind: "routed",
    transaction: {
      id: uuid,
      createdAt: new Date().toISOString(),
      status: "routed",
      outcome,
      corridor: corridor.corridor,
      senderCountry: corridor.senderCountry,
      receiverCountry: corridor.receiverCountry,
      amountUsd: A,
      simulationDate: date,
      stateMode: state.mode,
      policy: payload.policy,
      policyTier: TIER[payload.policy],
      clientReference: payload.clientReference ?? null,
      failure: null,
      decision,
    },
  });

  if (A > PREVIEW_REFERENCE.maxSingleTransferUsd) {
    return detail(
      {
        decisionId,
        feasibility: {
          allowed: false,
          reason: "Transaction amount exceeds single transfer policy limit.",
          decisiveFactIds: ["preview.single_transfer_cap"],
          knowledgeVersion: "preview",
        },
        allocations: [],
        totals: { requestedUsd: 0, executedUsd: 0, unroutedAmountBasedUsd: A, completionRatio: 0, completed: false, bridgesUsed: 0 },
        regime: regimeFor(A, byFee.map((v) => liquidityByUid[v.bridgeUid] ?? 0)),
        warnings,
      },
      "rejected",
    );
  }

  // Waterfall fills the cheapest venue first, never past what it holds.
  // Cheapest-feasible asks the cheapest venue for everything, and is clipped.
  let remaining = A;
  const requestedByUid: Record<string, number> = {};
  byFee.forEach((v, i) => {
    const held = liquidityByUid[v.bridgeUid] ?? 0;
    if (payload.policy === "cheapestFeasible") {
      requestedByUid[v.bridgeUid] = i === 0 ? A : 0;
    } else {
      const take = Math.min(remaining, held);
      requestedByUid[v.bridgeUid] = take;
      remaining = round2(remaining - take);
    }
  });

  const allocations: AllocationView[] = corridor.venues.map((v) => {
    const requested = requestedByUid[v.bridgeUid] ?? 0;
    const held = liquidityByUid[v.bridgeUid] ?? 0;
    const executed = Math.min(requested, held);
    return {
      bridgeUid: v.bridgeUid,
      dataSourceTag: v.dataSourceTag,
      feePct: v.feePct,
      liquidityUsd: held,
      shareRequested: requested / A,
      amountRequestedUsd: requested,
      amountExecutedUsd: executed,
      amountClippedUsd: round2(requested - executed),
    };
  });
  const executedUsd = round2(allocations.reduce((s, a) => s + a.amountExecutedUsd, 0));
  const completed = executedUsd >= A;
  const completionRatio = Math.min(1, executedUsd / A);
  if (!completed) {
    warnings.push({
      code: "PARTIAL_COMPLETION",
      message: `Executed ${(completionRatio * 100).toFixed(1)}% of the amount; the rest is unrouted.`,
    });
  }

  return detail(
    {
      decisionId,
      feasibility: { allowed: true, reason: null, decisiveFactIds: [], knowledgeVersion: "preview" },
      allocations,
      totals: {
        requestedUsd: round2(allocations.reduce((s, a) => s + a.amountRequestedUsd, 0)),
        executedUsd,
        unroutedAmountBasedUsd: Math.max(0, round2(A - executedUsd)),
        completionRatio,
        completed,
        bridgesUsed: allocations.filter((a) => a.amountExecutedUsd > 0).length,
      },
      regime: regimeFor(A, byFee.map((v) => liquidityByUid[v.bridgeUid] ?? 0)),
      warnings,
    },
    completed ? "completed" : "partial",
  );
}

/** Submits a transaction to the stand-in engine. Never retries. */
export async function submitPreviewTransaction(payload: TransactionPayload, options: SubmitOptions = {}): Promise<SubmitResult> {
  const delay = options.delayMs ?? MOCK_DELAY_MS;
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  return options.failure ? forcedFailure(options.failure, payload) : compute(payload);
}
