import { PrismaClient } from "@prisma/client";
import type { Logger } from "../logger.js";

// The application's single PrismaClient. Prisma connects lazily, on the first
// query. Prisma's own warnings and errors are routed as events to our logger
// without their message text, which can name the database host or user.

let instance: { client: PrismaClient; databaseUrl: string } | undefined;

export function getPrismaClient(databaseUrl: string, logger: Logger): PrismaClient {
  if (instance !== undefined) {
    if (instance.databaseUrl !== databaseUrl) {
      throw new Error("PrismaClient already exists for a different DATABASE_URL");
    }
    return instance.client;
  }
  const client = new PrismaClient({
    datasourceUrl: databaseUrl,
    log: [
      { emit: "event", level: "warn" },
      { emit: "event", level: "error" },
    ],
  });
  attachPrismaLogging(client, logger);
  instance = { client, databaseUrl };
  return client;
}

/** Disconnects and forgets the client, if one was created. */
export async function disconnectPrismaClient(): Promise<void> {
  const current = instance;
  instance = undefined;
  if (current !== undefined) await current.client.$disconnect();
}

export interface PrismaEventSource {
  $on(event: "warn" | "error", callback: (event: unknown) => void): void;
}

export function attachPrismaLogging(client: PrismaEventSource, logger: Logger): void {
  client.$on("warn", () => logger.warn("database client warning"));
  client.$on("error", () => logger.error("database client error"));
}
