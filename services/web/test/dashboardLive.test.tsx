import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SESSION_TOKEN_KEY } from "../src/auth/tokenStore";
import { formatCount } from "../src/lib/format";
import { NO_LIQUIDITY_CARRY_OVER } from "../src/lib/labels";
import { dashboardHandler, fixtureSummary } from "./msw/dashboard";
import { server } from "./msw/server";
import { fixtureRows, transactionsHandler } from "./msw/transactions";
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
const LIVE_FOOTNOTE = "A dash means the value isn't available.";
const PREVIEW_FOOTNOTE = /The preview data has no fee cost, reward, latency or risk values/;
const live = (search = "") => renderRoute(`/${search}`, { data: "live" });
const fixture = fixtureSummary();
const totalsRegion = () => screen.getByRole("region", { name: "Totals" });
const recentCard = () => screen.getByRole("region", { name: "Recent transactions" });
const policyTable = () => screen.getByRole("table", { name: "Metrics by policy" });
const findTotals = () => screen.findByRole("region", { name: "Totals" });
const errorAlerts = () => screen.queryAllByRole("alert");

function tile(label: string) {
  return within(totalsRegion()).getByText(label, { selector: "p" }).previousElementSibling;
}

type Seen = { kind: "summary" | "recent"; url: URL; authorization: string | null };

/** Records the requests that reach the summary and the recent-transactions handlers. */
function recordRequests() {
  const seen: Seen[] = [];
  server.use(
    dashboardHandler(undefined, { onRequest: (url, authorization) => seen.push({ kind: "summary", url, authorization }) }),
    transactionsHandler(fixtureRows(), { onRequest: (url, authorization) => seen.push({ kind: "recent", url, authorization }) }),
  );
  return seen;
}
const ofKind = (seen: Seen[], kind: Seen["kind"]) => seen.filter((s) => s.kind === kind);

const serverError = (requestId = "req-500") =>
  HttpResponse.json({ error: { code: "INTERNAL_ERROR", message: "BACKEND TEXT", details: {}, requestId } }, { status: 500 });

describe("Dashboard (desktop) on the live API: the summary", () => {
  it("makes one summary request and one recent request, each with the bearer token, and no filters", async () => {
    mockWidth(1280);
    const seen = recordRequests();
    live();

    await findTotals();
    await within(recentCard()).findByRole("table", { name: "Recent transactions" });
    await delay(30);

    expect(ofKind(seen, "summary")).toHaveLength(1);
    expect(ofKind(seen, "summary")[0]!.authorization).toBe("Bearer mock-analyst");
    expect(ofKind(seen, "summary")[0]!.url.pathname).toBe("/api/v1/dashboard/summary");
    expect(ofKind(seen, "summary")[0]!.url.search).toBe("");
    expect(ofKind(seen, "recent")).toHaveLength(1);
    expect(ofKind(seen, "recent")[0]!.authorization).toBe("Bearer mock-analyst");
    expect([...ofKind(seen, "recent")[0]!.url.searchParams.entries()]).toEqual([
      ["page", "1"],
      ["pageSize", "5"],
    ]);
  });

  it("shows the totals of the summary", async () => {
    mockWidth(1280);
    live();
    await findTotals();
    expect(tile("Transactions")).toHaveTextContent(formatCount(fixture.totals.transactions));
    expect(tile("Routed")).toHaveTextContent(formatCount(fixture.totals.routed));
    expect(tile("Failed")).toHaveTextContent(formatCount(fixture.totals.failed));
    expect(tile("Rejected by feasibility")).toHaveTextContent(formatCount(fixture.totals.rejectedByFeasibility));
  });

  it("shows the activity bars: corridors by routed count, policies by request count", async () => {
    mockWidth(1280);
    live();
    await findTotals();
    const corridors = within(screen.getByRole("list", { name: "Routed transactions" })).getAllByRole("listitem");
    expect(corridors).toHaveLength(fixture.byCorridor.length);
    expect(corridors[1]).toHaveTextContent("GBR → PHL");
    expect(corridors[1]).toHaveTextContent("5");
    const policies = within(screen.getByRole("list", { name: "Requests by policy" })).getAllByRole("listitem");
    expect(policies).toHaveLength(fixture.byPolicy.length);
    expect(policies[0]).toHaveTextContent("Waterfall");
    expect(policies[0]).toHaveTextContent("5");
  });

  it("shows the policy metrics from the API: counts, completion, and the means, with the fee cost as the percentage it is", async () => {
    mockWidth(1280);
    live();
    await findTotals();
    const rows = within(policyTable()).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    const waterfall = within(rows[0]!).getAllByRole("cell");
    expect(waterfall[1]).toHaveTextContent("5"); // requests
    expect(waterfall[2]).toHaveTextContent("3"); // allowed routed
    expect(waterfall[3]).toHaveTextContent("66.7%"); // 0.666667
    expect(waterfall[4]).toHaveTextContent("1.56%"); // 1.563333, already a percentage: not multiplied
    expect(waterfall[5]).toHaveTextContent("-0.2514");
    expect(waterfall[6]).toHaveTextContent("0.2571");
    expect(waterfall[7]).toHaveTextContent("0");
    expect(within(rows[1]!).getAllByRole("cell")[4]).toHaveTextContent("1.40%");
    expect(rows[2]).toHaveTextContent(/Experimental/);
  });

  it("shows the corridor metrics and the summary's note", async () => {
    mockWidth(1280);
    live();
    await findTotals();
    const rows = within(screen.getByRole("table", { name: "Metrics by corridor" })).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveTextContent("GBR → PHL");
    expect(within(rows[1]!).getAllByRole("cell")[3]).toHaveTextContent("50.0%");
    expect(screen.getByText(fixture.note)).toBeInTheDocument();
  });

  it("keeps the placeholder-weights label, the filters and the carry-over notice", async () => {
    mockWidth(1280);
    live();
    await findTotals();
    expect(screen.getAllByText(/placeholder/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: "Filters" })).toBeInTheDocument();
    expect(screen.getByText(NO_LIQUIDITY_CARRY_OVER)).toBeInTheDocument();
  });

  it("shows a dash, not zero, for a mean that is null, and a real zero as 0", async () => {
    mockWidth(1280);
    const body = fixtureSummary();
    body.byPolicy[1] = {
      ...body.byPolicy[1]!,
      allowedRouted: 0,
      completionRate: null,
      meanRewardAmountBased: null,
      meanFeeCostPct: null,
      meanLatencyTerm: null,
      meanRiskTerm: null,
    };
    server.use(dashboardHandler(body));
    live();
    await findTotals();

    const rows = within(policyTable()).getAllByRole("row").slice(1);
    const cells = within(rows[1]!).getAllByRole("cell");
    for (const i of [3, 4, 5, 6, 7]) expect(within(cells[i]!).getByText("Not available")).toBeInTheDocument();
    expect(within(rows[0]!).getAllByRole("cell")[7]).toHaveTextContent("0"); // a real zero risk
  });

  it("shows an unknown policy as written", async () => {
    mockWidth(1280);
    const body = fixtureSummary();
    body.byPolicy[0] = { ...body.byPolicy[0]!, policy: "someNewPolicy" };
    server.use(dashboardHandler(body));
    live();
    await findTotals();
    expect(screen.getAllByText("someNewPolicy").length).toBeGreaterThan(0);
  });
});

describe("Dashboard (desktop): the live footnote and labels", () => {
  it("uses the shorter footnote in live mode, and not the preview wording", async () => {
    mockWidth(1280);
    live();
    await findTotals();
    expect(screen.getByText(LIVE_FOOTNOTE)).toBeInTheDocument();
    expect(screen.queryByText(PREVIEW_FOOTNOTE)).not.toBeInTheDocument();
    expect(screen.queryByText(/preview data/i)).not.toBeInTheDocument();
  });

  it("is labelled live, with no preview notice", async () => {
    mockWidth(1280);
    live();
    await findTotals();
    expect(screen.getByText("Live data")).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
    expect(screen.queryByText(PREVIEW_NOTICE)).not.toBeInTheDocument();
  });
});

describe("Dashboard (desktop): filters", () => {
  it("sends every filter under the contract's names, with the dates as UTC timestamps (to excluded)", async () => {
    mockWidth(1280);
    const seen = recordRequests();
    live("?corridor=GBR-%3EPHL&policy=waterfall&from=2026-11-01&to=2026-11-03");

    await findTotals();
    expect(Object.fromEntries(ofKind(seen, "summary")[0]!.url.searchParams)).toEqual({
      corridor: "GBR->PHL",
      policy: "waterfall",
      from: "2026-11-01T00:00:00.000Z",
      to: "2026-11-03T00:00:00.000Z",
    });
    // The window line says the end isn't included.
    expect(screen.getByTestId("window")).toHaveTextContent("end not included");
    // The recent transactions are not filtered.
    expect(ofKind(seen, "recent")[0]!.url.searchParams.get("corridor")).toBeNull();
  });

  it("shows 'All time' for an unbounded window", async () => {
    mockWidth(1280);
    live();
    await findTotals();
    expect(screen.getByTestId("window")).toHaveTextContent("All time");
  });

  it("changing a filter requests a new summary, and does not request the recent transactions again", async () => {
    mockWidth(1280);
    const seen = recordRequests();
    const user = userEvent.setup();
    const { router } = live();
    await findTotals();
    await within(recentCard()).findByRole("table", { name: "Recent transactions" });

    await user.selectOptions(screen.getByRole("combobox", { name: "Policy" }), "cheapestFeasible");

    await waitFor(() => expect(ofKind(seen, "summary")).toHaveLength(2));
    expect(ofKind(seen, "summary")[1]!.url.searchParams.get("policy")).toBe("cheapestFeasible");
    expect(router.state.location.search).toBe("?policy=cheapestFeasible");
    await findTotals();
    expect(ofKind(seen, "recent")).toHaveLength(1);
  });

  it("makes no request while a filter can't be applied, and says so", async () => {
    mockWidth(1280);
    const seen = recordRequests();
    live("?corridor=XXX");

    expect(await screen.findByText("The summary isn't shown")).toBeInTheDocument();
    await delay(40);
    expect(seen).toHaveLength(0);
    expect(screen.queryByRole("region", { name: "Recent transactions" })).not.toBeInTheDocument();
  });

  it("makes the requests once the bad filter is fixed", async () => {
    mockWidth(1280);
    const seen = recordRequests();
    const { router } = live("?from=2026-11-05&to=2026-11-01");
    expect(await screen.findByText("The summary isn't shown")).toBeInTheDocument();
    expect(seen).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("From (included)"), { target: { value: "2026-11-01" } });
    fireEvent.change(screen.getByLabelText("To (not included)"), { target: { value: "2026-11-05" } });

    await findTotals();
    expect(router.state.location.search).toContain("from=2026-11-01");
    expect(ofKind(seen, "summary").length).toBeGreaterThan(0);
    expect(ofKind(seen, "recent")).toHaveLength(1);
  });
});

describe("Dashboard (desktop): empty states", () => {
  const empty = () => {
    const body = fixtureSummary();
    body.totals = { transactions: 0, routed: 0, failed: 0, rejectedByFeasibility: 0 };
    body.byPolicy = [];
    body.byCorridor = [];
    return body;
  };

  it("shows 'No transactions yet' with a link to route one", async () => {
    mockWidth(1280);
    server.use(dashboardHandler(empty()), transactionsHandler([]));
    live();

    expect(await screen.findByText("No transactions yet", { selector: "h2, h3, p" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Totals" })).not.toBeInTheDocument();
    // The recent card has its own empty line.
    expect(await within(recentCard()).findByText("No transactions yet.")).toBeInTheDocument();
  });

  it("shows 'No transactions in this window' for a filtered, empty summary, and Clear filters goes back", async () => {
    mockWidth(1280);
    server.use(dashboardHandler(empty()));
    const user = userEvent.setup();
    const { router } = live("?policy=waterfall");

    expect(await screen.findByText("No transactions in this window")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Clear filters" }).at(-1)!);

    await waitFor(() => expect(router.state.location.search).toBe(""));
  });
});

describe("Dashboard (desktop): loading", () => {
  it("shows a loading state for the summary and, separately, for the recent transactions", async () => {
    mockWidth(1280);
    server.use(
      http.get("*/api/v1/dashboard/summary", async () => {
        await delay(80);
        return HttpResponse.json(fixtureSummary());
      }),
      http.get("*/api/v1/transactions", async () => {
        await delay(120);
        return HttpResponse.json({ items: fixtureRows(), page: 1, pageSize: 5, total: 7 });
      }),
    );
    live();

    expect(screen.getByRole("status")).toHaveTextContent("Loading dashboard");
    expect(within(recentCard()).queryByRole("table")).not.toBeInTheDocument();

    await findTotals();
    // The summary has arrived while the recent transactions are still loading.
    expect(within(recentCard()).queryByRole("table")).not.toBeInTheDocument();
    expect(await within(recentCard()).findByRole("table", { name: "Recent transactions" })).toBeInTheDocument();
  });
});

describe("Dashboard (desktop): independent errors", () => {
  it("a failed summary shows its error with the request ID, and the recent transactions still load", async () => {
    mockWidth(1280);
    let calls = 0;
    server.use(
      http.get("*/api/v1/dashboard/summary", () => {
        calls += 1;
        return serverError();
      }),
    );
    live();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the dashboard");
    expect(alert).toHaveTextContent("The server hit an unexpected error");
    expect(alert).toHaveTextContent("req-500");
    expect(alert).not.toHaveTextContent("BACKEND TEXT");
    expect(await within(recentCard()).findByRole("table", { name: "Recent transactions" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Totals" })).not.toBeInTheDocument();
    await delay(60);
    expect(calls).toBe(1); // nothing was retried by itself
  });

  it("retrying the summary asks for the summary only", async () => {
    mockWidth(1280);
    let summaryCalls = 0;
    let recentCalls = 0;
    server.use(
      http.get("*/api/v1/dashboard/summary", () => {
        summaryCalls += 1;
        return summaryCalls === 1 ? serverError() : HttpResponse.json(fixtureSummary());
      }),
      http.get("*/api/v1/transactions", () => {
        recentCalls += 1;
        return HttpResponse.json({ items: fixtureRows(), page: 1, pageSize: 5, total: 7 });
      }),
    );
    const user = userEvent.setup();
    live();
    await screen.findByRole("alert");
    await within(recentCard()).findByRole("table", { name: "Recent transactions" });

    await user.click(screen.getByRole("button", { name: "Try again" }));

    await findTotals();
    expect(summaryCalls).toBe(2);
    expect(recentCalls).toBe(1);
  });

  it("failed recent transactions show their own error inside the card, and the summary stays", async () => {
    mockWidth(1280);
    let calls = 0;
    server.use(
      http.get("*/api/v1/transactions", () => {
        calls += 1;
        return serverError("req-recent");
      }),
    );
    live();

    await findTotals();
    const alert = await within(recentCard()).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load recent transactions");
    expect(alert).toHaveTextContent("req-recent");
    expect(screen.getByRole("table", { name: "Metrics by policy" })).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load the dashboard")).not.toBeInTheDocument();
    await delay(60);
    expect(calls).toBe(1);
  });

  it("retrying the recent transactions asks for them only", async () => {
    mockWidth(1280);
    let summaryCalls = 0;
    let recentCalls = 0;
    server.use(
      http.get("*/api/v1/dashboard/summary", () => {
        summaryCalls += 1;
        return HttpResponse.json(fixtureSummary());
      }),
      http.get("*/api/v1/transactions", () => {
        recentCalls += 1;
        return recentCalls === 1
          ? serverError()
          : HttpResponse.json({ items: fixtureRows(), page: 1, pageSize: 5, total: 7 });
      }),
    );
    const user = userEvent.setup();
    live();
    const alert = await within(recentCard()).findByRole("alert");

    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await within(recentCard()).findByRole("table", { name: "Recent transactions" })).toBeInTheDocument();
    expect(recentCalls).toBe(2);
    expect(summaryCalls).toBe(1);
  });

  it("both failing show both errors", async () => {
    mockWidth(1280);
    server.use(http.get("*/api/v1/dashboard/summary", () => HttpResponse.error()), http.get("*/api/v1/transactions", () => serverError()));
    live();

    await waitFor(() => expect(errorAlerts()).toHaveLength(2));
    expect(screen.getByText("Couldn't load the dashboard")).toBeInTheDocument();
    expect(screen.getByText("Couldn't load recent transactions")).toBeInTheDocument();
  });

  it("says when the server could not be reached", async () => {
    mockWidth(1280);
    server.use(http.get("*/api/v1/dashboard/summary", () => HttpResponse.error()));
    live();
    expect(await screen.findByRole("alert")).toHaveTextContent("The server could not be reached");
  });

  it("treats a body that isn't a summary, or contradicts itself, as an error and not as an empty dashboard", async () => {
    mockWidth(1280);
    const contradictory = fixtureSummary();
    contradictory.totals.failed = 5;
    for (const body of [{ hello: "world" }, contradictory]) {
      server.use(dashboardHandler(body as never));
      const { unmount } = live();
      expect(await screen.findByText("Couldn't load the dashboard")).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent("response this page couldn't read");
      expect(screen.queryByText("No transactions yet", { selector: "h2, h3" })).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Totals" })).not.toBeInTheDocument();
      unmount();
    }
  });

  it("ends the session on a 401 from the summary", async () => {
    mockWidth(1280);
    sessionStorage.setItem(SESSION_TOKEN_KEY, "mock-analyst");
    server.use(
      http.get("*/api/v1/dashboard/summary", () =>
        HttpResponse.json({ error: { code: "UNAUTHENTICATED", message: "x", details: {} } }, { status: 401 }),
      ),
    );
    const { router } = renderRoute("/", { auth: "real", data: "live" });

    expect(await screen.findByText("Your session has ended")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"));
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
  });
});

describe("Dashboard (desktop): the recent transactions", () => {
  it("lists the newest five from the History's request, with their outcomes and links", async () => {
    mockWidth(1280);
    live();

    const table = await within(recentCard()).findByRole("table", { name: "Recent transactions" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(5);
    expect(within(recentCard()).getAllByRole("link", { name: /^View transaction/ })[0]).toHaveAttribute(
      "href",
      `/transactions/${fixtureRows()[0]!.id}`,
    );
    expect(rows[0]).toHaveTextContent("Completed");
    expect(rows[1]).toHaveTextContent("Partial");
    expect(rows[2]).toHaveTextContent("Rejected");
    expect(recentCard()).toHaveTextContent("The filters above apply to the summary only.");
  });

  it("shows a failed transaction without a corridor", async () => {
    mockWidth(1280);
    const failed = fixtureRows().find((r) => r.status === "failed")!;
    server.use(transactionsHandler([failed]));
    live();

    const table = await within(recentCard()).findByRole("table", { name: "Recent transactions" });
    const row = within(table).getAllByRole("row")[1]!;
    expect(row).toHaveTextContent("Failed");
    expect(within(row).getByText("Not confirmed")).toBeInTheDocument();
  });
});

describe("preview mode and the narrow layout are unchanged", () => {
  it("preview mode shows the preview dashboard, labelled, with the old footnote, and makes no request", async () => {
    mockWidth(1280);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderRoute("/", { data: "preview" });

    expect(screen.getByText(PREVIEW_NOTICE)).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.queryByText("Live data")).not.toBeInTheDocument();
    expect(screen.getByText(PREVIEW_FOOTNOTE)).toBeInTheDocument();
    expect(screen.queryByText(LIVE_FOOTNOTE)).not.toBeInTheDocument();
    expect(within(recentCard()).getAllByRole("row")).toHaveLength(6);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["loading", "empty", "error"])("preview mode keeps ?state=%s without a request", (state) => {
    mockWidth(1280);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderRoute(`/?state=${state}`, { data: "preview" });
    expect(screen.getByText(PREVIEW_NOTICE)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["loading", "empty", "error"])("live mode ignores ?state=%s and loads the real summary", async (state) => {
    mockWidth(1280);
    live(`?state=${state}`);
    await findTotals();
    expect(screen.queryByText(/preview of an error/)).not.toBeInTheDocument();
    expect(tile("Transactions")).toHaveTextContent(formatCount(fixture.totals.transactions));
  });

  it("below 1024px the dashboard is still the original, on preview data, with no request, even in live mode", () => {
    mockWidth(800);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    live();

    expect(screen.getByText(PREVIEW_NOTICE)).toBeInTheDocument();
    expect(screen.queryByText("Live data")).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
