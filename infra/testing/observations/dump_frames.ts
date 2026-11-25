// Dev D (P-8, AD-1 v0.5 section 3.7): writes the frames the REAL backend stream hub produces, so CI can check them against
// contracts/events/stream-message.v1.schema.json (check_event_contracts.py --frames). Test-only: it is in no image and no
// package; run from services/backend with its own tsx:
//   (cd services/backend && node --import tsx ../../infra/testing/observations/dump_frames.ts "$RUNNER_TEMP/frames.json")
// It drives the real createObservationStore and createStreamHub with a fake clock and sink and the shared ingestion-latest
// fixture's events. Four cases: fresh, stale, aged past unavailable_after_ms (outage), and an empty store (starting).
// Each case is one connection: a snapshot, an update and a heartbeat. It judges nothing: the Python checker does.
import { readFileSync, writeFileSync } from "node:fs";
import { createObservationStore } from "../../../services/backend/src/observations/store.js";
import { createStreamHub } from "../../../services/backend/src/observations/streamHub.js";

const out = process.argv[2];
if (out === undefined) throw new Error("usage: dump_frames.ts OUTPUT.json");

const fixture = new URL("../../../contracts/events/fixtures/ingestion-latest/valid_four_events.json", import.meta.url);
const events = (JSON.parse(readFileSync(fixture, "utf8")) as { instance: { events: unknown[] } }).instance.events;
const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };
const RECEIVED = Date.parse("2026-11-24T10:00:01.000Z");

const frames: { connection: string; event: string; msg: unknown }[] = [];
function connection(label: string, nowIso: string, status: "starting" | "ok" | "outage", load: boolean): void {
  const now = Date.parse(nowIso);
  const logger = quietLogger as never;
  const store = createObservationStore({ logger, now: () => now });
  if (load) for (const e of events) store.ingest(e, RECEIVED);
  const hub = createStreamHub({
    lookup: (b, q) => store.current(b, q),
    sourceStatus: () => status,
    logger,
    clock: { now: () => now, setTimeout: () => 0, clearTimeout() {} },
  });
  const sink = {
    write(chunk: string) {
      const m = /^event: (\w+)\ndata: (.*)\n\n$/s.exec(chunk);
      if (m === null) throw new Error(`not an SSE frame: ${chunk.slice(0, 60)}`);
      frames.push({ connection: label, event: m[1] as string, msg: JSON.parse(m[2] as string) });
      return true;
    },
    end() {},
    destroy() {},
    on() {},
    off() {},
  };
  const slot = hub.reserve("dump");
  if (!slot.ok) throw new Error("no stream slot");
  hub.open(slot.slot, sink);
  hub.publishUpdate("EUR", "USD");
  hub.publishHeartbeat();
}

connection("fresh", "2026-11-24T10:00:02.000Z", "ok", true);
connection("stale", "2026-11-24T10:00:10.000Z", "ok", true);
connection("unavailable", "2026-11-24T10:01:00.000Z", "outage", true);
connection("empty", "2026-11-24T10:00:02.000Z", "starting", false);
writeFileSync(out, JSON.stringify(frames, null, 1));
console.log(`wrote ${frames.length} frames to ${out}`);
