import { MandatoryLabel } from "../../components/labels/MandatoryLabel";
import { Card, CardHeader } from "../../components/ui/Card";
import { Table, type TableColumn } from "../../components/ui/Table";
import { formatCorridor, formatUsd } from "../../lib/format";
import { dataSourceName, formatFeeFraction, type CorridorView, type VenueView } from "./types";

const columns: TableColumn<VenueView>[] = [
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
  { key: "capacity", header: "Baseline capacity", numeric: true, cell: (v) => formatUsd(v.baselineCapacityUsd) },
  { key: "source", header: "Data source", cell: (v) => dataSourceName(v.dataSourceTag) },
];

/** One corridor and its bridge venues. Shows reference data only: no liquidity, congestion or status. */
export function CorridorCard({ corridor }: { corridor: CorridorView }) {
  const name = formatCorridor(corridor.corridor);
  return (
    <Card aria-label={`Corridor ${name}`}>
      <CardHeader
        title={name}
        description={`${corridor.senderCountry} to ${corridor.receiverCountry} · ${corridor.venues.length} ${
          corridor.venues.length === 1 ? "venue" : "venues"
        }`}
      />
      <Table
        caption={`Bridge venues of ${name}`}
        columns={columns}
        rows={corridor.venues}
        getRowKey={(v) => v.bridgeUid}
        empty={<p className="text-ui text-ink-muted">This corridor has no venues.</p>}
      />
    </Card>
  );
}
