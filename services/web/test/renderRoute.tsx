import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { createApiClient } from "../src/api/client";
import { DataModeContext, type DataMode } from "../src/api/dataMode";
import type { MeResponse } from "../src/api/types";
import { routes } from "../src/app/routes";
import { AuthContext, type AuthContextValue } from "../src/auth/AuthContext";
import { AuthProvider } from "../src/auth/AuthProvider";
import { createTokenStore } from "../src/auth/tokenStore";

export const TEST_USER: MeResponse = {
  userId: "u-analyst-1",
  email: "analyst@example.test",
  role: "analyst",
  authMode: "dev",
  permissions: { experimentalPolicies: true },
};

/**
 * How the session is provided:
 * - "signedIn" (default): a fixed signed-in user, so tests of the screens behind the guard see them.
 * - "signedOut": a fixed signed-out visitor, with no API behind it.
 * - "real": the real AuthProvider with its own empty token store, talking to whatever
 *   fetch is mocked (MSW in the auth tests).
 */
export type RenderAuth = "signedIn" | "signedOut" | "real";

/** The tokens the fixed sessions' API client sends. MSW accepts them (test/msw/server.ts); a real backend would not. */
const MOCK_TOKENS = { analyst: "mock-analyst", viewer: "mock-viewer" } as const;

export type RenderOptions = {
  auth?: RenderAuth;
  data?: DataMode;
  /** The role of the fixed signed-in user (default analyst). It also picks the token the client sends. */
  role?: "analyst" | "viewer";
  /** The `fetch` the fixed session's API client uses (default: the global one). */
  fetchImpl?: typeof fetch;
};

function fixedSession(
  status: "signedIn" | "signedOut",
  role: "analyst" | "viewer",
  fetchImpl: typeof fetch | undefined,
): AuthContextValue {
  const user: MeResponse =
    role === "analyst"
      ? TEST_USER
      : { userId: "u-viewer-1", email: "viewer@example.test", role: "viewer", authMode: "dev", permissions: { experimentalPolicies: false } };
  return {
    status,
    user: status === "signedIn" ? user : null,
    sessionNotice: null,
    signIn: async () => ({ ok: false, reason: "unavailable" }),
    signOut: () => {},
    api: createApiClient({ getToken: () => (status === "signedIn" ? MOCK_TOKENS[role] : null), fetchImpl }),
  };
}

/**
 * Renders the real route table at a given path.
 *
 * `data` is where connected screens get their data: "preview" (the default, so
 * the preview-data tests are unchanged and never touch the network) or "live"
 * (the screen calls the API, which the test must answer, normally with MSW).
 */
export function renderRoute(path: string, options: RenderOptions = {}) {
  const auth = options.auth ?? "signedIn";
  const data = options.data ?? "preview";
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const tree = <RouterProvider router={router} />;
  const wrapped =
    auth === "real" ? (
      <AuthProvider store={createTokenStore()}>{tree}</AuthProvider>
    ) : (
      <AuthContext.Provider value={fixedSession(auth, options.role ?? "analyst", options.fetchImpl)}>{tree}</AuthContext.Provider>
    );
  return { router, ...render(<DataModeContext.Provider value={data}>{wrapped}</DataModeContext.Provider>) };
}
