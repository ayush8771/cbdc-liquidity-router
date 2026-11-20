/*
 * MSW handlers for GET /api/v1/replay/calendar and GET /api/v1/state (contract
 * §2.5, §2.6, §3.7). The calendar is contracts/fixtures/app/meta/200_replay_calendar.json.
 * The state handler checks things in the order the backend does
 * (services/backend/src/routes/state.ts):
 * 1. the token (401);
 * 2. the query: `corridor`, `mode` (historicalReplay or scenario) and `date` are
 *    required, `scenarioId` is required with the scenario and refused with the
 *    replay, a repeated parameter is refused, and every problem comes back
 *    together as a 422 VALIDATION_ERROR with details.errors[];
 * 3. what the engine would refuse: an unknown corridor (UNSUPPORTED_CORRIDOR),
 *    a date outside the data (DATE_OUT_OF_RANGE) or inside an excluded range
 *    (DATE_IN_GAP_BUFFER), an unknown scenario (UNKNOWN_SCENARIO), as 422s whose
 *    details.field names the parameter.
 * Then it answers with the contract's fixture where one fits (GBR->PHL on
 * 2024-06-14, replay, or with cheapest_venue_outage) and otherwise with a state
 * built from the network fixture, labelled with the right provenance. The
 * numbers are made up for the tests: they check what the page shows, not the
 * engine's arithmetic.
 */
import { http, HttpResponse } from "msw";
import { contractFixture } from "./fixtures";
import { fixtureNetwork } from "./network";

const VALID_TOKENS = ["mock-analyst", "mock-viewer"];
const KNOWN = ["corridor", "mode", "date", "scenarioId", "includeHistory"];

export type CalendarBody = {
  start: string;
  end: string;
  excludedRanges: { start: string; end: string }[];
  [key: string]: unknown;
};

/** The body of the contract's calendar fixture (a fresh copy each call). */
export const fixtureCalendar = (): CalendarBody =>
  structuredClone(contractFixture("meta/200_replay_calendar.json").response.body) as CalendarBody;

type StateBody = {
  corridor: string;
  state: { mode: string; date: string; split: string; scenarioId: string | null };
  corridorRisk: number;
  baselineCostPct: number;
  venues: Record<string, unknown>[];
  warnings: { code: string; message: string }[];
};

/** The contract's replay state (GBR->PHL, 2024-06-14), a fresh copy. */
export const fixtureReplayState = (): StateBody =>
  structuredClone(contractFixture("meta/200_state_replay.json").response.body) as StateBody;

/** The contract's scenario state (GBR->PHL, 2024-06-14, cheapest_venue_outage), without its history. */
export const fixtureScenarioState = (): StateBody => {
  const body = structuredClone(contractFixture("meta/200_state_scenario_with_history.json").response.body) as StateBody;
  for (const venue of body.venues) delete venue.history;
  return body;
};

const SCENARIOS = ["baseline", "cheapest_venue_outage", "combined_stress", "congestion_x2", "liquidity_minus30", "liquidity_minus50"];

const splitOf = (date: string) => (date >= "2024-01-01" ? "test" : date >= "2022-01-01" ? "validation" : "train");

/** A state for any corridor, date and scenario, built from the network fixture. */
export function generatedState(corridor: string, mode: string, date: string, scenarioId: string | null): StateBody {
  const entry = fixtureNetwork().corridors.find((c) => c.corridor === corridor)!;
  return {
    corridor,
    state: { mode, date, split: splitOf(date), scenarioId },
    corridorRisk: 0.0,
    baselineCostPct: 0.0612,
    venues: entry.venues.map((v, i) => ({
      slot: v.slot,
      bridgeUid: v.bridgeUid,
      feePct: v.feePct,
      liquidityUsd: Math.round(Number(v.baselineCapacityUsd) * (0.5 + i * 0.1)),
      congestion: 0.1 + i * 0.15,
      dataSourceTag: v.dataSourceTag,
      valuesProvenance: mode === "scenario" ? "synthetic_scenario" : "synthetic_simulation",
    })),
    warnings: [],
  };
}

type Problem = { field: string; message: string };

const envelope = (code: string, message: string, details: unknown) => ({
  error: { code, message, details, requestId: "msw-request-1" },
});

export type MonitorHandlerOptions = {
  /** Called with the request URL of every request that reaches the handler. */
  onRequest?: (url: URL, authorization: string | null) => void;
};

function unauthenticated(authorization: string | null) {
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  return token === null || !VALID_TOKENS.includes(token)
    ? HttpResponse.json(envelope("UNAUTHENTICATED", "Missing or invalid token.", {}), { status: 401 })
    : null;
}

export const calendarHandler = (body: unknown = fixtureCalendar(), options: MonitorHandlerOptions = {}) =>
  http.get("*/api/v1/replay/calendar", ({ request }) => {
    const authorization = request.headers.get("Authorization");
    options.onRequest?.(new URL(request.url), authorization);
    return unauthenticated(authorization) ?? HttpResponse.json(body as Record<string, unknown>);
  });

export const stateHandler = (options: MonitorHandlerOptions = {}) =>
  http.get("*/api/v1/state", ({ request }) => {
    const url = new URL(request.url);
    const authorization = request.headers.get("Authorization");
    options.onRequest?.(url, authorization);
    const denied = unauthenticated(authorization);
    if (denied) return denied;

    const problems: Problem[] = [];
    const value = new Map<string, string>();
    for (const name of KNOWN) {
      const all = url.searchParams.getAll(name);
      if (all.length > 1) problems.push({ field: name, message: "Must be given at most once." });
      else if (all.length === 1) value.set(name, all[0]!);
    }
    const corridor = value.get("corridor");
    const mode = value.get("mode");
    const date = value.get("date");
    const scenarioId = value.get("scenarioId");
    if (!corridor) problems.push({ field: "corridor", message: "Required." });
    if (mode === undefined) problems.push({ field: "mode", message: "Required." });
    else if (mode !== "historicalReplay" && mode !== "scenario") {
      problems.push({ field: "mode", message: "Must be one of: historicalReplay, scenario." });
    }
    if (date === undefined) problems.push({ field: "date", message: "Required." });
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
      problems.push({ field: "date", message: "Must be a calendar date, YYYY-MM-DD." });
    }
    if (mode === "scenario" && !scenarioId) problems.push({ field: "scenarioId", message: "Required." });
    if (mode === "historicalReplay" && scenarioId !== undefined) {
      problems.push({ field: "scenarioId", message: "Must not be given with mode historicalReplay." });
    }
    if (problems.length > 0) {
      return HttpResponse.json(envelope("VALIDATION_ERROR", "Request failed validation.", { errors: problems }), { status: 422 });
    }

    // What the engine itself would refuse.
    const known = fixtureNetwork().corridors.some((c) => c.corridor === corridor);
    if (!known) {
      return HttpResponse.json(envelope("UNSUPPORTED_CORRIDOR", "This corridor is not supported.", { field: "corridor" }), { status: 422 });
    }
    const calendar = fixtureCalendar();
    if (date! < calendar.start || date! > calendar.end) {
      return HttpResponse.json(envelope("DATE_OUT_OF_RANGE", "The date is outside the available data.", { field: "date" }), { status: 422 });
    }
    if (calendar.excludedRanges.some((r) => date! >= r.start && date! <= r.end)) {
      return HttpResponse.json(envelope("DATE_IN_GAP_BUFFER", "The date falls within a gap buffer.", { field: "date" }), { status: 422 });
    }
    if (mode === "scenario" && !SCENARIOS.includes(scenarioId!)) {
      return HttpResponse.json(envelope("UNKNOWN_SCENARIO", "Unknown scenario.", { field: "scenarioId" }), { status: 422 });
    }

    if (corridor === "GBR->PHL" && date === "2024-06-14") {
      if (mode === "historicalReplay") return HttpResponse.json(fixtureReplayState());
      if (scenarioId === "cheapest_venue_outage") return HttpResponse.json(fixtureScenarioState());
    }
    return HttpResponse.json(generatedState(corridor!, mode!, date!, mode === "scenario" ? scenarioId! : null));
  });
