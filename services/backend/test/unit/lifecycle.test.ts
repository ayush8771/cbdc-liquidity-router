import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createShutdown } from "../../src/lifecycle.js";
import { captureLogger } from "../helpers/server.js";

function fakeServer(events: string[], options: { closeDelayMs?: number } = {}) {
  return {
    close(callback?: (error?: Error) => void) {
      events.push("server.close");
      setTimeout(() => {
        events.push("server.closed");
        callback?.();
      }, options.closeDelayMs ?? 0);
      return this as never;
    },
    closeIdleConnections() {
      events.push("server.closeIdleConnections");
    },
  };
}

describe("graceful shutdown", () => {
  it("closes the server, then disconnects the database, then exits 0", async () => {
    const events: string[] = [];
    const capture = captureLogger();
    const shutdown = createShutdown({
      server: fakeServer(events),
      disconnect: async () => void events.push("disconnect"),
      logger: capture.logger,
      exit: (code) => void events.push(`exit ${code}`),
    });
    await shutdown("SIGTERM");
    assert.deepEqual(events, ["server.close", "server.closeIdleConnections", "server.closed", "disconnect", "exit 0"]);
    assert.deepEqual(
      capture.entries().map(({ msg, signal }) => [msg, signal]),
      [
        ["shutting down", "SIGTERM"],
        ["shutdown complete", undefined],
      ],
    );
  });

  it("runs only once when signalled twice", async () => {
    const events: string[] = [];
    const shutdown = createShutdown({
      server: fakeServer(events),
      disconnect: async () => void events.push("disconnect"),
      logger: captureLogger().logger,
      exit: (code) => void events.push(`exit ${code}`),
    });
    await Promise.all([shutdown("SIGINT"), shutdown("SIGINT")]);
    assert.equal(events.filter((e) => e === "disconnect").length, 1);
    assert.equal(events.filter((e) => e.startsWith("exit")).length, 1);
  });

  it("exits 1 and logs no error details when disconnecting fails", async () => {
    const events: string[] = [];
    const capture = captureLogger();
    const shutdown = createShutdown({
      server: fakeServer(events),
      disconnect: async () => {
        throw new Error("postgresql://cbdc:s3cret-pw@db.internal:5432/cbdc");
      },
      logger: capture.logger,
      exit: (code) => void events.push(`exit ${code}`),
    });
    await shutdown("SIGTERM");
    assert.deepEqual(events.slice(-1), ["exit 1"]);
    assert.ok(capture.entries().some((e) => e.level === "error" && e.msg === "database disconnect failed"));
    assert.ok(!capture.lines.join("\n").includes("s3cret-pw"));
  });

  it("forces exit 1 if closing takes longer than the timeout", async () => {
    const events: string[] = [];
    const capture = captureLogger();
    const shutdown = createShutdown({
      server: fakeServer(events, { closeDelayMs: 200 }),
      disconnect: async () => void events.push("disconnect"),
      logger: capture.logger,
      exit: (code) => void events.push(`exit ${code}`),
      timeoutMs: 20,
    });
    await shutdown("SIGTERM");
    assert.equal(events[events.indexOf("server.closed") - 1], "exit 1", events.join(", "));
    assert.ok(capture.entries().some((e) => e.msg === "shutdown timed out; exiting"));
  });
});
