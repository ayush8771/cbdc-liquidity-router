import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, createApiClient, INVALID_RESPONSE, type ApiClient } from "../api/client";
import { isMeResponse, type MeResponse } from "../api/types";
import { AuthContext, type AuthContextValue, type AuthStatus, type SessionNotice, type SignInResult } from "./AuthContext";
import { tokenStore, type TokenStore } from "./tokenStore";

type AuthProviderProps = {
  children: ReactNode;
  /** For tests. Defaults to the app's store (memory plus sessionStorage). */
  store?: TokenStore;
  /** For tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
};

/** Numbers the session changes, so an answer that arrives after a newer change can be ignored. */
class AttemptCounter {
  private latest = 0;
  /** Starts a new attempt and returns its number. */
  next(): number {
    this.latest += 1;
    return this.latest;
  }
  /** Makes every attempt so far stale (a sign-out or an expiry). */
  supersede(): void {
    this.latest += 1;
  }
  isLatest(attempt: number): boolean {
    return attempt === this.latest;
  }
}

type Session = { status: AuthStatus; user: MeResponse | null; notice: SessionNotice | null };

/** Asks the API who this token belongs to. Throws ApiError, or INVALID_RESPONSE for a body that isn't a session. */
async function fetchMe(client: ApiClient): Promise<MeResponse> {
  const me = await client.get<unknown>("/auth/me");
  if (!isMeResponse(me)) {
    throw new ApiError({ status: 200, code: INVALID_RESPONSE, message: "The server's response could not be read." });
  }
  return me;
}

/**
 * Holds the session (arch §8.3). The token is validated with GET /auth/me before
 * it is kept, held in memory and mirrored to sessionStorage, and cleared on
 * sign-out and on any 401 from the API client.
 */
export function AuthProvider({ children, store = tokenStore, fetchImpl }: AuthProviderProps) {
  const [session, setSession] = useState<Session>(() => ({
    status: store.get() ? "restoring" : "signedOut",
    user: null,
    notice: null,
  }));
  // A newer sign-in attempt, sign-out or expiry makes an older answer irrelevant.
  const [attempts] = useState(() => new AttemptCounter());

  const expire = useCallback(() => {
    attempts.supersede();
    store.clear();
    // Only a live (or being-restored) session can expire; a late 401 after sign-out changes nothing.
    setSession((current) => (current.status === "signedOut" ? current : { status: "signedOut", user: null, notice: "expired" }));
  }, [store, attempts]);

  const api = useMemo(
    () => createApiClient({ getToken: () => store.get(), onUnauthorized: expire, fetchImpl }),
    [store, expire, fetchImpl],
  );

  // A token saved by an earlier page load: check it once, then decide.
  useEffect(() => {
    if (session.status !== "restoring") return;
    const attempt = attempts.next();
    void fetchMe(api).then(
      (user) => {
        if (!attempts.isLatest(attempt)) return;
        setSession({ status: "signedIn", user, notice: null });
      },
      () => {
        // A 401 already ended the session through `expire`, which also superseded this attempt.
        if (!attempts.isLatest(attempt)) return;
        // The token couldn't be checked. Keep it for the next reload, but don't act signed in.
        setSession({ status: "signedOut", user: null, notice: "unavailable" });
      },
    );
    // Runs once, for the token found at start-up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signIn = useCallback(
    async (rawToken: string): Promise<SignInResult> => {
      const token = rawToken.trim();
      const attempt = attempts.next();
      // A separate client that tries this one token and ends no session on a 401.
      const probe = createApiClient({ getToken: () => token, fetchImpl });
      try {
        const user = await fetchMe(probe);
        if (!attempts.isLatest(attempt)) return { ok: false, reason: "unavailable" };
        store.set(token);
        setSession({ status: "signedIn", user, notice: null });
        return { ok: true, user };
      } catch (error) {
        return { ok: false, reason: error instanceof ApiError && error.status === 401 ? "invalid" : "unavailable" };
      }
    },
    [store, fetchImpl, attempts],
  );

  const signOut = useCallback(() => {
    attempts.supersede();
    store.clear();
    setSession({ status: "signedOut", user: null, notice: null });
  }, [store, attempts]);

  const value = useMemo<AuthContextValue>(
    () => ({ status: session.status, user: session.user, sessionNotice: session.notice, signIn, signOut, api }),
    [session, signIn, signOut, api],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
