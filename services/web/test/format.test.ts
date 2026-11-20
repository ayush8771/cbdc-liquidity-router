import { describe, expect, it } from "vitest";
import { isTransactionId, readHistoryParams, writeHistoryParams } from "../src/features/transactions/filters";
import { formatCorridor, formatDate, formatDateTime, formatPercent, formatUsd, shortId } from "../src/lib/format";

describe("format", () => {
  it("formats money, shares and corridors for display", () => {
    expect(formatUsd(300000)).toBe("$300,000");
    expect(formatPercent(0.9714)).toBe("97.1%");
    expect(formatCorridor("GBR->PHL")).toBe("GBR → PHL");
    expect(shortId("c0a8012e-7d3b-4f5e-9a51-2b1f3c4d5e6f")).toBe("c0a8012e");
  });

  it("shows timestamps and dates in UTC", () => {
    expect(formatDateTime("2026-11-02T10:00:00Z")).toBe("2 Nov 2026, 10:00 UTC");
    expect(formatDate("2024-06-14")).toBe("14 Jun 2024");
  });
});

describe("history URL parameters", () => {
  it("round-trips filters under the contract's query names", () => {
    const params = writeHistoryParams(
      { corridor: "GBR->PHL", policy: "ppoProjected", stateMode: "scenario", completed: false, from: "2026-11-01", to: "2026-11-02" },
      3,
    );
    expect(params.toString()).toBe(
      "corridor=GBR-%3EPHL&policy=ppoProjected&stateMode=scenario&completed=false&from=2026-11-01&to=2026-11-02&page=3",
    );
    expect(readHistoryParams(params)).toEqual({
      filters: { corridor: "GBR->PHL", policy: "ppoProjected", stateMode: "scenario", completed: false, from: "2026-11-01", to: "2026-11-02" },
      page: 3,
    });
  });

  it("ignores unrecognised values instead of passing them on", () => {
    const { filters, page } = readHistoryParams(new URLSearchParams("corridor=XXX->YYY&policy=raw&completed=maybe&page=-2"));
    expect(filters).toEqual({});
    expect(page).toBe(1);
  });

  it("accepts only full UUIDs as transaction IDs", () => {
    expect(isTransactionId("1b12ba0b-f730-4cfe-9443-024e91ca3331")).toBe(true);
    expect(isTransactionId("1b12ba0b")).toBe(false);
  });
});
