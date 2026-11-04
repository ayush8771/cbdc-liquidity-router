import express, { type Express } from "express";
import { createAuthenticator, requireAuth } from "./auth/devAuth.js";
import type { DevUser } from "./config/devTokens.js";
import type { ExplanationStore } from "./db/explanations.js";
import { createDatabaseProbe, type DatabaseProbe } from "./db/health.js";
import type { TransactionPersistence } from "./db/transactionPersistence.js";
import type { TransactionRepository } from "./db/transactions.js";
import type { InferenceClient } from "./inferenceClient/client.js";
import { createInferenceHealthProbe, type InferenceHealthProbe } from "./inferenceClient/health.js";
import { createLogger, type Logger } from "./logger.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { jsonBody } from "./middleware/jsonBody.js";
import { methodNotAllowed, methodNotAllowedError, type RouteMethods } from "./middleware/methodNotAllowed.js";
import { requestId } from "./middleware/requestId.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { authMe } from "./routes/auth.js";
import { getTransactionExplanation } from "./routes/explanations.js";
import { healthCheck } from "./routes/health.js";
import { replayCalendar } from "./routes/replay.js";
import { createTransaction, getTransaction, listTransactions } from "./routes/transactions.js";

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
  /** Transaction history and details. Without one (no DATABASE_URL), both return 500 INTERNAL_ERROR. */
  transactions?: TransactionRepository;
  /** Saving new transactions. Without one (no DATABASE_URL), POST /transactions returns 500 INTERNAL_ERROR. */
  transactionPersistence?: TransactionPersistence;
  /** Stored explanations. Without one (no DATABASE_URL), GET /transactions/:id/explanation returns 500 INTERNAL_ERROR. */
  explanations?: ExplanationStore;
}

/**
 * Every registered path and its methods, for 405 responses. Keep in step with
 * the routes below; a test checks that each listed method is routed.
 */
export const API_ROUTES: RouteMethods = Object.freeze({
  "/api/v1/health": ["GET"],
  "/api/v1/auth/me": ["GET"],
  "/api/v1/replay/calendar": ["GET"],
  "/api/v1/transactions": ["GET", "POST"],
  "/api/v1/transactions/:id": ["GET"],
  "/api/v1/transactions/:id/explanation": ["GET"],
});

/**
 * GET paths where HEAD is 405 instead of an implicit GET. The explanation GET
 * may call inference and store an Explanation, so HEAD must never run it.
 */
export const GET_WITHOUT_HEAD: readonly string[] = Object.freeze(["/api/v1/transactions/:id/explanation"]);

export function createApp(options: AppOptions = {}): Express {
  const logger = options.logger ?? createLogger();
  const database = options.database ?? createDatabaseProbe(undefined, logger);
  const inference = options.inference ?? createInferenceHealthProbe(undefined, logger);
  const authenticated = requireAuth(createAuthenticator(options.users ?? []));
  const app = express();
  app.disable("x-powered-by");

  app.use(requestId);
  app.use(requestLogger(logger));

  // Public (API contract §3.0, §3.9): readiness, 503 when the database is down.
  app.get("/api/v1/health", healthCheck(database, inference));

  // Protected: auth runs per route, so unknown paths still return 404.
  app.get("/api/v1/auth/me", authenticated, authMe);
  app.get("/api/v1/replay/calendar", authenticated, replayCalendar(options.inferenceClient, logger));
  app.get("/api/v1/transactions", authenticated, listTransactions(options.transactions));
  app.post(
    "/api/v1/transactions",
    authenticated,
    jsonBody(),
    createTransaction(options.transactionPersistence, options.inferenceClient, logger),
  );
  app.get("/api/v1/transactions/:id", authenticated, getTransaction(options.transactions, logger));
  // Before the GET route, so Express never answers this HEAD with the GET
  // handler. Like every 405, it runs before authentication (§10 Q14).
  app.head("/api/v1/transactions/:id/explanation", () => {
    throw methodNotAllowedError("HEAD", "/api/v1/transactions/:id/explanation", "GET");
  });
  app.get(
    "/api/v1/transactions/:id/explanation",
    authenticated,
    getTransactionExplanation(options.explanations, options.inferenceClient, logger),
  );

  // A registered path with an unregistered method: 405 with Allow (§4).
  // OPTIONS gets 405 too. The API is same-origin through the Vite proxy (§1),
  // so browsers send no preflight. A future CORS middleware must be mounted
  // before the routes and this handler, and answer preflights itself;
  // otherwise every preflight would get this 405.
  app.use(methodNotAllowed(API_ROUTES, { getWithoutHead: GET_WITHOUT_HEAD }));
  app.use(notFound);
  app.use(errorHandler(logger));

  return app;
}
