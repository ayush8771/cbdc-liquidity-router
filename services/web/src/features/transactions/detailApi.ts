/*
 * GET /api/v1/transactions/:id and GET /api/v1/transactions/:id/explanation
 * (contract §3.4, §3.5) for the desktop Transaction Detail. API bodies become
 * the display models the detail components already render (detailTypes.ts,
 * explanationTypes.ts). Nothing here recomputes a value.
 */
import { ApiError, INVALID_RESPONSE, type ApiClient } from "../../api/client";
import { isApiExplanation, isTransactionRecord, type ApiExplanation, type TransactionRecord } from "../../api/types";
import type { DataSourceTag, DecisionView, TransactionDetailView } from "./detailTypes";
import type { ExplanationView } from "./explanationTypes";
import { outcomeOf } from "./historyTypes";
import type { PolicyKey, PolicyTier, StateModeKey } from "./types";

/** The explanation is for a different transaction or decision than the one on screen. Raised by this client, not the server. */
export const EXPLANATION_MISMATCH = "EXPLANATION_MISMATCH";

const unreadable = () =>
  new ApiError({ status: 200, code: INVALID_RESPONSE, message: "The server's response could not be read." });

// ---------- the transaction ----------

/**
 * API record to display model.
 * - A routed transaction's policy, tier and state mode come from its decision
 *   (`decision.policy`, `decision.policyStatus`, `decision.provenance.stateMode`),
 *   and the regime from `decision.diagnostics.regime`.
 * - A failed transaction has no decision and carries neither a policy nor a
 *   state mode, so both are null and the screen shows "—". Nothing is guessed.
 * - Enum values pass through as they came (contract §1): an unknown value is
 *   shown as written by the components that print it.
 * - The outcome is derived the way the History derives it.
 */
export function mapTransactionRecord(record: TransactionRecord): TransactionDetailView {
  const failed = record.status === "failed";
  const decision = failed ? null : record.decision;
  const view: DecisionView | null = decision
    ? {
        decisionId: decision.decisionId,
        feasibility: {
          allowed: decision.feasibility.allowed,
          reason: decision.feasibility.reason,
          decisiveFactIds: decision.feasibility.decisiveFactIds,
          knowledgeVersion: decision.feasibility.knowledgeVersion,
        },
        allocations: decision.allocations.map((a) => ({
          bridgeUid: a.bridgeUid,
          dataSourceTag: a.dataSourceTag as DataSourceTag,
          feePct: a.feePct,
          liquidityUsd: a.liquidityUsd,
          shareRequested: a.shareRequested,
          amountRequestedUsd: a.amountRequestedUsd,
          amountExecutedUsd: a.amountExecutedUsd,
          amountClippedUsd: a.amountClippedUsd,
        })),
        totals: {
          requestedUsd: decision.totals.requestedUsd,
          executedUsd: decision.totals.executedUsd,
          unroutedAmountBasedUsd: decision.totals.unroutedAmountBasedUsd,
          completionRatio: decision.totals.completionRatio,
          completed: decision.totals.completed,
          bridgesUsed: decision.totals.bridgesUsed,
        },
        regime: decision.diagnostics.regime,
        warnings: decision.warnings.map((w) => ({ code: w.code, message: w.message })),
      }
    : null;

  return {
    id: record.id,
    createdAt: record.createdAt,
    status: failed ? "failed" : "routed",
    outcome: outcomeOf({
      status: failed ? "failed" : "routed",
      allowed: decision ? decision.feasibility.allowed : null,
      completed: decision ? decision.totals.completed : null,
    }),
    corridor: record.transaction.corridor,
    senderCountry: record.transaction.senderCountry,
    receiverCountry: record.transaction.receiverCountry,
    amountUsd: record.transaction.amountUsd,
    simulationDate: record.transaction.simulationDate,
    stateMode: decision ? (decision.provenance.stateMode as StateModeKey) : null,
    policy: decision ? (decision.policy as PolicyKey) : null,
    policyTier: decision ? (decision.policyStatus as PolicyTier) : null,
    clientReference: record.transaction.clientReference,
    failure: record.failure ? { code: record.failure.code, message: record.failure.message } : null,
    decision: view,
  };
}

/** One request for one transaction. A body that isn't the documented shape is an INVALID_RESPONSE error. */
export async function fetchTransactionDetail(api: ApiClient, id: string): Promise<TransactionDetailView> {
  const raw = await api.get<unknown>(`/transactions/${encodeURIComponent(id)}`);
  if (!isTransactionRecord(raw)) throw unreadable();
  // The ID asked for must be the ID returned: another transaction must never be shown under this address.
  if (raw.id.toLowerCase() !== id.toLowerCase()) throw unreadable();
  return mapTransactionRecord(raw);
}

// ---------- the explanation ----------

function factValueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function mapExplanation(explanation: ApiExplanation): ExplanationView {
  return {
    decisionId: explanation.decisionId,
    summary: explanation.summary,
    feasibility: {
      allowed: explanation.feasibility.allowed,
      reason: explanation.feasibility.reason,
      facts: explanation.feasibility.activeFacts.map((f) => ({
        factId: f.factId,
        ruleType: f.ruleType,
        valueText: factValueText(f.value),
        provenanceTag: f.provenanceTag,
        verified: f.verified,
        source: f.source,
      })),
      provider: explanation.feasibility.provider,
    },
    venues: explanation.venueExplanations.map((v) => ({
      bridgeUid: v.bridgeUid,
      outcome: v.outcome,
      reasonCode: v.reasonCode,
      text: v.text,
    })),
    policyNotes: explanation.policyNotes,
    limitations: explanation.limitations,
  };
}

/**
 * One request for one explanation (the backend recomputes it on first use and
 * stores it). The body must be for this transaction and for the decision on
 * screen: if either ID differs it is refused with EXPLANATION_MISMATCH and
 * nothing of it is shown.
 */
export async function fetchExplanation(
  api: ApiClient,
  transactionId: string,
  expectedDecisionId: string,
): Promise<ExplanationView> {
  const raw = await api.get<unknown>(`/transactions/${encodeURIComponent(transactionId)}/explanation`);
  if (!isApiExplanation(raw)) throw unreadable();
  if (raw.transactionId.toLowerCase() !== transactionId.toLowerCase() || raw.decisionId !== expectedDecisionId) {
    throw new ApiError({
      status: 200,
      code: EXPLANATION_MISMATCH,
      message: "The explanation is not for this decision.",
    });
  }
  return mapExplanation(raw);
}

// ---------- what to tell the user ----------

export type DetailErrorView = {
  message: string;
  /** Field messages of a 422, as "field: message". */
  details: string[];
  /** The request ID, for the user to quote. */
  reference: string | undefined;
  /** Whether asking again can help. A permanent answer (409, 404) gets no retry button. */
  canRetry: boolean;
};

/** Whether the server said this transaction doesn't exist (also what it says for an ID that isn't a UUID). */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/**
 * Wording is this UI's own, chosen by `code`, `status` and `details.cause`,
 * never by the backend's `message`.
 */
export function describeDetailError(error: unknown, what: "transaction" | "explanation"): DetailErrorView {
  const noun = what === "transaction" ? "the transaction" : "the explanation";
  if (!(error instanceof ApiError)) {
    return { message: `Something went wrong while loading ${noun}.`, details: [], reference: undefined, canRetry: true };
  }
  const reference = error.requestId ?? undefined;
  const view = (message: string, canRetry = true, details: string[] = []): DetailErrorView => ({
    message,
    details,
    reference,
    canRetry,
  });

  switch (error.code) {
    case "NETWORK_ERROR":
      return view("The server could not be reached. Check your connection, then try again.");
    case INVALID_RESPONSE:
      return view("The server sent a response this page couldn't read.");
    case EXPLANATION_MISMATCH:
      return view("The explanation the server returned is not for this decision, so it is not shown.", false);
    case "NOT_FOUND":
      return view("This transaction no longer exists.", false);
    case "TRANSACTION_FAILED":
      return view("This transaction failed, so it has no decision to explain.", false);
    case "POLICY_DISABLED":
      return view("This decision used a policy that is currently disabled, so it can't be explained again.", false);
    case "DECISION_MISMATCH":
      return view("The engine's data has changed since this decision was made, so it can't be explained again.", false);
    case "ENGINE_BUSY": {
      const wait = error.retryAfterSeconds;
      return view(
        wait !== null
          ? `The routing engine is busy. Try again in about ${wait} ${wait === 1 ? "second" : "seconds"}.`
          : "The routing engine is busy. Try again in a moment.",
      );
    }
    case "INFERENCE_UNAVAILABLE":
      return error.details.cause === "NOT_READY"
        ? view("The routing engine is starting up. Try again in a moment.")
        : view("The routing engine is unavailable. Try again in a moment.");
    case "ENGINE_TIMEOUT":
      return view("The routing engine did not answer in time. Try again.");
    default:
      break;
  }
  if (error.status === 403) return view(`You don't have access to ${noun}.`, false);
  if (error.status === 422) {
    const details = (error.details.errors ?? []).map((e) => (e.field ? `${e.field}: ${e.message}` : e.message));
    return view("The server didn't accept this request.", false, details);
  }
  if (error.status >= 500) return view("The server hit an unexpected error. Try again in a moment.");
  return view(`The request failed (${error.code}).`);
}
