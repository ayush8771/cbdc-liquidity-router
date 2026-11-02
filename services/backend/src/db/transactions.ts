import { Prisma, type PrismaClient } from "@prisma/client";
import type { Policy, PolicyStatus, StateMode, TransactionStatus } from "@prisma/client";

// Reading transaction history for GET /api/v1/transactions (API contract §3.3).
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

export interface TransactionRepository {
  /** One page, newest first (createdAt DESC, then id DESC), and the total matching the filters. */
  list(query: TransactionListQuery): Promise<{ rows: TransactionListRow[]; total: number }>;
}

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
  };
}
