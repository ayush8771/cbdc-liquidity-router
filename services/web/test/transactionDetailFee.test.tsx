import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatFeeFraction } from "../src/lib/format";
import { PREVIEW_TRANSACTION_DETAILS } from "../src/preview/previewDetail";
import { renderRoute } from "./renderRoute";

const original = window.matchMedia;

function mockWidth(width: number) {
  const impl = (query: string) =>
    ({
      matches: query === "(min-width: 1024px)" ? width >= 1024 : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
  window.matchMedia = vi.fn(impl) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  window.matchMedia = original;
});

const firstWhere = (predicate: (d: (typeof PREVIEW_TRANSACTION_DETAILS)[number]) => boolean) => {
  const found = PREVIEW_TRANSACTION_DETAILS.find(predicate);
  if (!found) throw new Error("The preview data has no transaction matching this case.");
  return found;
};
const feeCells = () =>
  within(screen.getByRole("region", { name: "Allocations" }))
    .getAllByRole("row")
    .slice(1) // without the header
    .map((row) => within(row).getAllByRole("cell")[1]!.textContent);

describe("formatFeeFraction", () => {
  // The contract defines feePct as a fraction: 0.015 is 1.5%.
  it.each([
    [0.015, "1.50%"],
    [0.0105, "1.05%"],
    [0.008, "0.80%"],
    [0.0225, "2.25%"],
    [0.012, "1.20%"],
    [0.023, "2.30%"],
    [0, "0.00%"],
    [1, "100.00%"],
  ])("shows %d as %s", (fraction, text) => expect(formatFeeFraction(fraction)).toBe(text));

  it("does not show a fraction as 0.02%, the old mistake", () => {
    expect(formatFeeFraction(0.015)).not.toBe("0.02%");
    expect(formatFeeFraction(0.015)).not.toBe("0.01%");
  });

  it("shows a dash for a missing or non-finite value", () => {
    expect(formatFeeFraction(null)).toBe("—");
    expect(formatFeeFraction(undefined)).toBe("—");
    expect(formatFeeFraction(Number.NaN)).toBe("—");
    expect(formatFeeFraction(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("does not change the number it is given", () => {
    const fee = 0.0105;
    formatFeeFraction(fee);
    expect(fee).toBe(0.0105);
  });
});

describe("preview allocation fees", () => {
  it("are stored as fractions, as the contract defines feePct", () => {
    const fees = PREVIEW_TRANSACTION_DETAILS.flatMap((d) => d.decision?.allocations.map((a) => a.feePct) ?? []);
    expect(fees.length).toBeGreaterThan(0);
    for (const fee of fees) {
      expect(fee).toBeGreaterThan(0);
      expect(fee).toBeLessThan(0.1); // 0.1 would be 10%; a percent number like 1.4 would fail
    }
  });

  it("give a venue the same fee in every transaction", () => {
    const byVenue = new Map<string, Set<number>>();
    for (const d of PREVIEW_TRANSACTION_DETAILS) {
      for (const a of d.decision?.allocations ?? []) {
        byVenue.set(a.bridgeUid, (byVenue.get(a.bridgeUid) ?? new Set()).add(a.feePct));
      }
    }
    for (const [uid, fees] of byVenue) expect(fees.size, uid).toBe(1);
  });
});

describe("Transaction Detail fee display at 1024px and above", () => {
  it.each([1024, 1280, 1440])("shows each fee as a percentage at %ipx", (width) => {
    mockWidth(width);
    const d = firstWhere((x) => x.outcome === "completed" && !!x.decision?.allocations.length);
    renderRoute(`/transactions/${d.id}`);
    const expected = d.decision!.allocations.map((a) => formatFeeFraction(a.feePct));
    expect(feeCells()).toEqual(expected);
    for (const text of feeCells()) expect(text).toMatch(/^\d\.\d{2}%$/);
  });

  it("shows GBR->PHL#0, stored as 0.014, as 1.40%", () => {
    mockWidth(1280);
    const d = firstWhere((x) => !!x.decision?.allocations.some((a) => a.bridgeUid === "GBR->PHL#0"));
    expect(d.decision!.allocations.find((a) => a.bridgeUid === "GBR->PHL#0")!.feePct).toBe(0.014);
    renderRoute(`/transactions/${d.id}`);
    const row = within(screen.getByRole("region", { name: "Allocations" }))
      .getAllByRole("row")
      .find((r) => r.textContent?.includes("GBR->PHL#0"))!;
    expect(row).toHaveTextContent("1.40%");
    expect(row).not.toHaveTextContent("140.00%");
    expect(row).not.toHaveTextContent("0.01%");
  });

  it("leaves the stored values alone", () => {
    mockWidth(1280);
    const d = firstWhere((x) => x.outcome === "partial");
    const before = JSON.stringify(d.decision!.allocations.map((a) => a.feePct));
    renderRoute(`/transactions/${d.id}`);
    expect(JSON.stringify(d.decision!.allocations.map((a) => a.feePct))).toBe(before);
  });

  it("shows no fee for a rejected transaction: it has no allocations", () => {
    mockWidth(1280);
    const d = firstWhere((x) => x.outcome === "rejected");
    renderRoute(`/transactions/${d.id}`);
    const region = screen.getByRole("region", { name: "Allocations" });
    expect(within(region).queryByRole("table")).not.toBeInTheDocument();
    expect(region).not.toHaveTextContent("%");
  });

  it("shows no fee for a failed transaction: it has no decision", () => {
    mockWidth(1280);
    const d = firstWhere((x) => x.outcome === "failed");
    renderRoute(`/transactions/${d.id}`);
    const region = screen.getByRole("region", { name: "Allocations" });
    expect(within(region).queryByRole("table")).not.toBeInTheDocument();
    expect(region).toHaveTextContent("There is no decision for this transaction");
    expect(region).not.toHaveTextContent("%");
  });

  it("still marks synthetic venues and lists every allocation", () => {
    mockWidth(1280);
    const d = firstWhere((x) => !!x.decision?.allocations.some((a) => a.dataSourceTag === "synthetic_bridge_expansion"));
    renderRoute(`/transactions/${d.id}`);
    const region = within(screen.getByRole("region", { name: "Allocations" }));
    expect(region.getAllByText("Synthetic venue").length).toBeGreaterThan(0);
    expect(region.getAllByRole("row")).toHaveLength(d.decision!.allocations.length + 1);
  });
});

describe("Transaction Detail below 1024px", () => {
  it("keeps the placeholder, with no fees", () => {
    mockWidth(1023);
    const d = firstWhere((x) => x.outcome === "completed");
    renderRoute(`/transactions/${d.id}`);
    expect(screen.getByText("This screen isn't connected yet")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Allocations" })).not.toBeInTheDocument();
    expect(screen.queryByText(/\d\.\d{2}%/)).not.toBeInTheDocument();
  });
});
