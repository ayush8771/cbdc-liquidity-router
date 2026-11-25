import { SseParser } from "./sseParser";
import {
  INITIAL_STATE,
  PAIRS,
  type ObservationState,
  type ObservationValue,
  type Profile,
  type StopReason,
} from "./types";
import { decodeMessage, type DecodedValue } from "./validate";

/*
 * The observation stream controller (AD-1 v0.5 §3.3, §3.3.1-§3.3.4).
 *
 * It owns one stream at a time. Everything that wants a connection *requests* one; a request is
 * idempotent (a no-op while an attempt is in flight, a stream is open, or a reconnect is pending),
 * and every abort bumps a generation counter so that bytes, errors or a 401 from a superseded
 * attempt are dropped unread. It holds no routing, transaction or auth state: the only thing it
 * is given from the session is `open`, the additive `openObservationStream` (§3.3.4).
 */

export const HEADER_TIMEOUT_MS = 2000;
export const SILENCE_TIMEOUT_MS = 35000;
/**
 * The fault window. AD-1 §3.3 and §3.3.2 say three protocol faults "without 60 s of valid streaming between them"
 * stop the stream; they do not define "valid streaming", say whether the 60 s must be continuous, or say how it is
 * measured. This client reads it conservatively:
 *  - Only protocol faults count (§3.3.3). A header timeout, silence, a network error, a 429 or a 5xx never does.
 *  - "Valid streaming" is one connection's time, on the monotonic clock, from its accepted snapshot to the moment the
 *    connection ends, whatever ends it. That run must be at least 60 s (>=) to clear the count.
 *  - It must be one connection: shorter runs on several connections are never added together.
 * Known limit of this reading: the run is timed to the end of the connection, not to its last valid message, so up to
 * 35 s of silence before the no-bytes abort can count as streaming. Timing to the last valid message would be stricter.
 * Both points are open questions for the AD-1 owner.
 */
export const FAULT_FREE_STREAMING_MS = 60000;
export const MAX_FAULTS = 3;
/** 1 s, then 2 s (the maximum), each multiplied by a random 0.5-1 (§3.3). */
export const BACKOFF_MS = [1000, 2000] as const;
export const RETRY_AFTER_DEFAULT_MS = 5000;
export const RETRY_AFTER_MIN_MS = 1000;
export const RETRY_AFTER_MAX_MS = 30000;

/**
 * `Retry-After` on a 429 or 503, as the client uses it (§3.3.2 table). Absent or unparseable
 * gives 5 s; zero, negative or a past date gives the 1 s floor; everything is clamped to 1-30 s.
 * An HTTP-date is measured against the response's `Date` header, or the local clock without one.
 */
export function retryAfterMs(value: string | null, dateHeader: string | null, wallNowMs: number): number {
  const clamp = (ms: number) => Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, ms));
  const text = value?.trim() ?? "";
  if (text === "") return RETRY_AFTER_DEFAULT_MS;
  if (/^[+-]?infinity$/i.test(text)) return text.startsWith("-") ? RETRY_AFTER_MIN_MS : RETRY_AFTER_MAX_MS;
  if (/^[+-]?\d+(\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (!Number.isFinite(seconds)) return RETRY_AFTER_MAX_MS;
    return seconds <= 0 ? RETRY_AFTER_MIN_MS : clamp(seconds * 1000);
  }
  if (/[A-Za-z]/.test(text)) {
    const target = Date.parse(text);
    if (Number.isFinite(target)) {
      const headerNow = dateHeader ? Date.parse(dateHeader) : NaN;
      const base = Number.isFinite(headerNow) ? headerNow : wallNowMs;
      return target - base <= 0 ? RETRY_AFTER_MIN_MS : clamp(target - base);
    }
  }
  return RETRY_AFTER_DEFAULT_MS;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export type ControllerDeps = {
  /** Issues the stream request with the session's token (AuthContext.openObservationStream). */
  open: (signal: AbortSignal) => Promise<Response>;
  /** Monotonic milliseconds. Defaults to `performance.now`. The wall clock is never used for ages. */
  now?: () => number;
  /** Wall clock, used only to read an HTTP-date `Retry-After` when the response has no `Date`. */
  wallNow?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  random?: () => number;
  doc?: Document;
  win?: Window;
  /** Receives a short reason for a fault or a withheld value. Never a payload or a token. */
  warn?: (message: string) => void;
};

export type ObservationController = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ObservationState;
  /** Monotonic now, on the same clock as the values' receipt times. */
  now(): number;
  /** Adds the listeners and requests the first connection. Idempotent. */
  start(): void;
  /** Aborts, removes every listener and resets the state. Idempotent. */
  stop(): void;
  /** Resets backoff, faults and any wait, then connects once. A no-op while an attempt is in flight, hidden or offline. */
  retryNow(): void;
};

export function createObservationController(deps: ControllerDeps): ObservationController {
  const now = deps.now ?? (() => performance.now());
  const wallNow = deps.wallNow ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
  const random = deps.random ?? Math.random;
  const doc = deps.doc ?? (typeof document !== "undefined" ? document : undefined);
  const win = deps.win ?? (typeof window !== "undefined" ? window : undefined);
  const warn = deps.warn ?? ((message: string) => console.warn(`[observations] ${message}`));

  let state: ObservationState = INITIAL_STATE;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<ObservationState>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };

  let started = false;
  let generation = 0;
  let abortController: AbortController | null = null;
  let headerTimer: TimerHandle | null = null;
  let silenceTimer: TimerHandle | null = null;
  let reconnectTimer: TimerHandle | null = null;
  let backoffIndex = 0;
  let faultCount = 0;
  /** Monotonic time of the current connection's first valid snapshot, for the 60 s fault window. */
  let validSince: number | null = null;

  const visible = () => doc === undefined || doc.visibilityState !== "hidden";
  const online = () => win === undefined || win.navigator.onLine !== false;

  function clearTimers() {
    if (headerTimer !== null) clearTimer(headerTimer);
    if (silenceTimer !== null) clearTimer(silenceTimer);
    if (reconnectTimer !== null) clearTimer(reconnectTimer);
    headerTimer = silenceTimer = reconnectTimer = null;
  }

  /** Idempotent: a second abort finds nothing to abort. Bumps the generation so late results are dropped. */
  function abortConnection() {
    // The connection (if any) is over. If it streamed validly for 60 s or more, the faults before it no
    // longer count (AD-1 §3.3: three faults "without 60 s of valid streaming between them"). This runs for
    // every way a connection ends: a close, an error, hidden, offline, unmount, or the next attempt.
    if (validSince !== null && now() - validSince >= FAULT_FREE_STREAMING_MS) faultCount = 0;
    validSince = null;
    generation += 1;
    abortController?.abort();
    abortController = null;
    clearTimers();
  }

  function discard(response: Response) {
    void response.body?.cancel().catch(() => {});
  }

  function backoffDelay(): number {
    const base = BACKOFF_MS[Math.min(backoffIndex, BACKOFF_MS.length - 1)] as number;
    backoffIndex += 1;
    return base * (0.5 + 0.5 * random());
  }

  /** A recoverable disconnect: reconnect after the backoff, or the longer `Retry-After` wait (§3.3.2). */
  function recoverableFailure(retryAfter: number | null = null, tooManyStreams = false) {
    abortConnection();
    if (!online()) {
      // Nothing is attempted while offline (AD-1 §3.3.1): no timer; the `online` event resumes.
      set({ phase: "offline", tooManyStreams: false });
      return;
    }
    let delay = backoffDelay();
    if (retryAfter !== null) delay = Math.min(RETRY_AFTER_MAX_MS, Math.max(retryAfter, delay));
    set({ phase: "waiting", tooManyStreams });
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      if (state.phase === "waiting") void connect();
    }, delay);
  }

  /** A permanent stopped state: no timer, no backoff, no automatic trigger leaves it (§3.3.2). */
  function stopPermanently(reason: StopReason) {
    abortConnection();
    set({ phase: "stopped", stopReason: reason, tooManyStreams: false });
  }

  function protocolFault(reason: string) {
    warn(`protocol fault: ${reason}`);
    const t = now();
    if (validSince !== null && t - validSince >= FAULT_FREE_STREAMING_MS) faultCount = 0;
    validSince = null;
    faultCount += 1;
    if (faultCount >= MAX_FAULTS) stopPermanently("protocol_faults");
    else recoverableFailure();
  }

  function stamp(v: DecodedValue, t: number): ObservationValue {
    return { base: v.base, quote: v.quote, rate: v.rate, sourceId: v.sourceId, ageAtReceiptMs: v.ageMs, receivedAtMs: t, unavailable: v.unavailable };
  }

  async function connect() {
    abortConnection();
    if (!online()) {
      if (state.phase !== "stopped") set({ phase: "offline", tooManyStreams: false });
      return;
    }
    const gen = generation;
    const controller = new AbortController();
    abortController = controller;
    set({ phase: "connecting", stopReason: null });
    headerTimer = setTimer(() => {
      headerTimer = null;
      if (gen === generation) recoverableFailure(); // no response headers in time (not a protocol fault)
    }, HEADER_TIMEOUT_MS);

    let response: Response;
    try {
      response = await deps.open(controller.signal);
    } catch {
      if (gen === generation) recoverableFailure();
      return;
    }
    if (gen !== generation) {
      discard(response); // a superseded attempt: dropped unread
      return;
    }
    if (headerTimer !== null) clearTimer(headerTimer);
    headerTimer = null;
    await handleResponse(gen, response);
  }

  async function handleResponse(gen: number, response: Response) {
    const { status } = response;
    if (status !== 200) {
      discard(response);
      if (status === 401) return stopPermanently("unauthenticated");
      if (status === 429 || status === 503) {
        const wait = retryAfterMs(response.headers.get("Retry-After"), response.headers.get("Date"), wallNow());
        return recoverableFailure(wait, status === 429);
      }
      if (status >= 500) return recoverableFailure();
      if (status >= 400) return stopPermanently("unavailable");
      return protocolFault(`unexpected status ${status}`);
    }
    if (!(response.headers.get("Content-Type") ?? "").toLowerCase().startsWith("text/event-stream")) {
      discard(response);
      return protocolFault("the response is not an event stream");
    }
    if (!response.body) return protocolFault("the response has no body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    const parser = new SseParser();
    let lastSeq = 0;
    let connProfile: Profile | null = null;

    const armSilence = () => {
      if (silenceTimer !== null) clearTimer(silenceTimer);
      silenceTimer = setTimer(() => {
        silenceTimer = null;
        if (gen === generation) recoverableFailure(); // no bytes (comments count) for 35 s
      }, SILENCE_TIMEOUT_MS);
    };
    armSilence();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (gen !== generation) return;
        if (done) break;
        armSilence();
        const { events, overflow } = parser.feed(decoder.decode(value, { stream: true }));
        for (const event of events) {
          const decoded = decodeMessage(event.event, event.data, { lastSeq, profile: connProfile });
          if (decoded.kind === "fault") return protocolFault(decoded.reason);
          if (decoded.kind === "stop") return stopPermanently(decoded.reason);
          lastSeq = decoded.seq;
          const t = now();
          if (decoded.kind === "snapshot") {
            connProfile = decoded.profile;
            validSince = t;
            backoffIndex = 0;
            const withheld = decoded.values.filter((v) => v.withheld).length;
            if (withheld > 0) warn(`${withheld} value(s) withheld by the per-value checks`);
            set({
              phase: "streaming",
              tooManyStreams: false,
              source: decoded.source,
              profile: decoded.profile,
              values: decoded.values.map((v) => stamp(v, t)),
              withheld: state.withheld + withheld,
            });
          } else if (decoded.kind === "update") {
            if (decoded.value.withheld) warn("a value was withheld by the per-value checks");
            const index = PAIRS.findIndex((p) => p.base === decoded.value.base && p.quote === decoded.value.quote);
            const values = (state.values ?? []).map((v, i) => (i === index ? stamp(decoded.value, t) : v));
            set({ source: decoded.source, values, withheld: state.withheld + (decoded.value.withheld ? 1 : 0) });
          } else if (decoded.kind === "heartbeat") {
            set({ source: decoded.source });
          }
          if (gen !== generation) return;
        }
        if (overflow) return protocolFault("a message or buffer exceeded 64 KiB");
      }
    } catch {
      if (gen === generation) recoverableFailure();
      return;
    }
    // A normal end of the stream: any partial event is discarded, never parsed.
    if (gen === generation) recoverableFailure();
  }

  /** Every trigger asks here; none opens a stream directly (§3.3.1 "One connection, one snapshot"). */
  function requestConnect() {
    if (!started) return;
    if (state.phase === "connecting" || state.phase === "streaming" || state.phase === "waiting" || state.phase === "stopped") return;
    if (!visible() || !online()) return;
    void connect();
  }

  function dropDisplayed() {
    set({ values: null, profile: null, source: null });
  }

  function resetCounters() {
    backoffIndex = 0;
    faultCount = 0;
    validSince = null;
  }

  /** hidden, pagehide, freeze, beforeunload: abort at once and release the slot. */
  function pause() {
    abortConnection();
    if (state.phase !== "stopped") set({ phase: "paused", tooManyStreams: false });
  }

  const onVisibility = () => {
    if (!doc) return;
    if (doc.visibilityState === "hidden") return pause();
    if (state.phase === "stopped" || state.phase === "connecting" || state.phase === "streaming" || state.phase === "waiting") return;
    if (!online()) {
      abortConnection();
      set({ phase: "offline" });
      return;
    }
    resetCounters();
    dropDisplayed();
    requestConnect();
  };

  const onPageShow = (event: Event) => {
    if (!(event as PageTransitionEvent).persisted) return;
    abortConnection(); // any stream handle from before the restore is discarded unread
    if (state.phase === "stopped") return;
    set({ phase: "idle" });
    resetCounters();
    dropDisplayed();
    if (!visible()) set({ phase: "paused" });
    else if (!online()) set({ phase: "offline" });
    else requestConnect();
  };

  const onOffline = () => {
    abortConnection();
    if (state.phase !== "stopped") set({ phase: "offline", tooManyStreams: false });
  };

  const onOnline = () => {
    if (state.phase === "offline") {
      set({ phase: "idle" });
      if (!visible()) set({ phase: "paused" });
      else requestConnect();
    }
  };

  const docEvents: Array<[string, EventListener]> = [
    ["visibilitychange", onVisibility],
    ["freeze", pause],
  ];
  const winEvents: Array<[string, EventListener]> = [
    ["pagehide", pause],
    ["beforeunload", pause],
    ["pageshow", onPageShow],
    ["offline", onOffline],
    ["online", onOnline],
  ];

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    now,
    start() {
      if (started) return;
      started = true;
      for (const [name, fn] of docEvents) doc?.addEventListener(name, fn);
      for (const [name, fn] of winEvents) win?.addEventListener(name, fn);
      if (!visible()) set({ phase: "paused" });
      else if (!online()) set({ phase: "offline" });
      else void connect();
    },
    stop() {
      if (!started) return;
      started = false;
      abortConnection();
      for (const [name, fn] of docEvents) doc?.removeEventListener(name, fn);
      for (const [name, fn] of winEvents) win?.removeEventListener(name, fn);
      resetCounters();
      set({ ...INITIAL_STATE });
    },
    retryNow() {
      if (!started || state.phase === "connecting" || !visible() || !online()) return;
      abortConnection();
      resetCounters();
      void connect();
    },
  };
}
