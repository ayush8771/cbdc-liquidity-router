import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useDataMode } from "../api/dataMode";
import { useAuth } from "../auth/AuthContext";
import { MandatoryLabel } from "../components/labels/MandatoryLabel";
import { Notice } from "../components/ui/Notice";
import { PageHeading } from "../components/ui/PageHeading";
import { StatusIndicator } from "../components/ui/StatusIndicator";
import { withoutChangedErrors } from "../features/newTransaction/formErrors";
import { ReferenceStatus } from "../features/newTransaction/ReferenceStatus";
import { ResultPanel } from "../features/newTransaction/ResultPanel";
import { describeUncertain, submitTransaction } from "../features/newTransaction/submitApi";
import { useLiveReference } from "../features/newTransaction/useReference";
import { TransactionForm } from "../features/newTransaction/TransactionForm";
import type {
  FieldErrors,
  FormErrorView,
  FormValues,
  LiveSubmitResult,
  ReferenceData,
} from "../features/newTransaction/types";
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

/**
 * The screen's state: the values, errors and last result. It lives in
 * NewTransactionPage, above the 1024px switch, so a window that is resized
 * across the breakpoint doesn't wipe what the user typed or the last result.
 *
 * A request is never retried automatically, and a second submit is ignored
 * while one is running.
 *
 * Live (the default data mode, src/api/dataMode.ts) the submission goes to
 * POST /api/v1/transactions through the signed-in session's client; in preview
 * mode it goes to the stand-in service and the ?mock= failures apply.
 */
function useNewTransactionState(live: boolean) {
  const { api } = useAuth();
  const [params] = useSearchParams();
  const failure = live ? null : readMockFailure(params);

  const [values, setValues] = useState<FormValues>(initialValues);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<FormErrorView | null>(null);
  const [status, setStatus] = useState<"idle" | "submitting" | "done">("idle");
  const [result, setResult] = useState<LiveSubmitResult | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const inFlight = useRef(false);

  function handleChange(next: FormValues) {
    setErrors((current) => withoutChangedErrors(current, values, next));
    setValues(next);
  }

  async function handleSubmit(reference: ReferenceData) {
    if (inFlight.current) return;
    const checked = validateForm(values, reference);
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
      const outcome: LiveSubmitResult = live
        ? await submitTransaction(api, checked.payload)
        : await submitPreviewTransaction(checked.payload, { failure });
      setResult(outcome);
      if (outcome.kind === "error") {
        const described = describeFailure(outcome.error);
        setErrors(described.fields);
        setFormError(described.form);
        if (Object.keys(described.fields).length > 0) setFocusSignal((n) => n + 1);
      } else if (outcome.kind === "uncertain") {
        // No way to tell whether it was saved: warn, keep what was typed, and retry nothing.
        setFormError(describeUncertain(outcome.reason));
      }
    } catch {
      if (live) {
        // Not reachable in practice (submitTransaction never throws), but if it ever happens
        // the transaction may have been sent, so it is never reported as "nothing was saved".
        setResult({ kind: "uncertain", reason: "unreadable" });
        setFormError(describeUncertain("unreadable"));
      } else {
        setFormError({
          title: "Something went wrong",
          messages: ["The preview submission failed unexpectedly. Nothing was saved."],
          code: "PREVIEW_ERROR",
          requestId: "preview",
        });
      }
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
 * New transaction, from 1024px up. Live by default: the form's options come
 * from three separate reads (corridors from GET /api/v1/network, scenarios from
 * GET /api/v1/scenarios, policies from GET /api/v1/meta), each with its own
 * loading and error and its own retry, and the submission goes to
 * POST /api/v1/transactions. In preview mode (VITE_API_MODE=preview) the options
 * and the stand-in submission service are the preview data, nothing is sent to
 * the API, and the failures ?mock=validation|busy|timeout|unavailable|notready|error apply.
 */
function DesktopNewTransaction({
  spec,
  state,
  live,
}: {
  spec: ScreenSpec;
  state: ReturnType<typeof useNewTransactionState>;
  live: boolean;
}) {
  const { failure, values, errors, formError, status, result, focusSignal } = state;
  const liveReference = useLiveReference(live);
  const reference: ReferenceData | null = live ? liveReference.reference : PREVIEW_REFERENCE;

  return (
    <div className="space-y-8">
      <PageHeading
        eyebrow={spec.eyebrow}
        title={spec.title}
        description={spec.description}
        actions={<StatusIndicator tone="neutral" label={live ? "Live data" : "Not connected"} />}
        meta={<MandatoryLabel kind="simulated" />}
      />

      {live ? null : <PreviewNotice />}
      {spec.showCarryOverNote ? <Notice>{NO_LIQUIDITY_CARRY_OVER}</Notice> : null}
      {failure ? (
        <Notice title={`Preview failure mode: ${failure}`}>
          Every submission returns this failure, so you can review how it looks. Remove <code className="text-ink-body">?mock=</code>{" "}
          from the address to leave this mode.
        </Notice>
      ) : null}

      {/* Stacked up to 1535px, so the form and the result each get the full width; side by side only on very wide screens. */}
      <div className="grid grid-cols-1 gap-6 2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] 2xl:items-start">
        {reference ? (
          <TransactionForm
            values={values}
            errors={errors}
            reference={reference}
            submitting={status === "submitting"}
            formError={formError}
            focusSignal={focusSignal}
            onChange={state.handleChange}
            onSubmit={() => state.handleSubmit(reference)}
            onReset={state.handleReset}
          />
        ) : (
          <ReferenceStatus queries={liveReference.queries} />
        )}
        <div aria-live="polite">
          <ResultPanel status={status} result={result} live={live} />
        </div>
      </div>
    </div>
  );
}

/**
 * New transaction. From 1024px up it shows the form (live, or on the stand-in service in preview mode); below that it
 * renders the existing placeholder screen, unchanged. The form's state is kept
 * here, so crossing the breakpoint only changes what is shown.
 */
export function NewTransactionPage() {
  const isDesktop = useMediaQuery(DESKTOP);
  const live = useDataMode() === "live";
  const state = useNewTransactionState(live);
  const spec = SCREENS.find((s) => s.path === "/transactions/new");
  if (!spec) throw new Error("The /transactions/new screen spec is missing from SCREENS.");

  return isDesktop ? <DesktopNewTransaction spec={spec} state={state} live={live} /> : <PendingScreen spec={spec} />;
}
