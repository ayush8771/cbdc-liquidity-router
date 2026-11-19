import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { FormField } from "../../components/ui/FormField";
import { Input } from "../../components/ui/Input";
import { Select } from "../../components/ui/Select";
import { formatCorridor } from "../../lib/format";
import { CORRIDORS } from "../transactions/filters";
import type { MonitorProblems, MonitorSelection } from "./monitorQuery";
import { MODE_NAMES, type MonitorMode } from "./types";

export type ScenarioOptions =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; options: { scenarioId: string; description: string }[] }
  | { status: "error"; message: string; onRetry: (() => void) | null };

type MonitorControlsProps = {
  selection: MonitorSelection;
  /** The date in use: the URL's, or the calendar's latest eligible one. Empty while the calendar is still loading. */
  effectiveDate: string;
  /** True when `effectiveDate` is the default rather than a choice. */
  dateIsDefault: boolean;
  /** The calendar's bounds, as `min` and `max` hints for the date field. */
  dateBounds: { min: string; max: string } | null;
  dateHelper: string;
  /** What is wrong with each control: the URL, the calendar, or the server's own answer. */
  errors: MonitorProblems;
  scenarios: ScenarioOptions;
  onChange: (patch: Partial<Record<"corridor" | "mode" | "date" | "scenarioId", string | undefined>>) => void;
};

/**
 * The monitor's selections: corridor, mode, date and (for the scenario mode)
 * scenario. They live in the URL, so each change goes through `onChange`. A
 * problem with one is shown at that control.
 */
export function MonitorControls({
  selection,
  effectiveDate,
  dateIsDefault,
  dateBounds,
  dateHelper,
  errors,
  scenarios,
  onChange,
}: MonitorControlsProps) {
  return (
    <Card aria-label="Monitor controls">
      <section aria-label="Selections" className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <FormField label="Corridor" error={errors.corridor}>
          {({ invalid, ...control }) => (
            <Select
              {...control}
              invalid={invalid}
              value={selection.corridor ?? ""}
              onChange={(e) => onChange({ corridor: e.target.value || undefined })}
            >
              <option value="">All corridors</option>
              {CORRIDORS.map((c) => (
                <option key={c} value={c}>
                  {formatCorridor(c)}
                </option>
              ))}
            </Select>
          )}
        </FormField>

        <FormField label="Mode" error={errors.mode}>
          {({ invalid, ...control }) => (
            <Select
              {...control}
              invalid={invalid}
              value={selection.mode}
              onChange={(e) => onChange({ mode: e.target.value, scenarioId: undefined })}
            >
              {(Object.keys(MODE_NAMES) as MonitorMode[]).map((m) => (
                <option key={m} value={m}>
                  {MODE_NAMES[m]}
                </option>
              ))}
            </Select>
          )}
        </FormField>

        <FormField label="Date" error={errors.date} helper={dateIsDefault && effectiveDate ? `${dateHelper} Showing the latest eligible date.` : dateHelper}>
          {({ invalid, ...control }) => (
            <Input
              {...control}
              invalid={invalid}
              type="date"
              value={effectiveDate}
              min={dateBounds?.min}
              max={dateBounds?.max}
              onChange={(e) => onChange({ date: e.target.value || undefined })}
            />
          )}
        </FormField>

        {selection.mode === "scenario" ? (
          <FormField label="Scenario" error={errors.scenarioId ?? (scenarios.status === "error" ? scenarios.message : undefined)}>
            {({ invalid, ...control }) => (
              <>
                <Select
                  {...control}
                  invalid={invalid}
                  value={selection.scenarioId ?? ""}
                  disabled={scenarios.status !== "ready"}
                  onChange={(e) => onChange({ scenarioId: e.target.value || undefined })}
                >
                  <option value="">{scenarios.status === "loading" ? "Loading scenarios…" : "Choose a scenario"}</option>
                  {scenarios.status === "ready"
                    ? scenarios.options.map((s) => (
                        <option key={s.scenarioId} value={s.scenarioId}>
                          {s.scenarioId}
                        </option>
                      ))
                    : null}
                </Select>
                {scenarios.status === "error" && scenarios.onRetry ? (
                  <div className="mt-2">
                    <Button variant="secondary" size="sm" onClick={scenarios.onRetry}>
                      Try again
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </FormField>
        ) : null}
      </section>
    </Card>
  );
}
