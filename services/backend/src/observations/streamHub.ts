import type { Logger } from "../logger.js";
import {
  DRAIN_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  MAX_MESSAGE_BYTES,
  MAX_STREAMS_PER_USER,
  MAX_STREAMS_TOTAL,
  PAIR_KEYS,
  PROFILE,
  PROTOCOL_VERSION,
  SHUTDOWN_DESTROY_AFTER_MS,
  SOURCE_ID,
  type SourceProfile,
  type SourceStatus,
} from "./constants.js";
import type { FxEnvelope } from "./envelope.js";
import { assertServableProfile, evaluateAll, evaluateValue, formatServerTime } from "./freshness.js";
import { systemClock, type Clock } from "./poller.js";

// SSE connections for `GET /api/rt/v1/observations/stream` (AD-1 v0.5 §3.2,
// §3.5). Messages are built when written, so `stream_seq`, `server_time` and
// every age are computed at write time, once per message.
//
// - Limits: 3 streams per user, 20 in total. Check and reservation are one
//   synchronous step; a new stream never evicts an old one.
// - A slot is released exactly once, on the first of close, error or shutdown.
// - Backpressure: when a write reports a full buffer, at most one pending
//   update per pair and one pending heartbeat are kept (newest wins: an update
//   is rebuilt from the current event at write) and written on `drain`. No
//   drain within 10 s destroys the stream. The poller never waits on a stream.
// - Cleanup removes listeners and timers and drops pending data.
// - Logs carry a connection number, user ID and reason only: no token, header
//   or payload.

/** What a connection writes to: a ServerResponse in production. */
export interface StreamSink {
  write(chunk: string): boolean;
  end(): void;
  destroy(): void;
  on(event: "drain" | "close" | "error", listener: (...args: unknown[]) => void): unknown;
  off(event: "drain" | "close" | "error", listener: (...args: unknown[]) => void): unknown;
}

export interface Slot {
  readonly userId: string;
  /** Idempotent; true only on the call that actually released it. */
  release(): boolean;
}

export type ReserveResult = { ok: true; slot: Slot } | { ok: false; reason: "limit" | "shutting_down" };

export interface StreamHub {
  reserve(userId: string): ReserveResult;
  /** Writes the snapshot and keeps the stream open. The slot belongs to the stream from here. */
  open(slot: Slot, sink: StreamSink, meta?: { requestId?: string }): void;
  /** One `update` to every stream, for the pair's current event. */
  publishUpdate(base: string, quote: string): void;
  /** One immediate `heartbeat` to every stream (source status change). */
  publishHeartbeat(): void;
  /** First shutdown step (§3.5): refuse new streams (503) from now on. Idempotent. */
  refuseNew(): void;
  /** Refuse new streams (if not already), end all, destroy any left after 1 s. */
  shutdown(): Promise<void>;
  isShuttingDown(): boolean;
  stats(): { total: number; byUser: Record<string, number>; reserved: number };
}

export interface StreamHubOptions {
  lookup: (base: string, quote: string) => FxEnvelope | undefined;
  sourceStatus: () => SourceStatus;
  logger: Logger;
  clock?: Clock;
  profile?: SourceProfile;
  limits?: { perUser?: number; total?: number };
  timings?: { heartbeatMs?: number; drainTimeoutMs?: number; shutdownDestroyMs?: number };
}

type MessageType = "snapshot" | "update" | "heartbeat";

/**
 * One SSE frame, or undefined when its `data:` JSON exceeds the §3.2 limit
 * of 64 KiB, measured in UTF-8 bytes. Exactly MAX_MESSAGE_BYTES is allowed.
 */
export function encodeFrame(type: string, json: string): string | undefined {
  if (Buffer.byteLength(json, "utf8") > MAX_MESSAGE_BYTES) return undefined;
  return `event: ${type}\ndata: ${json}\n\n`;
}

export function createStreamHub(options: StreamHubOptions): StreamHub {
  const { lookup, sourceStatus, logger } = options;
  const clock = options.clock ?? systemClock;
  const profile = options.profile ?? PROFILE;
  // Express refuses to serve a stream whose profile has no positive
  // withdrawal threshold (§3.2): fail at construction, before any stream.
  assertServableProfile(profile);
  const perUser = options.limits?.perUser ?? MAX_STREAMS_PER_USER;
  const total = options.limits?.total ?? MAX_STREAMS_TOTAL;
  const heartbeatMs = options.timings?.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
  const drainTimeoutMs = options.timings?.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
  const shutdownDestroyMs = options.timings?.shutdownDestroyMs ?? SHUTDOWN_DESTROY_AFTER_MS;

  // Reserved slots, open or not yet opened.
  const reservedByUser = new Map<string, number>();
  let reservedTotal = 0;
  const connections = new Set<Connection>();
  let shuttingDown = false;
  let ended = false;
  let nextConnectionId = 1;

  function reserve(userId: string): ReserveResult {
    if (shuttingDown) return { ok: false, reason: "shutting_down" };
    const mine = reservedByUser.get(userId) ?? 0;
    if (reservedTotal >= total || mine >= perUser) return { ok: false, reason: "limit" };
    reservedByUser.set(userId, mine + 1);
    reservedTotal += 1;
    let released = false;
    return {
      ok: true,
      slot: {
        userId,
        release() {
          if (released) return false;
          released = true;
          reservedTotal -= 1;
          const left = (reservedByUser.get(userId) ?? 1) - 1;
          if (left > 0) reservedByUser.set(userId, left);
          else reservedByUser.delete(userId);
          return true;
        },
      },
    };
  }

  function buildMessage(type: MessageType, seq: number, pair?: string): string | undefined {
    const now = clock.now();
    const message: Record<string, unknown> = {
      protocol_version: PROTOCOL_VERSION,
      type,
      stream_seq: seq,
      server_time: formatServerTime(now),
      source: { source_id: SOURCE_ID, status: sourceStatus() },
    };
    if (type === "snapshot") {
      message.profile = { ...profile };
      // Same profile as the one advertised above and used for updates (L-2).
      message.values = evaluateAll(lookup, now, profile);
    } else if (type === "update" && pair !== undefined) {
      const [base, quote] = pair.split("/") as [string, string];
      message.value = evaluateValue(base, quote, lookup(base, quote), now, profile);
    }
    return encodeFrame(type, JSON.stringify(message));
  }

  class Connection {
    readonly id = nextConnectionId++;
    private seq = 0;
    private closed = false;
    private blocked = false;
    private readonly pendingPairs = new Set<string>();
    private pendingHeartbeat = false;
    private heartbeatTimer: unknown;
    private drainTimer: unknown;
    readonly done: Promise<void>;
    private finished = false;
    private resolveDoneOnce!: () => void;

    constructor(
      private readonly slot: Slot,
      private readonly sink: StreamSink,
      private readonly requestId: string | undefined,
    ) {
      this.done = new Promise((resolve) => (this.resolveDoneOnce = resolve));
      this.onDrain = this.onDrain.bind(this);
      this.onClose = this.onClose.bind(this);
      this.onError = this.onError.bind(this);
      sink.on("drain", this.onDrain);
      sink.on("close", this.onClose);
      sink.on("error", this.onError);
    }

    start(): void {
      logger.info("observation stream opened", {
        connection: this.id,
        userId: this.slot.userId,
        requestId: this.requestId,
      });
      this.send("snapshot");
      this.armHeartbeat();
    }

    send(type: MessageType, pair?: string): void {
      if (this.closed) return;
      if (this.blocked) {
        if (type === "update" && pair !== undefined) this.pendingPairs.add(pair);
        else if (type === "heartbeat") this.pendingHeartbeat = true;
        return;
      }
      this.writeNow(type, pair);
    }

    private writeNow(type: MessageType, pair?: string): void {
      this.seq += 1;
      const text = buildMessage(type, this.seq, pair);
      if (text === undefined) {
        // Cannot happen with validated envelopes; never send an oversized event.
        this.close("message_too_large", true);
        return;
      }
      let ok: boolean;
      try {
        ok = this.sink.write(text);
      } catch {
        this.close("write_error", true);
        return;
      }
      if (!ok && !this.closed) {
        this.blocked = true;
        this.drainTimer = clock.setTimeout(() => {
          this.drainTimer = undefined;
          this.close("drain_timeout", true);
        }, drainTimeoutMs);
      }
    }

    private onDrain(): void {
      if (this.closed || !this.blocked) return;
      this.blocked = false;
      if (this.drainTimer !== undefined) clock.clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
      for (const pair of PAIR_KEYS) {
        if (this.blocked || this.closed) return;
        if (!this.pendingPairs.delete(pair)) continue;
        this.writeNow("update", pair);
      }
      if (!this.blocked && !this.closed && this.pendingHeartbeat) {
        this.pendingHeartbeat = false;
        this.writeNow("heartbeat");
      }
    }

    private armHeartbeat(): void {
      this.heartbeatTimer = clock.setTimeout(() => {
        this.heartbeatTimer = undefined;
        if (this.closed) return;
        this.send("heartbeat");
        this.armHeartbeat();
      }, heartbeatMs);
    }

    private onClose(): void {
      this.close("client_closed", false);
      this.resolveDone();
    }

    private onError(): void {
      this.close("error", true);
    }

    /** Idempotent. Releases the slot, clears timers, drops pending data. */
    close(reason: string, destroy: boolean): void {
      if (this.closed) return;
      this.closed = true;
      this.slot.release();
      connections.delete(this);
      if (this.heartbeatTimer !== undefined) clock.clearTimeout(this.heartbeatTimer);
      if (this.drainTimer !== undefined) clock.clearTimeout(this.drainTimer);
      this.heartbeatTimer = undefined;
      this.drainTimer = undefined;
      this.pendingPairs.clear();
      this.pendingHeartbeat = false;
      this.sink.off("drain", this.onDrain);
      this.sink.off("error", this.onError);
      // The close listener stays until it fires, so shutdown can await it;
      // it holds nothing once the connection is closed.
      logger.info("observation stream closed", { connection: this.id, userId: this.slot.userId, reason });
      if (destroy) {
        this.sink.destroy();
        this.resolveDone();
      }
    }

    /** Shutdown: release now, end gracefully. */
    end(): void {
      if (this.closed) return;
      this.close("shutdown", false);
      try {
        this.sink.end();
      } catch {
        this.sink.destroy();
        this.resolveDone();
      }
    }

    /** The sink has closed or been destroyed. */
    private resolveDone(): void {
      if (this.finished) return;
      this.finished = true;
      this.resolveDoneOnce();
    }

    /** Shutdown straggler: destroy only a sink that has not closed yet. */
    forceDestroy(): void {
      if (this.finished) return;
      this.sink.destroy();
      this.resolveDone();
    }
  }

  return {
    reserve,
    open(slot, sink, meta = {}) {
      if (shuttingDown) {
        slot.release();
        sink.destroy();
        return;
      }
      const connection = new Connection(slot, sink, meta.requestId);
      connections.add(connection);
      connection.start();
    },
    publishUpdate(base, quote) {
      const key = `${base}/${quote}`;
      if (!PAIR_KEYS.includes(key)) return;
      for (const c of [...connections]) c.send("update", key);
    },
    publishHeartbeat() {
      for (const c of [...connections]) c.send("heartbeat");
    },
    refuseNew() {
      shuttingDown = true;
    },
    async shutdown() {
      if (ended) return;
      ended = true;
      shuttingDown = true;
      const open = [...connections];
      for (const c of open) {
        c.end();
      }
      if (open.length === 0) return;
      let timer: unknown;
      const forced = new Promise<void>((resolve) => {
        timer = clock.setTimeout(() => {
          for (const c of open) c.forceDestroy();
          resolve();
        }, shutdownDestroyMs);
      });
      await Promise.race([Promise.all(open.map((c) => c.done)), forced]);
      clock.clearTimeout(timer);
    },
    isShuttingDown: () => shuttingDown,
    stats() {
      const byUser: Record<string, number> = {};
      for (const [user, n] of reservedByUser) byUser[user] = n;
      return { total: connections.size, byUser, reserved: reservedTotal };
    },
  };
}
