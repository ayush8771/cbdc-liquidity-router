import { Link } from "react-router-dom";
import { useDataMode } from "../api/dataMode";
import { useApiQuery } from "../api/useApiQuery";
import { useAuth } from "../auth/AuthContext";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { ErrorState } from "../components/ui/ErrorState";
import { LoadingState } from "../components/ui/LoadingState";
import { Notice } from "../components/ui/Notice";
import { PageHeading } from "../components/ui/PageHeading";
import { Stat } from "../components/ui/Stat";
import { StatusIndicator } from "../components/ui/StatusIndicator";
import { CorridorCard } from "../features/network/CorridorCard";
import { describeNetworkError, fetchNetwork } from "../features/network/networkApi";
import { provenanceName } from "../features/network/types";
import { formatUsd } from "../lib/format";
import { useMediaQuery } from "../lib/useMediaQuery";
import { PREVIEW_NETWORK } from "../preview/previewNetwork";
import { PreviewNotice } from "../preview/PreviewNotice";
import { usePreviewState } from "../preview/usePreviewState";
import { PendingScreen } from "./PendingScreen";
import { SCREENS, type ScreenSpec } from "./screens";

// Desktop starts at 1024px, the same point as Tailwind's `lg`, the sidebar and the other desktop screens.
const DESKTOP = "(min-width: 1024px)";

/**
 * The supported network, from 1024px up. It shows reference data only:
 * corridors, venues, fees and baseline capacity. Live liquidity and congestion
 * are not on this endpoint; they are on the Bridge monitor's.
 *
 * Data mode (src/api/dataMode.ts): live by default, from GET /api/v1/network
 * through the signed-in session's client. In preview mode
 * (VITE_API_MODE=preview) it shows the preview data instead and never calls
 * the API; only then do the review states ?state=loading, ?state=empty and
 * ?state=error apply.
 */
function DesktopNetwork({ spec }: { spec: ScreenSpec }) {
  const live = useDataMode() === "live";
  const { api } = useAuth();
  const { state: previewState, clear } = usePreviewState();
  const state = live ? "ready" : previewState;

  const query = useApiQuery("network", () => fetchNetwork(api), live);
  const network = live ? (query.status === "success" ? query.data : null) : PREVIEW_NETWORK;
  const liveLoading = live && query.status === "loading";
  const failure = live && query.status === "error" ? describeNetworkError(query.error) : null;
  const isEmpty = state === "empty" || (network !== null && network.corridors.length === 0);

  return (
    <div className="space-y-8">
      <PageHeading
        eyebrow={spec.eyebrow}
        title={spec.title}
        description={spec.description}
        actions={<StatusIndicator tone="neutral" label={live ? "Live data" : "Not connected"} />}
      />

      {live ? null : <PreviewNotice />}

      <Notice title="Baseline capacity is reference data">
        Baseline capacity is static reference metadata. It is not live liquidity or current availability. Execution uses
        the dynamic liquidity of the state on the day, which the{" "}
        <Link to="/bridges" className="rounded-pill text-ink-body underline underline-offset-2 hover:text-paper-white">
          Bridge monitor
        </Link>{" "}
        shows, together with congestion.
      </Notice>

      {state === "loading" || liveLoading ? (
        <Card>
          <LoadingState label="Loading the network" rows={8} />
        </Card>
      ) : failure && query.status === "error" ? (
        <Card padded={false}>
          <ErrorState
            title="Couldn't load the network"
            message={failure.message}
            reference={failure.reference}
            action={
              failure.canRetry ? (
                <Button variant="secondary" onClick={query.retry}>
                  Try again
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : state === "error" ? (
        <Card padded={false}>
          <ErrorState
            title="Couldn't load the network"
            message="This is the preview of an error. With the live API, the server's message appears here."
            reference="preview"
            action={
              <Button variant="secondary" onClick={clear}>
                Try again
              </Button>
            }
          />
        </Card>
      ) : isEmpty ? (
        <Card padded={false}>
          <EmptyState icon="network" title="No corridors">
            The network lists no supported corridors.
          </EmptyState>
        </Card>
      ) : network ? (
        <>
          <Card aria-label="Single-transfer limit">
            <Stat
              size="sm"
              label="Single-transfer limit"
              value={formatUsd(network.maxSingleTransferUsd)}
              meta={
                <p className="text-meta text-ink-muted">
                  Provenance: {provenanceName(network.maxSingleTransferProvenance)}. A project constraint, not a real
                  regulation. A larger amount is rejected by the feasibility rules.
                </p>
              }
            />
          </Card>

          <div className="space-y-6">
            {network.corridors.map((corridor) => (
              <CorridorCard key={corridor.corridor} corridor={corridor} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * Network. From 1024px up it shows the network page (live API data, or
 * preview data in preview mode); below that it renders the existing
 * placeholder screen, unchanged.
 */
export function NetworkPage() {
  const isDesktop = useMediaQuery(DESKTOP);
  const spec = SCREENS.find((s) => s.path === "/network");
  if (!spec) throw new Error("The /network screen spec is missing from SCREENS.");

  return isDesktop ? <DesktopNetwork spec={spec} /> : <PendingScreen spec={spec} />;
}
