import { Badge } from "../../../components/ui/Badge";
import { Card, CardHeader } from "../../../components/ui/Card";
import { DescriptionList } from "../../../components/ui/DescriptionList";
import { formatCount, formatPercent } from "../../../lib/format";
import { REGIME_NAMES, type DecisionView } from "../detailTypes";
import { Dash, orDash } from "./dash";

/** Feasibility and decision facts. Every row is "—" when there is no decision. */
export function DecisionPanel({ decision }: { decision: DecisionView | null }) {
  const feasibility = decision?.feasibility;
  return (
    <Card aria-label="Decision">
      <CardHeader title="Decision" />
      <DescriptionList
        items={[
          {
            term: "Feasibility",
            detail: feasibility ? (
              <Badge tone={feasibility.allowed ? "success" : "tag"}>{feasibility.allowed ? "Allowed" : "Not allowed"}</Badge>
            ) : (
              <Dash />
            ),
          },
          { term: "Reason", detail: orDash(feasibility?.reason) },
          {
            term: "Decisive facts",
            detail: feasibility?.decisiveFactIds.length ? (
              <span className="font-mono text-meta">{feasibility.decisiveFactIds.join(", ")}</span>
            ) : (
              <Dash />
            ),
          },
          { term: "Knowledge version", detail: orDash(feasibility?.knowledgeVersion) },
          { term: "Regime", detail: decision ? orDash(REGIME_NAMES[decision.regime] ?? decision.regime) : <Dash /> },
          { term: "Completion", detail: decision ? formatPercent(decision.totals.completionRatio) : <Dash /> },
          { term: "Bridges used", detail: decision ? formatCount(decision.totals.bridgesUsed) : <Dash /> },
          {
            term: "Decision ID",
            // A decision always has an ID. The dash is for "no decision" (a failed transaction has
            // none, and none is made up), and is also a defensive fallback if one ever arrived without.
            detail: decision?.decisionId ? <span className="break-all font-mono text-meta">{decision.decisionId}</span> : <Dash />,
          },
        ]}
      />
    </Card>
  );
}

/** Warnings from the decision. "—" when there is no decision; a plain line when there are none. */
export function WarningsPanel({ decision }: { decision: DecisionView | null }) {
  return (
    <Card aria-label="Warnings">
      <CardHeader title="Warnings" />
      {!decision ? (
        <Dash />
      ) : decision.warnings.length === 0 ? (
        <p className="text-ui text-ink-muted">No warnings.</p>
      ) : (
        <ul className="space-y-3">
          {decision.warnings.map((w) => (
            <li key={`${w.code}:${w.message}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-ui">
              <code className="rounded-pill border border-line px-2.5 py-1 text-meta text-ink-secondary">{w.code}</code>
              <span className="text-ink-body">{w.message}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
