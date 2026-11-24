import { useSearchParams } from "react-router-dom";
import type { ApiClient } from "../../api/client";
import { useApiQuery, type ApiQueryState } from "../../api/useApiQuery";
import { useAuth } from "../../auth/AuthContext";
import { Button } from "../../components/ui/Button";
import { Notice } from "../../components/ui/Notice";
import { describeReferenceError, fetchScenarios } from "../newTransaction/referenceApi";
import { CORRIDORS } from "../transactions/filters";
import { CorridorStateCard, type CorridorCardState } from "./CorridorStateCard";
import { MonitorControls, type ScenarioOptions } from "./MonitorControls";
import { readMonitorParams, updateMonitorParams, type MonitorProblems } from "./monitorQuery";
import {
  dateProblem,
  describeStateError,
  fetchCalendar,
  fetchCorridorState,
  latestEligibleDate,
  type StateRequest,
} from "./stateApi";
import type { CorridorStateView } from "./types";

/** One corridor's request: an independent query, asked for only while the selections are complete and usable. */
function useCorridorState(api: ApiClient, corridor: string, request: Omit<StateRequest, "corridor"> | null) {
  return useApiQuery<CorridorStateView>(
    JSON.stringify({ corridor, ...request }),
    () => fetchCorridorState(api, { corridor, ...(request as Omit<StateRequest, "corridor">) }),
    request !== null,
  );
}

/**
 * The Bridge monitor's live part (shown only in live mode, from 1024px up): the
 * corridor, mode, date and scenario controls, and one card per corridor with
 * its venues' simulated liquidity and congestion, from GET /api/v1/state.
 *
 * - Each corridor is its own request, so one failing, loading or being retried
 *   never touches the others.
 * - The date defaults to the latest one the calendar (GET /api/v1/replay/calendar)
 *   says the engine accepts, skipping every excluded range. A date or scenario
 *   the URL, the calendar or the server rejects is reported at its control.
 * - The scenario list is fetched only for the scenario mode.
 * - It shows no availability, health or status: the API provides none.
 */
export function LiveMonitor() {
  const { api } = useAuth();
  const [params, setParams] = useSearchParams();
  const { selection, problems } = readMonitorParams(params);

  const calendarQuery = useApiQuery("monitor:calendar", () => fetchCalendar(api), true);
  const calendar = calendarQuery.status === "success" ? calendarQuery.data : null;
  const defaultDate = calendar ? latestEligibleDate(calendar) : null;
  const date = selection.date ?? defaultDate ?? undefined;

  const scenariosQuery = useApiQuery("monitor:scenarios", () => fetchScenarios(api), selection.mode === "scenario");
  const scenarioList = scenariosQuery.status === "success" ? scenariosQuery.data : null;

  // What is wrong with each selection, before any request is made.
  const errors: MonitorProblems = { ...problems };
  if (!errors.date && date && calendar) {
    const problem = dateProblem(calendar, date);
    if (problem) errors.date = problem;
  }
  if (selection.mode === "scenario" && !errors.scenarioId && selection.scenarioId && scenarioList) {
    if (!scenarioList.some((s) => s.scenarioId === selection.scenarioId)) {
      errors.scenarioId = "This scenario isn't in the engine's list. Choose one from the list.";
    }
  }
  // A scenario given without the scenario mode has no control of its own to sit on: it is reported at the mode.
  if (selection.mode !== "scenario" && errors.scenarioId) {
    errors.mode = errors.mode ?? errors.scenarioId;
    delete errors.scenarioId;
  }
  const blocked = Boolean(errors.corridor || errors.mode || errors.date || errors.scenarioId);
  const needsScenario = selection.mode === "scenario" && !selection.scenarioId;
  // The calendar and (for a scenario) the list are checked against before anything is asked of the engine, so
  // a date or scenario they refuse never reaches it. If one of them failed to load, the engine decides.
  const calendarPending = calendarQuery.status === "loading" && !calendarQuery.settledOnce;
  const scenariosPending = selection.mode === "scenario" && scenariosQuery.status === "loading" && !scenariosQuery.settledOnce;
  const ready = !blocked && date !== undefined && !needsScenario && !calendarPending && !scenariosPending;

  const base = ready ? { mode: selection.mode, date, scenarioId: selection.scenarioId } : null;
  const selected: readonly string[] = selection.corridor ? [selection.corridor] : CORRIDORS;
  const requestFor = (corridor: string) => (base && selected.includes(corridor) ? base : null);
  const queries: Record<string, ApiQueryState<CorridorStateView> & { retry: () => void }> = {
    [CORRIDORS[0]]: useCorridorState(api, CORRIDORS[0], requestFor(CORRIDORS[0])),
    [CORRIDORS[1]]: useCorridorState(api, CORRIDORS[1], requestFor(CORRIDORS[1])),
    [CORRIDORS[2]]: useCorridorState(api, CORRIDORS[2], requestFor(CORRIDORS[2])),
  };

  // A date or scenario the server rejected is reported at its control (and is the same for every corridor).
  const failures = selected.flatMap((corridor) => {
    const q = queries[corridor];
    return q && q.status === "error" ? [{ corridor, failure: describeStateError(q.error, corridor) }] : [];
  });
  for (const { failure } of failures) {
    if (failure.target === "date" && !errors.date) errors.date = failure.message;
    if (failure.target === "scenario" && !errors.scenarioId) errors.scenarioId = failure.message;
  }

  const waitingReason = (): string => {
    if (blocked) return "Fix the highlighted selection to see this corridor.";
    if (calendarPending) return "Loading the available dates…";
    if (date === undefined) return "Choose a date to see this corridor.";
    if (needsScenario) return "Choose a scenario to see this corridor.";
    return "Loading the scenarios…";
  };

  const cardFor = (corridor: string): CorridorCardState => {
    const q = queries[corridor];
    if (!ready || !q) return { kind: "waiting", reason: waitingReason() };
    if (q.status === "loading" || q.status === "idle") return { kind: "loading" };
    if (q.status === "success") return { kind: "ready", state: q.data };
    const failure = describeStateError(q.error, corridor);
    if (failure.target === "date" || failure.target === "scenario") {
      return { kind: "control-error", control: failure.target };
    }
    return { kind: "error", failure, onRetry: q.retry };
  };

  const scenarios: ScenarioOptions =
    selection.mode !== "scenario"
      ? { status: "idle" }
      : scenariosQuery.status === "error"
        ? { status: "error", message: describeReferenceError(scenariosQuery.error, "scenarios").message, onRetry: scenariosQuery.retry }
        : scenarioList
          ? { status: "ready", options: scenarioList }
          : { status: "loading" };

  const dateHelper = calendar
    ? `Data runs from ${calendar.start} to ${calendar.end}. The data's ends and the gaps around each split boundary are excluded.`
    : calendarQuery.status === "loading"
      ? "Loading the dates the engine accepts…"
      : "The engine decides which dates are eligible.";

  return (
    <div className="space-y-6">
      <Notice title="Simulated values — not availability or status">
        These are the API&apos;s simulated liquidity and congestion for the date you choose. The API provides no
        availability or bridge status, so none is shown.
      </Notice>

      {calendarQuery.status === "error" ? (
        <Notice tone="warning" role="alert" title="Couldn't load the calendar">
          <p>
            {describeReferenceError(calendarQuery.error, "calendar").message}
            {date === undefined ? " Without it there is no default date: choose one below." : " Date hints are unavailable."}
          </p>
          <div className="mt-3">
            <Button variant="secondary" size="sm" onClick={calendarQuery.retry}>
              Try again
            </Button>
          </div>
        </Notice>
      ) : null}

      <MonitorControls
        selection={selection}
        effectiveDate={date ?? ""}
        dateIsDefault={selection.date === undefined}
        dateBounds={calendar ? { min: calendar.start, max: calendar.end } : null}
        dateHelper={dateHelper}
        errors={errors}
        scenarios={scenarios}
        onChange={(patch) => setParams(updateMonitorParams(params, patch))}
      />

      <div className="space-y-6" aria-label="Corridor states" role="group">
        {selected.map((corridor) => (
          <CorridorStateCard key={corridor} corridor={corridor} view={cardFor(corridor)} />
        ))}
      </div>
    </div>
  );
}
