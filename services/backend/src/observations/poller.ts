import http from "node:http";
import type { Logger } from "../logger.js";
import {
  INGESTION_PATH,
  OUTAGE_AFTER_FAILURES,
  OUTAGE_AFTER_MS,
  POLL_CONTRACT_FAULT_DELAY_MS,
  POLL_DEADLINE_MS,
  POLL_INTERVAL_MS,
  POLL_MAX_BODY_BYTES,
  POLL_RETRY_AFTER_DEFAULT_MS,
  POLL_RETRY_AFTER_MAX_MS,
  POLL_RETRY_AFTER_MIN_MS,
  type SourceStatus,
} from "./constants.js";
import { parseLatestResponse } from "./latestResponse.js";
import type { ApplyResult, ObservationStore } from "./store.js";

// Express as a client of ingestion's `GET /v1/latest` (AD-1 v0.5 §3.1).
// - One poll in flight: the next is scheduled only when the last has settled.
// - 400 ms deadline for the whole exchange; body <= 64 KiB, counted while
//   reading; no redirects (node:http never follows them); no credentials.
// - No poll result refreshes a value's age: only an accepted event changes
//   state, and its age comes from its own source_timestamp.
// - stop() cancels the timer and aborts the request in flight.

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** A raw HTTP answer, or a failure before one was complete. */
export type FetchOutcome =
  | { kind: "response"; status: number; contentType: string | undefined; retryAfter: string | undefined; body: Buffer }
  | { kind: "timeout" | "network" | "too_large" | "aborted" };

export type FetchLatest = (signal: AbortSignal) => Promise<FetchOutcome>;

/** The real HTTP fetch, with the deadline and the size cap. */
export function createHttpFetch(
  baseUrl: string,
  options: { deadlineMs?: number; maxBodyBytes?: number } = {},
): { fetch: FetchLatest; close: () => void } {
  const deadlineMs = options.deadlineMs ?? POLL_DEADLINE_MS;
  const maxBodyBytes = options.maxBodyBytes ?? POLL_MAX_BODY_BYTES;
  const url = new URL(INGESTION_PATH, `${baseUrl.replace(/\/+$/, "")}/`);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

  const fetch: FetchLatest = (signal) =>
    new Promise<FetchOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: FetchOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const req = http.request(url, {
        method: "GET",
        agent,
        headers: { Accept: "application/json" },
      });
      const timer = setTimeout(() => {
        finish({ kind: "timeout" });
        req.destroy();
      }, deadlineMs);
      const onAbort = () => {
        finish({ kind: "aborted" });
        req.destroy();
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });

      req.on("error", () => finish({ kind: "network" }));
      req.on("response", (res) => {
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBodyBytes) {
          finish({ kind: "too_large" });
          req.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBodyBytes) {
            finish({ kind: "too_large" });
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", () => finish({ kind: "network" }));
        res.on("aborted", () => finish({ kind: "network" }));
        res.on("end", () => {
          const retryAfter = res.headers["retry-after"];
          finish({
            kind: "response",
            status: res.statusCode ?? 0,
            contentType: res.headers["content-type"],
            retryAfter: Array.isArray(retryAfter) ? retryAfter[0] : retryAfter,
            body: Buffer.concat(chunks),
          });
        });
      });
      req.end();
    });

  return { fetch, close: () => agent.destroy() };
}

/** §3.1: Retry-After in whole seconds, limited to 1–30 s; 5 s if absent or invalid. */
export function retryAfterDelayMs(value: string | undefined): number {
  const text = value?.trim();
  if (text === undefined || !/^\d+$/.test(text)) return POLL_RETRY_AFTER_DEFAULT_MS;
  const ms = Number(text) * 1000;
  return Math.min(POLL_RETRY_AFTER_MAX_MS, Math.max(POLL_RETRY_AFTER_MIN_MS, ms));
}

/** What a poll's outcome means for the schedule. */
export type PollVerdict = { ok: true; events: unknown[] } | { ok: false; reason: string; delayMs: number };

export function classify(outcome: FetchOutcome): PollVerdict {
  if (outcome.kind !== "response") return { ok: false, reason: outcome.kind, delayMs: POLL_INTERVAL_MS };
  const { status } = outcome;
  if (status === 429) return { ok: false, reason: "http_429", delayMs: retryAfterDelayMs(outcome.retryAfter) };
  if (status >= 500) return { ok: false, reason: "http_5xx", delayMs: POLL_INTERVAL_MS };
  // 3xx, 401, 403 and every other 4xx: a contract fault.
  if (status >= 300) return { ok: false, reason: "contract_fault", delayMs: POLL_CONTRACT_FAULT_DELAY_MS };
  if (status !== 200) return { ok: false, reason: "bad_response", delayMs: POLL_INTERVAL_MS };

  const contentType = outcome.contentType?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return { ok: false, reason: "content_type", delayMs: POLL_INTERVAL_MS };
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(outcome.body));
  } catch {
    return { ok: false, reason: "invalid_json", delayMs: POLL_INTERVAL_MS };
  }
  const parsed = parseLatestResponse(body);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, delayMs: POLL_INTERVAL_MS };
  return { ok: true, events: parsed.events };
}

export interface Poller {
  start(): void;
  /** Idempotent: cancels the timer and aborts the request in flight. */
  stop(): void;
  status(): SourceStatus;
  /** Polls currently in flight; never more than 1. */
  inFlight(): number;
}

export interface PollerOptions {
  fetch: FetchLatest;
  store: ObservationStore;
  logger: Logger;
  clock?: Clock;
  /** Called once per accepted (newer) event. */
  onUpdate?: (result: Extract<ApplyResult, { kind: "update" }>) => void;
  /** Called on every source-status change. */
  onStatus?: (status: SourceStatus) => void;
}

export function createPoller(options: PollerOptions): Poller {
  const { fetch, store, logger } = options;
  const clock = options.clock ?? systemClock;
  let status: SourceStatus = "starting";
  let running = false;
  let stopped = false;
  let pollTimer: unknown;
  let outageTimer: unknown;
  let controller: AbortController | undefined;
  let consecutiveFailures = 0;
  let inFlight = 0;
  let lastFailureReason: string | undefined;

  const setStatus = (next: SourceStatus) => {
    if (next === status) return;
    status = next;
    logger.info("observation source status", { status: next });
    options.onStatus?.(next);
  };

  // 2 s without a success, from start or from the last success.
  const armOutageTimer = () => {
    if (outageTimer !== undefined) clock.clearTimeout(outageTimer);
    outageTimer = clock.setTimeout(() => {
      outageTimer = undefined;
      if (!stopped) setStatus("outage");
    }, OUTAGE_AFTER_MS);
  };

  const schedule = (delayMs: number) => {
    if (stopped) return;
    pollTimer = clock.setTimeout(() => {
      pollTimer = undefined;
      void poll();
    }, delayMs);
  };

  async function poll(): Promise<void> {
    if (stopped || inFlight > 0) return;
    inFlight += 1;
    const startedAt = clock.now();
    controller = new AbortController();
    let outcome: FetchOutcome;
    try {
      outcome = await fetch(controller.signal);
    } catch {
      outcome = { kind: "network" };
    } finally {
      inFlight -= 1;
      controller = undefined;
    }
    if (stopped) return;

    const verdict = classify(outcome);
    if (verdict.ok) {
      const receivedAt = clock.now();
      for (const raw of verdict.events) {
        const result = store.ingest(raw, receivedAt);
        if (result.kind === "update") options.onUpdate?.(result);
      }
      consecutiveFailures = 0;
      lastFailureReason = undefined;
      armOutageTimer();
      setStatus("ok");
      schedule(Math.max(0, POLL_INTERVAL_MS - (clock.now() - startedAt)));
      return;
    }

    consecutiveFailures += 1;
    // One log line per change of failure reason, never a body or header.
    if (verdict.reason !== lastFailureReason) {
      logger.warn("observation poll failed", { reason: verdict.reason });
      lastFailureReason = verdict.reason;
    }
    if (consecutiveFailures >= OUTAGE_AFTER_FAILURES) setStatus("outage");
    const delay =
      verdict.delayMs === POLL_INTERVAL_MS ? Math.max(0, POLL_INTERVAL_MS - (clock.now() - startedAt)) : verdict.delayMs;
    schedule(delay);
  }

  return {
    start() {
      if (running || stopped) return;
      running = true;
      armOutageTimer();
      void poll();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (pollTimer !== undefined) clock.clearTimeout(pollTimer);
      if (outageTimer !== undefined) clock.clearTimeout(outageTimer);
      pollTimer = undefined;
      outageTimer = undefined;
      controller?.abort();
    },
    status: () => status,
    inFlight: () => inFlight,
  };
}
