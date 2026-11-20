import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, ButtonLink } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { FormField } from "../components/ui/FormField";
import { Icon } from "../components/ui/Icon";
import { Input } from "../components/ui/Input";
import { LoadingState } from "../components/ui/LoadingState";
import { PageHeading } from "../components/ui/PageHeading";
import { Pagination } from "../components/ui/Pagination";
import { StatusIndicator } from "../components/ui/StatusIndicator";
import {
  PAGE_SIZE,
  hasActiveFilters,
  isTransactionId,
  readHistoryParams,
  writeHistoryParams,
  type HistoryFilters,
} from "../features/transactions/filters";
import { HistoryFilterBar } from "../features/transactions/HistoryFilterBar";
import { TransactionList } from "../features/transactions/TransactionList";
import { useMediaQuery } from "../lib/useMediaQuery";
import { queryPreviewTransactions } from "../preview/previewData";
import { PreviewNotice } from "../preview/PreviewNotice";
import { usePreviewState } from "../preview/usePreviewState";
import { HistoryDesktop } from "./HistoryDesktop";

// Desktop starts at 1024px, the same point as Tailwind's `lg` and the sidebar.
const DESKTOP = "(min-width: 1024px)";

/** "Open by ID": the contract has no free-text search, but it can fetch one transaction by ID. */
export function OpenById() {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = value.trim();
    if (!isTransactionId(id)) {
      setError("Enter a full transaction ID, for example 1b12ba0b-f730-4cfe-9443-024e91ca3331.");
      return;
    }
    navigate(`/transactions/${id.toLowerCase()}`);
  }

  return (
    <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1">
        <FormField label="Open by transaction ID" error={error}>
          {({ invalid, ...control }) => (
            <Input
              {...control}
              invalid={invalid}
              value={value}
              spellCheck={false}
              autoComplete="off"
              placeholder="Full transaction ID"
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError(null);
              }}
            />
          )}
        </FormField>
      </div>
      <Button type="submit" variant="secondary" className="sm:mt-7" iconEnd={<Icon name="arrowRight" size={14} />}>
        Open
      </Button>
    </form>
  );
}

/**
 * Transaction history on PREVIEW DATA. Filters and page live in the URL under
 * the contract's query names, ready to pass to GET /api/v1/transactions.
 *
 * This is the history below 1024px. It is kept exactly as it was; only its
 * name changed, so the desktop version can be chosen above it.
 */
function NarrowHistory() {
  const [params, setParams] = useSearchParams();
  const { state, clear } = usePreviewState();
  const { filters, page } = readHistoryParams(params);
  const result = queryPreviewTransactions(filters, page, PAGE_SIZE);

  const update = (nextFilters: HistoryFilters, nextPage: number) => {
    const next = writeHistoryParams(nextFilters, nextPage);
    const previewState = params.get("state");
    if (previewState) next.set("state", previewState);
    setParams(next);
  };

  const isEmpty = state === "empty" || result.total === 0;

  return (
    <div className="space-y-8">
      <PageHeading
        eyebrow="Records"
        title="History"
        description="Every stored transaction, newest first. Open one to see its allocation and explanation."
        actions={<StatusIndicator tone="neutral" label="Not connected" />}
      />

      <PreviewNotice />

      <Card className="space-y-6">
        <OpenById />
        <div className="border-t border-line-subtle pt-6">
          <HistoryFilterBar filters={filters} onChange={(next) => update(next, 1)} />
        </div>
      </Card>

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
          hasActiveFilters(filters) && state !== "empty" ? (
            <EmptyState
              icon="history"
              title="No transactions match these filters"
              actions={
                <Button variant="secondary" onClick={() => update({}, 1)}>
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
        ) : (
          <>
            <TransactionList rows={result.items} caption="Transactions" />
            <Pagination
              page={result.page}
              pageSize={PAGE_SIZE}
              total={result.total}
              itemLabel="transactions"
              onPageChange={(next) => update(filters, next)}
            />
          </>
        )}
      </Card>
    </div>
  );
}

/**
 * History. From 1024px up it shows the desktop version; below that it renders
 * the existing history, unchanged.
 */
export function HistoryPage() {
  const isDesktop = useMediaQuery(DESKTOP);
  return isDesktop ? <HistoryDesktop /> : <NarrowHistory />;
}
