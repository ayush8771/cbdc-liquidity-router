import express, { type Express } from "express";
import { createAuthenticator, requireAuth } from "./auth/devAuth.js";
import type { DevUser } from "./config/devTokens.js";
import { createDatabaseProbe, type DatabaseProbe } from "./db/health.js";
import type { TransactionRepository } from "./db/transactions.js";
import type { InferenceClient } from "./inferenceClient/client.js";
import { createInferenceHealthProbe, type InferenceHealthProbe } from "./inferenceClient/health.js";
import { createLogger, type Logger } from "./logger.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { requestId } from "./middleware/requestId.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { authMe } from "./routes/auth.js";
import { replayCalendar } from "./routes/replay.js";
import { listTransactions } from "./routes/transactions.js";

export interface AppOptions {
  logger?: Logger;
  /** Development users from the token file. With none, every protected route returns 401. */
  users?: readonly DevUser[];
  /** Database reachability. Without one, health reports the database as unavailable. */
  database?: DatabaseProbe;
  /** Inference status. Without one, health reports inference as unavailable. */
  inference?: InferenceHealthProbe;
  /** Calls to the inference service. Without one, routes that need it return 503 INFERENCE_UNAVAILABLE. */
  inferenceClient?: InferenceClient;
  /** Transaction history. Without one (no DATABASE_URL), history returns 500 INTERNAL_ERROR. */
  transactions?: TransactionRepository;
}

export function createApp(options: AppOptions = {}): Express {
  const logger = options.logger ?? createLogger();
  const database = options.database ?? createDatabaseProbe(undefined, logger);
  const inference = options.inference ?? createInferenceHealthProbe(undefined, logger);
  const authenticated = requireAuth(createAuthenticator(options.users ?? []));
  const app = express();
  app.disable("x-powered-by");

  app.use(requestId);
  app.use(requestLogger(logger));

  // Public (API contract §3.0). Shape from §3.9; always HTTP 200 (provisional,
  // the contract gives no status code). Both checks run in parallel and never
  // reject; the request ID is forwarded to inference.
  app.get("/api/v1/health", async (req, res) => {
    const [databaseStatus, inferenceStatus] = await Promise.all([database.check(), inference.check(req.requestId)]);
    res.json({
      status: databaseStatus === "ok" && inferenceStatus === "ok" ? "ok" : "degraded",
      database: databaseStatus,
      inference: inferenceStatus,
      authMode: "dev",
      time: new Date().toISOString(),
    });
  });

  // Protected: auth runs per route, so unknown paths still return 404.
  app.get("/api/v1/auth/me", authenticated, authMe);
  app.get("/api/v1/replay/calendar", authenticated, replayCalendar(options.inferenceClient, logger));
  app.get("/api/v1/transactions", authenticated, listTransactions(options.transactions));

  app.use(notFound);
  app.use(errorHandler(logger));

  return app;
}
