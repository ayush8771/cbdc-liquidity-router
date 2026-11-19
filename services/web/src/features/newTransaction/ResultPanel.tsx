import { MandatoryLabel } from "../../components/labels/MandatoryLabel";
import { Card, CardHeader } from "../../components/ui/Card";
import { EmptyState } from "../../components/ui/EmptyState";
import { LoadingState } from "../../components/ui/LoadingState";
import { Notice } from "../../components/ui/Notice";
import { Stat } from "../../components/ui/Stat";
import { Table, type TableColumn } from "../../components/ui/Table";
import { formatCorridor, formatPercent, formatUsd } from "../../lib/format";
import type { AllocationView, TransactionDetailView } from "../transactions/detailTypes";
import { WarningsPanel } from "../transactions/detail/DecisionPanel";
import type { SubmitResult } from "./types";
import { isNotReady } from "./validate";

export const PREVIEW_RESULT_LABEL = "Preview result — illustrative, not from the API";

// No fee column and no share column: this panel only summarises the result, and the transaction's own page shows both.
const columns: TableColumn<AllocationView>[] = [
  {
    key: "venue",
    header: "Venue",
    cell: (a) => <span className="whitespace-nowrap font-mono text-meta text-ink-secondary">{a.bridgeUid}</span>,
  },
  { key: "requested", header: "Requested", numeric: true, cell: (a) => formatUsd(a.amountRequestedUsd) },
  { key: "executed", header: "Executed", numeric: true, cell: (a) => formatUsd(a.amountExecutedUsd) },
  { key: "clipped", header: "Clipped", numeric: true, cell: (a) => formatUsd(a.amountClippedUsd) },
];

function PreviewLabel() {
  return (
    <Notice title={PREVIEW_RESULT_LABEL}>
      Made by a stand-in for the engine. Nothing was sent to the API.
    </Notice>
  );
}

/** A routed transaction. Rejection and partial completion are results, not errors. */
function RoutedResult({ transaction }: { transaction: TransactionDetailView }) {
  const decision = transaction.decision;
  if (!decision) return null; // a routed transaction always has a decision

  return (
    <div className="space-y-6">
      <PreviewLabel />

      {transaction.outcome === "rejected" ? (
        <Notice title="Rejected by the feasibility rules">
          <p>{decision.feasibility.reason ?? "—"}</p>
          <p className="mt-1">This is a valid routing result, not an error. Nothing was allocated.</p>
        </Notice>
      ) : transaction.outcome === "partial" ? (
        <Notice tone="warning" title="Partially completed">
          {formatPercent(decision.totals.completionRatio)} of the amount was executed;{" "}
          {formatUsd(decision.totals.unroutedAmountBasedUsd)} is unrouted. This is a routing result, not an error.
        </Notice>
      ) : (
        <Notice tone="success" title="Routed and fully executed">
          The whole amount was executed.
        </Notice>
      )}

      <Card aria-label="Result">
        <CardHeader
          title="Result"
          description={`${transaction.corridor ? formatCorridor(transaction.corridor) : "—"} · ${transaction.senderCountry} to ${transaction.receiverCountry}`}
          actions={<MandatoryLabel kind="simulated" />}
        />
        <div className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-6">
          <Stat size="sm" label="Requested" value={formatUsd(transaction.amountUsd)} />
          <Stat size="sm" label="Executed" value={formatUsd(decision.totals.executedUsd)} />
          <Stat size="sm" label="Unrouted" value={formatUsd(decision.totals.unroutedAmountBasedUsd)} />
        </div>
        <dl className="mt-6 border-t border-line-subtle pt-4 text-ui">
          <dt className="text-ink-muted">Transaction ID</dt>
          <dd className="mt-1 break-all font-mono text-meta text-ink-body">{transaction.id}</dd>
          <dd className="mt-1 text-meta text-ink-muted">
            Shown as text only: this preview transaction isn&apos;t in the History list.
          </dd>
        </dl>
      </Card>

      <Card aria-label="Allocations">
        <CardHeader title="Allocations" description="How the amount was split across bridge venues." />
        {decision.allocations.length === 0 ? (
          <p className="text-ui text-ink-muted">Nothing was allocated, because the transaction wasn&apos;t allowed.</p>
        ) : (
          <Table caption="Allocations by venue" columns={columns} rows={decision.allocations} getRowKey={(a) => a.bridgeUid} />
        )}
      </Card>

      <WarningsPanel decision={decision} />
    </div>
  );
}

type ResultPanelProps = {
  status: "idle" | "submitting" | "done";
  result: SubmitResult | null;
};

/** What the last submission produced. The message for an error is in the form; this says what it means for the transaction. */
export function ResultPanel({ status, result }: ResultPanelProps) {
  if (status === "submitting") {
    return (
      <Card aria-label="Result">
        <LoadingState label="Routing the transaction" rows={6} />
      </Card>
    );
  }

  if (!result) {
    return (
      <Card aria-label="Result" padded={false}>
        <EmptyState icon="route" title="No result yet">
          Submit the form to see an illustrative routing result.
        </EmptyState>
      </Card>
    );
  }

  if (result.kind === "routed") return <RoutedResult transaction={result.transaction} />;

  const { error } = result;
  const transactionId = error.details.transactionId;

  // The engine was still starting up (503 INFERENCE_UNAVAILABLE, details.cause NOT_READY). Nothing
  // is retried and no countdown is shown: whether a Retry-After arrives is still an open question.
  if (isNotReady(error)) {
    return (
      <div className="space-y-6">
        <PreviewLabel />
        <Notice
          tone="danger"
          title={transactionId ? "Routing engine starting up — saved without a decision" : "Routing engine starting up"}
        >
          <p>
            The routing engine hadn&apos;t finished starting up, so nothing was routed
            {transactionId ? ", and the transaction was saved as failed, with no decision" : ""}.
          </p>
          {transactionId ? (
            <p className="mt-2">
              Transaction ID: <code className="break-all text-ink-body">{transactionId}</code>
            </p>
          ) : null}
          <p className="mt-1 text-meta text-ink-muted">
            {transactionId ? "Shown as text only. " : ""}It is not retried automatically: submit again once the engine has started.
          </p>
        </Notice>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PreviewLabel />
      {transactionId ? (
        <Notice tone="danger" title="Routing failed — saved without a decision">
          <p>The transaction was saved as failed, so it has no decision and nothing was routed.</p>
          <p className="mt-2">
            Transaction ID: <code className="break-all text-ink-body">{transactionId}</code>
          </p>
          <p className="mt-1 text-meta text-ink-muted">
            Shown as text only. It is not retried automatically: submit again when you are ready.
          </p>
        </Notice>
      ) : (
        <Notice tone="warning" title="Not saved">
          <p>The request was not accepted, so no transaction was created and nothing was routed.</p>
          <p className="mt-1 text-meta text-ink-muted">Fix the form and submit again.</p>
        </Notice>
      )}
    </div>
  );
}
