/*
 * POST /api/v1/transactions (contract §3.2) for the live New Transaction form.
 *
 * A submission is sent once and never retried. It ends in one of three ways:
 * - a definite success: 201 with the saved record (routed, including a
 *   rejection or a partial completion, which are results, not errors);
 * - a definite API error: the server answered with an error body. A 4xx means
 *   nothing was saved; a 5xx that carries `details.transactionId` means the
 *   transaction was saved as failed. The backend's own message is kept;
 * - an UNCERTAIN outcome: no answer in time (25 s), the connection failed, or an
 *   answer arrived that can't be read. The request may have reached the server,
 *   so the transaction may have been saved. This is never reported as "not
 *   saved": the user is told to check History before submitting again.
 */
import { ApiError, INVALID_RESPONSE, NETWORK_ERROR, REQUEST_TIMEOUT, type ApiClient } from "../../api/client";
import { isTransactionRecord } from "../../api/types";
import { mapTransactionRecord } from "../transactions/detailApi";
import type { FormErrorView, LiveSubmitResult, TransactionPayload, UncertainReason } from "./types";

/** The backend gives up on inference after 15 s (contract §5); the browser waits a little longer than that. */
export const SUBMIT_TIMEOUT_MS = 25_000;

/**
 * Whether an ApiError means "we can't tell what happened to the request": no
 * response (timeout, network), a 2xx body we can't read, or an error response
 * that isn't the backend's envelope (for example a proxy's gateway page, which
 * can be sent after the backend has already saved the transaction).
 */
export function uncertainReason(error: ApiError): UncertainReason | null {
  if (error.code === REQUEST_TIMEOUT) return "timeout";
  if (error.code === NETWORK_ERROR) return "network";
  if (error.code === INVALID_RESPONSE || error.code.startsWith("HTTP_")) return "unreadable";
  return null;
}

/**
 * Sends one transaction. Never throws: whatever happens is a LiveSubmitResult.
 * `timeoutMs` is for tests; the form uses the default.
 */
export async function submitTransaction(
  api: ApiClient,
  payload: TransactionPayload,
  options: { timeoutMs?: number } = {},
): Promise<LiveSubmitResult> {
  let raw: unknown;
  try {
    raw = await api.post<unknown>("/transactions", payload, { timeoutMs: options.timeoutMs ?? SUBMIT_TIMEOUT_MS });
  } catch (error) {
    if (!(error instanceof ApiError)) return { kind: "uncertain", reason: "unreadable" };
    const reason = uncertainReason(error);
    if (reason) return { kind: "uncertain", reason };
    return {
      kind: "error",
      error: {
        status: error.status,
        code: error.code,
        // The backend's own message, kept as it is (contract §4).
        message: error.message,
        details: error.details,
        requestId: error.requestId ?? "none",
      },
    };
  }

  // A 2xx the contract doesn't describe (not a record, or not a routed one) is not a result we can show:
  // the transaction may well have been saved.
  if (!isTransactionRecord(raw) || raw.status !== "routed") return { kind: "uncertain", reason: "unreadable" };
  const transaction = mapTransactionRecord(raw);
  if (!transaction.decision) return { kind: "uncertain", reason: "unreadable" };
  return { kind: "routed", transaction };
}

const UNCERTAIN: Record<UncertainReason, { what: string; code: string }> = {
  timeout: { what: "The server did not answer within 25 seconds.", code: REQUEST_TIMEOUT },
  network: { what: "The connection to the server failed.", code: NETWORK_ERROR },
  unreadable: { what: "The server answered, but the answer could not be read.", code: INVALID_RESPONSE },
};

/** The form-level warning for an uncertain outcome. It never says "nothing was saved". */
export function describeUncertain(reason: UncertainReason): FormErrorView {
  return {
    title: "We can't tell whether this transaction was saved",
    messages: [
      UNCERTAIN[reason].what,
      "The request may have reached the server, so the transaction may have been saved. Check History before submitting again, or you may create a duplicate.",
    ],
    code: UNCERTAIN[reason].code,
    requestId: "none (no readable response)",
  };
}
