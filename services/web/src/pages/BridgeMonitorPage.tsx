import { useState } from "react";
import { MandatoryLabel } from "../components/labels/MandatoryLabel";
import { Badge } from "../components/ui/Badge";
import { Card } from "../components/ui/Card";
import { Notice } from "../components/ui/Notice";
import { PageHeading } from "../components/ui/PageHeading";
import { StatusIndicator } from "../components/ui/StatusIndicator";
import { Globe } from "../features/globe/Globe";
import { GlobeControls } from "../features/globe/GlobeControls";
import { ILLUSTRATIVE_CORRIDORS, ILLUSTRATIVE_LOCATIONS } from "../features/globe/illustrativeData";
import { formatCorridor } from "../lib/format";
import { useMediaQuery } from "../lib/useMediaQuery";
import { PendingScreen } from "./PendingScreen";
import { SCREENS, type ScreenSpec } from "./screens";

// Desktop starts at 1024px, the same point as Tailwind's `lg` and the sidebar.
const DESKTOP = "(min-width: 1024px)";
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

const GLOBE_LABEL =
  "A rotating globe with markers for the United States, India, the United Kingdom, the Philippines, the United Arab Emirates and Mexico, and arcs for the three corridors: United States to India, United Kingdom to Philippines, and United Arab Emirates to Mexico. Illustrative only.";

function DesktopBridgeMonitor({ spec }: { spec: ScreenSpec }) {
  const reducedMotion = useMediaQuery(REDUCED_MOTION);
  // People who ask for reduced motion get a still globe and choose to start it.
  const [paused, setPaused] = useState(reducedMotion);

  return (
    <div className="space-y-8">
      <PageHeading
        eyebrow={spec.eyebrow}
        title={spec.title}
        description={spec.description}
        actions={<StatusIndicator tone="neutral" label="Not connected" />}
        meta={spec.labels?.map((kind) => <MandatoryLabel key={kind} kind={kind} />)}
      />

      <Card as="section" aria-labelledby="globe-heading" padded={false}>
        <h2 id="globe-heading" className="sr-only">
          Illustrative corridor globe
        </h2>
        <div className="flex flex-col items-center gap-6 px-8 pb-8 pt-6">
          <Globe
            className="h-[min(60vh,620px)] w-full max-w-[720px]"
            locations={ILLUSTRATIVE_LOCATIONS}
            connections={ILLUSTRATIVE_CORRIDORS}
            paused={paused}
            reducedMotion={reducedMotion}
            label={GLOBE_LABEL}
          />

          <div className="flex flex-col items-center gap-4 text-center">
            <GlobeControls paused={paused} onToggle={() => setPaused((p) => !p)} />
            <div className="space-y-1">
              <p className="text-ui font-medium text-ink-body">Illustrative — not live bridge availability.</p>
              <p className="max-w-xl text-ui text-ink-muted">
                Arcs mark the three supported corridors, and locations are approximate. They show no liquidity,
                availability or status.
              </p>
            </div>
            <ul aria-label="Corridors shown" className="flex flex-wrap justify-center gap-2">
              {ILLUSTRATIVE_CORRIDORS.map((c) => (
                <li key={c.id}>
                  <Badge tone="tag">{formatCorridor(c.corridor)}</Badge>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Card>

      <Notice title="The monitor's data isn't connected yet">
        Liquidity and congestion for each venue will appear here once the shared API contracts are merged. It will read
        from <code className="text-ink-body">GET /api/v1/state</code>. Until then, no such data is shown.
      </Notice>
    </div>
  );
}

/**
 * Bridge monitor. From 1024px up it shows the illustrative globe; below that it
 * renders the existing placeholder screen, unchanged, and never loads or starts
 * any 3D code.
 */
export function BridgeMonitorPage() {
  const isDesktop = useMediaQuery(DESKTOP);
  const spec = SCREENS.find((s) => s.path === "/bridges");
  if (!spec) throw new Error("The /bridges screen spec is missing from SCREENS.");

  return isDesktop ? <DesktopBridgeMonitor spec={spec} /> : <PendingScreen spec={spec} />;
}
