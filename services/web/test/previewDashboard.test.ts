import { describe, expect, it } from "vitest";
import { toWindow } from "../src/features/dashboard/dashboardQuery";
import { PREVIEW_DASHBOARD, PREVIEW_TRANSACTIONS } from "../src/preview/previewData";
import { queryPreviewDashboard } from "../src/preview/previewDashboard";

const ALL = { from: null, to: null };
const all = () => queryPreviewDashboard({ window: ALL });
const allowed = (rows: typeof PREVIEW_TRANSACTIONS) => rows.filter((r) => r.outcome === "completed" || r.outcome === "partial");

describe("queryPreviewDashboard: unbounded window", () => {
  const summary = all();

  it("echoes an unbounded window as nulls", () => {
    expect(summary.window).toEqual({ from: null, to: null });
  });

  it("counts every preview transaction", () => {
    expect(summary.totals.transactions).toBe(PREVIEW_TRANSACTIONS.length);
    expect(summary.totals.routed + summary.totals.failed).toBe(summary.totals.transactions);
    expect(summary.totals.rejectedByFeasibility).toBe(PREVIEW_TRANSACTIONS.filter((r) => r.outcome === "rejected").length);
    expect(summary.totals.rejectedByFeasibility).toBeLessThanOrEqual(summary.totals.routed);
  });

  it("agrees with the narrow dashboard's preview figures, which it doesn't replace", () => {
    expect(summary.totals).toEqual(PREVIEW_DASHBOARD.totals);
    for (const p of PREVIEW_DASHBOARD.byPolicy) {
      const row = summary.byPolicy.find((x) => x.policy === p.policy)!;
      expect(row.count).toBe(p.count);
      expect(row.completionRate).toBe(p.completionRate);
    }
    for (const c of PREVIEW_DASHBOARD.byCorridor) {
      const row = summary.byCorridor.find((x) => x.corridor === c.corridor)!;
      expect(row.routed).toBe(c.count);
      expect(row.completionRate).toBe(c.completionRate);
    }
  });

  it("counts every request in a policy's count, failed and rejected included", () => {
    expect(summary.byPolicy.reduce((s, p) => s + p.count, 0)).toBe(summary.totals.transactions);
    for (const p of summary.byPolicy) {
      const own = PREVIEW_TRANSACTIONS.filter((r) => r.policy === p.policy);
      expect(p.count).toBe(own.length);
      expect(p.allowedRouted).toBe(allowed(own).length);
    }
  });

  it("keeps count and allowedRouted different: failed and rejected requests are in one and not the other", () => {
    expect(summary.byPolicy.some((p) => p.count !== p.allowedRouted)).toBe(true);
    for (const p of summary.byPolicy) expect(p.allowedRouted).toBeLessThanOrEqual(p.count);
  });

  it("computes the completion rate over allowedRouted, not over count", () => {
    for (const p of summary.byPolicy) {
      const own = allowed(PREVIEW_TRANSACTIONS.filter((r) => r.policy === p.policy));
      const completed = own.filter((r) => r.outcome === "completed").length;
      expect(p.completionRate).toBe(own.length === 0 ? null : completed / own.length);
    }
  });

  it("counts a corridor's routed decisions without failed transactions, which have no corridor", () => {
    expect(summary.byCorridor.reduce((s, c) => s + c.routed, 0)).toBe(summary.totals.routed);
    for (const c of summary.byCorridor) {
      expect(c.allowedRouted).toBeLessThanOrEqual(c.routed);
      expect(c.routed).toBe(PREVIEW_TRANSACTIONS.filter((r) => r.corridor === c.corridor).length);
    }
  });

  it("leaves all five mean fields null: the preview data has nothing to average", () => {
    expect(summary.byPolicy.length).toBeGreaterThan(0);
    for (const p of summary.byPolicy) {
      expect(p.meanRewardAmountBased).toBeNull();
      expect(p.meanFeeCostPct).toBeNull();
      expect(p.meanLatencyTerm).toBeNull();
      expect(p.meanRiskTerm).toBeNull();
    }
  });

  it("carries a note that says it is illustrative", () => {
    expect(summary.note).toMatch(/illustrative/i);
  });
});

describe("queryPreviewDashboard: filters", () => {
  it("filters by policy", () => {
    const own = PREVIEW_TRANSACTIONS.filter((r) => r.policy === "cheapestFeasible");
    const summary = queryPreviewDashboard({ window: ALL, policy: "cheapestFeasible" });
    expect(summary.totals.transactions).toBe(own.length);
    expect(summary.byPolicy.map((p) => p.policy)).toEqual(["cheapestFeasible"]);
  });

  it("filters by corridor, which leaves out failed transactions: they have no corridor", () => {
    const own = PREVIEW_TRANSACTIONS.filter((r) => r.corridor === "GBR->PHL");
    const summary = queryPreviewDashboard({ window: ALL, corridor: "GBR->PHL" });
    expect(summary.totals.transactions).toBe(own.length);
    expect(summary.totals.failed).toBe(0);
    expect(summary.byCorridor.map((c) => c.corridor)).toEqual(["GBR->PHL"]);
  });

  it("combines the filters", () => {
    const own = PREVIEW_TRANSACTIONS.filter((r) => r.corridor === "ARE->MEX" && r.policy === "waterfall");
    const summary = queryPreviewDashboard({ window: ALL, corridor: "ARE->MEX", policy: "waterfall" });
    expect(summary.totals.transactions).toBe(own.length);
  });
});

describe("queryPreviewDashboard: windows", () => {
  const rows = PREVIEW_TRANSACTIONS; // newest first
  const at = (i: number) => rows[i]!.createdAt;

  it("includes a transaction created exactly at `from`", () => {
    const summary = queryPreviewDashboard({ window: { from: at(10), to: null } });
    expect(summary.totals.transactions).toBe(11); // rows 0..10: newest first
  });

  it("excludes a transaction created exactly at `to`", () => {
    const summary = queryPreviewDashboard({ window: { from: null, to: at(10) } });
    expect(summary.totals.transactions).toBe(rows.length - 10 - 1); // rows 11.. only
  });

  it("is empty when from equals to", () => {
    expect(queryPreviewDashboard({ window: { from: at(5), to: at(5) } }).totals.transactions).toBe(0);
  });

  it("applies a date window in UTC", () => {
    const window = toWindow({ from: "2026-11-03", to: "2026-11-04" });
    const expected = rows.filter((r) => r.createdAt >= "2026-11-03T00:00:00.000Z" && r.createdAt < "2026-11-04T00:00:00.000Z");
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(rows.length);
    const summary = queryPreviewDashboard({ window });
    expect(summary.totals.transactions).toBe(expected.length);
    expect(summary.window).toEqual(window);
  });

  it("returns an empty summary, with empty lists and zero totals, for a window with no transactions", () => {
    const window = toWindow({ from: "2000-01-01", to: "2000-01-02" });
    const summary = queryPreviewDashboard({ window });
    expect(summary.totals).toEqual({ transactions: 0, routed: 0, failed: 0, rejectedByFeasibility: 0 });
    expect(summary.byPolicy).toEqual([]);
    expect(summary.byCorridor).toEqual([]);
    expect(summary.window).toEqual(window);
  });

  it("reports a null completion rate, never 0, when nothing was allowed", () => {
    // The newest transactions by outcome: find a policy whose rows are all rejected or failed in some narrow window.
    const rejectedOnly = rows.findIndex((r) => r.outcome === "rejected");
    const window = { from: at(rejectedOnly), to: new Date(Date.parse(at(rejectedOnly)) + 1).toISOString() };
    const summary = queryPreviewDashboard({ window });
    expect(summary.totals.transactions).toBe(1);
    expect(summary.byPolicy[0]!.allowedRouted).toBe(0);
    expect(summary.byPolicy[0]!.completionRate).toBeNull();
    expect(summary.byCorridor[0]!.completionRate).toBeNull();
  });
});
