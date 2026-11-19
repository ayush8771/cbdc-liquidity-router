import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { HistoryTableDesktop } from "../src/features/transactions/HistoryTableDesktop";
import type { TransactionSummaryView } from "../src/features/transactions/historyTypes";
import { PREVIEW_TRANSACTIONS } from "../src/preview/previewData";
import { toSummary } from "../src/preview/previewHistory";

const ID = "11111111-2222-4333-8444-555555555555";
const summary = (patch: Partial<TransactionSummaryView> = {}): TransactionSummaryView => ({
  id: ID,
  createdAt: "2026-11-03T16:00:00.000Z",
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
  ...patch,
});

const completed = summary();
const partial = summary({ id: "22222222-2222-4333-8444-555555555555", completed: false, completionRatio: 0.5, executedUsd: 150000, policy: "cheapestFeasible", policyStatus: "baseline", stateMode: "scenario" });
const rejected = summary({ id: "33333333-2222-4333-8444-555555555555", amountUsd: 600000, allowed: false, completed: false, completionRatio: 0, executedUsd: 0, stateMode: "explicit" });
const failed = summary({
  id: "44444444-2222-4333-8444-555555555555",
  corridor: null,
  policyStatus: null,
  status: "failed",
  allowed: null,
  completed: null,
  completionRatio: null,
  executedUsd: null,
});

const renderTable = (rows: TransactionSummaryView[]) =>
  render(
    <MemoryRouter>
      <HistoryTableDesktop rows={rows} />
    </MemoryRouter>,
  );
const bodyRows = () => within(screen.getByRole("table", { name: "Transactions" })).getAllByRole("row").slice(1);
const cell = (row: HTMLElement, index: number) => within(row).getAllByRole("cell")[index]!;
const COL = { id: 0, corridor: 1, amount: 2, status: 3, policy: 4, state: 5, executed: 6, created: 7, view: 8 };

describe("HistoryTableDesktop", () => {
  it("keeps the existing columns and adds the state and executed columns", () => {
    renderTable([completed]);
    expect(within(screen.getByRole("table")).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Transaction",
      "Corridor",
      "Amount",
      "Status",
      "Policy",
      "State",
      "Executed",
      "Created",
      "Details",
    ]);
  });

  it("has no reward or created-by column", () => {
    renderTable([completed]);
    const headers = within(screen.getByRole("table")).getAllByRole("columnheader").map((h) => h.textContent ?? "");
    expect(headers.join(" ")).not.toMatch(/reward|created by|user|owner/i);
  });

  it("shows a completed transaction", () => {
    renderTable([completed]);
    const [row] = bodyRows();
    expect(cell(row!, COL.id)).toHaveTextContent("11111111");
    expect(cell(row!, COL.corridor)).toHaveTextContent("GBR → PHL");
    expect(cell(row!, COL.amount)).toHaveTextContent("$300,000");
    expect(cell(row!, COL.status)).toHaveTextContent("Completed");
    expect(cell(row!, COL.policy)).toHaveTextContent("Default (waterfall)");
    expect(cell(row!, COL.state)).toHaveTextContent("Historical replay");
    expect(cell(row!, COL.state)).toHaveTextContent("14 Jun 2024");
    expect(cell(row!, COL.executed)).toHaveTextContent("$300,000");
    expect(cell(row!, COL.executed)).toHaveTextContent("100.0%");
    expect(cell(row!, COL.created)).toHaveTextContent("3 Nov 2026, 16:00 UTC");
  });

  it("shows a partial transaction's executed amount and percentage", () => {
    renderTable([partial]);
    const [row] = bodyRows();
    expect(cell(row!, COL.status)).toHaveTextContent("Partial");
    expect(cell(row!, COL.amount)).toHaveTextContent("$300,000");
    expect(cell(row!, COL.executed)).toHaveTextContent("$150,000");
    expect(cell(row!, COL.executed)).toHaveTextContent("50.0%");
    expect(cell(row!, COL.state)).toHaveTextContent("Scenario");
    expect(cell(row!, COL.policy)).toHaveTextContent("Cheapest feasible");
  });

  it("shows a rejection as executing zero, not as missing", () => {
    renderTable([rejected]);
    const [row] = bodyRows();
    expect(cell(row!, COL.status)).toHaveTextContent("Rejected");
    expect(cell(row!, COL.executed)).toHaveTextContent("$0");
    expect(cell(row!, COL.executed)).toHaveTextContent("0.0%");
    expect(cell(row!, COL.executed).textContent).not.toContain("—");
    expect(cell(row!, COL.state)).toHaveTextContent("Explicit state");
  });

  it("shows a failed transaction with dashes for the corridor and executed values", () => {
    renderTable([failed]);
    const [row] = bodyRows();
    expect(cell(row!, COL.status)).toHaveTextContent("Failed");
    expect(cell(row!, COL.corridor)).toHaveTextContent("—");
    expect(within(cell(row!, COL.corridor)).getByText("Not confirmed")).toBeInTheDocument();
    expect(cell(row!, COL.executed)).toHaveTextContent("—");
    expect(within(cell(row!, COL.executed)).getByText("Not available")).toBeInTheDocument();
    expect(cell(row!, COL.executed).textContent).not.toMatch(/\$|%/);
    // The requested policy is still shown, with no confirmed tier.
    expect(cell(row!, COL.policy)).toHaveTextContent("Waterfall");
    expect(cell(row!, COL.policy)).not.toHaveTextContent("Default (waterfall)");
  });

  it("shows a dash for the percentage when only that is missing", () => {
    renderTable([summary({ completionRatio: null, executedUsd: 1000 })]);
    const executed = cell(bodyRows()[0]!, COL.executed);
    expect(executed).toHaveTextContent("$1,000");
    expect(executed).toHaveTextContent("—");
  });

  it("keeps the four outcomes distinct", () => {
    renderTable([completed, partial, rejected, failed]);
    expect(bodyRows().map((r) => cell(r, COL.status).textContent)).toEqual(["Completed", "Partial", "Rejected", "Failed"]);
  });

  it("links every row to its transaction", () => {
    renderTable([completed, partial, rejected, failed]);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([completed, partial, rejected, failed].map((s) => `/transactions/${s.id}`));
    expect(links[0]).toHaveAccessibleName("View transaction 11111111");
  });

  it("carries the required experimental label", () => {
    renderTable([summary({ policy: "ppoProjected", policyStatus: "experimental" })]);
    expect(screen.getByText("Experimental")).toBeInTheDocument();
  });

  it("renders every preview transaction, each linking to its own id", () => {
    renderTable(PREVIEW_TRANSACTIONS.map(toSummary));
    const rows = bodyRows();
    expect(rows).toHaveLength(PREVIEW_TRANSACTIONS.length);
    rows.forEach((row, i) => {
      expect(within(row).getByRole("link")).toHaveAttribute("href", `/transactions/${PREVIEW_TRANSACTIONS[i]!.id}`);
    });
  });
});
