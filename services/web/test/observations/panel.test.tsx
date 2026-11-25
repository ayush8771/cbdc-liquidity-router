import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode, useRef, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataModeContext, type DataMode } from "../../src/api/dataMode";
import { createApiClient } from "../../src/api/client";
import { AuthContext, useAuth, type AuthContextValue } from "../../src/auth/AuthContext";
import { ObservationPanel, ObservationsSection } from "../../src/features/observations/ObservationPanel";
import { ObservationsFlagContext } from "../../src/features/observations/flags";
import { TEST_USER } from "../renderRoute";
import { freshValues, heartbeat, makeValue, snapshot, sse, streamResponse, update } from "./fixtures";

type Call = { signal: AbortSignal; respond: (r: Response) => void; reject: (e: unknown) => void };
let calls: Call[] = [];
let visibility: "visible" | "hidden" = "visible";

function session(status: "signedIn" | "signedOut" = "signedIn"): AuthContextValue {
  return {
    status,
    user: status === "signedIn" ? TEST_USER : null,
    sessionNotice: null,
    signIn: async () => ({ ok: false, reason: "unavailable" }),
    signOut: () => {},
    api: createApiClient({ getToken: () => null, fetchImpl: () => Promise.reject(new Error("the API client must not be used")) }),
    openObservationStream: (signal) => new Promise<Response>((resolve, reject) => calls.push({ signal, respond: resolve, reject })),
  };
}

function wrap(children: ReactNode, opts: { data?: DataMode; flag?: boolean; auth?: AuthContextValue } = {}) {
  return (
    <DataModeContext.Provider value={opts.data ?? "live"}>
      <ObservationsFlagContext.Provider value={opts.flag ?? true}>
        <AuthContext.Provider value={opts.auth ?? session()}>{children}</AuthContext.Provider>
      </ObservationsFlagContext.Provider>
    </DataModeContext.Provider>
  );
}

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

async function open(values = freshValues()) {
  const s = streamResponse();
  calls[0]?.respond(s.response);
  s.push(sse(snapshot(1, values)));
  await flush();
  return s;
}
const rowOf = (pair: string) => screen.getByRole("row", { name: new RegExp(pair) });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  calls = [];
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("gating (AD-1 §3.3.4)", () => {
  it.each([
    ["preview mode, even with the flag on", { data: "preview" as const, flag: true }],
    ["the flag off", { flag: false }],
    ["a signed-out session", { auth: session("signedOut") }],
  ])("renders nothing, requests nothing and adds no listener with %s", (_n, opts) => {
    const doc = vi.spyOn(document, "addEventListener");
    const win = vi.spyOn(window, "addEventListener");
    const { container } = render(wrap(<ObservationsSection />, opts));
    expect(container).toBeEmptyDOMElement();
    expect(calls).toHaveLength(0);
    expect(doc).not.toHaveBeenCalledWith("visibilitychange", expect.anything());
    expect(win.mock.calls.map((c) => c[0])).not.toContain("pagehide");
  });

  it("defaults to off with no provider at all", () => {
    const { container } = render(
      <DataModeContext.Provider value="live">
        <AuthContext.Provider value={session()}>
          <ObservationsSection />
        </AuthContext.Provider>
      </DataModeContext.Provider>,
    );
    expect(container).toBeEmptyDOMElement();
    expect(calls).toHaveLength(0);
  });

  it("mounts, and opens one stream, with live mode, the flag and a signed-in session", () => {
    render(wrap(<ObservationsSection />));
    expect(screen.getByTestId("observation-panel")).toBeInTheDocument();
    expect(calls).toHaveLength(1);
  });
});

describe("the panel", () => {
  it("labels every shown value SIMULATED, with age, source and transport, and says it doesn't affect routing", async () => {
    render(wrap(<ObservationPanel />));
    await open();
    const panel = screen.getByTestId("observation-panel");
    for (const pair of ["AED/MXN", "EUR/USD", "GBP/PHP", "USD/INR"]) {
      const row = within(rowOf(pair));
      expect(row.getByText("SIMULATED")).toBeInTheDocument();
      expect(row.getByText("1 s")).toBeInTheDocument();
      expect(row.getByText("synthetic.fx")).toBeInTheDocument();
      expect(row.getByText("synthetic")).toBeInTheDocument();
    }
    expect(within(rowOf("USD/INR")).getByText("4.2345")).toBeInTheDocument();
    expect(screen.getByText("Observations are shown for context. They do not affect routing.")).toBeInTheDocument();
    expect(screen.getByText("Receiving")).toBeInTheDocument();
    expect(panel.textContent).not.toMatch(/\b(live|real[- ]time|market)\b/i);
  });

  it("applies an update to one pair and reports a source outage apart from the connection", async () => {
    render(wrap(<ObservationPanel />));
    const s = await open();
    s.push(sse(update(2, makeValue("USD", "INR", 0, "fresh", "9.9"))));
    s.push(sse(heartbeat(3, "outage")));
    await flush();
    expect(within(rowOf("USD/INR")).getByText("9.9")).toBeInTheDocument();
    expect(within(rowOf("EUR/USD")).getByText("2.2345")).toBeInTheDocument();
    expect(screen.getByText("Receiving")).toBeInTheDocument();
    expect(screen.getByText("Source synthetic.fx: outage")).toBeInTheDocument();
    expect(screen.getByText("The simulated source reports an outage")).toBeInTheDocument();
  });

  it("moves a value from fresh to stale to unavailable at the thresholds, withdrawing the number", async () => {
    render(wrap(<ObservationPanel />));
    await open(freshValues(0));
    const label = () => within(rowOf("USD/INR")).getByText(/SIMULATED|Unavailable/);
    await advance(6000);
    expect(label()).toHaveTextContent(/^SIMULATED$/); // exactly 6.000 s is still fresh
    await advance(2);
    expect(label()).toHaveTextContent("SIMULATED · stale");
    await advance(23998); // 30.000 s
    expect(label()).toHaveTextContent("SIMULATED · stale");
    expect(within(rowOf("USD/INR")).getByText("4.2345")).toBeInTheDocument();
    await advance(2);
    const row = within(rowOf("USD/INR"));
    expect(row.getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(row.queryByText("4.2345")).toBeNull();
    expect(row.queryByText("synthetic.fx")).toBeNull();
  });

  it("shows a withheld (non-synthetic) value as Unavailable with no number", async () => {
    const values = freshValues();
    values[1] = makeValue("EUR", "USD", 1000, "fresh", "7.7", { provenance_class: "real" });
    render(wrap(<ObservationPanel />));
    await open(values);
    expect(within(rowOf("EUR/USD")).queryByText("7.7")).toBeNull();
    expect(within(rowOf("EUR/USD")).getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(within(rowOf("AED/MXN")).getByText("SIMULATED")).toBeInTheDocument();
  });

  it("keeps values, ageing, while disconnected and says so", async () => {
    render(wrap(<ObservationPanel />));
    const s = await open();
    s.end();
    await flush();
    expect(screen.getByText("Disconnected, reconnecting")).toBeInTheDocument();
    expect(within(rowOf("USD/INR")).getByText("SIMULATED")).toBeInTheDocument();
  });

  it("explains a stop, offers Retry now, and Retry now connects once", async () => {
    render(wrap(<ObservationPanel />));
    calls[0]?.respond(new Response("", { status: 401 }));
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("Observations stopped: your session has ended.");
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    await advance(120000);
    expect(calls).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
    expect(calls).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Retry now" })).toBeDisabled(); // attempt in flight
  });

  it("says too many streams on a 429", async () => {
    render(wrap(<ObservationPanel />));
    calls[0]?.respond(new Response("", { status: 429, headers: { "Retry-After": "5" } }));
    await flush();
    expect(screen.getByText("Too many streams, waiting to retry")).toBeInTheDocument();
  });

  it("pauses when the tab is hidden, holds no connection, and reconnects on visible", async () => {
    render(wrap(<ObservationPanel />));
    await open();
    visibility = "hidden";
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(screen.getByText("Paused (tab hidden)")).toBeInTheDocument();
    await advance(60000);
    expect(calls).toHaveLength(1);
    visibility = "visible";
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(calls).toHaveLength(2);
    expect(screen.getByText("No observations are shown yet.")).toBeInTheDocument();
  });
});

describe("offline (F4)", () => {
  it("shows Offline, disables Retry now, makes no request, and connects when the online event fires", async () => {
    let onLine = false;
    vi.spyOn(window.navigator, "onLine", "get").mockImplementation(() => onLine);
    render(wrap(<ObservationPanel />));
    expect(screen.getByText("Offline")).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Retry now" });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    await advance(120000);
    expect(calls).toHaveLength(0);
    onLine = true;
    act(() => void window.dispatchEvent(new Event("online")));
    expect(calls).toHaveLength(1);
    expect(screen.getByText("Connecting")).toBeInTheDocument();
  });
});

describe("lifecycle and isolation", () => {
  it("aborts and removes every listener it added when it unmounts", async () => {
    const addDoc = vi.spyOn(document, "addEventListener");
    const removeDoc = vi.spyOn(document, "removeEventListener");
    const addWin = vi.spyOn(window, "addEventListener");
    const removeWin = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(wrap(<ObservationPanel />));
    await open();
    const names = (spy: typeof addDoc) => spy.mock.calls.map((c) => c[0]).filter((n) => ["visibilitychange", "freeze", "pagehide", "beforeunload", "pageshow", "offline", "online"].includes(n));
    expect(names(addDoc).length + names(addWin).length).toBe(7);
    unmount();
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(names(removeDoc).sort()).toEqual(names(addDoc).sort());
    expect(names(removeWin).sort()).toEqual(names(addWin).sort());
  });

  it("leaves exactly one live stream under StrictMode's mount, unmount, mount", () => {
    render(<StrictMode>{wrap(<ObservationPanel />)}</StrictMode>);
    expect(calls.filter((c) => !c.signal.aborted)).toHaveLength(1);
  });

  it("does not re-render other consumers of the session when the stream updates", async () => {
    let renders = 0;
    const Consumer = () => {
      useAuth();
      const seen = useRef(0);
      seen.current += 1;
      renders = seen.current;
      return null;
    };
    const auth = session();
    render(wrap(<><Consumer /><ObservationPanel /></>, { auth }));
    const s = await open();
    const before = renders;
    for (let i = 0; i < 5; i++) {
      s.push(sse(update(2 + i, makeValue("USD", "INR", 0, "fresh", `${i}.5`))));
      await flush();
    }
    await advance(3000);
    expect(renders).toBe(before);
    expect(within(rowOf("USD/INR")).getByText("4.5")).toBeInTheDocument();
  });

  it("makes no routing, transaction or API-client call: only the stream is opened", async () => {
    render(wrap(<ObservationPanel />));
    const s = await open();
    s.push(sse(update(2, makeValue("USD", "INR", 0, "fresh", "3.3"))));
    await flush();
    expect(calls).toHaveLength(1); // the session's API client rejects any use, and none happened
  });
});
