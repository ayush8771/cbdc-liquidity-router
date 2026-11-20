/*
 * GET /api/v1/state and GET /api/v1/replay/calendar (contract §2.5, §2.6, §3.7)
 * for the desktop Bridge monitor. Nothing here invents a value: the API's
 * numbers are copied, a null stays null, and no availability or status is
 * derived from them.
 */
import { ApiError, INVALID_RESPONSE, type ApiClient } from "../../api/client";
import { isApiCalendar, isApiState, type ApiCalendar, type ApiState } from "../../api/types";
import type { DataSourceTag } from "../transactions/detailTypes";
import type { CorridorStateView, MonitorMode } from "./types";

const unreadable = () =>
  new ApiError({ status: 200, code: INVALID_RESPONSE, message: "The server's response could not be read." });

// ---------- the calendar: which dates the engine accepts ----------

export async function fetchCalendar(api: ApiClient): Promise<ApiCalendar> {
  const raw = await api.get<unknown>("/replay/calendar");
  if (!isApiCalendar(raw)) throw unreadable();
  return raw;
}

function previousDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** The excluded range that contains `day`, or null. Dates are YYYY-MM-DD, so string order is date order. */
export function excludedRangeOf(calendar: ApiCalendar, day: string): { start: string; end: string } | null {
  return calendar.excludedRanges.find((r) => day >= r.start && day <= r.end) ?? null;
}

/**
 * The latest date the engine accepts: counting back from the calendar's end,
 * the first day that is not inside an excluded range (the gap buffers at each
 * split boundary and at the data's ends). Null if no day qualifies.
 */
export function latestEligibleDate(calendar: ApiCalendar): string | null {
  let day = calendar.end;
  while (day >= calendar.start) {
    const range = excludedRangeOf(calendar, day);
    if (!range) return day;
    day = previousDay(range.start); // jump past the whole excluded range
  }
  return null;
}

/** Why the calendar says this date can't be used, or null when it can. The engine stays the authority. */
export function dateProblem(calendar: ApiCalendar, day: string): string | null {
  if (day < calendar.start || day > calendar.end) {
    return `No data for this date. The data runs from ${calendar.start} to ${calendar.end}.`;
  }
  const range = excludedRangeOf(calendar, day);
  return range
    ? `This date isn't available: it falls in an excluded range (${range.start} to ${range.end}), near a split boundary or an end of the data.`
    : null;
}

// ---------- one corridor's state ----------

export type StateRequest = {
  corridor: string;
  mode: MonitorMode;
  /** YYYY-MM-DD. */
  date: string;
  /** Only with the scenario mode. */
  scenarioId?: string;
};

/** The request's query: `scenarioId` only for a scenario, and no history (the monitor doesn't use it). */
export function toStateQuery(request: StateRequest) {
  return {
    corridor: request.corridor,
    mode: request.mode,
    date: request.date,
    scenarioId: request.mode === "scenario" ? request.scenarioId : undefined,
  };
}

export function mapState(state: ApiState): CorridorStateView {
  return {
    corridor: state.corridor,
    mode: state.state.mode,
    date: state.state.date,
    split: state.state.split,
    scenarioId: state.state.scenarioId,
    corridorRisk: state.corridorRisk,
    baselineCostPct: state.baselineCostPct,
    venues: state.venues.map((v) => ({
      slot: v.slot,
      bridgeUid: v.bridgeUid,
      feePct: v.feePct,
      liquidityUsd: v.liquidityUsd,
      congestion: v.congestion,
      // Passed through as it came; the table prints an unknown tag as written.
      dataSourceTag: v.dataSourceTag as DataSourceTag,
      valuesProvenance: v.valuesProvenance,
    })),
    warnings: state.warnings.map((w) => ({ code: w.code, message: w.message })),
  };
}

/**
 * One request for one corridor. A body that isn't the documented shape, or is
 * for another corridor, date or scenario than the one asked for, is an
 * INVALID_RESPONSE error: it must never be shown under the wrong heading.
 */
export async function fetchCorridorState(api: ApiClient, request: StateRequest): Promise<CorridorStateView> {
  const raw = await api.get<unknown>("/state", { query: toStateQuery(request) });
  if (!isApiState(raw)) throw unreadable();
  const answered = raw.state;
  const sameScenario = request.mode === "scenario" ? answered.scenarioId === request.scenarioId : answered.scenarioId === null;
  if (raw.corridor !== request.corridor || answered.date !== request.date || answered.mode !== request.mode || !sameScenario) {
    throw unreadable();
  }
  return mapState(raw);
}

// ---------- what to tell the user ----------

/** Where an error belongs: on a control, or on the corridor's own card. */
export type StateErrorTarget = "date" | "scenario" | "card";

export type StateErrorView = {
  target: StateErrorTarget;
  message: string;
  /** Field messages the server gave for a 422 it couldn't place on a control, as "field: message". */
  details: string[];
  /** The request ID, for the user to quote. */
  reference: string | undefined;
  /** Whether asking again can help. */
  canRetry: boolean;
};

const DATE_FIELDS = ["date", "state.date"];
const SCENARIO_FIELDS = ["scenarioId", "state.scenarioId"];

/**
 * What to tell the user. The wording is this UI's own, chosen by `code`,
 * `status` and `details.cause`, never by the backend's message. A date or
 * scenario problem belongs on its control (and is not worth retrying until the
 * control changes); anything else belongs on the corridor's card.
 */
export function describeStateError(error: unknown, corridor: string): StateErrorView {
  if (!(error instanceof ApiError)) {
    return { target: "card", message: "Something went wrong while loading this corridor.", details: [], reference: undefined, canRetry: true };
  }
  const reference = error.requestId ?? undefined;
  const make = (target: StateErrorTarget, message: string, canRetry = true, details: string[] = []): StateErrorView => ({
    target,
    message,
    details,
    reference,
    canRetry,
  });

  switch (error.code) {
    case "DATE_OUT_OF_RANGE":
      return make("date", "The engine has no data for this date. Choose a date inside the data's range.", false);
    case "DATE_IN_GAP_BUFFER":
      return make("date", "This date is within 30 days of a split boundary, so the engine doesn't accept it. Choose another date.", false);
    case "UNKNOWN_SCENARIO":
      return make("scenario", "The engine doesn't know this scenario. Choose one from the list.", false);
    case "UNSUPPORTED_CORRIDOR":
      return make("card", `The engine doesn't support ${corridor}.`, false);
    case "NETWORK_ERROR":
      return make("card", "The server could not be reached. Check your connection, then try again.");
    case INVALID_RESPONSE:
      return make("card", "The server sent a response this page couldn't read.");
    case "INFERENCE_UNAVAILABLE":
      return error.details.cause === "NOT_READY"
        ? make("card", "The routing engine is starting up, so this corridor isn't available yet. Try again in a moment.")
        : make("card", "The routing engine is unavailable, so this corridor can't be loaded. Try again in a moment.");
    case "ENGINE_BUSY":
      return make("card", "The routing engine is busy. Try again in a moment.");
    case "ENGINE_TIMEOUT":
      return make("card", "The routing engine did not answer in time. Try again.");
    default:
      break;
  }

  if (error.status === 422) {
    const items = error.details.errors ?? [];
    const onDate = items.find((e) => e.field && DATE_FIELDS.includes(e.field));
    if (onDate) return make("date", onDate.message, false);
    const onScenario = items.find((e) => e.field && SCENARIO_FIELDS.includes(e.field));
    if (onScenario) return make("scenario", onScenario.message, false);
    const details = items.map((e) => (e.field ? `${e.field}: ${e.message}` : e.message));
    return make("card", "The server didn't accept this request.", false, details);
  }
  if (error.status === 403) return make("card", "You don't have access to the bridge state.", false);
  if (error.status >= 500) return make("card", "The server hit an unexpected error. Try again in a moment.");
  return make("card", `The request failed (${error.code}).`);
}
