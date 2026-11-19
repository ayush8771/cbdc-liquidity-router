import { Button } from "../../components/ui/Button";
import { FormField } from "../../components/ui/FormField";
import { Input } from "../../components/ui/Input";
import { Select } from "../../components/ui/Select";
import { formatCorridor } from "../../lib/format";
import { CORRIDORS } from "./filters";
import { PAGE_SIZES, type HistoryProblems, type HistoryQuery, type ManagedKey } from "./historyQuery";
import { POLICY_NAMES, STATE_MODE_NAMES, type PolicyKey, type StateModeKey } from "./types";

type Patch = Partial<Record<ManagedKey, string | undefined>>;

type HistoryFiltersDesktopProps = {
  /** The valid values from the URL. A filter whose URL value was invalid shows as unset, with its error. */
  query: HistoryQuery;
  problems: HistoryProblems;
  /** Whether any filter is in the URL, valid or not. */
  hasFilters: boolean;
  onChange: (patch: Patch) => void;
  onClear: () => void;
};

/**
 * The filters GET /api/v1/transactions supports (contract §3.3), plus the page
 * size, and no others. Dates are UTC midnight: `from` is included and `to`
 * is not. A change reports only what the user touched; the screen resets the
 * page for every change except a change of page.
 */
export function HistoryFiltersDesktop({ query, problems, hasFilters, onChange, onClear }: HistoryFiltersDesktopProps) {
  // A page size that isn't one of the three (the contract allows 1 to 100) is shown as it is, not hidden.
  const sizes = (PAGE_SIZES as readonly number[]).includes(query.pageSize) ? [...PAGE_SIZES] : [...PAGE_SIZES, query.pageSize].sort((a, b) => a - b);

  return (
    <section aria-label="Filters" className="space-y-4">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <FormField label="Corridor" error={problems.corridor}>
          {({ invalid, ...control }) => (
            <Select
              {...control}
              invalid={invalid}
              value={query.corridor ?? ""}
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

        <FormField label="Policy" error={problems.policy}>
          {({ invalid, ...control }) => (
            <Select
              {...control}
              invalid={invalid}
              value={query.policy ?? ""}
              onChange={(e) => onChange({ policy: e.target.value || undefined })}
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

        <FormField label="State mode" error={problems.stateMode}>
          {({ invalid, ...control }) => (
            <Select
              {...control}
              invalid={invalid}
              value={query.stateMode ?? ""}
              onChange={(e) => onChange({ stateMode: e.target.value || undefined })}
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

        <FormField label="Completion" error={problems.completed} helper="Failed transactions match neither option.">
          {({ invalid, ...control }) => (
            <Select
              {...control}
              invalid={invalid}
              value={query.completed === undefined ? "" : String(query.completed)}
              onChange={(e) => onChange({ completed: e.target.value || undefined })}
            >
              <option value="">Any</option>
              <option value="true">Completed</option>
              <option value="false">Not completed</option>
            </Select>
          )}
        </FormField>

        <FormField label="Created from (included)" error={problems.from}>
          {({ invalid, ...control }) => (
            <Input
              {...control}
              invalid={invalid}
              type="date"
              value={query.from ?? ""}
              onChange={(e) => onChange({ from: e.target.value || undefined })}
            />
          )}
        </FormField>

        <FormField label="Created to (not included)" error={problems.to}>
          {({ invalid, ...control }) => (
            <Input
              {...control}
              invalid={invalid}
              type="date"
              value={query.to ?? ""}
              onChange={(e) => onChange({ to: e.target.value || undefined })}
            />
          )}
        </FormField>

        <FormField label="Rows per page" error={problems.pageSize}>
          {({ invalid, ...control }) => (
            <Select
              {...control}
              invalid={invalid}
              value={String(query.pageSize)}
              onChange={(e) => onChange({ pageSize: e.target.value })}
            >
              {sizes.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <p className="text-meta text-ink-muted">Dates are UTC midnight. The end date is not included.</p>
        {hasFilters ? (
          <Button variant="tertiary" size="sm" onClick={onClear}>
            Clear filters
          </Button>
        ) : null}
      </div>
    </section>
  );
}
