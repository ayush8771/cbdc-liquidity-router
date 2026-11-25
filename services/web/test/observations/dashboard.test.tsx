import { screen, waitFor, within } from "@testing-library/react";
import { delay, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { dashboardHandler } from "../msw/dashboard";
import { server } from "../msw/server";
import { fixtureRows, transactionsHandler } from "../msw/transactions";
import { renderRoute } from "../renderRoute";
import { snapshot, sse } from "./fixtures";

const original = window.matchMedia;
function mockWidth(width: number) {
  window.matchMedia = vi.fn(
    (query: string) =>
      ({
        matches: query === "(min-width: 1024px)" ? width >= 1024 : false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  ) as unknown as typeof window.matchMedia;
}

type StreamRequest = { pathname: string; authorization: string | null; accept: string | null };

/** A stream endpoint that records its requests and sends one snapshot, then stays open. */
function streamHandler(seen: StreamRequest[]) {
  return http.get("*/api/rt/v1/observations/stream", ({ request }) => {
    seen.push({
      pathname: new URL(request.url).pathname,
      authorization: request.headers.get("Authorization"),
      accept: request.headers.get("Accept"),
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse(snapshot(1))));
      },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
  });
}

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  sessionStorage.clear();
  window.matchMedia = original;
  vi.restoreAllMocks();
});
afterAll(() => server.close());

function useHandlers() {
  const seen: StreamRequest[] = [];
  server.use(dashboardHandler(), transactionsHandler(fixtureRows()), streamHandler(seen));
  return seen;
}

describe("the desktop dashboard and the observation panel (D-24)", () => {
  it("shows the panel with live mode and the flag on, and the dashboard is otherwise unchanged", async () => {
    mockWidth(1280);
    const seen = useHandlers();
    renderRoute("/", { data: "live", observations: true });

    const panel = await screen.findByTestId("observation-panel");
    await waitFor(() => expect(within(panel).getAllByText("SIMULATED").length).toBeGreaterThanOrEqual(5)); // header + 4 rows
    expect(within(panel).getByText("USD/INR")).toBeInTheDocument();
    expect(seen).toEqual([{ pathname: "/api/rt/v1/observations/stream", authorization: "Bearer mock-analyst", accept: "text/event-stream" }]);

    await waitFor(() => expect(within(screen.getByRole("region", { name: "Totals" })).queryByRole("status")).toBeNull());
    expect(await screen.findByRole("region", { name: "Recent transactions" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Metrics by policy" })).toBeInTheDocument();
    expect(screen.getByText("Observations are shown for context. They do not affect routing.")).toBeInTheDocument();
  });

  it("makes no stream request and shows no panel with the flag off (the default)", async () => {
    mockWidth(1280);
    const seen = useHandlers();
    renderRoute("/", { data: "live" });
    await screen.findByRole("region", { name: "Recent transactions" });
    await delay(50);
    expect(seen).toHaveLength(0);
    expect(screen.queryByTestId("observation-panel")).toBeNull();
  });

  it("makes no stream request and shows no panel in preview mode, even with the flag on", async () => {
    mockWidth(1280);
    const seen = useHandlers();
    renderRoute("/", { data: "preview", observations: true });
    await screen.findByText("Preview data — illustrative, not from the API");
    await delay(50);
    expect(seen).toHaveLength(0);
    expect(screen.queryByTestId("observation-panel")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry now" })).toBeNull();
  });

  it("makes no stream request below 1024px, where the mobile dashboard is shown", async () => {
    mockWidth(800);
    const seen = useHandlers();
    renderRoute("/", { data: "live", observations: true });
    await delay(80);
    expect(seen).toHaveLength(0);
    expect(screen.queryByTestId("observation-panel")).toBeNull();
  });
});
