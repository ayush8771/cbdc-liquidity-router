import express, { type Express } from "express";
import { createAuthenticator, requireAuth } from "./auth/devAuth.js";
import type { DevUser } from "./config/devTokens.js";
import type { ComparisonStore } from "./db/comparisons.js";
import type { DashboardRepository } from "./db/dashboard.js";
import type { ExplanationStore } from "./db/explanations.js";
import { createDatabaseProbe, type DatabaseProbe } from "./db/health.js";
import type { TransactionPersistence } from "./db/transactionPersistence.js";
import type { TransactionRepository } from "./db/transactions.js";
import { createInferenceCache, type InferenceCache } from "./inferenceClient/cache.js";
import type { InferenceClient } from "./inferenceClient/client.js";
import { createInferenceHealthProbe, type InferenceHealthProbe } from "./inferenceClient/health.js";
import { createLogger, type Logger } from "./logger.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { jsonBody } from "./middleware/jsonBody.js";
import { methodNotAllowed, methodNotAllowedError, type RouteMethods } from "./middleware/methodNotAllowed.js";
import { requestId } from "./middleware/requestId.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { authMe } from "./routes/auth.js";
import { createComparison, getComparison } from "./routes/comparisons.js";
import { getDashboardSummary } from "./routes/dashboard.js";
import { getTransactionExplanation } from "./routes/explanations.js";
import { healthCheck, livenessCheck } from "./routes/health.js";
import { getMeta } from "./routes/meta.js";
import { getNetwork, getScenarios } from "./routes/metadata.js";
import { replayCalendar } from "./routes/replay.js";
import { getState } from "./routes/state.js";
import { createTransaction, getTransaction, listTransactions } from "./routes/transactions.js";
import { STREAM_PATH } from "./observations/constants.js";
import { observationStream } from "./observations/route.js";
import type { StreamHub } from "./observations/streamHub.js";

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
  /**
   * The shared inference GET cache (§5). Defaults to a new cache over
   * inferenceClient, one per app; injectable for tests (e.g. a fake clock).
   */
  inferenceCache?: InferenceCache;
  /** Transaction history and details. Without one (no DATABASE_URL), both return 500 INTERNAL_ERROR. */
  transactions?: TransactionRepository;
  /** Saving new transactions. Without one (no DATABASE_URL), POST /transactions returns 500 INTERNAL_ERROR. */
  transactionPersistence?: TransactionPersistence;
  /** Stored explanations. Without one (no DATABASE_URL), GET /transactions/:id/explanation returns 500 INTERNAL_ERROR. */
  explanations?: ExplanationStore;
  /** Dashboard aggregates. Without one (no DATABASE_URL), GET /dashboard/summary returns 500 INTERNAL_ERROR. */
  dashboard?: DashboardRepository;
  /** Stored comparisons. Without one (no DATABASE_URL), both comparison routes return 500 INTERNAL_ERROR. */
  comparisons?: ComparisonStore;
  /**
   * Phase 3 D-24 observation streams (AD-1 v0.5 §3.2). Without one (no
   * OBSERVATIONS_URL), the stream route is not registered, so it is 404.
   */
  observationStreams?: StreamHub;
}

/**
 * Every registered path and its methods, for 405 responses. Keep in step with
 * the routes below; a test checks that each listed method is routed.
 */
export const API_ROUTES: RouteMethods = Object.freeze({
  "/api/v1/health": ["GET"],
  "/api/v1/health/live": ["GET"],
  "/api/v1/auth/me": ["GET"],
  "/api/v1/meta": ["GET"],
  "/api/v1/network": ["GET"],
  "/api/v1/scenarios": ["GET"],
  "/api/v1/state": ["GET"],
  "/api/v1/replay/calendar": ["GET"],
  "/api/v1/transactions": ["GET", "POST"],
  "/api/v1/transactions/:id": ["GET"],
  "/api/v1/transactions/:id/explanation": ["GET"],
  "/api/v1/comparisons": ["POST"],
  "/api/v1/comparisons/:id": ["GET"],
  "/api/v1/dashboard/summary": ["GET"],
});

/** Registered paths that need no token (§3.0, §3.9), including for their 405s. */
export const PUBLIC_PATHS: readonly string[] = Object.freeze(["/api/v1/health", "/api/v1/health/live"]);

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
  const client = options.inferenceClient;
  const cache = options.inferenceCache ?? (client === undefined ? undefined : createInferenceCache(client, { logger }));
  const app = express();
  app.disable("x-powered-by");

  app.use(requestId);
  app.use(requestLogger(logger));

  // Public (API contract §3.0, §3.9): readiness, 503 when the database is down.
  app.get("/api/v1/health", healthCheck(database, inference));
  // Public (§3.9): liveness, 200 {"status": "ok"}; checks no dependency.
  app.get("/api/v1/health/live", livenessCheck);

  // Protected: auth runs per route, so unknown paths still return 404.
  app.get("/api/v1/auth/me", authenticated, authMe);
  app.get("/api/v1/meta", authenticated, getMeta(cache, client?.mode, logger));
  app.get("/api/v1/network", authenticated, getNetwork(cache, logger));
  app.get("/api/v1/replay/calendar", authenticated, replayCalendar(cache, logger));
  app.get("/api/v1/scenarios", authenticated, getScenarios(cache, logger));
  // Not cached (§3.1). HEAD is answered by this GET route, as for the other
  // read-only GETs: it calls inference but stores nothing.
  app.get("/api/v1/state", authenticated, getState(client, logger));
  app.get("/api/v1/transactions", authenticated, listTransactions(options.transactions));
  app.post(
    "/api/v1/transactions",
    authenticated,
    jsonBody(),
    createTransaction(options.transactionPersistence, options.inferenceClient, logger),
  );
  app.get("/api/v1/transactions/:id", authenticated, getTransaction(options.transactions, logger));
  // Before the GET route, so Express never answers this HEAD with the GET
  // handler. Authenticated first, like every protected 405 (§10 Q14): no
  // token is 401, a valid token is 405.
  app.head("/api/v1/transactions/:id/explanation", authenticated, () => {
    throw methodNotAllowedError("HEAD", "/api/v1/transactions/:id/explanation", "GET");
  });
  app.get(
    "/api/v1/transactions/:id/explanation",
    authenticated,
    getTransactionExplanation(options.explanations, client, cache, logger),
  );
  // §3.6. POST only: GET and HEAD on the collection are 405 with Allow: POST.
  app.post("/api/v1/comparisons", authenticated, jsonBody(), createComparison(options.comparisons, client, logger));
  // A database read only, so HEAD is answered by this GET route.
  app.get("/api/v1/comparisons/:id", authenticated, getComparison(options.comparisons, logger));
  // Database reads only (§3.8), any role. HEAD is answered by this GET route,
  // as for the other read-only GETs.
  app.get("/api/v1/dashboard/summary", authenticated, getDashboardSummary(options.dashboard));

  // Phase 3 D-24 (AD-1 v0.5 §3.2), outside API contract v0.4 and API_ROUTES.
  // app.all with authentication first: 401 before 405, HEAD included; the
  // handler answers every other method with 405 itself.
  if (options.observationStreams !== undefined) {
    app.all(STREAM_PATH, authenticated, observationStream(options.observationStreams));
  }

  // A registered path with an unregistered method: 405 with Allow (§4).
  // OPTIONS gets 405 too. The API is same-origin through the Vite proxy (§1),
  // so browsers send no preflight. A future CORS middleware must be mounted
  // before the routes and this handler, and answer preflights itself;
  // otherwise every preflight would get this 405.
  // Protected paths authenticate first (§10 Q14): 401 without a valid token,
  // 405 with one. The health paths stay public: 405 with no token.
  app.use(
    methodNotAllowed(API_ROUTES, {
      getWithoutHead: GET_WITHOUT_HEAD,
      authenticate: authenticated,
      publicPaths: PUBLIC_PATHS,
    }),
  );
  app.use(notFound);
  app.use(errorHandler(logger));

  return app;
}
