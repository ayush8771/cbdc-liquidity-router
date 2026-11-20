import { MandatoryLabel } from "../../../components/labels/MandatoryLabel";
import { Card, CardHeader } from "../../../components/ui/Card";
import { DescriptionList } from "../../../components/ui/DescriptionList";
import { Notice } from "../../../components/ui/Notice";
import { Stat } from "../../../components/ui/Stat";
import { formatCorridor, formatDate, formatDateTime, formatPercent, formatUsd } from "../../../lib/format";
import type { TransactionDetailView } from "../detailTypes";
import { OutcomeBadge } from "../OutcomeBadge";
import { PolicyCell } from "../PolicyCell";
import { STATE_MODE_NAMES, type Outcome } from "../types";
import { Dash, orDash } from "./dash";

const OUTCOME_TEXT: Record<Outcome, string> = {
  completed: "Routed and fully executed.",
  partial: "Routed, but only part of the amount was executed.",
  rejected: "Not allowed by the feasibility rules. This is a valid routing result, not an error.",
  failed: "The routing call failed, so there is no decision.",
};

/** Business outcomes are explained plainly; only a failed call is shown as a failure. */
function OutcomeNotice({ detail }: { detail: TransactionDetailView }) {
  const decision = detail.decision;
  if (detail.outcome === "failed") {
    return (
      <Notice tone="danger" title="Routing failed">
        <p>This transaction was saved, but the routing call did not complete, so there is no decision.</p>
        <p className="mt-2">
          Code: <code className="text-ink-body">{detail.failure?.code ?? "—"}</code>
        </p>
        <p>Message: {orDash(detail.failure?.message)}</p>
      </Notice>
    );
  }
  if (detail.outcome === "rejected") {
    return (
      <Notice title="Rejected by the feasibility rules">
        <p>{orDash(decision?.feasibility.reason)}</p>
        <p className="mt-1">This is a valid routing result, not an error. Nothing was allocated.</p>
      </Notice>
    );
  }
  if (detail.outcome === "partial" && decision) {
    return (
      <Notice tone="warning" title="Partially completed">
        {formatPercent(decision.totals.completionRatio)} of the amount was executed;{" "}
        {formatUsd(decision.totals.unroutedAmountBasedUsd)} is unrouted. This is a routing result, not an error.
      </Notice>
    );
  }
  return null;
}

/** Outcome notice, the three amounts, and the transaction's own details. */
export function DetailOverview({ detail }: { detail: TransactionDetailView }) {
  const totals = detail.decision?.totals ?? null;

  return (
    <>
      <OutcomeNotice detail={detail} />

      <Card aria-label="Amounts">
        <div className="grid grid-cols-3 gap-8">
          <Stat size="sm" label="Requested" value={formatUsd(detail.amountUsd)} />
          <Stat size="sm" label="Executed" value={totals ? formatUsd(totals.executedUsd) : "—"} />
          <Stat
            size="sm"
            label="Unrouted"
            value={totals ? formatUsd(totals.unroutedAmountBasedUsd) : "—"}
            meta={<span className="text-meta text-ink-muted">Requested amount minus executed</span>}
          />
        </div>
      </Card>

      <Card aria-label="Transaction">
        <CardHeader title="Transaction" />
        <DescriptionList
          items={[
            { term: "Transaction ID", detail: <span className="break-all font-mono text-meta">{detail.id}</span> },
            {
              term: "Status",
              detail: (
                <span className="inline-flex flex-wrap items-center gap-3">
                  <OutcomeBadge outcome={detail.outcome} />
                  <span className="text-ink-muted">{OUTCOME_TEXT[detail.outcome]}</span>
                </span>
              ),
            },
            { term: "Created", detail: formatDateTime(detail.createdAt) },
            { term: "Corridor", detail: detail.corridor ? formatCorridor(detail.corridor) : orDash(null) },
            { term: "Source", detail: orDash(detail.senderCountry) },
            { term: "Destination", detail: orDash(detail.receiverCountry) },
            {
              term: "Policy",
              // A failed transaction from the API has no policy of its own to show.
              detail: detail.policy ? <PolicyCell policy={detail.policy} tier={detail.policyTier} /> : orDash(null),
            },
            {
              term: "State",
              detail: detail.stateMode ? (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span>
                    {STATE_MODE_NAMES[detail.stateMode] ?? detail.stateMode}, {formatDate(detail.simulationDate)}
                  </span>
                  {detail.stateMode === "explicit" ? <MandatoryLabel kind="userSuppliedState" /> : null}
                </span>
              ) : (
                // No state mode on a failed transaction: "—", and the simulation date it did have.
                <span className="inline-flex flex-wrap items-center gap-2">
                  <Dash />
                  <span className="text-ink-muted">Simulation date {formatDate(detail.simulationDate)}</span>
                </span>
              ),
            },
            { term: "Client reference", detail: orDash(detail.clientReference) },
          ]}
        />
      </Card>
    </>
  );
}
