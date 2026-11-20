import { MandatoryLabel } from "../../components/labels/MandatoryLabel";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { DescriptionList } from "../../components/ui/DescriptionList";
import { LoadingState } from "../../components/ui/LoadingState";
import { Notice } from "../../components/ui/Notice";
import { Table, type TableColumn } from "../../components/ui/Table";
import { formatCorridor, formatDate, formatUsd } from "../../lib/format";
import { dataSourceName, formatFeeFraction } from "../network/types";
import type { StateErrorView } from "./stateApi";
import { modeName, valuesProvenanceName, type CorridorStateView, type VenueStateView } from "./types";

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });

/** The raw number the API gave, with no unit, scale or level added. */
const raw = (value: number) => number.format(value);

const columns: TableColumn<VenueStateView>[] = [
  {
    key: "venue",
    header: "Venue",
    cell: (v) => (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span className="whitespace-nowrap font-mono text-meta text-ink-secondary">{v.bridgeUid}</span>
        {v.dataSourceTag === "synthetic_bridge_expansion" ? <MandatoryLabel kind="syntheticVenue" /> : null}
      </span>
    ),
  },
  { key: "slot", header: "Slot", numeric: true, cell: (v) => v.slot },
  { key: "fee", header: "Fee", numeric: true, cell: (v) => formatFeeFraction(v.feePct) },
  { key: "liquidity", header: "Liquidity", numeric: true, cell: (v) => formatUsd(v.liquidityUsd) },
  { key: "congestion", header: "Congestion (raw)", numeric: true, cell: (v) => raw(v.congestion) },
  { key: "source", header: "Data source", cell: (v) => dataSourceName(v.dataSourceTag) },
  { key: "provenance", header: "Values", cell: (v) => valuesProvenanceName(v.valuesProvenance) },
];

/** What a corridor's card shows. Exactly one of these. */
export type CorridorCardState =
  /** The selections aren't complete or usable yet, so no request was made. */
  | { kind: "waiting"; reason: string }
  | { kind: "loading" }
  | { kind: "error"; failure: StateErrorView; onRetry: () => void }
  /** The server rejected the date or scenario: the control says so, and the card points to it. */
  | { kind: "control-error"; control: "date" | "scenario" }
  | { kind: "ready"; state: CorridorStateView };

/**
 * One corridor on one date: its venues' simulated liquidity and congestion, and
 * the corridor's risk, baseline cost and data split. It shows what the API
 * sent and nothing else: there is no availability, health or status, and none
 * is worked out. Loading, errors and retry belong to this card alone.
 */
export function CorridorStateCard({ corridor, view }: { corridor: string; view: CorridorCardState }) {
  const name = formatCorridor(corridor);
  return (
    <Card aria-label={`Bridge state ${name}`}>
      <CardHeader
        title={name}
        description={
          view.kind === "ready"
            ? `${formatDate(view.state.date)} · ${modeName(view.state.mode)}${view.state.scenarioId ? ` · ${view.state.scenarioId}` : ""}`
            : undefined
        }
        actions={<MandatoryLabel kind="simulated" />}
      />
      {view.kind === "waiting" ? (
        <p className="text-ui text-ink-muted">{view.reason}</p>
      ) : view.kind === "loading" ? (
        <LoadingState label={`Loading ${name}`} rows={4} />
      ) : view.kind === "control-error" ? (
        <p className="text-ui text-ink-muted">
          Not shown: the {view.control === "date" ? "date" : "scenario"} can&apos;t be used. See the message at the{" "}
          {view.control === "date" ? "date" : "scenario"} control.
        </p>
      ) : view.kind === "error" ? (
        <Notice tone="danger" role="alert" title={`Couldn't load ${name}`}>
          <p>{view.failure.message}</p>
          {view.failure.details.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {view.failure.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          ) : null}
          {view.failure.reference ? (
            <p className="mt-2 text-meta text-ink-muted">
              Reference: <code className="select-all text-ink-secondary">{view.failure.reference}</code>
            </p>
          ) : null}
          {view.failure.canRetry ? (
            <div className="mt-3">
              <Button variant="secondary" size="sm" onClick={view.onRetry}>
                Try again
              </Button>
            </div>
          ) : null}
        </Notice>
      ) : (
        <div className="space-y-6">
          <DescriptionList
            items={[
              { term: "Data split", detail: <Badge tone="tag">{view.state.split}</Badge> },
              { term: "Corridor risk", detail: raw(view.state.corridorRisk) },
              { term: "Baseline cost", detail: raw(view.state.baselineCostPct) },
            ]}
          />
          <p className="text-meta text-ink-muted">
            Corridor risk, baseline cost and congestion are shown as the API gives them: the contract doesn&apos;t
            define a unit or scale for them.
          </p>
          {view.state.venues.length === 0 ? (
            <p className="text-ui text-ink-muted">The API lists no venues for this corridor on this date.</p>
          ) : (
            <Table caption={`Venues of ${name}`} columns={columns} rows={view.state.venues} getRowKey={(v) => v.bridgeUid} />
          )}
          {view.state.warnings.length > 0 ? (
            <section aria-label={`Warnings for ${name}`} className="space-y-3">
              <h3 className="eyebrow">Warnings</h3>
              <ul className="space-y-3">
                {view.state.warnings.map((w) => (
                  <li key={`${w.code}:${w.message}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-ui">
                    <code className="rounded-pill border border-line px-2.5 py-1 text-meta text-ink-secondary">{w.code}</code>
                    <span className="text-ink-body">{w.message}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </Card>
  );
}
