import { useId } from "react";
import { Icon } from "../../components/ui/Icon";
import type { Role } from "../../api/types";
import { VIEWER_POLICY_REASON } from "../newTransaction/referenceApi";
import type { PolicyRef } from "../newTransaction/types";
import { PolicyCell } from "../transactions/PolicyCell";
import { POLICY_NAMES, type PolicyKey } from "../transactions/types";

type PolicyChecklistProps = {
  policies: PolicyRef[];
  role: Role | undefined;
  /** The chosen policies, in the order they were chosen: results are shown in that order. */
  selected: PolicyKey[];
  error?: string | null;
  onChange: (next: PolicyKey[]) => void;
};

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Which policies to compare. Each can be chosen once, and the order they are
 * chosen in is the order of the results. Only analysts can choose the
 * experimental policy. An analyst can choose it even when the engine has no
 * approved checkpoint for it: the engine then skips it, and the comparison
 * shows it as skipped (that is a result, not an error). A policy the engine
 * has switched off that isn't the experimental one is not offered.
 */
export function PolicyChecklist({ policies, role, selected, error, onChange }: PolicyChecklistProps) {
  const id = useId();
  const errorId = error ? `${id}-error` : undefined;
  const toggle = (policy: PolicyKey) =>
    onChange(selected.includes(policy) ? selected.filter((p) => p !== policy) : [...selected, policy]);

  return (
    <fieldset className="space-y-3" aria-describedby={errorId}>
      <legend className="mb-2 text-ui font-medium text-ink-body">
        Policies <span className="font-normal text-ink-muted">(choose at least two)</span>
      </legend>
      <ul className="space-y-3">
        {policies.map((p) => {
          const experimental = p.policy === "ppoProjected";
          const viewerBlocked = experimental && role !== "analyst";
          const disabled = viewerBlocked || (!p.enabled && !experimental);
          const hint = viewerBlocked
            ? sentence(VIEWER_POLICY_REASON)
            : experimental && !p.enabled
              ? `The engine has it switched off${p.disabledReason ? ` (${p.disabledReason})` : ""}, so it will be skipped.`
              : !p.enabled
                ? `Unavailable${p.disabledReason ? `: ${p.disabledReason}` : ""}.`
                : null;
          const inputId = `${id}-${p.policy}`;
          const position = selected.indexOf(p.policy);
          return (
            <li key={p.policy} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <input
                id={inputId}
                type="checkbox"
                className="h-4 w-4 rounded-card border border-line-control bg-surface-panel accent-paper-white disabled:opacity-50"
                checked={selected.includes(p.policy)}
                disabled={disabled}
                aria-describedby={[hint ? `${inputId}-hint` : null, errorId].filter(Boolean).join(" ") || undefined}
                onChange={() => toggle(p.policy)}
              />
              <label htmlFor={inputId} className={disabled ? "text-ui text-ink-muted" : "text-ui text-ink-body"}>
                {POLICY_NAMES[p.policy] ?? p.policy}
              </label>
              <PolicyCell policy={p.policy} tier={p.status} />
              {position >= 0 ? <span className="text-meta text-ink-muted">Shown {ordinal(position + 1)}</span> : null}
              {hint ? (
                <span id={`${inputId}-hint`} className="w-full pl-7 text-meta text-ink-muted">
                  {hint}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {selected.length > 0 ? (
        <p className="text-meta text-ink-muted">
          Results are shown in this order: {selected.map((p) => POLICY_NAMES[p] ?? p).join(", ")}.
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 px-1 text-ui text-status-danger">
          <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </fieldset>
  );
}

function ordinal(n: number): string {
  return n === 1 ? "first" : n === 2 ? "second" : n === 3 ? "third" : `#${n}`;
}
