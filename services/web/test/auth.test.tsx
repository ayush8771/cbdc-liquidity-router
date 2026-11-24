import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, delay } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider";
import { useAuth } from "../src/auth/AuthContext";
import { createTokenStore, SESSION_TOKEN_KEY } from "../src/auth/tokenStore";
import { MOCK_ANALYST_TOKEN, MOCK_VIEWER_TOKEN, server } from "./msw/server";
import { renderRoute } from "./renderRoute";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  sessionStorage.clear();
  localStorage.clear();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

async function signInWith(token: string) {
  await userEvent.type(screen.getByLabelText(/Development token/), token);
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("token store", () => {
  it("keeps the token in memory and sessionStorage, and never in localStorage or cookies", () => {
    const store = createTokenStore();
    store.set("abc");

    expect(store.get()).toBe("abc");
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBe("abc");
    expect(localStorage.length).toBe(0);
    expect(document.cookie).toBe("");
  });

  it("is read back by a new store (a reload), and cleared everywhere by clear()", () => {
    createTokenStore().set("abc");
    const reloaded = createTokenStore();
    expect(reloaded.get()).toBe("abc");

    reloaded.clear();
    expect(reloaded.get()).toBeNull();
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
  });

  it("falls back to memory when sessionStorage throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    const store = createTokenStore(() => broken);

    store.set("abc");
    expect(store.get()).toBe("abc");
    store.clear();
    expect(store.get()).toBeNull();
  });

  it("works with no storage at all", () => {
    const store = createTokenStore(() => null);
    store.set("abc");
    expect(store.get()).toBe("abc");
  });
});

describe("the route guard", () => {
  it("sends a signed-out visitor to /sign-in, without a request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { router } = renderRoute("/transactions", { auth: "real" });

    expect(router.state.location.pathname).toBe("/sign-in");
    expect(router.state.location.search).toBe("");
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows the screens to a signed-in visitor, with their email and role", () => {
    renderRoute("/network");
    expect(screen.getByRole("heading", { level: 1, name: "Network" })).toBeInTheDocument();
    expect(screen.getAllByText("analyst@example.test").length).toBeGreaterThan(0);
    expect(screen.getAllByText("analyst").length).toBeGreaterThan(0);
  });

  it("sends a signed-in visitor away from /sign-in", () => {
    const { router } = renderRoute("/sign-in");
    expect(router.state.location.pathname).toBe("/");
  });
});

describe("signing in with GET /api/v1/auth/me", () => {
  it("accepts a valid token, keeps it for the session, and returns to the page the guard turned away", async () => {
    const { router } = renderRoute("/network", { auth: "real" });
    expect(router.state.location.pathname).toBe("/sign-in");

    await signInWith(MOCK_ANALYST_TOKEN);

    // The page itself, not only the router's location: the sign-in page renders nothing while it redirects.
    expect(await screen.findByRole("heading", { level: 1, name: "Network" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/network");
    expect(screen.getAllByText("analyst@example.test").length).toBeGreaterThan(0);
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBe(MOCK_ANALYST_TOKEN);
    expect(localStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    expect(window.location.href).not.toContain(MOCK_ANALYST_TOKEN);
  });

  it("shows a viewer's email and role", async () => {
    renderRoute("/", { auth: "real" });
    await signInWith(MOCK_VIEWER_TOKEN);

    expect((await screen.findAllByText("viewer@example.test")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("viewer").length).toBeGreaterThan(0);
  });

  it("sends the token only as a bearer header, to the same-origin /api/v1/auth/me", async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    server.use(
      http.get("*/api/v1/auth/me", ({ request }) => {
        seen.push({ url: request.url, authorization: request.headers.get("Authorization") });
        return HttpResponse.json({
          userId: "u1",
          email: "a@example.test",
          role: "analyst",
          authMode: "dev",
          permissions: { experimentalPolicies: true },
        });
      }),
    );
    renderRoute("/sign-in", { auth: "real" });
    await signInWith(`  ${MOCK_ANALYST_TOKEN}  `);

    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({ url: `${window.location.origin}/api/v1/auth/me`, authorization: `Bearer ${MOCK_ANALYST_TOKEN}` });
  });

  it("rejects an unknown token with a message, stores nothing, and keeps the text for editing", async () => {
    const { router } = renderRoute("/sign-in", { auth: "real" });
    await signInWith("not-a-token");

    expect(await screen.findByRole("alert")).toHaveTextContent("That token wasn't accepted");
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
    expect(screen.getByLabelText(/Development token/)).toHaveValue("not-a-token");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it.each([
    ["a server error", () => HttpResponse.json({ error: { code: "INTERNAL_ERROR", message: "x" } }, { status: 500 })],
    ["an unreachable server", () => HttpResponse.error()],
    ["a body that isn't an identity", () => HttpResponse.json({ hello: "world" })],
  ])("says it couldn't check the token after %s, and does not call the token invalid", async (_name, respond) => {
    server.use(http.get("*/api/v1/auth/me", respond));
    renderRoute("/sign-in", { auth: "real" });
    await signInWith(MOCK_ANALYST_TOKEN);

    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't check your token");
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
  });

  it("shows Checking… while the request runs, and sends only one", async () => {
    let calls = 0;
    server.use(
      http.get("*/api/v1/auth/me", async () => {
        calls += 1;
        await delay(50);
        return HttpResponse.json({ error: { code: "UNAUTHENTICATED", message: "Missing or invalid token." } }, { status: 401 });
      }),
    );
    renderRoute("/sign-in", { auth: "real" });
    await userEvent.type(screen.getByLabelText(/Development token/), "x");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Checking your token…");

    await screen.findByRole("alert");
    expect(calls).toBe(1);
  });

  it("still asks for a token when the field is empty, and makes no request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderRoute("/sign-in", { auth: "real" });
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(screen.getByText("Enter your development token.")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("a saved session", () => {
  it("is checked on load, then used", async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, MOCK_ANALYST_TOKEN);
    const { router } = renderRoute("/network", { auth: "real" });

    expect(screen.getByRole("status")).toHaveTextContent("Checking your session");
    expect((await screen.findAllByText("analyst@example.test")).length).toBeGreaterThan(0);
    expect(router.state.location.pathname).toBe("/network");
  });

  it("that the API no longer accepts ends with a message and no token", async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, "stale-token");
    const { router } = renderRoute("/network", { auth: "real" });

    expect(await screen.findByText("Your session has ended")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
  });

  it("that can't be checked is kept for the next load, but is not treated as signed in", async () => {
    server.use(http.get("*/api/v1/auth/me", () => HttpResponse.error()));
    sessionStorage.setItem(SESSION_TOKEN_KEY, MOCK_ANALYST_TOKEN);
    const { router } = renderRoute("/network", { auth: "real" });

    expect(await screen.findByText("We couldn't check your saved session")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBe(MOCK_ANALYST_TOKEN);
  });
});

describe("signing out", () => {
  it("clears the token and returns to sign-in, and the guard then keeps the screens closed", async () => {
    sessionStorage.setItem(SESSION_TOKEN_KEY, MOCK_ANALYST_TOKEN);
    const { router } = renderRoute("/", { auth: "real" });
    await screen.findAllByText("analyst@example.test");

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"));
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
    expect(screen.queryByText("Your session has ended")).not.toBeInTheDocument();

    await router.navigate("/transactions");
    await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"));
  });
});

describe("an expired session", () => {
  function Probe() {
    const { status, sessionNotice, signIn, api } = useAuth();
    return (
      <div>
        <p data-testid="status">{`${status}/${sessionNotice ?? "none"}`}</p>
        <button onClick={() => void signIn(MOCK_ANALYST_TOKEN)}>sign in</button>
        <button onClick={() => void api.get("/meta").catch(() => undefined)}>call</button>
      </div>
    );
  }

  it("ends on a 401 from any API call: the token is cleared and the status says expired", async () => {
    server.use(http.get("*/api/v1/meta", () => HttpResponse.json({ error: { code: "UNAUTHENTICATED", message: "x" } }, { status: 401 })));
    const store = createTokenStore();
    render(
      <AuthProvider store={store}>
        <Probe />
      </AuthProvider>,
    );
    await userEvent.click(screen.getByText("sign in"));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signedIn/none"));
    expect(store.get()).toBe(MOCK_ANALYST_TOKEN);

    await userEvent.click(screen.getByText("call"));

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signedOut/expired"));
    expect(store.get()).toBeNull();
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
  });

  it("is not triggered by a 403, which keeps the session", async () => {
    server.use(http.get("*/api/v1/meta", () => HttpResponse.json({ error: { code: "FORBIDDEN_POLICY", message: "x" } }, { status: 403 })));
    render(
      <AuthProvider store={createTokenStore()}>
        <Probe />
      </AuthProvider>,
    );
    await userEvent.click(screen.getByText("sign in"));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("signedIn/none"));

    await userEvent.click(screen.getByText("call"));
    await delay(30);

    expect(screen.getByTestId("status")).toHaveTextContent("signedIn/none");
  });

  it("makes useAuth fail loudly outside a provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow("useAuth must be used inside an AuthProvider.");
    spy.mockRestore();
  });
});
