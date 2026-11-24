import type {
  FieldErrors,
  FormErrorView,
  FormValues,
  ReferenceData,
  ServerError,
  TransactionPayload,
} from "./types";

const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLIENT_REFERENCE_MAX = 200;

/** A finite number from text, or null. "", "abc", "0x10", "Infinity" and "NaN" are all null. */
export function parseNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!DECIMAL.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** YYYY-MM-DD, and a real calendar date. Whether the engine accepts the date is not decided here. */
export function isIsoDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function initialValues(): FormValues {
  return {
    corridor: "",
    amountUsd: "",
    policy: "waterfall",
    clientReference: "",
    mode: "historicalReplay",
    date: "",
    scenarioId: "",
    referenceDate: "",
    venues: [],
  };
}

function validateDate(value: string): string | null {
  if (value.trim() === "") return "Enter a date.";
  return isIsoDate(value.trim()) ? null : "Use the format YYYY-MM-DD.";
}

/**
 * Checks what the form can check by itself: required fields, number and date
 * format, the client reference length, and policies that are switched off. It
 * does not decide whether a date is eligible or an amount is allowed: the
 * engine is authoritative for those, and a rejection is a result, not an error.
 */
export function validateForm(
  values: FormValues,
  reference: ReferenceData,
): { errors: FieldErrors; payload: TransactionPayload | null } {
  const errors: FieldErrors = {};

  const corridor = reference.corridors.find((c) => c.corridor === values.corridor);
  if (!values.corridor) errors.corridor = "Choose a corridor.";
  else if (!corridor) errors.corridor = "Choose one of the listed corridors.";

  const amount = parseNumber(values.amountUsd);
  if (values.amountUsd.trim() === "") errors.amountUsd = "Enter an amount.";
  else if (amount === null) errors.amountUsd = "Enter a valid number.";
  else if (amount <= 0) errors.amountUsd = "The amount must be greater than 0 and finite.";

  const policy = reference.policies.find((p) => p.policy === values.policy);
  if (policy && !policy.enabled) {
    errors.policy = `${policy.policy === "ppoProjected" ? "PPO (projected)" : policy.policy} is unavailable${
      policy.disabledReason ? `: ${policy.disabledReason}` : ""
    }.`;
  }

  const clientReference = values.clientReference.trim();
  if (Array.from(clientReference).length > CLIENT_REFERENCE_MAX) {
    errors.clientReference = `Use at most ${CLIENT_REFERENCE_MAX} characters.`;
  }

  if (values.mode === "historicalReplay" || values.mode === "scenario") {
    const dateError = validateDate(values.date);
    if (dateError) errors.date = dateError;
  }
  if (values.mode === "scenario" && values.scenarioId === "") errors.scenarioId = "Choose a scenario.";

  if (values.mode === "explicit") {
    const dateError = validateDate(values.referenceDate);
    if (dateError) errors.referenceDate = dateError;
    values.venues.forEach((venue, i) => {
      if (venue.bridgeUid.trim() === "") errors[`venues.${i}.bridgeUid`] = "Enter the venue.";
      for (const key of ["liquidityUsd", "congestion"] as const) {
        const text = venue[key];
        if (text.trim() === "") errors[`venues.${i}.${key}`] = key === "liquidityUsd" ? "Enter the liquidity." : "Enter the congestion.";
        else if (parseNumber(text) === null) errors[`venues.${i}.${key}`] = "Enter a valid number.";
      }
    });
  }

  if (Object.keys(errors).length > 0 || !corridor || amount === null) return { errors, payload: null };

  const state: TransactionPayload["state"] =
    values.mode === "historicalReplay"
      ? { mode: "historicalReplay", date: values.date.trim() }
      : values.mode === "scenario"
        ? { mode: "scenario", date: values.date.trim(), scenarioId: values.scenarioId }
        : {
            mode: "explicit",
            referenceDate: values.referenceDate.trim(),
            venues: values.venues.map((v) => ({
              bridgeUid: v.bridgeUid.trim(),
              liquidityUsd: parseNumber(v.liquidityUsd) ?? 0,
              congestion: parseNumber(v.congestion) ?? 0,
            })),
          };

  return {
    errors,
    payload: {
      senderCountry: corridor.senderCountry,
      receiverCountry: corridor.receiverCountry,
      amountUsd: amount,
      state,
      policy: values.policy,
      ...(clientReference ? { clientReference } : {}),
    },
  };
}

// ---------- server errors ----------

const VENUE_PATH = /^state\.venues\[(\d+)\]\.(bridgeUid|liquidityUsd|congestion)$/;

/** The form field an API path belongs to, or null when no field matches (the error is then form-level). */
export function fieldKeyForPath(path: string): string | null {
  switch (path) {
    case "senderCountry":
    case "receiverCountry":
      return "corridor";
    case "amountUsd":
    case "policy":
    case "clientReference":
      return path;
    case "state.mode":
      return "mode";
    case "state.date":
      return "date";
    case "state.scenarioId":
      return "scenarioId";
    case "state.referenceDate":
      return "referenceDate";
    default: {
      const match = VENUE_PATH.exec(path);
      return match ? `venues.${match[1]}.${match[2]}` : null;
    }
  }
}

/**
 * Whether the engine was still starting up: a 503 INFERENCE_UNAVAILABLE with
 * `details.cause: "NOT_READY"` (contract §4). The cause counts only on that
 * code, so the same cause on another error, or any other cause, is not a
 * start-up. This is the only thing it changes: how the failure is worded. The
 * form never retries on its own, whatever the cause.
 */
export function isNotReady(error: ServerError): boolean {
  return error.code === "INFERENCE_UNAVAILABLE" && error.details.cause === "NOT_READY";
}

/**
 * Turns an error into field errors plus one form-level message. Follows the
 * backend as confirmed: only VALIDATION_ERROR is relied on to carry
 * `details.errors[]`; every other error is form-level, using the backend's own
 * message and request ID. `details.field` is used if it is there, never required.
 */
export function describeFailure(error: ServerError): { fields: FieldErrors; form: FormErrorView } {
  const fields: FieldErrors = {};
  const messages: string[] = [];

  if (error.code === "VALIDATION_ERROR") {
    for (const item of error.details.errors ?? []) {
      const key = item.field ? fieldKeyForPath(item.field) : null;
      if (key) fields[key] ??= item.message;
      else messages.push(item.field ? `${item.field}: ${item.message}` : item.message);
    }
    if (messages.length === 0) messages.push(error.message);
  } else {
    messages.push(error.message);
    const key = error.details.field ? fieldKeyForPath(error.details.field) : null;
    if (key) fields[key] = error.message;
  }

  const title = isNotReady(error)
    ? "The routing engine is starting up"
    : error.code === "VALIDATION_ERROR"
      ? "The request failed validation"
      : error.status >= 500
        ? "Routing failed"
        : "The request wasn't accepted";
  return { fields, form: { title, messages, code: error.code, requestId: error.requestId } };
}
