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

/**
 * The observation stream requests in flight (Phase 3 D-24). The epoch changes only when a session ends or a
 * new one begins (expiry, sign-out, successful sign-in), not on every sign-in attempt, so a late answer for an
 * earlier session can be told apart and dropped. Ending a session aborts every request still in flight.
 */
class ObservationAttempts {
  private epoch = 0;
  private live = new Set<AbortController>();
  current(): number {
    return this.epoch;
  }
  begin(): AbortController {
    const attempt = new AbortController();
    this.live.add(attempt);
    attempt.signal.addEventListener("abort", () => this.live.delete(attempt), { once: true });
    return attempt;
  }
  endSession(): void {
    this.epoch += 1;
    for (const attempt of [...this.live]) attempt.abort();
  }
}

/** The observation stream's path: the only place it appears (AD-1 v0.5 §3.3.4). */
const OBSERVATION_STREAM_PATH = "/api/rt/v1/observations/stream";

function observationStreamUrl(): string {
  // As in the API client: resolve against the page's own origin where `fetch` can't take a relative URL.
  return typeof globalThis.location !== "undefined" && globalThis.location.origin !== "null"
    ? new URL(OBSERVATION_STREAM_PATH, globalThis.location.origin).href
    : OBSERVATION_STREAM_PATH;
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

  const [streams] = useState(() => new ObservationAttempts());
  const endSessionEpoch = useCallback(() => streams.endSession(), [streams]);

  const expire = useCallback(() => {
    endSessionEpoch();
    attempts.supersede();
    store.clear();
    // Only a live (or being-restored) session can expire; a late 401 after sign-out changes nothing.
    setSession((current) => (current.status === "signedOut" ? current : { status: "signedOut", user: null, notice: "expired" }));
  }, [store, attempts, endSessionEpoch]);

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
        endSessionEpoch();
        store.set(token);
        setSession({ status: "signedIn", user, notice: null });
        return { ok: true, user };
      } catch (error) {
        return { ok: false, reason: error instanceof ApiError && error.status === 401 ? "invalid" : "unavailable" };
      }
    },
    [store, fetchImpl, attempts, endSessionEpoch],
  );

  const signOut = useCallback(() => {
    endSessionEpoch();
    attempts.supersede();
    store.clear();
    setSession({ status: "signedOut", user: null, notice: null });
  }, [store, attempts, endSessionEpoch]);

  const openObservationStream = useCallback(
    async (signal: AbortSignal): Promise<Response> => {
      const epoch = streams.current();
      const token = store.get();
      const attempt = streams.begin();
      const forward = () => attempt.abort();
      if (signal.aborted) attempt.abort();
      else signal.addEventListener("abort", forward, { once: true });
      attempt.signal.addEventListener("abort", () => signal.removeEventListener("abort", forward), { once: true });

      const headers: Record<string, string> = { Accept: "text/event-stream" };
      if (token) headers.Authorization = `Bearer ${token}`;
      // No cookies, no redirects (the token must not follow one), no cache, and never a Last-Event-ID: no replay.
      const response = await (fetchImpl ?? ((input, init) => globalThis.fetch(input, init)))(observationStreamUrl(), {
        method: "GET",
        headers,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: attempt.signal,
      });
      if (epoch !== streams.current()) {
        // The session this attempt was issued for has ended: drop the answer unread, 401 included.
        void response.body?.cancel().catch(() => {});
        throw new DOMException("The session ended.", "AbortError");
      }
      if (response.status === 401 && token) expire();
      return response;
    },
    [store, fetchImpl, expire, streams],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ status: session.status, user: session.user, sessionNotice: session.notice, signIn, signOut, api, openObservationStream }),
    [session, signIn, signOut, api, openObservationStream],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
