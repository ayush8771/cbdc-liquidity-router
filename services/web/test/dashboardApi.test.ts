import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, INVALID_RESPONSE, NETWORK_ERROR } from "../src/api/client";
import { isApiDashboardSummary, type ApiDashboardSummary } from "../src/api/types";
import {
  describeDashboardError,
  fetchDashboardSummary,
  fetchRecentTransactions,
  mapDashboardSummary,
  toDashboardApiQuery,
  toRecentRow,
} from "../src/features/dashboard/dashboardApi";
import type { TransactionSummaryView } from "../src/features/transactions/historyTypes";
import { fixtureSummary } from "./msw/dashboard";
import { fixtureRows } from "./msw/transactions";

const fixture = () => fixtureSummary() as unknown as ApiDashboardSummary;

function clientReturning(body: unknown) {
  const fetchImpl = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }),
  );
  return { api: createApiClient({ getToken: () => "t", fetchImpl }), fetchImpl };
}

describe("toDashboardApiQuery", () => {
  it("leaves out every unset filter (unbounded)", () => {
    expect(toDashboardApiQuery({})).toEqual({ from: undefined, to: undefined, corridor: undefined, policy: undefined });
  });

  it("sends the contract's names, with the dates as UTC-midnight timestamps (from included, to excluded)", () => {
    expect(toDashboardApiQuery({ corridor: "GBR->PHL", policy: "waterfall", from: "2026-11-01", to: "2026-11-03" })).toEqual({
      from: "2026-11-01T00:00:00.000Z",
      to: "2026-11-03T00:00:00.000Z",
      corridor: "GBR->PHL",
      policy: "waterfall",
    });
  });
});

describe("the contract's dashboard fixture", () => {
  it("passes the strict check", () => {
    expect(isApiDashboardSummary(fixture())).toBe(true);
  });
});

describe("mapDashboardSummary", () => {
  it("copies every field unchanged", () => {
    const raw = fixture();
    const view = mapDashboardSummary(raw);
    expect(view.window).toEqual(raw.window);
    expect(view.totals).toEqual(raw.totals);
    expect(view.byPolicy).toEqual(raw.byPolicy);
    expect(view.byCorridor).toEqual(raw.byCorridor);
    expect(view.note).toBe(raw.note);
  });

  it("keeps meanFeeCostPct as the percentage number it is: 1.563333 stays 1.563333", () => {
    const waterfall = mapDashboardSummary(fixture()).byPolicy.find((p) => p.policy === "waterfall")!;
    expect(waterfall.meanFeeCostPct).toBe(1.563333);
  });

  it("keeps null rates and means as null, and a real zero as zero", () => {
    const raw = fixture();
    raw.byPolicy[0] = {
      ...raw.byPolicy[0]!,
      allowedRouted: 0,
      completionRate: null,
      meanRewardAmountBased: null,
      meanFeeCostPct: null,
      meanLatencyTerm: null,
      meanRiskTerm: null,
    };
    raw.byPolicy[1] = { ...raw.byPolicy[1]!, completionRate: 0, meanRiskTerm: 0 };
    const view = mapDashboardSummary(raw);
    expect(view.byPolicy[0]).toMatchObject({ completionRate: null, meanFeeCostPct: null, meanRewardAmountBased: null });
    expect(view.byPolicy[1]).toMatchObject({ completionRate: 0, meanRiskTerm: 0 });
  });

  it("keeps an unbounded window as nulls", () => {
    const raw = fixture();
    raw.window = { from: null, to: null };
    expect(mapDashboardSummary(raw).window).toEqual({ from: null, to: null });
  });

  it("passes an unknown policy through as written (contract §1)", () => {
    const raw = fixture();
    raw.byPolicy[0] = { ...raw.byPolicy[0]!, policy: "someNewPolicy" };
    expect(mapDashboardSummary(raw).byPolicy[0]!.policy).toBe("someNewPolicy");
  });
});

describe("isApiDashboardSummary is strict", () => {
  /** A fresh fixture with one thing broken. */
  const broken = (change: (s: ApiDashboardSummary) => void) => {
    const s = fixture();
    change(s);
    return s;
  };

  it("accepts an empty summary: no transactions, no groups", () => {
    const empty = {
      window: { from: null, to: null },
      totals: { transactions: 0, routed: 0, failed: 0, rejectedByFeasibility: 0 },
      byPolicy: [],
      byCorridor: [],
      note: "n",
    };
    expect(isApiDashboardSummary(empty)).toBe(true);
  });

  it("accepts a group where nothing was allowed, with a null rate and null means", () => {
    const s = broken((x) => {
      x.byPolicy[0] = {
        ...x.byPolicy[0]!,
        allowedRouted: 0,
        completionRate: null,
        meanRewardAmountBased: null,
        meanFeeCostPct: null,
        meanLatencyTerm: null,
        meanRiskTerm: null,
      };
    });
    expect(isApiDashboardSummary(s)).toBe(true);
  });

  it("accepts a null fee cost where decisions were allowed (none executed anything)", () => {
    expect(isApiDashboardSummary(broken((x) => (x.byPolicy[0]!.meanFeeCostPct = null)))).toBe(true);
  });

  it("ignores extra fields", () => {
    const s = { ...fixture(), extra: 1 } as unknown;
    expect(isApiDashboardSummary(s)).toBe(true);
  });

  it.each([
    ["null", () => null],
    ["no window", () => ({ ...fixture(), window: undefined })],
    ["a window bound that is a number", () => broken((s) => ((s.window as unknown as Record<string, unknown>).from = 5))],
    ["no totals", () => ({ ...fixture(), totals: undefined })],
    ["a count that is a string", () => broken((s) => ((s.totals as unknown as Record<string, unknown>).routed = "6"))],
    ["a negative count", () => broken((s) => (s.byPolicy[0]!.count = -1))],
    ["a fractional count", () => broken((s) => (s.byCorridor[0]!.routed = 1.5))],
    ["routed + failed that isn't the total", () => broken((s) => (s.totals.failed = 5))],
    ["more rejected than routed", () => broken((s) => (s.totals.rejectedByFeasibility = 99))],
    ["a completion rate above 1", () => broken((s) => (s.byPolicy[0]!.completionRate = 1.2))],
    ["a negative completion rate", () => broken((s) => (s.byCorridor[0]!.completionRate = -0.1))],
    ["a completion rate where nothing was allowed", () => broken((s) => (s.byCorridor[0]!.allowedRouted = 0))],
    [
      "no completion rate where decisions were allowed",
      () => broken((s) => (s.byPolicy[0]!.completionRate = null)),
    ],
    [
      "a mean where nothing was allowed",
      () =>
        broken((s) => {
          s.byPolicy[0] = { ...s.byPolicy[0]!, allowedRouted: 0, completionRate: null };
        }),
    ],
    ["more allowed-routed decisions than requests", () => broken((s) => (s.byPolicy[0]!.allowedRouted = 99))],
    ["more allowed-routed decisions than routed ones", () => broken((s) => (s.byCorridor[0]!.allowedRouted = 99))],
    ["a negative fee cost", () => broken((s) => (s.byPolicy[0]!.meanFeeCostPct = -1))],
    ["a mean that is not finite", () => broken((s) => (s.byPolicy[0]!.meanLatencyTerm = Number.NaN))],
    ["a policy listed twice", () => broken((s) => (s.byPolicy[1]!.policy = s.byPolicy[0]!.policy))],
    ["a corridor listed twice", () => broken((s) => (s.byCorridor[1]!.corridor = s.byCorridor[0]!.corridor))],
    ["no note", () => ({ ...fixture(), note: undefined })],
    ["byPolicy that is not a list", () => ({ ...fixture(), byPolicy: {} })],
  ])("rejects %s", (_name, make) => {
    expect(isApiDashboardSummary(make())).toBe(false);
  });
});

describe("fetchDashboardSummary", () => {
  it("asks for /dashboard/summary with the filters, and maps the body", async () => {
    const { api, fetchImpl } = clientReturning(fixtureSummary());
    const view = await fetchDashboardSummary(api, { corridor: "GBR->PHL", from: "2026-11-01" });
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.pathname).toBe("/api/v1/dashboard/summary");
    expect(Object.fromEntries(url.searchParams)).toEqual({ corridor: "GBR->PHL", from: "2026-11-01T00:00:00.000Z" });
    expect(view.totals.transactions).toBe(7);
  });

  it("refuses a body that isn't a summary, and one that contradicts itself", async () => {
    const contradictory = fixtureSummary();
    contradictory.totals.failed = 5;
    for (const body of [{ hello: "world" }, [], contradictory]) {
      await expect(fetchDashboardSummary(clientReturning(body).api, {})).rejects.toMatchObject({ code: INVALID_RESPONSE });
    }
  });
});

describe("recent transactions", () => {
  const view = (overrides: Partial<TransactionSummaryView> = {}): TransactionSummaryView => ({
    id: "id-1",
    createdAt: "2026-11-02T10:00:00Z",
    corridor: "GBR->PHL",
    amountUsd: 300000,
    simulationDate: "2024-06-14",
    stateMode: "historicalReplay",
    policy: "waterfall",
    policyStatus: "default",
    status: "routed",
    allowed: true,
    completed: true,
    completionRatio: 1,
    executedUsd: 300000,
    ...overrides,
  });

  it("shapes a history row for the list, with the outcome derived as the History derives it", () => {
    expect(toRecentRow(view())).toEqual({
      id: "id-1",
      createdAt: "2026-11-02T10:00:00Z",
      corridor: "GBR->PHL",
      amountUsd: 300000,
      policy: "waterfall",
      policyTier: "default",
      outcome: "completed",
      stateMode: "historicalReplay",
      simulationDate: "2024-06-14",
    });
    expect(toRecentRow(view({ completed: false })).outcome).toBe("partial");
    expect(toRecentRow(view({ allowed: false, completed: false })).outcome).toBe("rejected");
    expect(toRecentRow(view({ status: "failed", corridor: null, policyStatus: null, allowed: null, completed: null })).outcome).toBe("failed");
  });

  it("asks the History's own request for the first page of five, with no filters", async () => {
    const { api, fetchImpl } = clientReturning({ items: fixtureRows(), page: 1, pageSize: 5, total: 7 });
    const rows = await fetchRecentTransactions(api, 5);
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.pathname).toBe("/api/v1/transactions");
    expect([...url.searchParams.entries()]).toEqual([
      ["page", "1"],
      ["pageSize", "5"],
    ]);
    expect(rows).toHaveLength(5);
    expect(rows[0]!.id).toBe(fixtureRows()[0]!.id);
  });

  it("refuses a body that isn't a transaction page", async () => {
    await expect(fetchRecentTransactions(clientReturning({ items: "x" }).api, 5)).rejects.toMatchObject({ code: INVALID_RESPONSE });
  });
});

describe("describeDashboardError", () => {
  const api = (status: number, code: string, extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {}) =>
    new ApiError({ status, code, message: "BACKEND TEXT", ...extra });

  it("words every case itself, never with the backend's message", () => {
    for (const error of [api(0, NETWORK_ERROR), api(200, INVALID_RESPONSE), api(500, "INTERNAL_ERROR"), api(403, "X"), api(422, "VALIDATION_ERROR"), api(418, "TEAPOT")]) {
      expect(describeDashboardError(error).message).not.toContain("BACKEND TEXT");
    }
  });

  it("offers a retry except for a 403 or a rejected request", () => {
    expect(describeDashboardError(api(500, "INTERNAL_ERROR")).canRetry).toBe(true);
    expect(describeDashboardError(api(0, NETWORK_ERROR)).canRetry).toBe(true);
    expect(describeDashboardError(api(200, INVALID_RESPONSE)).canRetry).toBe(true);
    expect(describeDashboardError(api(403, "X")).canRetry).toBe(false);
    expect(describeDashboardError(api(422, "VALIDATION_ERROR")).canRetry).toBe(false);
  });

  it("lists a 422's fields, carries the request ID, and copes with an error that isn't an ApiError", () => {
    const view = describeDashboardError(
      api(422, "VALIDATION_ERROR", { requestId: "req-1", details: { errors: [{ field: "from", message: "bad" }, { message: "Form-level." }] } }),
    );
    expect(view.details).toEqual(["from: bad", "Form-level."]);
    expect(view.reference).toBe("req-1");
    expect(describeDashboardError(new Error("x")).message).toMatch(/went wrong/);
  });
});
