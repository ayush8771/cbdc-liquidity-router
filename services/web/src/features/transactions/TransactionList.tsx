import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../../components/ui/Icon";
import { Table, type TableColumn } from "../../components/ui/Table";
import { formatCorridor, formatDateTime, formatUsd, shortId } from "../../lib/format";
import { OutcomeBadge } from "./OutcomeBadge";
import { PolicyCell } from "./PolicyCell";
import { POLICY_NAMES, type TransactionRow } from "./types";

const detailPath = (id: string) => `/transactions/${id}`;

function Corridor({ corridor }: { corridor: string | null }) {
  if (corridor) return <>{formatCorridor(corridor)}</>;
  return (
    <span className="text-ink-muted">
      <span aria-hidden="true">—</span>
      <span className="sr-only">Not confirmed</span>
    </span>
  );
}

const columns: TableColumn<TransactionRow>[] = [
  {
    key: "id",
    header: "Transaction",
    cell: (r) => (
      <span className="font-mono text-meta text-ink-secondary" title={r.id}>
        {shortId(r.id)}
      </span>
    ),
  },
  { key: "corridor", header: "Corridor", cell: (r) => <Corridor corridor={r.corridor} /> },
  { key: "amount", header: "Amount", numeric: true, cell: (r) => formatUsd(r.amountUsd) },
  { key: "status", header: "Status", cell: (r) => <OutcomeBadge outcome={r.outcome} /> },
  { key: "policy", header: "Policy", cell: (r) => <PolicyCell policy={r.policy} tier={r.policyTier} /> },
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
        to={detailPath(r.id)}
        aria-label={`View transaction ${shortId(r.id)}`}
        className="inline-flex items-center gap-1 rounded-pill text-ui font-medium text-ink-muted hover:text-paper-white"
      >
        View
        <Icon name="arrowRight" size={14} />
      </Link>
    ),
  },
];

type TransactionListProps = {
  rows: TransactionRow[];
  caption: string;
  empty?: ReactNode;
};

/**
 * Table from md up; stacked cards on small screens, where seven columns would
 * not fit. Every row leads to the transaction's detail page.
 */
export function TransactionList({ rows, caption, empty }: TransactionListProps) {
  if (rows.length === 0 && empty) return <>{empty}</>;

  return (
    <>
      <div className="hidden md:block">
        <Table caption={caption} columns={columns} rows={rows} getRowKey={(r) => r.id} />
      </div>

      <ul className="space-y-3 md:hidden" aria-label={caption}>
        {rows.map((r) => (
          <li key={r.id}>
            <Link
              to={detailPath(r.id)}
              aria-label={`Transaction ${shortId(r.id)}, ${r.corridor ? formatCorridor(r.corridor) : "corridor not confirmed"}, ${formatUsd(r.amountUsd)}, ${r.outcome}, ${POLICY_NAMES[r.policy]}`}
              className="block rounded-card border border-line-subtle bg-surface-card p-4 transition-colors hover:border-line"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-meta text-ink-secondary">{shortId(r.id)}</span>
                <OutcomeBadge outcome={r.outcome} />
              </div>
              <div className="mt-3 flex items-baseline justify-between gap-3">
                <span className="text-ui text-ink-body">
                  <Corridor corridor={r.corridor} />
                </span>
                <span className="text-ui font-medium tabular-nums text-ink-primary">{formatUsd(r.amountUsd)}</span>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-meta text-ink-muted">
                <PolicyCell policy={r.policy} tier={r.policyTier} />
                <span>{formatDateTime(r.createdAt)}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
