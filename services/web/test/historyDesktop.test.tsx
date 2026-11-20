import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DUPLICATE_MESSAGE, RANGE_MESSAGE } from "../src/features/transactions/historyQuery";
import { outcomeOf } from "../src/features/transactions/historyTypes";
import { formatPercent, formatUsd } from "../src/lib/format";
import { PREVIEW_TRANSACTIONS } from "../src/preview/previewData";
import { getPreviewTransactionDetail } from "../src/preview/previewDetail";
import { toSummary } from "../src/preview/previewHistory";
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
const table = () => screen.getByRole("table", { name: "Transactions" });
const dataRows = () => within(table()).getAllByRole("row").slice(1);
const pagination = () => screen.getByRole("navigation", { name: "Pagination" });
const corridorSelect = () => screen.getByRole("combobox", { name: "Corridor" });
const sizeSelect = () => screen.getByRole("combobox", { name: "Rows per page" });
const fromInput = () => screen.getByLabelText("Created from (included)");
const toInput = () => screen.getByLabelText("Created to (not included)");
const noTable = () => expect(screen.queryByRole("table", { name: "Transactions" })).not.toBeInTheDocument();
const rowsWhere = (predicate: (r: (typeof PREVIEW_TRANSACTIONS)[number]) => boolean) => PREVIEW_TRANSACTIONS.filter(predicate);

describe("HistoryPage at 1024px and above", () => {
  it.each([1024, 1280, 1440])("shows the desktop History at %ipx", (width) => {
    mockWidth(width);
    renderRoute("/transactions");
    expect(screen.getByRole("heading", { level: 1, name: "History" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(sizeSelect()).toBeInTheDocument();
    expect(within(table()).getAllByRole("columnheader")).toHaveLength(9);
  });

  it("is labelled as preview data, and no longer promises an explanation", () => {
    mockWidth(1280);
    renderRoute("/transactions");
    expect(screen.getByText(PREVIEW_NOTICE)).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText("Every stored transaction, newest first. Open one to see its allocation and decision.")).toBeInTheDocument();
    expect(screen.queryByText(/explanation/i)).not.toBeInTheDocument();
  });

  it("tells people on narrower desktop widths that the table scrolls sideways", () => {
    mockWidth(1024);
    renderRoute("/transactions");
    expect(screen.getByText("Scroll sideways to see every column.")).toBeInTheDocument();
  });

  it("shows the first 20 of 57, with every column", () => {
    mockWidth(1280);
    renderRoute("/transactions");
    expect(dataRows()).toHaveLength(20);
    expect(pagination()).toHaveTextContent("Showing 1–20 of 57 transactions");
    expect(within(table()).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
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
});

describe("paging and page size", () => {
  it("pages through the results and keeps the page in the URL", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    const { router } = renderRoute("/transactions");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(router.state.location.search).toBe("?page=2");
    expect(pagination()).toHaveTextContent("Showing 21–40 of 57");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(dataRows()).toHaveLength(17);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Previous" }));
    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(router.state.location.search).toBe(""); // page 1 is not written
  });

  it("defaults to 20 rows and offers 20, 50 and 100", () => {
    mockWidth(1280);
    renderRoute("/transactions");
    expect(sizeSelect()).toHaveValue("20");
    expect(within(sizeSelect()).getAllByRole("option").map((o) => o.textContent)).toEqual(["20", "50", "100"]);
  });

  it("shows 50 rows at a time, then the remaining 7", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    const { router } = renderRoute("/transactions");
    await user.selectOptions(sizeSelect(), "50");
    expect(router.state.location.search).toBe("?pageSize=50");
    expect(dataRows()).toHaveLength(50);
    expect(pagination()).toHaveTextContent("Showing 1–50 of 57");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(router.state.location.search).toBe("?pageSize=50&page=2");
    expect(dataRows()).toHaveLength(7);
    expect(pagination()).toHaveTextContent("Showing 51–57 of 57");
  });

  it("shows all 57 on one page at 100 rows", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions");
    await user.selectOptions(sizeSelect(), "100");
    expect(dataRows()).toHaveLength(57);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
  });

  it("goes back to page 1 when the page size changes", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    const { router } = renderRoute("/transactions?page=3");
    expect(dataRows()).toHaveLength(17);
    await user.selectOptions(sizeSelect(), "50");
    expect(router.state.location.search).toBe("?pageSize=50"); // no page
    expect(pagination()).toHaveTextContent("Showing 1–50 of 57");
  });

  it("goes back to page 1 when a filter changes", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    const { router } = renderRoute("/transactions?page=2");
    await user.selectOptions(corridorSelect(), "GBR->PHL");
    expect(router.state.location.search).toBe("?corridor=GBR-%3EPHL");
    expect(pagination()).toHaveTextContent(`of ${rowsWhere((r) => r.corridor === "GBR->PHL").length} transactions`);
  });

  it("goes back to page 1 when a date changes", () => {
    mockWidth(1280);
    const { router } = renderRoute("/transactions?page=2");
    fireEvent.change(fromInput(), { target: { value: "2026-11-02" } });
    expect(router.state.location.search).toBe("?from=2026-11-02");
  });

  it("keeps an unusual page size from the URL as a choice", () => {
    mockWidth(1280);
    renderRoute("/transactions?pageSize=30");
    expect(sizeSelect()).toHaveValue("30");
    expect(within(sizeSelect()).getAllByRole("option").map((o) => o.textContent)).toEqual(["20", "30", "50", "100"]);
    expect(dataRows()).toHaveLength(30);
  });
});

describe("filters", () => {
  it("filters by each field, writing the contract's names to the URL", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    const { router } = renderRoute("/transactions");

    await user.selectOptions(screen.getByRole("combobox", { name: "Policy" }), "cheapestFeasible");
    expect(router.state.location.search).toBe("?policy=cheapestFeasible");
    expect(pagination()).toHaveTextContent(`of ${rowsWhere((r) => r.policy === "cheapestFeasible").length} transactions`);

    await user.selectOptions(screen.getByRole("combobox", { name: "State mode" }), "explicit");
    expect(router.state.location.search).toBe("?policy=cheapestFeasible&stateMode=explicit");

    await user.selectOptions(screen.getByRole("combobox", { name: "Completion" }), "true");
    expect(router.state.location.search).toBe("?policy=cheapestFeasible&stateMode=explicit&completed=true");
    const expected = rowsWhere((r) => r.policy === "cheapestFeasible" && r.stateMode === "explicit" && r.outcome === "completed");
    if (expected.length > 0) expect(dataRows()).toHaveLength(expected.length);
    else expect(screen.getByText("No transactions match these filters")).toBeInTheDocument();
  });

  it("filters by completion without ever matching a failed transaction", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions?pageSize=100");
    await user.selectOptions(screen.getByRole("combobox", { name: "Completion" }), "false");
    const statuses = new Set(dataRows().map((r) => within(r).getAllByRole("cell")[3]!.textContent));
    expect(statuses).toEqual(new Set(["Partial", "Rejected"]));
  });

  it("filters by corridor, which leaves out failed transactions", async () => {
    mockWidth(1280);
    renderRoute(`/transactions?pageSize=100&corridor=${encodeURIComponent("USA->IND")}`);
    const corridors = new Set(dataRows().map((r) => within(r).getAllByRole("cell")[1]!.textContent));
    expect(corridors).toEqual(new Set(["USA → IND"]));
  });

  it("filters by policy, which keeps failed transactions", () => {
    mockWidth(1280);
    renderRoute("/transactions?pageSize=100&policy=cheapestFeasible");
    const statuses = dataRows().map((r) => within(r).getAllByRole("cell")[3]!.textContent);
    expect(statuses.includes("Failed")).toBe(rowsWhere((r) => r.policy === "cheapestFeasible" && r.outcome === "failed").length > 0);
  });

  it("combines filters from the URL, and shows them in the controls", () => {
    mockWidth(1280);
    renderRoute(`/transactions?corridor=${encodeURIComponent("GBR->PHL")}&policy=waterfall&stateMode=historicalReplay&completed=true`);
    expect(corridorSelect()).toHaveValue("GBR->PHL");
    expect(screen.getByRole("combobox", { name: "Policy" })).toHaveValue("waterfall");
    expect(screen.getByRole("combobox", { name: "State mode" })).toHaveValue("historicalReplay");
    expect(screen.getByRole("combobox", { name: "Completion" })).toHaveValue("true");
    const expected = rowsWhere((r) => r.corridor === "GBR->PHL" && r.policy === "waterfall" && r.stateMode === "historicalReplay" && r.outcome === "completed");
    expect(screen.queryByText("No transactions match these filters") === null).toBe(expected.length > 0);
  });

  it("clears the filters, and keeps the page size", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    const { router } = renderRoute("/transactions?policy=waterfall&from=2026-11-02&pageSize=50&page=1");
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(router.state.location.search).toBe("?pageSize=50");
    expect(pagination()).toHaveTextContent("Showing 1–50 of 57");
  });

  it("preserves unrelated URL parameters while filtering and paging", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    const { router } = renderRoute("/transactions?foo=bar");
    await user.selectOptions(corridorSelect(), "GBR->PHL");
    // What was there stays where it was; the new parameter is added after it.
    expect(router.state.location.search).toBe("?foo=bar&corridor=GBR-%3EPHL");
    await user.selectOptions(sizeSelect(), "50");
    expect(router.state.location.search).toContain("foo=bar");
    expect(router.state.location.search).toContain("pageSize=50");
  });
});

describe("date window (UTC; from included, to not included)", () => {
  const day = (d: string) => rowsWhere((r) => r.createdAt.startsWith(d));

  it("includes `from`'s day and leaves out `to`'s day", () => {
    mockWidth(1280);
    renderRoute("/transactions?pageSize=100&from=2026-11-02&to=2026-11-03");
    expect(dataRows()).toHaveLength(day("2026-11-02").length);
    expect(pagination()).toHaveTextContent(`of ${day("2026-11-02").length} transactions`);
  });

  it("gives an empty result, not an error, when from equals to", () => {
    mockWidth(1280);
    renderRoute("/transactions?from=2026-11-02&to=2026-11-02");
    expect(screen.getByText("No transactions match these filters")).toBeInTheDocument();
    expect(screen.queryByText(RANGE_MESSAGE)).not.toBeInTheDocument();
    noTable();
  });

  it("applies a window set through the date fields", () => {
    mockWidth(1280);
    const { router } = renderRoute("/transactions?pageSize=100");
    fireEvent.change(fromInput(), { target: { value: "2026-11-03" } });
    fireEvent.change(toInput(), { target: { value: "2026-11-04" } });
    expect(router.state.location.search).toBe("?pageSize=100&from=2026-11-03&to=2026-11-04");
    expect(dataRows()).toHaveLength(day("2026-11-03").length);
  });

  it("labels the fields with the semantics", () => {
    mockWidth(1280);
    renderRoute("/transactions");
    expect(screen.getByText("Dates are UTC midnight. The end date is not included.")).toBeInTheDocument();
  });

  it("differs on purpose from the narrow history, where the end day is included", () => {
    mockWidth(1280);
    renderRoute("/transactions?from=2026-11-01&to=2026-11-01");
    expect(screen.getByText("No transactions match these filters")).toBeInTheDocument();
  });
});

describe("invalid parameters", () => {
  const ALL_BAD =
    "/transactions?corridor=XXX&policy=best&stateMode=zzz&completed=maybe&from=2026-11-05&to=2026-11-01&pageSize=500&page=0";

  it("lists every problem together and shows no transactions", () => {
    mockWidth(1280);
    renderRoute(ALL_BAD);
    const notice = screen.getByText("Some parameters can't be used").closest("div")!.parentElement!;
    for (const text of [
      "corridor: Choose one of the listed corridors.",
      "policy: Choose one of the listed policies.",
      "stateMode: Choose one of the listed state modes.",
      "completed: Choose Completed or Not completed.",
      `to: ${RANGE_MESSAGE}`,
      "pageSize: Use a whole number from 1 to 100.",
      "page: Use a whole number from 1.",
    ]) {
      expect(within(notice).getByText(text)).toBeInTheDocument();
    }
    expect(within(notice).getAllByRole("listitem")).toHaveLength(7);
    noTable();
    expect(screen.queryByRole("navigation", { name: "Pagination" })).not.toBeInTheDocument();
    expect(screen.queryByText("No transactions match these filters")).not.toBeInTheDocument();
  });

  it("shows each problem on its own field too", () => {
    mockWidth(1280);
    renderRoute(ALL_BAD);
    expect(corridorSelect()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("combobox", { name: "Policy" })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("combobox", { name: "State mode" })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("combobox", { name: "Completion" })).toHaveAttribute("aria-invalid", "true");
    expect(toInput()).toHaveAttribute("aria-invalid", "true");
    expect(sizeSelect()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getAllByText(RANGE_MESSAGE).length).toBeGreaterThan(0);
  });

  it("does not change the URL or the dates it was given", () => {
    mockWidth(1280);
    const { router } = renderRoute("/transactions?from=2026-11-05&to=2026-11-01");
    expect(router.state.location.search).toBe("?from=2026-11-05&to=2026-11-01");
    expect(fromInput()).toHaveValue("2026-11-05");
    expect(toInput()).toHaveValue("2026-11-01"); // not swapped or corrected
    noTable();
  });

  it("reports a malformed date", () => {
    mockWidth(1280);
    renderRoute("/transactions?from=banana");
    expect(screen.getAllByText("Use the format YYYY-MM-DD.").length).toBeGreaterThan(0);
    noTable();
  });

  it("reports a repeated parameter", () => {
    mockWidth(1280);
    renderRoute(`/transactions?corridor=${encodeURIComponent("GBR->PHL")}&corridor=${encodeURIComponent("USA->IND")}`);
    expect(screen.getAllByText(DUPLICATE_MESSAGE).length).toBeGreaterThan(0);
    noTable();
  });

  it.each(["page=0", "page=-2", "page=abc", "page=1.5", "pageSize=0", "pageSize=101", "pageSize=abc"])("reports %s", (query) => {
    mockWidth(1280);
    renderRoute(`/transactions?${query}`);
    expect(screen.getByText("Some parameters can't be used")).toBeInTheDocument();
    noTable();
  });

  it("fixing one problem does not hide the others", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions?corridor=XXX&policy=best");
    expect(screen.getByText("corridor: Choose one of the listed corridors.")).toBeInTheDocument();
    await user.selectOptions(corridorSelect(), "GBR->PHL");
    expect(screen.queryByText("corridor: Choose one of the listed corridors.")).not.toBeInTheDocument();
    expect(screen.getByText("policy: Choose one of the listed policies.")).toBeInTheDocument();
    noTable(); // still invalid, so still no list
  });

  it("shows the list again once everything is fixed", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    const { router } = renderRoute("/transactions?corridor=XXX&from=banana&foo=bar");
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(router.state.location.search).toBe("?foo=bar");
    expect(table()).toBeInTheDocument();
    expect(screen.queryByText("Some parameters can't be used")).not.toBeInTheDocument();
  });

  it("recovers when the date range is fixed through the fields", () => {
    mockWidth(1280);
    renderRoute("/transactions?from=2026-11-03&to=2026-11-01");
    expect(screen.getAllByText(RANGE_MESSAGE).length).toBeGreaterThan(0);
    fireEvent.change(toInput(), { target: { value: "2026-11-04" } }); // 3 Nov up to, not including, 4 Nov
    expect(screen.queryByText(RANGE_MESSAGE)).not.toBeInTheDocument();
    expect(table()).toBeInTheDocument();
    expect(pagination()).toHaveTextContent(`of ${rowsWhere((r) => r.createdAt.startsWith("2026-11-03")).length} transactions`);
  });
});

describe("a page past the last one", () => {
  it("shows the last page, says so, and does not change the URL by itself", () => {
    mockWidth(1280);
    const { router } = renderRoute("/transactions?page=99");
    expect(screen.getByText("Page 99 doesn't exist")).toBeInTheDocument();
    expect(screen.getByText(/These filters give 57 transactions on 3 pages\. The last page is shown below\./)).toBeInTheDocument();
    expect(dataRows()).toHaveLength(17);
    expect(pagination()).toHaveTextContent("Showing 41–57 of 57");
    expect(router.state.location.search).toBe("?page=99"); // not rewritten silently
  });

  it("goes to the last page with an explicit button", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    const { router } = renderRoute("/transactions?page=99");
    await user.click(screen.getByRole("button", { name: "Go to page 3" }));
    expect(router.state.location.search).toBe("?page=3");
    expect(screen.queryByText("Page 99 doesn't exist")).not.toBeInTheDocument();
    expect(dataRows()).toHaveLength(17);
  });

  it("uses the filtered total and the page size to find the last page", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    const own = rowsWhere((r) => r.corridor === "ARE->MEX").length; // more than 20, fewer than 40
    const { router } = renderRoute(`/transactions?corridor=${encodeURIComponent("ARE->MEX")}&page=5`);
    expect(screen.getByText("Page 5 doesn't exist")).toBeInTheDocument();
    expect(dataRows()).toHaveLength(own - 20);
    await user.click(screen.getByRole("button", { name: "Go to page 2" }));
    expect(router.state.location.search).toBe(`?corridor=${encodeURIComponent("ARE->MEX")}&page=2`);
  });

  it("goes to page 1 without writing a page when there is only one page", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    const { router } = renderRoute("/transactions?pageSize=100&page=2");
    expect(screen.getByText("Page 2 doesn't exist")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Go to page 1" }));
    expect(router.state.location.search).toBe("?pageSize=100");
  });

  it("pages backwards from the shown last page", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    const { router } = renderRoute("/transactions?page=99");
    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(router.state.location.search).toBe("?page=2");
    expect(pagination()).toHaveTextContent("Showing 21–40 of 57");
  });

  it("shows the empty state, not a page notice, when the filters match nothing", () => {
    mockWidth(1280);
    renderRoute("/transactions?from=2000-01-01&to=2000-01-02&page=2");
    expect(screen.getByText("No transactions match these filters")).toBeInTheDocument();
    expect(screen.queryByText(/doesn't exist/)).not.toBeInTheDocument();
  });
});

describe("states", () => {
  it("explains an empty filtered result and can clear the filters", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    const { router } = renderRoute("/transactions?from=2030-01-01");
    expect(screen.getByText("No transactions match these filters")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Clear filters" })[1]!);
    expect(router.state.location.search).toBe("");
    expect(table()).toBeInTheDocument();
  });

  it("shows ?state=empty as no transactions yet", () => {
    mockWidth(1280);
    renderRoute("/transactions?state=empty");
    expect(screen.getByText("No transactions yet")).toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByRole("link", { name: "New transaction" })).toHaveAttribute("href", "/transactions/new");
  });

  it("shows the loading state", () => {
    mockWidth(1280);
    renderRoute("/transactions?state=loading");
    expect(screen.getByRole("status")).toHaveTextContent("Loading transactions");
    noTable();
  });

  it("shows the error state and recovers with Try again", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions?state=error");
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load transactions");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(table()).toBeInTheDocument();
  });

  it("keeps the preview state while filtering", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    const { router } = renderRoute("/transactions?state=loading");
    await user.selectOptions(corridorSelect(), "GBR->PHL");
    expect(router.state.location.search).toBe("?state=loading&corridor=GBR-%3EPHL");
  });
});

describe("rows and links", () => {
  it("shows a failed row with an unconfirmed corridor and no executed values", () => {
    mockWidth(1280);
    renderRoute("/transactions?pageSize=100");
    const index = PREVIEW_TRANSACTIONS.findIndex((r) => r.outcome === "failed");
    const row = dataRows()[index]!;
    expect(row).toHaveTextContent("Failed");
    expect(within(row).getByText("Not confirmed")).toBeInTheDocument();
    const cells = within(row).getAllByRole("cell");
    expect(cells[6]).toHaveTextContent("—");
    expect(cells[6]!.textContent).not.toMatch(/\$|%/);
  });

  it("shows a partial row's executed amount and percentage from its detail", () => {
    mockWidth(1280);
    renderRoute("/transactions?pageSize=100");
    const index = PREVIEW_TRANSACTIONS.findIndex((r) => r.outcome === "partial");
    const totals = getPreviewTransactionDetail(PREVIEW_TRANSACTIONS[index]!.id)!.decision!.totals;
    const executed = within(dataRows()[index]!).getAllByRole("cell")[6]!;
    expect(executed).toHaveTextContent(formatUsd(totals.executedUsd));
    expect(executed).toHaveTextContent(formatPercent(totals.completionRatio));
    expect(totals.executedUsd).toBeLessThan(PREVIEW_TRANSACTIONS[index]!.amountUsd);
  });

  it("shows a rejected row as executing $0 at 0.0%", () => {
    mockWidth(1280);
    renderRoute("/transactions?pageSize=100");
    const index = PREVIEW_TRANSACTIONS.findIndex((r) => r.outcome === "rejected");
    const executed = within(dataRows()[index]!).getAllByRole("cell")[6]!;
    expect(executed).toHaveTextContent("$0");
    expect(executed).toHaveTextContent("0.0%");
  });

  it("gives every row the status its outcome has", () => {
    mockWidth(1280);
    renderRoute("/transactions?pageSize=100");
    const label = { completed: "Completed", partial: "Partial", rejected: "Rejected", failed: "Failed" } as const;
    dataRows().forEach((row, i) => {
      expect(within(row).getAllByRole("cell")[3]).toHaveTextContent(label[outcomeOf(toSummary(PREVIEW_TRANSACTIONS[i]!))]);
    });
  });

  it("links every one of the 57 rows to its own transaction, each of which has a detail page", () => {
    mockWidth(1280);
    renderRoute("/transactions?pageSize=100");
    const links = within(table()).getAllByRole("link");
    expect(links).toHaveLength(57);
    links.forEach((link, i) => {
      const id = PREVIEW_TRANSACTIONS[i]!.id;
      expect(link).toHaveAttribute("href", `/transactions/${id}`);
      expect(getPreviewTransactionDetail(id)).toBeDefined();
    });
  });

  it.each(["failed", "rejected", "partial", "completed"] as const)("opens the %s transaction's detail page from its row", async (outcome) => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions?pageSize=100");
    const index = PREVIEW_TRANSACTIONS.findIndex((r) => r.outcome === outcome);
    await user.click(within(dataRows()[index]!).getByRole("link"));
    expect(screen.getByRole("heading", { level: 1, name: "Transaction details" })).toBeInTheDocument();
    expect(screen.getAllByText(PREVIEW_TRANSACTIONS[index]!.id).length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: "Amounts" })).toBeInTheDocument();
  });

  it("still opens a transaction by its full ID", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions");
    const id = PREVIEW_TRANSACTIONS[0]!.id;
    await user.type(screen.getByRole("textbox", { name: "Open by transaction ID" }), id.toUpperCase());
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getAllByText(id).length).toBeGreaterThan(0);
  });
});

describe("History below 1024px", () => {
  it.each([1023, 800, 375])("keeps the existing history, unchanged, at %ipx", (width) => {
    mockWidth(width);
    renderRoute("/transactions");
    expect(screen.getByRole("heading", { level: 1, name: "History" })).toBeInTheDocument();
    expect(screen.getByText(PREVIEW_NOTICE)).toBeInTheDocument();
    expect(screen.getByText("Every stored transaction, newest first. Open one to see its allocation and explanation.")).toBeInTheDocument();
    expect(screen.getByLabelText("Created from")).toBeInTheDocument();
    expect(screen.getByLabelText("Created to")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Rows per page" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Transactions" })).getAllByRole("columnheader")).toHaveLength(7);
    expect(screen.getByRole("list", { name: "Transactions" })).toBeInTheDocument(); // the card list
    expect(pagination()).toHaveTextContent("Showing 1–20 of 57 transactions");
  });

  it("keeps the narrow date semantics: the end day is included", () => {
    mockWidth(800);
    renderRoute("/transactions?from=2026-11-01&to=2026-11-01");
    expect(pagination()).toHaveTextContent(`of ${PREVIEW_TRANSACTIONS.filter((r) => r.createdAt.startsWith("2026-11-01")).length} transactions`);
  });

  it("keeps ignoring invalid parameters quietly, as it always did", () => {
    mockWidth(800);
    renderRoute("/transactions?corridor=XXX&policy=best&from=banana");
    expect(pagination()).toHaveTextContent("Showing 1–20 of 57 transactions");
    expect(screen.queryByText("Some parameters can't be used")).not.toBeInTheDocument();
  });

  it("keeps clamping a page past the last one, as it always did", () => {
    mockWidth(800);
    renderRoute("/transactions?page=99");
    expect(pagination()).toHaveTextContent("Showing 41–57 of 57 transactions");
    expect(screen.queryByText(/doesn't exist/)).not.toBeInTheDocument();
  });

  it.each([
    ["loading", () => expect(screen.getByRole("status")).toHaveTextContent("Loading transactions")],
    ["empty", () => expect(screen.getByText("No transactions yet")).toBeInTheDocument()],
    ["error", () => expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load transactions")],
  ])("keeps the %s state", (state, check) => {
    mockWidth(1023);
    renderRoute(`/transactions?state=${state}`);
    check();
  });
});
