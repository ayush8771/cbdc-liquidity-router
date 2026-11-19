import { useSearchParams } from "react-router-dom";
import { Button, ButtonLink } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { LoadingState } from "../components/ui/LoadingState";
import { Notice } from "../components/ui/Notice";
import { PageHeading } from "../components/ui/PageHeading";
import { Pagination } from "../components/ui/Pagination";
import { StatusIndicator } from "../components/ui/StatusIndicator";
import { HistoryFiltersDesktop } from "../features/transactions/HistoryFiltersDesktop";
import {
  clearHistoryFilters,
  hasHistoryFilters,
  lastPageOf,
  listProblems,
  readHistoryQuery,
  toHistoryWindow,
  updateHistoryParams,
} from "../features/transactions/historyQuery";
import { HistoryTableDesktop } from "../features/transactions/HistoryTableDesktop";
import { queryPreviewHistory } from "../preview/previewHistory";
import { PreviewNotice } from "../preview/PreviewNotice";
import { usePreviewState } from "../preview/usePreviewState";
import { OpenById } from "./HistoryPage";

/**
 * The desktop History (1024px and up) on PREVIEW DATA. Filters, page size and
 * page live in the URL under the contract's query names, ready to pass to
 * GET /api/v1/transactions. Nothing invalid is used: every problem with the
 * URL is listed together and no transactions are shown until they are fixed.
 * Preview states: ?state=loading, ?state=empty and ?state=error.
 */
export function HistoryDesktop() {
  const [params, setParams] = useSearchParams();
  const { state, clear } = usePreviewState();
  const { query, problems } = readHistoryQuery(params);
  const problemList = listProblems(problems);
  const invalid = problemList.length > 0;

  const apply = (patch: Parameters<typeof updateHistoryParams>[1]) => setParams(updateHistoryParams(params, patch));
  const filtersActive = hasHistoryFilters(params);

  const dateWindow = toHistoryWindow(query);
  const result = invalid ? null : queryPreviewHistory({ ...query, window: dateWindow });
  const lastPage = result ? lastPageOf(result.total, result.pageSize) : 1;
  // A page past the last one is not clamped silently: the last page is shown, with a notice and a button.
  const pastLast = result !== null && result.total > 0 && query.page > lastPage;
  const shown = result && pastLast ? queryPreviewHistory({ ...query, window: dateWindow, page: lastPage }) : result;
  const shownPage = pastLast ? lastPage : query.page;
  const isEmpty = state === "empty" || (result !== null && result.total === 0);

  return (
    <div className="space-y-8">
      <PageHeading
        eyebrow="Records"
        title="History"
        description="Every stored transaction, newest first. Open one to see its allocation and decision."
        actions={<StatusIndicator tone="neutral" label="Not connected" />}
      />

      <PreviewNotice />

      <Card className="space-y-6">
        <OpenById />
        <div className="border-t border-line-subtle pt-6">
          <HistoryFiltersDesktop
            query={query}
            problems={problems}
            hasFilters={filtersActive}
            onChange={apply}
            onClear={() => setParams(clearHistoryFilters(params))}
          />
        </div>
      </Card>

      {invalid ? (
        <Notice tone="warning" title="Some parameters can't be used">
          <ul className="list-disc space-y-1 pl-5">
            {problemList.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <p className="mt-2">No transactions are shown until these are fixed. Nothing has been changed for you.</p>
        </Notice>
      ) : (
        <Card aria-labelledby="results-heading">
          <h2 id="results-heading" className="sr-only">
            Transactions
          </h2>
          {state === "loading" ? (
            <LoadingState label="Loading transactions" rows={8} />
          ) : state === "error" ? (
            <ErrorState
              title="Couldn't load transactions"
              message="This is the preview of an error. With the live API, the server's message appears here."
              reference="preview"
              action={
                <Button variant="secondary" onClick={clear}>
                  Try again
                </Button>
              }
            />
          ) : isEmpty ? (
            filtersActive && state !== "empty" ? (
              <EmptyState
                icon="history"
                title="No transactions match these filters"
                actions={
                  <Button variant="secondary" onClick={() => setParams(clearHistoryFilters(params))}>
                    Clear filters
                  </Button>
                }
              >
                Try a wider date range or fewer filters.
              </EmptyState>
            ) : (
              <EmptyState
                icon="history"
                title="No transactions yet"
                actions={
                  <ButtonLink to="/transactions/new" variant="primary">
                    New transaction
                  </ButtonLink>
                }
              >
                Transactions you route will be listed here.
              </EmptyState>
            )
          ) : shown ? (
            <>
              {pastLast ? (
                <div className="mb-6">
                  <Notice tone="warning" title={`Page ${query.page} doesn't exist`}>
                    <p>
                      These filters give {shown.total} {shown.total === 1 ? "transaction" : "transactions"} on {lastPage}{" "}
                      {lastPage === 1 ? "page" : "pages"}. The last page is shown below.
                    </p>
                    <div className="mt-3">
                      <Button variant="secondary" size="sm" onClick={() => apply({ page: String(lastPage) })}>
                        Go to page {lastPage}
                      </Button>
                    </div>
                  </Notice>
                </div>
              ) : null}
              {/* The nine columns need the wider layout; below 1280px the table scrolls inside its card. */}
              <p className="mb-3 text-meta text-ink-muted xl:hidden">Scroll sideways to see every column.</p>
              <HistoryTableDesktop rows={shown.items} />
              <Pagination
                page={shownPage}
                pageSize={shown.pageSize}
                total={shown.total}
                itemLabel="transactions"
                onPageChange={(next) => apply({ page: String(next) })}
              />
            </>
          ) : null}
        </Card>
      )}
    </div>
  );
}
