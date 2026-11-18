import { Prisma, type PrismaClient } from "@prisma/client";
import type { FailureCode, Policy, PolicyStatus, StateMode, TransactionStatus } from "@prisma/client";

// Reading transactions: history for GET /api/v1/transactions (API contract
// §3.3) and one transaction for GET /api/v1/transactions/:id (§3.4).
// The route depends on the TransactionRepository interface, so tests can use a
// fake; createPrismaTransactionRepository() is the real implementation.

export interface TransactionListFilters {
  corridor?: string;
  /** Matched against TransactionRequest.requestedPolicy, which failed rows have too. */
  policy?: Policy;
  stateMode?: StateMode;
  /** Matches only transactions with a decision; failed ones have none. */
  completed?: boolean;
  /** Inclusive. */
  from?: Date;
  /** Exclusive. */
  to?: Date;
}

export interface TransactionListQuery {
  filters: TransactionListFilters;
  page: number;
  pageSize: number;
}

/** The stored fields a history item is built from. */
export interface TransactionListRow {
  id: string;
  createdAt: Date;
  createdById: string;
  corridor: string | null;
  amountUsd: number;
  simulationDate: Date;
  stateMode: StateMode;
  requestedPolicy: Policy;
  status: TransactionStatus;
  /** Null for a failed transaction. */
  decision: {
    policyStatus: PolicyStatus;
    allowed: boolean;
    completed: boolean;
    completionRatio: number;
    executedUsd: number;
    rewardAmountBased: number | null;
  } | null;
}

/**
 * The stored fields GET /api/v1/transactions/:id (§3.4) is rebuilt from: the
 * request columns, and for a routed row the verbatim engine response (§6.1).
 */
export interface TransactionDetailRow {
  id: string;
  createdAt: Date;
  createdById: string;
  senderCountry: string;
  receiverCountry: string;
  amountUsd: number;
  /** The validated Application API state, as saved (§6.2). */
  stateSpec: Prisma.JsonValue;
  simulationDate: Date;
  requestedPolicy: Policy;
  status: TransactionStatus;
  /** Null for routed rows, and for failed rows saved before the column existed. */
  failureCode: FailureCode | null;
  clientReference: string | null;
  /** Null for a failed transaction. */
  decision: { engineResponse: Prisma.JsonValue } | null;
}

export interface TransactionRepository {
  /** One page, newest first (createdAt DESC, then id DESC), and the total matching the filters. */
  list(query: TransactionListQuery): Promise<{ rows: TransactionListRow[]; total: number }>;
  /** One transaction by ID, or null. The ID must already be a syntactically valid UUID. */
  findById(id: string): Promise<TransactionDetailRow | null>;
}

const DETAIL_SELECT = {
  id: true,
  createdAt: true,
  createdById: true,
  senderCountry: true,
  receiverCountry: true,
  amountUsd: true,
  stateSpec: true,
  simulationDate: true,
  requestedPolicy: true,
  status: true,
  failureCode: true,
  clientReference: true,
  decision: { select: { engineResponse: true } },
} satisfies Prisma.TransactionRequestSelect;

const SELECT = {
  id: true,
  createdAt: true,
  createdById: true,
  corridor: true,
  amountUsd: true,
  simulationDate: true,
  stateMode: true,
  requestedPolicy: true,
  status: true,
  decision: {
    select: {
      policyStatus: true,
      allowed: true,
      completed: true,
      completionRatio: true,
      executedUsd: true,
      rewardAmountBased: true,
    },
  },
} satisfies Prisma.TransactionRequestSelect;

export function transactionListWhere(filters: TransactionListFilters): Prisma.TransactionRequestWhereInput {
  const where: Prisma.TransactionRequestWhereInput = {};
  if (filters.corridor !== undefined) where.corridor = filters.corridor;
  if (filters.policy !== undefined) where.requestedPolicy = filters.policy;
  if (filters.stateMode !== undefined) where.stateMode = filters.stateMode;
  // A relation filter, so transactions without a decision never match.
  if (filters.completed !== undefined) where.decision = { is: { completed: filters.completed } };
  if (filters.from !== undefined || filters.to !== undefined) {
    where.createdAt = {
      ...(filters.from !== undefined && { gte: filters.from }),
      ...(filters.to !== undefined && { lt: filters.to }),
    };
  }
  return where;
}

export function createPrismaTransactionRepository(client: PrismaClient): TransactionRepository {
  return {
    async list({ filters, page, pageSize }) {
      const where = transactionListWhere(filters);
      // Both queries run in one database transaction. REPEATABLE READ gives them
      // one snapshot, so the page and the total agree even while rows are added.
      const [rows, total] = await client.$transaction(
        [
          client.transactionRequest.findMany({
            where,
            select: SELECT,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
          client.transactionRequest.count({ where }),
        ],
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
      return { rows, total };
    },

    async findById(id) {
      // Read only: GET writes nothing, not even an audit row (§6.2).
      return client.transactionRequest.findUnique({ where: { id }, select: DETAIL_SELECT });
    },
  };
}
