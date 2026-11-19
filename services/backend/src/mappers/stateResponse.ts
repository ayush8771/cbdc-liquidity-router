import { InferenceError } from "../inferenceClient/errors.js";
import { KeyCollisionError, toCamelCase } from "./camelCase.js";
import { STATE_MODE_FROM_ENGINE } from "./routeResponse.js";

// The inference GET /v1/state body (API contract §2.5) as the Application API
// GET /api/v1/state body (§3.7: "the camelCase mapping of §2.5"). Values are
// copied, never computed.
//
// - Keys become camelCase recursively (toCamelCase), including each venue's
//   optional history object (dates, liquidity_usd -> liquidityUsd,
//   congestion). Unknown fields are kept and mapped (§1: tolerant at run time).
// - The one value mapped is state.mode, as everywhere in the app (§3.2;
//   contracts/README "Engine -> app mapping"): historical_replay ->
//   historicalReplay; scenario is unchanged. An unknown mode value is kept as
//   it is (§1: unknown enum values are treated generically, not rejected).
//   Nothing else changes: scenario_id, split, data_source_tag,
//   values_provenance, warning codes and messages, dates and numbers.
// - Validation covers only what the mapping relies on: `state` must be an
//   object whose `mode` is a string. Anything else in the body is passed
//   through unchecked. A failure, or two keys mapping to the same camelCase
//   name, throws InvalidStateResponseError, a 502 INFERENCE_ERROR whose
//   problems name field paths (for logs), never values or key names.
// - The input is never mutated.

export class InvalidStateResponseError extends InferenceError {
  /** Field paths and what was wrong, for logs. Never contains values. */
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(502, "INFERENCE_ERROR", "The inference service returned an invalid response.", "invalid_response", {
      upstreamStatus: 200,
    });
    this.name = "InvalidStateResponseError";
    this.problems = problems;
  }
}

type JsonObject = Record<string, unknown>;

export function mapStateResponse(body: JsonObject): JsonObject {
  const state = body.state;
  if (!isObject(state)) throw new InvalidStateResponseError(["state: must be an object"]);
  if (typeof state.mode !== "string") throw new InvalidStateResponseError(["state.mode: must be a string"]);

  let mapped: JsonObject;
  try {
    mapped = toCamelCase(body) as JsonObject;
  } catch (error) {
    if (error instanceof KeyCollisionError) {
      throw new InvalidStateResponseError(["(keys): two keys map to the same camelCase name"]);
    }
    throw error;
  }
  const engineMode = state.mode;
  if (Object.hasOwn(STATE_MODE_FROM_ENGINE, engineMode)) {
    (mapped.state as JsonObject).mode = STATE_MODE_FROM_ENGINE[engineMode];
  }
  return mapped;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
