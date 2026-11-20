import { Button } from "../../components/ui/Button";
import { FormField } from "../../components/ui/FormField";
import { Input } from "../../components/ui/Input";
import { Select } from "../../components/ui/Select";
import { formatCorridor } from "../../lib/format";
import { CORRIDORS, hasActiveFilters, type HistoryFilters } from "./filters";
import { POLICY_NAMES, STATE_MODE_NAMES, type PolicyKey, type StateModeKey } from "./types";

type HistoryFilterBarProps = {
  filters: HistoryFilters;
  onChange: (next: HistoryFilters) => void;
};

/** The filters GET /api/v1/transactions supports (contract §3.3), and no others. */
export function HistoryFilterBar({ filters, onChange }: HistoryFilterBarProps) {
  const set = (patch: Partial<HistoryFilters>) => onChange({ ...filters, ...patch });

  return (
    <section aria-label="Filters" className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <FormField label="Corridor">
          {({ invalid, ...control }) => (
            <Select
              {...control}
              invalid={invalid}
              value={filters.corridor ?? ""}
              onChange={(e) => set({ corridor: e.target.value || undefined })}
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

        <FormField label="Policy">
          {({ invalid, ...control }) => (
            <Select
              {...control}
              invalid={invalid}
              value={filters.policy ?? ""}
              onChange={(e) => set({ policy: (e.target.value || undefined) as PolicyKey | undefined })}
            >
              <option value="">All policies</option>
              {(Object.keys(POLICY_NAMES) as PolicyKey[]).map((p) => (
                <option key={p} value={p}>
                  {POLICY_NAMES[p]}
                </option>
              ))}
            </Select>
          )}
        </FormField>

        <FormField label="State mode">
          {({ invalid, ...control }) => (
            <Select
              {...control}
              invalid={invalid}
              value={filters.stateMode ?? ""}
              onChange={(e) => set({ stateMode: (e.target.value || undefined) as StateModeKey | undefined })}
            >
              <option value="">All state modes</option>
              {(Object.keys(STATE_MODE_NAMES) as StateModeKey[]).map((m) => (
                <option key={m} value={m}>
                  {STATE_MODE_NAMES[m]}
                </option>
              ))}
            </Select>
          )}
        </FormField>

        <FormField label="Completion" helper="Failed transactions match neither option.">
          {({ invalid, ...control }) => (
            <Select
              {...control}
              invalid={invalid}
              value={filters.completed === undefined ? "" : String(filters.completed)}
              onChange={(e) => set({ completed: e.target.value === "" ? undefined : e.target.value === "true" })}
            >
              <option value="">Any</option>
              <option value="true">Completed</option>
              <option value="false">Not completed</option>
            </Select>
          )}
        </FormField>

        <FormField label="Created from">
          {({ invalid, ...control }) => (
            <Input
              {...control}
              invalid={invalid}
              type="date"
              value={filters.from ?? ""}
              max={filters.to}
              onChange={(e) => set({ from: e.target.value || undefined })}
            />
          )}
        </FormField>

        <FormField label="Created to">
          {({ invalid, ...control }) => (
            <Input
              {...control}
              invalid={invalid}
              type="date"
              value={filters.to ?? ""}
              min={filters.from}
              onChange={(e) => set({ to: e.target.value || undefined })}
            />
          )}
        </FormField>
      </div>

      {hasActiveFilters(filters) ? (
        <Button variant="tertiary" size="sm" onClick={() => onChange({})}>
          Clear filters
        </Button>
      ) : null}
    </section>
  );
}
