import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { server } from "./msw/server";
import { renderRoute } from "./renderRoute";

const TOKEN = "a1b2c3d4".repeat(8); // 64 characters; a made-up value for tests, unknown to the mock API

// The page needs a real (signed-out) session, and /auth/me is answered by MSW. See auth.test.tsx for the
// sign-in flow itself; this file keeps the page's own behaviour and its visual previews covered.
const renderSignIn = (path: string) => renderRoute(path, { auth: "real" });

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  sessionStorage.clear();
});
afterAll(() => server.close());

describe("SignInPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows the dev-auth banner and a labelled token field", () => {
    renderSignIn("/sign-in");
    expect(screen.getByText("Development authentication — not secure")).toBeInTheDocument();
    const field = screen.getByLabelText(/Development token/);
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "off");
  });

  it("asks for a token when submitted empty", async () => {
    renderSignIn("/sign-in");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByText("Enter your development token.")).toBeInTheDocument();
    expect(screen.getByLabelText(/Development token/)).toHaveAttribute("aria-invalid", "true");
  });

  it("checks a token once with the API, and a rejected token is never stored", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderSignIn("/sign-in");

    await userEvent.type(screen.getByLabelText(/Development token/), "a".repeat(64));
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That token wasn't accepted");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toMatch(/\/api\/v1\/auth\/me$/);
    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).toBe("");
  });
});

describe("SignInPage preview-mode notice and Show/Hide (desktop additions)", () => {
  it("shows the preview-mode notice only while a visual preview is on screen", () => {
    renderSignIn("/sign-in");
    expect(screen.queryByText("Preview mode")).not.toBeInTheDocument();
  });

  it("says a preview is illustrative", () => {
    renderSignIn("/sign-in?state=invalid");
    expect(screen.getByText("Preview mode")).toBeInTheDocument();
    expect(screen.getByText(/The message below is illustrative, not a result\./)).toBeInTheDocument();
  });

  it("shows and hides the token, and hides it again after a submit", async () => {
    renderSignIn("/sign-in");
    const field = screen.getByLabelText(/Development token/);
    await userEvent.type(field, TOKEN);

    await userEvent.click(screen.getByRole("button", { name: "Show token" }));
    expect(field).toHaveAttribute("type", "text");
    expect(field).toHaveValue(TOKEN);

    await userEvent.click(screen.getByRole("button", { name: "Hide token" }));
    expect(field).toHaveAttribute("type", "password");

    await userEvent.click(screen.getByRole("button", { name: "Show token" }));
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(field).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Show token" })).toBeInTheDocument();
    await screen.findByRole("alert"); // the (rejected) check has finished
  });

  it("keeps empty-input validation", async () => {
    renderSignIn("/sign-in");
    await userEvent.type(screen.getByLabelText(/Development token/), "   ");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByText("Enter your development token.")).toBeInTheDocument();
  });

  it("marks every new element as desktop only (hidden below lg)", () => {
    renderSignIn("/sign-in?state=error");
    expect(screen.getByRole("button", { name: "Show token" }).className).toMatch(/\bhidden\b.*\blg:inline-flex\b/);
    for (const el of [screen.getByText("Preview mode"), screen.getByRole("alert")]) {
      const wrapper = el.closest(".hidden");
      expect(wrapper).not.toBeNull();
      expect(wrapper).toHaveClass("lg:block");
    }
  });
});

describe("SignInPage cannot expose the token", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the token out of the URL, the history and the form data, with Show on", async () => {
    const { router } = renderSignIn("/sign-in");
    const field = screen.getByLabelText(/Development token/) as HTMLInputElement;
    await userEvent.type(field, TOKEN);
    await userEvent.click(screen.getByRole("button", { name: "Show token" }));

    // A native submission would serialise named controls. There must be none.
    expect(field).not.toHaveAttribute("name");
    expect([...new FormData(field.form!).values()].join("")).not.toContain(TOKEN);

    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("alert"); // the (rejected) check has finished
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(router.state.location.search).toBe("");
    expect(router.state.location.hash).toBe("");
    expect(router.state.historyAction).toBe("POP"); // nothing was pushed or replaced
    expect(window.location.href).not.toContain(TOKEN);
  });

  it("ignores any other URL parameter and never renders it", () => {
    renderSignIn(`/sign-in?state=success&token=${TOKEN}`);
    expect(document.body).not.toHaveTextContent(TOKEN);
    expect(screen.getByLabelText(/Development token/)).toHaveValue("");
    // "success" is not a state: no preview message of any kind appears.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each(["checking", "invalid", "error"])("touches no network, storage or cookie in the %s preview", async (state) => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderSignIn(`/sign-in?state=${state}`);

    await userEvent.type(screen.getByLabelText(/Development token/), TOKEN);
    await userEvent.click(screen.getByRole("button", { name: "Show token" }));
    await userEvent.click(screen.getByRole("button", { name: "Hide token" }));
    await userEvent.click(screen.getByRole("button", { name: state === "error" ? "Try again" : "Exit preview" }));

    expect(setItem).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.cookie).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
  });
});

describe("SignInPage visual previews (?state=)", () => {
  it("shows the checking state: a status message and a disabled Checking… button", () => {
    renderSignIn("/sign-in?state=checking");
    expect(screen.getByRole("status")).toHaveTextContent("Checking your token…");
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    expect(screen.getByText("Preview of this state. Nothing was checked.")).toBeInTheDocument();
  });

  it("shows the invalid-token state", () => {
    renderSignIn("/sign-in?state=invalid");
    expect(screen.getByRole("alert")).toHaveTextContent("That token wasn't accepted");
    expect(screen.getByRole("alert")).toHaveTextContent("Check it and try again.");
  });

  it("shows the error state with Try again", () => {
    renderSignIn("/sign-in?state=error");
    expect(screen.getByRole("alert")).toHaveTextContent("We couldn't check your token");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it.each([
    ["error", "Try again"],
    ["invalid", "Exit preview"],
    ["checking", "Exit preview"],
  ])("%s: %s only clears the visual preview, replaces the history entry and keeps the typed token", async (state, action) => {
    const { router } = renderSignIn(`/sign-in?state=${state}`);
    const field = screen.getByLabelText(/Development token/);
    await userEvent.type(field, "typed-value");

    await userEvent.click(screen.getByRole("button", { name: action }));

    expect(router.state.location.search).toBe("");
    expect(router.state.historyAction).toBe("REPLACE");
    expect(field).toHaveValue("typed-value");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); // no outcome was simulated
  });

  it("leaves the preview on submit, then behaves as before", async () => {
    const { router } = renderSignIn("/sign-in?state=error");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(router.state.location.search).toBe("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Enter your development token.")).toBeInTheDocument();
  });
});
