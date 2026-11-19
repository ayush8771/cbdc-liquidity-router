import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SESSION_TOKEN_KEY } from "../src/auth/tokenStore";
import { formatUsd } from "../src/lib/format";
import { PREVIEW_NETWORK } from "../src/preview/previewNetwork";
import { fixtureNetwork, networkHandler } from "./msw/network";
import { server } from "./msw/server";
import { renderRoute } from "./renderRoute";

const original = window.matchMedia;

function mockWidth(width: number) {
  const impl = (query: string) =>
    ({
      matches: query === "(min-width: 1024px)" ? width >= 1024 : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
  window.matchMedia = vi.fn(impl) as unknown as typeof window.matchMedia;
}

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  sessionStorage.clear();
  window.matchMedia = original;
  vi.restoreAllMocks();
});
afterAll(() => server.close());

const PREVIEW_NOTICE = "Preview data — illustrative, not from the API";
const live = (search = "") => renderRoute(`/network${search}`, { data: "live" });
const corridorCard = (name: string) => screen.getByRole("region", { name: `Corridor ${name}` });
const fixture = fixtureNetwork();

function recordRequests() {
  const seen: { url: URL; authorization: string | null }[] = [];
  server.use(networkHandler(undefined, { onRequest: (url, authorization) => seen.push({ url, authorization }) }));
  return seen;
}

describe("Network (desktop) on the live API", () => {
  it("makes one request, with the session's bearer token and no parameters", async () => {
    mockWidth(1280);
    const seen = recordRequests();
    live();

    await screen.findByRole("region", { name: "Corridor USA → IND" });
    await delay(30);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.authorization).toBe("Bearer mock-analyst");
    expect(seen[0]!.url.pathname).toBe("/api/v1/network");
    expect(seen[0]!.url.search).toBe("");
  });

  it("shows the same page as the preview: one card per corridor, with the countries and venue count", async () => {
    mockWidth(1280);
    live();

    await screen.findByRole("region", { name: "Corridor USA → IND" });
    expect(screen.getAllByRole("table")).toHaveLength(fixture.corridors.length);
    for (const corridor of fixture.corridors) {
      const name = corridor.corridor.replace("->", " → ");
      const card = corridorCard(name);
      expect(within(card).getByRole("heading", { name })).toBeInTheDocument();
      expect(card).toHaveTextContent(`${corridor.senderCountry} to ${corridor.receiverCountry}`);
      expect(card).toHaveTextContent(`${corridor.venues.length} venues`);
    }
    // The same five columns, and nothing live.
    for (const table of screen.getAllByRole("table")) {
      expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
        "Venue",
        "Slot",
        "Fee",
        "Baseline capacity",
        "Data source",
      ]);
    }
    expect(screen.queryByRole("columnheader", { name: /congestion|liquidity|status|health|available/i })).not.toBeInTheDocument();
  });

  it("shows each venue's slot, fee as a percentage (from the fraction), baseline capacity and data source", async () => {
    mockWidth(1280);
    live();

    await screen.findByRole("region", { name: "Corridor USA → IND" });
    const rows = within(corridorCard("USA → IND")).getAllByRole("row").slice(1);
    const first = fixture.corridors[0]!.venues[0]!;
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText(String(first.bridgeUid))).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent("1.50%"); // 0.015
    expect(rows[0]).toHaveTextContent(formatUsd(Number(first.baselineCapacityUsd)));
    expect(rows[0]).toHaveTextContent("Real static bridge");
    expect(rows[1]).toHaveTextContent("1.05%"); // 0.0105
    expect(rows[1]).toHaveTextContent("Synthetic expansion");
  });

  it("shows every fee as a percentage and never as the raw fraction", async () => {
    mockWidth(1280);
    live();
    await screen.findByRole("region", { name: "Corridor USA → IND" });
    for (const table of screen.getAllByRole("table")) {
      for (const row of within(table).getAllByRole("row").slice(1)) {
        expect(within(row).getAllByRole("cell")[2]!.textContent).toMatch(/^\d\.\d{2}%$/);
      }
    }
  });

  it("shows the single-transfer limit with its provenance, and the reference-data notice", async () => {
    mockWidth(1280);
    live();

    const card = await screen.findByRole("region", { name: "Single-transfer limit" });
    expect(card).toHaveTextContent(formatUsd(500000));
    expect(card).toHaveTextContent("Provenance: Project assumption");
    expect(screen.getByText("Baseline capacity is reference data")).toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByRole("link", { name: "Bridge monitor" })).toHaveAttribute("href", "/bridges");
  });

  it("labels the synthetic venues, and shows the no-real-anchor and unknown tags as they are", async () => {
    mockWidth(1280);
    const body = fixtureNetwork();
    body.corridors[0]!.venues[2]!.dataSourceTag = "future_source_tag";
    server.use(networkHandler(body));
    live();

    await screen.findByRole("region", { name: "Corridor USA → IND" });
    const expansion = fixture.corridors.flatMap((c) => c.venues).filter((v) => v.dataSourceTag === "synthetic_bridge_expansion").length;
    // The venue whose tag became unknown no longer counts as a synthetic expansion venue.
    expect(screen.getAllByText("Synthetic venue")).toHaveLength(expansion - 1);
    expect(screen.getAllByText("Synthetic — no real anchor")).toHaveLength(1);
    expect(screen.getByText("future_source_tag")).toBeInTheDocument();
  });

  it("is labelled live, and not as preview data", async () => {
    mockWidth(1280);
    live();
    await screen.findByRole("region", { name: "Corridor USA → IND" });
    expect(screen.getByText("Live data")).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
    expect(screen.queryByText(PREVIEW_NOTICE)).not.toBeInTheDocument();
  });

  it("shows the network the API sent, not the preview's: the numbers are the fixture's", async () => {
    mockWidth(1280);
    const body = fixtureNetwork();
    body.maxSingleTransferUsd = 250000;
    body.corridors[0]!.venues[0]!.baselineCapacityUsd = 123456;
    server.use(networkHandler(body));
    live();

    const card = await screen.findByRole("region", { name: "Single-transfer limit" });
    expect(card).toHaveTextContent(formatUsd(250000));
    expect(corridorCard("USA → IND")).toHaveTextContent(formatUsd(123456));
    expect(PREVIEW_NETWORK.maxSingleTransferUsd).toBe(500000); // the preview data was not used or changed
  });

  it.each(["error", "empty", "loading"])("ignores the preview review state ?state=%s and loads the real network", async (state) => {
    mockWidth(1280);
    live(`?state=${state}`);
    await screen.findByRole("region", { name: "Corridor USA → IND" });
    expect(screen.queryByText(/preview of an error/)).not.toBeInTheDocument();
    expect(screen.queryByText("No corridors")).not.toBeInTheDocument();
  });
});

describe("Network (desktop) loading, empty and error states", () => {
  it("shows a loading state while the request runs", async () => {
    mockWidth(1280);
    server.use(
      http.get("*/api/v1/network", async () => {
        await delay(60);
        return HttpResponse.json(fixtureNetwork());
      }),
    );
    live();

    expect(screen.getByRole("status")).toHaveTextContent("Loading the network");
    await screen.findByRole("region", { name: "Corridor USA → IND" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows 'No corridors' when the network lists none, and keeps the reference-data notice", async () => {
    mockWidth(1280);
    server.use(networkHandler({ ...fixtureNetwork(), corridors: [] }));
    live();

    expect(await screen.findByText("No corridors")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("Baseline capacity is reference data")).toBeInTheDocument();
  });

  it("shows a server error with its request ID, does not retry by itself, and retries on request", async () => {
    mockWidth(1280);
    let calls = 0;
    server.use(
      http.get("*/api/v1/network", () => {
        calls += 1;
        return HttpResponse.json(
          { error: { code: "INTERNAL_ERROR", message: "BACKEND TEXT", details: {}, requestId: "req-500" } },
          { status: 500 },
        );
      }),
    );
    const user = userEvent.setup();
    live();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the network");
    expect(alert).toHaveTextContent("The server hit an unexpected error");
    expect(alert).toHaveTextContent("req-500");
    expect(alert).not.toHaveTextContent("BACKEND TEXT");
    await delay(80);
    expect(calls).toBe(1);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    server.use(networkHandler());
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("region", { name: "Corridor USA → IND" })).toBeInTheDocument();
    expect(calls).toBe(1);
  });

  it("says the engine is starting up when the backend reports NOT_READY, and offers a retry", async () => {
    mockWidth(1280);
    server.use(
      http.get("*/api/v1/network", () =>
        HttpResponse.json(
          { error: { code: "INFERENCE_UNAVAILABLE", message: "BACKEND TEXT", details: { cause: "NOT_READY" }, requestId: "req-503" } },
          { status: 503, headers: { "Retry-After": "5" } },
        ),
      ),
    );
    live();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("starting up");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("says the engine is unavailable on another 503", async () => {
    mockWidth(1280);
    server.use(
      http.get("*/api/v1/network", () =>
        HttpResponse.json({ error: { code: "INFERENCE_UNAVAILABLE", message: "x", details: {}, requestId: "r" } }, { status: 503 }),
      ),
    );
    live();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("unavailable");
    expect(alert).not.toHaveTextContent("starting up");
  });

  it("says when the server could not be reached", async () => {
    mockWidth(1280);
    server.use(http.get("*/api/v1/network", () => HttpResponse.error()));
    live();
    expect(await screen.findByRole("alert")).toHaveTextContent("The server could not be reached");
  });

  it("treats a body that isn't a network as an error, never as an empty or partial page", async () => {
    mockWidth(1280);
    const bad = fixtureNetwork();
    (bad.corridors[0]!.venues[0] as Record<string, unknown>).feePct = "0.015";
    for (const body of [{ hello: "world" }, bad]) {
      server.use(networkHandler(body));
      const { unmount } = live();
      expect(await screen.findByRole("alert")).toHaveTextContent("response this page couldn't read");
      expect(screen.queryByText("No corridors")).not.toBeInTheDocument();
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      unmount();
    }
  });

  it("ends the session on a 401 and returns to sign-in with a message", async () => {
    mockWidth(1280);
    sessionStorage.setItem(SESSION_TOKEN_KEY, "mock-analyst");
    server.use(
      http.get("*/api/v1/network", () =>
        HttpResponse.json({ error: { code: "UNAUTHENTICATED", message: "x", details: {} } }, { status: 401 }),
      ),
    );
    const { router } = renderRoute("/network", { auth: "real", data: "live" });

    expect(await screen.findByText("Your session has ended")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"));
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
  });
});

describe("preview mode and the narrow layout are unchanged", () => {
  it("preview mode shows the preview network, labelled, with its review states, and makes no request", async () => {
    mockWidth(1280);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderRoute("/network", { data: "preview" });

    expect(screen.getByText(PREVIEW_NOTICE)).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.queryByText("Live data")).not.toBeInTheDocument();
    expect(screen.getAllByRole("table")).toHaveLength(PREVIEW_NETWORK.corridors.length);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["loading", "Loading the network"],
    ["empty", "No corridors"],
    ["error", "Couldn't load the network"],
  ])("preview mode keeps ?state=%s without a request", (state, text) => {
    mockWidth(1280);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderRoute(`/network?state=${state}`, { data: "preview" });
    expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("below 1024px the page is still the unchanged placeholder, with no request, even in live mode", () => {
    mockWidth(800);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    live();

    expect(screen.getByText("This screen isn't connected yet")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Endpoints" })).toHaveTextContent("GET /api/v1/network");
    expect(screen.queryByText("Live data")).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
