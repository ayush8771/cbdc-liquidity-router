import { Card } from "../../components/ui/Card";
import { Skeleton } from "../../components/ui/LoadingState";
import { Stat } from "../../components/ui/Stat";
import { formatCount } from "../../lib/format";
import type { DashboardView } from "./types";

// One tile per field of the contract's dashboard totals (§3.8), with its definition.
const TILES: { key: keyof DashboardView["totals"]; label: string; description: string }[] = [
  { key: "transactions", label: "Transactions", description: "All stored transactions." },
  { key: "routed", label: "Routed", description: "A routing decision was returned, including rejections." },
  { key: "failed", label: "Failed", description: "The routing call failed after validation." },
  { key: "rejectedByFeasibility", label: "Rejected by feasibility", description: "Routed, but not allowed by the rules." },
];

export function KpiGrid({ totals }: { totals: DashboardView["totals"] | null }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {TILES.map((tile) => (
        <Card key={tile.key} as="div">
          {totals ? (
            <Stat
              value={formatCount(totals[tile.key])}
              label={tile.label}
              meta={<p className="text-meta text-ink-muted">{tile.description}</p>}
            />
          ) : (
            <div className="space-y-3" aria-hidden="true">
              <Skeleton className="h-10 w-16" />
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-40" />
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
