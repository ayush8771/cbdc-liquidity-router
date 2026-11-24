import { Prisma, type PrismaClient } from "@prisma/client";
import type { Policy } from "@prisma/client";

// Aggregates for GET /api/v1/dashboard/summary (API contract §3.8). The route
// depends on the DashboardRepository interface, so tests can use a fake;
// createPrismaDashboardRepository() is the real implementation.
//
// Everything is aggregated in PostgreSQL: one row per group comes back, never
// the transaction history. Values come from stored decision columns only,
// never recomputed from allocations or engineResponse (§3.8). Comparisons are
// a separate table and are never read (§3.6, §3.8).
//
// Populations (§3.8):
// - "allowed routed": status = routed with a decision whose allowed = true.
//   It is the denominator of completionRate and the population of every mean.
// - "rejected": status = routed with a decision whose allowed = false.
// - meanFeeCostPct averages feeCostUsd / executedUsd over the allowed routed
//   decisions with executedUsd > 0, then multiplies by 100.
// - NULL metric columns (only possible on rows saved before metrics became
//   required) are skipped by AVG, so a mean covers the non-null values and is
//   NULL when there are none (decision approved for this step).
//
// Filters follow §3.3, which §1 points dashboard queries to: from inclusive
// and to exclusive on createdAt; corridor matches the stored corridor, so it
// never matches a failed row; policy matches the requested policy, so failed
// rows are included.

export interface DashboardFilters {
  /** Inclusive. */
  from?: Date;
  /** Exclusive. */
  to?: Date;
  corridor?: string;
  /** Matched against TransactionRequest.requestedPolicy. */
  policy?: Policy;
}

export interface DashboardTotalsRow {
  transactions: number;
  routed: number;
  failed: number;
  rejectedByFeasibility: number;
}

export interface DashboardPolicyRow {
  policy: Policy;
  /** Every transaction with this requested policy, failed and rejected included. */
  count: number;
  allowedRouted: number;
  /** Allowed routed decisions with completed = true. */
  completedAllowedRouted: number;
  meanRewardAmountBased: number | null;
  meanFeeCostPct: number | null;
  meanLatencyTerm: number | null;
  meanRiskTerm: number | null;
}

export interface DashboardCorridorRow {
  corridor: string;
  /** Routed decisions on this corridor. */
  routed: number;
  allowedRouted: number;
  completedAllowedRouted: number;
}

export interface DashboardAggregates {
  totals: DashboardTotalsRow;
  byPolicy: DashboardPolicyRow[];
  byCorridor: DashboardCorridorRow[];
}

export interface DashboardRepository {
  summary(filters: DashboardFilters): Promise<DashboardAggregates>;
}

/** The WHERE clause for the filters, over TransactionRequest aliased "t". */
export function dashboardWhere(filters: DashboardFilters): Prisma.Sql {
  const conditions: Prisma.Sql[] = [Prisma.sql`TRUE`];
  // ISO strings cast to timestamptz: the trailing Z makes them unambiguous
  // whatever the session time zone.
  if (filters.from !== undefined) {
    conditions.push(Prisma.sql`t."createdAt" >= CAST(${filters.from.toISOString()} AS timestamptz)`);
  }
  if (filters.to !== undefined) {
    conditions.push(Prisma.sql`t."createdAt" < CAST(${filters.to.toISOString()} AS timestamptz)`);
  }
  // A NULL corridor never equals a value, so failed rows never match (§3.3).
  if (filters.corridor !== undefined) conditions.push(Prisma.sql`t."corridor" = ${filters.corridor}`);
  if (filters.policy !== undefined) {
    conditions.push(Prisma.sql`t."requestedPolicy" = CAST(${filters.policy} AS "Policy")`);
  }
  return Prisma.join(conditions, " AND ");
}

const FROM = Prisma.sql`"TransactionRequest" t LEFT JOIN "RoutingDecision" d ON d."transactionId" = t."id"`;
const ROUTED = Prisma.sql`t."status" = 'routed'`;
const ALLOWED_ROUTED = Prisma.sql`t."status" = 'routed' AND d."allowed" IS TRUE`;

export function createPrismaDashboardRepository(client: PrismaClient): DashboardRepository {
  return {
    async summary(filters) {
      const where = dashboardWhere(filters);
      // COUNT is bigint in PostgreSQL; ::integer keeps it a JS number.
      const totalsQuery = client.$queryRaw<DashboardTotalsRow[]>`
        SELECT
          COUNT(*)::integer AS "transactions",
          (COUNT(*) FILTER (WHERE ${ROUTED}))::integer AS "routed",
          (COUNT(*) FILTER (WHERE t."status" = 'failed'))::integer AS "failed",
          (COUNT(*) FILTER (WHERE ${ROUTED} AND d."allowed" IS FALSE))::integer AS "rejectedByFeasibility"
        FROM ${FROM}
        WHERE ${where}`;
      const policyQuery = client.$queryRaw<DashboardPolicyRow[]>`
        SELECT
          t."requestedPolicy"::text AS "policy",
          COUNT(*)::integer AS "count",
          (COUNT(*) FILTER (WHERE ${ALLOWED_ROUTED}))::integer AS "allowedRouted",
          (COUNT(*) FILTER (WHERE ${ALLOWED_ROUTED} AND d."completed" IS TRUE))::integer AS "completedAllowedRouted",
          AVG(d."rewardAmountBased") FILTER (WHERE ${ALLOWED_ROUTED}) AS "meanRewardAmountBased",
          100 * AVG(d."feeCostUsd" / d."executedUsd") FILTER (WHERE ${ALLOWED_ROUTED} AND d."executedUsd" > 0)
            AS "meanFeeCostPct",
          AVG(d."latencyTerm") FILTER (WHERE ${ALLOWED_ROUTED}) AS "meanLatencyTerm",
          AVG(d."riskTerm") FILTER (WHERE ${ALLOWED_ROUTED}) AS "meanRiskTerm"
        FROM ${FROM}
        WHERE ${where}
        GROUP BY t."requestedPolicy"`;
      // Routed only: a failed row has no corridor (§3.8). A routed row always
      // has one (saveRouted requires it); IS NOT NULL keeps a corridor-less row
      // out of a list whose entries need a corridor.
      const corridorQuery = client.$queryRaw<DashboardCorridorRow[]>`
        SELECT
          t."corridor" AS "corridor",
          COUNT(*)::integer AS "routed",
          (COUNT(*) FILTER (WHERE d."allowed" IS TRUE))::integer AS "allowedRouted",
          (COUNT(*) FILTER (WHERE d."allowed" IS TRUE AND d."completed" IS TRUE))::integer AS "completedAllowedRouted"
        FROM ${FROM}
        WHERE ${where} AND ${ROUTED} AND t."corridor" IS NOT NULL
        GROUP BY t."corridor"`;
      // One REPEATABLE READ snapshot, so the totals and the groups agree even
      // while transactions are being added.
      const [totals, byPolicy, byCorridor] = await client.$transaction([totalsQuery, policyQuery, corridorQuery], {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
      return {
        totals: totals[0] ?? { transactions: 0, routed: 0, failed: 0, rejectedByFeasibility: 0 },
        byPolicy,
        byCorridor,
      };
    },
  };
}
