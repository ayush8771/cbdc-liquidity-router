/*
 * POST /api/v1/comparisons and GET /api/v1/comparisons/:id (contract §3.6) for
 * the desktop Compare screen. The API's comparison becomes the display model
 * the Compare components render (types.ts). Nothing here ranks or scores the
 * policies: they stay in the order requested, with the engine's own numbers.
 *
 * A comparison is an independent record: it is saved only when the engine
 * answered, an error saves nothing and carries no transaction ID, and it
 * appears in no list. A submission is sent once and never retried. If the
 * outcome is unknown (no answer in time, a lost connection, an unreadable
 * answer) the comparison MAY have been saved, and there is no list to check:
 * the user is told so, and that sending it again only makes another record.
 */
import { ApiError, INVALID_RESPONSE, NETWORK_ERROR, REQUEST_TIMEOUT, type ApiClient } from "../../api/client";
import { isApiComparison, type ApiComparedDecision, type ApiComparison } from "../../api/types";
import type { FormErrorView, ServerError, TransactionPayload, UncertainReason } from "../newTransaction/types";
import { uncertainReason, SUBMIT_TIMEOUT_MS } from "../newTransaction/submitApi";
import { outcomeOf } from "../transactions/historyTypes";
import type { DataSourceTag } from "../transactions/detailTypes";
import type { PolicyKey, PolicyTier } from "../transactions/types";
import type { ComparedDecisionView, ComparisonView, PolicyColumnView } from "./types";

const unreadable = () =>
  new ApiError({ status: 200, code: INVALID_RESPONSE, message: "The server's response could not be read." });

// ---------- the request ----------

/** The request body: the transaction's fields with `policies` in place of `policy` (contract §3.6). */
export type ComparePayload = Omit<TransactionPayload, "policy"> & { policies: PolicyKey[] };

/**
 * The transaction form's payload, with its single policy replaced by the chosen
 * policies in the order chosen. Only canonical names are ever sent; the
 * backend's aliases (`baseline`, `ruleBased`) are not used.
 */
export function toComparePayload(payload: TransactionPayload, policies: PolicyKey[]): ComparePayload {
  const { policy, ...rest } = payload;
  void policy;
  return { ...rest, policies };
}

// ---------- the response ----------

function mapDecision(decision: ApiComparedDecision): ComparedDecisionView {
  return {
    decisionId: decision.decisionId,
    policy: decision.policy as PolicyKey,
    policyTier: decision.policyStatus as PolicyTier,
    outcome: outcomeOf({
      status: "routed",
      allowed: decision.feasibility.allowed,
      completed: decision.totals.completed,
    }) as ComparedDecisionView["outcome"],
    feasibility: { allowed: decision.feasibility.allowed, reason: decision.feasibility.reason },
    totals: {
      requestedUsd: decision.totals.requestedUsd,
      executedUsd: decision.totals.executedUsd,
      unroutedAmountBasedUsd: decision.totals.unroutedAmountBasedUsd,
      completionRatio: decision.totals.completionRatio,
      bridgesUsed: decision.totals.bridgesUsed,
    },
    metrics: {
      feeCostUsd: decision.metrics.feeCostUsd,
      latencyTerm: decision.metrics.latencyTerm,
      riskTerm: decision.metrics.riskTerm,
      rewardAmountBased: decision.metrics.rewardAmountBased,
      weightsStatus: decision.metrics.rewardWeights.status,
    },
    projectionApplied: decision.diagnostics.projectionApplied,
    allocations: decision.allocations.map((a) => ({
      bridgeUid: a.bridgeUid,
      dataSourceTag: a.dataSourceTag as DataSourceTag,
      feePct: a.feePct,
      liquidityUsd: a.liquidityUsd,
      shareRequested: a.shareRequested,
      amountRequestedUsd: a.amountRequestedUsd,
      amountExecutedUsd: a.amountExecutedUsd,
      amountClippedUsd: a.amountClippedUsd,
      shareBeforeProjection: a.shareBeforeProjection,
    })),
    warnings: decision.warnings.map((w) => ({ code: w.code, message: w.message })),
  };
}

/**
 * API comparison to display model. One column per requested policy, in the
 * order requested (the strict check guarantees each policy has exactly one
 * result or one skipped entry). Policy names pass through as they came, so a
 * name this version doesn't know is shown as written (contract §1).
 */
export function mapComparison(comparison: ApiComparison): ComparisonView {
  const results = new Map(comparison.results.map((r) => [r.policy, r]));
  const skipped = new Map(comparison.skipped.map((s) => [s.policy, s]));
  const columns: PolicyColumnView[] = comparison.policies.map((policy): PolicyColumnView => {
    const result = results.get(policy);
    if (result) return { kind: "result", policy: policy as PolicyKey, decision: mapDecision(result) };
    const entry = skipped.get(policy)!;
    return { kind: "skipped", policy: policy as PolicyKey, code: entry.code, message: entry.message };
  });
  return {
    id: comparison.id,
    createdAt: comparison.createdAt,
    transaction: { ...comparison.transaction },
    stateMode: comparison.state.mode,
    columns,
    note: comparison.note,
  };
}

/** One request for a saved comparison. A body that isn't the documented shape, or is another comparison, is INVALID_RESPONSE. */
export async function fetchComparison(api: ApiClient, id: string): Promise<ComparisonView> {
  const raw = await api.get<unknown>(`/comparisons/${encodeURIComponent(id)}`);
  if (!isApiComparison(raw) || raw.id.toLowerCase() !== id.toLowerCase()) throw unreadable();
  return mapComparison(raw);
}

// ---------- submitting ----------

export type CompareSubmitResult =
  | { kind: "saved"; comparison: ComparisonView }
  | { kind: "error"; error: ServerError }
  /** No way to tell whether it was saved. */
  | { kind: "uncertain"; reason: UncertainReason };

/**
 * Sends one comparison, once, with the same 25 s limit as a transaction. Never
 * throws: whatever happens is a CompareSubmitResult. A definite error keeps the
 * backend's own message, code, details and request ID, and saved nothing.
 */
export async function submitComparison(
  api: ApiClient,
  payload: ComparePayload,
  options: { timeoutMs?: number } = {},
): Promise<CompareSubmitResult> {
  let raw: unknown;
  try {
    raw = await api.post<unknown>("/comparisons", payload, { timeoutMs: options.timeoutMs ?? SUBMIT_TIMEOUT_MS });
  } catch (error) {
    if (!(error instanceof ApiError)) return { kind: "uncertain", reason: "unreadable" };
    const reason = uncertainReason(error);
    if (reason) return { kind: "uncertain", reason };
    return {
      kind: "error",
      error: {
        status: error.status,
        code: error.code,
        message: error.message,
        details: error.details,
        requestId: error.requestId ?? "none",
      },
    };
  }
  // A 2xx the contract doesn't describe isn't a result we can show, and it may well have been saved.
  if (!isApiComparison(raw)) return { kind: "uncertain", reason: "unreadable" };
  return { kind: "saved", comparison: mapComparison(raw) };
}

const UNCERTAIN: Record<UncertainReason, { what: string; code: string }> = {
  timeout: { what: "The server did not answer within 25 seconds.", code: REQUEST_TIMEOUT },
  network: { what: "The connection to the server failed.", code: NETWORK_ERROR },
  unreadable: { what: "The server answered, but the answer could not be read.", code: INVALID_RESPONSE },
};

/** The form-level warning for an unknown outcome. It never says the comparison wasn't saved. */
export function describeCompareUncertain(reason: UncertainReason): FormErrorView {
  return {
    title: "We can't tell whether this comparison was saved",
    messages: [
      UNCERTAIN[reason].what,
      "The request may have reached the server, so the comparison may have been saved. Comparisons can't be listed, so there is nowhere to check. Submitting again only creates another, independent record; it doesn't affect History or the dashboard.",
    ],
    code: UNCERTAIN[reason].code,
    requestId: "none (no readable response)",
  };
}

/**
 * Field errors for the comparison form: the transaction form's own mapping
 * (describeFailure), plus the `policies` field, which that mapping doesn't know.
 * A problem the server names on `policies` (or one of its entries) goes to the
 * policies control; a 403 FORBIDDEN_POLICY goes there too.
 */
export function policyFieldMessage(error: ServerError): string | null {
  if (error.code === "FORBIDDEN_POLICY") return error.message;
  const items = error.code === "VALIDATION_ERROR" ? (error.details.errors ?? []) : [];
  const onPolicies = items.find((e) => e.field !== undefined && /^policies(\[\d+\])?$/.test(e.field));
  if (onPolicies) return onPolicies.message;
  return error.details.field !== undefined && /^policies(\[\d+\])?$/.test(error.details.field) ? error.message : null;
}

// ---------- what to tell the user about a saved comparison that didn't load ----------

export type ComparisonErrorView = {
  message: string;
  /** The request ID, for the user to quote. */
  reference: string | undefined;
  canRetry: boolean;
};

/** Wording is this UI's own, chosen by `code` and `status`, never by the backend's message. */
export function describeComparisonError(error: unknown): ComparisonErrorView {
  if (!(error instanceof ApiError)) {
    return { message: "Something went wrong while loading the comparison.", reference: undefined, canRetry: true };
  }
  const reference = error.requestId ?? undefined;
  const view = (message: string, canRetry = true): ComparisonErrorView => ({ message, reference, canRetry });
  if (error.code === "NETWORK_ERROR") return view("The server could not be reached. Check your connection, then try again.");
  if (error.code === INVALID_RESPONSE) return view("The server sent a response this page couldn't read.");
  if (error.status === 404) return view("This comparison doesn't exist.", false);
  if (error.status === 403) return view("You don't have access to this comparison.", false);
  if (error.status >= 500) return view("The server hit an unexpected error. Try again in a moment.");
  return view(`The request failed (${error.code}).`);
}
