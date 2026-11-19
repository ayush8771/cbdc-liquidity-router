import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { MandatoryLabel } from "../components/labels/MandatoryLabel";
import { Notice } from "../components/ui/Notice";
import { PageHeading } from "../components/ui/PageHeading";
import { StatusIndicator } from "../components/ui/StatusIndicator";
import { ResultPanel } from "../features/newTransaction/ResultPanel";
import { TransactionForm } from "../features/newTransaction/TransactionForm";
import type { FieldErrors, FormErrorView, FormValues, SubmitResult } from "../features/newTransaction/types";
import { describeFailure, initialValues, validateForm } from "../features/newTransaction/validate";
import { NO_LIQUIDITY_CARRY_OVER } from "../lib/labels";
import { useMediaQuery } from "../lib/useMediaQuery";
import { readMockFailure, submitPreviewTransaction } from "../preview/mockSubmit";
import { PREVIEW_REFERENCE } from "../preview/previewReference";
import { PreviewNotice } from "../preview/PreviewNotice";
import { PendingScreen } from "./PendingScreen";
import { SCREENS, type ScreenSpec } from "./screens";

// Desktop starts at 1024px, the same point as Tailwind's `lg`, the sidebar and the other desktop screens.
const DESKTOP = "(min-width: 1024px)";

const SIMPLE_KEYS = ["corridor", "amountUsd", "policy", "clientReference", "mode", "date", "scenarioId", "referenceDate"] as const;

/** Drops the errors of every field the user just changed, so a message never outlives its fix. */
function withoutChangedErrors(errors: FieldErrors, prev: FormValues, next: FormValues): FieldErrors {
  const kept = { ...errors };
  for (const key of SIMPLE_KEYS) if (prev[key] !== next[key]) delete kept[key];
  if (prev.corridor !== next.corridor || prev.mode !== next.mode) {
    for (const key of Object.keys(kept)) if (key.startsWith("venues.")) delete kept[key];
  }
  next.venues.forEach((venue, i) => {
    const before = prev.venues[i];
    if (before?.liquidityUsd !== venue.liquidityUsd) delete kept[`venues.${i}.liquidityUsd`];
    if (before?.congestion !== venue.congestion) delete kept[`venues.${i}.congestion`];
  });
  return kept;
}

/**
 * The screen's state: the values, errors and last result. It lives in
 * NewTransactionPage, above the 1024px switch, so a window that is resized
 * across the breakpoint doesn't wipe what the user typed or the last result.
 *
 * A request is never retried automatically, and a second submit is ignored
 * while one is running.
 */
function useNewTransactionState() {
  const [params] = useSearchParams();
  const failure = readMockFailure(params);

  const [values, setValues] = useState<FormValues>(initialValues);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<FormErrorView | null>(null);
  const [status, setStatus] = useState<"idle" | "submitting" | "done">("idle");
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const inFlight = useRef(false);

  function handleChange(next: FormValues) {
    setErrors((current) => withoutChangedErrors(current, values, next));
    setValues(next);
  }

  async function handleSubmit() {
    if (inFlight.current) return;
    const checked = validateForm(values, PREVIEW_REFERENCE);
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
      const outcome = await submitPreviewTransaction(checked.payload, { failure });
      setResult(outcome);
      if (outcome.kind === "error") {
        const described = describeFailure(outcome.error);
        setErrors(described.fields);
        setFormError(described.form);
        if (Object.keys(described.fields).length > 0) setFocusSignal((n) => n + 1);
      }
    } catch {
      setFormError({
        title: "Something went wrong",
        messages: ["The preview submission failed unexpectedly. Nothing was saved."],
        code: "PREVIEW_ERROR",
        requestId: "preview",
      });
    } finally {
      inFlight.current = false;
      setStatus("done");
    }
  }

  function handleReset() {
    setValues(initialValues());
    setErrors({});
    setFormError(null);
    setResult(null);
    setStatus("idle");
  }

  return { failure, values, errors, formError, status, result, focusSignal, handleChange, handleSubmit, handleReset };
}

/**
 * New transaction on a MOCK submission service, from 1024px up. Nothing is
 * sent to the API: live creation is blocked until the engine returns a decision
 * ID. Preview failures: ?mock=validation|busy|timeout|unavailable|error.
 */
function DesktopNewTransaction({ spec, state }: { spec: ScreenSpec; state: ReturnType<typeof useNewTransactionState> }) {
  const { failure, values, errors, formError, status, result, focusSignal } = state;

  return (
    <div className="space-y-8">
      <PageHeading
        eyebrow={spec.eyebrow}
        title={spec.title}
        description={spec.description}
        actions={<StatusIndicator tone="neutral" label="Not connected" />}
        meta={<MandatoryLabel kind="simulated" />}
      />

      <PreviewNotice />
      {spec.showCarryOverNote ? <Notice>{NO_LIQUIDITY_CARRY_OVER}</Notice> : null}
      {failure ? (
        <Notice title={`Preview failure mode: ${failure}`}>
          Every submission returns this failure, so you can review how it looks. Remove <code className="text-ink-body">?mock=</code>{" "}
          from the address to leave this mode.
        </Notice>
      ) : null}

      {/* Stacked up to 1535px, so the form and the result each get the full width; side by side only on very wide screens. */}
      <div className="grid grid-cols-1 gap-6 2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] 2xl:items-start">
        <TransactionForm
          values={values}
          errors={errors}
          reference={PREVIEW_REFERENCE}
          submitting={status === "submitting"}
          formError={formError}
          focusSignal={focusSignal}
          onChange={state.handleChange}
          onSubmit={state.handleSubmit}
          onReset={state.handleReset}
        />
        <div aria-live="polite">
          <ResultPanel status={status} result={result} />
        </div>
      </div>
    </div>
  );
}

/**
 * New transaction. From 1024px up it shows the mock-backed form; below that it
 * renders the existing placeholder screen, unchanged. The form's state is kept
 * here, so crossing the breakpoint only changes what is shown.
 */
export function NewTransactionPage() {
  const isDesktop = useMediaQuery(DESKTOP);
  const state = useNewTransactionState();
  const spec = SCREENS.find((s) => s.path === "/transactions/new");
  if (!spec) throw new Error("The /transactions/new screen spec is missing from SCREENS.");

  return isDesktop ? <DesktopNewTransaction spec={spec} state={state} /> : <PendingScreen spec={spec} />;
}
