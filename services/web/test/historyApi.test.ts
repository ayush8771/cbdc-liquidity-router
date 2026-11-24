import { describe, expect, it } from "vitest";
import { ApiError, INVALID_RESPONSE, NETWORK_ERROR } from "../src/api/client";
import { isTransactionPage, type TransactionPage, type TransactionSummary } from "../src/api/types";
import { describeHistoryError, mapTransactionPage, toApiQuery } from "../src/features/transactions/historyApi";
import { DEFAULT_PAGE_SIZE, type HistoryQuery } from "../src/features/transactions/historyQuery";
import { outcomeOf } from "../src/features/transactions/historyTypes";
import { fixtureRows } from "./msw/transactions";

const row = (overrides: Partial<TransactionSummary> = {}): TransactionSummary => ({
  ...(fixtureRows()[0] as unknown as TransactionSummary),
  ...overrides,
});
const page = (items: TransactionSummary[]): TransactionPage => ({ items, page: 1, pageSize: 20, total: items.length });

describe("toApiQuery", () => {
  it("always sends page and pageSize, and nothing for an unset filter", () => {
    const query: HistoryQuery = { page: 1, pageSize: DEFAULT_PAGE_SIZE };
    expect(toApiQuery(query)).toEqual({
      page: 1,
      pageSize: 20,
      corridor: undefined,
      policy: undefined,
      stateMode: undefined,
      completed: undefined,
      from: undefined,
      to: undefined,
    });
  });

  it("sends the contract's names, and the dates as UTC midnight timestamps (from included, to excluded)", () => {
    const query: HistoryQuery = {
      page: 3,
      pageSize: 50,
      corridor: "GBR->PHL",
      policy: "cheapestFeasible",
      stateMode: "scenario",
      completed: false,
      from: "2026-11-01",
      to: "2026-11-03",
    };
    expect(toApiQuery(query)).toEqual({
      page: 3,
      pageSize: 50,
      corridor: "GBR->PHL",
      policy: "cheapestFeasible",
      stateMode: "scenario",
      completed: false,
      from: "2026-11-01T00:00:00.000Z",
      to: "2026-11-03T00:00:00.000Z",
    });
  });

  it("has no sort or status parameter (the contract has no status filter, and one sort)", () => {
    expect(Object.keys(toApiQuery({ page: 1, pageSize: 20 }))).not.toContain("sort");
    expect(Object.keys(toApiQuery({ page: 1, pageSize: 20 }))).not.toContain("status");
  });
});

describe("mapTransactionPage", () => {
  it("copies the fields the table shows, and the paging numbers", () => {
    const mapped = mapTransactionPage({ items: fixtureRows() as unknown as TransactionSummary[], page: 2, pageSize: 50, total: 120 });
    expect(mapped.page).toBe(2);
    expect(mapped.pageSize).toBe(50);
    expect(mapped.total).toBe(120);
    expect(mapped.items[0]).toEqual({
      id: "56d0d708-62d6-59aa-aa8d-4df8d9b8d37f",
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
    });
  });

  it("keeps every decision-derived null of a failed transaction as null, never zero", () => {
    const failed = mapTransactionPage(
      page([row({ status: "failed", corridor: null, policyStatus: null, allowed: null, completed: null, completionRatio: null, executedUsd: null })]),
    ).items[0]!;
    expect(failed).toMatchObject({ status: "failed", corridor: null, policyStatus: null, allowed: null, completed: null, completionRatio: null, executedUsd: null });
    expect(outcomeOf(failed)).toBe("failed");
  });

  it("derives the outcome the way the History defines it: rejected, partial, completed", () => {
    const [done, partial, rejected] = mapTransactionPage(
      page([
        row(),
        row({ completed: false, completionRatio: 0.5, executedUsd: 150000 }),
        row({ allowed: false, completed: false, completionRatio: 0, executedUsd: 0 }),
      ]),
    ).items;
    expect([done, partial, rejected].map((r) => outcomeOf(r!))).toEqual(["completed", "partial", "rejected"]);
    expect(rejected!.executedUsd).toBe(0); // zero is a real value
  });

  it("passes an unknown enum value through unchanged instead of rejecting the page (contract §1)", () => {
    const [item] = mapTransactionPage(page([row({ policy: "someNewPolicy", stateMode: "futureMode", policyStatus: "gold" })])).items;
    expect(item).toMatchObject({ policy: "someNewPolicy", stateMode: "futureMode", policyStatus: "gold" });
  });

  it("does not carry fields the table doesn't show", () => {
    const [item] = mapTransactionPage(page([row({ createdBy: "u-1", rewardAmountBased: -0.2 })])).items;
    expect(item).not.toHaveProperty("createdBy");
    expect(item).not.toHaveProperty("rewardAmountBased");
  });
});

describe("isTransactionPage", () => {
  const ok = { items: fixtureRows(), page: 1, pageSize: 20, total: 7 };

  it("accepts the contract fixture, extra fields, and a page without the unused fields", () => {
    expect(isTransactionPage(ok)).toBe(true);
    expect(isTransactionPage({ ...ok, extra: true, items: fixtureRows().map((r) => ({ ...r, extra: 1 })) })).toBe(true);
    const slim = fixtureRows().map((r) => {
      const { createdBy, rewardAmountBased, ...rest } = r;
      void createdBy;
      void rewardAmountBased;
      return rest;
    });
    expect(isTransactionPage({ ...ok, items: slim })).toBe(true);
  });

  it.each([
    ["null", null],
    ["no items", { page: 1, pageSize: 20, total: 0 }],
    ["items that is not a list", { ...ok, items: "x" }],
    ["a fractional total", { ...ok, total: 1.5 }],
    ["a missing page", { items: [], pageSize: 20, total: 0 }],
    ["an amount that is a string", { ...ok, items: [{ ...fixtureRows()[0], amountUsd: "300000" }] }],
    ["an undefined (missing) nullable field", { ...ok, items: [{ ...fixtureRows()[0], executedUsd: undefined }] }],
    ["a row that is not an object", { ...ok, items: [1] }],
  ])("rejects %s", (_name, value) => {
    expect(isTransactionPage(value)).toBe(false);
  });
});

describe("describeHistoryError", () => {
  const api = (status: number, code: string, extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {}) =>
    new ApiError({ status, code, message: "BACKEND TEXT", ...extra });

  it("words each case itself, never with the backend's message", () => {
    for (const error of [api(0, NETWORK_ERROR), api(200, INVALID_RESPONSE), api(500, "INTERNAL_ERROR"), api(403, "FORBIDDEN_POLICY"), api(418, "TEAPOT")]) {
      expect(describeHistoryError(error).message).not.toContain("BACKEND TEXT");
    }
    expect(describeHistoryError(api(0, NETWORK_ERROR)).message).toMatch(/could not be reached/);
    expect(describeHistoryError(api(200, INVALID_RESPONSE)).message).toMatch(/couldn't read/);
    expect(describeHistoryError(api(503, "INFERENCE_UNAVAILABLE")).message).toMatch(/unexpected error/);
    expect(describeHistoryError(api(403, "FORBIDDEN_POLICY")).message).toMatch(/don't have access/);
    expect(describeHistoryError(api(404, "NOT_FOUND")).message).toContain("NOT_FOUND");
  });

  it("lists a 422's field messages, and a form-level one without a field", () => {
    const view = describeHistoryError(
      api(422, "VALIDATION_ERROR", { details: { errors: [{ field: "pageSize", message: "must be at most 100" }, { message: "Form-level." }] } }),
    );
    expect(view.message).toMatch(/didn't accept these filters/);
    expect(view.details).toEqual(["pageSize: must be at most 100", "Form-level."]);
  });

  it("carries the request ID as the reference, and copes with an error that isn't an ApiError", () => {
    expect(describeHistoryError(api(500, "INTERNAL_ERROR", { requestId: "req-9" })).reference).toBe("req-9");
    expect(describeHistoryError(api(500, "INTERNAL_ERROR")).reference).toBeUndefined();
    expect(describeHistoryError(new Error("x")).message).toMatch(/went wrong/);
  });
});
