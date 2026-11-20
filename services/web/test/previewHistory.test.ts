import { describe, expect, it } from "vitest";
import { outcomeOf } from "../src/features/transactions/historyTypes";
import { toHistoryWindow } from "../src/features/transactions/historyQuery";
import { PREVIEW_TRANSACTIONS } from "../src/preview/previewData";
import { getPreviewTransactionDetail } from "../src/preview/previewDetail";
import { queryPreviewHistory, toSummary } from "../src/preview/previewHistory";

const UNBOUNDED = { from: null, to: null };
const base = { window: UNBOUNDED, page: 1, pageSize: 100 };
const ids = (items: { id: string }[]) => items.map((i) => i.id);
const rowsWhere = (predicate: (r: (typeof PREVIEW_TRANSACTIONS)[number]) => boolean) => PREVIEW_TRANSACTIONS.filter(predicate);

describe("queryPreviewHistory: paging", () => {
  it("pages 57 transactions as 20, 20 and 17", () => {
    const sizes = [1, 2, 3].map((page) => queryPreviewHistory({ ...base, page, pageSize: 20 }).items.length);
    expect(sizes).toEqual([20, 20, 17]);
  });

  it("reports the total and the paging it was asked for", () => {
    expect(queryPreviewHistory({ ...base, page: 2, pageSize: 20 })).toMatchObject({ page: 2, pageSize: 20, total: 57 });
  });

  it("pages 50 at a time as 50 and 7, and 100 at a time as one page", () => {
    expect(queryPreviewHistory({ ...base, page: 1, pageSize: 50 }).items).toHaveLength(50);
    expect(queryPreviewHistory({ ...base, page: 2, pageSize: 50 }).items).toHaveLength(7);
    expect(queryPreviewHistory({ ...base, page: 1, pageSize: 100 }).items).toHaveLength(57);
    expect(queryPreviewHistory({ ...base, page: 2, pageSize: 100 }).items).toHaveLength(0);
  });

  it("gives every transaction once, newest first, across the pages", () => {
    const all = [1, 2, 3].flatMap((page) => ids(queryPreviewHistory({ ...base, page, pageSize: 20 }).items));
    expect(all).toEqual(ids(PREVIEW_TRANSACTIONS));
    expect(new Set(all).size).toBe(57);
    const times = queryPreviewHistory(base).items.map((i) => Date.parse(i.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("returns an empty page, with the real total, for a page past the last", () => {
    const result = queryPreviewHistory({ ...base, page: 99, pageSize: 20 });
    expect(result.items).toEqual([]);
    expect(result.total).toBe(57);
  });

  it("pages within a filtered result", () => {
    const own = rowsWhere((r) => r.corridor === "ARE->MEX");
    expect(own.length).toBeGreaterThan(20);
    const first = queryPreviewHistory({ ...base, corridor: "ARE->MEX", page: 1, pageSize: 20 });
    const second = queryPreviewHistory({ ...base, corridor: "ARE->MEX", page: 2, pageSize: 20 });
    expect(first.total).toBe(own.length);
    expect(ids(first.items).concat(ids(second.items))).toEqual(ids(own.map((r) => ({ id: r.id }))));
  });
});

describe("queryPreviewHistory: filters follow the contract", () => {
  it("filters by corridor, which never matches a failed transaction", () => {
    const result = queryPreviewHistory({ ...base, corridor: "GBR->PHL" });
    expect(result.total).toBe(rowsWhere((r) => r.corridor === "GBR->PHL").length);
    expect(result.items.every((i) => i.corridor === "GBR->PHL" && i.status === "routed")).toBe(true);
  });

  it("filters by policy, which includes failed transactions", () => {
    const own = rowsWhere((r) => r.policy === "cheapestFeasible");
    const result = queryPreviewHistory({ ...base, policy: "cheapestFeasible" });
    expect(result.total).toBe(own.length);
    expect(result.items.some((i) => i.status === "failed")).toBe(own.some((r) => r.outcome === "failed"));
  });

  it("filters by state mode", () => {
    const result = queryPreviewHistory({ ...base, stateMode: "explicit" });
    expect(result.total).toBe(rowsWhere((r) => r.stateMode === "explicit").length);
    expect(result.items.every((i) => i.stateMode === "explicit")).toBe(true);
  });

  it("filters completed=true to completed transactions only", () => {
    const result = queryPreviewHistory({ ...base, completed: true });
    expect(result.total).toBe(rowsWhere((r) => r.outcome === "completed").length);
    expect(result.items.every((i) => i.completed === true)).toBe(true);
  });

  it("filters completed=false to partial and rejected transactions, never failed ones", () => {
    const result = queryPreviewHistory({ ...base, completed: false });
    expect(result.total).toBe(rowsWhere((r) => r.outcome === "partial" || r.outcome === "rejected").length);
    expect(result.items.every((i) => i.status === "routed" && i.completed === false)).toBe(true);
  });

  it("never matches a failed transaction with either completed value", () => {
    const failed = rowsWhere((r) => r.outcome === "failed").length;
    expect(failed).toBeGreaterThan(0);
    const both = queryPreviewHistory({ ...base, completed: true }).total + queryPreviewHistory({ ...base, completed: false }).total;
    expect(both).toBe(57 - failed);
  });

  it("combines filters", () => {
    const own = rowsWhere((r) => r.corridor === "GBR->PHL" && r.policy === "waterfall" && r.outcome === "completed");
    const result = queryPreviewHistory({ ...base, corridor: "GBR->PHL", policy: "waterfall", completed: true });
    expect(ids(result.items)).toEqual(ids(own));
  });

  it("returns nothing for filters that exclude everything", () => {
    // The only transactions with no corridor are failed, and a failed one has no decision.
    const result = queryPreviewHistory({ ...base, corridor: "GBR->PHL", completed: false, policy: "ppoProjected", stateMode: "scenario" });
    expect(result.total).toBe(
      rowsWhere((r) => r.corridor === "GBR->PHL" && (r.outcome === "partial" || r.outcome === "rejected") && r.policy === "ppoProjected" && r.stateMode === "scenario").length,
    );
  });
});

describe("queryPreviewHistory: the date window", () => {
  const at = (i: number) => PREVIEW_TRANSACTIONS[i]!.createdAt; // newest first

  it("includes a transaction created exactly at `from`", () => {
    expect(queryPreviewHistory({ ...base, window: { from: at(10), to: null } }).total).toBe(11);
  });

  it("excludes a transaction created exactly at `to`", () => {
    expect(queryPreviewHistory({ ...base, window: { from: null, to: at(10) } }).total).toBe(57 - 11);
  });

  it("is empty when from equals to", () => {
    expect(queryPreviewHistory({ ...base, window: { from: at(5), to: at(5) } }).total).toBe(0);
  });

  it("includes `from`'s day and leaves out `to`'s day, in UTC", () => {
    const window = toHistoryWindow({ from: "2026-11-02", to: "2026-11-03" });
    const own = rowsWhere((r) => r.createdAt >= "2026-11-02T00:00:00.000Z" && r.createdAt < "2026-11-03T00:00:00.000Z");
    expect(own.length).toBeGreaterThan(0);
    expect(own.length).toBeLessThan(57);
    const result = queryPreviewHistory({ ...base, window });
    expect(ids(result.items)).toEqual(ids(own));
    // The day after `to` is not included, and nor is `to`'s own day.
    expect(result.items.every((i) => i.createdAt.startsWith("2026-11-02"))).toBe(true);
  });

  it("gives the whole of a day when the window is that day and the next", () => {
    const day1 = queryPreviewHistory({ ...base, window: toHistoryWindow({ from: "2026-11-01", to: "2026-11-02" }) });
    const day2 = queryPreviewHistory({ ...base, window: toHistoryWindow({ from: "2026-11-02", to: "2026-11-03" }) });
    const day3 = queryPreviewHistory({ ...base, window: toHistoryWindow({ from: "2026-11-03", to: "2026-11-04" }) });
    expect(day1.total + day2.total + day3.total).toBe(57);
  });

  it("is empty for a window with no transactions", () => {
    expect(queryPreviewHistory({ ...base, window: toHistoryWindow({ from: "2000-01-01", to: "2000-01-02" }) }).total).toBe(0);
  });
});

describe("toSummary", () => {
  const all = PREVIEW_TRANSACTIONS.map(toSummary);

  it("keeps every row's outcome: the summary's status, allowed and completed give the same outcome", () => {
    all.forEach((summary, i) => expect(outcomeOf(summary)).toBe(PREVIEW_TRANSACTIONS[i]!.outcome));
  });

  it("covers all four outcomes", () => {
    expect(new Set(all.map(outcomeOf))).toEqual(new Set(["completed", "partial", "rejected", "failed"]));
  });

  it("leaves every decision-derived field null for a failed transaction", () => {
    const failed = all.filter((s) => s.status === "failed");
    expect(failed.length).toBeGreaterThan(0);
    for (const s of failed) {
      expect(s.corridor).toBeNull();
      expect(s.policyStatus).toBeNull();
      expect(s.allowed).toBeNull();
      expect(s.completed).toBeNull();
      expect(s.completionRatio).toBeNull();
      expect(s.executedUsd).toBeNull();
      expect(s.policy).toBeTruthy(); // the requested policy is still there
    }
  });

  it("shows a rejection as executing nothing: zero, not missing", () => {
    const rejected = all.filter((s) => outcomeOf(s) === "rejected");
    expect(rejected.length).toBeGreaterThan(0);
    for (const s of rejected) {
      expect(s.allowed).toBe(false);
      expect(s.executedUsd).toBe(0);
      expect(s.completionRatio).toBe(0);
    }
  });

  it("gives a partial transaction an executed amount below the amount, and its share", () => {
    const partial = all.filter((s) => outcomeOf(s) === "partial");
    expect(partial.length).toBeGreaterThan(0);
    for (const s of partial) {
      expect(s.allowed).toBe(true);
      expect(s.completed).toBe(false);
      expect(s.executedUsd!).toBeGreaterThan(0);
      expect(s.executedUsd!).toBeLessThan(s.amountUsd);
      expect(s.completionRatio!).toBeGreaterThan(0);
      expect(s.completionRatio!).toBeLessThan(1);
      expect(s.completionRatio!).toBeCloseTo(s.executedUsd! / s.amountUsd, 9);
    }
  });

  it("gives a completed transaction the whole amount", () => {
    for (const s of all.filter((x) => outcomeOf(x) === "completed")) {
      expect(s.executedUsd).toBe(s.amountUsd);
      expect(s.completionRatio).toBe(1);
    }
  });

  it("takes the executed figures from the detail preview, joined by ID", () => {
    for (const s of all.filter((x) => x.status === "routed")) {
      const totals = getPreviewTransactionDetail(s.id)!.decision!.totals;
      expect(s.executedUsd).toBe(totals.executedUsd);
      expect(s.completionRatio).toBe(totals.completionRatio);
    }
  });

  it("agrees with the detail on status, allowed and completed", () => {
    for (const s of all.filter((x) => x.status === "routed")) {
      const decision = getPreviewTransactionDetail(s.id)!.decision!;
      expect(s.allowed).toBe(decision.feasibility.allowed);
      expect(s.completed).toBe(decision.totals.completed);
    }
  });

  it("uses nulls, not made-up values, when a transaction has no detail to join", () => {
    const orphan = toSummary({ ...PREVIEW_TRANSACTIONS.find((r) => r.outcome === "partial")!, id: "00000000-0000-4000-8000-000000000000" });
    expect(orphan.executedUsd).toBeNull();
    expect(orphan.completionRatio).toBeNull();
    expect(outcomeOf(orphan)).toBe("partial"); // the status still comes from the row
  });
});

describe("outcomeOf", () => {
  it.each([
    [{ status: "failed", allowed: null, completed: null }, "failed"],
    [{ status: "routed", allowed: false, completed: false }, "rejected"],
    [{ status: "routed", allowed: true, completed: true }, "completed"],
    [{ status: "routed", allowed: true, completed: false }, "partial"],
  ] as const)("%j is %s", (row, outcome) => expect(outcomeOf(row)).toBe(outcome));
});
