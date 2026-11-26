import type { Page, Request } from "@playwright/test";

export const STREAM = "/api/rt/v1/observations/stream";
/** The per-user stream cap (AD-1 v0.5 section 3.5; MAX_STREAMS_PER_USER in the backend). */
export const PER_USER_STREAM_LIMIT = 3;
/** How long one probe request may wait for its response headers. A probe is a local request; it normally answers in milliseconds. */
const PROBE_TIMEOUT_MS = 3000;

/**
 * The observation stream requests of one page. `open` counts those started and not yet reported ended.
 *
 * A reload destroys the document that owned them, and the browser does not always report the end of a request that the teardown cancelled:
 * measured on one stack, 1 reload in 30 never produced `requestfailed` for the old stream, and the event never arrived later, so `open`
 * stayed one too high for the rest of the page's life. The server had released the slot within 120 ms. So a caller that reloads takes a
 * `snapshot()` first, `forget()`s it afterwards, and proves on the server, with freeStreamSlots(), that the old connection is closed.
 */
export function trackStreams(page: Page) {
  const live = new Set<Request>();
  const urls: string[] = [];
  const other: string[] = [];
  let started = 0;
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (path === STREAM) {
      started++;
      live.add(r);
      urls.push(r.url());
    } else if (path.startsWith("/api/rt/")) {
      other.push(path);
    }
  });
  const ended = (r: Request) => {
    live.delete(r);
  };
  page.on("requestfinished", ended);
  page.on("requestfailed", ended);
  return {
    get started() { return started; },
    get open() { return live.size; },
    get urls() { return urls; },
    get other() { return other; },
    /** The stream requests open now: take it just before an action that destroys the document (a reload). */
    snapshot(): Request[] { return [...live]; },
    /** Stops counting requests of the destroyed document. Requests that started after the snapshot are kept. */
    forget(requests: Request[]) { for (const r of requests) live.delete(r); },
  };
}

/**
 * How many more streams this user can still open (0 to PER_USER_STREAM_LIMIT): sequential connections until the first refusal,
 * all aborted afterwards. It is the server's own count, so it does not depend on what the browser reports. With the page holding one
 * stream the answer is PER_USER_STREAM_LIMIT - 1; an old connection that was not released makes it one lower.
 */
export async function freeStreamSlots(token: string): Promise<number> {
  const base = process.env.E2E_BASE_URL ?? "http://127.0.0.1:8080";
  const controllers: AbortController[] = [];
  let ok = 0;
  try {
    for (let i = 0; i <= PER_USER_STREAM_LIMIT; i++) {
      const ac = new AbortController();
      controllers.push(ac); // registered before the request: a failed or hung one is aborted as well
      const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]); // a probe that gets no answer fails instead of hanging
      const r = await fetch(base + STREAM, { headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" }, signal });
      if (r.status !== 200) {
        await r.body?.cancel().catch(() => undefined);
        break;
      }
      ok++;
    }
  } finally {
    for (const ac of controllers) ac.abort(); // success, refusal, error or timeout: every probe connection is closed
  }
  return ok;
}
