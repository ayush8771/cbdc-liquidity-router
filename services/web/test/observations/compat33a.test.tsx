import { act, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataModeContext, type DataMode } from "../../src/api/dataMode";
import { createApiClient } from "../../src/api/client";
import { AuthContext, type AuthContextValue } from "../../src/auth/AuthContext";
import { ObservationPanel } from "../../src/features/observations/ObservationPanel";
import { parseProfile } from "../../src/features/observations/validate";
import { ObservationsFlagContext } from "../../src/features/observations/flags";
import { TEST_USER } from "../renderRoute";
import { PROFILE, freshValues, makeValue, snapshot, sse, streamResponse, update } from "./fixtures";

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


/*
 * Phase 3.3-A compatibility checks for gaps in the D-24 coverage. Test-only: no production change.
 */
const statusSnapshot = (status: string) =>
  snapshot(1, freshValues(), { source: { source_id: "synthetic.fx", status } });

describe("3.3-A compatibility: synthetic profile and published source.status", () => {
  it("pins the whole synthetic profile: 2,000 ms interval, null live_max_age_ms, 6,000 / 30,000 ms thresholds, 1,000 ms tolerance", () => {
    expect(parseProfile(PROFILE)).toEqual({
      expectedIntervalMs: 2000, liveMaxAgeMs: null, staleAfterMs: 6000, unavailableAfterMs: 30000, clockToleranceMs: 1000,
    });
  });

  it.each(["starting", "ok", "outage"])("shows the published status %s as received", async (status) => {
    render(wrap(<ObservationPanel />));
    const s = streamResponse();
    calls[0]?.respond(s.response);
    s.push(sse(statusSnapshot(status)));
    await flush();
    expect(screen.getByText(`Source synthetic.fx: ${status}`)).toBeInTheDocument();
  });

  it("a transport disconnect is shown as a connection state; the source status stays as last published", async () => {
    render(wrap(<ObservationPanel />));
    const s = streamResponse();
    calls[0]?.respond(s.response);
    s.push(sse(statusSnapshot("starting")));
    await flush();
    s.end();
    await flush();
    expect(screen.getByText("Disconnected, reconnecting")).toBeInTheDocument();
    expect(screen.getByText("Source synthetic.fx: starting")).toBeInTheDocument();
    expect(screen.queryByText(/Source synthetic\.fx: (disconnected|offline|unavailable)/)).toBeNull();
  });
});

describe("3.3-A compatibility: reconnection and the clock", () => {
  it("a reconnect shows only the new snapshot: no earlier update or duplicate row survives", async () => {
    render(wrap(<ObservationPanel />));
    const s1 = await open();
    s1.push(sse(update(2, makeValue("USD", "INR", 0, "fresh", "9.9"))));
    await flush();
    expect(within(rowOf("USD/INR")).getByText("9.9")).toBeInTheDocument();
    s1.end();
    await flush();
    await advance(2000); // backoff is at most 2 s
    expect(calls).toHaveLength(2);
    const s2 = streamResponse();
    calls[1]?.respond(s2.response);
    s2.push(sse(snapshot(1, freshValues().map((v, i) => ({ ...v, ...makeValue(["AED", "EUR", "GBP", "USD"][i] as string, ["MXN", "USD", "PHP", "INR"][i] as string, 500, "fresh", `7.${i}`) })))));
    await flush();
    expect(screen.getAllByRole("row", { name: /USD\/INR/ })).toHaveLength(1);
    expect(within(rowOf("USD/INR")).getByText("7.3")).toBeInTheDocument();
    expect(screen.queryByText("9.9")).toBeNull();
    expect(screen.getByText("Receiving")).toBeInTheDocument();
  });

  it("freshness follows elapsed monotonic time, not the wall clock: a wall-clock jump does not age a value", async () => {
    render(wrap(<ObservationPanel />));
    await open(freshValues(0));
    vi.setSystemTime(Date.now() + 3_600_000); // wall clock +1 h, no monotonic time passes
    await flush();
    expect(within(rowOf("USD/INR")).getByText("SIMULATED")).toBeInTheDocument();
    expect(within(rowOf("USD/INR")).getByText("4.2345")).toBeInTheDocument();
  });
});
