import { Button } from "../../components/ui/Button";
import { FormField } from "../../components/ui/FormField";
import { Input } from "../../components/ui/Input";
import { Select } from "../../components/ui/Select";
import { formatCorridor } from "../../lib/format";
import { CORRIDORS } from "../transactions/filters";
import { POLICY_NAMES, type PolicyKey } from "../transactions/types";
import { hasDashboardFilters, type DashboardFilters as Filters, type FilterProblems } from "./dashboardQuery";

type DashboardFiltersProps = {
  filters: Filters;
  /** Values the URL carried that can't be applied. Shown on their fields, never corrected. */
  problems: FilterProblems;
  onChange: (next: Filters) => void;
};

/** The four filters GET /api/v1/dashboard/summary supports, all optional, and no others. */
export function DashboardFilters({ filters, problems, onChange }: DashboardFiltersProps) {
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });

  return (
    <section aria-label="Filters" className="space-y-4">
      {/* Two by two from 1024px, so the date fields stay readable; four across from 1280px. */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <FormField label="Corridor" error={problems.corridor}>
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

        <FormField label="Policy" error={problems.policy}>
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

        <FormField label="From (included)" error={problems.from}>
          {({ invalid, ...control }) => (
            <Input
              {...control}
              invalid={invalid}
              type="date"
              value={filters.from ?? ""}
              onChange={(e) => set({ from: e.target.value || undefined })}
            />
          )}
        </FormField>

        <FormField label="To (not included)" error={problems.to}>
          {({ invalid, ...control }) => (
            <Input
              {...control}
              invalid={invalid}
              type="date"
              value={filters.to ?? ""}
              onChange={(e) => set({ to: e.target.value || undefined })}
            />
          )}
        </FormField>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <p className="text-meta text-ink-muted">Dates are UTC midnight. Leave both empty for all time.</p>
        {hasDashboardFilters(filters) ? (
          <Button variant="tertiary" size="sm" onClick={() => onChange({})}>
            Clear filters
          </Button>
        ) : null}
      </div>
    </section>
  );
}
