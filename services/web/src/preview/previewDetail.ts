/*
 * PREVIEW DATA — illustrative details for the 57 preview transactions, for
 * reviewing the Transaction Detail layout before the shared API contracts are
 * merged. Not from the API, not copied from the shared fixtures, and not used
 * once integration starts: delete this file then, with ./previewData.ts.
 *
 * Venue fees, liquidity and shares are made up. They are built so each record
 * agrees with its row in the history list (same outcome, amount, policy) and
 * with itself: totals are summed from the allocations, executed never exceeds
 * what was requested or what the venue held, and unrouted is the amount minus
 * executed. Each record is seeded from its own ID, so it is stable and does not
 * depend on the order of the rows. This file never alters the rows.
 */
import { CORRIDORS } from "../features/transactions/filters";
import type {
  AllocationView,
  DataSourceTag,
  DecisionView,
  TransactionDetailView,
  WarningView,
} from "../features/transactions/detailTypes";
import type { TransactionRow } from "../features/transactions/types";
import { PREVIEW_TRANSACTIONS } from "./previewData";

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

/** FNV-1a: a stable seed from the transaction ID. */
function seedFrom(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

type PreviewVenue = { bridgeUid: string; feePct: number; tag: DataSourceTag };

/**
 * Cheapest first. Illustrative. `feePct` is a fraction, as the contract defines
 * it (0.012 is 1.2%); the page converts it to a percentage only for display.
 */
const VENUES: Record<string, PreviewVenue[]> = {
  "USA->IND": [
    { bridgeUid: "USA->IND#0", feePct: 0.012, tag: "real_static_bridge" },
    { bridgeUid: "USA->IND#1", feePct: 0.016, tag: "synthetic_bridge_expansion" },
  ],
  "GBR->PHL": [
    { bridgeUid: "GBR->PHL#0", feePct: 0.014, tag: "real_static_bridge" },
    { bridgeUid: "GBR->PHL#1", feePct: 0.019, tag: "synthetic_bridge_expansion" },
    { bridgeUid: "GBR->PHL#2", feePct: 0.023, tag: "synthetic_bridge_expansion" },
  ],
  "ARE->MEX": [
    { bridgeUid: "ARE->MEX#0", feePct: 0.015, tag: "synthetic_no_real_anchor" },
    { bridgeUid: "ARE->MEX#1", feePct: 0.021, tag: "synthetic_bridge_expansion" },
  ],
};

const FAILURES = [
  { code: "INFERENCE_UNAVAILABLE", message: "The inference service is unavailable." },
  { code: "ENGINE_BUSY", message: "Engine queue is full; retry later." },
  { code: "ENGINE_TIMEOUT", message: "The routing engine did not answer in time." },
  { code: "INFERENCE_ERROR", message: "The inference service returned an error." },
];

const up1k = (n: number) => Math.ceil(n / 1000) * 1000;
const down1k = (n: number) => Math.max(1000, Math.floor(n / 1000) * 1000);
const hex = (rand: () => number, n: number) =>
  Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");

function regimeFor(amount: number, liquidity: number[]): string {
  const cheapest = liquidity[0] ?? 0;
  const combined = liquidity.reduce((sum, l) => sum + l, 0);
  if (amount > combined) return "exceeds_combined";
  if (amount <= cheapest * 0.9) return "below_cheapest";
  if (amount <= cheapest * 1.1) return "near_boundary";
  return "splitting_needed";
}

/** What each venue holds and what the policy asks of it, by outcome. */
function plan(row: TransactionRow, venues: PreviewVenue[], rand: () => number) {
  const A = row.amountUsd;
  const n = venues.length;
  const weights = n === 3 ? [0.5, 0.3, 0.2] : [0.6, 0.4];
  const partial = row.outcome === "partial";
  const liquidity: number[] = new Array(n).fill(0);
  let requested: number[] = new Array(n).fill(0);

  if (row.policy === "waterfall") {
    if (partial) {
      const total = down1k(A * (0.4 + rand() * 0.45));
      weights.forEach((w, i) => (liquidity[i] = down1k(total * w)));
    } else if (rand() < 0.4) {
      liquidity[0] = up1k(A * (1.05 + rand() * 0.4));
      for (let i = 1; i < n; i += 1) liquidity[i] = up1k(A * (0.3 + rand() * 0.4));
    } else {
      liquidity[0] = down1k(A * (0.35 + rand() * 0.3));
      liquidity[1] = up1k((A - liquidity[0]) * (1.1 + rand() * 0.4));
      if (n === 3) liquidity[2] = up1k(A * (0.2 + rand() * 0.3));
    }
    // Fill the cheapest venue first, never past what it holds.
    let remaining = A;
    requested = liquidity.map((l) => {
      const take = Math.min(remaining, l);
      remaining -= take;
      return take;
    });
  } else if (row.policy === "cheapestFeasible") {
    // Asks the cheapest venue for everything, whatever it holds.
    requested[0] = A;
    liquidity[0] = partial ? down1k(A * (0.4 + rand() * 0.45)) : up1k(A * (1.05 + rand() * 0.35));
    for (let i = 1; i < n; i += 1) liquidity[i] = up1k(A * (0.3 + rand() * 0.4));
  } else {
    // Fixed shares, rounded to whole dollars with the last venue taking the remainder.
    let assigned = 0;
    weights.forEach((w, i) => {
      requested[i] = i === n - 1 ? A - assigned : Math.round(w * A);
      assigned += requested[i] ?? 0;
    });
    requested.forEach((r, i) => {
      liquidity[i] = partial ? down1k(r * (0.4 + rand() * 0.5)) : up1k(r * (1.05 + rand() * 0.35));
    });
  }
  return { liquidity, requested };
}

function buildDecision(row: TransactionRow, corridor: string, rand: () => number): DecisionView {
  const venues = VENUES[corridor] ?? [];
  const A = row.amountUsd;
  // The contract requires every decision to have a decision ID: "sha256:" and 64 hex digits.
  // The draw and the 64 digits below are consumed from `rand` exactly as they always were, so
  // every other preview value (liquidity, amounts, executed figures) stays exactly as it was.
  // A decision that used to get no ID now takes its digits from a separate stream, seeded from
  // the transaction's own ID, so it is stable and doesn't disturb `rand`.
  const keepsDrawnId = rand() >= 0.5;
  const decisionId = `sha256:${hex(keepsDrawnId ? rand : seeded(seedFrom(`${row.id}#decision-id`)), 64)}`;
  const warnings: WarningView[] = [];
  if (row.policy === "ppoProjected") {
    warnings.push({ code: "EXPERIMENTAL_POLICY", message: "ppoProjected is experimental." });
  }
  if (corridor === "ARE->MEX") {
    warnings.push({ code: "SYNTHETIC_COST_ANCHOR", message: "The cost baseline for this corridor is a synthetic anchor." });
  }

  if (row.outcome === "rejected") {
    return {
      decisionId,
      feasibility: {
        allowed: false,
        reason: "Transaction amount exceeds single transfer policy limit.",
        decisiveFactIds: ["preview.single_transfer_cap"],
        knowledgeVersion: "preview",
      },
      allocations: [],
      totals: {
        requestedUsd: 0,
        executedUsd: 0,
        unroutedAmountBasedUsd: A,
        completionRatio: 0,
        completed: false,
        bridgesUsed: 0,
      },
      regime: "splitting_needed",
      warnings,
    };
  }

  const { liquidity, requested } = plan(row, venues, rand);
  const allocations: AllocationView[] = venues.map((v, i) => {
    const req = requested[i] ?? 0;
    const liq = liquidity[i] ?? 0;
    const executed = Math.min(req, liq);
    return {
      bridgeUid: v.bridgeUid,
      dataSourceTag: v.tag,
      feePct: v.feePct,
      liquidityUsd: liq,
      shareRequested: req / A,
      amountRequestedUsd: req,
      amountExecutedUsd: executed,
      amountClippedUsd: req - executed,
    };
  });
  const executedUsd = allocations.reduce((sum, a) => sum + a.amountExecutedUsd, 0);
  const completionRatio = executedUsd / A;
  if (executedUsd < A) {
    warnings.push({
      code: "PARTIAL_COMPLETION",
      message: `Executed ${(completionRatio * 100).toFixed(1)}% of the amount; the rest is unrouted.`,
    });
  }
  return {
    decisionId,
    feasibility: { allowed: true, reason: null, decisiveFactIds: [], knowledgeVersion: "preview" },
    allocations,
    totals: {
      requestedUsd: allocations.reduce((sum, a) => sum + a.amountRequestedUsd, 0),
      executedUsd,
      unroutedAmountBasedUsd: A - executedUsd,
      completionRatio,
      completed: executedUsd === A,
      bridgesUsed: allocations.filter((a) => a.amountExecutedUsd > 0).length,
    },
    regime: regimeFor(A, liquidity),
    warnings,
  };
}

function buildDetail(row: TransactionRow): TransactionDetailView {
  const rand = seeded(seedFrom(row.id));
  const corridor = row.corridor ?? CORRIDORS[Math.floor(rand() * CORRIDORS.length)] ?? CORRIDORS[0];
  const [senderCountry = "", receiverCountry = ""] = corridor.split("->");
  const failed = row.outcome === "failed";
  const failure = failed ? (FAILURES[Math.floor(rand() * FAILURES.length)] ?? null) : null;

  return {
    id: row.id,
    createdAt: row.createdAt,
    status: failed ? "failed" : "routed",
    outcome: row.outcome,
    // A failed transaction has no confirmed corridor, even though it had countries.
    corridor: row.corridor,
    senderCountry,
    receiverCountry,
    amountUsd: row.amountUsd,
    simulationDate: row.simulationDate,
    stateMode: row.stateMode,
    policy: row.policy,
    policyTier: row.policyTier,
    clientReference: rand() < 0.3 ? `PO-${Math.floor(1000 + rand() * 9000)}` : null,
    failure,
    decision: failed ? null : buildDecision(row, corridor, rand),
  };
}

export const PREVIEW_TRANSACTION_DETAILS: TransactionDetailView[] = PREVIEW_TRANSACTIONS.map(buildDetail);

const BY_ID = new Map(PREVIEW_TRANSACTION_DETAILS.map((d) => [d.id, d]));

/** The preview detail for an ID, or undefined, as the API would answer 404. */
export function getPreviewTransactionDetail(id: string): TransactionDetailView | undefined {
  return BY_ID.get(id);
}
