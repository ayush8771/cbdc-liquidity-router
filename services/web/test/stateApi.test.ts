import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, INVALID_RESPONSE, NETWORK_ERROR } from "../src/api/client";
import { isApiCalendar, isApiState, type ApiCalendar, type ApiState } from "../src/api/types";
import { readMonitorParams, updateMonitorParams } from "../src/features/bridges/monitorQuery";
import {
  dateProblem,
  describeStateError,
  excludedRangeOf,
  fetchCalendar,
  fetchCorridorState,
  latestEligibleDate,
  mapState,
  toStateQuery,
} from "../src/features/bridges/stateApi";
import { modeName, valuesProvenanceName } from "../src/features/bridges/types";
import { fixtureCalendar, fixtureReplayState, fixtureScenarioState, generatedState } from "./msw/monitor";

const calendar = () => fixtureCalendar() as unknown as ApiCalendar;
const state = () => fixtureReplayState() as unknown as ApiState;

function clientReturning(body: unknown, init: ResponseInit = {}) {
  const fetchImpl = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" }, ...init }),
  );
  return { api: createApiClient({ getToken: () => "t", fetchImpl }), fetchImpl };
}

describe("the calendar: the latest eligible date", () => {
  it("is 30 August 2025 for the contract's calendar, which excludes 31 August to 30 September", () => {
    expect(latestEligibleDate(calendar())).toBe("2025-08-30");
  });

  it("is the end itself when the end is not excluded", () => {
    expect(latestEligibleDate({ start: "2024-01-01", end: "2024-12-31", excludedRanges: [] })).toBe("2024-12-31");
  });

  it("skips every excluded range, including ranges that touch each other", () => {
    const c: ApiCalendar = {
      start: "2024-01-01",
      end: "2024-09-30",
      excludedRanges: [
        { start: "2024-09-01", end: "2024-09-30" },
        { start: "2024-08-01", end: "2024-08-31" }, // starts the day the next one ends
        { start: "2024-07-15", end: "2024-07-31" },
      ],
    };
    expect(latestEligibleDate(c)).toBe("2024-07-14");
  });

  it("copes with ranges given out of order, and with a range that reaches past the end", () => {
    const c: ApiCalendar = {
      start: "2024-01-01",
      end: "2024-09-30",
      excludedRanges: [
        { start: "2024-08-01", end: "2024-08-31" },
        { start: "2024-09-01", end: "2024-12-31" },
      ],
    };
    expect(latestEligibleDate(c)).toBe("2024-07-31");
  });

  it("is null when every day is excluded", () => {
    expect(latestEligibleDate({ start: "2024-01-01", end: "2024-01-31", excludedRanges: [{ start: "2023-12-01", end: "2024-02-29" }] })).toBeNull();
  });

  it("never picks a date the calendar itself rejects, for any end in the contract's calendar", () => {
    const c = calendar();
    for (const end of ["2025-09-30", "2025-08-30", "2024-01-15", "2023-12-01", "2022-02-01", "2011-02-01"]) {
      const day = latestEligibleDate({ ...c, end });
      expect(day).not.toBeNull();
      expect(dateProblem(c, day!)).toBeNull();
    }
  });

  it("finds the excluded range of a date, or none", () => {
    expect(excludedRangeOf(calendar(), "2025-09-15")).toEqual({ start: "2025-08-31", end: "2025-09-30" });
    expect(excludedRangeOf(calendar(), "2024-06-14")).toBeNull();
    expect(excludedRangeOf(calendar(), "2021-12-01")).toEqual({ start: "2021-12-01", end: "2022-01-31" });
  });

  it("explains why a date can't be used, and accepts an eligible one", () => {
    const c = calendar();
    expect(dateProblem(c, "2024-06-14")).toBeNull();
    expect(dateProblem(c, "2010-12-31")).toMatch(/No data for this date.*2011-01-01 to 2025-09-30/);
    expect(dateProblem(c, "2025-10-01")).toMatch(/No data for this date/);
    expect(dateProblem(c, "2025-09-15")).toMatch(/excluded range \(2025-08-31 to 2025-09-30\)/);
    expect(dateProblem(c, "2023-12-01")).toMatch(/excluded range/);
    expect(dateProblem(c, "2011-01-01")).toMatch(/excluded range \(2011-01-01 to 2011-01-31\)/);
  });
});

describe("the calendar's strict check", () => {
  it("accepts the contract's calendar and ignores extra fields", () => {
    expect(isApiCalendar(fixtureCalendar())).toBe(true);
    expect(isApiCalendar({ ...fixtureCalendar(), extra: 1 })).toBe(true);
  });

  it.each([
    ["null", null],
    ["a start that isn't a date", { ...fixtureCalendar(), start: "2011-13-01" }],
    ["an end that isn't a real day", { ...fixtureCalendar(), end: "2025-02-30" }],
    ["a start after the end", { ...fixtureCalendar(), start: "2026-01-01" }],
    ["no excluded ranges list", { ...fixtureCalendar(), excludedRanges: undefined }],
    ["a range that ends before it starts", { ...fixtureCalendar(), excludedRanges: [{ start: "2024-02-01", end: "2024-01-01" }] }],
    ["a range with a bad date", { ...fixtureCalendar(), excludedRanges: [{ start: "soon", end: "2024-01-01" }] }],
  ])("rejects %s", (_name, body) => {
    expect(isApiCalendar(body)).toBe(false);
  });

  it("fetchCalendar asks for /replay/calendar and refuses a body that isn't a calendar", async () => {
    const ok = clientReturning(fixtureCalendar());
    await expect(fetchCalendar(ok.api)).resolves.toMatchObject({ start: "2011-01-01", end: "2025-09-30" });
    expect(String(ok.fetchImpl.mock.calls[0]![0])).toBe(`${window.location.origin}/api/v1/replay/calendar`);
    await expect(fetchCalendar(clientReturning({ start: "x" }).api)).rejects.toMatchObject({ code: INVALID_RESPONSE });
  });
});

describe("the state's strict check", () => {
  it("accepts both contract fixtures, a state with no venues, and extra fields (such as history)", () => {
    expect(isApiState(fixtureReplayState())).toBe(true);
    expect(isApiState(fixtureScenarioState())).toBe(true);
    expect(isApiState({ ...state(), venues: [] })).toBe(true);
    const withHistory = state();
    (withHistory.venues[0] as unknown as Record<string, unknown>).history = { dates: [], liquidityUsd: [], congestion: [] };
    expect(isApiState({ ...withHistory, extra: 1 })).toBe(true);
  });

  const broken = (change: (s: ApiState) => void) => {
    const s = state();
    change(s);
    return s;
  };

  it.each([
    ["null", () => null],
    ["no corridor", () => ({ ...state(), corridor: undefined })],
    ["a state with no date", () => broken((s) => ((s.state as unknown as Record<string, unknown>).date = undefined))],
    ["a date that isn't a real day", () => broken((s) => (s.state.date = "2024-02-31"))],
    ["a scenario ID that is a number", () => broken((s) => ((s.state as unknown as Record<string, unknown>).scenarioId = 5))],
    ["a negative corridor risk", () => broken((s) => (s.corridorRisk = -0.1))],
    ["a baseline cost that is a string", () => broken((s) => ((s as unknown as Record<string, unknown>).baselineCostPct = "0.06"))],
    ["a venue with negative liquidity", () => broken((s) => (s.venues[0]!.liquidityUsd = -1))],
    ["a venue with negative congestion", () => broken((s) => (s.venues[0]!.congestion = -0.2))],
    ["a venue with a fee that is not finite", () => broken((s) => (s.venues[0]!.feePct = Number.POSITIVE_INFINITY))],
    ["a venue with a fractional slot", () => broken((s) => (s.venues[0]!.slot = 0.5))],
    ["a venue with no provenance", () => broken((s) => delete (s.venues[0] as Partial<ApiState["venues"][0]>).valuesProvenance)],
    ["a venue with no data-source tag", () => broken((s) => delete (s.venues[0] as Partial<ApiState["venues"][0]>).dataSourceTag)],
    ["a repeated venue", () => broken((s) => (s.venues[1]!.bridgeUid = s.venues[0]!.bridgeUid))],
    ["a repeated slot", () => broken((s) => (s.venues[1]!.slot = s.venues[0]!.slot))],
    ["warnings that aren't {code, message}", () => broken((s) => ((s as unknown as Record<string, unknown>).warnings = [{ code: 1 }]))],
    ["venues that isn't a list", () => ({ ...state(), venues: {} })],
  ])("rejects %s", (_name, make) => {
    expect(isApiState(make())).toBe(false);
  });
});

describe("mapState and fetchCorridorState", () => {
  it("copies every number unchanged: congestion stays raw, fees stay fractions, nothing becomes a status", () => {
    const raw = state();
    const view = mapState(raw);
    expect(view.corridor).toBe("GBR->PHL");
    expect(view).toMatchObject({ mode: "historicalReplay", date: "2024-06-14", split: "test", scenarioId: null, corridorRisk: 0, baselineCostPct: 0.0612 });
    expect(view.venues[0]).toEqual(raw.venues[0]);
    expect(view.venues[0]).toMatchObject({ slot: 0, feePct: 0.02, liquidityUsd: 412345.6, congestion: 0.31 });
    expect(view.warnings).toEqual(raw.warnings);
    for (const venue of view.venues) expect(Object.keys(venue).sort()).toEqual(["bridgeUid", "congestion", "dataSourceTag", "feePct", "liquidityUsd", "slot", "valuesProvenance"]);
  });

  it("keeps an unknown data-source tag and provenance as written", () => {
    const raw = state();
    raw.venues[0] = { ...raw.venues[0]!, dataSourceTag: "future_tag", valuesProvenance: "future_provenance" };
    const venue = mapState(raw).venues[0]!;
    expect(venue.dataSourceTag).toBe("future_tag");
    expect(valuesProvenanceName(venue.valuesProvenance)).toBe("future_provenance");
    expect(modeName("future_mode")).toBe("future_mode");
  });

  it("names the provenances and modes it knows", () => {
    expect(valuesProvenanceName("synthetic_simulation")).toBe("Synthetic simulation");
    expect(valuesProvenanceName("synthetic_scenario")).toBe("Synthetic scenario");
    expect(modeName("historicalReplay")).toBe("Historical replay");
    expect(modeName("scenario")).toBe("Scenario");
  });

  it("asks for the corridor, mode and date, with the scenario only for the scenario mode, and no history", async () => {
    expect(toStateQuery({ corridor: "GBR->PHL", mode: "historicalReplay", date: "2024-06-14", scenarioId: "baseline" })).toEqual({
      corridor: "GBR->PHL",
      mode: "historicalReplay",
      date: "2024-06-14",
      scenarioId: undefined,
    });
    const { api, fetchImpl } = clientReturning(fixtureScenarioState());
    await fetchCorridorState(api, { corridor: "GBR->PHL", mode: "scenario", date: "2024-06-14", scenarioId: "cheapest_venue_outage" });
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.pathname).toBe("/api/v1/state");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      corridor: "GBR->PHL",
      mode: "scenario",
      date: "2024-06-14",
      scenarioId: "cheapest_venue_outage",
    });
    expect(url.searchParams.has("includeHistory")).toBe(false);
  });

  it.each([
    ["a body that isn't a state", { hello: "world" }],
    ["a state for another corridor", generatedState("USA->IND", "historicalReplay", "2024-06-14", null)],
    ["a state for another date", generatedState("GBR->PHL", "historicalReplay", "2024-06-13", null)],
    ["a scenario state when the replay was asked for", generatedState("GBR->PHL", "scenario", "2024-06-14", "baseline")],
  ])("refuses %s, so it is never shown under the wrong heading", async (_name, body) => {
    const { api } = clientReturning(body);
    await expect(
      fetchCorridorState(api, { corridor: "GBR->PHL", mode: "historicalReplay", date: "2024-06-14" }),
    ).rejects.toMatchObject({ code: INVALID_RESPONSE });
  });

  it("refuses a replay state when a scenario was asked for, and a state for another scenario", async () => {
    const request = { corridor: "GBR->PHL", mode: "scenario" as const, date: "2024-06-14", scenarioId: "baseline" };
    await expect(fetchCorridorState(clientReturning(fixtureReplayState()).api, request)).rejects.toMatchObject({ code: INVALID_RESPONSE });
    await expect(fetchCorridorState(clientReturning(fixtureScenarioState()).api, request)).rejects.toMatchObject({ code: INVALID_RESPONSE });
  });
});

describe("describeStateError", () => {
  const api = (status: number, code: string, extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {}) =>
    new ApiError({ status, code, message: "BACKEND TEXT", ...extra });

  it("puts a date or scenario problem on its control, with no retry", () => {
    const date = describeStateError(api(422, "DATE_IN_GAP_BUFFER", { details: { field: "date" } }), "GBR->PHL");
    expect(date).toMatchObject({ target: "date", canRetry: false });
    expect(describeStateError(api(422, "DATE_OUT_OF_RANGE"), "GBR->PHL")).toMatchObject({ target: "date", canRetry: false });
    expect(describeStateError(api(422, "UNKNOWN_SCENARIO"), "GBR->PHL")).toMatchObject({ target: "scenario", canRetry: false });
  });

  it("places a VALIDATION_ERROR on the control it names, using the server's field message", () => {
    const onDate = describeStateError(
      api(422, "VALIDATION_ERROR", { details: { errors: [{ field: "date", message: "Must be a calendar date." }] } }),
      "GBR->PHL",
    );
    expect(onDate).toMatchObject({ target: "date", message: "Must be a calendar date." });
    const onScenario = describeStateError(
      api(422, "VALIDATION_ERROR", { details: { errors: [{ field: "scenarioId", message: "Required." }] } }),
      "GBR->PHL",
    );
    expect(onScenario).toMatchObject({ target: "scenario", message: "Required." });
  });

  it("keeps any other 422 on the card, with its field messages", () => {
    const view = describeStateError(
      api(422, "VALIDATION_ERROR", { details: { errors: [{ field: "corridor", message: "Required." }, { message: "Form-level." }] } }),
      "GBR->PHL",
    );
    expect(view).toMatchObject({ target: "card", canRetry: false });
    expect(view.details).toEqual(["corridor: Required.", "Form-level."]);
    expect(describeStateError(api(422, "UNSUPPORTED_CORRIDOR"), "XXX->YYY").message).toContain("XXX->YYY");
  });

  it("keeps everything else on the card, with a retry for what can pass", () => {
    for (const error of [api(0, NETWORK_ERROR), api(200, INVALID_RESPONSE), api(503, "INFERENCE_UNAVAILABLE"), api(503, "ENGINE_BUSY"), api(504, "ENGINE_TIMEOUT"), api(500, "INTERNAL_ERROR"), api(502, "INFERENCE_ERROR")]) {
      expect(describeStateError(error, "GBR->PHL")).toMatchObject({ target: "card", canRetry: true });
    }
    expect(describeStateError(api(403, "X"), "GBR->PHL")).toMatchObject({ target: "card", canRetry: false });
  });

  it("words every case itself, never with the backend's message, and says starting up only for NOT_READY", () => {
    for (const error of [api(0, NETWORK_ERROR), api(200, INVALID_RESPONSE), api(503, "INFERENCE_UNAVAILABLE"), api(500, "INTERNAL_ERROR"), api(418, "TEAPOT"), api(422, "DATE_OUT_OF_RANGE")]) {
      expect(describeStateError(error, "GBR->PHL").message).not.toContain("BACKEND TEXT");
    }
    expect(describeStateError(api(503, "INFERENCE_UNAVAILABLE", { details: { cause: "NOT_READY" } }), "GBR->PHL").message).toMatch(/starting up/);
    expect(describeStateError(api(503, "INFERENCE_UNAVAILABLE"), "GBR->PHL").message).not.toMatch(/starting up/);
    expect(describeStateError(api(500, "INTERNAL_ERROR", { requestId: "req-1" }), "GBR->PHL").reference).toBe("req-1");
    expect(describeStateError(new Error("x"), "GBR->PHL").message).toMatch(/went wrong/);
  });
});

describe("the monitor's URL", () => {
  const read = (search: string) => readMonitorParams(new URLSearchParams(search));

  it("defaults to replay, all corridors and no date", () => {
    expect(read("")).toEqual({ selection: { mode: "historicalReplay" }, problems: {} });
  });

  it("reads each selection", () => {
    expect(read("corridor=GBR-%3EPHL&mode=scenario&date=2024-06-14&scenarioId=baseline")).toEqual({
      selection: { corridor: "GBR->PHL", mode: "scenario", date: "2024-06-14", scenarioId: "baseline" },
      problems: {},
    });
  });

  it("reports what can't be used, and does not apply it", () => {
    expect(read("corridor=XXX").problems.corridor).toBeTruthy();
    expect(read("corridor=XXX").selection.corridor).toBeUndefined();
    expect(read("mode=other").problems.mode).toBeTruthy();
    expect(read("date=2024-02-31").problems.date).toMatch(/YYYY-MM-DD/);
    expect(read("date=soon").selection.date).toBeUndefined();
    expect(read("scenarioId=baseline").problems.scenarioId).toMatch(/Scenario mode/);
    expect(read("date=2024-06-14&date=2024-06-15").problems.date).toMatch(/more than once/);
    expect(read("corridor=GBR-%3EPHL&corridor=USA-%3EIND").problems.corridor).toMatch(/more than once/);
  });

  it("treats an empty value as not given", () => {
    expect(read("corridor=&date=&mode=")).toEqual({ selection: { mode: "historicalReplay" }, problems: {} });
  });

  it("writes a change, leaves unrelated parameters alone, and drops the scenario with the scenario mode", () => {
    const start = new URLSearchParams("mode=scenario&scenarioId=baseline&date=2024-06-14&keep=1");
    expect(updateMonitorParams(start, { corridor: "USA->IND" }).toString()).toBe("mode=scenario&scenarioId=baseline&date=2024-06-14&keep=1&corridor=USA-%3EIND");
    expect(updateMonitorParams(start, { mode: "historicalReplay", scenarioId: undefined }).toString()).toBe("date=2024-06-14&keep=1");
    expect(updateMonitorParams(start, { date: undefined }).toString()).toBe("mode=scenario&scenarioId=baseline&keep=1");
    expect(updateMonitorParams(new URLSearchParams(""), { mode: "scenario" }).toString()).toBe("mode=scenario");
  });
});
