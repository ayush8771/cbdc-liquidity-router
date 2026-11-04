import type { RequestHandler } from "express";
import type { DatabaseProbe, DatabaseStatus } from "../db/health.js";
import type { InferenceHealthProbe, InferenceStatus } from "../inferenceClient/health.js";

// GET /api/v1/health, the readiness check (API contract §3.9, owner decision):
// - database unavailable                          -> HTTP 503, status "unavailable"
// - database ok, inference ok or mock             -> HTTP 200, status "ok"
//   (mock mode is a deliberate configuration, not a fault)
// - database ok, inference degraded or unavailable -> HTTP 200, status "degraded"
// The 503 body is the same Health object, not the §4 error envelope, so the
// component fields still say what failed.

export type HealthStatus = "ok" | "degraded" | "unavailable";

export function readiness(
  database: DatabaseStatus,
  inference: InferenceStatus,
): { httpStatus: 200 | 503; status: HealthStatus } {
  if (database !== "ok") return { httpStatus: 503, status: "unavailable" };
  if (inference === "ok" || inference === "mock") return { httpStatus: 200, status: "ok" };
  return { httpStatus: 200, status: "degraded" };
}

export function healthCheck(database: DatabaseProbe, inference: InferenceHealthProbe): RequestHandler {
  // Public (§3.0). Both checks run in parallel and never reject; the request
  // ID is forwarded to inference.
  return async (req, res) => {
    const [databaseStatus, inferenceStatus] = await Promise.all([database.check(), inference.check(req.requestId)]);
    const { httpStatus, status } = readiness(databaseStatus, inferenceStatus);
    res.status(httpStatus).json({
      status,
      database: databaseStatus,
      inference: inferenceStatus,
      authMode: "dev",
      time: new Date().toISOString(),
    });
  };
}
