import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DescriptionList } from "../src/components/ui/DescriptionList";
import { ErrorState } from "../src/components/ui/ErrorState";
import { FormField } from "../src/components/ui/FormField";
import { LoadingState } from "../src/components/ui/LoadingState";
import { Pagination } from "../src/components/ui/Pagination";
import { Select } from "../src/components/ui/Select";
import { Stat } from "../src/components/ui/Stat";
import { Table, type TableColumn } from "../src/components/ui/Table";

type Row = { id: string; name: string; amount: string };
const columns: TableColumn<Row>[] = [
  { key: "name", header: "Name", cell: (r) => r.name },
  { key: "amount", header: "Amount", cell: (r) => r.amount, numeric: true },
];

describe("Table", () => {
  it("renders a captioned table with column headers and one row per item", () => {
    render(
      <Table
        caption="Sample rows"
        columns={columns}
        rows={[
          { id: "a", name: "First", amount: "1" },
          { id: "b", name: "Second", amount: "2" },
        ]}
        getRowKey={(r) => r.id}
      />,
    );
    const table = screen.getByRole("table", { name: "Sample rows" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Amount"]);
    expect(within(table).getAllByRole("row")).toHaveLength(3); // header + 2
  });

  it("shows the empty state instead of an empty table", () => {
    render(<Table caption="Sample rows" columns={columns} rows={[]} getRowKey={(r) => r.id} empty={<p>Nothing yet</p>} />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("Nothing yet")).toBeInTheDocument();
  });
});

describe("Select", () => {
  it("works with FormField for its label and error", () => {
    render(
      <FormField label="Corridor" error="Choose a corridor.">
        {({ invalid, ...control }) => (
          <Select {...control} invalid={invalid} defaultValue="">
            <option value="">Select…</option>
            <option value="x">X</option>
          </Select>
        )}
      </FormField>,
    );
    const select = screen.getByRole("combobox", { name: "Corridor" });
    expect(select).toHaveAttribute("aria-invalid", "true");
    expect(select).toHaveAccessibleDescription("Choose a corridor.");
  });
});

describe("Pagination", () => {
  it("summarises the visible range and disables Previous on the first page", async () => {
    const onPageChange = vi.fn();
    render(<Pagination page={1} pageSize={20} total={57} onPageChange={onPageChange} itemLabel="transactions" />);
    const nav = screen.getByRole("navigation", { name: "Pagination" });
    expect(nav).toHaveTextContent("Showing 1–20 of 57 transactions");
    expect(within(nav).getByRole("button", { name: "Previous" })).toBeDisabled();
    await userEvent.click(within(nav).getByRole("button", { name: "Next" }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("disables Next on the last page and clamps the range", () => {
    render(<Pagination page={3} pageSize={20} total={57} onPageChange={() => {}} />);
    expect(screen.getByRole("navigation")).toHaveTextContent("Showing 41–57 of 57 results");
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("renders nothing when there are no results", () => {
    const { container } = render(<Pagination page={1} pageSize={20} total={0} onPageChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("LoadingState and ErrorState", () => {
  it("announces loading politely", () => {
    render(<LoadingState label="Loading transactions" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading transactions");
  });

  it("announces an error with its reference and action", () => {
    render(
      <ErrorState
        title="Couldn't load transactions"
        message="Please try again."
        reference="req-123"
        action={<button type="button">Try again</button>}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load transactions");
    expect(alert).toHaveTextContent("Reference: req-123");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("DescriptionList and Stat", () => {
  it("pairs each term with its detail", () => {
    render(<DescriptionList items={[{ term: "Mode", detail: "Replay" }]} />);
    expect(screen.getByRole("term")).toHaveTextContent("Mode");
    expect(screen.getByRole("definition")).toHaveTextContent("Replay");
  });

  it("shows the value with its caption", () => {
    render(<Stat value="97.1%" label="Completion rate" />);
    expect(screen.getByText("97.1%")).toBeInTheDocument();
    expect(screen.getByText("Completion rate")).toBeInTheDocument();
  });
});
