import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../src/auth/AuthProvider";
import { useAuth, type AuthContextValue } from "../../src/auth/AuthContext";
import { createTokenStore } from "../../src/auth/tokenStore";
import { TEST_USER } from "../renderRoute";

const STREAM = "/api/rt/v1/observations/stream";

type Pending = { url: string; init: RequestInit; respond: (r: Response) => void };

/** A fetch that answers /auth/me at once and holds every stream request until the test answers it. */
function harness(token: string | null = "tok-1") {
  const pending: Pending[] = [];
  const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v1/auth/me")) return Promise.resolve(new Response(JSON.stringify(TEST_USER), { status: 200 }));
    return new Promise<Response>((resolve) => pending.push({ url, init: init ?? {}, respond: resolve }));
  }) as unknown as typeof fetch;

  const store = createTokenStore(() => null);
  if (token) store.set(token);
  let ctx!: AuthContextValue;
  const Probe = () => {
    ctx = useAuth();
    return <p>{ctx.status}:{ctx.sessionNotice ?? "none"}</p>;
  };
  const view = render(
    <AuthProvider store={store} fetchImpl={fetchImpl}>
      <Probe />
    </AuthProvider>,
  );
  return { pending, fetchImpl, store, view, ctx: () => ctx };
}

const signedIn = async (h: ReturnType<typeof harness>) => waitFor(() => expect(h.ctx().status).toBe("signedIn"));

describe("AuthContext.openObservationStream (AD-1 §3.3.4)", () => {
  it("sends a same-origin GET with the bearer token in a header only, and no replay header", async () => {
    const h = harness();
    await signedIn(h);
    const signal = new AbortController().signal;
    void h.ctx().openObservationStream(signal);
    await waitFor(() => expect(h.pending).toHaveLength(1));
    const { url, init } = h.pending[0] as Pending;
    expect(new URL(url).pathname).toBe(STREAM);
    expect(new URL(url).origin).toBe(window.location.origin);
    expect(url).not.toContain("tok-1");
    expect(new URL(url).search).toBe("");
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual({ Accept: "text/event-stream", Authorization: "Bearer tok-1" });
    expect(init).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store" });
    expect(Object.keys(init.headers as object).map((k) => k.toLowerCase())).not.toContain("last-event-id");
  });

  it("ends the session on a 401, like any other request", async () => {
    const h = harness();
    await signedIn(h);
    const result = h.ctx().openObservationStream(new AbortController().signal);
    await waitFor(() => expect(h.pending).toHaveLength(1));
    await act(async () => {
      h.pending[0]?.respond(new Response("", { status: 401 }));
      await result;
    });
    await waitFor(() => expect(h.view.container.textContent).toBe("signedOut:expired"));
    expect(h.store.get()).toBeNull();
  });

  it("returns a non-401 error response to the caller without ending the session", async () => {
    const h = harness();
    await signedIn(h);
    const result = h.ctx().openObservationStream(new AbortController().signal);
    await waitFor(() => expect(h.pending).toHaveLength(1));
    h.pending[0]?.respond(new Response("", { status: 429 }));
    expect((await result).status).toBe(429);
    expect(h.ctx().status).toBe("signedIn");
  });

  it("aborts an in-flight attempt on sign-out, and drops a late 401 without a session notice", async () => {
    const h = harness();
    await signedIn(h);
    const controller = new AbortController();
    const result = h.ctx().openObservationStream(controller.signal);
    const settled = result.then(() => "resolved", (e: unknown) => (e as Error).name);
    await waitFor(() => expect(h.pending).toHaveLength(1));
    const attemptSignal = (h.pending[0]?.init.signal ?? null) as AbortSignal;

    act(() => h.ctx().signOut());
    expect(attemptSignal.aborted).toBe(true);

    h.pending[0]?.respond(new Response("", { status: 401 })); // a fetch that ignored the abort
    expect(await settled).toBe("AbortError");
    await waitFor(() => expect(h.view.container.textContent).toBe("signedOut:none"));
  });

  it("does not let a late 401 from an earlier session sign out its replacement", async () => {
    const h = harness();
    await signedIn(h);
    const first = h.ctx().openObservationStream(new AbortController().signal);
    const settled = first.then(() => "resolved", (e: unknown) => (e as Error).name);
    await waitFor(() => expect(h.pending).toHaveLength(1));

    act(() => h.ctx().signOut());
    let signIn!: Promise<unknown>;
    await act(async () => {
      signIn = h.ctx().signIn("tok-2");
      await signIn;
    });
    expect(h.ctx().status).toBe("signedIn");

    h.pending[0]?.respond(new Response("", { status: 401 }));
    expect(await settled).toBe("AbortError");
    expect(h.ctx().status).toBe("signedIn");
    expect(h.store.get()).toBe("tok-2");
  });

  it("forwards the caller's abort to the request", async () => {
    const h = harness();
    await signedIn(h);
    const controller = new AbortController();
    void h.ctx().openObservationStream(controller.signal).catch(() => {});
    await waitFor(() => expect(h.pending).toHaveLength(1));
    const attemptSignal = h.pending[0]?.init.signal as AbortSignal;
    expect(attemptSignal.aborted).toBe(false);
    controller.abort();
    expect(attemptSignal.aborted).toBe(true);
  });

  it("does not touch the API client: its calls still go to /api/v1 only", async () => {
    const h = harness();
    await signedIn(h);
    const calls = (h.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => new URL(String(c[0])).pathname);
    expect(calls).toEqual(["/api/v1/auth/me"]);
  });
});
