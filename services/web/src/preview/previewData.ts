/*
 * PREVIEW DATA — illustrative values for reviewing layouts before the shared
 * API contracts are merged. Not from the API, not copied from the shared
 * fixtures, and not used once integration starts: delete this folder then.
 *
 * Values are deterministic (seeded) so screenshots and tests are stable.
 */
import type { DashboardView } from "../features/dashboard/types";
import { CORRIDORS, type HistoryFilters } from "../features/transactions/filters";
import type { Outcome, PolicyKey, PolicyTier, StateModeKey, TransactionRow } from "../features/transactions/types";

// Small seeded PRNG (mulberry32), so every run produces the same rows.
function seeded(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = seeded(20261103);
const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(["8", "9", "a", "b"])}${hex(3)}-${hex(12)}`;

const TIER: Record<PolicyKey, PolicyTier> = { waterfall: "default", cheapestFeasible: "baseline", ppoProjected: "experimental" };
const AMOUNTS = [25_000, 60_000, 100_000, 150_000, 240_000, 300_000, 320_000, 400_000, 480_000, 600_000];
const DATES = ["2024-06-14", "2024-09-03", "2025-02-11", "2025-07-22"];

function makeRows(count: number): TransactionRow[] {
  const start = Date.parse("2026-11-03T16:00:00Z");
  return Array.from({ length: count }, (_, i) => {
    const policy: PolicyKey = pick(["waterfall", "waterfall", "waterfall", "cheapestFeasible", "ppoProjected"]);
    const stateMode: StateModeKey = pick(["historicalReplay", "historicalReplay", "scenario", "explicit"]);
    const amountUsd = pick(AMOUNTS);
    const failed = rand() < 0.06;
    // Amounts above the $500K single-transfer cap are rejected by feasibility.
    const outcome: Outcome = failed ? "failed" : amountUsd > 500_000 ? "rejected" : rand() < 0.82 ? "completed" : "partial";
    return {
      id: uuid(),
      createdAt: new Date(start - i * 47 * 60_000).toISOString(),
      corridor: failed ? null : pick(CORRIDORS),
      amountUsd,
      policy,
      policyTier: failed ? null : TIER[policy],
      outcome,
      stateMode,
      simulationDate: pick(DATES),
    };
  });
}

/** 57 rows, newest first: three pages at the default page size. */
export const PREVIEW_TRANSACTIONS: TransactionRow[] = makeRows(57);

// Completion rate over routed, allowed decisions only; rejected and failed
// rows are excluded, as the contract defines it (§3.8).
function completionRate(rows: TransactionRow[]): number | null {
  const eligible = rows.filter((r) => r.outcome === "completed" || r.outcome === "partial");
  return eligible.length ? eligible.filter((r) => r.outcome === "completed").length / eligible.length : null;
}

/** Dashboard figures computed from the preview rows, so both pages agree. */
export const PREVIEW_DASHBOARD: DashboardView = {
  totals: {
    transactions: PREVIEW_TRANSACTIONS.length,
    routed: PREVIEW_TRANSACTIONS.filter((r) => r.outcome !== "failed").length,
    failed: PREVIEW_TRANSACTIONS.filter((r) => r.outcome === "failed").length,
    rejectedByFeasibility: PREVIEW_TRANSACTIONS.filter((r) => r.outcome === "rejected").length,
  },
  byCorridor: CORRIDORS.map((corridor) => {
    const rows = PREVIEW_TRANSACTIONS.filter((r) => r.corridor === corridor);
    return { corridor, count: rows.length, completionRate: completionRate(rows) };
  }),
  byPolicy: (["waterfall", "cheapestFeasible", "ppoProjected"] as PolicyKey[]).map((policy) => {
    const rows = PREVIEW_TRANSACTIONS.filter((r) => r.policy === policy);
    return { policy, count: rows.length, completionRate: completionRate(rows) };
  }),
};

/**
 * Filters and pages the preview rows the way the server will. Like the
 * contract, `completed` never matches a failed row.
 */
export function queryPreviewTransactions(filters: HistoryFilters, page: number, pageSize: number) {
  const matches = PREVIEW_TRANSACTIONS.filter((r) => {
    if (filters.corridor && r.corridor !== filters.corridor) return false;
    if (filters.policy && r.policy !== filters.policy) return false;
    if (filters.stateMode && r.stateMode !== filters.stateMode) return false;
    if (filters.completed === true && r.outcome !== "completed") return false;
    if (filters.completed === false && !(r.outcome === "partial" || r.outcome === "rejected")) return false;
    const day = r.createdAt.slice(0, 10);
    if (filters.from && day < filters.from) return false;
    if (filters.to && day > filters.to) return false;
    return true;
  });
  const lastPage = Math.max(1, Math.ceil(matches.length / pageSize));
  const safePage = Math.min(page, lastPage);
  return {
    items: matches.slice((safePage - 1) * pageSize, safePage * pageSize),
    total: matches.length,
    page: safePage,
  };
}
