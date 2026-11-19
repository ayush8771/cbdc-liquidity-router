import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as mockModule from "../src/preview/mockSubmit";
import { renderRoute } from "./renderRoute";

const original = window.matchMedia;
const realSubmit = mockModule.submitPreviewTransaction;
let submitSpy: MockInstance<typeof mockModule.submitPreviewTransaction>;

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

beforeEach(() => {
  // Same service, no artificial delay.
  submitSpy = vi.spyOn(mockModule, "submitPreviewTransaction").mockImplementation((p, o) => realSubmit(p, { ...o, delayMs: 0 }));
});
afterEach(() => {
  submitSpy.mockRestore();
  window.matchMedia = original;
});

const PREVIEW_RESULT = "Preview result — illustrative, not from the API";
const form = () => screen.getByRole("region", { name: "New transaction form" });
const corridorSelect = () => screen.getByRole("combobox", { name: "Corridor" });
const amountInput = () => screen.getByRole("textbox", { name: "Amount (USD)" });
const submitButton = () => screen.getByRole("button", { name: "Route transaction" });
const dateInput = () => screen.getByLabelText(/^Date/);

async function fillReplay(user: ReturnType<typeof userEvent.setup>, amount = "100000", corridor = "GBR->PHL") {
  await user.selectOptions(corridorSelect(), corridor);
  await user.type(amountInput(), amount);
  fireEvent.change(dateInput(), { target: { value: "2024-06-14" } });
}

async function fillExplicit(user: ReturnType<typeof userEvent.setup>, liquidity: string, amount = "100000") {
  await user.selectOptions(corridorSelect(), "GBR->PHL");
  await user.type(amountInput(), amount);
  await user.selectOptions(screen.getByRole("combobox", { name: "State mode" }), "explicit");
  fireEvent.change(screen.getByLabelText(/^Reference date/), { target: { value: "2024-06-14" } });
  for (const uid of ["GBR->PHL#0", "GBR->PHL#1", "GBR->PHL#2"]) {
    await user.type(screen.getByRole("textbox", { name: `${uid} liquidity (USD)` }), liquidity);
    await user.type(screen.getByRole("textbox", { name: `${uid} congestion` }), "0.2");
  }
}

describe("NewTransactionPage at 1024px and above", () => {
  it.each([1024, 1280, 1440])("shows the form at %ipx", (width) => {
    mockWidth(width);
    renderRoute("/transactions/new");
    expect(screen.getByRole("heading", { level: 1, name: "New transaction" })).toBeInTheDocument();
    expect(form()).toBeInTheDocument();
    expect(screen.queryByText("This screen isn't connected yet")).not.toBeInTheDocument();
  });

  it("labels the page as preview data and keeps the no-liquidity-carry-over note visible", () => {
    mockWidth(1280);
    renderRoute("/transactions/new");
    expect(screen.getByText("Preview data — illustrative, not from the API")).toBeInTheDocument();
    expect(screen.getByText(/Replay transactions don't consume liquidity/)).toBeInTheDocument();
    expect(screen.getByText("Simulated")).toBeInTheDocument();
    expect(screen.getByText("No result yet")).toBeInTheDocument();
  });

  it("offers three corridors, waterfall by default, and ppoProjected disabled with its reason", () => {
    mockWidth(1280);
    renderRoute("/transactions/new");
    expect(within(corridorSelect()).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Choose a corridor",
      "USA → IND",
      "GBR → PHL",
      "ARE → MEX",
    ]);
    const policy = screen.getByRole("combobox", { name: "Policy" });
    expect(policy).toHaveValue("waterfall");
    expect(screen.getByRole("option", { name: "PPO (projected) — unavailable" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "Cheapest feasible" })).toBeEnabled();
    expect(screen.getByText(/Unavailable: no approved checkpoint configured/)).toBeInTheDocument();
  });

  it("shows no explanation or comparison controls", () => {
    mockWidth(1280);
    renderRoute("/transactions/new");
    expect(screen.queryByText(/explanation/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/compare/i, { selector: "main *" })).not.toBeInTheDocument();
  });

  it("lists the scenarios sorted by id, the order the API returns them in", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions/new");
    await user.selectOptions(screen.getByRole("combobox", { name: "State mode" }), "scenario");
    const options = within(screen.getByRole("combobox", { name: "Scenario" })).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Choose a scenario",
      "baseline",
      "cheapest_venue_outage",
      "combined_stress",
      "congestion_x2",
      "liquidity_minus30",
      "liquidity_minus50",
    ]);
  });

  it("shows the scenario field only in scenario mode, and the explicit fields only in explicit mode", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions/new");
    const mode = screen.getByRole("combobox", { name: "State mode" });
    expect(screen.queryByRole("combobox", { name: "Scenario" })).not.toBeInTheDocument();

    await user.selectOptions(mode, "scenario");
    expect(screen.getByRole("combobox", { name: "Scenario" })).toBeInTheDocument();
    expect(within(screen.getByRole("combobox", { name: "Scenario" })).getAllByRole("option")).toHaveLength(7); // placeholder + 6

    await user.selectOptions(mode, "explicit");
    expect(screen.queryByRole("combobox", { name: "Scenario" })).not.toBeInTheDocument();
    expect(screen.getByText("User-supplied synthetic state")).toBeInTheDocument();
    expect(screen.getByText("Choose a corridor to enter its venues.")).toBeInTheDocument();
    await user.selectOptions(corridorSelect(), "GBR->PHL");
    expect(screen.getAllByRole("group").filter((g) => g.getAttribute("aria-label")?.startsWith("GBR->PHL#"))).toHaveLength(3);
  });
});

describe("validation", () => {
  it("shows field errors, sends nothing, and moves focus to the first error", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions/new");
    await user.click(submitButton());

    expect(screen.getByText("Choose a corridor.")).toBeInTheDocument();
    expect(screen.getByText("Enter an amount.")).toBeInTheDocument();
    expect(screen.getByText("Enter a date.")).toBeInTheDocument();
    expect(corridorSelect()).toHaveAttribute("aria-invalid", "true");
    expect(corridorSelect()).toHaveFocus();
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("explains an amount of zero and clears an error once the field is edited", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions/new");
    await user.type(amountInput(), "0");
    await user.click(submitButton());
    expect(screen.getByText("The amount must be greater than 0 and finite.")).toBeInTheDocument();
    await user.type(amountInput(), "5");
    expect(screen.queryByText("The amount must be greater than 0 and finite.")).not.toBeInTheDocument();
  });

  it("requires a scenario in scenario mode", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions/new");
    await fillReplay(user);
    await user.selectOptions(screen.getByRole("combobox", { name: "State mode" }), "scenario");
    await user.click(submitButton());
    expect(screen.getByText("Choose a scenario.")).toBeInTheDocument();
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("requires each explicit venue's liquidity and congestion", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions/new");
    await user.selectOptions(corridorSelect(), "GBR->PHL");
    await user.type(amountInput(), "100000");
    await user.selectOptions(screen.getByRole("combobox", { name: "State mode" }), "explicit");
    await user.click(submitButton());
    expect(screen.getAllByText("Enter the liquidity.")).toHaveLength(3);
    expect(screen.getAllByText("Enter the congestion.")).toHaveLength(3);
    expect(screen.getByText("Enter a date.")).toBeInTheDocument();
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("does not check date eligibility itself: the engine decides", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions/new");
    await user.selectOptions(corridorSelect(), "GBR->PHL");
    await user.type(amountInput(), "100000");
    fireEvent.change(dateInput(), { target: { value: "2030-01-01" } });
    await user.click(submitButton());
    // It reached the (mock) engine, which answered with a form-level error.
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("alert")).toHaveTextContent("DATE_OUT_OF_RANGE");
  });
});

describe("results", () => {
  it("shows a completed result, labelled as a preview, with the transaction ID as text only", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions/new");
    await fillReplay(user);
    await user.click(submitButton());

    expect(await screen.findByText("Routed and fully executed")).toBeInTheDocument();
    expect(screen.getByText(PREVIEW_RESULT)).toBeInTheDocument();
    const result = screen.getByRole("region", { name: "Result" });
    expect(result).toHaveTextContent("$100,000Requested$100,000Executed$0Unrouted");
    expect(within(screen.getByRole("region", { name: "Allocations" })).getAllByRole("row").length).toBeGreaterThan(1);

    const id = within(result).getByText(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    expect(id.closest("a")).toBeNull();
    expect(screen.queryByRole("link", { name: new RegExp(id.textContent!) })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a regulatory rejection as a result, not an error", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions/new");
    await fillReplay(user, "600000");
    await user.click(submitButton());

    expect(await screen.findByText("Rejected by the feasibility rules")).toBeInTheDocument();
    expect(screen.getByText(PREVIEW_RESULT)).toBeInTheDocument();
    expect(screen.getByText(/valid routing result, not an error/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Result" })).toHaveTextContent("$0Executed$600,000Unrouted");
    expect(screen.getByRole("region", { name: "Allocations" })).toHaveTextContent("Nothing was allocated");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a partial completion as a result, with the amount-based unrouted figure", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions/new");
    await fillExplicit(user, "10000");
    await user.click(submitButton());

    expect(await screen.findByText("Partially completed")).toBeInTheDocument();
    expect(screen.getByText(PREVIEW_RESULT)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Result" })).toHaveTextContent("$100,000Requested$30,000Executed$70,000Unrouted");
    expect(screen.getByRole("region", { name: "Warnings" })).toHaveTextContent("PARTIAL_COMPLETION");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the loading state while submitting, disables the buttons, and ignores a second submit", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    let release!: (value: Awaited<ReturnType<typeof realSubmit>>) => void;
    submitSpy.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    renderRoute("/transactions/new");
    await fillReplay(user);

    await user.click(submitButton());
    expect(screen.getByRole("button", { name: "Routing…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Routing the transaction");

    fireEvent.submit(form().querySelector("form")!); // a second submit while the first is running
    expect(submitSpy).toHaveBeenCalledTimes(1);

    release(await realSubmit({ senderCountry: "GBR", receiverCountry: "PHL", amountUsd: 100000, state: { mode: "historicalReplay", date: "2024-06-14" }, policy: "waterfall" }, { delayMs: 0 }));
    expect(await screen.findByText("Routed and fully executed")).toBeInTheDocument();
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(submitButton()).toBeEnabled();
  });
});

describe("failures", () => {
  it("shows ?mock=validation as field and form-level errors, and says nothing was saved", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions/new?mock=validation");
    expect(screen.getByText("Preview failure mode: validation")).toBeInTheDocument();
    await fillReplay(user);
    await user.click(submitButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The request failed validation");
    expect(alert).toHaveTextContent("Preview validation message that belongs to no single field.");
    expect(alert).toHaveTextContent("VALIDATION_ERROR");
    expect(alert).toHaveTextContent(/Reference: preview-/);
    expect(screen.getByText("Preview validation message for the amount.")).toBeInTheDocument();
    expect(amountInput()).toHaveAttribute("aria-invalid", "true");
    expect(amountInput()).toHaveFocus();
    expect(screen.getByText("Not saved")).toBeInTheDocument();
    expect(screen.queryByText(/Transaction ID/)).not.toBeInTheDocument();
  });

  it.each([
    ["busy", "ENGINE_BUSY"],
    ["timeout", "ENGINE_TIMEOUT"],
    ["unavailable", "INFERENCE_UNAVAILABLE"],
    ["error", "INFERENCE_ERROR"],
  ])("shows ?mock=%s as a form-level error plus the persisted transaction ID as text", async (mock, code) => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute(`/transactions/new?mock=${mock}`);
    await fillReplay(user);
    await user.click(submitButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Routing failed");
    expect(alert).toHaveTextContent(code);
    expect(alert).toHaveTextContent(/Reference: preview-/);
    expect(screen.getByText("Routing failed — saved without a decision")).toBeInTheDocument();
    expect(screen.getByText(PREVIEW_RESULT)).toBeInTheDocument();
    const id = screen.getByText(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    expect(id.closest("a")).toBeNull();
    // The form is still filled in and usable, and nothing was retried.
    expect(amountInput()).toHaveValue("100000");
    expect(submitButton()).toBeEnabled();
    expect(submitSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));
  });

  it("shows ?mock=notready as the engine starting up, in the form and in the result", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions/new?mock=notready");
    expect(screen.getByText("Preview failure mode: notready")).toBeInTheDocument(); // the preview scenario is labelled
    await fillReplay(user);
    await user.click(submitButton());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The routing engine is starting up");
    expect(alert).toHaveTextContent("The inference service is unavailable."); // the backend's own message is kept
    expect(alert).toHaveTextContent("INFERENCE_UNAVAILABLE");
    expect(alert).toHaveTextContent(/Reference: preview-/);
    expect(alert).not.toHaveTextContent("Routing failed");

    expect(screen.getByText("Routing engine starting up — saved without a decision")).toBeInTheDocument();
    expect(screen.getByText(/hadn't finished starting up, so nothing was routed/)).toBeInTheDocument();
    expect(screen.getByText(PREVIEW_RESULT)).toBeInTheDocument();
    const id = screen.getByText(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    expect(id.closest("a")).toBeNull(); // the persisted transaction's ID, as text only
    expect(screen.queryByText("Routing failed — saved without a decision")).not.toBeInTheDocument();
    expect(screen.queryByText("Not saved")).not.toBeInTheDocument();
  });

  it("does not retry on its own after NOT_READY, and leaves the form filled in and usable", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions/new?mock=notready");
    await fillReplay(user);
    await user.click(submitButton());
    await screen.findByRole("alert");
    expect(amountInput()).toHaveValue("100000");
    expect(submitButton()).toBeEnabled();
    await waitFor(() => expect(submitSpy).toHaveBeenCalledTimes(1));
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it("shows no Retry-After countdown or retry control for NOT_READY either", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions/new?mock=notready");
    await fillReplay(user);
    await user.click(submitButton());
    await screen.findByRole("alert");
    expect(screen.queryByText(/retry-after|retrying|seconds/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("keeps an ordinary unavailable inference service worded as a routing failure, not a start-up", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions/new?mock=unavailable");
    await fillReplay(user);
    await user.click(submitButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Routing failed");
    expect(alert).not.toHaveTextContent(/starting up/i);
    expect(screen.getByText("Routing failed — saved without a decision")).toBeInTheDocument();
    expect(screen.queryByText(/starting up/i)).not.toBeInTheDocument();
  });

  it("does not use start-up wording for the other persisted failures", async () => {
    for (const mock of ["busy", "timeout", "error"]) {
      mockWidth(1280);
      const user = userEvent.setup();
      const { unmount } = renderRoute(`/transactions/new?mock=${mock}`);
      await fillReplay(user);
      await user.click(submitButton());
      await screen.findByRole("alert");
      expect(screen.queryByText(/starting up/i), mock).not.toBeInTheDocument();
      unmount();
    }
  });

  it("lets the next submission succeed once the preview scenario is left", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    const { router } = renderRoute("/transactions/new?mock=notready");
    await fillReplay(user);
    await user.click(submitButton());
    await screen.findByRole("alert");
    await router.navigate("/transactions/new"); // the scenario parameter is removed
    await user.click(submitButton());
    expect(await screen.findByText("Routed and fully executed")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/starting up/i)).not.toBeInTheDocument();
  });

  // What the screen does today, which is all this claims: it shows no countdown and no retry control, and
  // it does not retry by itself. Whether the backend forwards a Retry-After is unresolved, so nothing here
  // depends on it either way.
  it("shows no Retry-After countdown or retry control, and does not retry by itself", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions/new?mock=busy");
    await fillReplay(user);
    await user.click(submitButton());
    await screen.findByRole("alert");
    expect(screen.queryByText(/retry-after|retrying|seconds/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();

    // Left alone for a while, nothing is sent again and nothing appears.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/retry-after|retrying|seconds/i)).not.toBeInTheDocument();
    expect(submitButton()).toBeEnabled();
  });

  it("shows a 4xx engine error as a form-level message with the backend's message and request ID", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions/new");
    await fillReplay(user);
    fireEvent.change(dateInput(), { target: { value: "2000-01-01" } });
    await user.click(submitButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The request wasn't accepted");
    expect(alert).toHaveTextContent("The date 2000-01-01 is outside the available data.");
    expect(alert).toHaveTextContent("DATE_OUT_OF_RANGE");
    expect(screen.getByText("Not saved")).toBeInTheDocument();
  });

  it("ignores an unknown ?mock= value", () => {
    mockWidth(1280);
    renderRoute("/transactions/new?mock=whatever");
    expect(screen.queryByText(/Preview failure mode/)).not.toBeInTheDocument();
  });
});

describe("reset", () => {
  it("clears the values, the errors and the result", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions/new");
    await fillReplay(user);
    await user.click(submitButton());
    await screen.findByText("Routed and fully executed");

    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(amountInput()).toHaveValue("");
    expect(corridorSelect()).toHaveValue("");
    expect(dateInput()).toHaveValue("");
    expect(screen.getByText("No result yet")).toBeInTheDocument();
    expect(screen.queryByText("Routed and fully executed")).not.toBeInTheDocument();
  });

  it("clears errors and a form-level message", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions/new?mock=busy");
    await user.click(submitButton());
    expect(screen.getByText("Choose a corridor.")).toBeInTheDocument();
    await fillReplay(user);
    await user.click(submitButton());
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Choose a corridor.")).not.toBeInTheDocument();
    expect(screen.queryByText("Routing failed — saved without a decision")).not.toBeInTheDocument();
  });
});

describe("crossing the 1024px breakpoint", () => {
  /** A matchMedia whose width can change, notifying listeners as a browser does. */
  function controllableWidth(initial: number) {
    let width = initial;
    const listeners = new Set<() => void>();
    window.matchMedia = vi.fn((query: string) => ({
      get matches() {
        return query === "(min-width: 1024px)" ? width >= 1024 : false;
      },
      media: query,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    return (next: number) => {
      width = next;
      act(() => listeners.forEach((fn) => fn()));
    };
  }

  it("keeps what was typed and the last result when the window is narrowed and widened again", async () => {
    const resize = controllableWidth(1280);
    const user = userEvent.setup();
    renderRoute("/transactions/new");
    await fillReplay(user);
    await user.click(submitButton());
    await screen.findByText("Routed and fully executed");
    await user.type(screen.getByRole("textbox", { name: "Client reference" }), "PO-7");

    resize(800); // below 1024px: the existing placeholder, unchanged
    expect(screen.getByText("This screen isn't connected yet")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "New transaction form" })).not.toBeInTheDocument();

    resize(1280);
    expect(amountInput()).toHaveValue("100000");
    expect(corridorSelect()).toHaveValue("GBR->PHL");
    expect(screen.getByRole("textbox", { name: "Client reference" })).toHaveValue("PO-7");
    expect(screen.getByText("Routed and fully executed")).toBeInTheDocument();
  });
});

describe("NewTransactionPage below 1024px", () => {
  it.each([1023, 768, 375])("keeps the existing placeholder at %ipx", (width) => {
    mockWidth(width);
    renderRoute("/transactions/new");
    expect(screen.getByRole("heading", { level: 1, name: "New transaction" })).toBeInTheDocument();
    expect(screen.getByText("This screen isn't connected yet")).toBeInTheDocument();
    expect(screen.getByText(/Replay transactions don't consume liquidity/)).toBeInTheDocument();
    const endpoints = screen.getByRole("list", { name: "Endpoints" });
    expect(endpoints).toHaveTextContent("POST /api/v1/transactions");
    expect(endpoints).toHaveTextContent("GET /api/v1/replay/calendar");
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "New transaction form" })).not.toBeInTheDocument();
    expect(screen.queryByText("Preview data — illustrative, not from the API")).not.toBeInTheDocument();
    expect(submitSpy).not.toHaveBeenCalled();
  });
});
