import { randomUUID } from "node:crypto";
import type { Policy, Prisma, PrismaClient, StateMode } from "@prisma/client";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, AUDIT_OUTCOMES, auditLogData } from "../audit/auditLog.js";
import { exactComparisonResponse } from "./exactEngineResponse.js";
import type { ComparisonRequest } from "../validation/comparisonRequest.js";

// Comparisons for POST /api/v1/comparisons and GET /api/v1/comparisons/:id
// (API contract §3.6, §6). The routes depend on the ComparisonStore interface,
// so tests can use a fake; createPrismaComparisonStore() is the real one.
//
// - A comparison is an independent record: no TransactionRequest,
//   RoutingDecision or Allocation row is written (§3.6).
// - save writes the Comparison and its SUCCESS audit row in one database
//   transaction (§6.2), so neither exists without the other. If either insert
//   fails, nothing is saved.
// - Nothing is unique about a comparison but its ID: the same request sent
//   twice is saved as two records, each with its own audit row (§6.1: records
//   are append-only).
// - Inserts only: no update or delete.
// - IDs and timestamps come from the backend. The audit row shares the
//   comparison's createdAt and references its ID.
// - stateSpec is the validated Application API state and policies the
//   resolved list sent to the engine, in order; both are returned (Q18).
// - engineResponse is the /v1/compare 200 body as received (§6.1).

export interface NewComparison {
  userId: string;
  requestId: string;
  /** The validated request, with its policy list resolved. */
  request: ComparisonRequest;
  /** From the results; null when every policy was skipped (§3.6). */
  corridor: string | null;
  /** The /v1/compare 200 body, unchanged. */
  engineResponse: Record<string, unknown>;
}

export interface SavedComparison {
  id: string;
  createdAt: Date;
}

export interface ComparisonRow {
  id: string;
  createdAt: Date;
  createdById: string;
  senderCountry: string;
  receiverCountry: string;
  corridor: string | null;
  amountUsd: number;
  simulationDate: Date;
  clientReference: string | null;
  stateMode: StateMode;
  stateSpec: Prisma.JsonValue;
  policies: Policy[];
  engineResponse: Prisma.JsonValue;
}

export interface ComparisonStore {
  /** Whether the seeded User row exists. Users are never created here. */
  userExists(userId: string): Promise<boolean>;
  save(input: NewComparison): Promise<SavedComparison>;
  /** The ID must already be a syntactically valid UUID. */
  findById(id: string): Promise<ComparisonRow | null>;
}

export interface ComparisonStoreOptions {
  /** The comparison ID is drawn first, then the audit ID. Tests may inject this. */
  newId?: () => string;
  now?: () => Date;
}

const ROW_SELECT = {
  id: true,
  createdAt: true,
  createdById: true,
  senderCountry: true,
  receiverCountry: true,
  corridor: true,
  amountUsd: true,
  simulationDate: true,
  clientReference: true,
  stateMode: true,
  stateSpec: true,
  policies: true,
  engineResponse: true,
} satisfies Prisma.ComparisonSelect;

export function comparisonData(
  input: NewComparison,
  ids: SavedComparison,
): Prisma.ComparisonUncheckedCreateInput {
  const { request } = input;
  const state = request.state;
  const simulationDate = state.mode === "explicit" ? state.referenceDate : state.date;
  return {
    id: ids.id,
    createdAt: ids.createdAt,
    createdById: input.userId,
    senderCountry: request.senderCountry,
    receiverCountry: request.receiverCountry,
    corridor: input.corridor,
    amountUsd: request.amountUsd,
    simulationDate: new Date(`${simulationDate}T00:00:00.000Z`),
    clientReference: request.clientReference,
    stateMode: state.mode,
    stateSpec: state as unknown as Prisma.InputJsonObject,
    policies: [...request.policies],
    engineResponse: input.engineResponse as Prisma.InputJsonObject,
  };
}

export function createPrismaComparisonStore(
  client: PrismaClient,
  { newId = randomUUID, now = () => new Date() }: ComparisonStoreOptions = {},
): ComparisonStore {
  return {
    async userExists(userId) {
      return (await client.user.findUnique({ where: { id: userId }, select: { id: true } })) !== null;
    },

    async save(input) {
      if (input.request.policies.length === 0) throw new Error("A comparison has no policies; nothing was saved");
      const ids = { id: newId(), createdAt: now() };
      const [saved] = await client.$transaction([
        client.comparison.create({ data: comparisonData(input, ids), select: { id: true, createdAt: true } }),
        client.auditLog.create({
          data: auditLogData({
            id: newId(),
            at: ids.createdAt,
            userId: input.userId,
            action: AUDIT_ACTIONS.comparisonCreate,
            requestId: input.requestId,
            outcome: AUDIT_OUTCOMES.success,
            entity: { type: AUDIT_ENTITY_TYPES.comparison, id: ids.id },
          }),
          select: { id: true },
        }),
        // Last in the same transaction: Prisma rounds every double in a Json field to
        // 16 significant digits, so the engine's numbers are written again from text
        // (src/db/exactEngineResponse.ts). Without it a stored comparison differs from
        // the 201 body by about 1 ulp (§3.6, §6.1).
        exactComparisonResponse(client, ids.id, input.engineResponse),
      ]);
      return saved;
    },

    async findById(id) {
      return client.comparison.findUnique({ where: { id }, select: ROW_SELECT });
    },
  };
}
