import { Button } from "./Button";
import { Icon } from "./Icon";

type PaginationProps = {
  /** 1-based page number. */
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  /** What is being counted, e.g. "transactions". */
  itemLabel?: string;
};

/** Previous/next paging with a "Showing 21–40 of 57" summary. Hidden when there is nothing to page. */
export function Pagination({ page, pageSize, total, onPageChange, itemLabel = "results" }: PaginationProps) {
  if (total <= 0) return null;

  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3 pt-4">
      <p className="text-ui text-ink-muted" aria-live="polite">
        Showing <span className="tabular-nums text-ink-body">{first}</span>–
        <span className="tabular-nums text-ink-body">{last}</span> of{" "}
        <span className="tabular-nums text-ink-body">{total}</span> {itemLabel}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          iconStart={<Icon name="arrowRight" size={14} className="rotate-180" />}
        >
          Previous
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={page >= lastPage}
          onClick={() => onPageChange(page + 1)}
          iconEnd={<Icon name="arrowRight" size={14} />}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}
