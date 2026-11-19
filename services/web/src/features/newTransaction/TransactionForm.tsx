import { useEffect, useRef } from "react";
import { MandatoryLabel } from "../../components/labels/MandatoryLabel";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { FormField } from "../../components/ui/FormField";
import { Icon } from "../../components/ui/Icon";
import { Input } from "../../components/ui/Input";
import { Notice } from "../../components/ui/Notice";
import { Select } from "../../components/ui/Select";
import { formatCorridor, formatUsd } from "../../lib/format";
import { PolicyCell } from "../transactions/PolicyCell";
import { POLICY_NAMES, STATE_MODE_NAMES, type StateModeKey } from "../transactions/types";
import type { FieldErrors, FormErrorView, FormValues, PolicyRef, ReferenceData } from "./types";

type TransactionFormProps = {
  values: FormValues;
  errors: FieldErrors;
  reference: ReferenceData;
  submitting: boolean;
  formError: FormErrorView | null;
  /** Bumped by the page when a submit found errors, to move focus to the first one. */
  focusSignal: number;
  onChange: (next: FormValues) => void;
  onSubmit: () => void;
  onReset: () => void;
};

const legend = "mb-4 text-body-sm font-medium text-ink-primary";

function policyOptionLabel(p: PolicyRef) {
  return p.enabled ? POLICY_NAMES[p.policy] : `${POLICY_NAMES[p.policy]} — unavailable`;
}

/** Every field of POST /api/v1/transactions (contract §3.2), and nothing else. */
export function TransactionForm({
  values,
  errors,
  reference,
  submitting,
  formError,
  focusSignal,
  onChange,
  onSubmit,
  onReset,
}: TransactionFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const set = (patch: Partial<FormValues>) => onChange({ ...values, ...patch });

  useEffect(() => {
    if (focusSignal > 0) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusSignal]);

  const corridor = reference.corridors.find((c) => c.corridor === values.corridor);
  const policy = reference.policies.find((p) => p.policy === values.policy);
  const setVenue = (index: number, patch: Partial<FormValues["venues"][number]>) =>
    set({ venues: values.venues.map((v, i) => (i === index ? { ...v, ...patch } : v)) });

  return (
    <Card aria-label="New transaction form">
      <form
        ref={formRef}
        noValidate
        aria-busy={submitting}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        className="space-y-8"
      >
        <fieldset disabled={submitting} className="space-y-4">
          <legend className={legend}>Transaction</legend>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Corridor" required error={errors.corridor}>
              {({ invalid, ...control }) => (
                <Select
                  {...control}
                  invalid={invalid}
                  value={values.corridor}
                  onChange={(e) => {
                    const next = reference.corridors.find((c) => c.corridor === e.target.value);
                    set({
                      corridor: e.target.value,
                      venues: (next?.venues ?? []).map((v) => ({ bridgeUid: v.bridgeUid, liquidityUsd: "", congestion: "" })),
                    });
                  }}
                >
                  <option value="">Choose a corridor</option>
                  {reference.corridors.map((c) => (
                    <option key={c.corridor} value={c.corridor}>
                      {formatCorridor(c.corridor)}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>

            <FormField
              label="Amount (USD)"
              required
              error={errors.amountUsd}
              helper={`The single-transfer limit is ${formatUsd(reference.maxSingleTransferUsd)}. A larger amount is still routed and then rejected by the feasibility rules: that is a result, not an error.`}
            >
              {({ invalid, ...control }) => (
                <Input
                  {...control}
                  invalid={invalid}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="300000"
                  value={values.amountUsd}
                  onChange={(e) => set({ amountUsd: e.target.value })}
                />
              )}
            </FormField>

            <FormField
              label="Policy"
              error={errors.policy}
              helper={
                <span className="block space-y-1.5">
                  {policy ? <PolicyCell policy={policy.policy} tier={policy.status} /> : null}
                  {reference.policies
                    .filter((p) => !p.enabled)
                    .map((p) => (
                      <span key={p.policy} className="flex flex-wrap items-center gap-2">
                        <PolicyCell policy={p.policy} tier={p.status} />
                        <span>
                          Unavailable{p.disabledReason ? `: ${p.disabledReason}` : ""}.
                        </span>
                      </span>
                    ))}
                </span>
              }
            >
              {({ invalid, ...control }) => (
                <Select
                  {...control}
                  invalid={invalid}
                  value={values.policy}
                  onChange={(e) => set({ policy: e.target.value as FormValues["policy"] })}
                >
                  {reference.policies.map((p) => (
                    <option key={p.policy} value={p.policy} disabled={!p.enabled}>
                      {policyOptionLabel(p)}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>

            <FormField label="Client reference" error={errors.clientReference} helper="Optional. Up to 200 characters.">
              {({ invalid, ...control }) => (
                <Input
                  {...control}
                  invalid={invalid}
                  autoComplete="off"
                  value={values.clientReference}
                  onChange={(e) => set({ clientReference: e.target.value })}
                />
              )}
            </FormField>
          </div>
        </fieldset>

        <fieldset disabled={submitting} className="space-y-4 border-t border-line-subtle pt-8">
          <legend className={legend}>
            <span className="inline-flex flex-wrap items-center gap-3">
              State
              {values.mode === "explicit" ? <MandatoryLabel kind="userSuppliedState" /> : null}
            </span>
          </legend>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="State mode" required error={errors.mode}>
              {({ invalid, ...control }) => (
                <Select
                  {...control}
                  invalid={invalid}
                  value={values.mode}
                  onChange={(e) => set({ mode: e.target.value as StateModeKey })}
                >
                  {(Object.keys(STATE_MODE_NAMES) as StateModeKey[]).map((m) => (
                    <option key={m} value={m}>
                      {STATE_MODE_NAMES[m]}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>

            {values.mode !== "explicit" ? (
              <FormField
                label="Date"
                required
                error={errors.date}
                helper="Historical data ends on 30 September 2025. The engine decides which dates are eligible."
              >
                {({ invalid, ...control }) => (
                  <Input
                    {...control}
                    invalid={invalid}
                    type="date"
                    value={values.date}
                    onChange={(e) => set({ date: e.target.value })}
                  />
                )}
              </FormField>
            ) : (
              <FormField
                label="Reference date"
                required
                error={errors.referenceDate}
                helper="The engine decides which dates are eligible."
              >
                {({ invalid, ...control }) => (
                  <Input
                    {...control}
                    invalid={invalid}
                    type="date"
                    value={values.referenceDate}
                    onChange={(e) => set({ referenceDate: e.target.value })}
                  />
                )}
              </FormField>
            )}

            {values.mode === "scenario" ? (
              <FormField
                label="Scenario"
                required
                error={errors.scenarioId}
                helper={reference.scenarios.find((s) => s.scenarioId === values.scenarioId)?.description}
              >
                {({ invalid, ...control }) => (
                  <Select
                    {...control}
                    invalid={invalid}
                    value={values.scenarioId}
                    onChange={(e) => set({ scenarioId: e.target.value })}
                  >
                    <option value="">Choose a scenario</option>
                    {reference.scenarios.map((s) => (
                      <option key={s.scenarioId} value={s.scenarioId}>
                        {s.scenarioId}
                      </option>
                    ))}
                  </Select>
                )}
              </FormField>
            ) : null}
          </div>

          {values.mode === "explicit" ? (
            corridor ? (
              <div className="space-y-4 pt-2">
                <p className="text-ui text-ink-muted">
                  Enter the liquidity and congestion of each venue in {formatCorridor(corridor.corridor)}.
                </p>
                {values.venues.map((venue, i) => (
                  <div
                    key={venue.bridgeUid}
                    role="group"
                    aria-label={venue.bridgeUid}
                    className="grid grid-cols-1 items-start gap-4 rounded-card border border-line-subtle p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]"
                  >
                    <p className="pt-1 font-mono text-meta text-ink-secondary">{venue.bridgeUid}</p>
                    <FormField label={`${venue.bridgeUid} liquidity (USD)`} required error={errors[`venues.${i}.liquidityUsd`]}>
                      {({ invalid, ...control }) => (
                        <Input
                          {...control}
                          invalid={invalid}
                          type="text"
                          inputMode="decimal"
                          autoComplete="off"
                          spellCheck={false}
                          value={venue.liquidityUsd}
                          onChange={(e) => setVenue(i, { liquidityUsd: e.target.value })}
                        />
                      )}
                    </FormField>
                    <FormField label={`${venue.bridgeUid} congestion`} required error={errors[`venues.${i}.congestion`]}>
                      {({ invalid, ...control }) => (
                        <Input
                          {...control}
                          invalid={invalid}
                          type="text"
                          inputMode="decimal"
                          autoComplete="off"
                          spellCheck={false}
                          value={venue.congestion}
                          onChange={(e) => setVenue(i, { congestion: e.target.value })}
                        />
                      )}
                    </FormField>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-ui text-ink-muted">Choose a corridor to enter its venues.</p>
            )
          ) : null}
        </fieldset>

        {formError ? (
          <Notice tone="danger" role="alert" title={formError.title}>
            {formError.messages.length === 1 ? (
              <p>{formError.messages[0]}</p>
            ) : (
              <ul className="list-disc space-y-1 pl-5">
                {formError.messages.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-meta text-ink-muted">
              Code: <code className="text-ink-secondary">{formError.code}</code>
              {" · "}Reference: <code className="select-all text-ink-secondary">{formError.requestId}</code>
            </p>
          </Notice>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          {submitting ? (
            <Button
              type="submit"
              disabled
              iconStart={
                <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              }
            >
              Routing…
            </Button>
          ) : (
            <Button type="submit" iconEnd={<Icon name="arrowRight" size={16} />}>
              Route transaction
            </Button>
          )}
          <Button variant="tertiary" onClick={onReset} disabled={submitting}>
            Reset
          </Button>
        </div>
      </form>
    </Card>
  );
}
