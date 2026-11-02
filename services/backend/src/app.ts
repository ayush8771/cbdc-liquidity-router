import express, { type Express } from "express";
import { createAuthenticator, requireAuth } from "./auth/devAuth.js";
import type { DevUser } from "./config/devTokens.js";
import { createDatabaseProbe, type DatabaseProbe } from "./db/health.js";
import { createLogger, type Logger } from "./logger.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { requestId } from "./middleware/requestId.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { authMe } from "./routes/auth.js";

// The backend has no inference client yet: it can neither call the inference
// service nor serve mock fixtures. "unavailable" (a documented §3.9 value) is
// the only truthful status until then; it is replaced with a real check, or
// "mock" in mock mode, when the client exists.
const INFERENCE_STATUS: "ok" | "degraded" | "unavailable" | "mock" = "unavailable";

export interface AppOptions {
  logger?: Logger;
  /** Development users from the token file. With none, every protected route returns 401. */
  users?: readonly DevUser[];
  /** Database reachability. Without one, health reports the database as unavailable. */
  database?: DatabaseProbe;
}

export function createApp(options: AppOptions = {}): Express {
  const logger = options.logger ?? createLogger();
  const database = options.database ?? createDatabaseProbe(undefined, logger);
  const authenticated = requireAuth(createAuthenticator(options.users ?? []));
  const app = express();
  app.disable("x-powered-by");

  app.use(requestId);
  app.use(requestLogger(logger));

  // Public (API contract §3.0). Shape from §3.9.
  app.get("/api/v1/health", async (_req, res) => {
    const databaseStatus = await database.check();
    res.json({
      status: databaseStatus === "ok" && INFERENCE_STATUS === "ok" ? "ok" : "degraded",
      database: databaseStatus,
      inference: INFERENCE_STATUS,
      authMode: "dev",
      time: new Date().toISOString(),
    });
  });

  // Protected: auth runs per route, so unknown paths still return 404.
  app.get("/api/v1/auth/me", authenticated, authMe);

  app.use(notFound);
  app.use(errorHandler(logger));

  return app;
}
