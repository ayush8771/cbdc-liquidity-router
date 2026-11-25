import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { payloadSha256 } from "../../src/observations/canonical.js";
import type { Clock } from "../../src/observations/poller.js";

// Test-only helpers for the D-24 observation module: an envelope factory, a
// manual clock, a fake stream sink, a controllable fake ingestion server and
// an SSE reader. None of this is in the runtime image (Dockerfile copies src/
// only into the runtime stages).
//
// These fixtures are local to the backend tests. They are NOT the shared
// cross-language fixtures of AD-1 §3.7 (contracts/test-vectors/
// event_payload_hash.v1.json), which Dev A has not yet delivered.

let counter = 0;

/** A UUID matching the AD-4 pattern (version 5, variant 8). */
export function uuid(n: number = ++counter): string {
  const hex = n.toString(16).padStart(12, "0");
  return `00000000-0000-5000-8000-${hex}`;
}

export interface EventOptions {
  base?: string;
  quote?: string;
  rate?: string;
  sourceTimestamp?: string | null;
  retrievedAt?: string;
  emittedAt?: string;
  eventId?: string;
  status?: "validated" | "quarantined";
  reasons?: string[];
  sequence?: string | null;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A valid synthetic fx_rate envelope (AD-4 §10 shape) with a correct hash. */
export function makeEvent(options: EventOptions = {}): Record<string, unknown> {
  const base = options.base ?? "USD";
  const quote = options.quote ?? "INR";
  const payload = { base_currency: base, quote_currency: quote, rate: options.rate ?? "1.2345", rate_type: "mid" };
  const sourceTimestamp = options.sourceTimestamp === undefined ? "2026-11-24T10:00:00.000Z" : options.sourceTimestamp;
  const status = options.status ?? "validated";
  return {
    schema_version: "1.0",
    event_id: options.eventId ?? uuid(),
    event_type: "fx_rate",
    usage: "display_only",
    source: { source_id: "synthetic.fx", transport: "synthetic", source_url: null, gate3_decision_ref: null },
    provenance_class: "synthetic",
    derived_from: [],
    derivation: null,
    timestamps: {
      source_timestamp: sourceTimestamp,
      source_timestamp_basis: sourceTimestamp === null ? "none" : "observed",
      retrieved_at: options.retrievedAt ?? "2026-11-24T10:00:00.050Z",
      emitted_at: options.emittedAt ?? "2026-11-24T10:00:00.060Z",
    },
    source_sequence: options.sequence === undefined ? "1" : options.sequence,
    payload,
    payload_sha256: payloadSha256("fx_rate", payload),
    raw_sha256: null,
    validation: { status, reasons: options.reasons ?? (status === "quarantined" ? ["FUTURE_SOURCE_TIMESTAMP"] : []) },
    extraction: null,
    review: null,
    supersedes: null,
    synthetic: { generator_version: "0.0.0-test", seed: 1, case_id: "normal" },
  };
}

/** An event whose source/retrieved/emitted timestamps are all `ms`. */
export function eventAt(ms: number, options: EventOptions = {}): Record<string, unknown> {
  return makeEvent({ sourceTimestamp: iso(ms), retrievedAt: iso(ms), emittedAt: iso(ms), ...options });
}

export function latestBody(events: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol_version: "1.0",
    instance_id: "11111111-1111-4111-8111-111111111111",
    source_id: "synthetic.fx",
    generated_at: "2026-11-24T10:00:00.100Z",
    events,
    ...overrides,
  };
}

/** A manual clock: timers fire only on advance(). */
export class FakeClock implements Clock {
  private time: number;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  constructor(start = Date.parse("2026-11-24T10:00:00.000Z")) {
    this.time = start;
  }
  now(): number {
    return this.time;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  pending(): number {
    return this.timers.size;
  }
  /** Moves time forward, firing due timers in order. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.timers) if (entry[1].at <= end && (next === undefined || entry[1].at < next[1].at)) next = entry;
      if (next === undefined) break;
      this.timers.delete(next[0]);
      this.time = Math.max(this.time, next[1].at);
      next[1].fn();
    }
    this.time = end;
  }
  set(ms: number): void {
    this.time = ms;
  }
}

/** A sink that records writes; `full` makes write() report a full buffer. */
export class FakeSink extends EventEmitter {
  readonly writes: string[] = [];
  full = false;
  ended = false;
  destroyed = false;
  write(chunk: string): boolean {
    if (this.destroyed) throw new Error("write after destroy");
    // A real ServerResponse emits ERR_STREAM_WRITE_AFTER_END, uncaught without
    // an error listener (verified on Node 20.20.2), so the fake fails loudly.
    if (this.ended) throw new Error("write after end");
    this.writes.push(chunk);
    return !this.full;
  }
  end(): void {
    this.ended = true;
  }
  destroy(): void {
    this.destroyed = true;
  }
  messages(): Array<{ event: string; data: Record<string, unknown> }> {
    return this.writes.map(parseSseMessage);
  }
}

export function parseSseMessage(text: string): { event: string; data: Record<string, unknown> } {
  const lines = text.replace(/\n\n$/, "").split("\n");
  const event = lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "";
  const dataLines = lines.filter((l) => l.startsWith("data: "));
  if (dataLines.length !== 1) throw new Error(`expected one data line, got ${dataLines.length}`);
  return { event, data: JSON.parse(dataLines[0]!.slice(6)) as Record<string, unknown> };
}

export type FakeIngestionHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** A controllable fake ingestion server on loopback. */
export async function startFakeIngestion(handler: FakeIngestionHandler): Promise<{
  url: string;
  requests: () => number;
  maxConcurrent: () => number;
  setHandler: (h: FakeIngestionHandler) => void;
  close: () => Promise<void>;
}> {
  let current = handler;
  let requests = 0;
  let active = 0;
  let maxConcurrent = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    active += 1;
    maxConcurrent = Math.max(maxConcurrent, active);
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        active -= 1;
      }
    };
    res.on("close", finish);
    current(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => requests,
    maxConcurrent: () => maxConcurrent,
    setHandler: (h) => (current = h),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(text);
}

/** Opens the SSE stream with fetch and collects parsed messages. */
export async function openStream(
  url: string,
  token: string | undefined,
  options: { method?: string; signal?: AbortSignal } = {},
): Promise<{
  response: Response;
  messages: Array<{ event: string; data: Record<string, unknown> }>;
  next: (count?: number, timeoutMs?: number) => Promise<void>;
  ended: Promise<void>;
  abort: () => void;
}> {
  const controller = new AbortController();
  options.signal?.addEventListener("abort", () => controller.abort());
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { method: options.method ?? "GET", headers, signal: controller.signal });
  const messages: Array<{ event: string; data: Record<string, unknown> }> = [];
  const waiters: Array<() => void> = [];
  let ended: Promise<void> = Promise.resolve();
  if (response.ok && response.body !== null) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    ended = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index: number;
          while ((index = buffer.indexOf("\n\n")) !== -1) {
            messages.push(parseSseMessage(buffer.slice(0, index + 2)));
            buffer = buffer.slice(index + 2);
            for (const w of waiters.splice(0)) w();
          }
        }
      } catch {
        // aborted
      }
      for (const w of waiters.splice(0)) w();
    })();
  }
  return {
    response,
    messages,
    ended,
    abort: () => controller.abort(),
    async next(count = 1, timeoutMs = 3000) {
      const target = messages.length + count;
      const deadline = Date.now() + timeoutMs;
      while (messages.length < target) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} message(s)`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 50);
        });
      }
    },
  };
}

/** Polls a condition until true (real time), for asynchronous cleanup. */
export async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
