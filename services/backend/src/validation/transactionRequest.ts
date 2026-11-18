// The POST /api/v1/transactions request (API contract §3.2, §2.4). Mostly
// shape and type checks. The remaining domain rules stay in the inference
// service, which owns them and has its own error codes (§2.4, §4): supported
// corridor, date range and gap buffers, known scenario, venues matching the
// corridor, non-negative values, and the last history value equalling the
// current one.
//
// Two outcomes, in the precedence §3.2 approves:
//   1. VALIDATION_ERROR: every schema problem at once, in details.errors[].
//   2. INVALID_AMOUNT, only when the body is otherwise valid: a finite
//      amountUsd of zero or less. The code is preserved rather than folded
//      into VALIDATION_ERROR (owner decision), and the route sends it with
//      details.field = "amountUsd".
// So a bad country code and a zero amount give VALIDATION_ERROR, naming the
// country and not the amount.
//
// What is checked here:
// - The body is a JSON object. Required: senderCountry and receiverCountry
//   (exactly three upper-case letters, §3.2), amountUsd (a finite number),
//   state.
// - amountUsd must be greater than 0 (§3.2). The check runs here, before
//   inference, so a failed record can never store a non-positive amount.
// - policy: waterfall, cheapestFeasible or ppoProjected. An omitted policy
//   means waterfall (§2.8 default); policy: null is rejected (§3.2).
// - state.mode selects the structure:
//   - historicalReplay: date
//   - scenario: date, scenarioId (a non-empty string, passed on unchanged)
//   - explicit: referenceDate, venues[]; each venue has bridgeUid,
//     liquidityUsd, congestion and optional history {liquidityUsd[30],
//     congestion[30]} (or null)
//   Dates are YYYY-MM-DD calendar dates (§1). Numbers must be finite: a value
//   like 1e400 parses to Infinity, which JSON can't carry to inference.
// - Unsafe integers (§2.11, owner decision): every number (amountUsd, venue
//   liquidityUsd and congestion, every history element) that is integer-valued
//   with an absolute value above Number.MAX_SAFE_INTEGER (2^53 - 1) is
//   rejected, never rounded. The rule applies to the parsed value, not its
//   spelling: 9007199254740993, 9007199254740992.0, 9.007199254740992e15 and
//   1e21 are all rejected. Accepted numbers are passed on unchanged, so the
//   values checked here are the values the inference mapper sends.
// - Unknown fields inside state, a venue or history are rejected (§2.4).
//
// - clientReference: a string of at most 200 Unicode code points, or omitted
//   or null (§3.2). The limit counts code points ([...s].length), not UTF-16
//   units, so one astral character such as an emoji counts as one. Empty
//   strings are allowed.
//
// PROVISIONAL (unspecified in the contract):
// - Unknown top-level fields are rejected too, for §2.4's reason: a misspelt
//   "polcy" would otherwise route silently with the default policy.
// - null counts as omitted for clientReference only; for policy it is an error.
// - Errors use details.errors[] = [{field, message}], with paths such as
//   "state.venues[1].history.congestion", as in GET /api/v1/transactions.
//   A body that isn't an object is a form-level error with no field (§4).
//   Messages are the fixed sentences in MESSAGES (§3.2 "No echoing").

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
  /** Omitted for an error about no single field (§4), never an empty string. */
  field?: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; value: TransactionRequest }
  /** Schema problems, all of them, as details.errors[] (§3.2 precedence step 1). */
  | { ok: false; code: "VALIDATION_ERROR"; errors: FieldError[] }
  /** An otherwise valid body whose finite amountUsd is zero or less (step 2). */
  | { ok: false; code: "INVALID_AMOUNT"; field: "amountUsd" };

/** Exactly three upper-case letters (§3.2). `[A-Z]` is ASCII-only, as intended. */
const COUNTRY_CODE = /^[A-Z]{3}$/;

/** The §3.2 fixed text, quoted by the contract and by the §4 fixtures. */
export const COUNTRY_CODE_MESSAGE = "Must be three upper-case letters.";

export const CLIENT_REFERENCE_MAX_CODE_POINTS = 200;
export const CLIENT_REFERENCE_MESSAGE = `Must be at most ${CLIENT_REFERENCE_MAX_CODE_POINTS} characters (Unicode code points).`;

/**
 * The fixed details.errors[].message texts (§3.2 "No echoing", §4). None
 * repeats a caller-supplied value. "Unknown field." and "Must be three
 * upper-case letters." are the fixtures' exact texts; the rest follow them.
 */
export const MESSAGES = Object.freeze({
  required: "Required.",
  unknownField: "Unknown field.",
  object: "Must be an object.",
  jsonObject: "Must be a JSON object.",
  array: "Must be an array.",
  string: "Must be a string.",
  nonEmptyString: "Must be a non-empty string.",
  finiteNumber: "Must be a finite number.",
  date: "Must be a date in YYYY-MM-DD form.",
  history: `Must be an array of exactly ${HISTORY_LENGTH} numbers.`,
  stateMode: `Must be one of: ${STATE_MODES.join(", ")}.`,
  policy: `Must be one of: ${POLICIES.join(", ")}.`,
});

/** The VALIDATION_ERROR envelope message, the same wherever the code is raised (§4). */
export const VALIDATION_ERROR_MESSAGE = "Request failed validation.";

/** The §3.2/§4 message for the backend's own INVALID_AMOUNT. */
export const INVALID_AMOUNT_MESSAGE = "The amount must be greater than 0 and finite.";

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
    isObject(value) ? value : fail(field, MESSAGES.object);
  const unknownFields = (value: JsonObject, allowed: readonly string[], prefix: string): void => {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) fail(join(prefix, key), MESSAGES.unknownField);
    }
  };
  const nonEmptyString = (value: unknown, field: string): string | undefined => {
    if (value === undefined) return fail(field, MESSAGES.required);
    return typeof value === "string" && value.length > 0 ? value : fail(field, MESSAGES.nonEmptyString);
  };
  // One message for everything that isn't three upper-case letters, including
  // a non-string, so no caller-supplied value is echoed (§3.2).
  const countryCode = (value: unknown, field: string): string | undefined => {
    if (value === undefined) return fail(field, MESSAGES.required);
    return typeof value === "string" && COUNTRY_CODE.test(value) ? value : fail(field, COUNTRY_CODE_MESSAGE);
  };
  const finiteNumber = (value: unknown, field: string): number | undefined => {
    if (value === undefined) return fail(field, MESSAGES.required);
    const problem = numberProblem(value);
    return problem === null ? (value as number) : fail(field, problem);
  };
  const date = (value: unknown, field: string): string | undefined => {
    if (value === undefined) return fail(field, MESSAGES.required);
    return typeof value === "string" && isCalendarDate(value) ? value : fail(field, MESSAGES.date);
  };
  const series = (value: unknown, field: string): number[] | undefined => {
    if (value === undefined) return fail(field, MESSAGES.required);
    if (!Array.isArray(value) || value.length !== HISTORY_LENGTH) {
      return fail(field, MESSAGES.history);
    }
    const bad = value.findIndex((n) => numberProblem(n) !== null);
    return bad === -1 ? [...(value as number[])] : fail(`${field}[${bad}]`, numberProblem(value[bad])!);
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
    if (value === undefined) return fail("state", MESSAGES.required);
    const s = object(value, "state");
    if (s === undefined) return undefined;
    const mode = s.mode;
    if (mode === undefined) return fail("state.mode", MESSAGES.required);
    if (typeof mode !== "string" || !(STATE_MODES as readonly string[]).includes(mode)) {
      return fail("state.mode", MESSAGES.stateMode);
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
    if (s.venues === undefined) return fail("state.venues", MESSAGES.required);
    if (!Array.isArray(s.venues)) return fail("state.venues", MESSAGES.array);
    const venues = s.venues.map((v, i) => venue(v, `state.venues[${i}]`));
    if (referenceDate === undefined || venues.some((v) => v === undefined)) return undefined;
    return { mode: m, referenceDate, venues: venues as ExplicitVenue[] };
  };

  if (!isObject(body)) {
    // About no single field, so field is omitted (§4: a form-level error).
    return { ok: false, code: "VALIDATION_ERROR", errors: [{ message: MESSAGES.jsonObject }] };
  }
  unknownFields(body, TOP_LEVEL, "");
  const senderCountry = countryCode(body.senderCountry, "senderCountry");
  const receiverCountry = countryCode(body.receiverCountry, "receiverCountry");
  const amountUsd = finiteNumber(body.amountUsd, "amountUsd");
  const stateSpec = state(body.state);

  // null is not "omitted" here: only an absent policy defaults (§3.2).
  let policy: Policy = DEFAULT_POLICY;
  if (body.policy !== undefined) {
    if (typeof body.policy === "string" && (POLICIES as readonly string[]).includes(body.policy)) {
      policy = body.policy as Policy;
    } else {
      fail("policy", MESSAGES.policy);
    }
  }

  let clientReference: string | null = null;
  if (body.clientReference !== undefined && body.clientReference !== null) {
    if (typeof body.clientReference !== "string") fail("clientReference", MESSAGES.string);
    // Code points, not UTF-16 units: [...s] iterates by code point.
    else if ([...body.clientReference].length > CLIENT_REFERENCE_MAX_CODE_POINTS) {
      fail("clientReference", CLIENT_REFERENCE_MESSAGE);
    } else clientReference = body.clientReference;
  }

  if (errors.length > 0) return { ok: false, code: "VALIDATION_ERROR", errors };
  // Step 2: reached only with no schema problem, so amountUsd is a finite
  // number. -0 counts as zero and is rejected.
  if (amountUsd! <= 0) return { ok: false, code: "INVALID_AMOUNT", field: "amountUsd" };
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

export const UNSAFE_INTEGER_MESSAGE = `Must not be an integer beyond ±${Number.MAX_SAFE_INTEGER}; unsafe integers are rejected, not rounded.`;

/** null for an acceptable number; otherwise the error message (§2.11). */
function numberProblem(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return MESSAGES.finiteNumber;
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) return UNSAFE_INTEGER_MESSAGE;
  return null;
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
