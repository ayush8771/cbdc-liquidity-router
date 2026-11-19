import type { ReactNode } from "react";
import { cx } from "../../lib/cx";

export type TableColumn<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Right-aligns the column and uses tabular figures (DESIGN.md: right-aligned numerics). */
  numeric?: boolean;
  className?: string;
};

type TableProps<T> = {
  /** Describes the table for screen readers; shown visually only when `showCaption` is set. */
  caption: string;
  showCaption?: boolean;
  columns: TableColumn<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  /** Rendered in place of the body when `rows` is empty. */
  empty?: ReactNode;
};

/**
 * DESIGN.md "Data Table Row": transparent fill, 1px Graphite bottom border on
 * each row, Fog 14px/500 headers, Bone cell values. A wide table scrolls
 * inside its own container, so the page itself never scrolls sideways.
 */
export function Table<T>({ caption, showCaption = false, columns, rows, getRowKey, empty }: TableProps<T>) {
  if (rows.length === 0 && empty) return <>{empty}</>;

  return (
    // `relative` makes this the containing block for absolutely positioned
    // descendants (sr-only text), so they are clipped here instead of
    // widening the page.
    <div className="relative w-full overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <caption className={showCaption ? "pb-3 text-left text-ui text-ink-muted" : "sr-only"}>{caption}</caption>
        <thead>
          <tr className="border-b border-line-subtle">
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={cx(
                  "whitespace-nowrap px-2.5 pb-3 text-ui font-medium text-ink-muted first:pl-0 last:pr-0",
                  col.numeric && "text-right",
                  col.className,
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={getRowKey(row)} className="border-b border-line-subtle">
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={cx(
                    "px-2.5 py-3 align-top text-ui text-ink-body first:pl-0 last:pr-0",
                    col.numeric && "whitespace-nowrap text-right tabular-nums",
                    col.className,
                  )}
                >
                  {col.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
