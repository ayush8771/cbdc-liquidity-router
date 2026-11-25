import type { Logger } from "../logger.js";
import { createHttpFetch, createPoller, systemClock, type Clock, type FetchLatest, type Poller } from "./poller.js";
import { createObservationStore, type ObservationStore } from "./store.js";
import { createStreamHub, type StreamHub } from "./streamHub.js";

// The observation module, composed (AD-1 v0.5 §1, §3.5). Created only when
// OBSERVATIONS_URL is set; otherwise nothing here exists, the route is not
// registered (404) and nothing polls. It holds no database, inference or
// routing reference, and nothing it does reaches them (AD-6).

export interface ObservationService {
  readonly store: ObservationStore;
  readonly poller: Poller;
  readonly hub: StreamHub;
  /** Starts polling; call after the server listens. */
  start(): void;
  /**
   * The lifecycle pre-close hook: refuse new streams, stop polling and abort
   * the request in flight, end all streams (destroying any left after 1 s).
   */
  shutdown(): Promise<void>;
}

export interface ObservationServiceOptions {
  url: string;
  logger: Logger;
  clock?: Clock;
  /** Tests only: replaces the HTTP fetch. */
  fetch?: FetchLatest;
  hubOptions?: Pick<Parameters<typeof createStreamHub>[0], "limits" | "timings">;
}

export function createObservationService(options: ObservationServiceOptions): ObservationService {
  const { logger } = options;
  const clock = options.clock ?? systemClock;
  const http = options.fetch === undefined ? createHttpFetch(options.url) : undefined;
  const store = createObservationStore({ logger, now: () => clock.now() });
  // The poller and hub reference each other only through these callbacks.
  let hub: StreamHub | undefined;
  const poller = createPoller({
    fetch: options.fetch ?? (http as { fetch: FetchLatest }).fetch,
    store,
    logger,
    clock,
    onUpdate: ({ event }) => hub?.publishUpdate(event.payload.base_currency, event.payload.quote_currency),
    onStatus: () => hub?.publishHeartbeat(),
  });
  hub = createStreamHub({
    lookup: (base, quote) => store.current(base, quote),
    sourceStatus: () => poller.status(),
    logger,
    clock,
    ...options.hubOptions,
  });
  const streams = hub;

  let shutdownPromise: Promise<void> | undefined;
  return {
    store,
    poller,
    hub: streams,
    start: () => poller.start(),
    shutdown() {
      shutdownPromise ??= (async () => {
        // §3.5 order: refuse new streams (503); stop polling and abort the
        // request in flight; then end all streams, destroying any left after 1 s.
        streams.refuseNew();
        poller.stop();
        http?.close();
        await streams.shutdown();
      })();
      return shutdownPromise;
    },
  };
}
