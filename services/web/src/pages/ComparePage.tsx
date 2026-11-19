import { useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useDataMode } from "../api/dataMode";
import { useApiQuery } from "../api/useApiQuery";
import { useAuth } from "../auth/AuthContext";
import { MandatoryLabel } from "../components/labels/MandatoryLabel";
import { Button, ButtonLink } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { Icon } from "../components/ui/Icon";
import { LoadingState } from "../components/ui/LoadingState";
import { Notice } from "../components/ui/Notice";
import { PageHeading } from "../components/ui/PageHeading";
import { StatusIndicator } from "../components/ui/StatusIndicator";
import {
  describeCompareUncertain,
  describeComparisonError,
  fetchComparison,
  policyFieldMessage,
  submitComparison,
  type CompareSubmitResult,
} from "../features/compare/compareApi";
import { validateCompare } from "../features/compare/compareValidate";
import { isNotFound } from "../features/transactions/detailApi";
import { ComparisonResult } from "../features/compare/ComparisonResult";
import { PolicyChecklist } from "../features/compare/PolicyChecklist";
import { withoutChangedErrors } from "../features/newTransaction/formErrors";
import { ReferenceStatus } from "../features/newTransaction/ReferenceStatus";
import { TransactionForm } from "../features/newTransaction/TransactionForm";
import type { FieldErrors, FormErrorView, FormValues, ReferenceData } from "../features/newTransaction/types";
import { useLiveReference } from "../features/newTransaction/useReference";
import { describeFailure, initialValues } from "../features/newTransaction/validate";
import { isTransactionId } from "../features/transactions/filters";
import type { PolicyKey } from "../features/transactions/types";
import { NO_LIQUIDITY_CARRY_OVER } from "../lib/labels";
import { useMediaQuery } from "../lib/useMediaQuery";
import { PendingScreen } from "./PendingScreen";
import { SCREENS, type ScreenSpec } from "./screens";

// Desktop starts at 1024px, the same point as Tailwind's `lg`, the sidebar and the other desktop screens.
const DESKTOP = "(min-width: 1024px)";

/**
 * The comparison form's state: the transaction's values, the chosen policies in
 * the order chosen, the errors and the last result. A submission is sent once
 * and never retried, and a second submit is ignored while one is running.
 */
function useCompareState() {
  const { api, user } = useAuth();
  const [values, setValues] = useState<FormValues>(initialValues);
  const [policies, setPolicies] = useState<PolicyKey[]>([]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<FormErrorView | null>(null);
  const [status, setStatus] = useState<"idle" | "submitting" | "done">("idle");
  const [result, setResult] = useState<CompareSubmitResult | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const inFlight = useRef(false);

  function handleChange(next: FormValues) {
    setErrors((current) => withoutChangedErrors(current, values, next));
    setValues(next);
  }

  function handlePolicies(next: PolicyKey[]) {
    setErrors((current) => {
      const kept = { ...current };
      delete kept.policies;
      return kept;
    });
    setPolicies(next);
  }

  async function handleSubmit(reference: ReferenceData) {
    if (inFlight.current) return;
    const checked = validateCompare(values, reference, policies, user?.role);
    if (!checked.payload) {
      setErrors(checked.errors);
      setFormError(null);
      setFocusSignal((n) => n + 1);
      return;
    }

    inFlight.current = true;
    setErrors({});
    setFormError(null);
    setResult(null);
    setStatus("submitting");
    try {
      const outcome = await submitComparison(api, checked.payload);
      setResult(outcome);
      if (outcome.kind === "error") {
        const described = describeFailure(outcome.error);
        const onPolicies = policyFieldMessage(outcome.error);
        const fields = onPolicies ? { ...described.fields, policies: onPolicies } : described.fields;
        setErrors(fields);
        setFormError(described.form);
        if (Object.keys(fields).length > 0) setFocusSignal((n) => n + 1);
      } else if (outcome.kind === "uncertain") {
        // No way to tell whether it was saved: warn, keep what was typed, and retry nothing.
        setFormError(describeCompareUncertain(outcome.reason));
      }
    } finally {
      inFlight.current = false;
      setStatus("done");
    }
  }

  function handleReset() {
    setValues(initialValues());
    setPolicies([]);
    setErrors({});
    setFormError(null);
    setResult(null);
    setStatus("idle");
  }

  return { user, values, policies, errors, formError, status, result, focusSignal, handleChange, handlePolicies, handleSubmit, handleReset };
}

/** What the last submission produced, under the form. */
function CompareResultPanel({ status, result }: { status: "idle" | "submitting" | "done"; result: CompareSubmitResult | null }) {
  if (status === "submitting") {
    return (
      <Card aria-label="Comparison result">
        <LoadingState label="Comparing the policies" rows={6} />
      </Card>
    );
  }
  if (!result) {
    return (
      <Card aria-label="Comparison result" padded={false}>
        <EmptyState icon="compare" title="No comparison yet">
          Choose a transaction and at least two policies, then compare them.
        </EmptyState>
      </Card>
    );
  }
  if (result.kind === "saved") return <ComparisonResult comparison={result.comparison} showLink />;
  if (result.kind === "uncertain") {
    return (
      <Notice tone="warning" role="alert" title="We can't tell whether it was saved">
        <p>
          {result.reason === "timeout"
            ? "The server did not answer within 25 seconds."
            : result.reason === "network"
              ? "The connection to the server failed."
              : "The server answered, but the answer could not be read."}
        </p>
        <p className="mt-2">
          The request may have reached the server, so the comparison{" "}
          <strong className="font-medium text-ink-body">may have been saved</strong>. Comparisons can&apos;t be listed, so
          there is nowhere to check. Submitting again only creates another, independent record; it doesn&apos;t affect
          History or the dashboard.
        </p>
        <p className="mt-1 text-meta text-ink-muted">Nothing is retried automatically.</p>
      </Notice>
    );
  }
  return (
    <Notice tone="warning" title="Not saved">
      <p>The request was not accepted, so no comparison was created.</p>
      <p className="mt-1 text-meta text-ink-muted">Fix the form and submit again.</p>
    </Notice>
  );
}

/** The comparison form, in place of which the reference data's own loading and errors show until it is ready. */
function NewComparison({ spec }: { spec: ScreenSpec }) {
  const state = useCompareState();
  const { reference, queries } = useLiveReference(true);
  const role = state.user?.role;

  return (
    <div className="space-y-8">
      <PageHeading
        eyebrow={spec.eyebrow}
        title={spec.title}
        description={spec.description}
        actions={<StatusIndicator tone="neutral" label="Live data" />}
        meta={
          <>
            {spec.labels?.map((kind) => <MandatoryLabel key={kind} kind={kind} />)}
            <MandatoryLabel kind="simulated" />
          </>
        }
      />

      <Notice>{NO_LIQUIDITY_CARRY_OVER}</Notice>

      {reference ? (
        <TransactionForm
          values={state.values}
          errors={state.errors}
          reference={reference}
          submitting={state.status === "submitting"}
          formError={state.formError}
          focusSignal={state.focusSignal}
          onChange={state.handleChange}
          onSubmit={() => state.handleSubmit(reference)}
          onReset={state.handleReset}
          cardLabel="Comparison form"
          submitLabel="Compare policies"
          submittingLabel="Comparing…"
          policyField={
            <div className="sm:col-span-2">
              <PolicyChecklist
                policies={reference.policies}
                role={role}
                selected={state.policies}
                error={state.errors.policies}
                onChange={state.handlePolicies}
              />
            </div>
          }
        />
      ) : (
        <ReferenceStatus queries={queries} />
      )}

      <div aria-live="polite">
        <CompareResultPanel status={state.status} result={state.result} />
      </div>
    </div>
  );
}

/** A saved comparison, from GET /api/v1/comparisons/:id. Read only. */
function SavedComparison({ spec, id }: { spec: ScreenSpec; id: string }) {
  const { api } = useAuth();
  const valid = isTransactionId(id);
  const normalized = id.trim().toLowerCase();
  const query = useApiQuery(`comparison:${normalized}`, () => fetchComparison(api, normalized), valid);
  const failure = query.status === "error" ? describeComparisonError(query.error) : null;
  const notFound = query.status === "error" && isNotFound(query.error);

  return (
    <div className="space-y-8">
      <ButtonLink to="/compare" variant="tertiary" size="sm" className="-ml-1.5">
        <Icon name="arrowRight" size={14} className="rotate-180" />
        New comparison
      </ButtonLink>

      <PageHeading
        eyebrow={spec.eyebrow}
        title="Saved comparison"
        description={
          valid ? (
            <span className="break-all font-mono text-ui text-ink-secondary">{id}</span>
          ) : (
            "This address doesn't contain a valid comparison ID."
          )
        }
        actions={<StatusIndicator tone="neutral" label="Live data" />}
        meta={
          <>
            {spec.labels?.map((kind) => <MandatoryLabel key={kind} kind={kind} />)}
            <MandatoryLabel kind="simulated" />
          </>
        }
      />

      {!valid ? (
        <Card padded={false}>
          <EmptyState icon="info" title="No comparison to show">
            Check the address, or make a new comparison.
          </EmptyState>
        </Card>
      ) : query.status === "loading" ? (
        <Card>
          <LoadingState label="Loading the comparison" rows={8} />
        </Card>
      ) : notFound ? (
        <Card padded={false}>
          <EmptyState
            icon="compare"
            title="Comparison not found"
            actions={
              <ButtonLink to="/compare" variant="secondary">
                New comparison
              </ButtonLink>
            }
          >
            No comparison with this ID exists.
          </EmptyState>
        </Card>
      ) : failure && query.status === "error" ? (
        <Card padded={false}>
          <ErrorState
            title="Couldn't load this comparison"
            message={failure.message}
            reference={failure.reference}
            action={
              failure.canRetry ? (
                <Button variant="secondary" onClick={query.retry}>
                  Try again
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : query.status === "success" ? (
        <ComparisonResult comparison={query.data} />
      ) : null}
    </div>
  );
}

function LiveCompare({ spec }: { spec: ScreenSpec }) {
  const { id } = useParams();
  return id === undefined ? <NewComparison spec={spec} /> : <SavedComparison spec={spec} id={id} />;
}

/**
 * Compare policies. From 1024px up, in live mode (the default data mode,
 * src/api/dataMode.ts), it is the comparison form and the saved-comparison page
 * (`/compare/:id`). In preview mode (VITE_API_MODE=preview), and below 1024px,
 * it is the existing placeholder screen, unchanged, and makes no request.
 */
export function ComparePage() {
  const isDesktop = useMediaQuery(DESKTOP);
  const live = useDataMode() === "live";
  const spec = SCREENS.find((s) => s.path === "/compare");
  if (!spec) throw new Error("The /compare screen spec is missing from SCREENS.");

  return isDesktop && live ? <LiveCompare spec={spec} /> : <PendingScreen spec={spec} />;
}
