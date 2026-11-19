import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PREVIEW_DASHBOARD, PREVIEW_TRANSACTIONS } from "../src/preview/previewData";
import { renderRoute } from "./renderRoute";

describe("DashboardPage (preview data)", () => {
  it("labels the data as preview, and shows the required labels", () => {
    renderRoute("/");
    expect(screen.getByText("Preview data — illustrative, not from the API")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText("Placeholder weights")).toBeInTheDocument();
    expect(screen.getByText(/Replay transactions don't consume liquidity/)).toBeInTheDocument();
  });

  it("shows one tile per contract total, with the preview values", () => {
    renderRoute("/");
    const { totals } = PREVIEW_DASHBOARD;
    for (const [label, value] of [
      ["Transactions", totals.transactions],
      ["Routed", totals.routed],
      ["Failed", totals.failed],
      ["Rejected by feasibility", totals.rejectedByFeasibility],
    ] as const) {
      const caption = screen.getByText(label, { selector: "p" });
      expect(caption.previousElementSibling).toHaveTextContent(String(value));
    }
  });

  it("draws one focusable, labelled bar per corridor and per policy", () => {
    renderRoute("/");
    const corridors = screen.getByRole("list", { name: "Transactions by corridor" });
    const bars = within(corridors).getAllByRole("listitem");
    expect(bars).toHaveLength(PREVIEW_DASHBOARD.byCorridor.length);
    const first = PREVIEW_DASHBOARD.byCorridor[0]!;
    expect(bars[0]).toHaveAttribute("tabindex", "0");
    expect(bars[0]).toHaveAccessibleName(new RegExp(`^GBR → PHL|^USA → IND|^ARE → MEX`));
    expect(bars[0]!.getAttribute("aria-label")).toContain(`${first.count} transactions`);
    expect(within(screen.getByRole("list", { name: "Transactions by policy" })).getAllByRole("listitem")).toHaveLength(3);
  });

  it("offers every chart value as a table", () => {
    renderRoute("/");
    const table = screen.getByRole("table", { name: "Transactions by corridor" });
    expect(within(table).getAllByRole("row")).toHaveLength(1 + PREVIEW_DASHBOARD.byCorridor.length);
  });

  it("lists the five most recent transactions, each linking to its details", () => {
    renderRoute("/");
    const table = screen.getByRole("table", { name: "Recent transactions" });
    expect(within(table).getAllByRole("row")).toHaveLength(6);
    const newest = PREVIEW_TRANSACTIONS[0]!;
    expect(within(table).getAllByRole("link", { name: /^View transaction/ })[0]).toHaveAttribute(
      "href",
      `/transactions/${newest.id}`,
    );
  });

  it.each([
    ["loading", () => expect(screen.getByRole("status")).toHaveTextContent("Loading dashboard")],
    ["empty", () => expect(screen.getByText("No transactions yet")).toBeInTheDocument()],
    ["error", () => expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load the dashboard")],
  ])("shows the %s state", (state, check) => {
    renderRoute(`/?state=${state}`);
    check();
  });
});
