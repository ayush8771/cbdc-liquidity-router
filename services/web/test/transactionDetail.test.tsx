import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionPanel } from "../src/features/transactions/detail/DecisionPanel";
import { formatPercent, formatUsd } from "../src/lib/format";
import { PREVIEW_TRANSACTIONS } from "../src/preview/previewData";
import { PREVIEW_TRANSACTION_DETAILS, getPreviewTransactionDetail } from "../src/preview/previewDetail";
import { renderRoute } from "./renderRoute";

const original = window.matchMedia;

/** A matchMedia that answers the desktop query by width. */
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
const region = (name: string) => screen.getByRole("region", { name });
const PREVIEW_NOTICE = "Preview data — illustrative, not from the API";
// The contract's DecisionId: "sha256:" and exactly 64 lowercase hex digits.
const DECISION_ID = /^sha256:[0-9a-f]{64}$/;
/** The value cell of the Decision card's "Decision ID" row. */
const decisionIdCell = () => within(region("Decision")).getByText("Decision ID").nextElementSibling as HTMLElement;

describe("preview transaction details", () => {
  it("has one detail per preview transaction, in the same order, agreeing with the list row", () => {
    expect(PREVIEW_TRANSACTION_DETAILS).toHaveLength(PREVIEW_TRANSACTIONS.length);
    PREVIEW_TRANSACTION_DETAILS.forEach((d, i) => {
      const row = PREVIEW_TRANSACTIONS[i]!;
      expect(d.id).toBe(row.id);
      expect(d.outcome).toBe(row.outcome);
      expect(d.amountUsd).toBe(row.amountUsd);
      expect(d.policy).toBe(row.policy);
      expect(d.policyTier).toBe(row.policyTier);
      expect(d.corridor).toBe(row.corridor);
      expect(d.createdAt).toBe(row.createdAt);
      expect(getPreviewTransactionDetail(row.id)).toBe(d);
    });
  });

  it("covers completed, partial, rejected and failed outcomes", () => {
    const outcomes = new Set(PREVIEW_TRANSACTION_DETAILS.map((d) => d.outcome));
    expect([...outcomes].sort()).toEqual(["completed", "failed", "partial", "rejected"]);
  });

  it("keeps amounts internally consistent", () => {
    for (const d of PREVIEW_TRANSACTION_DETAILS) {
      if (!d.decision) continue;
      const { allocations, totals } = d.decision;
      const sum = (pick: (a: (typeof allocations)[number]) => number) => allocations.reduce((s, a) => s + pick(a), 0);
      expect(totals.executedUsd).toBe(sum((a) => a.amountExecutedUsd));
      expect(totals.requestedUsd).toBe(sum((a) => a.amountRequestedUsd));
      expect(totals.executedUsd).toBeLessThanOrEqual(d.amountUsd);
      expect(totals.unroutedAmountBasedUsd).toBe(d.amountUsd - totals.executedUsd);
      expect(totals.completionRatio).toBeCloseTo(totals.executedUsd / d.amountUsd, 12);
      expect(totals.completed).toBe(totals.executedUsd === d.amountUsd);
      expect(totals.bridgesUsed).toBe(allocations.filter((a) => a.amountExecutedUsd > 0).length);
      for (const a of allocations) {
        expect(a.amountExecutedUsd).toBeLessThanOrEqual(a.amountRequestedUsd);
        expect(a.amountExecutedUsd).toBeLessThanOrEqual(a.liquidityUsd);
        expect(a.amountClippedUsd).toBe(a.amountRequestedUsd - a.amountExecutedUsd);
      }
    }
  });

  it("matches each outcome to its decision", () => {
    for (const d of PREVIEW_TRANSACTION_DETAILS) {
      if (d.outcome === "failed") {
        expect(d.status).toBe("failed");
        expect(d.decision).toBeNull();
        expect(d.corridor).toBeNull();
        expect(d.policyTier).toBeNull();
        expect(d.failure?.code).toBeTruthy();
        expect(d.failure?.message).toBeTruthy();
        continue;
      }
      expect(d.status).toBe("routed");
      expect(d.failure).toBeNull();
      const decision = d.decision!;
      if (d.outcome === "rejected") {
        expect(decision.feasibility.allowed).toBe(false);
        expect(decision.allocations).toEqual([]);
        expect(decision.totals.executedUsd).toBe(0);
        expect(decision.totals.unroutedAmountBasedUsd).toBe(d.amountUsd);
      } else {
        expect(decision.feasibility.allowed).toBe(true);
        expect(decision.totals.completed).toBe(d.outcome === "completed");
        expect(decision.warnings.some((w) => w.code === "PARTIAL_COMPLETION")).toBe(d.outcome === "partial");
      }
    }
  });

  it("gives every decision a non-null decision ID in the contract's form", () => {
    const decisions = PREVIEW_TRANSACTION_DETAILS.flatMap((d) => (d.decision ? [d.decision] : []));
    expect(decisions.length).toBeGreaterThan(0);
    for (const decision of decisions) {
      expect(decision.decisionId).not.toBeNull();
      expect(decision.decisionId).toMatch(DECISION_ID);
    }
  });

  it("gives every outcome that has a decision an ID: completed, partial and rejected", () => {
    for (const outcome of ["completed", "partial", "rejected"] as const) {
      const rows = PREVIEW_TRANSACTION_DETAILS.filter((d) => d.outcome === outcome);
      expect(rows.length, outcome).toBeGreaterThan(0);
      for (const d of rows) expect(d.decision!.decisionId, `${outcome} ${d.id}`).toMatch(DECISION_ID);
    }
  });

  it("gives every decision a different ID", () => {
    const ids = PREVIEW_TRANSACTION_DETAILS.flatMap((d) => (d.decision ? [d.decision.decisionId] : []));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not make up an ID for a failed transaction: it has no decision to identify", () => {
    const failed = PREVIEW_TRANSACTION_DETAILS.filter((d) => d.outcome === "failed");
    expect(failed.length).toBeGreaterThan(0);
    for (const d of failed) {
      expect(d.decision).toBeNull();
      expect(JSON.stringify(d)).not.toContain("sha256:");
    }
  });

  it("is stable: asking for a transaction's detail twice gives the same ID", () => {
    const d = firstWhere((x) => !!x.decision);
    expect(getPreviewTransactionDetail(d.id)!.decision!.decisionId).toBe(d.decision!.decisionId);
  });
});

describe("TransactionDetailPage at 1024px and above", () => {
  it.each([1024, 1280, 1440])("shows the detail page at %ipx", (width) => {
    mockWidth(width);
    const d = firstWhere((x) => x.outcome === "completed");
    renderRoute(`/transactions/${d.id}`);
    expect(screen.getByRole("heading", { level: 1, name: "Transaction details" })).toBeInTheDocument();
    // The ID is in the heading, as before, and again in the Transaction ID row.
    expect(screen.getAllByText(d.id)).toHaveLength(2);
    expect(within(region("Transaction")).getByText(d.id)).toBeInTheDocument();
    expect(region("Amounts")).toBeInTheDocument();
    expect(screen.queryByText("This screen isn't connected yet")).not.toBeInTheDocument();
  });

  it("labels the page as preview data and links back to the history", () => {
    mockWidth(1280);
    renderRoute(`/transactions/${PREVIEW_TRANSACTIONS[0]!.id}`);
    expect(screen.getByText(PREVIEW_NOTICE)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Back to history/ })).toHaveAttribute("href", "/transactions");
    expect(screen.getByText("Simulated")).toBeInTheDocument();
  });

  it("shows a completed transaction's amounts, details, decision and allocations", () => {
    mockWidth(1280);
    const d = firstWhere((x) => x.outcome === "completed" && x.policy === "waterfall");
    const totals = d.decision!.totals;
    renderRoute(`/transactions/${d.id}`);

    expect(region("Amounts")).toHaveTextContent(
      `${formatUsd(d.amountUsd)}Requested${formatUsd(totals.executedUsd)}Executed${formatUsd(0)}Unrouted`,
    );
    const details = region("Transaction");
    expect(details).toHaveTextContent("Completed");
    expect(details).toHaveTextContent(d.corridor!.replace("->", " → "));
    expect(details).toHaveTextContent(d.senderCountry);
    expect(details).toHaveTextContent(d.receiverCountry);
    expect(details).toHaveTextContent("Default (waterfall)");
    expect(region("Decision")).toHaveTextContent("Allowed");
    expect(region("Warnings").querySelector("li") !== null || region("Warnings").textContent?.includes("No warnings")).toBe(true);

    const rows = within(region("Allocations")).getAllByRole("row");
    expect(rows).toHaveLength(d.decision!.allocations.length + 1); // plus the header row
    expect(within(region("Allocations")).getByText(d.decision!.allocations[0]!.bridgeUid)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a partial completion as an outcome, with the amount-based unrouted figure", () => {
    mockWidth(1280);
    const d = firstWhere((x) => x.outcome === "partial");
    const totals = d.decision!.totals;
    renderRoute(`/transactions/${d.id}`);

    expect(screen.getByText("Partially completed")).toBeInTheDocument();
    expect(region("Amounts")).toHaveTextContent(`${formatUsd(totals.unroutedAmountBasedUsd)}Unrouted`);
    expect(totals.unroutedAmountBasedUsd).toBe(d.amountUsd - totals.executedUsd);
    expect(region("Decision")).toHaveTextContent(formatPercent(totals.completionRatio));
    expect(region("Warnings")).toHaveTextContent("PARTIAL_COMPLETION");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a regulatory rejection as a business outcome, with no allocations", () => {
    mockWidth(1280);
    const d = firstWhere((x) => x.outcome === "rejected");
    renderRoute(`/transactions/${d.id}`);

    expect(screen.getByText("Rejected by the feasibility rules")).toBeInTheDocument();
    expect(screen.getByText(/valid routing result, not an error/, { selector: "p" })).toBeInTheDocument();
    expect(region("Decision")).toHaveTextContent("Not allowed");
    expect(region("Decision")).toHaveTextContent(d.decision!.feasibility.reason!);
    expect(region("Amounts")).toHaveTextContent(`${formatUsd(0)}Executed${formatUsd(d.amountUsd)}Unrouted`);
    expect(region("Allocations")).toHaveTextContent("The transaction wasn't allowed, so nothing was allocated.");
    expect(within(region("Allocations")).queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a failed transaction with its failure and dashes for everything derived from the decision", () => {
    mockWidth(1280);
    const d = firstWhere((x) => x.outcome === "failed");
    renderRoute(`/transactions/${d.id}`);

    expect(screen.getByText("Routing failed")).toBeInTheDocument();
    expect(screen.getByText(d.failure!.code)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(d.failure!.message))).toBeInTheDocument();
    expect(region("Amounts")).toHaveTextContent(`${formatUsd(d.amountUsd)}Requested—Executed—Unrouted`);
    expect(region("Transaction")).toHaveTextContent("Failed");
    expect(within(region("Transaction")).getAllByText("Not available").length).toBeGreaterThan(0); // no corridor
    expect(within(region("Decision")).getAllByText("Not available")).toHaveLength(8);
    expect(region("Allocations")).toHaveTextContent("There is no decision for this transaction");
    expect(within(region("Warnings")).getByText("Not available")).toBeInTheDocument();
  });

  it.each(["completed", "partial", "rejected"] as const)("shows the decision ID, as text, for a %s transaction", (outcome) => {
    mockWidth(1280);
    const d = firstWhere((x) => x.outcome === outcome);
    renderRoute(`/transactions/${d.id}`);
    const cell = decisionIdCell();
    expect(cell).toHaveTextContent(d.decision!.decisionId);
    expect(cell.textContent).toMatch(DECISION_ID);
    expect(within(cell).queryByText("Not available")).not.toBeInTheDocument();
    expect(within(cell).queryByRole("link")).not.toBeInTheDocument();
  });

  it("shows the decision ID on every page that has a decision, and never a dash there", () => {
    mockWidth(1280);
    for (const d of PREVIEW_TRANSACTION_DETAILS.filter((x) => !!x.decision)) {
      const { unmount } = renderRoute(`/transactions/${d.id}`);
      expect(decisionIdCell().textContent, d.id).toBe(d.decision!.decisionId);
      unmount();
    }
  });

  it("shows a dash for a failed transaction's decision ID, because it has no decision, and invents none", () => {
    mockWidth(1280);
    const d = firstWhere((x) => x.outcome === "failed");
    renderRoute(`/transactions/${d.id}`);
    const cell = decisionIdCell();
    expect(cell).toHaveTextContent("—");
    expect(within(cell).getByText("Not available")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("sha256:");
  });
});

describe("DecisionPanel's defensive fallback", () => {
  // The contract forbids a decision without an ID, so this can't be produced by the preview data or
  // by the types. It checks that the panel still doesn't break or show a blank, if one ever arrives.
  it("shows a dash for the ID, and still shows the rest of the decision", () => {
    const decision = firstWhere((x) => x.outcome === "completed").decision!;
    render(<DecisionPanel decision={{ ...decision, decisionId: null as unknown as string }} />);
    const cell = within(screen.getByRole("region", { name: "Decision" })).getByText("Decision ID").nextElementSibling as HTMLElement;
    expect(cell).toHaveTextContent("—");
    expect(within(cell).getByText("Not available")).toBeInTheDocument();
    expect(screen.getByText("Allowed")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Decision" })).toHaveTextContent(formatPercent(decision.totals.completionRatio));
  });

  it("shows a dash for an empty-string ID too, never a blank", () => {
    const decision = firstWhere((x) => x.outcome === "partial").decision!;
    render(<DecisionPanel decision={{ ...decision, decisionId: "" }} />);
    const cell = within(screen.getByRole("region", { name: "Decision" })).getByText("Decision ID").nextElementSibling as HTMLElement;
    expect(cell).toHaveTextContent("—");
  });

  it("shows the ID when there is one", () => {
    const decision = firstWhere((x) => x.outcome === "rejected").decision!;
    render(<DecisionPanel decision={decision} />);
    expect(screen.getByText(decision.decisionId)).toBeInTheDocument();
  });

  it("shows a dash on every row when there is no decision at all", () => {
    render(<DecisionPanel decision={null} />);
    expect(within(screen.getByRole("region", { name: "Decision" })).getAllByText("Not available")).toHaveLength(8);
  });
});

describe("TransactionDetailPage at 1024px and above (continued)", () => {

  it("carries the required policy and provenance labels", () => {
    mockWidth(1280);
    const ppo = firstWhere((x) => x.policy === "ppoProjected" && !!x.decision);
    const { unmount } = renderRoute(`/transactions/${ppo.id}`);
    expect(region("Transaction")).toHaveTextContent("Experimental");
    expect(region("Warnings")).toHaveTextContent("EXPERIMENTAL_POLICY");
    unmount();

    const explicit = firstWhere((x) => x.stateMode === "explicit");
    renderRoute(`/transactions/${explicit.id}`);
    expect(region("Transaction")).toHaveTextContent("User-supplied synthetic state");
  });

  it("marks synthetic-expansion venues in the allocation table", () => {
    mockWidth(1280);
    const d = firstWhere((x) => !!x.decision?.allocations.some((a) => a.dataSourceTag === "synthetic_bridge_expansion"));
    renderRoute(`/transactions/${d.id}`);
    expect(within(region("Allocations")).getAllByText("Synthetic venue").length).toBeGreaterThan(0);
  });

  it("has no explanation panel or link", () => {
    mockWidth(1280);
    renderRoute(`/transactions/${PREVIEW_TRANSACTIONS[0]!.id}`);
    expect(screen.queryByText(/explanation/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /explain/i })).not.toBeInTheDocument();
  });

  it("has exactly one h1", () => {
    mockWidth(1280);
    renderRoute(`/transactions/${PREVIEW_TRANSACTIONS[0]!.id}`);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });
});

describe("TransactionDetailPage states at 1024px and above", () => {
  it("keeps the heading and the ID for a valid ID the preview data doesn't know", () => {
    mockWidth(1280);
    renderRoute("/transactions/1b12ba0b-f730-4cfe-9443-024e91ca3331");
    expect(screen.getByRole("heading", { level: 1, name: "Transaction details" })).toBeInTheDocument();
    expect(screen.getByText("1b12ba0b-f730-4cfe-9443-024e91ca3331")).toBeInTheDocument();
    expect(screen.getByText("Transaction not found")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Back to history/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says when the address has no valid transaction ID", () => {
    mockWidth(1280);
    renderRoute("/transactions/not-an-id");
    expect(screen.getByRole("heading", { level: 1, name: "Transaction details" })).toBeInTheDocument();
    expect(screen.getByText("This address doesn't contain a valid transaction ID.")).toBeInTheDocument();
    expect(screen.getByText("No transaction to show")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Back to history/ })).toHaveAttribute("href", "/transactions");
    expect(screen.queryByText(PREVIEW_NOTICE)).not.toBeInTheDocument();
  });

  it("shows the loading state", () => {
    mockWidth(1280);
    renderRoute(`/transactions/${PREVIEW_TRANSACTIONS[0]!.id}?state=loading`);
    expect(screen.getByRole("status")).toHaveTextContent("Loading the transaction");
    expect(screen.queryByRole("region", { name: "Amounts" })).not.toBeInTheDocument();
  });

  it("shows the error state and recovers with Try again", async () => {
    mockWidth(1280);
    renderRoute(`/transactions/${PREVIEW_TRANSACTIONS[0]!.id}?state=error`);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load this transaction");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(region("Amounts")).toBeInTheDocument();
  });

  it("opens from a history row", async () => {
    mockWidth(1280);
    renderRoute("/transactions");
    const first = PREVIEW_TRANSACTIONS[0]!;
    const link = screen.getAllByRole("link", { name: new RegExp(`transaction ${first.id.split("-")[0]}`, "i") })[0]!;
    await userEvent.click(link);
    expect(region("Amounts")).toBeInTheDocument();
    expect(within(region("Transaction")).getByText(first.id)).toBeInTheDocument();
  });
});

describe("TransactionDetailPage below 1024px", () => {
  it.each([1023, 768, 375])("keeps the existing placeholder at %ipx", (width) => {
    mockWidth(width);
    const d = PREVIEW_TRANSACTIONS[0]!;
    renderRoute(`/transactions/${d.id}`);
    expect(screen.getByRole("heading", { level: 1, name: "Transaction details" })).toBeInTheDocument();
    expect(screen.getByText(d.id)).toBeInTheDocument();
    expect(screen.getByText("This screen isn't connected yet")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Endpoints" })).toHaveTextContent("GET /api/v1/transactions/{id}/explanation");
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.queryByText(PREVIEW_NOTICE)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Amounts" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Back to history/ })).toHaveAttribute("href", "/transactions");
  });

  it("keeps the invalid-ID message", () => {
    mockWidth(800);
    renderRoute("/transactions/not-an-id");
    expect(screen.getByText("This address doesn't contain a valid transaction ID.")).toBeInTheDocument();
    expect(screen.getByText("This screen isn't connected yet")).toBeInTheDocument();
  });
});
