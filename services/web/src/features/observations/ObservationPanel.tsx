import { useEffect, useReducer } from "react";
import { useDataMode } from "../../api/dataMode";
import { useObservationSession } from "../../auth/observationSession";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Notice } from "../../components/ui/Notice";
import { StatusIndicator, type StatusTone } from "../../components/ui/StatusIndicator";
import { Table, type TableColumn } from "../../components/ui/Table";
import { useObservationsFlag } from "./flags";
import { currentAgeMs, msUntilNextChange, valueFreshness } from "./freshness";
import { useObservationStream } from "./useObservationStream";
import type { ObservationState, ObservationValue, Profile, StopReason } from "./types";

/** Visible text. "Simulated" is always shown as SIMULATED; nothing here says live, real or market (AD-4 §8, AD-6 T-8). */
export const OBSERVATION_COPY = {
  title: "Simulated FX observations",
  description: "Synthetic FX rates from a local generator. The values are deliberately unrealistic.",
  context: "Observations are shown for context. They do not affect routing.",
  simulated: "SIMULATED",
  unavailable: "Unavailable",
} as const;

const STOP_TEXT: Record<StopReason, string> = {
  unauthenticated: "Observations stopped: your session has ended.",
  unavailable: "Observations unavailable.",
  unsupported_version: "Observations unavailable: the stream uses a protocol version this page can't read.",
  protocol_faults: "Observations stopped: the stream sent messages that couldn't be read.",
};

function connectionStatus(state: ObservationState): { tone: StatusTone; label: string } {
  switch (state.phase) {
    case "connecting":
      return { tone: "neutral", label: "Connecting" };
    case "streaming":
      return { tone: "success", label: "Receiving" };
    case "waiting":
      return state.tooManyStreams
        ? { tone: "warning", label: "Too many streams, waiting to retry" }
        : { tone: "warning", label: "Disconnected, reconnecting" };
    case "paused":
      return { tone: "neutral", label: "Paused (tab hidden)" };
    case "offline":
      return { tone: "warning", label: "Offline" };
    case "stopped":
      return { tone: "danger", label: "Stopped" };
    default:
      return { tone: "neutral", label: "Not connected" };
  }
}

type Row = { value: ObservationValue; pair: string; freshness: ReturnType<typeof valueFreshness>; age: number | null };

function formatAge(ms: number): string {
  return `${Math.floor(ms / 1000)} s`;
}

function columns(): TableColumn<Row>[] {
  return [
    { key: "pair", header: "Pair", cell: (r) => <span className="font-medium text-ink-primary">{r.pair}</span> },
    {
      key: "rate",
      header: "Rate",
      numeric: true,
      cell: (r) => (r.freshness === "unavailable" ? <span className="text-ink-muted">{OBSERVATION_COPY.unavailable}</span> : r.value.rate),
    },
    {
      key: "label",
      header: "Label",
      cell: (r) =>
        r.freshness === "unavailable" ? (
          <Badge tone="tag">{OBSERVATION_COPY.unavailable}</Badge>
        ) : (
          <Badge tone={r.freshness === "stale" ? "warning" : "tag"}>
            {r.freshness === "stale" ? `${OBSERVATION_COPY.simulated} · stale` : OBSERVATION_COPY.simulated}
          </Badge>
        ),
    },
    { key: "age", header: "Age", numeric: true, cell: (r) => (r.freshness === "unavailable" || r.age === null ? "" : formatAge(r.age)) },
    { key: "source", header: "Source", cell: (r) => (r.freshness === "unavailable" ? "" : r.value.sourceId) },
    { key: "transport", header: "Transport", cell: (r) => (r.freshness === "unavailable" ? "" : "synthetic") },
  ];
}

function rowsOf(values: readonly ObservationValue[], profile: Profile, now: number): Row[] {
  return values.map((value) => ({
    value,
    pair: `${value.base}/${value.quote}`,
    freshness: valueFreshness(value, profile, now),
    age: currentAgeMs(value, now),
  }));
}

/** The panel itself. Mounted only through ObservationsSection, which checks both flags and the session. */
export function ObservationPanel() {
  const { state, controller } = useObservationStream();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const now = controller.now();
  const { values, profile } = state;

  // Re-render when a value crosses a threshold, and at least once a second so ages advance.
  // A value only degrades between messages (fresh, stale, unavailable); a new message replaces it.
  useEffect(() => {
    if (!values || !profile) return;
    const id = setTimeout(rerender, msUntilNextChange(values, profile, controller.now(), 1000));
    return () => clearTimeout(id);
  });

  const status = connectionStatus(state);
  const rows = values && profile ? rowsOf(values, profile, now) : [];
  const sourceOutage = state.source?.status === "outage";

  return (
    <Card aria-label="Simulated FX observations" data-testid="observation-panel">
      <CardHeader
        title={OBSERVATION_COPY.title}
        description={OBSERVATION_COPY.description}
        actions={
          <>
            <Badge tone="tag">{OBSERVATION_COPY.simulated}</Badge>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => controller.retryNow()}
              disabled={state.phase === "connecting" || state.phase === "idle" || state.phase === "offline"}
            >
              Retry now
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2" role="status">
        <StatusIndicator tone={status.tone} label={status.label} />
        {state.source ? (
          <StatusIndicator tone={sourceOutage ? "warning" : "neutral"} label={`Source ${state.source.sourceId}: ${state.source.status}`} />
        ) : null}
      </div>

      {state.phase === "stopped" && state.stopReason ? (
        <div className="mb-4">
          <Notice tone="danger" role="alert" title="Observations unavailable">
            {STOP_TEXT[state.stopReason]} Use Retry now to try again.
          </Notice>
        </div>
      ) : null}
      {sourceOutage ? (
        <div className="mb-4">
          <Notice tone="warning" title="The simulated source reports an outage">
            Values keep ageing and are withdrawn when they pass the withdrawal threshold.
          </Notice>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <Table
          caption="Simulated FX observations"
          columns={columns()}
          rows={rows}
          getRowKey={(r) => r.pair}
        />
      ) : (
        <p className="text-ui text-ink-muted">No observations are shown yet.</p>
      )}

      <p className="mt-5 border-t border-line-subtle pt-4 text-meta text-ink-muted">{OBSERVATION_COPY.context}</p>
    </Card>
  );
}

/**
 * The only thing the dashboard mounts (AD-1 §3.3.4). The panel exists only when the data mode is
 * live AND the build flag VITE_OBSERVATIONS is "on" AND the session is signed in. Otherwise this
 * renders nothing: no request, no listener, no Retry now. Preview mode is unchanged.
 */
export function ObservationsSection() {
  const live = useDataMode() === "live";
  const enabled = useObservationsFlag();
  const { status } = useObservationSession();
  if (!live || !enabled || status !== "signedIn") return null;
  return <ObservationPanel />;
}
