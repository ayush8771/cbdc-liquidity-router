import { randomUUID } from "node:crypto";
import type { Policy, Prisma, PrismaClient, TransactionStatus } from "@prisma/client";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, AUDIT_OUTCOMES, auditLogData } from "../audit/auditLog.js";
import { prismaErrorCode } from "./errors.js";

// Explanations for GET /api/v1/transactions/:id/explanation (API contract
// §3.5, §6). The route depends on the ExplanationStore interface, so tests can
// use a fake; createPrismaExplanationStore() is the real implementation.
//
// - findTarget reads only: the transaction's request columns, its decision's
//   identifiers and any stored explanation.
// - save writes the Explanation and its SUCCESS audit row in one database
//   transaction (§6.2), so neither exists without the other.
// - Concurrent first requests: Explanation.routingDecisionId is unique, so
//   only one insert can succeed. The other fails with P2002, which rolls back
//   its audit row too, and save returns the explanation that was stored first.
//   Exactly one Explanation and one audit row exist either way.
// - Inserts only: no update or delete.

export interface ExplanationTarget {
  id: string;
  status: TransactionStatus;
  senderCountry: string;
  receiverCountry: string;
  amountUsd: number;
  /** The validated Application API state, as saved (§6.2). */
  stateSpec: Prisma.JsonValue;
  requestedPolicy: Policy;
  clientReference: string | null;
  /** Null for a failed transaction. */
  decision: {
    /** RoutingDecision.id. */
    id: string;
    /** The engine's decision_id. */
    decisionId: string;
    checkpointSha256: string | null;
    /** The verbatim /v1/explain body, once stored. */
    explanation: { engineResponse: Prisma.JsonValue } | null;
  } | null;
}

export interface NewExplanation {
  routingDecisionId: string;
  /** The /v1/explain 200 body, unchanged (§6.1). */
  engineResponse: Record<string, unknown>;
  userId: string;
  requestId: string;
}

export type SaveResult =
  | { stored: "created" }
  /** Another request stored this decision's explanation first; its body is returned. */
  | { stored: "existing"; engineResponse: Prisma.JsonValue };

export interface ExplanationStore {
  /** The ID must already be a syntactically valid UUID. */
  findTarget(transactionId: string): Promise<ExplanationTarget | null>;
  /** Whether the seeded User row exists. Users are never created here. */
  userExists(userId: string): Promise<boolean>;
  save(input: NewExplanation): Promise<SaveResult>;
}

export interface ExplanationStoreOptions {
  /** The explanation ID is drawn first, then the audit ID. Tests may inject this. */
  newId?: () => string;
  now?: () => Date;
}

const TARGET_SELECT = {
  id: true,
  status: true,
  senderCountry: true,
  receiverCountry: true,
  amountUsd: true,
  stateSpec: true,
  requestedPolicy: true,
  clientReference: true,
  decision: {
    select: {
      id: true,
      decisionId: true,
      checkpointSha256: true,
      explanation: { select: { engineResponse: true } },
    },
  },
} satisfies Prisma.TransactionRequestSelect;

export function createPrismaExplanationStore(
  client: PrismaClient,
  { newId = randomUUID, now = () => new Date() }: ExplanationStoreOptions = {},
): ExplanationStore {
  return {
    async findTarget(transactionId) {
      return client.transactionRequest.findUnique({ where: { id: transactionId }, select: TARGET_SELECT });
    },

    async userExists(userId) {
      return (await client.user.findUnique({ where: { id: userId }, select: { id: true } })) !== null;
    },

    async save(input) {
      const id = newId();
      const createdAt = now();
      try {
        await client.$transaction([
          client.explanation.create({
            data: {
              id,
              createdAt,
              routingDecisionId: input.routingDecisionId,
              engineResponse: input.engineResponse as Prisma.InputJsonObject,
            },
            select: { id: true },
          }),
          client.auditLog.create({
            data: auditLogData({
              id: newId(),
              at: createdAt,
              userId: input.userId,
              action: AUDIT_ACTIONS.explanationCreate,
              requestId: input.requestId,
              outcome: AUDIT_OUTCOMES.success,
              entity: { type: AUDIT_ENTITY_TYPES.explanation, id },
            }),
            select: { id: true },
          }),
        ]);
        return { stored: "created" };
      } catch (error) {
        // Only a unique violation of Explanation.routingDecisionId means
        // another request won the race. The failed transaction is already
        // rolled back, so the reread runs outside it. Every other error,
        // including any other P2002, or this one with no stored row,
        // propagates (500, nothing saved).
        if (!isRoutingDecisionConflict(error)) throw error;
        const existing = await client.explanation.findUnique({
          where: { routingDecisionId: input.routingDecisionId },
          select: { engineResponse: true },
        });
        if (existing === null) throw error;
        return { stored: "existing", engineResponse: existing.engineResponse };
      }
    },
  };
}

/** The unique index on Explanation.routingDecisionId (init migration). */
export const ROUTING_DECISION_UNIQUE_INDEX = "Explanation_routingDecisionId_key";

/**
 * True only for a P2002 on Explanation.routingDecisionId. Prisma reports the
 * model in meta.modelName and the constraint in meta.target, either as the
 * field list or as the index name, depending on the engine. Without both
 * pieces of evidence the error is not treated as the race.
 */
export function isRoutingDecisionConflict(error: unknown): boolean {
  if (prismaErrorCode(error) !== "P2002") return false;
  const meta = (error as { meta?: unknown }).meta;
  if (typeof meta !== "object" || meta === null) return false;
  const { modelName, target } = meta as { modelName?: unknown; target?: unknown };
  if (modelName !== undefined && modelName !== "Explanation") return false;
  if (Array.isArray(target)) return target.length === 1 && target[0] === "routingDecisionId" && modelName === "Explanation";
  return target === ROUTING_DECISION_UNIQUE_INDEX;
}
