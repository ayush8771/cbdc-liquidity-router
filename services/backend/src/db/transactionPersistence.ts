import { randomUUID } from "node:crypto";
import type { FailureCode, Prisma, PrismaClient } from "@prisma/client";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, AUDIT_OUTCOMES, auditLogData, type AuditOutcome } from "../audit/auditLog.js";
import type { AllocationColumns, DecisionColumns } from "../mappers/routeResponse.js";
import type { TransactionRequest } from "../validation/transactionRequest.js";

// Saving POST /api/v1/transactions outcomes (API contract §3.2, §6). The route
// depends on the TransactionPersistence interface, so tests can use a fake;
// createPrismaTransactionPersistence() is the real implementation.
//
// - Routed: TransactionRequest, its RoutingDecision, every Allocation and a
//   SUCCESS audit row, in one database transaction.
// - Failed: TransactionRequest (status failed, failureCode set, no decision)
//   and a FAILED audit row, in one database transaction. Routed rows have
//   failureCode null.
// - RoutingDecision.feeCostUsd is the mapper's copy of metrics.fee_cost_usd.
// - If any insert fails, nothing is saved. Inserts only: no update or delete.
// - IDs and timestamps come from the backend. The audit row shares the
//   transaction's createdAt and references its ID.
// - stateSpec is the validated Application API state (camelCase, history
//   null when omitted), so the request can be replayed (§6.2).
// - engineResponse is the inference body as received. Column values are the
//   mapper's copies of it; nothing is computed here.

export interface TransactionContext {
  userId: string;
  requestId: string;
  /** The validated request (Step 6E-1), policy already defaulted. */
  request: TransactionRequest;
}

export interface RoutedTransaction extends TransactionContext {
  corridor: string;
  decision: DecisionColumns;
  allocations: AllocationColumns[];
  /** The /v1/route 200 body, unchanged. */
  engineResponse: Record<string, unknown>;
}

/** The §3.2 failure codes, as stored in TransactionRequest.failureCode. */
export const FAILURE_CODES: readonly FailureCode[] = Object.freeze([
  "INFERENCE_ERROR",
  "INFERENCE_UNAVAILABLE",
  "ENGINE_BUSY",
  "ENGINE_TIMEOUT",
]);

export function isFailureCode(code: string): code is FailureCode {
  return (FAILURE_CODES as readonly string[]).includes(code);
}

export interface FailedTransaction extends TransactionContext {
  /** The app error code the POST returned (NOT_READY arrives as INFERENCE_UNAVAILABLE). */
  failureCode: FailureCode;
}

export interface SavedTransaction {
  id: string;
  createdAt: Date;
}

export interface TransactionPersistence {
  /** Whether the seeded User row exists. Users are never created here. */
  userExists(userId: string): Promise<boolean>;
  saveRouted(input: RoutedTransaction): Promise<SavedTransaction>;
  /** Corridor null: there is no usable engine response to take it from. */
  saveFailed(input: FailedTransaction): Promise<SavedTransaction>;
}

export interface PersistenceOptions {
  /** The transaction ID is drawn first, then the audit ID. Tests may inject this. */
  newId?: () => string;
  now?: () => Date;
}

/** TransactionRequest columns shared by routed and failed rows. */
export function transactionRequestData(
  { userId, request }: TransactionContext,
  ids: { id: string; createdAt: Date },
  status: "routed" | "failed",
  corridor: string | null,
  failureCode: FailureCode | null = null,
): Prisma.TransactionRequestUncheckedCreateInput {
  const state = request.state;
  const simulationDate = state.mode === "explicit" ? state.referenceDate : state.date;
  return {
    id: ids.id,
    createdAt: ids.createdAt,
    createdById: userId,
    senderCountry: request.senderCountry,
    receiverCountry: request.receiverCountry,
    corridor,
    amountUsd: request.amountUsd,
    stateMode: state.mode,
    stateSpec: state as unknown as Prisma.InputJsonObject,
    simulationDate: new Date(`${simulationDate}T00:00:00.000Z`),
    requestedPolicy: request.policy,
    status,
    failureCode,
    clientReference: request.clientReference,
  };
}

export function createPrismaTransactionPersistence(
  client: PrismaClient,
  { newId = randomUUID, now = () => new Date() }: PersistenceOptions = {},
): TransactionPersistence {
  const audit = (input: TransactionContext, outcome: AuditOutcome, saved: SavedTransaction) =>
    client.auditLog.create({
      data: auditLogData({
        id: newId(),
        at: saved.createdAt,
        userId: input.userId,
        action: AUDIT_ACTIONS.transactionCreate,
        requestId: input.requestId,
        outcome,
        entity: { type: AUDIT_ENTITY_TYPES.transactionRequest, id: saved.id },
      }),
      select: { id: true },
    });
  const select = { id: true, createdAt: true } as const;

  return {
    async userExists(userId) {
      return (await client.user.findUnique({ where: { id: userId }, select: { id: true } })) !== null;
    },

    async saveRouted(input) {
      // RoutingDecision.policy must equal requestedPolicy (schema rule). The
      // mapper already rejects a mismatch; this keeps the rule at the write.
      if (input.decision.policy !== input.request.policy) {
        throw new Error("RoutingDecision.policy differs from the requested policy; nothing was saved");
      }
      const ids = { id: newId(), createdAt: now() };
      const [saved] = await client.$transaction([
        client.transactionRequest.create({
          data: {
            ...transactionRequestData(input, ids, "routed", input.corridor),
            decision: {
              create: {
                ...input.decision,
                engineResponse: input.engineResponse as Prisma.InputJsonObject,
                ...(input.allocations.length > 0 && { allocations: { createMany: { data: input.allocations } } }),
              },
            },
          },
          select,
        }),
        audit(input, AUDIT_OUTCOMES.success, ids),
      ]);
      return saved;
    },

    async saveFailed(input) {
      // Untyped callers: an unknown code would otherwise reach the database enum.
      if (!isFailureCode(input.failureCode)) {
        throw new Error("Unknown failure code; nothing was saved");
      }
      const ids = { id: newId(), createdAt: now() };
      const [saved] = await client.$transaction([
        client.transactionRequest.create({
          data: transactionRequestData(input, ids, "failed", null, input.failureCode),
          select,
        }),
        audit(input, AUDIT_OUTCOMES.failed, ids),
      ]);
      return saved;
    },
  };
}
