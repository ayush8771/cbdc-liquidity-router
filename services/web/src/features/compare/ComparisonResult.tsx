import type { ReactNode } from "react";
import { MandatoryLabel } from "../../components/labels/MandatoryLabel";
import { ButtonLink } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { DescriptionList } from "../../components/ui/DescriptionList";
import { Notice } from "../../components/ui/Notice";
import { Table, type TableColumn } from "../../components/ui/Table";
import { formatCorridor, formatDate, formatDateTime, formatPercent, formatUsd } from "../../lib/format";
import { OutcomeBadge } from "../transactions/OutcomeBadge";
import { PolicyCell } from "../transactions/PolicyCell";
import { POLICY_NAMES, type PolicyKey, type PolicyTier } from "../transactions/types";
import { modeName } from "../bridges/types";
import type { ComparedAllocationView, ComparedDecisionView, ComparisonView, PolicyColumnView } from "./types";

/**
 * What a policy's tier is, for a skipped policy (whose entry carries none): the contract's fixed tiers,
 * so the experimental policy keeps its Experimental label even when it did not run.
 */
const KNOWN_TIER: Record<PolicyKey, PolicyTier> = { waterfall: "default", cheapestFeasible: "baseline", ppoProjected: "experimental" };

const plain = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
const dash = <span className="text-ink-muted">—</span>;

/** The engine's own number, with no unit, sign convention or level added: reward, latency and risk have none. */
const raw = (value: number) => plain.format(value);

function allocationColumns(withProjection: boolean): TableColumn<ComparedAllocationView>[] {
  const columns: TableColumn<ComparedAllocationView>[] = [
    {
      key: "venue",
      header: "Venue",
      cell: (a) => <span className="whitespace-nowrap font-mono text-meta text-ink-secondary">{a.bridgeUid}</span>,
    },
    { key: "share", header: "Share", numeric: true, cell: (a) => formatPercent(a.shareRequested) },
  ];
  if (withProjection) {
    columns.push({
      key: "before",
      header: "Before projection",
      numeric: true,
      cell: (a) => (a.shareBeforeProjection === null ? dash : formatPercent(a.shareBeforeProjection)),
    });
  }
  columns.push(
    { key: "requested", header: "Requested", numeric: true, cell: (a) => formatUsd(a.amountRequestedUsd) },
    { key: "executed", header: "Executed", numeric: true, cell: (a) => formatUsd(a.amountExecutedUsd) },
    { key: "clipped", header: "Clipped", numeric: true, cell: (a) => formatUsd(a.amountClippedUsd) },
  );
  return columns;
}

function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="eyebrow">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** A policy that ran. Every number is the engine's; nothing is compared, scored or highlighted. */
function ResultBody({ decision }: { decision: ComparedDecisionView }) {
  const name = POLICY_NAMES[decision.policy] ?? decision.policy;
  const withProjection = decision.allocations.some((a) => a.shareBeforeProjection !== null);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <OutcomeBadge outcome={decision.outcome} />
        {decision.outcome === "rejected" ? (
          <span className="text-ui text-ink-muted">Not allowed by the feasibility rules. This is a result, not an error.</span>
        ) : null}
      </div>

      <DescriptionList
        items={[
          { term: "Executed", detail: formatUsd(decision.totals.executedUsd) },
          { term: "Unrouted", detail: formatUsd(decision.totals.unroutedAmountBasedUsd) },
          { term: "Completion", detail: formatPercent(decision.totals.completionRatio) },
          { term: "Bridges used", detail: decision.totals.bridgesUsed },
          ...(decision.feasibility.reason ? [{ term: "Reason", detail: decision.feasibility.reason }] : []),
        ]}
      />

      <Section title="Metrics" actions={<MandatoryLabel kind="placeholderWeights" />}>
        <DescriptionList
          items={[
            { term: "Fee cost", detail: formatUsd(decision.metrics.feeCostUsd) },
            { term: "Latency term", detail: raw(decision.metrics.latencyTerm) },
            { term: "Risk term", detail: raw(decision.metrics.riskTerm) },
            { term: "Reward (amount-based)", detail: raw(decision.metrics.rewardAmountBased) },
          ]}
        />
        <p className="text-meta text-ink-muted">
          Latency, risk and reward use reward weights that are placeholders ({decision.metrics.weightsStatus}). They have
          no stated unit, so they are shown as the engine gave them.
        </p>
      </Section>

      <Section title="Allocations">
        {decision.allocations.length === 0 ? (
          <p className="text-ui text-ink-muted">Nothing was allocated.</p>
        ) : (
          <Table
            caption={`Allocations of ${name}`}
            columns={allocationColumns(withProjection)}
            rows={decision.allocations}
            getRowKey={(a) => a.bridgeUid}
          />
        )}
        {decision.projectionApplied ? (
          <p className="text-meta text-ink-muted">
            The capacity projection adjusted this policy&apos;s allocation to the venues&apos; liquidity. It is a correction
            applied after the policy, not something the policy learned.
          </p>
        ) : null}
      </Section>

      <Section title="Warnings">
        {decision.warnings.length === 0 ? (
          <p className="text-ui text-ink-muted">No warnings.</p>
        ) : (
          <ul className="space-y-3">
            {decision.warnings.map((w) => (
              <li key={`${w.code}:${w.message}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-ui">
                <code className="rounded-pill border border-line px-2.5 py-1 text-meta text-ink-secondary">{w.code}</code>
                <span className="text-ink-body">{w.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function PolicyColumn({ column }: { column: PolicyColumnView }) {
  const name = POLICY_NAMES[column.policy] ?? column.policy;
  return (
    <Card aria-label={`${name} result`} className="min-w-0">
      <CardHeader
        title={name}
        actions={
          column.kind === "result" ? <PolicyCell policy={column.policy} tier={column.decision.policyTier} /> : <PolicyCell policy={column.policy} tier={KNOWN_TIER[column.policy] ?? null} />
        }
      />
      {column.kind === "result" ? (
        <ResultBody decision={column.decision} />
      ) : (
        <Notice title="Skipped">
          <p>The engine did not run this policy, so there is no result for it. The comparison was still saved.</p>
          <p className="mt-2">
            <code className="text-ink-body">{column.code}</code>: {column.message}
          </p>
        </Notice>
      )}
    </Card>
  );
}

const COLUMNS_CLASS: Record<number, string> = { 1: "xl:grid-cols-1", 2: "xl:grid-cols-2", 3: "xl:grid-cols-3" };

type ComparisonResultProps = {
  comparison: ComparisonView;
  /** Shows a link to this comparison's own page (for a comparison just made). */
  showLink?: boolean;
};

/**
 * A comparison: the transaction, then one column per policy in the order they
 * were asked for (stacked below 1280px, side by side from there). It shows no
 * winner, ranking, score or "best" anywhere: the API's own note says a single
 * comparison under placeholder weights is not evidence that one policy is
 * better, and that note is always shown, as written.
 */
export function ComparisonResult({ comparison, showLink = false }: ComparisonResultProps) {
  const { transaction } = comparison;
  return (
    <div className="space-y-6">
      <Notice title="A comparison, not a ranking">
        <p>{comparison.note}</p>
        <p className="mt-2 text-meta text-ink-muted">
          The policies are shown in the order you chose. Nothing is ranked, scored or highlighted.
        </p>
      </Notice>

      <Card aria-label="Compared transaction">
        <CardHeader title="Transaction" actions={<MandatoryLabel kind="simulated" />} />
        <DescriptionList
          items={[
            { term: "Corridor", detail: transaction.corridor ? formatCorridor(transaction.corridor) : dash },
            { term: "From and to", detail: `${transaction.senderCountry} to ${transaction.receiverCountry}` },
            { term: "Amount", detail: formatUsd(transaction.amountUsd) },
            { term: "State", detail: `${modeName(comparison.stateMode)}, ${formatDate(transaction.simulationDate)}` },
            { term: "Client reference", detail: transaction.clientReference ?? dash },
            { term: "Saved", detail: formatDateTime(comparison.createdAt) },
            {
              term: "Comparison ID",
              detail: (
                <span className="inline-flex flex-wrap items-center gap-3">
                  <span className="break-all font-mono text-meta">{comparison.id}</span>
                  {showLink ? (
                    <ButtonLink to={`/compare/${comparison.id}`} variant="secondary" size="sm">
                      Open this comparison
                    </ButtonLink>
                  ) : null}
                </span>
              ),
            },
          ]}
        />
      </Card>

      <section aria-label="Policy results" className={`grid grid-cols-1 gap-6 ${COLUMNS_CLASS[comparison.columns.length] ?? "xl:grid-cols-3"}`}>
        {comparison.columns.map((column) => (
          <PolicyColumn key={column.policy} column={column} />
        ))}
      </section>
    </div>
  );
}
