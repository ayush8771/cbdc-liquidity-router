import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createObservationController,
  retryAfterMs,
  type ObservationController,
} from "../../src/features/observations/observationController";
import { freshValues, heartbeat, makeValue, snapshot, sse, streamResponse, update } from "./fixtures";

type Call = { signal: AbortSignal; respond: (r: Response) => void; reject: (e: unknown) => void };

let clock = 0;
let calls: Call[] = [];
let controller: ObservationController;
let visibility: "visible" | "hidden" = "visible";
let onLine = true;
const warn = vi.fn();

const open = (signal: AbortSignal) =>
  new Promise<Response>((resolve, reject) => {
    calls.push({ signal, respond: resolve, reject });
  });

/** Advances the injected monotonic clock and the fake timers together. */
async function advance(ms: number) {
  clock += ms;
  await vi.advanceTimersByTimeAsync(ms);
}
const settle = () => advance(0);

function make(random = () => 1): ObservationController {
  controller = createObservationController({ open, now: () => clock, wallNow: () => Date.now(), random, warn });
  return controller;
}

/** Starts, answers the first request with a 200 stream and delivers a snapshot. */
async function streaming(random = () => 1) {
  make(random);
  controller.start();
  const s = streamResponse();
  calls[0]?.respond(s.response);
  s.push(sse(snapshot(1)));
  await settle();
  return s;
}

const fire = (target: EventTarget, name: string, init: object = {}) =>
  target.dispatchEvent(Object.assign(new Event(name), init));

beforeEach(() => {
  vi.useFakeTimers();
  clock = 0;
  calls = [];
  visibility = "visible";
  onLine = true;
  warn.mockReset();
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.spyOn(window.navigator, "onLine", "get").mockImplementation(() => onLine);
});
afterEach(() => {
  controller?.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("a healthy stream", () => {
  it("opens once, shows the snapshot, applies updates and heartbeats separately", async () => {
    const s = await streaming();
    const state = () => controller.getSnapshot();
    expect(calls).toHaveLength(1);
    expect(state().phase).toBe("streaming");
    expect(state().values).toHaveLength(4);
    expect(state().values?.[3]).toMatchObject({ base: "USD", quote: "INR", rate: "4.2345", ageAtReceiptMs: 1000 });
    expect(state().source).toEqual({ sourceId: "synthetic.fx", status: "ok" });

    await advance(500);
    s.push(sse(update(2, makeValue("USD", "INR", 0, "fresh", "9.9"))));
    await settle();
    expect(state().values?.[3]).toMatchObject({ rate: "9.9", ageAtReceiptMs: 0, receivedAtMs: 500 });
    expect(state().values?.[0]?.rate).toBe("1.2345");

    s.push(sse(heartbeat(3, "outage")));
    await settle();
    expect(state().source?.status).toBe("outage"); // a source outage is not a disconnect
    expect(state().phase).toBe("streaming");
  });

  it("withholds a non-synthetic value and counts it, without faulting", async () => {
    make();
    controller.start();
    const s = streamResponse();
    calls[0]?.respond(s.response);
    const values = freshValues();
    values[1] = makeValue("EUR", "USD", 1000, "fresh", "1", { provenance_class: "real" });
    s.push(sse(snapshot(1, values)));
    await settle();
    expect(controller.getSnapshot()).toMatchObject({ phase: "streaming", withheld: 1 });
    expect(controller.getSnapshot().values?.[1]).toMatchObject({ rate: null, unavailable: true });
  });

  it("ignores an unknown message type but still counts its stream_seq", async () => {
    const s = await streaming();
    s.push(sse({ ...heartbeat(2), type: "notice", extra: 1 }));
    s.push(sse(heartbeat(3)));
    await settle();
    expect(controller.getSnapshot().phase).toBe("streaming");
    s.push(sse(heartbeat(9)));
    await settle();
    expect(controller.getSnapshot().phase).toBe("waiting"); // a gap
  });
});

describe("reconnect and backoff (§3.3)", () => {
  it("reconnects after a normal end with 1 s, then 2 s, never more than 2 s, and resets after a snapshot", async () => {
    const s = await streaming(() => 1);
    s.end();
    await settle();
    expect(controller.getSnapshot().phase).toBe("waiting");
    await advance(999);
    expect(calls).toHaveLength(1);
    await advance(1);
    expect(calls).toHaveLength(2);

    calls[1]?.reject(new TypeError("down")); // 2nd failure: 2 s
    await settle();
    await advance(1999);
    expect(calls).toHaveLength(2);
    await advance(1);
    expect(calls).toHaveLength(3);

    calls[2]?.reject(new TypeError("down")); // 3rd failure: still 2 s
    await settle();
    await advance(2000);
    expect(calls).toHaveLength(4);

    const s2 = streamResponse();
    calls[3]?.respond(s2.response);
    s2.push(sse(snapshot(1)));
    await settle();
    s2.end(); // reset by the valid snapshot: back to 1 s
    await settle();
    await advance(1000);
    expect(calls).toHaveLength(5);
  });

  it("jitters each wait between 0.5x and 1x", async () => {
    make(() => 0);
    controller.start();
    calls[0]?.reject(new TypeError("down"));
    await settle();
    await advance(500);
    expect(calls).toHaveLength(2);
  });

  it("reconnects after a network error in the body", async () => {
    const s = await streaming();
    s.fail();
    await settle();
    expect(controller.getSnapshot().phase).toBe("waiting");
    await advance(1000);
    expect(calls).toHaveLength(2);
  });

  it("aborts and reconnects when no headers arrive within 2 s", async () => {
    make();
    controller.start();
    await advance(1999);
    expect(calls[0]?.signal.aborted).toBe(false);
    await advance(1);
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(controller.getSnapshot().phase).toBe("waiting");
    await advance(1000);
    expect(calls).toHaveLength(2);
  });

  it("aborts and reconnects after 35 s without bytes; a comment counts as traffic", async () => {
    const s = await streaming();
    await advance(30000);
    s.push(": keep-alive\n\n");
    await settle();
    await advance(34999);
    expect(controller.getSnapshot().phase).toBe("streaming");
    await advance(1);
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(controller.getSnapshot().phase).toBe("waiting");
  });

  it("keeps displayed values, aging, while disconnected", async () => {
    const s = await streaming();
    s.end();
    await settle();
    expect(controller.getSnapshot().values).toHaveLength(4);
    expect(controller.getSnapshot().phase).toBe("waiting");
  });
});

describe("HTTP statuses (§3.3 table, §3.3.2)", () => {
  async function respondWith(status: number, headers: Record<string, string> = {}) {
    make();
    controller.start();
    calls[0]?.respond(new Response(JSON.stringify({ error: { code: "X", message: "m" } }), { status, headers }));
    await settle();
  }

  it("stops for good on 401: no timer, no backoff, no reconnect", async () => {
    await respondWith(401);
    expect(controller.getSnapshot()).toMatchObject({ phase: "stopped", stopReason: "unauthenticated" });
    await advance(120000);
    expect(calls).toHaveLength(1);
  });

  it.each([403, 404, 405, 422])("stops for good on %i", async (status) => {
    await respondWith(status);
    expect(controller.getSnapshot()).toMatchObject({ phase: "stopped", stopReason: "unavailable" });
    await advance(120000);
    expect(calls).toHaveLength(1);
  });

  it("waits the larger of Retry-After and the backoff on 429, and says so", async () => {
    await respondWith(429, { "Retry-After": "5" });
    expect(controller.getSnapshot()).toMatchObject({ phase: "waiting", tooManyStreams: true });
    await advance(4999);
    expect(calls).toHaveLength(1);
    await advance(1);
    expect(calls).toHaveLength(2);
  });

  it("caps a long Retry-After at 30 s", async () => {
    await respondWith(429, { "Retry-After": "3600" });
    await advance(29999);
    expect(calls).toHaveLength(1);
    await advance(1);
    expect(calls).toHaveLength(2);
  });

  it("honours Retry-After on 503 and uses the backoff on other 5xx", async () => {
    await respondWith(503, { "Retry-After": "1" });
    await advance(1000);
    expect(calls).toHaveLength(2);
    calls[1]?.respond(new Response("bad gateway", { status: 502, headers: { "Retry-After": "20" } }));
    await settle();
    await advance(2000); // Retry-After is read on 429 and 503 only
    expect(calls).toHaveLength(3);
  });

  it("treats a 200 that is not an event stream as a protocol fault", async () => {
    make();
    controller.start();
    calls[0]?.respond(new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    await settle();
    expect(controller.getSnapshot().phase).toBe("waiting");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not an event stream"));
  });
});

describe("protocol faults (§3.3.3)", () => {
  async function faultOnce(index: number) {
    const s = streamResponse();
    calls[index]?.respond(s.response);
    s.push(sse(heartbeat(1))); // a first message that is not a snapshot
    await settle();
    return s;
  }

  it("stops for good after three faults without 60 s of valid streaming between them", async () => {
    make();
    controller.start();
    await faultOnce(0);
    expect(controller.getSnapshot().phase).toBe("waiting");
    await advance(2000);
    await faultOnce(1);
    await advance(2000);
    await faultOnce(2);
    expect(controller.getSnapshot()).toMatchObject({ phase: "stopped", stopReason: "protocol_faults" });
    await advance(120000);
    expect(calls).toHaveLength(3);
  });

  it("does not count faults that are 60 s of valid streaming apart", async () => {
    make();
    controller.start();
    await faultOnce(0);
    await advance(2000);
    await faultOnce(1);
    await advance(2000);
    const s = streamResponse();
    calls[2]?.respond(s.response);
    s.push(sse(snapshot(1)));
    await settle();
    for (let i = 0; i < 4; i++) {
      await advance(15000);
      s.push(sse(heartbeat(2 + i)));
      await settle();
    }
    s.push(sse(heartbeat(99))); // a gap, after 60 s of valid streaming
    await settle();
    expect(controller.getSnapshot().phase).toBe("waiting");
  });

  it("stops for good on an unknown major version", async () => {
    make();
    controller.start();
    const s = streamResponse();
    calls[0]?.respond(s.response);
    s.push(sse({ ...snapshot(1), protocol_version: "2.0" }));
    await settle();
    expect(controller.getSnapshot()).toMatchObject({ phase: "stopped", stopReason: "unsupported_version" });
  });

  it("faults on an oversized message", async () => {
    make();
    controller.start();
    const s = streamResponse();
    calls[0]?.respond(s.response);
    s.push("data: " + "x".repeat(70000) + "\n\n");
    await settle();
    expect(controller.getSnapshot().phase).toBe("waiting");
  });

  it("decodes a multi-byte character split across chunks", async () => {
    make();
    controller.start();
    const s = streamResponse();
    calls[0]?.respond(s.response);
    const bytes = new TextEncoder().encode(sse(snapshot(1)).replace("synthetic.fx", "synthetic.fé"));
    const cut = bytes.indexOf(0xc3) + 1; // inside the two-byte é
    s.pushBytes(bytes.slice(0, cut));
    s.pushBytes(bytes.slice(cut));
    await settle();
    expect(controller.getSnapshot()).toMatchObject({ phase: "streaming", source: { sourceId: "synthetic.fé" } });
  });
});

describe("hidden tabs and resumption (§3.3.1)", () => {
  it("aborts at once when hidden, cancels any wait, keeps ageing values, and holds no connection", async () => {
    const s = await streaming();
    visibility = "hidden";
    fire(document, "visibilitychange");
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ phase: "paused" });
    expect(controller.getSnapshot().values).toHaveLength(4);
    s.end();
    await advance(60000);
    expect(calls).toHaveLength(1);
  });

  it("cancels a pending reconnect when hidden", async () => {
    make();
    controller.start();
    calls[0]?.reject(new TypeError("down"));
    await settle();
    expect(controller.getSnapshot().phase).toBe("waiting");
    visibility = "hidden";
    fire(document, "visibilitychange");
    await advance(60000);
    expect(calls).toHaveLength(1);
  });

  it("drops values and reconnects once on visible, from a fresh snapshot", async () => {
    await streaming();
    visibility = "hidden";
    fire(document, "visibilitychange");
    visibility = "visible";
    fire(document, "visibilitychange");
    expect(calls).toHaveLength(2);
    expect(controller.getSnapshot().values).toBeNull();
    expect(controller.getSnapshot().phase).toBe("connecting");
  });

  it("opens one stream when pageshow, visibilitychange and online arrive together", async () => {
    await streaming();
    visibility = "hidden";
    fire(document, "visibilitychange");
    visibility = "visible";
    fire(window, "pageshow", { persisted: true });
    fire(document, "visibilitychange");
    fire(window, "online");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.signal.aborted).toBe(false);
    expect(controller.getSnapshot().phase).toBe("connecting");
  });

  it("keeps the attempt a visibility resume started when a persisted pageshow follows it (M-1)", async () => {
    await streaming();
    visibility = "hidden";
    fire(document, "visibilitychange");
    visibility = "visible";
    fire(document, "visibilitychange");
    expect(calls).toHaveLength(2);
    fire(window, "pageshow", { persisted: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.signal.aborted).toBe(false);
    expect(controller.getSnapshot().phase).toBe("connecting");
  });

  it("still aborts and reconnects on a persisted pageshow with no visibility resume before it", async () => {
    await streaming();
    fire(window, "pageshow", { persisted: true });
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.signal.aborted).toBe(false);
    expect(controller.getSnapshot().phase).toBe("connecting");
  });

  it("ends with one live stream after pagehide, hidden to visible, then a persisted pageshow", async () => {
    await streaming();
    fire(window, "pagehide");
    visibility = "hidden";
    fire(document, "visibilitychange");
    visibility = "visible";
    fire(document, "visibilitychange");
    fire(window, "pageshow", { persisted: true });
    expect(calls).toHaveLength(2);
    expect(calls.filter((c) => !c.signal.aborted)).toHaveLength(1);
    expect(controller.getSnapshot().phase).toBe("connecting");
  });

  it("does not let a spent resume suppress a later restore", async () => {
    await streaming();
    visibility = "hidden";
    fire(document, "visibilitychange");
    visibility = "visible";
    fire(document, "visibilitychange");
    fire(window, "pageshow", { persisted: true }); // consumed
    fire(window, "pageshow", { persisted: true }); // a second, genuine restore
    expect(calls).toHaveLength(3);
    expect(calls[1]?.signal.aborted).toBe(true);
    expect(calls[2]?.signal.aborted).toBe(false);
  });

  it("ignores a pageshow that is not a restore", async () => {
    await streaming();
    fire(window, "pageshow", { persisted: false });
    expect(calls).toHaveLength(1);
    expect(controller.getSnapshot().phase).toBe("streaming");
  });

  it("aborts on pagehide, freeze and beforeunload", async () => {
    for (const [target, name] of [[window, "pagehide"], [document, "freeze"], [window, "beforeunload"]] as const) {
      calls = [];
      await streaming();
      fire(target, name);
      expect(calls[0]?.signal.aborted).toBe(true);
      expect(controller.getSnapshot().phase).toBe("paused");
      controller.stop();
    }
  });

  it("does not connect at all when started hidden, and connects on visible", async () => {
    visibility = "hidden";
    make();
    controller.start();
    expect(calls).toHaveLength(0);
    expect(controller.getSnapshot().phase).toBe("paused");
    visibility = "visible";
    fire(document, "visibilitychange");
    expect(calls).toHaveLength(1);
  });

  it("drops a late answer from a superseded attempt unread", async () => {
    make();
    controller.start();
    visibility = "hidden";
    fire(document, "visibilitychange"); // aborts the in-flight attempt
    const late = streamResponse();
    calls[0]?.respond(late.response);
    late.push(sse(snapshot(1)));
    await settle();
    expect(controller.getSnapshot()).toMatchObject({ phase: "paused", values: null });
  });

  it("does not let a superseded 401 stop the newer attempt", async () => {
    make();
    controller.start();
    visibility = "hidden";
    fire(document, "visibilitychange");
    visibility = "visible";
    fire(document, "visibilitychange");
    calls[0]?.respond(new Response("", { status: 401 }));
    await settle();
    expect(controller.getSnapshot().phase).toBe("connecting");
  });

  it("never auto-resumes a permanent stop on visible, pageshow or online", async () => {
    make();
    controller.start();
    calls[0]?.respond(new Response("", { status: 401 }));
    await settle();
    visibility = "hidden";
    fire(document, "visibilitychange");
    visibility = "visible";
    fire(document, "visibilitychange");
    fire(window, "pageshow", { persisted: true });
    fire(window, "online");
    expect(calls).toHaveLength(1);
    expect(controller.getSnapshot().phase).toBe("stopped");
  });
});

describe("offline", () => {
  it("aborts when offline, attempts nothing, and reconnects when online", async () => {
    await streaming();
    onLine = false;
    fire(window, "offline");
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(controller.getSnapshot().phase).toBe("offline");
    await advance(60000);
    expect(calls).toHaveLength(1);
    onLine = true;
    fire(window, "online");
    expect(calls).toHaveLength(2);
  });
});

describe("Retry now", () => {
  it("leaves a permanent stop, resets the counters and connects once", async () => {
    make();
    controller.start();
    calls[0]?.respond(new Response("", { status: 404 }));
    await settle();
    expect(controller.getSnapshot().phase).toBe("stopped");
    controller.retryNow();
    controller.retryNow(); // disabled while an attempt is in flight
    expect(calls).toHaveLength(2);
    expect(controller.getSnapshot()).toMatchObject({ phase: "connecting", stopReason: null });
  });

  it("cancels a pending wait and connects at once", async () => {
    make();
    controller.start();
    calls[0]?.reject(new TypeError("down"));
    await settle();
    controller.retryNow();
    expect(calls).toHaveLength(2);
    calls[1]?.respond(streamResponse().response);
    await advance(5000); // the cancelled wait would have fired by now
    expect(calls).toHaveLength(2); // and did not open a third
  });

  it("does nothing while hidden", async () => {
    make();
    controller.start();
    calls[0]?.respond(new Response("", { status: 404 }));
    await settle();
    visibility = "hidden";
    controller.retryNow();
    expect(calls).toHaveLength(1);
  });
});

describe("lifecycle", () => {
  it("stop() aborts, removes every listener and resets", async () => {
    await streaming();
    controller.stop();
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(controller.getSnapshot().phase).toBe("idle");
    visibility = "hidden";
    fire(document, "visibilitychange");
    fire(window, "online");
    fire(window, "pagehide");
    expect(controller.getSnapshot().phase).toBe("idle");
    expect(calls).toHaveLength(1);
  });

  it("survives a StrictMode style start, stop, start: one live connection", async () => {
    make();
    controller.start();
    controller.stop();
    controller.start();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(calls[1]?.signal.aborted).toBe(false);
  });

  it("start() is idempotent", () => {
    make();
    controller.start();
    controller.start();
    expect(calls).toHaveLength(1);
  });

  it("notifies subscribers and stops after unsubscribe", async () => {
    make();
    const listener = vi.fn();
    const off = controller.subscribe(listener);
    controller.start();
    expect(listener).toHaveBeenCalled();
    off();
    listener.mockClear();
    controller.stop();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("Retry-After table (§3.3.2)", () => {
  const wall = Date.parse("2026-11-25T12:00:00Z");
  it.each([
    [null, 5000],
    ["", 5000],
    ["soon", 5000],
    ["0", 1000],
    ["-3", 1000],
    ["5", 5000],
    ["2.5", 2500],
    ["0.2", 1000],
    ["45", 30000],
    ["Infinity", 30000],
    ["9".repeat(400), 30000],
  ])("%j gives %i ms", (value, expected) => expect(retryAfterMs(value, null, wall)).toBe(expected));
  it("measures an HTTP-date against the Date header, else the local clock", () => {
    expect(retryAfterMs("Wed, 25 Nov 2026 12:00:07 GMT", "Wed, 25 Nov 2026 12:00:00 GMT", 0)).toBe(7000);
    expect(retryAfterMs("Wed, 25 Nov 2026 12:00:07 GMT", null, wall)).toBe(7000);
    expect(retryAfterMs("Wed, 25 Nov 2026 12:00:07 GMT", "garbage", wall)).toBe(7000);
    expect(retryAfterMs("Wed, 25 Nov 2026 11:59:00 GMT", null, wall)).toBe(1000);
    expect(retryAfterMs("Wed, 25 Nov 2026 13:00:00 GMT", null, wall)).toBe(30000);
  });
});

describe("fault window across connections (F2)", () => {
  async function fault(index: number) {
    const s = streamResponse();
    calls[index]?.respond(s.response);
    s.push(sse(heartbeat(1))); // a first message that is not a snapshot: a protocol fault
    await settle();
  }
  /** Opens connection `index`, sends a valid snapshot, then heartbeats every 15 s until `ms` have passed. */
  async function validFor(index: number, ms: number) {
    const s = streamResponse();
    calls[index]?.respond(s.response);
    s.push(sse(snapshot(1)));
    await settle();
    for (let t = 0, n = 2; t < ms; t += 15000, n++) {
      await advance(Math.min(15000, ms - t));
      s.push(sse(heartbeat(n)));
      await settle();
    }
    return s;
  }
  /** Two faults, then valid streaming, an end, and a new connection (calls[3]) that opens with a snapshot and faults. */
  async function twoFaultsThen(streamMs: number, end: (s: Awaited<ReturnType<typeof validFor>>) => void | Promise<void>) {
    make();
    controller.start();
    await fault(0);
    await advance(2000);
    await fault(1);
    await advance(2000);
    expect(controller.getSnapshot().phase).toBe("connecting"); // two faults: still recoverable
    const s = await validFor(2, streamMs);
    await end(s);
    await advance(2000);
    expect(calls).toHaveLength(4);
    const next = streamResponse();
    calls[3]?.respond(next.response);
    next.push(sse(snapshot(1)));
    await settle();
    next.push(sse(heartbeat(9))); // a stream_seq gap: the third fault
    await settle();
  }
  const normalClose = async (s: { end: () => void }) => {
    s.end();
    await settle();
  };

  it("the reviewed sequence: two faults, 75 s of valid streaming, a normal close, a new snapshot, another fault: not stopped", async () => {
    await twoFaultsThen(75000, normalClose);
    expect(controller.getSnapshot().phase).toBe("waiting");
    expect(controller.getSnapshot().stopReason).toBeNull();
  });

  it("exactly 60 s of valid streaming is enough to reset", async () => {
    await twoFaultsThen(60000, normalClose);
    expect(controller.getSnapshot().phase).toBe("waiting");
  });

  it("59 s is not: the third fault stops the stream for good", async () => {
    await twoFaultsThen(59000, normalClose);
    expect(controller.getSnapshot()).toMatchObject({ phase: "stopped", stopReason: "protocol_faults" });
  });

  it("the count really restarts: after the reset it takes three faults in all to stop", async () => {
    await twoFaultsThen(75000, normalClose);
    expect(controller.getSnapshot().phase).toBe("waiting"); // fault 1 of the new count
    await advance(2000);
    await fault(4); // 2 of 3
    expect(controller.getSnapshot().phase).toBe("waiting");
    await advance(2000);
    await fault(5); // 3 of 3
    expect(controller.getSnapshot()).toMatchObject({ phase: "stopped", stopReason: "protocol_faults" });
  });

  it("resets when the long connection ended in a network error", async () => {
    await twoFaultsThen(70000, async (s) => {
      s.fail();
      await settle();
    });
    expect(controller.getSnapshot().phase).toBe("waiting");
  });

  it("resets when the long connection ended because the browser went offline", async () => {
    make();
    controller.start();
    await fault(0);
    await advance(2000);
    await fault(1);
    await advance(2000);
    await validFor(2, 65000);
    onLine = false;
    fire(window, "offline");
    onLine = true;
    fire(window, "online"); // reconnects: calls[3]
    expect(calls).toHaveLength(4);
    const next = streamResponse();
    calls[3]?.respond(next.response);
    next.push(sse(snapshot(1)));
    next.push(sse(heartbeat(9)));
    await settle();
    expect(controller.getSnapshot().phase).toBe("waiting");
  });
});

describe("offline: no requests and no timers (F4)", () => {
  it("starts nothing while offline, and connects once when the online event fires", async () => {
    onLine = false;
    make();
    controller.start();
    expect(controller.getSnapshot().phase).toBe("offline");
    await advance(120000);
    expect(calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    onLine = true;
    fire(window, "online");
    expect(calls).toHaveLength(1);
    expect(controller.getSnapshot().phase).toBe("connecting");
  });

  it("Retry now is a no-op while offline: no request, no state change, no timer, however long it waits", async () => {
    onLine = false;
    make();
    controller.start();
    controller.retryNow();
    controller.retryNow();
    await advance(120000);
    expect(calls).toHaveLength(0);
    expect(controller.getSnapshot().phase).toBe("offline");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("Retry now from a stopped state while offline leaves it stopped, then works once online", async () => {
    make();
    controller.start();
    calls[0]?.respond(new Response("", { status: 404 }));
    await settle();
    onLine = false;
    controller.retryNow();
    expect(calls).toHaveLength(1);
    expect(controller.getSnapshot().phase).toBe("stopped");
    onLine = true;
    controller.retryNow();
    expect(calls).toHaveLength(2);
  });

  it("a failure while the browser reports offline sets no retry timer and waits for online", async () => {
    const s = await streaming();
    onLine = false; // no `offline` event reached us
    s.fail();
    await settle();
    expect(controller.getSnapshot().phase).toBe("offline");
    expect(vi.getTimerCount()).toBe(0);
    await advance(120000);
    expect(calls).toHaveLength(1);
    onLine = true;
    fire(window, "online");
    expect(calls).toHaveLength(2);
  });

  it("a reconnect timer that fires while offline starts nothing and leaves no timer", async () => {
    make();
    controller.start();
    calls[0]?.reject(new TypeError("down"));
    await settle();
    expect(controller.getSnapshot().phase).toBe("waiting");
    onLine = false; // the `offline` event was missed
    await advance(1000);
    expect(calls).toHaveLength(1);
    expect(controller.getSnapshot().phase).toBe("offline");
    expect(vi.getTimerCount()).toBe(0);
    await advance(120000);
    expect(calls).toHaveLength(1);
  });

  it("the offline event cancels a pending wait and every timer, and nothing repeats until online", async () => {
    make();
    controller.start();
    calls[0]?.reject(new TypeError("down"));
    await settle();
    onLine = false;
    fire(window, "offline");
    expect(vi.getTimerCount()).toBe(0);
    await advance(600000);
    expect(calls).toHaveLength(1);
    onLine = true;
    fire(window, "online");
    expect(calls).toHaveLength(2);
  });

  it("a 429 answer that arrives while offline does not schedule a retry either", async () => {
    make();
    controller.start();
    onLine = false;
    calls[0]?.respond(new Response("", { status: 429, headers: { "Retry-After": "5" } }));
    await settle();
    expect(controller.getSnapshot().phase).toBe("offline");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("non-ASCII events delivered as bytes (F1)", () => {
  const encode = (text: string) => new TextEncoder().encode(text);

  it("faults on an oversized multibyte message whose chunk boundary falls inside a character", async () => {
    make();
    controller.start();
    const s = streamResponse();
    calls[0]?.respond(s.response);
    const bytes = encode("event: snapshot\ndata: " + "€".repeat(22000) + "\n\n"); // about 66 KB, 22,000 UTF-16 units
    const cut = bytes.indexOf(0xe2) + 1; // after the first byte of a 3-byte character
    s.pushBytes(bytes.slice(0, cut));
    s.pushBytes(bytes.slice(cut, 40000));
    s.pushBytes(bytes.slice(40000));
    await settle();
    expect(controller.getSnapshot().phase).toBe("waiting");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("64 KiB"));
  });

  it("accepts a large multibyte message under the limit, split at every awkward place", async () => {
    make();
    controller.start();
    const s = streamResponse();
    calls[0]?.respond(s.response);
    const bytes = encode(sse({ ...snapshot(1), pad: "€é😀".repeat(5000) })); // about 45 KB
    for (let i = 0; i < bytes.length; i += 1013) s.pushBytes(bytes.slice(i, i + 1013)); // odd size: splits characters
    await settle();
    expect(controller.getSnapshot()).toMatchObject({ phase: "streaming" });
    expect(controller.getSnapshot().values).toHaveLength(4);
  });
});

describe("payload limit 65,536 bytes, buffer limit 131,072 bytes, and malformed UTF-8 (L-1)", () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const bytesOf = (o: object) => encode(JSON.stringify(o)).length;

  /** A snapshot whose JSON `data` payload is exactly `target` UTF-8 bytes: `pad` is `unit` repeated, then ASCII to fill. */
  function snapshotOfBytes(target: number, unit: string) {
    const empty = bytesOf({ ...snapshot(1), pad: "" });
    const room = target - empty;
    const unitLen = encode(unit).length;
    const pad = unit.repeat(Math.floor(room / unitLen)) + "x".repeat(room % unitLen);
    const message = { ...snapshot(1), pad };
    expect(bytesOf(message)).toBe(target);
    return message;
  }

  async function open() {
    make();
    controller.start();
    const s = streamResponse();
    calls[0]?.respond(s.response);
    return s;
  }

  it.each([
    ["ASCII", "x"],
    ["2-byte é", "é"],
    ["3-byte €", "€"],
    ["4-byte emoji", "😀"],
  ])("accepts a payload of exactly 65,536 bytes (%s pad) fed in 3-byte chunks that split characters", async (_n, unit) => {
    const s = await open();
    const bytes = encode(sse(snapshotOfBytes(65536, unit)));
    for (let i = 0; i < bytes.length; i += 3) s.pushBytes(bytes.slice(i, i + 3));
    await settle();
    expect(controller.getSnapshot()).toMatchObject({ phase: "streaming" });
    expect(controller.getSnapshot().values).toHaveLength(4);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["ASCII", "x"],
    ["2-byte é", "é"],
    ["3-byte €", "€"],
    ["4-byte emoji", "😀"],
  ])("faults on a payload of 65,537 bytes (%s pad) with a controlled protocol fault", async (_n, unit) => {
    const s = await open();
    s.pushBytes(encode(sse(snapshotOfBytes(65537, unit))));
    await settle();
    expect(controller.getSnapshot().phase).toBe("waiting");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("64 KiB"));
    expect(calls[0]?.signal.aborted).toBe(true);
  });

  it.each([
    ["ASCII", "x"],
    ["3-byte €", "€"],
  ])("accepts a payload of 65,535 bytes (%s pad), one under the limit", async (_n, unit) => {
    const s = await open();
    s.pushBytes(encode(sse(snapshotOfBytes(65535, unit))));
    await settle();
    expect(controller.getSnapshot()).toMatchObject({ phase: "streaming" });
    expect(controller.getSnapshot().values).toHaveLength(4);
    expect(warn).not.toHaveBeenCalled();
  });

  /** An unterminated comment line of exactly `total` UTF-8 bytes: ":" then `unit` repeated, then ASCII to fill. */
  function openLineOfBytes(total: number, unit: string) {
    const room = total - 1;
    const unitLen = encode(unit).length;
    const line = ":" + unit.repeat(Math.floor(room / unitLen)) + "c".repeat(room % unitLen);
    expect(encode(line).length).toBe(total);
    return encode(line);
  }

  it("accepts exactly 131,072 unterminated bytes without a fault, and the stream still works afterwards", async () => {
    const s = await open();
    s.pushBytes(openLineOfBytes(131072, "c"));
    await settle();
    expect(warn).not.toHaveBeenCalled();
    expect(calls[0]?.signal.aborted).toBe(false);
    s.push("\n" + sse(snapshot(1))); // ends the comment line, then a valid frame
    await settle();
    expect(controller.getSnapshot()).toMatchObject({ phase: "streaming" });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    [131072, false],
    [131073, true],
  ])("handles %i unterminated bytes fed in 3-byte chunks that split a multibyte character (fault: %s)", async (total, faults) => {
    const s = await open();
    const bytes = openLineOfBytes(total, "€"); // "€" starts at byte 1, so every 3-byte chunk boundary falls inside a character
    for (let i = 0; i < bytes.length; i += 3) s.pushBytes(bytes.slice(i, i + 3));
    await settle();
    if (faults) {
      expect(controller.getSnapshot().phase).toBe("waiting");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("128 KiB"));
    } else {
      expect(warn).not.toHaveBeenCalled();
    }
    expect(calls[0]?.signal.aborted).toBe(faults);
  });

  it("faults when the incomplete parser buffer passes 131,072 bytes even though no payload is near its limit", async () => {
    const s = await open();
    s.pushBytes(encode(":" + "c".repeat(131072))); // one unterminated comment line
    await settle();
    expect(controller.getSnapshot().phase).toBe("waiting");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("128 KiB"));
  });

  it("accepts several valid frames in one network chunk, though together they pass both limits", async () => {
    const s = await open();
    const pad = "p".repeat(50000);
    const chunk = sse({ ...snapshot(1), pad }) + sse({ ...update(2, makeValue("USD", "INR", 0, "fresh", "9.9")), pad }) + sse({ ...heartbeat(3), pad });
    expect(encode(chunk).length).toBeGreaterThan(131072);
    s.pushBytes(encode(chunk));
    await settle();
    expect(controller.getSnapshot()).toMatchObject({ phase: "streaming" });
    expect(controller.getSnapshot().values?.[3]?.rate).toBe("9.9");
    expect(warn).not.toHaveBeenCalled();
  });

  it("applies the valid frames of a chunk before it faults on an oversized one", async () => {
    const s = await open();
    s.pushBytes(encode(sse(snapshot(1)) + sse(update(2, makeValue("USD", "INR", 0, "fresh", "9.9"))) + sse(snapshotOfBytes(65537, "x"))));
    await settle();
    expect(controller.getSnapshot().phase).toBe("waiting");
    expect(controller.getSnapshot().values?.[3]?.rate).toBe("9.9"); // the first two were applied before the fault
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("64 KiB"));
  });

  it.each([
    ["a stray 0xFF byte", [0xff]],
    ["a bad continuation byte", [0xc3, 0x28]],
    ["an overlong encoding", [0xc0, 0xaf]],
    ["a lone continuation byte", [0x80]],
    ["an encoded surrogate", [0xed, 0xa0, 0x80]],
  ])("rejects %s inside a payload as a protocol fault, not a replacement character", async (_n, bad) => {
    const s = await open();
    const head = encode("event: snapshot\ndata: {\"a\":\"");
    const tail = encode("\"}\n\n");
    s.pushBytes(Uint8Array.from([...head, ...bad, ...tail]));
    await settle();
    expect(controller.getSnapshot().phase).toBe("waiting");
    expect(controller.getSnapshot().values).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("UTF-8"));
  });

  it("rejects malformed UTF-8 whose bad byte arrives in a later chunk than its lead byte", async () => {
    const s = await open();
    s.pushBytes(Uint8Array.from([...encode("data: x"), 0xe2])); // the lead byte of a 3-byte character
    s.pushBytes(Uint8Array.from([0x28, 0x0a, 0x0a])); // 0x28 is not a continuation byte
    await settle();
    expect(controller.getSnapshot().phase).toBe("waiting");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("UTF-8"));
  });

  it("raises a UTF-8 protocol fault when the stream ends inside a multibyte character", async () => {
    const s = await open();
    s.pushBytes(Uint8Array.from([...encode("data: x"), 0xe2, 0x82])); // the first two bytes of a 3-byte "€"
    await settle();
    expect(warn).not.toHaveBeenCalled(); // nothing is wrong until the stream ends
    s.end();
    await settle();
    expect(controller.getSnapshot().phase).toBe("waiting");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("UTF-8"));
  });

  it("does not call an incomplete SSE event of valid UTF-8 at EOF a UTF-8 fault", async () => {
    const s = await open();
    s.pushBytes(encode("event: snapshot\ndata: {\"a\":\"é€😀")); // complete characters, but no closing line
    s.end();
    await settle();
    expect(controller.getSnapshot().phase).toBe("waiting"); // the ordinary end of stream: reconnect
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts a multibyte character split across chunks and completed before EOF", async () => {
    const s = await open();
    const bytes = encode(sse({ ...snapshot(1), pad: "€😀" }));
    const cut = bytes.indexOf(0xf0) + 2; // inside the 4-byte emoji
    s.pushBytes(bytes.slice(0, cut));
    s.pushBytes(bytes.slice(cut));
    await settle();
    expect(controller.getSnapshot()).toMatchObject({ phase: "streaming" });
    s.end();
    await settle();
    expect(controller.getSnapshot().phase).toBe("waiting"); // the ordinary end of stream
    expect(controller.getSnapshot().values).toHaveLength(4);
    expect(warn).not.toHaveBeenCalled();
  });

  it("faults on malformed UTF-8 after a valid frame in the same chunk, drops that chunk, and recovers cleanly", async () => {
    const s = await open();
    s.pushBytes(Uint8Array.from([...encode(sse(snapshot(1))), 0xff])); // the fatal decoder rejects the whole chunk
    await settle();
    expect(controller.getSnapshot().phase).toBe("waiting");
    expect(controller.getSnapshot().values).toBeNull(); // documented: the valid frame in the bad chunk is not applied
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("UTF-8"));
    expect(calls[0]?.signal.aborted).toBe(true);
    await advance(1000); // the first backoff (1 s with random() = 1), then a clean second attempt
    expect(calls).toHaveLength(2);
    const next = streamResponse();
    calls[1]?.respond(next.response);
    next.push(sse(snapshot(1)));
    await settle();
    expect(controller.getSnapshot()).toMatchObject({ phase: "streaming" });
    expect(controller.getSnapshot().values).toHaveLength(4);
  });
});

describe("fault window: the documented interpretation (AD-1 §3.3 is ambiguous; this is the conservative reading)", () => {
  async function fault(index: number) {
    const s = streamResponse();
    calls[index]?.respond(s.response);
    s.push(sse(heartbeat(1)));
    await settle();
  }
  async function streamFor(index: number, ms: number) {
    const s = streamResponse();
    calls[index]?.respond(s.response);
    s.push(sse(snapshot(1)));
    await settle();
    for (let t = 0, n = 2; t < ms; t += 15000, n++) {
      await advance(Math.min(15000, ms - t));
      s.push(sse(heartbeat(n)));
      await settle();
    }
    s.end();
    await settle();
    await advance(2000);
  }

  it("never adds shorter runs together: two 40 s connections between faults do not clear the count", async () => {
    make();
    controller.start();
    await fault(0);
    await advance(2000);
    await fault(1);
    await advance(2000);
    await streamFor(2, 40000); // 40 s, then a normal close
    await streamFor(3, 40000); // another 40 s: 80 s in all, but never 60 s on one connection
    await fault(4);
    expect(controller.getSnapshot()).toMatchObject({ phase: "stopped", stopReason: "protocol_faults" });
  });

  it("counts protocol faults only: header timeouts, network errors and 5xx answers never stop the stream, however many", async () => {
    make();
    controller.start();
    for (let i = 0; i < 12; i++) {
      const index = calls.length - 1;
      if (i % 4 === 0) calls[index]?.reject(new TypeError("down")); // a network error
      else if (i % 4 === 1) calls[index]?.respond(new Response("", { status: 503, headers: { "Retry-After": "1" } }));
      else if (i % 4 === 2) calls[index]?.respond(new Response("", { status: 502 }));
      else await advance(2000); // no response headers in time
      await settle();
      await advance(2000);
      expect(controller.getSnapshot().phase).not.toBe("stopped");
    }
    expect(controller.getSnapshot().stopReason).toBeNull();
  });

  it("a run that starts the 60 s only at an accepted snapshot: a connection that never gets one clears nothing", async () => {
    make();
    controller.start();
    await fault(0);
    await advance(2000);
    await fault(1);
    await advance(2000);
    const open = streamResponse(); // headers arrive, then 70 s of nothing valid (comments only), then the next fault
    calls[2]?.respond(open.response);
    for (let i = 0; i < 7; i++) {
      await advance(10000);
      open.push(": keep-alive\n\n");
      await settle();
    }
    open.end();
    await settle();
    await advance(2000);
    await fault(3);
    expect(controller.getSnapshot()).toMatchObject({ phase: "stopped", stopReason: "protocol_faults" });
  });
});
