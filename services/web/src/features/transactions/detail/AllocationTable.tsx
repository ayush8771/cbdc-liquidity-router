import { MandatoryLabel } from "../../../components/labels/MandatoryLabel";
import { Card, CardHeader } from "../../../components/ui/Card";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Table, type TableColumn } from "../../../components/ui/Table";
import { formatFeeFraction, formatPercent, formatUsd } from "../../../lib/format";
import type { AllocationView, DecisionView } from "../detailTypes";

const columns: TableColumn<AllocationView>[] = [
  {
    key: "venue",
    header: "Venue",
    cell: (a) => (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span className="font-mono text-meta text-ink-secondary">{a.bridgeUid}</span>
        {a.dataSourceTag === "synthetic_bridge_expansion" ? <MandatoryLabel kind="syntheticVenue" /> : null}
      </span>
    ),
  },
  { key: "fee", header: "Fee", numeric: true, cell: (a) => formatFeeFraction(a.feePct) },
  { key: "liquidity", header: "Liquidity", numeric: true, cell: (a) => formatUsd(a.liquidityUsd) },
  { key: "share", header: "Share requested", numeric: true, cell: (a) => formatPercent(a.shareRequested) },
  { key: "requested", header: "Requested", numeric: true, cell: (a) => formatUsd(a.amountRequestedUsd) },
  { key: "executed", header: "Executed", numeric: true, cell: (a) => formatUsd(a.amountExecutedUsd) },
  { key: "clipped", header: "Clipped", numeric: true, cell: (a) => formatUsd(a.amountClippedUsd) },
];

/** How the amount was split across venues. Empty for a rejection, absent for a failure. */
export function AllocationTable({ decision }: { decision: DecisionView | null }) {
  return (
    <Card aria-label="Allocations">
      <CardHeader title="Allocations" description="How the amount was split across bridge venues." />
      {!decision ? (
        <EmptyState icon="info" title="No allocations">
          There is no decision for this transaction, so nothing was allocated.
        </EmptyState>
      ) : decision.allocations.length === 0 ? (
        <EmptyState icon="info" title="No allocations">
          {decision.feasibility.allowed
            ? "The decision contains no allocations."
            : "The transaction wasn't allowed, so nothing was allocated."}
        </EmptyState>
      ) : (
        <Table caption="Allocations by venue" columns={columns} rows={decision.allocations} getRowKey={(a) => a.bridgeUid} />
      )}
    </Card>
  );
}
