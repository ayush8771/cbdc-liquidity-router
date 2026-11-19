import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { NAVIGATION } from "../src/app/navigation";
import { renderRoute } from "./renderRoute";

// jsdom applies no CSS, so both the desktop sidebar and the mobile menu are
// in the DOM; the desktop one is the first "Main" navigation.
const desktopNav = () => screen.getAllByRole("navigation", { name: "Main" })[0]!;

describe("AppShell", () => {
  it("shows the persistent dev-auth banner on app screens", () => {
    renderRoute("/");
    expect(screen.getByText("Development authentication — not secure")).toBeInTheDocument();
  });

  it("lists every screen in the navigation", () => {
    renderRoute("/");
    for (const item of NAVIGATION) {
      expect(within(desktopNav()).getByRole("link", { name: item.label })).toHaveAttribute("href", item.to);
    }
  });

  it("marks only the current screen as active", () => {
    renderRoute("/transactions/new");
    const nav = desktopNav();
    expect(within(nav).getByRole("link", { name: "New transaction" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "History" })).not.toHaveAttribute("aria-current");
  });

  it("renders one h1 per screen and shows no data before the API is connected", () => {
    renderRoute("/bridges");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Bridge monitor" })).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText("Simulated")).toBeInTheDocument();
  });

  it("states that replay transactions don't consume liquidity on the transaction form", () => {
    renderRoute("/transactions/new");
    expect(screen.getByText(/Replay transactions don't consume liquidity/)).toBeInTheDocument();
  });

  it("toggles the mobile menu with aria-expanded and closes it with Escape", async () => {
    renderRoute("/");
    const toggle = screen.getByRole("button", { name: "Open menu" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Close menu" })).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Open menu" })).toHaveAttribute("aria-expanded", "false");
  });

  it("shows a not-found page for unknown paths", () => {
    renderRoute("/no-such-page");
    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
  });
});
