import { InferenceError } from "../inferenceClient/errors.js";

// Validation of a GET /v1/version 200 body (API contract §2.2) before the
// shared cache stores it (§5).
//
// Only what the backend relies on is checked: the eleven §5 fingerprint inputs
// and the checkpoint shape, which the explanation route reads (§3.5).
// - git_commit, engine_version: non-empty strings.
// - reward_weights: an object whose three λ are finite numbers and whose status
//   is a string. Its value isn't checked: a change of status is a fingerprint
//   change, not an invalid response.
// - knowledge.sha256 and the six data.*_sha256: SHA-256 hex, 64 lower-case hex
//   digits (§2.2, §2.11; Sha256Hex in the draft OpenAPI).
// - checkpoint: null, or an object whose sha256 is SHA-256 hex.
// Every other field is passed through unchecked, and unknown fields are
// allowed: consumers are tolerant of response fields at run time (§1).
// Problems are field paths only, never values, so they can be logged.

const SHA256_HEX = /^[0-9a-f]{64}$/;
const DATA_HASHES = [
  "daily_state_sha256",
  "bridge_network_sha256",
  "normalization_stats_sha256",
  "macro_risk_proxy_sha256",
  "rpw_corridor_quarterly_sha256",
  "scenarios_sha256",
] as const;
const LAMBDAS = ["lambda_latency", "lambda_risk", "lambda_unrouted"] as const;

/** A 200 /v1/version body that fails validation: 502 INFERENCE_ERROR, like any invalid response. */
export class InvalidVersionResponseError extends InferenceError {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(502, "INFERENCE_ERROR", "The inference service returned an invalid response.", "invalid_response", {
      upstreamStatus: 200,
    });
    this.name = "InvalidVersionResponseError";
    this.problems = problems;
  }
}

/** The field paths that fail validation; empty when the body is usable. */
export function versionResponseProblems(body: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const nonEmptyString = (value: unknown) => typeof value === "string" && value !== "";
  const sha256 = (value: unknown) => typeof value === "string" && SHA256_HEX.test(value);

  if (!nonEmptyString(body.git_commit)) problems.push("git_commit");
  if (!nonEmptyString(body.engine_version)) problems.push("engine_version");

  const weights = asObject(body.reward_weights);
  if (weights === undefined) {
    problems.push("reward_weights");
  } else {
    for (const lambda of LAMBDAS) {
      const value = weights[lambda];
      if (typeof value !== "number" || !Number.isFinite(value)) problems.push(`reward_weights.${lambda}`);
    }
    if (typeof weights.status !== "string") problems.push("reward_weights.status");
  }

  const knowledge = asObject(body.knowledge);
  if (knowledge === undefined) problems.push("knowledge");
  else if (!sha256(knowledge.sha256)) problems.push("knowledge.sha256");

  const data = asObject(body.data);
  if (data === undefined) {
    problems.push("data");
  } else {
    for (const field of DATA_HASHES) if (!sha256(data[field])) problems.push(`data.${field}`);
  }

  if (!Object.hasOwn(body, "checkpoint")) {
    problems.push("checkpoint");
  } else if (body.checkpoint !== null) {
    const checkpoint = asObject(body.checkpoint);
    if (checkpoint === undefined) problems.push("checkpoint");
    else if (!sha256(checkpoint.sha256)) problems.push("checkpoint.sha256");
  }
  return problems;
}

/** Throws InvalidVersionResponseError unless the body passes versionResponseProblems. */
export function validateVersionResponse(body: Record<string, unknown>): void {
  const problems = versionResponseProblems(body);
  if (problems.length > 0) throw new InvalidVersionResponseError(problems);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
