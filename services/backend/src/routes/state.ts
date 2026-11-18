import type { RequestHandler } from "express";
import type { InferenceClient, QueryValue } from "../inferenceClient/client.js";
import { inferenceUnavailable } from "../inferenceClient/errors.js";
import type { Logger } from "../logger.js";
import { STATE_MODE_TO_ENGINE } from "../mappers/routeRequest.js";
import { InvalidStateResponseError, mapStateResponse } from "../mappers/stateResponse.js";
import { ApiError } from "../middleware/errors.js";
import { MESSAGES, VALIDATION_ERROR_MESSAGE, isCalendarDate } from "../validation/transactionRequest.js";

// GET /api/v1/state (API contract §3.7, §2.5): bridge monitor data. Any
// authenticated role may call it (§3.0, §3.1: no role rule). It calls
// GET /v1/state on every request: §3.1 lists no cache for it.
//
// Query parameters (§3.7; app OpenAPI getState):
// - corridor: required, a non-empty string, sent to inference unchanged. It
//   is not checked against a local list: the approved contract (§3.7) gives
//   no app-side corridor rule, so an unknown corridor is left to inference,
//   whose rejection (e.g. 422 UNSUPPORTED_CORRIDOR) is mapped as below.
// - mode: required, historicalReplay or scenario. explicit is refused:
//   explicit states are not looked up (§2.5).
// - date: required, YYYY-MM-DD naming a real calendar day. Its range and gap
//   buffers are left to inference (DATE_OUT_OF_RANGE, DATE_IN_GAP_BUFFER, §2.4).
// - scenarioId (§2.5, §3.7): required with scenario, refused with
//   historicalReplay (both VALIDATION_ERROR). Any non-empty string passes, as
//   on POST /transactions (validation/transactionRequest.ts); an unknown value
//   is sent to inference, whose 422 UNKNOWN_SCENARIO is passed through.
// - includeHistory: optional, "true" or "false" (OpenAPI boolean, default false).
// - A documented parameter given twice is a VALIDATION_ERROR, and unknown
//   parameters are ignored: the §3.3 query rules, applied here because §3.7
//   doesn't state its own (§1: query parameters are not strict bodies).
// Every problem is returned at once as 422 VALIDATION_ERROR with
// details.errors[] = [{field, message}], with fixed messages that never echo
// a caller-supplied value (§4). Validation runs before inference is called.
//
// Inference request: corridor, mode (engine spelling, historical_replay or
// scenario), date, scenario_id only with scenario, and include_history=true
// only when includeHistory is true (false is the engine default, §2.5).
// Inference errors are mapped by the client as for every other endpoint (§4):
// documented 422 codes (e.g. UNKNOWN_SCENARIO) and ENGINE_BUSY/ENGINE_TIMEOUT
// pass through with the backend's own message, NOT_READY becomes 503
// INFERENCE_UNAVAILABLE, and anything else becomes 502 INFERENCE_ERROR.

export const STATE_LOOKUP_MODES = ["historicalReplay", "scenario"] as const;
export type StateLookupMode = (typeof STATE_LOOKUP_MODES)[number];
const KNOWN = ["corridor", "mode", "date", "scenarioId", "includeHistory"] as const;

export const STATE_QUERY_MESSAGES = Object.freeze({
  duplicate: "Must be given at most once.",
  mode: `Must be one of: ${STATE_LOOKUP_MODES.join(", ")}.`,
  scenarioIdNotAllowed: "Must not be given with mode historicalReplay.",
  includeHistory: "Must be true or false.",
});

export interface StateQuery {
  corridor: string;
  mode: StateLookupMode;
  date: string;
  scenarioId: string | undefined;
  includeHistory: boolean;
}

export interface FieldError {
  field: string;
  message: string;
}

export type StateQueryResult = { ok: true; query: StateQuery } | { ok: false; errors: FieldError[] };

export function parseStateQuery(params: URLSearchParams): StateQueryResult {
  const errors: FieldError[] = [];
  const values = new Map<string, string>();
  const duplicated = new Set<string>();
  for (const name of KNOWN) {
    const all = params.getAll(name);
    if (all.length > 1) {
      errors.push({ field: name, message: STATE_QUERY_MESSAGES.duplicate });
      duplicated.add(name);
    } else if (all.length === 1) values.set(name, all[0]!);
  }
  // A duplicated parameter is reported once, as a duplicate, and not checked further.
  const required = (name: string): string | undefined => {
    const raw = values.get(name);
    if (raw === undefined && !duplicated.has(name)) errors.push({ field: name, message: MESSAGES.required });
    return raw;
  };

  const corridorRaw = required("corridor");
  let corridor: string | undefined;
  if (corridorRaw !== undefined) {
    if (corridorRaw !== "") corridor = corridorRaw;
    else errors.push({ field: "corridor", message: MESSAGES.nonEmptyString });
  }

  const modeRaw = required("mode");
  let mode: StateLookupMode | undefined;
  if (modeRaw !== undefined) {
    if ((STATE_LOOKUP_MODES as readonly string[]).includes(modeRaw)) mode = modeRaw as StateLookupMode;
    else errors.push({ field: "mode", message: STATE_QUERY_MESSAGES.mode });
  }

  const dateRaw = required("date");
  let date: string | undefined;
  if (dateRaw !== undefined) {
    if (isCalendarDate(dateRaw)) date = dateRaw;
    else errors.push({ field: "date", message: MESSAGES.date });
  }

  // The scenarioId rules depend on a valid mode; with none, only a duplicate is reported.
  let scenarioId: string | undefined;
  if (mode === "scenario" && !duplicated.has("scenarioId")) {
    const raw = values.get("scenarioId");
    if (raw === undefined) errors.push({ field: "scenarioId", message: MESSAGES.required });
    else if (raw === "") errors.push({ field: "scenarioId", message: MESSAGES.nonEmptyString });
    else scenarioId = raw;
  } else if (mode === "historicalReplay" && values.has("scenarioId")) {
    errors.push({ field: "scenarioId", message: STATE_QUERY_MESSAGES.scenarioIdNotAllowed });
  }

  let includeHistory = false;
  const includeRaw = values.get("includeHistory");
  if (includeRaw !== undefined) {
    if (includeRaw === "true") includeHistory = true;
    else if (includeRaw !== "false") errors.push({ field: "includeHistory", message: STATE_QUERY_MESSAGES.includeHistory });
  }

  if (errors.length > 0 || corridor === undefined || mode === undefined || date === undefined) {
    return { ok: false, errors };
  }
  return { ok: true, query: { corridor, mode, date, scenarioId, includeHistory } };
}

/** The /v1/state query for a validated app query (§2.5), with absent parameters left out. */
export function toEngineStateQuery(query: StateQuery): Record<string, QueryValue> {
  return {
    corridor: query.corridor,
    mode: STATE_MODE_TO_ENGINE[query.mode],
    date: query.date,
    ...(query.mode === "scenario" && query.scenarioId !== undefined && { scenario_id: query.scenarioId }),
    ...(query.includeHistory && { include_history: "true" }),
  };
}

export function getState(client: InferenceClient | undefined, logger: Logger): RequestHandler {
  return async (req, res) => {
    // Parsed from the raw URL, so duplicates are seen whatever Express's query parser does.
    const parsed = parseStateQuery(new URL(req.originalUrl, "http://localhost").searchParams);
    if (!parsed.ok) {
      throw new ApiError(422, "VALIDATION_ERROR", VALIDATION_ERROR_MESSAGE, { errors: parsed.errors });
    }
    if (client === undefined) throw inferenceUnavailable("not_configured");
    // Inference errors (InferenceError) reach the error handler as they are.
    const body = await client.get("/v1/state", { query: toEngineStateQuery(parsed.query), requestId: req.requestId });
    let mapped: Record<string, unknown>;
    try {
      mapped = mapStateResponse(body);
    } catch (error) {
      if (error instanceof InvalidStateResponseError) {
        logger.warn("inference response could not be mapped", {
          requestId: req.requestId,
          path: "/v1/state",
          reason: "invalid_response",
          problems: error.problems,
        });
      }
      throw error;
    }
    res.json(mapped);
  };
}
