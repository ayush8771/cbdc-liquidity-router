import type { Logger } from "../logger.js";
import type { InferenceClient, InferenceHealthResponse, JsonObject } from "./client.js";
import { InferenceError } from "./errors.js";

// Inference status for GET /api/v1/health (API contract §2.1, §3.9).
//
// - Mock mode: "mock", without calling anything, even when a mock handler exists.
// - Live mode, /v1/health (timeout INFERENCE_TIMEOUT_MS, no retry):
//   - 200, ready true, status "ok"        -> "ok"
//   - 200, ready true, status "degraded"  -> "degraded"
//   - 503 with ready false, or a NOT_READY error envelope -> "unavailable"
//   - anything else (timeout, unreachable, another status, an invalid or
//     contradictory body)                 -> "unavailable"
// - No client: "unavailable".
//
// Only `ready` and `status` are read; nothing from the inference body or an
// error reaches the backend's response. Changes are logged with a fixed
// reason, never a body or message, and only when the status or reason changes.
// check() never rejects.

export type InferenceStatus = "ok" | "degraded" | "unavailable" | "mock";

export interface InferenceHealthProbe {
  check(requestId?: string): Promise<InferenceStatus>;
}

interface Outcome {
  status: InferenceStatus;
  reason: string;
}

export function createInferenceHealthProbe(client: InferenceClient | undefined, logger: Logger): InferenceHealthProbe {
  let lastReported: string | undefined;
  const report = ({ status, reason }: Outcome) => {
    const key = `${status}:${reason}`;
    if (key === lastReported) return;
    lastReported = key;
    if (status === "ok" || status === "mock") logger.info("inference status", { inference: status, reason });
    else logger.warn("inference status", { inference: status, reason });
  };

  const probe = async (requestId: string | undefined): Promise<Outcome> => {
    if (client === undefined) return { status: "unavailable", reason: "not_configured" };
    if (client.mode === "mock") return { status: "mock", reason: "mock" };
    try {
      return classify(await client.health({ requestId }));
    } catch (error) {
      // InferenceError failure kinds are fixed strings, safe to log.
      return { status: "unavailable", reason: error instanceof InferenceError ? error.failure : "error" };
    }
  };

  return {
    async check(requestId) {
      const outcome = await probe(requestId);
      report(outcome);
      return outcome.status;
    },
  };
}

function classify({ httpStatus, body }: InferenceHealthResponse): Outcome {
  const { ready, status } = body;
  const knownStatus = status === "ok" || status === "degraded";
  if (httpStatus === 200) {
    if (ready === true && status === "ok") return { status: "ok", reason: "ok" };
    if (ready === true && status === "degraded") return { status: "degraded", reason: "degraded" };
  } else if ((ready === false && knownStatus) || isNotReadyEnvelope(body)) {
    return { status: "unavailable", reason: "not_ready" };
  }
  return { status: "unavailable", reason: "invalid_response" };
}

// The §4 error envelope with code NOT_READY.
function isNotReadyEnvelope(body: JsonObject): boolean {
  const error = body.error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return false;
  const { code, message } = error as JsonObject;
  return code === "NOT_READY" && typeof message === "string";
}
