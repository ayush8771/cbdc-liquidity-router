import { act, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataModeContext } from "../../src/api/dataMode";
import { createApiClient } from "../../src/api/client";
import { AuthContext, type AuthContextValue } from "../../src/auth/AuthContext";
import { ObservationPanel } from "../../src/features/observations/ObservationPanel";
import { ObservationsFlagContext } from "../../src/features/observations/flags";
import { PAIRS, SOURCE_STATUSES } from "../../src/features/observations/types";
import { TEST_USER } from "../renderRoute";
import { PAIR_LIST, PROFILE, freshValues, heartbeat, makeValue, snapshot, sse, streamResponse, update } from "./fixtures";

/*
 * Phase 3.3-S: deterministic synthetic fault scenarios for the dashboard observation panel (test-only).
 * Faults are simulated with hand-fed SSE streams and fake timers; no backend, no real time. Nisarga's
 * fault fixtures (services/ingestion) are Python and cannot be consumed here, so these local fixtures stand in.
 */
type Call = { signal: AbortSignal; respond: (r: Response) => void };
let calls: Call[] = [];
let apiCalls = 0;
let fetchSpy: ReturnType<typeof vi.spyOn>;

function session(): AuthContextValue {
  return {
    status: "signedIn",
    user: TEST_USER,
    sessionNotice: null,
    signIn: async () => ({ ok: false, reason: "unavailable" }),
    signOut: () => {},
    api: createApiClient({
      getToken: () => null,
      fetchImpl: () => {
        apiCalls += 1;
        return Promise.reject(new Error("no API calls expected"));
      },
    }),
    openObservationStream: (signal) => new Promise<Response>((resolve) => calls.push({ signal, respond: resolve })),
  };
}

const wrap = (children: ReactNode) => (
  <DataModeContext.Provider value="live">
    <ObservationsFlagContext.Provider value={true}>
      <AuthContext.Provider value={session()}>{children}</AuthContext.Provider>
    </ObservationsFlagContext.Provider>
  </DataModeContext.Provider>
);

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const rowOf = (pair: string) => screen.getByRole("row", { name: new RegExp(pair) });
const PAIR_NAMES = PAIR_LIST.map(([b, q]) => `${b}/${q}`);
const dataRows = () => screen.getAllByRole("row").slice(1);
const labelOf = (pair: string) => {
  const row = within(rowOf(pair));
  if (row.queryByText("SIMULATED · stale")) return "stale";
  if (row.queryByText("SIMULATED")) return "fresh";
  return row.queryAllByText("Unavailable").length > 0 ? "unavailable" : "?";
};

async function open(values = freshValues(0)) {
  render(wrap(<ObservationPanel />));
  const s = streamResponse();
  calls[0]?.respond(s.response);
  s.push(sse(snapshot(1, values)));
  await flush();
  return s;
}
/** A new connection after a recoverable failure (backoff is at most 2 s). */
async function reconnect(index: number, values = freshValues(0)) {
  await advance(2000);
  expect(calls).toHaveLength(index + 1);
  const s = streamResponse();
  calls[index]?.respond(s.response);
  s.push(sse(snapshot(1, values)));
  await flush();
  return s;
}
const freshOf = (pair: string, rate: string) => {
  const [b, q] = pair.split("/") as [string, string];
  return makeValue(b, q, 0, "fresh", rate);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  calls = [];
  apiCalls = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no fetch expected"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("A. four FX pairs", () => {
  it("keeps the allowlist and its order: AED/MXN, EUR/USD, GBP/PHP, USD/INR", async () => {
    expect(PAIRS.map((p) => `${p.base}/${p.quote}`)).toEqual(PAIR_NAMES);
    await open();
    expect(dataRows().map((r) => r.textContent?.slice(0, 7))).toEqual(PAIR_NAMES);
  });

  it("treats a snapshot with a missing, extra or reordered pair as a protocol fault and shows no rows", async () => {
    const bads = [
      freshValues(0).slice(0, 3),
      [...freshValues(0), makeValue("EUR", "GBP", 0, "fresh")],
      [...freshValues(0)].reverse(),
    ];
    for (const bad of bads) {
      calls = [];
      const view = render(wrap(<ObservationPanel />));
      const s = streamResponse();
      calls[0]?.respond(s.response);
      s.push(sse(snapshot(1, bad)));
      await flush();
      expect(screen.getByText("Disconnected, reconnecting")).toBeInTheDocument();
      expect(screen.queryAllByRole("row")).toHaveLength(0);
      view.unmount();
    }
  });

  it("treats an update for a pair outside the allowlist as a fault: no fifth row, the four rows are kept", async () => {
    const s = await open();
    s.push(sse(update(2, makeValue("EUR", "GBP", 0, "fresh", "5.5"))));
    await flush();
    expect(screen.getByText("Disconnected, reconnecting")).toBeInTheDocument();
    expect(dataRows().map((r) => r.textContent?.slice(0, 7))).toEqual(PAIR_NAMES);
    expect(screen.queryByText("EUR/GBP")).toBeNull();
    expect(screen.queryByText("5.5")).toBeNull();
  });
});

describe("B. source silence", () => {
  it("ages every value with elapsed time while no bytes arrive", async () => {
    await open(freshValues(1000));
    expect(within(rowOf("USD/INR")).getByText("1 s")).toBeInTheDocument();
    await advance(4000);
    expect(within(rowOf("USD/INR")).getByText("5 s")).toBeInTheDocument();
    await advance(10_000);
    expect(within(rowOf("USD/INR")).getByText("15 s")).toBeInTheDocument();
  });

  it("keeps ageing under heartbeats alone: a heartbeat is not an observation", async () => {
    const s = await open(freshValues(0));
    for (let seq = 2; seq <= 4; seq++) {
      await advance(2000);
      s.push(sse(heartbeat(seq)));
      await flush();
    }
    expect(within(rowOf("AED/MXN")).getByText("6 s")).toBeInTheDocument();
    expect(labelOf("AED/MXN")).toBe("fresh");
    await advance(2000);
    expect(within(rowOf("AED/MXN")).getByText("8 s")).toBeInTheDocument();
    expect(labelOf("AED/MXN")).toBe("stale");
  });

  it("ages only the pair that went silent while the others keep updating", async () => {
    const s = await open(freshValues(0));
    let seq = 2;
    for (let i = 0; i < 4; i++) {
      await advance(2000);
      for (const pair of ["AED/MXN", "EUR/USD", "GBP/PHP"]) s.push(sse(update(seq++, freshOf(pair, "3.3333"))));
      await flush();
    }
    expect(labelOf("USD/INR")).toBe("stale"); // 8 s with no update
    for (const pair of ["AED/MXN", "EUR/USD", "GBP/PHP"]) expect(labelOf(pair)).toBe("fresh");
  });

  it("drops the connection after 35 s without a byte, keeps the values ageing, and reconnects", async () => {
    await open(freshValues(0));
    await advance(35_000);
    expect(screen.getByText("Disconnected, reconnecting")).toBeInTheDocument();
    expect(labelOf("USD/INR")).toBe("unavailable");
    await advance(2000);
    expect(calls).toHaveLength(2);
  });
});

describe("C. freshness transitions at the profile thresholds (6,000 ms stale, 30,000 ms unavailable)", () => {
  it("is fresh at exactly 6,000 ms, stale at 6,001 ms, stale at exactly 30,000 ms, unavailable at 30,001 ms", async () => {
    expect(PROFILE.stale_after_ms).toBe(6000);
    expect(PROFILE.unavailable_after_ms).toBe(30000);
    await open(freshValues(0));
    expect(labelOf("EUR/USD")).toBe("fresh");
    await advance(6000);
    expect(labelOf("EUR/USD")).toBe("fresh");
    await advance(1);
    expect(labelOf("EUR/USD")).toBe("stale");
    await advance(23_999);
    expect(labelOf("EUR/USD")).toBe("stale");
    expect(within(rowOf("EUR/USD")).getByText("2.2345")).toBeInTheDocument();
    await advance(1);
    expect(labelOf("EUR/USD")).toBe("unavailable");
  });

  it("withdraws the number and clears age and source when a value becomes unavailable", async () => {
    await open(freshValues(0));
    await advance(30_001);
    const row = within(rowOf("EUR/USD"));
    expect(row.queryByText("2.2345")).toBeNull();
    expect(row.queryByText(/\d+ s/)).toBeNull();
    expect(row.queryByText("synthetic")).toBeNull();
  });

  it("counts the age already carried at receipt toward the thresholds", async () => {
    await open(freshValues(5000));
    await advance(1000);
    expect(labelOf("EUR/USD")).toBe("fresh"); // 6,000 ms
    await advance(1);
    expect(labelOf("EUR/USD")).toBe("stale");
  });
});

describe("D. recovery after a synthetic fault", () => {
  async function allUnavailable() {
    const s = await open(freshValues(0));
    await advance(30_001);
    for (const p of PAIR_NAMES) expect(labelOf(p)).toBe("unavailable");
    return s;
  }

  it("a valid fresh update restores only its own pair", async () => {
    const s = await allUnavailable();
    s.push(sse(update(2, makeValue("GBP", "PHP", 500, "fresh", "8.8"))));
    await flush();
    expect(labelOf("GBP/PHP")).toBe("fresh");
    expect(within(rowOf("GBP/PHP")).getByText("8.8")).toBeInTheDocument();
    for (const p of ["AED/MXN", "EUR/USD", "USD/INR"]) expect(labelOf(p)).toBe("unavailable");
  });

  it("a valid stale update restores to stale, not fresh", async () => {
    const s = await allUnavailable();
    s.push(sse(update(2, makeValue("GBP", "PHP", 7000, "stale", "8.8"))));
    await flush();
    expect(labelOf("GBP/PHP")).toBe("stale");
  });

  it("an update that is itself past the unavailable threshold does not restore a value", async () => {
    const s = await allUnavailable();
    s.push(sse(update(2, makeValue("GBP", "PHP", 40_000, "unavailable", "8.8"))));
    await flush();
    expect(labelOf("GBP/PHP")).toBe("unavailable");
    expect(screen.queryByText("8.8")).toBeNull();
  });

  it.each([
    ["a non-synthetic provenance", { provenance_class: "real_licensed" }],
    ["a validation status that is not validated", { validation: { status: "rejected", reasons: [] } }],
    ["a non-display_only usage", { usage: "routing" }],
    ["a malformed rate", { payload: { base_currency: "GBP", quote_currency: "PHP", rate: "abc", rate_type: "mid" } }],
    ["a zero rate", { payload: { base_currency: "GBP", quote_currency: "PHP", rate: "0", rate_type: "mid" } }],
  ])("an update with %s is withheld and does not restore freshness", async (_name, over) => {
    const s = await allUnavailable();
    s.push(sse(update(2, makeValue("GBP", "PHP", 0, "fresh", "8.8", over))));
    await flush();
    expect(labelOf("GBP/PHP")).toBe("unavailable");
    expect(screen.queryByText("8.8")).toBeNull();
    expect(screen.getByText("Receiving")).toBeInTheDocument(); // a withheld value is not a protocol fault
  });

  it("an update whose freshness disagrees with its age is a fault and restores nothing", async () => {
    const s = await allUnavailable();
    s.push(sse(update(2, makeValue("GBP", "PHP", 20_000, "fresh", "8.8"))));
    await flush();
    expect(screen.getByText("Disconnected, reconnecting")).toBeInTheDocument();
    expect(labelOf("GBP/PHP")).toBe("unavailable");
    expect(screen.queryByText("8.8")).toBeNull();
  });

  it("a fresh snapshot on a new connection restores all four pairs", async () => {
    const s = await allUnavailable();
    s.push(sse(update(2, makeValue("GBP", "PHP", 20_000, "fresh")))); // fault
    await flush();
    await reconnect(1);
    for (const p of PAIR_NAMES) expect(labelOf(p)).toBe("fresh");
    expect(screen.getByText("Receiving")).toBeInTheDocument();
  });
});

describe("E. SSE interruption and reconnection", () => {
  it("shows the interruption, keeps the old values, reconnects, and replaces them with the new snapshot", async () => {
    const s1 = await open(freshValues(0));
    s1.fail();
    await flush();
    expect(screen.getByText("Disconnected, reconnecting")).toBeInTheDocument();
    expect(dataRows()).toHaveLength(4);
    await reconnect(1, PAIR_NAMES.map((p, i) => freshOf(p, `6.${i}`)));
    expect(screen.getByText("Receiving")).toBeInTheDocument();
    expect(dataRows()).toHaveLength(4);
    expect(within(rowOf("USD/INR")).getByText("6.3")).toBeInTheDocument();
    expect(screen.queryByText("4.2345")).toBeNull();
  });

  it("restarts stream_seq at 1 on the new connection and applies its updates once", async () => {
    const s1 = await open();
    s1.push(sse(update(2, freshOf("USD/INR", "9.9"))));
    await flush();
    s1.end();
    await flush();
    const s2 = await reconnect(1);
    s2.push(sse(update(2, freshOf("USD/INR", "7.7"))));
    await flush();
    expect(screen.getByText("Receiving")).toBeInTheDocument();
    expect(screen.getAllByRole("row", { name: /USD\/INR/ })).toHaveLength(1);
    expect(within(rowOf("USD/INR")).getByText("7.7")).toBeInTheDocument();
    expect(screen.queryByText("9.9")).toBeNull();
    expect(dataRows()).toHaveLength(4);
  });

  it("treats a replayed stream_seq as a fault and does not apply or duplicate the update", async () => {
    const s = await open();
    s.push(sse(update(2, freshOf("USD/INR", "9.9"))));
    s.push(sse(update(2, freshOf("USD/INR", "5.5")))); // replay of seq 2
    await flush();
    expect(screen.getByText("Disconnected, reconnecting")).toBeInTheDocument();
    expect(screen.queryByText("5.5")).toBeNull();
    expect(dataRows()).toHaveLength(4);
  });

  it("treats a second snapshot on one connection as a fault", async () => {
    const s = await open();
    s.push(sse(snapshot(2, freshValues(0))));
    await flush();
    expect(screen.getByText("Disconnected, reconnecting")).toBeInTheDocument();
  });

  it("recovers from repeated interruptions, each time with a single new connection", async () => {
    const s1 = await open();
    s1.fail();
    await flush();
    const s2 = await reconnect(1);
    s2.fail();
    await flush();
    await reconnect(2);
    expect(calls).toHaveLength(3);
    expect(screen.getByText("Receiving")).toBeInTheDocument();
    expect(dataRows()).toHaveLength(4);
  });

  it("makes no request while the reconnect wait is pending, and exactly one when it ends", async () => {
    const s = await open();
    s.fail();
    await flush();
    await advance(499); // minimum backoff is 0.5 s
    expect(calls).toHaveLength(1);
    await advance(1501);
    expect(calls).toHaveLength(2);
  });
});

describe("F. Express-owned source.status", () => {
  it("pins the published contract to starting | ok | outage", () => {
    expect(SOURCE_STATUSES).toEqual(["starting", "ok", "outage"]);
  });

  it("shows exactly the last published status while values age to unavailable", async () => {
    await open(freshValues(0));
    await advance(30_001);
    expect(labelOf("USD/INR")).toBe("unavailable");
    expect(screen.getByText("Source synthetic.fx: ok")).toBeInTheDocument();
    expect(screen.queryByText(/outage/i)).toBeNull();
  });

  it("does not change the status on interruption, a long wait or reconnect attempts", async () => {
    const s = await open();
    s.push(sse(heartbeat(2, "starting")));
    await flush();
    s.fail();
    await flush();
    expect(screen.getByText("Source synthetic.fx: starting")).toBeInTheDocument();
    await advance(60_000); // the reconnect waits for a response that never comes; nothing alters the label
    expect(screen.getByText("Source synthetic.fx: starting")).toBeInTheDocument();
    expect(screen.queryByText(/Source synthetic\.fx: (outage|unavailable|disconnected|stale)/)).toBeNull();
  });

  it("follows a published outage and a published recovery, and nothing else", async () => {
    const s = await open();
    s.push(sse(heartbeat(2, "outage")));
    await flush();
    expect(screen.getByText("Source synthetic.fx: outage")).toBeInTheDocument();
    s.push(sse(heartbeat(3, "ok")));
    await flush();
    expect(screen.getByText("Source synthetic.fx: ok")).toBeInTheDocument();
  });

  it("rejects a status outside the contract as a fault instead of displaying or inventing one", async () => {
    const s = await open();
    s.push(sse(heartbeat(2, "degraded")));
    await flush();
    expect(screen.queryByText(/degraded/)).toBeNull();
    expect(screen.getByText("Source synthetic.fx: ok")).toBeInTheDocument();
    expect(screen.getByText("Disconnected, reconnecting")).toBeInTheDocument();
  });

  it("does not set the source to outage when every value is unavailable", async () => {
    render(wrap(<ObservationPanel />));
    const s = streamResponse();
    calls[0]?.respond(s.response);
    s.push(sse(snapshot(1, PAIR_LIST.map(([b, q]) => makeValue(b, q, null, "unavailable")))));
    await flush();
    expect(screen.getByText("Source synthetic.fx: ok")).toBeInTheDocument();
    expect(screen.queryByText("The simulated source reports an outage")).toBeNull();
  });
});

describe("G. routing isolation", () => {
  it("makes no routing, transaction, compare or API call through a full fault cycle: only stream requests are opened", async () => {
    const s1 = await open(freshValues(0));
    await advance(30_001); // ageing to unavailable
    s1.push(sse(update(2, freshOf("GBP/PHP", "8.8")))); // recovery
    s1.push(sse(update(3, makeValue("GBP", "PHP", 20_000, "fresh")))); // fault
    await flush();
    const s2 = await reconnect(1); // reconnection
    s2.fail();
    await flush();
    await reconnect(2);
    expect(calls).toHaveLength(3);
    expect(apiCalls).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("states that observations do not affect routing", async () => {
    await open();
    expect(screen.getByText("Observations are shown for context. They do not affect routing.")).toBeInTheDocument();
  });
});
