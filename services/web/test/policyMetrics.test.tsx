import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  CorridorMetricsTable,
  PolicyMetricsTable,
  formatMean,
  formatMeanFeeCostPct,
} from "../src/features/dashboard/PolicyMetricsTable";
import type { CorridorSummary, PolicySummary } from "../src/features/dashboard/summaryTypes";

const policy = (patch: Partial<PolicySummary> = {}): PolicySummary => ({
  policy: "waterfall",
  count: 5,
  allowedRouted: 3,
  completionRate: 2 / 3,
  meanRewardAmountBased: -0.251407,
  meanFeeCostPct: 1.56,
  meanLatencyTerm: 0.257083,
  meanRiskTerm: 0,
  ...patch,
});

/** The cells of a row, by column name. */
function cells(row: HTMLElement) {
  const [name, count, allowed, completion, fee, reward, latency, risk] = within(row).getAllByRole("cell");
  return { name: name!, count: count!, allowed: allowed!, completion: completion!, fee: fee!, reward: reward!, latency: latency!, risk: risk! };
}
const bodyRows = () => within(screen.getByRole("table")).getAllByRole("row").slice(1);

describe("formatMeanFeeCostPct", () => {
  // meanFeeCostPct is already a percentage number: 1.56 means 1.56%.
  it.each([
    [1.56, "1.56%"],
    [1.4, "1.40%"],
    [0.05, "0.05%"],
    [12.345, "12.35%"],
    [0, "0.00%"],
    [1234.5, "1,234.50%"],
  ])("shows %d as %s", (value, text) => expect(formatMeanFeeCostPct(value)).toBe(text));

  it("does not multiply by 100", () => {
    expect(formatMeanFeeCostPct(1.56)).not.toBe("156.00%");
    expect(formatMeanFeeCostPct(1.563333)).toBe("1.56%");
    expect(formatMeanFeeCostPct(1.4)).not.toBe("140.00%");
  });

  it("is null for a missing or non-finite value, and zero is not null", () => {
    expect(formatMeanFeeCostPct(null)).toBeNull();
    expect(formatMeanFeeCostPct(Number.NaN)).toBeNull();
    expect(formatMeanFeeCostPct(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatMeanFeeCostPct(0)).not.toBeNull();
  });
});

describe("formatMean", () => {
  it("shows a plain number with no unit, to at most four decimals", () => {
    expect(formatMean(-0.251407)).toBe("-0.2514");
    expect(formatMean(0.257083)).toBe("0.2571");
    expect(formatMean(1)).toBe("1");
    expect(formatMean(0.11)).toBe("0.11");
  });

  it("shows zero as 0, not as unavailable", () => {
    expect(formatMean(0)).toBe("0");
  });

  it("is null for a missing or non-finite value", () => {
    expect(formatMean(null)).toBeNull();
    expect(formatMean(Number.NaN)).toBeNull();
  });
});

describe("PolicyMetricsTable", () => {
  it("has the eight columns, with requests and allowed routed as separate columns", () => {
    render(<PolicyMetricsTable rows={[policy()]} />);
    expect(within(screen.getByRole("table")).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Policy",
      "Requests",
      "Allowed routed",
      "Completion rate",
      "Mean fee cost",
      "Mean reward",
      "Mean latency",
      "Mean risk",
    ]);
  });

  it("shows count and allowedRouted as different numbers", () => {
    render(<PolicyMetricsTable rows={[policy({ count: 12, allowedRouted: 7 })]} />);
    const c = cells(bodyRows()[0]!);
    expect(c.count).toHaveTextContent("12");
    expect(c.allowed).toHaveTextContent("7");
  });

  it("shows the mean fee cost as 1.56%, not 156.00%", () => {
    render(<PolicyMetricsTable rows={[policy({ meanFeeCostPct: 1.56 })]} />);
    const fee = cells(bodyRows()[0]!).fee;
    expect(fee).toHaveTextContent("1.56%");
    expect(fee.textContent).not.toContain("156");
  });

  it("shows the other means as plain numbers", () => {
    render(<PolicyMetricsTable rows={[policy()]} />);
    const c = cells(bodyRows()[0]!);
    expect(c.reward).toHaveTextContent("-0.2514");
    expect(c.latency).toHaveTextContent("0.2571");
    expect(c.completion).toHaveTextContent("66.7%");
  });

  it("shows zero as zero, and null as a dash: null is not zero", () => {
    render(
      <PolicyMetricsTable
        rows={[
          policy({ policy: "waterfall", meanFeeCostPct: 0, meanRewardAmountBased: 0, meanLatencyTerm: 0, meanRiskTerm: 0, completionRate: 0 }),
          policy({ policy: "cheapestFeasible", meanFeeCostPct: null, meanRewardAmountBased: null, meanLatencyTerm: null, meanRiskTerm: null, completionRate: null }),
        ]}
      />,
    );
    const [zero, none] = bodyRows().map(cells);
    expect(zero!.fee).toHaveTextContent("0.00%");
    expect(zero!.reward).toHaveTextContent(/^0$/);
    expect(zero!.latency).toHaveTextContent(/^0$/);
    expect(zero!.risk).toHaveTextContent(/^0$/);
    expect(zero!.completion).toHaveTextContent("0.0%");
    for (const cell of [none!.fee, none!.reward, none!.latency, none!.risk, none!.completion]) {
      expect(cell).toHaveTextContent("—");
      expect(within(cell).getByText("Not available")).toBeInTheDocument();
      expect(cell.textContent).not.toMatch(/\d/);
    }
  });

  it("shows a dash for every nullable value when nothing was allowed", () => {
    render(
      <PolicyMetricsTable
        rows={[policy({ allowedRouted: 0, completionRate: null, meanRewardAmountBased: null, meanFeeCostPct: null, meanLatencyTerm: null, meanRiskTerm: null })]}
      />,
    );
    const c = cells(bodyRows()[0]!);
    expect(c.allowed).toHaveTextContent("0"); // a count, so zero is real
    for (const cell of [c.completion, c.fee, c.reward, c.latency, c.risk]) expect(cell).toHaveTextContent("—");
  });

  it("keeps the API's order and does not sort or flag a policy by its metrics", () => {
    render(
      <PolicyMetricsTable
        rows={[
          policy({ policy: "ppoProjected", meanRewardAmountBased: -9, meanRiskTerm: 5 }),
          policy({ policy: "waterfall", meanRewardAmountBased: 9, meanRiskTerm: 0 }),
          policy({ policy: "cheapestFeasible", meanRewardAmountBased: 0 }),
        ]}
      />,
    );
    expect(bodyRows().map((r) => cells(r).name.textContent)).toEqual([
      "PPO (projected)Experimental",
      "Default (waterfall)",
      "Cheapest feasible",
    ]);
    const table = screen.getByRole("table");
    expect(table.querySelector("[aria-sort]")).toBeNull();
    expect(within(table).queryByText(/best|worst|top|winner|rank/i)).not.toBeInTheDocument();
  });

  it("carries the required policy labels", () => {
    render(<PolicyMetricsTable rows={[policy({ policy: "waterfall" }), policy({ policy: "ppoProjected" })]} />);
    expect(screen.getByText("Default (waterfall)")).toBeInTheDocument();
    expect(screen.getByText("Experimental")).toBeInTheDocument();
  });

  it("says so when there are no rows", () => {
    render(<PolicyMetricsTable rows={[]} />);
    expect(screen.getByText("No policy requests in this window.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("CorridorMetricsTable", () => {
  const corridor = (patch: Partial<CorridorSummary> = {}): CorridorSummary => ({
    corridor: "GBR->PHL",
    routed: 5,
    allowedRouted: 4,
    completionRate: 0.5,
    ...patch,
  });

  it("shows routed and allowed routed as separate columns, and the completion rate", () => {
    render(<CorridorMetricsTable rows={[corridor()]} />);
    expect(within(screen.getByRole("table")).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Corridor",
      "Routed",
      "Allowed routed",
      "Completion rate",
    ]);
    const [row] = bodyRows();
    expect(row).toHaveTextContent("GBR → PHL");
    expect(within(row!).getAllByRole("cell").map((c) => c.textContent)).toEqual(["GBR → PHL", "5", "4", "50.0%"]);
  });

  it("shows a dash for a null completion rate", () => {
    render(<CorridorMetricsTable rows={[corridor({ allowedRouted: 0, completionRate: null })]} />);
    expect(within(bodyRows()[0]!).getAllByRole("cell")[3]).toHaveTextContent("—");
  });

  it("says so when there are no rows", () => {
    render(<CorridorMetricsTable rows={[]} />);
    expect(screen.getByText("No routed transactions in this window.")).toBeInTheDocument();
  });
});
