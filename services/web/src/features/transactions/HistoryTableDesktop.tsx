import { Link } from "react-router-dom";
import { Icon } from "../../components/ui/Icon";
import { Table, type TableColumn } from "../../components/ui/Table";
import { formatCorridor, formatDate, formatDateTime, formatPercent, formatUsd, shortId } from "../../lib/format";
import { outcomeOf, type TransactionSummaryView } from "./historyTypes";
import { OutcomeBadge } from "./OutcomeBadge";
import { PolicyCell } from "./PolicyCell";
import { STATE_MODE_NAMES } from "./types";

/** "—" for a value that isn't available, with a text alternative for screen readers. */
function Unavailable({ label = "Not available" }: { label?: string }) {
  return (
    <span className="text-ink-muted">
      <span aria-hidden="true">—</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

const columns: TableColumn<TransactionSummaryView>[] = [
  {
    key: "id",
    header: "Transaction",
    cell: (r) => (
      <span className="font-mono text-meta text-ink-secondary" title={r.id}>
        {shortId(r.id)}
      </span>
    ),
  },
  {
    key: "corridor",
    header: "Corridor",
    // A failed transaction has no confirmed corridor, and it is never worked out from anything else.
    cell: (r) => (r.corridor ? formatCorridor(r.corridor) : <Unavailable label="Not confirmed" />),
  },
  { key: "amount", header: "Amount", numeric: true, cell: (r) => formatUsd(r.amountUsd) },
  { key: "status", header: "Status", cell: (r) => <OutcomeBadge outcome={outcomeOf(r)} /> },
  { key: "policy", header: "Policy", cell: (r) => <PolicyCell policy={r.policy} tier={r.policyStatus} /> },
  {
    key: "state",
    header: "State",
    cell: (r) => (
      <span className="block">
        <span className="block">{STATE_MODE_NAMES[r.stateMode] ?? r.stateMode}</span>
        <span className="block text-meta text-ink-muted">{formatDate(r.simulationDate)}</span>
      </span>
    ),
  },
  {
    key: "executed",
    header: "Executed",
    numeric: true,
    // Zero is a real value (a rejection executes nothing); only a missing value is a dash.
    cell: (r) =>
      r.executedUsd === null ? (
        <Unavailable />
      ) : (
        <span className="block">
          <span className="block">{formatUsd(r.executedUsd)}</span>
          <span className="block text-meta text-ink-muted">
            {r.completionRatio === null ? <Unavailable /> : formatPercent(r.completionRatio)}
          </span>
        </span>
      ),
  },
  {
    key: "created",
    header: "Created",
    cell: (r) => <span className="text-ink-secondary">{formatDateTime(r.createdAt)}</span>,
  },
  {
    key: "view",
    header: <span className="sr-only">Details</span>,
    numeric: true,
    cell: (r) => (
      <Link
        to={`/transactions/${r.id}`}
        aria-label={`View transaction ${shortId(r.id)}`}
        className="inline-flex items-center gap-1 rounded-pill text-ui font-medium text-ink-muted hover:text-paper-white"
      >
        View
        <Icon name="arrowRight" size={14} />
      </Link>
    ),
  },
];

/**
 * The desktop History table: the narrow list's columns, plus the state mode and
 * simulation date, and the executed amount with its share of the amount.
 * Failed, rejected, partial and completed transactions keep distinct badges.
 * There is no reward or created-by column.
 */
export function HistoryTableDesktop({ rows }: { rows: TransactionSummaryView[] }) {
  return <Table caption="Transactions" columns={columns} rows={rows} getRowKey={(r) => r.id} />;
}
