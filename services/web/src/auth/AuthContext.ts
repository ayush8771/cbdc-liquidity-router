import { createContext, useContext } from "react";
import type { ApiClient } from "../api/client";
import type { MeResponse } from "../api/types";

/**
 * - `restoring`: a token was found in sessionStorage and is being checked.
 * - `signedOut`: no valid session.
 * - `signedIn`: `GET /auth/me` accepted the token; `user` is set.
 */
export type AuthStatus = "restoring" | "signedOut" | "signedIn";

/**
 * Why a signed-out visitor is told something on the sign-in page:
 * - `expired`: a token that was accepted (or saved) is no longer accepted (401);
 * - `unavailable`: a saved session couldn't be checked (the API didn't answer properly).
 */
export type SessionNotice = "expired" | "unavailable";

export type SignInResult =
  | { ok: true; user: MeResponse }
  /** `invalid`: the API answered 401. `unavailable`: any other failure, so nothing is known about the token. */
  | { ok: false; reason: "invalid" | "unavailable" };

export type AuthContextValue = {
  status: AuthStatus;
  user: MeResponse | null;
  sessionNotice: SessionNotice | null;
  /** Validates the token with GET /auth/me. The token is kept only if it is accepted. */
  signIn(token: string): Promise<SignInResult>;
  /** Clears the token. There is no server-side sign-out (contract §3.0). */
  signOut(): void;
  /** The API client every screen uses: it adds this session's token, and ends the session on a 401. */
  api: ApiClient;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside an AuthProvider.");
  return value;
}
