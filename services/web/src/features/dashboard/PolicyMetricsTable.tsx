import type { ReactNode } from "react";
import { Table, type TableColumn } from "../../components/ui/Table";
import { formatCount, formatPercent } from "../../lib/format";
import { PolicyCell } from "../transactions/PolicyCell";
import type { PolicyKey, PolicyTier } from "../transactions/types";
import type { CorridorSummary, PolicySummary } from "./summaryTypes";

const TIER: Record<PolicyKey, PolicyTier> = { waterfall: "default", cheapestFeasible: "baseline", ppoProjected: "experimental" };

const feeCost = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plainMean = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

/**
 * `meanFeeCostPct` for display, or null when there is none. The API value is
 * already a percentage number (1.56 means 1.56%), so it is formatted as it
 * is and never multiplied by 100. Null stays null; it is not zero.
 */
export function formatMeanFeeCostPct(value: number | null): string | null {
  return typeof value === "number" && Number.isFinite(value) ? `${feeCost.format(value)}%` : null;
}

/**
 * A mean reward, latency term or risk term, as a plain number, or null. Their
 * units aren't defined here, so no unit or sign convention is added. Null
 * stays null; zero is shown as 0.
 */
export function formatMean(value: number | null): string | null {
  return typeof value === "number" && Number.isFinite(value) ? plainMean.format(value) : null;
}

/** "—" for a value that isn't available, with a text alternative for screen readers. */
function Unavailable() {
  return (
    <span className="text-ink-muted">
      <span aria-hidden="true">—</span>
      <span className="sr-only">Not available</span>
    </span>
  );
}

const orUnavailable = (text: string | null): ReactNode => (text === null ? <Unavailable /> : text);
const rate = (value: number | null): ReactNode => orUnavailable(value === null ? null : formatPercent(value));

const policyColumns: TableColumn<PolicySummary>[] = [
  {
    key: "policy",
    header: "Policy",
    cell: (p) => <PolicyCell policy={p.policy} tier={TIER[p.policy] ?? null} />,
  },
  { key: "count", header: "Requests", numeric: true, cell: (p) => formatCount(p.count) },
  { key: "allowed", header: "Allowed routed", numeric: true, cell: (p) => formatCount(p.allowedRouted) },
  { key: "completion", header: "Completion rate", numeric: true, cell: (p) => rate(p.completionRate) },
  { key: "fee", header: "Mean fee cost", numeric: true, cell: (p) => orUnavailable(formatMeanFeeCostPct(p.meanFeeCostPct)) },
  { key: "reward", header: "Mean reward", numeric: true, cell: (p) => orUnavailable(formatMean(p.meanRewardAmountBased)) },
  { key: "latency", header: "Mean latency", numeric: true, cell: (p) => orUnavailable(formatMean(p.meanLatencyTerm)) },
  { key: "risk", header: "Mean risk", numeric: true, cell: (p) => orUnavailable(formatMean(p.meanRiskTerm)) },
];

/**
 * One row per policy, in the order the API gives them: never sorted or
 * highlighted by a metric, because the reward, latency and risk terms are under
 * placeholder weights and are not a ranking.
 */
export function PolicyMetricsTable({ rows }: { rows: PolicySummary[] }) {
  return (
    <Table
      caption="Metrics by policy"
      columns={policyColumns}
      rows={rows}
      getRowKey={(p) => p.policy}
      empty={<p className="text-ui text-ink-muted">No policy requests in this window.</p>}
    />
  );
}

const corridorColumns: TableColumn<CorridorSummary>[] = [
  { key: "corridor", header: "Corridor", cell: (c) => c.corridor.replace("->", " → ") },
  { key: "routed", header: "Routed", numeric: true, cell: (c) => formatCount(c.routed) },
  { key: "allowed", header: "Allowed routed", numeric: true, cell: (c) => formatCount(c.allowedRouted) },
  { key: "completion", header: "Completion rate", numeric: true, cell: (c) => rate(c.completionRate) },
];

/** Corridor counts with their completion denominator. Failed transactions have no corridor and are not here. */
export function CorridorMetricsTable({ rows }: { rows: CorridorSummary[] }) {
  return (
    <Table
      caption="Metrics by corridor"
      columns={corridorColumns}
      rows={rows}
      getRowKey={(c) => c.corridor}
      empty={<p className="text-ui text-ink-muted">No routed transactions in this window.</p>}
    />
  );
}
