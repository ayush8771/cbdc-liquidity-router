import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RANGE_MESSAGE, describeWindow, toWindow } from "../src/features/dashboard/dashboardQuery";
import { formatCount } from "../src/lib/format";
import { PREVIEW_TRANSACTIONS } from "../src/preview/previewData";
import { queryPreviewDashboard } from "../src/preview/previewDashboard";
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

const PREVIEW_NOTICE = "Preview data — illustrative, not from the API";
const all = () => queryPreviewDashboard({ window: { from: null, to: null } });
const totalsRegion = () => screen.getByRole("region", { name: "Totals" });
const policyRows = () => within(screen.getByRole("table", { name: "Metrics by policy" })).getAllByRole("row").slice(1);

function expectTotals(totals: { transactions: number; routed: number; failed: number; rejectedByFeasibility: number }) {
  const region = within(totalsRegion());
  for (const [label, value] of [
    ["Transactions", totals.transactions],
    ["Routed", totals.routed],
    ["Failed", totals.failed],
    ["Rejected by feasibility", totals.rejectedByFeasibility],
  ] as const) {
    expect(region.getByText(label, { selector: "p" }).previousElementSibling).toHaveTextContent(formatCount(value));
  }
}

describe("DashboardPage at 1024px and above", () => {
  it.each([1024, 1280, 1440])("shows the desktop dashboard at %ipx", (width) => {
    mockWidth(width);
    renderRoute("/");
    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Filters" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Metrics by policy" })).toBeInTheDocument();
  });

  it("labels the data as preview, with the required labels and notes", () => {
    mockWidth(1280);
    renderRoute("/");
    expect(screen.getByText(PREVIEW_NOTICE)).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getAllByText("Placeholder weights").length).toBeGreaterThan(0);
    expect(screen.getByText(/Replay transactions don't consume liquidity/)).toBeInTheDocument();
    expect(screen.getByText(/Illustrative aggregates over the preview transactions/)).toBeInTheDocument(); // the summary's note
  });

  it("shows All time when no date bounds are set", () => {
    mockWidth(1280);
    renderRoute("/");
    expect(screen.getByTestId("window")).toHaveTextContent("All time");
  });

  it("shows one tile per contract total, with the summary's values", () => {
    mockWidth(1280);
    renderRoute("/");
    expectTotals(all().totals);
  });

  it("calls the corridor series Routed transactions, and the policy series Requests", () => {
    mockWidth(1280);
    renderRoute("/");
    const corridors = screen.getByRole("list", { name: "Routed transactions" });
    expect(within(corridors).getAllByRole("listitem")).toHaveLength(all().byCorridor.length);
    expect(screen.getByText("Routed transactions per corridor. Failed transactions have no corridor.")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Requests by policy" })).getAllByRole("listitem")).toHaveLength(
      all().byPolicy.length,
    );
    expect(screen.queryByRole("list", { name: "Transactions by corridor" })).not.toBeInTheDocument();
  });

  it("gives each corridor bar its routed count, not a total that includes failed transactions", () => {
    mockWidth(1280);
    renderRoute("/");
    const first = all().byCorridor[0]!;
    const bars = within(screen.getByRole("list", { name: "Routed transactions" })).getAllByRole("listitem");
    expect(bars[0]!.getAttribute("aria-label")).toContain(`${first.routed} transactions`);
  });

  it("shows the policy metrics table with requests and allowed routed as separate columns", () => {
    mockWidth(1280);
    renderRoute("/");
    const table = screen.getByRole("table", { name: "Metrics by policy" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Policy",
      "Requests",
      "Allowed routed",
      "Completion rate",
      "Mean fee cost",
      "Mean reward",
      "Mean latency",
      "Mean risk",
    ]);
    const summary = all();
    expect(policyRows()).toHaveLength(summary.byPolicy.length);
    summary.byPolicy.forEach((p, i) => {
      const cells = within(policyRows()[i]!).getAllByRole("cell");
      expect(cells[1]).toHaveTextContent(formatCount(p.count));
      expect(cells[2]).toHaveTextContent(formatCount(p.allowedRouted));
    });
    expect(summary.byPolicy.some((p) => p.count !== p.allowedRouted)).toBe(true);
    expect(screen.getByText(/it is the denominator of the completion rate and of every mean/)).toBeInTheDocument();
  });

  it("tells people on narrower desktop widths that the policy table scrolls sideways", () => {
    mockWidth(1024);
    renderRoute("/");
    expect(screen.getByText("Scroll sideways to see every column.")).toBeInTheDocument();
  });

  it("shows a dash for every mean in the preview, because the preview data has none", () => {
    mockWidth(1280);
    renderRoute("/");
    for (const row of policyRows()) {
      const cells = within(row).getAllByRole("cell");
      for (const cell of cells.slice(4)) {
        expect(cell).toHaveTextContent("—");
        expect(cell.textContent).not.toMatch(/\d|%/);
      }
    }
    expect(screen.getByText(/The preview data has no fee cost, reward, latency or risk values/)).toBeInTheDocument();
  });

  it("does not rank policies", () => {
    mockWidth(1280);
    renderRoute("/");
    expect(screen.getByText(/the table is not a ranking/)).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Metrics by policy" });
    expect(table.querySelector("[aria-sort]")).toBeNull();
    expect(within(table).queryByText(/best|worst|winner|top/i)).not.toBeInTheDocument();
    // The order is the summary's, not the completion rate's.
    expect(policyRows().map((r) => within(r).getAllByRole("cell")[0]!.textContent?.replace("Experimental", ""))).toEqual(
      all().byPolicy.map((p) => ({ waterfall: "Default (waterfall)", cheapestFeasible: "Cheapest feasible", ppoProjected: "PPO (projected)" })[p.policy]),
    );
  });

  it("shows corridor metrics with the completion denominator", () => {
    mockWidth(1280);
    renderRoute("/");
    const rows = within(screen.getByRole("table", { name: "Metrics by corridor" })).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(all().byCorridor.length);
    const first = all().byCorridor[0]!;
    const cells = within(rows[0]!).getAllByRole("cell");
    expect(cells[1]).toHaveTextContent(formatCount(first.routed));
    expect(cells[2]).toHaveTextContent(formatCount(first.allowedRouted));
  });

  it("keeps recent transactions separate, and says the filters don't apply to them", () => {
    mockWidth(1280);
    renderRoute("/");
    const recent = screen.getByRole("region", { name: "Recent transactions" });
    expect(within(recent).getAllByRole("row")).toHaveLength(6); // header + 5
    expect(recent).toHaveTextContent("from the transaction history");
    expect(recent).toHaveTextContent("The filters above apply to the summary only.");
    expect(within(recent).getAllByRole("link", { name: /^View transaction/ })[0]).toHaveAttribute(
      "href",
      `/transactions/${PREVIEW_TRANSACTIONS[0]!.id}`,
    );
  });

  it("has no time-series chart: the summary has no per-day data", () => {
    mockWidth(1280);
    renderRoute("/");
    expect(screen.queryByText(/per day|daily|over time|trend/i)).not.toBeInTheDocument();
  });
});

describe("Dashboard filters (URL-backed)", () => {
  it("offers the four optional filters, all empty to start with", () => {
    mockWidth(1280);
    renderRoute("/");
    expect(screen.getByRole("combobox", { name: "Corridor" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Policy" })).toHaveValue("");
    expect(screen.getByLabelText("From (included)")).toHaveValue("");
    expect(screen.getByLabelText("To (not included)")).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
  });

  it("reads the filters from the URL", () => {
    mockWidth(1280);
    renderRoute(`/?corridor=${encodeURIComponent("GBR->PHL")}&policy=waterfall&from=2026-11-02&to=2026-11-04`);
    expect(screen.getByRole("combobox", { name: "Corridor" })).toHaveValue("GBR->PHL");
    expect(screen.getByRole("combobox", { name: "Policy" })).toHaveValue("waterfall");
    expect(screen.getByLabelText("From (included)")).toHaveValue("2026-11-02");
    expect(screen.getByLabelText("To (not included)")).toHaveValue("2026-11-04");
    const summary = queryPreviewDashboard({ corridor: "GBR->PHL", policy: "waterfall", window: toWindow({ from: "2026-11-02", to: "2026-11-04" }) });
    expectTotals(summary.totals);
  });

  it("filters the summary by corridor and writes it to the URL", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    const { router } = renderRoute("/");
    await user.selectOptions(screen.getByRole("combobox", { name: "Corridor" }), "GBR->PHL");
    expect(router.state.location.search).toBe(`?corridor=${encodeURIComponent("GBR->PHL")}`);
    expectTotals(queryPreviewDashboard({ corridor: "GBR->PHL", window: { from: null, to: null } }).totals);
    expect(within(screen.getByRole("list", { name: "Routed transactions" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("filters the summary by policy", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    const { router } = renderRoute("/");
    await user.selectOptions(screen.getByRole("combobox", { name: "Policy" }), "cheapestFeasible");
    expect(router.state.location.search).toBe("?policy=cheapestFeasible");
    expect(policyRows()).toHaveLength(1);
  });

  it("filters by a UTC date window: from included, to not included", () => {
    mockWidth(1280);
    renderRoute("/?from=2026-11-03&to=2026-11-04");
    const window = toWindow({ from: "2026-11-03", to: "2026-11-04" });
    expect(screen.getByTestId("window")).toHaveTextContent("3 Nov 2026, 00:00 UTC to 4 Nov 2026, 00:00 UTC (end not included)");
    expect(screen.getByTestId("window")).toHaveTextContent(describeWindow(window));
    expectTotals(queryPreviewDashboard({ window }).totals);
  });

  it("shows a window with only a start", () => {
    mockWidth(1280);
    renderRoute("/?from=2026-11-03");
    expect(screen.getByTestId("window")).toHaveTextContent("From 3 Nov 2026, 00:00 UTC");
  });

  it("shows a window with only an end", () => {
    mockWidth(1280);
    renderRoute("/?to=2026-11-03");
    expect(screen.getByTestId("window")).toHaveTextContent("Until 3 Nov 2026, 00:00 UTC (not included)");
  });

  it("updates the window when a date is chosen", () => {
    mockWidth(1280);
    const { router } = renderRoute("/");
    fireEvent.change(screen.getByLabelText("From (included)"), { target: { value: "2026-11-02" } });
    expect(router.state.location.search).toBe("?from=2026-11-02");
    expect(screen.getByTestId("window")).toHaveTextContent("From 2 Nov 2026, 00:00 UTC");
  });

  it("clears the filters", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    const { router } = renderRoute("/?policy=waterfall&from=2026-11-02");
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(router.state.location.search).toBe("");
    expect(screen.getByTestId("window")).toHaveTextContent("All time");
    expectTotals(all().totals);
  });

  it("keeps the preview state while filtering", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    const { router } = renderRoute("/?state=loading");
    await user.selectOptions(screen.getByRole("combobox", { name: "Policy" }), "waterfall");
    expect(router.state.location.search).toContain("state=loading");
    expect(router.state.location.search).toContain("policy=waterfall");
  });
});

describe("Dashboard invalid filters", () => {
  it("reports from later than to, and neither shows a summary nor changes the dates", () => {
    mockWidth(1280);
    const { router } = renderRoute("/?from=2026-11-05&to=2026-11-01");
    expect(screen.getByText(RANGE_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText("The summary isn't shown")).toBeInTheDocument();
    expect(screen.getByLabelText("From (included)")).toHaveValue("2026-11-05");
    expect(screen.getByLabelText("To (not included)")).toHaveValue("2026-11-01"); // not swapped or corrected
    expect(screen.getByLabelText("To (not included)")).toHaveAttribute("aria-invalid", "true");
    expect(router.state.location.search).toBe("?from=2026-11-05&to=2026-11-01");
    expect(screen.queryByRole("table", { name: "Metrics by policy" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Totals" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("window")).not.toBeInTheDocument();
  });

  it("accepts from equal to to as a valid, empty window", () => {
    mockWidth(1280);
    renderRoute("/?from=2026-11-03&to=2026-11-03");
    expect(screen.queryByText(RANGE_MESSAGE)).not.toBeInTheDocument();
    expect(screen.getByText("No transactions in this window")).toBeInTheDocument();
  });

  it("reports a malformed date and an unknown corridor or policy", () => {
    mockWidth(1280);
    renderRoute("/?from=banana&corridor=XXX-%3EYYY&policy=best");
    expect(screen.getByText("Use the format YYYY-MM-DD.")).toBeInTheDocument();
    expect(screen.getByText("Choose one of the listed corridors.")).toBeInTheDocument();
    expect(screen.getByText("Choose one of the listed policies.")).toBeInTheDocument();
    expect(screen.getByText("The summary isn't shown")).toBeInTheDocument();
  });

  it("recovers when the range is fixed", () => {
    mockWidth(1280);
    renderRoute("/?from=2026-11-05&to=2026-11-01");
    fireEvent.change(screen.getByLabelText("From (included)"), { target: { value: "2026-11-01" } });
    fireEvent.change(screen.getByLabelText("To (not included)"), { target: { value: "2026-11-05" } });
    expect(screen.queryByText(RANGE_MESSAGE)).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Metrics by policy" })).toBeInTheDocument();
  });
});

describe("Dashboard states", () => {
  it("shows an empty window with its window and a way to clear the filters", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    const { router } = renderRoute("/?from=2000-01-01&to=2000-01-02");
    expect(screen.getByText("No transactions in this window")).toBeInTheDocument();
    expect(screen.getByTestId("window")).toHaveTextContent(describeWindow(toWindow({ from: "2000-01-01", to: "2000-01-02" })));
    expect(screen.queryByRole("table", { name: "Metrics by policy" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Totals" })).not.toBeInTheDocument();
    // One Clear filters button in the filter bar, and one in the empty state.
    const clear = screen.getAllByRole("button", { name: "Clear filters" });
    expect(clear).toHaveLength(2);
    await user.click(clear[1]!);
    expect(router.state.location.search).toBe("");
    expect(screen.getByRole("table", { name: "Metrics by policy" })).toBeInTheDocument();
  });

  it("shows ?state=empty as no transactions yet, even with all the data present", () => {
    mockWidth(1280);
    renderRoute("/?state=empty");
    expect(screen.getByText("No transactions yet")).toBeInTheDocument();
    // Scoped to the page content: the sidebar has its own New transaction link.
    expect(within(screen.getByRole("main")).getByRole("link", { name: "New transaction" })).toHaveAttribute("href", "/transactions/new");
  });

  it("shows the loading state", () => {
    mockWidth(1280);
    renderRoute("/?state=loading");
    expect(screen.getAllByRole("status").some((s) => s.textContent?.includes("Loading dashboard"))).toBe(true);
    expect(screen.queryByRole("table", { name: "Metrics by policy" })).not.toBeInTheDocument();
  });

  it("shows the error state, keeps the filters, and recovers with Try again", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/?state=error&policy=waterfall");
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load the dashboard");
    expect(screen.getByRole("combobox", { name: "Policy" })).toHaveValue("waterfall");
    expect(screen.queryByRole("table", { name: "Metrics by policy" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Metrics by policy" })).toBeInTheDocument();
  });
});

describe("Dashboard below 1024px", () => {
  it.each([1023, 768, 375])("keeps the existing dashboard, unchanged, at %ipx", (width) => {
    mockWidth(width);
    renderRoute("/");
    // The existing page's own content and wording, including its footnote.
    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByText(PREVIEW_NOTICE)).toBeInTheDocument();
    expect(screen.getByText("Transactions per corridor.")).toBeInTheDocument();
    expect(screen.getByText("Transactions per requested policy.")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Transactions by corridor" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Transactions by policy" })).toBeInTheDocument();
    expect(screen.getByText(/What the per-group counts include is still being agreed in the API contract/)).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Recent transactions" })).toBeInTheDocument();
    // None of the desktop additions.
    expect(screen.queryByRole("region", { name: "Filters" })).not.toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Metrics by policy" })).not.toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Metrics by corridor" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("window")).not.toBeInTheDocument();
    expect(screen.queryByText("Routed transactions per corridor. Failed transactions have no corridor.")).not.toBeInTheDocument();
  });

  it("ignores the new filter parameters", () => {
    mockWidth(800);
    renderRoute("/?policy=waterfall&from=2026-11-05&to=2026-11-01");
    expect(screen.queryByText(RANGE_MESSAGE)).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Transactions by policy" })).toBeInTheDocument();
  });

  it.each([
    ["loading", () => expect(screen.getByRole("status")).toHaveTextContent("Loading dashboard")],
    ["empty", () => expect(screen.getByText("No transactions yet")).toBeInTheDocument()],
    ["error", () => expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load the dashboard")],
  ])("keeps the %s state", (state, check) => {
    mockWidth(1023);
    renderRoute(`/?state=${state}`);
    check();
  });
});
