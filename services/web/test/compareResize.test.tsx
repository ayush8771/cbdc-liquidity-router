/*
 * Regression test for the Compare screen losing its form state across the 1024px breakpoint.
 *
 * Both desktop screens swap to the placeholder below 1024px. The form's state must live above
 * that switch, so crossing the breakpoint changes only what is shown and never what the user
 * typed. ComparePage holds it in ComparePage (as NewTransactionPage holds it in
 * NewTransactionPage); when it was held inside the live branch instead, narrowing the window and
 * widening it again silently emptied every field and unticked every policy.
 *
 * The New transaction case is here too, as the reference behaviour the Compare case must match.
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { server } from "./msw/server";
import { renderRoute } from "./renderRoute";

const DESKTOP = "(min-width: 1024px)";
const original = window.matchMedia;

/**
 * A `matchMedia` whose width can change afterwards, notifying the listeners `useMediaQuery`
 * registers. The other tests only need a fixed width, so they mock a static one; this test has to
 * move the width while the page is mounted.
 */
function resizableMatchMedia(initial: number) {
  let width = initial;
  const listeners = new Set<() => void>();
  const impl = (query: string) =>
    ({
      // A getter, so every snapshot read sees the current width.
      get matches() {
        return query === DESKTOP ? width >= 1024 : false;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => void listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => void listeners.delete(listener),
      addListener: (listener: () => void) => void listeners.add(listener),
      removeListener: (listener: () => void) => void listeners.delete(listener),
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
  window.matchMedia = vi.fn(impl) as unknown as typeof window.matchMedia;

  return function setWidth(next: number) {
    width = next;
    act(() => {
      for (const listener of [...listeners]) listener();
    });
  };
}

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  sessionStorage.clear();
  window.matchMedia = original;
  vi.restoreAllMocks();
});
afterAll(() => server.close());

type User = ReturnType<typeof userEvent.setup>;

const corridorSelect = () => screen.getByRole("combobox", { name: "Corridor" });
const amountInput = () => screen.getByRole("textbox", { name: "Amount (USD)" });
const dateInput = () => screen.getByLabelText(/^Date/);
const clientReferenceInput = () => screen.getByRole("textbox", { name: "Client reference" });

/** Fills the four fields both forms share. */
async function fillShared(user: User, reference: string) {
  await user.selectOptions(corridorSelect(), "GBR->PHL");
  await user.type(amountInput(), "300000");
  fireEvent.change(dateInput(), { target: { value: "2024-06-14" } });
  await user.type(clientReferenceInput(), reference);
}

function expectSharedFields(reference: string) {
  expect(corridorSelect()).toHaveValue("GBR->PHL");
  expect(amountInput()).toHaveValue("300000");
  expect(dateInput()).toHaveValue("2024-06-14");
  expect(clientReferenceInput()).toHaveValue(reference);
}

describe("the Comparison form across the 1024px breakpoint", () => {
  it("keeps the typed values and the chosen policies when the window crosses it and comes back", async () => {
    const setWidth = resizableMatchMedia(1280);
    const user = userEvent.setup();
    renderRoute("/compare", { data: "live" });

    await screen.findByRole("region", { name: "Comparison form" });
    await fillShared(user, "resize-compare");
    await user.click(screen.getByRole("checkbox", { name: "Waterfall" }));
    await user.click(screen.getByRole("checkbox", { name: "Cheapest feasible" }));
    // The form echoes the chosen order, so this confirms the selection registered before resizing.
    expect(screen.getByText("Results are shown in this order: Waterfall, Cheapest feasible.")).toBeInTheDocument();

    // Below the breakpoint the placeholder takes over, as it did before.
    setWidth(1000);
    expect(screen.queryByRole("region", { name: "Comparison form" })).not.toBeInTheDocument();

    // Back above it, everything the user had entered must still be there.
    setWidth(1280);
    await screen.findByRole("region", { name: "Comparison form" });
    expectSharedFields("resize-compare");
    expect(screen.getByRole("checkbox", { name: "Waterfall" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Cheapest feasible" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "PPO (projected)" })).not.toBeChecked();
    // The chosen order is part of the state too, not just the ticks.
    expect(screen.getByText("Results are shown in this order: Waterfall, Cheapest feasible.")).toBeInTheDocument();
  });

  it("keeps a comparison result that was already produced", async () => {
    const setWidth = resizableMatchMedia(1280);
    const user = userEvent.setup();
    renderRoute("/compare", { data: "live" });

    await screen.findByRole("region", { name: "Comparison form" });
    await fillShared(user, "resize-compare-result");
    await user.click(screen.getByRole("checkbox", { name: "Waterfall" }));
    await user.click(screen.getByRole("checkbox", { name: "Cheapest feasible" }));
    await user.click(screen.getByRole("button", { name: "Compare policies" }));

    const results = await screen.findByRole("region", { name: "Policy results" });
    const before = within(results)
      .getAllByRole("region")
      .map((column) => column.getAttribute("aria-label"));
    expect(before.length).toBeGreaterThan(0);

    setWidth(1000);
    expect(screen.queryByRole("region", { name: "Policy results" })).not.toBeInTheDocument();

    setWidth(1280);
    const after = await screen.findByRole("region", { name: "Policy results" });
    expect(
      within(after)
        .getAllByRole("region")
        .map((column) => column.getAttribute("aria-label")),
    ).toEqual(before);
  });
});

describe("the New transaction form across the 1024px breakpoint", () => {
  it("keeps the typed values, as it already did (the pattern the Compare screen follows)", async () => {
    const setWidth = resizableMatchMedia(1280);
    const user = userEvent.setup();
    renderRoute("/transactions/new", { data: "live" });

    await screen.findByRole("region", { name: "New transaction form" });
    await fillShared(user, "resize-new-transaction");

    setWidth(1000);
    expect(screen.queryByRole("region", { name: "New transaction form" })).not.toBeInTheDocument();

    setWidth(1280);
    await screen.findByRole("region", { name: "New transaction form" });
    expectSharedFields("resize-new-transaction");
  });
});
