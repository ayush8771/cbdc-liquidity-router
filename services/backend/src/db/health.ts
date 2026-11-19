import type { Logger } from "../logger.js";
import { isPrismaError, prismaErrorCode } from "./errors.js";

// Database reachability for GET /api/v1/health (API contract §3.9).
// The contract shows only "ok" for the database field; "unavailable" is a
// provisional value borrowed from the inference field's documented values.
// Failures are logged with a Prisma error code at most, never a message,
// connection string or credential, and only when the status changes.
//
// The timeout does not cancel the query: Prisma has no way to cancel one, so
// a timed-out query keeps running until Prisma's own timeouts end it. To stop
// repeated health checks piling up database work, at most one probe query is
// in flight. Checks made while it runs, including after it timed out, wait on
// that same query instead of starting another.

export type DatabaseStatus = "ok" | "unavailable";

export interface DatabaseProbe {
  check(): Promise<DatabaseStatus>;
}

/** The part of PrismaClient the probe needs, so tests can supply a fake. */
export interface PingClient {
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<unknown>;
}

export const DATABASE_CHECK_TIMEOUT_MS = 3000;

const TIMED_OUT = Symbol("timed out");

export function createDatabaseProbe(
  client: PingClient | undefined,
  logger: Logger,
  timeoutMs: number = DATABASE_CHECK_TIMEOUT_MS,
): DatabaseProbe {
  let lastReported: string | undefined;
  const report = (status: DatabaseStatus, reason?: string) => {
    const key = `${status}:${reason ?? ""}`;
    if (key === lastReported) return;
    lastReported = key;
    if (status === "ok") logger.info("database status", { database: status });
    else logger.warn("database status", { database: status, reason });
  };

  let inFlight: Promise<unknown> | undefined;
  const startQuery = (pinger: PingClient): Promise<unknown> => {
    if (inFlight === undefined) {
      const query = Promise.resolve(pinger.$queryRaw`SELECT 1`).finally(() => {
        inFlight = undefined;
      });
      // A query that settles after every waiting check has timed out has no
      // other handler; this keeps its rejection from being unhandled.
      query.catch(() => {});
      inFlight = query;
    }
    return inFlight;
  };

  return {
    async check() {
      if (client === undefined) {
        report("unavailable", "not_configured");
        return "unavailable";
      }
      let timer: NodeJS.Timeout | undefined;
      try {
        const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
        });
        if ((await Promise.race([startQuery(client), timeout])) === TIMED_OUT) {
          report("unavailable", "timeout");
          return "unavailable";
        }
        report("ok");
        return "ok";
      } catch (error) {
        report("unavailable", failureReason(error));
        return "unavailable";
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function failureReason(error: unknown): string {
  // Prisma's error class names are fixed strings, safe to log; a refused
  // connection is a PrismaClientInitializationError with no error code.
  return prismaErrorCode(error) ?? (isPrismaError(error) ? error.name : "error");
}
