import { useState, type ReactNode } from "react";
import { useApiQuery } from "../../../api/useApiQuery";
import { useAuth } from "../../../auth/AuthContext";
import { Badge } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { Card, CardHeader } from "../../../components/ui/Card";
import { DescriptionList } from "../../../components/ui/DescriptionList";
import { LoadingState } from "../../../components/ui/LoadingState";
import { Notice } from "../../../components/ui/Notice";
import { Table, type TableColumn } from "../../../components/ui/Table";
import type { DecisionView } from "../detailTypes";
import { describeDetailError, fetchExplanation } from "../detailApi";
import type { ExplanationFactView, ExplanationView, VenueExplanationView } from "../explanationTypes";

const venueColumns: TableColumn<VenueExplanationView>[] = [
  { key: "venue", header: "Venue", cell: (v) => <span className="font-mono text-meta text-ink-secondary">{v.bridgeUid}</span> },
  {
    key: "outcome",
    header: "Outcome",
    // The words carry the meaning; an unknown outcome is shown as written.
    cell: (v) => <Badge tone={v.outcome === "used" ? "success" : "tag"}>{v.outcome === "used" ? "Used" : v.outcome === "unused" ? "Not used" : v.outcome}</Badge>,
  },
  { key: "reason", header: "Reason", cell: (v) => <code className="text-meta text-ink-secondary">{v.reasonCode}</code> },
  { key: "text", header: "Explanation", cell: (v) => <span className="text-ink-body">{v.text}</span> },
];

const factColumns: TableColumn<ExplanationFactView>[] = [
  { key: "fact", header: "Fact", cell: (f) => <span className="font-mono text-meta text-ink-secondary">{f.factId}</span> },
  { key: "rule", header: "Rule", cell: (f) => <span className="text-ink-body">{f.ruleType}</span> },
  { key: "value", header: "Value", cell: (f) => <span className="break-all text-ink-body">{f.valueText}</span> },
  {
    key: "provenance",
    header: "Provenance",
    cell: (f) => (
      <span className="inline-flex flex-wrap items-center gap-2">
        <code className="text-meta text-ink-secondary">{f.provenanceTag}</code>
        <Badge tone={f.verified ? "success" : "warning"}>{f.verified ? "Verified" : "Not verified"}</Badge>
      </span>
    ),
  },
  { key: "source", header: "Source", cell: (f) => <span className="text-ink-muted">{f.source}</span> },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="eyebrow">{title}</h3>
      {children}
    </section>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5 text-ui text-ink-body">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

/** The explanation itself: what the engine said about this decision. */
function ExplanationBody({ explanation }: { explanation: ExplanationView }) {
  const { feasibility } = explanation;
  return (
    <div className="space-y-8">
      <p className="max-w-3xl text-ui text-ink-body">{explanation.summary}</p>

      <DescriptionList
        items={[
          {
            term: "Feasibility",
            detail: (
              <span className="inline-flex flex-wrap items-center gap-3">
                <Badge tone={feasibility.allowed ? "success" : "tag"}>{feasibility.allowed ? "Allowed" : "Not allowed"}</Badge>
                {feasibility.reason ? <span>{feasibility.reason}</span> : null}
              </span>
            ),
          },
          { term: "Checked by", detail: <span className="font-mono text-meta">{feasibility.provider}</span> },
        ]}
      />

      <Section title="Venues">
        <Table caption="Explanation by venue" columns={venueColumns} rows={explanation.venues} getRowKey={(v) => v.bridgeUid} />
      </Section>

      {explanation.policyNotes.length > 0 ? (
        <Section title="Policy notes">
          <BulletList items={explanation.policyNotes} />
        </Section>
      ) : null}

      <Section title="Facts applied">
        {feasibility.facts.length === 0 ? (
          <p className="text-ui text-ink-muted">No regulatory facts were applied.</p>
        ) : (
          <Table caption="Facts applied" columns={factColumns} rows={feasibility.facts} getRowKey={(f) => f.factId} />
        )}
      </Section>

      <Section title="Limitations">
        <BulletList items={explanation.limitations} />
      </Section>
    </div>
  );
}

type ExplanationCardProps = {
  transactionId: string;
  /** Null for a failed transaction: there is nothing to explain. */
  decision: DecisionView | null;
};

/**
 * The Explanation card (contract §3.5), under the allocations. The explanation
 * is requested only when the user clicks Explain: the backend recomputes it
 * with the engine on first use and stores it. Its loading and errors belong to
 * this card alone, so the transaction above stays as it is. The explanation is
 * shown only if it is for this transaction and this decision (fetchExplanation).
 * Render it with `key={transactionId}` so a different transaction starts unrequested.
 */
export function ExplanationCard({ transactionId, decision }: ExplanationCardProps) {
  const { api } = useAuth();
  const [requested, setRequested] = useState(false);
  const decisionId = decision?.decisionId ?? "";
  const query = useApiQuery(
    `explanation:${transactionId}:${decisionId}`,
    () => fetchExplanation(api, transactionId, decisionId),
    requested && decision !== null,
  );

  const failure = query.status === "error" ? describeDetailError(query.error, "explanation") : null;

  return (
    <Card aria-label="Explanation">
      <CardHeader
        title="Explanation"
        description="Why the policy allocated the amount this way, as recomputed by the routing engine."
      />
      {decision === null ? (
        <p className="text-ui text-ink-muted">This transaction has no decision, so there is nothing to explain.</p>
      ) : query.status === "success" ? (
        <ExplanationBody explanation={query.data} />
      ) : query.status === "loading" ? (
        <LoadingState label="Loading the explanation" rows={5} />
      ) : failure ? (
        <Notice tone="danger" role="alert" title="Couldn't load the explanation">
          <p>{failure.message}</p>
          {failure.details.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {failure.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          ) : null}
          {failure.reference ? (
            <p className="mt-2 text-meta text-ink-muted">
              Reference: <code className="select-all text-ink-secondary">{failure.reference}</code>
            </p>
          ) : null}
          {failure.canRetry ? (
            <div className="mt-3">
              <Button variant="secondary" size="sm" onClick={query.retry}>
                Try again
              </Button>
            </div>
          ) : null}
        </Notice>
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          <Button variant="secondary" onClick={() => setRequested(true)}>
            Explain
          </Button>
          <p className="text-ui text-ink-muted">Asks the routing engine to recompute this decision. The result is saved.</p>
        </div>
      )}
    </Card>
  );
}
