import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PAGE_SIZE } from "../src/features/transactions/filters";
import { PREVIEW_TRANSACTIONS } from "../src/preview/previewData";
import { renderRoute } from "./renderRoute";

// jsdom applies no CSS, so both the desktop table and the mobile card list are
// in the DOM. These helpers scope to the table.
const table = () => screen.getByRole("table", { name: "Transactions" });
const dataRows = () => within(table()).getAllByRole("row").slice(1);
const column = (index: number) => dataRows().map((row) => within(row).getAllByRole("cell")[index]!.textContent);

describe("HistoryPage (preview data)", () => {
  it("shows the first page with every requested column, labelled as preview data", () => {
    renderRoute("/transactions");
    expect(screen.getByText("Preview data — illustrative, not from the API")).toBeInTheDocument();
    expect(within(table()).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Transaction",
      "Corridor",
      "Amount",
      "Status",
      "Policy",
      "Created",
      "Details",
    ]);
    expect(dataRows()).toHaveLength(PAGE_SIZE);
    expect(screen.getByRole("navigation", { name: "Pagination" })).toHaveTextContent(
      `Showing 1–20 of ${PREVIEW_TRANSACTIONS.length} transactions`,
    );
  });

  it("pages through results and keeps the page in the URL", async () => {
    const { router } = renderRoute("/transactions");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(router.state.location.search).toBe("?page=2");
    expect(screen.getByRole("navigation", { name: "Pagination" })).toHaveTextContent("Showing 21–40");
  });

  it("filters by corridor under the contract's query name and resets to page 1", async () => {
    const { router } = renderRoute("/transactions?page=2");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Corridor" }), "GBR->PHL");
    expect(router.state.location.search).toBe("?corridor=GBR-%3EPHL");
    const expected = PREVIEW_TRANSACTIONS.filter((r) => r.corridor === "GBR->PHL").length;
    expect(screen.getByRole("navigation", { name: "Pagination" })).toHaveTextContent(`of ${expected} transactions`);
    expect(new Set(column(1))).toEqual(new Set(["GBR → PHL"]));
  });

  it("filters by completion, which never matches failed transactions", async () => {
    renderRoute("/transactions");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Completion" }), "true");
    expect(new Set(column(3))).toEqual(new Set(["Completed"]));
  });

  it("shows failed rows with an unconfirmed corridor and the Failed status", () => {
    const index = PREVIEW_TRANSACTIONS.findIndex((r) => r.outcome === "failed");
    expect(index).toBeGreaterThanOrEqual(0);
    renderRoute(`/transactions?page=${Math.floor(index / PAGE_SIZE) + 1}`);
    const row = dataRows()[index % PAGE_SIZE]!;
    expect(row).toHaveTextContent("Not confirmed");
    expect(row).toHaveTextContent("Failed");
  });

  it("explains an empty filtered result and can clear the filters", async () => {
    const { router } = renderRoute("/transactions?from=2030-01-01");
    expect(screen.getByText("No transactions match these filters")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]!);
    expect(router.state.location.search).toBe("");
  });

  it("opens a transaction by its full ID, and rejects partial IDs", async () => {
    renderRoute("/transactions");
    const field = screen.getByRole("textbox", { name: "Open by transaction ID" });
    await userEvent.type(field, "1b12ba0b");
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(field).toHaveAttribute("aria-invalid", "true");

    await userEvent.clear(field);
    await userEvent.type(field, "1B12BA0B-F730-4CFE-9443-024E91CA3331");
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("heading", { level: 1, name: "Transaction details" })).toBeInTheDocument();
    expect(screen.getByText("1b12ba0b-f730-4cfe-9443-024e91ca3331")).toBeInTheDocument();
  });

  it("links every row and every mobile card to the transaction's details", () => {
    renderRoute("/transactions");
    const first = PREVIEW_TRANSACTIONS[0]!;
    const cards = screen.getByRole("list", { name: "Transactions" });
    expect(within(cards).getAllByRole("link")).toHaveLength(PAGE_SIZE);
    expect(within(cards).getAllByRole("link")[0]).toHaveAttribute("href", `/transactions/${first.id}`);
    expect(within(table()).getAllByRole("link")[0]).toHaveAttribute("href", `/transactions/${first.id}`);
  });

  it.each([
    ["loading", () => expect(screen.getByRole("status")).toHaveTextContent("Loading transactions")],
    ["empty", () => expect(screen.getByText("No transactions yet")).toBeInTheDocument()],
    ["error", () => expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load transactions")],
  ])("shows the %s state", (state, check) => {
    renderRoute(`/transactions?state=${state}`);
    check();
  });
});

describe("TransactionDetailPage", () => {
  it("says when the address has no valid transaction ID", () => {
    renderRoute("/transactions/not-an-id");
    expect(screen.getByText("This address doesn't contain a valid transaction ID.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Back to history/ })).toHaveAttribute("href", "/transactions");
  });
});
