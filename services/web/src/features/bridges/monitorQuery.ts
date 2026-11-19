import { CORRIDORS } from "../transactions/filters";
import type { MonitorMode } from "./types";

/**
 * The Bridge monitor's selections, kept in the URL: `corridor` (none means all
 * three), `mode` (`historicalReplay`, the default, or `scenario`), `date`
 * (YYYY-MM-DD; none means the latest eligible date, which the calendar gives)
 * and `scenarioId` (only with the scenario mode). A value that can't be used
 * is not applied and is reported, so the page says so instead of quietly
 * showing something else, and no request is made until it is fixed.
 */
export type MonitorSelection = {
  corridor?: string;
  mode: MonitorMode;
  date?: string;
  scenarioId?: string;
};

export type MonitorProblems = Partial<Record<"corridor" | "mode" | "date" | "scenarioId", string>>;

export const DUPLICATE_MESSAGE = "Given more than once. Use it once.";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function readMonitorParams(params: URLSearchParams): { selection: MonitorSelection; problems: MonitorProblems } {
  const problems: MonitorProblems = {};
  const selection: MonitorSelection = { mode: "historicalReplay" };

  /** The single non-empty value of a parameter. A repeated one is a problem. */
  const single = (key: "corridor" | "mode" | "date" | "scenarioId"): string | undefined => {
    const values = params.getAll(key).filter((v) => v !== "");
    if (values.length > 1) {
      problems[key] = DUPLICATE_MESSAGE;
      return undefined;
    }
    return values[0];
  };

  const corridor = single("corridor");
  if (corridor !== undefined) {
    if ((CORRIDORS as readonly string[]).includes(corridor)) selection.corridor = corridor;
    else problems.corridor = "Choose one of the listed corridors.";
  }

  const mode = single("mode");
  if (mode !== undefined) {
    if (mode === "historicalReplay" || mode === "scenario") selection.mode = mode;
    else problems.mode = "Choose Historical replay or Scenario.";
  }

  const date = single("date");
  if (date !== undefined) {
    if (isRealDate(date)) selection.date = date;
    else problems.date = "Use the format YYYY-MM-DD.";
  }

  const scenarioId = single("scenarioId");
  if (scenarioId !== undefined) {
    // The engine refuses a scenario with the replay mode, so the pair is reported rather than guessed at.
    if (selection.mode === "scenario" || problems.mode) selection.scenarioId = scenarioId;
    else problems.scenarioId = "A scenario can only be used with the Scenario mode.";
  }
  return { selection, problems };
}

type Patch = Partial<Record<"corridor" | "mode" | "date" | "scenarioId", string | undefined>>;

/**
 * The URL parameters after the user changes something. Only the parameters in
 * `patch` are touched (undefined or "" removes one); every other parameter
 * stays exactly as it was. Leaving the scenario mode drops the scenario, and
 * the default mode is not written.
 */
export function updateMonitorParams(current: URLSearchParams, patch: Patch): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(patch) as [keyof Patch, string | undefined][]) {
    next.delete(key);
    if (value !== undefined && value !== "") next.set(key, value);
  }
  if (next.get("mode") === "historicalReplay") next.delete("mode");
  if (!next.has("mode")) next.delete("scenarioId");
  return next;
}
