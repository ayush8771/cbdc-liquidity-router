// The POST /api/v1/transactions request (API contract §3.2, §2.4): shape and
// type checks only. Domain rules stay in the inference service, which owns
// them and has its own error codes (§2.4, §4): amount > 0, supported corridor,
// date range and gap buffers, known scenario, venues matching the corridor,
// non-negative values, and the last history value equalling the current one.
//
// What is checked here:
// - The body is a JSON object. Required: senderCountry and receiverCountry
//   (non-empty strings), amountUsd (a finite number), state.
// - policy: waterfall, cheapestFeasible or ppoProjected; omitted or null means
//   waterfall (§2.8 default).
// - state.mode selects the structure:
//   - historicalReplay: date
//   - scenario: date, scenarioId (a non-empty string, passed on unchanged)
//   - explicit: referenceDate, venues[]; each venue has bridgeUid,
//     liquidityUsd, congestion and optional history {liquidityUsd[30],
//     congestion[30]} (or null)
//   Dates are YYYY-MM-DD calendar dates (§1). Numbers must be finite: a value
//   like 1e400 parses to Infinity, which JSON can't carry to inference.
// - Unknown fields inside state, a venue or history are rejected (§2.4).
//
// PROVISIONAL (unspecified in the contract):
// - Unknown top-level fields are rejected too, for §2.4's reason: a misspelt
//   "polcy" would otherwise route silently with the default policy.
// - clientReference: a string of any length (only the body limit applies), or
//   omitted or null. Empty strings are allowed.
// - null counts as omitted for the optional fields policy and clientReference.
// - Errors use details.errors[] = [{field, message}], with paths such as
//   "state.venues[1].history.congestion", as in GET /api/v1/transactions.

export type Policy = "waterfall" | "cheapestFeasible" | "ppoProjected";
export const POLICIES: readonly Policy[] = ["waterfall", "cheapestFeasible", "ppoProjected"];
export const DEFAULT_POLICY: Policy = "waterfall";
export const STATE_MODES = ["historicalReplay", "scenario", "explicit"] as const;
export const HISTORY_LENGTH = 30;

export interface History {
  liquidityUsd: number[];
  congestion: number[];
}

export interface ExplicitVenue {
  bridgeUid: string;
  liquidityUsd: number;
  congestion: number;
  history: History | null;
}

export type StateSpec =
  | { mode: "historicalReplay"; date: string }
  | { mode: "scenario"; date: string; scenarioId: string }
  | { mode: "explicit"; referenceDate: string; venues: ExplicitVenue[] };

export interface TransactionRequest {
  senderCountry: string;
  receiverCountry: string;
  amountUsd: number;
  state: StateSpec;
  /** After defaulting: always set. */
  policy: Policy;
  clientReference: string | null;
}

export interface FieldError {
  field: string;
  message: string;
}

export type ValidationResult = { ok: true; value: TransactionRequest } | { ok: false; errors: FieldError[] };

const TOP_LEVEL = ["senderCountry", "receiverCountry", "amountUsd", "state", "policy", "clientReference"];
const STATE_FIELDS: Record<StateSpec["mode"], readonly string[]> = {
  historicalReplay: ["mode", "date"],
  scenario: ["mode", "date", "scenarioId"],
  explicit: ["mode", "referenceDate", "venues"],
};
const VENUE_FIELDS = ["bridgeUid", "liquidityUsd", "congestion", "history"];
const HISTORY_FIELDS = ["liquidityUsd", "congestion"];

type JsonObject = Record<string, unknown>;

export function validateTransactionRequest(body: unknown): ValidationResult {
  const errors: FieldError[] = [];
  const fail = (field: string, message: string): undefined => {
    errors.push({ field, message });
    return undefined;
  };

  const object = (value: unknown, field: string): JsonObject | undefined =>
    isObject(value) ? value : fail(field, "must be an object");
  const unknownFields = (value: JsonObject, allowed: readonly string[], prefix: string): void => {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) fail(join(prefix, key), "is not a known field");
    }
  };
  const nonEmptyString = (value: unknown, field: string): string | undefined => {
    if (value === undefined) return fail(field, "is required");
    return typeof value === "string" && value.length > 0 ? value : fail(field, "must be a non-empty string");
  };
  const finiteNumber = (value: unknown, field: string): number | undefined => {
    if (value === undefined) return fail(field, "is required");
    return typeof value === "number" && Number.isFinite(value) ? value : fail(field, "must be a finite number");
  };
  const date = (value: unknown, field: string): string | undefined => {
    if (value === undefined) return fail(field, "is required");
    return typeof value === "string" && isCalendarDate(value) ? value : fail(field, "must be a date in YYYY-MM-DD form");
  };
  const series = (value: unknown, field: string): number[] | undefined => {
    if (value === undefined) return fail(field, "is required");
    if (!Array.isArray(value) || value.length !== HISTORY_LENGTH) {
      return fail(field, `must be an array of exactly ${HISTORY_LENGTH} numbers`);
    }
    const bad = value.findIndex((n) => typeof n !== "number" || !Number.isFinite(n));
    return bad === -1 ? [...(value as number[])] : fail(`${field}[${bad}]`, "must be a finite number");
  };

  const history = (value: unknown, field: string): History | null | undefined => {
    if (value === undefined || value === null) return null;
    const h = object(value, field);
    if (h === undefined) return undefined;
    unknownFields(h, HISTORY_FIELDS, field);
    const liquidityUsd = series(h.liquidityUsd, `${field}.liquidityUsd`);
    const congestion = series(h.congestion, `${field}.congestion`);
    return liquidityUsd && congestion ? { liquidityUsd, congestion } : undefined;
  };

  const venue = (value: unknown, field: string): ExplicitVenue | undefined => {
    const v = object(value, field);
    if (v === undefined) return undefined;
    unknownFields(v, VENUE_FIELDS, field);
    const bridgeUid = nonEmptyString(v.bridgeUid, `${field}.bridgeUid`);
    const liquidityUsd = finiteNumber(v.liquidityUsd, `${field}.liquidityUsd`);
    const congestion = finiteNumber(v.congestion, `${field}.congestion`);
    const h = history(v.history, `${field}.history`);
    if (bridgeUid === undefined || liquidityUsd === undefined || congestion === undefined || h === undefined) {
      return undefined;
    }
    return { bridgeUid, liquidityUsd, congestion, history: h };
  };

  const state = (value: unknown): StateSpec | undefined => {
    if (value === undefined) return fail("state", "is required");
    const s = object(value, "state");
    if (s === undefined) return undefined;
    const mode = s.mode;
    if (mode === undefined) return fail("state.mode", "is required");
    if (typeof mode !== "string" || !(STATE_MODES as readonly string[]).includes(mode)) {
      return fail("state.mode", `must be one of: ${STATE_MODES.join(", ")}`);
    }
    const m = mode as StateSpec["mode"];
    unknownFields(s, STATE_FIELDS[m], "state");
    if (m === "historicalReplay") {
      const d = date(s.date, "state.date");
      return d === undefined ? undefined : { mode: m, date: d };
    }
    if (m === "scenario") {
      const d = date(s.date, "state.date");
      const scenarioId = nonEmptyString(s.scenarioId, "state.scenarioId");
      return d === undefined || scenarioId === undefined ? undefined : { mode: m, date: d, scenarioId };
    }
    const referenceDate = date(s.referenceDate, "state.referenceDate");
    if (s.venues === undefined) return fail("state.venues", "is required");
    if (!Array.isArray(s.venues)) return fail("state.venues", "must be an array");
    const venues = s.venues.map((v, i) => venue(v, `state.venues[${i}]`));
    if (referenceDate === undefined || venues.some((v) => v === undefined)) return undefined;
    return { mode: m, referenceDate, venues: venues as ExplicitVenue[] };
  };

  if (!isObject(body)) return { ok: false, errors: [{ field: "body", message: "must be a JSON object" }] };
  unknownFields(body, TOP_LEVEL, "");
  const senderCountry = nonEmptyString(body.senderCountry, "senderCountry");
  const receiverCountry = nonEmptyString(body.receiverCountry, "receiverCountry");
  const amountUsd = finiteNumber(body.amountUsd, "amountUsd");
  const stateSpec = state(body.state);

  let policy: Policy = DEFAULT_POLICY;
  if (body.policy !== undefined && body.policy !== null) {
    if (typeof body.policy === "string" && (POLICIES as readonly string[]).includes(body.policy)) {
      policy = body.policy as Policy;
    } else {
      fail("policy", `must be one of: ${POLICIES.join(", ")}`);
    }
  }

  let clientReference: string | null = null;
  if (body.clientReference !== undefined && body.clientReference !== null) {
    if (typeof body.clientReference === "string") clientReference = body.clientReference;
    else fail("clientReference", "must be a string");
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      senderCountry: senderCountry!,
      receiverCountry: receiverCountry!,
      amountUsd: amountUsd!,
      state: stateSpec!,
      policy,
      clientReference,
    },
  };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function join(prefix: string, key: string): string {
  return prefix === "" ? key : `${prefix}.${key}`;
}

/** YYYY-MM-DD naming a real calendar day (no Feb 30). */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
