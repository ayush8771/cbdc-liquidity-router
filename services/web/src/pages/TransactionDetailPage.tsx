import { useParams } from "react-router-dom";
import { useDataMode } from "../api/dataMode";
import { useApiQuery } from "../api/useApiQuery";
import { useAuth } from "../auth/AuthContext";
import { MandatoryLabel } from "../components/labels/MandatoryLabel";
import { Button, ButtonLink } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { Icon } from "../components/ui/Icon";
import { LoadingState } from "../components/ui/LoadingState";
import { PageHeading } from "../components/ui/PageHeading";
import { StatusIndicator } from "../components/ui/StatusIndicator";
import { AllocationTable } from "../features/transactions/detail/AllocationTable";
import { DecisionPanel, WarningsPanel } from "../features/transactions/detail/DecisionPanel";
import { DetailOverview } from "../features/transactions/detail/DetailOverview";
import { ExplanationCard } from "../features/transactions/detail/ExplanationCard";
import { describeDetailError, fetchTransactionDetail, isNotFound } from "../features/transactions/detailApi";
import { isTransactionId } from "../features/transactions/filters";
import { useMediaQuery } from "../lib/useMediaQuery";
import { getPreviewTransactionDetail } from "../preview/previewDetail";
import { PreviewNotice } from "../preview/PreviewNotice";
import { usePreviewState } from "../preview/usePreviewState";

// Desktop starts at 1024px, the same point as Tailwind's `lg`, the sidebar and the bridge monitor.
const DESKTOP = "(min-width: 1024px)";

const ENDPOINTS = ["GET /api/v1/transactions/{id}", "GET /api/v1/transactions/{id}/explanation"];

function BackToHistory() {
  return (
    <ButtonLink to="/transactions" variant="tertiary" size="sm" className="-ml-1.5">
      <Icon name="arrowRight" size={14} className="rotate-180" />
      Back to history
    </ButtonLink>
  );
}

/** Route inspector placeholder: the path from History exists; the data does not yet. Shown below 1024px, unchanged. */
function PendingTransactionDetail() {
  const { id = "" } = useParams();
  const valid = isTransactionId(id);

  return (
    <div className="space-y-8">
      <ButtonLink to="/transactions" variant="tertiary" size="sm" className="-ml-1.5">
        <Icon name="arrowRight" size={14} className="rotate-180" />
        Back to history
      </ButtonLink>

      <PageHeading
        eyebrow="Transaction"
        title="Transaction details"
        description={
          valid ? (
            <span className="break-all font-mono text-ui text-ink-secondary">{id}</span>
          ) : (
            "This address doesn't contain a valid transaction ID."
          )
        }
        actions={<StatusIndicator tone="neutral" label="Not connected" />}
      />

      <Card padded={false}>
        <EmptyState icon="info" title="This screen isn't connected yet">
          <p>
            The allocation, metrics, provenance and explanation will appear here once the shared API contracts are
            merged. No data is shown until then.
          </p>
          <ul className="mt-5 flex flex-wrap justify-center gap-2" aria-label="Endpoints">
            {ENDPOINTS.map((endpoint) => (
              <li key={endpoint}>
                <code className="inline-block rounded-pill border border-line bg-surface-panel px-2.5 py-1 text-meta text-ink-secondary">
                  {endpoint}
                </code>
              </li>
            ))}
          </ul>
        </EmptyState>
      </Card>
    </div>
  );
}

/**
 * Transaction detail, from 1024px up. The heading and the ID are the same in
 * every state, including an ID the data doesn't know.
 *
 * Data mode (src/api/dataMode.ts): live by default, from
 * GET /api/v1/transactions/:id through the signed-in session's client, with an
 * Explanation card that asks for GET .../explanation only when the user clicks
 * Explain. In preview mode (VITE_API_MODE=preview) it shows the preview data,
 * never calls the API and has no Explanation card; only then do the review
 * states ?state=loading and ?state=error apply.
 */
function DesktopTransactionDetail() {
  const { id = "" } = useParams();
  const live = useDataMode() === "live";
  const { api } = useAuth();
  const valid = isTransactionId(id);
  const { state: previewState, clear } = usePreviewState();
  const state = live ? "ready" : previewState;
  const normalizedId = id.trim().toLowerCase();

  const query = useApiQuery(`detail:${normalizedId}`, () => fetchTransactionDetail(api, normalizedId), live && valid);
  const liveDetail = query.status === "success" ? query.data : undefined;
  const detail = live ? liveDetail : valid ? getPreviewTransactionDetail(normalizedId) : undefined;

  const liveLoading = live && valid && query.status === "loading";
  const notFound = live && query.status === "error" && isNotFound(query.error);
  const liveFailed = live && query.status === "error" && !notFound ? query : null;
  const failure = liveFailed ? describeDetailError(liveFailed.error, "transaction") : null;

  return (
    <div className="space-y-8">
      <BackToHistory />

      <PageHeading
        eyebrow="Transaction"
        title="Transaction details"
        description={
          valid ? (
            <span className="break-all font-mono text-ui text-ink-secondary">{id}</span>
          ) : (
            "This address doesn't contain a valid transaction ID."
          )
        }
        actions={<StatusIndicator tone="neutral" label={live ? "Live data" : "Not connected"} />}
        meta={detail ? <MandatoryLabel kind="simulated" /> : undefined}
      />

      {valid && !live ? <PreviewNotice /> : null}

      {!valid ? (
        <Card padded={false}>
          <EmptyState icon="info" title="No transaction to show">
            Check the address, or open a transaction from History.
          </EmptyState>
        </Card>
      ) : state === "loading" || liveLoading ? (
        <Card>
          <LoadingState label="Loading the transaction" rows={8} />
        </Card>
      ) : liveFailed && failure ? (
        <Card padded={false}>
          <ErrorState
            title="Couldn't load this transaction"
            message={
              <>
                <p>{failure.message}</p>
                {failure.details.length > 0 ? (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-left">
                    {failure.details.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                ) : null}
              </>
            }
            reference={failure.reference}
            action={
              failure.canRetry ? (
                <Button variant="secondary" onClick={liveFailed.retry}>
                  Try again
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : state === "error" ? (
        <Card padded={false}>
          <ErrorState
            title="Couldn't load this transaction"
            message="This is the preview of an error. With the live API, the server's message appears here."
            reference="preview"
            action={
              <Button variant="secondary" onClick={clear}>
                Try again
              </Button>
            }
          />
        </Card>
      ) : !detail ? (
        <Card padded={false}>
          <EmptyState
            icon="history"
            title="Transaction not found"
            actions={
              <ButtonLink to="/transactions" variant="secondary">
                Back to history
              </ButtonLink>
            }
          >
            No transaction with this ID exists.
          </EmptyState>
        </Card>
      ) : (
        <>
          <DetailOverview detail={detail} />
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <DecisionPanel decision={detail.decision} />
            <WarningsPanel decision={detail.decision} />
          </div>
          <AllocationTable decision={detail.decision} />
          {live ? <ExplanationCard key={detail.id} transactionId={detail.id} decision={detail.decision} /> : null}
        </>
      )}
    </div>
  );
}

/**
 * Transaction detail. From 1024px up it shows the detail page (live API data,
 * or preview data in preview mode); below that it renders the existing
 * placeholder, unchanged.
 */
export function TransactionDetailPage() {
  const isDesktop = useMediaQuery(DESKTOP);
  return isDesktop ? <DesktopTransactionDetail /> : <PendingTransactionDetail />;
}
