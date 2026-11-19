import { MandatoryLabel } from "../components/labels/MandatoryLabel";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Notice } from "../components/ui/Notice";
import { PageHeading } from "../components/ui/PageHeading";
import { StatusIndicator } from "../components/ui/StatusIndicator";
import { NO_LIQUIDITY_CARRY_OVER } from "../lib/labels";
import type { ScreenSpec } from "./screens";

/**
 * Placeholder for a screen whose data isn't connected yet. It shows the
 * screen's purpose and the endpoints it will use; it shows no sample data.
 */
export function PendingScreen({ spec }: { spec: ScreenSpec }) {
  return (
    <div className="space-y-8">
      <PageHeading
        eyebrow={spec.eyebrow}
        title={spec.title}
        description={spec.description}
        actions={<StatusIndicator tone="neutral" label="Not connected" />}
        meta={spec.labels?.map((kind) => <MandatoryLabel key={kind} kind={kind} />)}
      />

      {spec.showCarryOverNote ? <Notice>{NO_LIQUIDITY_CARRY_OVER}</Notice> : null}

      <Card padded={false}>
        <EmptyState icon="info" title="This screen isn't connected yet">
          <p>
            It will read from the Application API once the shared contracts (
            <code className="text-ink-body">contracts/openapi/app.v1.yaml</code>) are merged. No data is shown until
            then.
          </p>
          <ul className="mt-5 flex flex-wrap justify-center gap-2" aria-label="Endpoints">
            {spec.endpoints.map((endpoint) => (
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
