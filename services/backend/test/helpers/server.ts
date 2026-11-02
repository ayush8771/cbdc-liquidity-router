import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createLogger, type Logger } from "../../src/logger.js";

/** Starts an app on a random localhost port. */
export async function startServer(app: Express): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A logger that keeps its output in memory, for assertions. */
export function captureLogger(): { logger: Logger; lines: string[]; entries: () => Array<Record<string, unknown>> } {
  const lines: string[] = [];
  return {
    logger: createLogger((line) => lines.push(line)),
    lines,
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

export const silentLogger: Logger = createLogger(() => {});
