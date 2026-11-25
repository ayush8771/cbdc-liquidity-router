import type { Server } from "node:http";
import type { Logger } from "./logger.js";

// Graceful shutdown: stop accepting connections, let in-flight requests
// finish, disconnect the database, then exit. A timer forces exit if that
// takes too long. Errors are logged without their message text.

export const SHUTDOWN_TIMEOUT_MS = 10000;

export interface ShutdownOptions {
  server: Pick<Server, "close" | "closeIdleConnections">;
  disconnect: () => Promise<void>;
  logger: Logger;
  exit: (code: number) => void;
  timeoutMs?: number;
  /**
   * Optional, additive (AD-1 v0.5 §3.5): runs before server.close, e.g. to end
   * open observation streams that would otherwise hold server.close until the
   * forced exit. Failures are logged without their message and do not stop
   * the shutdown.
   */
  beforeClose?: () => Promise<void>;
}

export function createShutdown(options: ShutdownOptions): (signal: string) => Promise<void> {
  const { server, disconnect, logger, exit, timeoutMs = SHUTDOWN_TIMEOUT_MS, beforeClose } = options;
  let started = false;

  return async (signal) => {
    if (started) return;
    started = true;
    logger.info("shutting down", { signal });

    const timer = setTimeout(() => {
      logger.error("shutdown timed out; exiting");
      exit(1);
    }, timeoutMs);
    timer.unref();

    if (beforeClose !== undefined) {
      try {
        await beforeClose();
      } catch {
        logger.error("pre-close hook failed");
      }
    }

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });

    let code = 0;
    try {
      await disconnect();
    } catch {
      logger.error("database disconnect failed");
      code = 1;
    }
    clearTimeout(timer);
    logger.info("shutdown complete");
    exit(code);
  };
}
