import { Table, type TableColumn } from "../../components/ui/Table";
import { Icon } from "../../components/ui/Icon";
import { formatCount, formatPercent } from "../../lib/format";

export type ActivityItem = {
  key: string;
  label: string;
  value: number;
  /** A share in [0, 1], or null when nothing qualified. */
  completionRate: number | null;
};

type ActivityBarsProps = {
  items: ActivityItem[];
  /** Names the chart for assistive technology and the table view. */
  caption: string;
  categoryHeader: string;
};

const completion = (rate: number | null) => (rate === null ? "No eligible decisions" : `${formatPercent(rate)} completed`);

/**
 * Single-series horizontal bars (one colour, so no legend; the card title
 * names the series). Bars are 12px thick with a 4px rounded data end and a
 * square baseline; the value sits at the tip in a text colour. Hover or focus
 * on a row shows a tooltip, and "View as table" gives every value without
 * hovering.
 */
export function ActivityBars({ items, caption, categoryHeader }: ActivityBarsProps) {
  const max = Math.max(1, ...items.map((i) => i.value));

  const tableColumns: TableColumn<ActivityItem>[] = [
    { key: "label", header: categoryHeader, cell: (i) => i.label },
    { key: "value", header: "Transactions", numeric: true, cell: (i) => formatCount(i.value) },
    {
      key: "rate",
      header: "Completion rate",
      numeric: true,
      cell: (i) => (i.completionRate === null ? "—" : formatPercent(i.completionRate)),
    },
  ];

  return (
    <div className="space-y-5">
      <ul aria-label={caption} className="space-y-1">
        {items.map((item) => {
          const description = `${item.label}: ${formatCount(item.value)} transactions, ${completion(item.completionRate)}`;
          return (
            <li
              key={item.key}
              tabIndex={0}
              aria-label={description}
              className="group relative grid grid-cols-[minmax(5.5rem,9rem)_1fr] items-center gap-3 rounded-card px-2 py-2 -mx-2 hover:bg-surface-panel focus-visible:bg-surface-panel"
            >
              <span className="truncate text-ui text-ink-body">{item.label}</span>
              <span className="flex items-center gap-2 border-l border-line pl-0">
                <span
                  aria-hidden="true"
                  className="block h-3 rounded-r-[4px] bg-chart-mark transition-[filter] group-hover:brightness-110 group-focus-visible:brightness-110"
                  style={{ width: item.value > 0 ? `max(2px, calc((100% - 3.5rem) * ${item.value / max}))` : "0px" }}
                />
                <span aria-hidden="true" className="text-ui tabular-nums text-ink-secondary">
                  {formatCount(item.value)}
                </span>
              </span>

              {/* Tooltip: value first, label second. Visual only; the row's
                  label and the table view carry the same information. Out of
                  layout until shown, and kept within the row's width, so it
                  can never widen the page on small screens. */}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute bottom-full left-2 z-10 mb-1 hidden max-w-[calc(100%-1rem)] rounded-card border border-line bg-surface-floating px-3 py-2 group-hover:block group-focus-visible:block"
              >
                <span className="block text-ui font-semibold text-ink-primary">
                  {formatCount(item.value)} transactions
                </span>
                <span className="block text-meta text-ink-muted">
                  {item.label} · {completion(item.completionRate)}
                </span>
              </span>
            </li>
          );
        })}
      </ul>

      <details className="group/table border-t border-line-subtle pt-4">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-pill text-ui font-medium text-ink-muted hover:text-paper-white [&::-webkit-details-marker]:hidden">
          View as table
          <Icon name="chevronDown" size={14} className="transition-transform group-open/table:rotate-180" />
        </summary>
        <div className="pt-4">
          <Table caption={caption} columns={tableColumns} rows={items} getRowKey={(i) => i.key} />
        </div>
      </details>
    </div>
  );
}
