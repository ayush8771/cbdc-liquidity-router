import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { LoadingState } from "../../components/ui/LoadingState";
import { Notice } from "../../components/ui/Notice";
import { describeReferenceError, type ReferenceSource } from "./referenceApi";

/** One of the three requests the form's options come from. */
export type ReferenceQuery = {
  source: ReferenceSource;
  status: "idle" | "loading" | "success" | "error";
  error: unknown;
  /** Asks again for this source only. */
  retry: () => void;
};

const NOUN: Record<ReferenceSource, string> = {
  network: "corridors",
  scenarios: "scenarios",
  policies: "policies",
  calendar: "calendar",
};

/**
 * Shown in place of the form while its options (corridors, scenarios, policies)
 * are loading or failed. Each source has its own state: one that failed shows
 * its error and a Try again that asks for that source alone, and one that
 * loaded is not shown. The form appears once all three have loaded.
 */
export function ReferenceStatus({ queries }: { queries: ReferenceQuery[] }) {
  const pending = queries.filter((q) => q.status !== "success");
  return (
    <Card aria-label="Form options">
      <CardHeader title="Loading the form" description="The form's options come from the API: corridors, scenarios and policies." />
      <div className="space-y-4">
        {pending.map((q) => {
          if (q.status === "error") {
            const failure = describeReferenceError(q.error, q.source);
            return (
              <Notice key={q.source} tone="danger" role="alert" title={`Couldn't load the ${NOUN[q.source]}`}>
                <p>{failure.message}</p>
                {failure.reference ? (
                  <p className="mt-2 text-meta text-ink-muted">
                    Reference: <code className="select-all text-ink-secondary">{failure.reference}</code>
                  </p>
                ) : null}
                {failure.canRetry ? (
                  <div className="mt-3">
                    <Button variant="secondary" size="sm" onClick={q.retry}>
                      Try again
                    </Button>
                  </div>
                ) : null}
              </Notice>
            );
          }
          return <LoadingState key={q.source} label={`Loading the ${NOUN[q.source]}`} rows={2} />;
        })}
      </div>
    </Card>
  );
}
