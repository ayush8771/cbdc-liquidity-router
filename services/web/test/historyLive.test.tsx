import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SESSION_TOKEN_KEY } from "../src/auth/tokenStore";
import { formatUsd } from "../src/lib/format";
import { server } from "./msw/server";
import { fixtureRows, makeRows, transactionsHandler, type ListRow } from "./msw/transactions";
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
const live = (path: string) => renderRoute(path, { data: "live" });
const findTable = () => screen.findByRole("table", { name: "Transactions" });
const dataRows = () => within(screen.getByRole("table", { name: "Transactions" })).getAllByRole("row").slice(1);
const pagination = () => screen.getByRole("navigation", { name: "Pagination" });
const rowOf = (shortId: string) => screen.getByRole("link", { name: `View transaction ${shortId}` }).closest("tr")!;

/** Records every request that reaches the list handler. */
function recordRequests(rows: ListRow[] = fixtureRows()) {
  const calls: { url: URL; authorization: string | null }[] = [];
  server.use(transactionsHandler(rows, { onRequest: (url, authorization) => calls.push({ url, authorization }) }));
  return calls;
}

describe("History (desktop) on the live API", () => {
  it("requests the first page with the session's bearer token, and no filters", async () => {
    mockWidth(1280);
    const calls = recordRequests();
    live("/transactions");

    await findTable();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.authorization).toBe("Bearer mock-analyst");
    expect(calls[0]!.url.pathname).toBe("/api/v1/transactions");
    expect([...calls[0]!.url.searchParams.entries()]).toEqual([
      ["page", "1"],
      ["pageSize", "20"],
    ]);
  });

  it("shows the API's rows, keeps the same table, and says the data is live, not preview", async () => {
    mockWidth(1280);
    live("/transactions");

    await findTable();
    expect(dataRows()).toHaveLength(7);
    expect(pagination()).toHaveTextContent("Showing 1–7 of 7 transactions");
    expect(within(screen.getByRole("table", { name: "Transactions" })).getAllByRole("columnheader")).toHaveLength(9);
    expect(screen.getByText("Live data")).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
    expect(screen.queryByText(PREVIEW_NOTICE)).not.toBeInTheDocument();
  });

  it("links every row to its transaction", async () => {
    mockWidth(1280);
    live("/transactions");
    await findTable();
    expect(screen.getByRole("link", { name: "View transaction 56d0d708" })).toHaveAttribute(
      "href",
      "/transactions/56d0d708-62d6-59aa-aa8d-4df8d9b8d37f",
    );
  });

  it("shows completed, partial, rejected and failed transactions with their own values", async () => {
    mockWidth(1280);
    live("/transactions");
    await findTable();

    expect(within(rowOf("56d0d708")).getByText("Completed")).toBeInTheDocument();
    expect(within(rowOf("56d0d708")).getByText(formatUsd(300000), { selector: "span.block" })).toBeInTheDocument();

    expect(within(rowOf("30bfe62e")).getByText("Partial")).toBeInTheDocument();
    expect(within(rowOf("30bfe62e")).getByText("50.0%")).toBeInTheDocument();

    // A rejection is a result, not an error, and it executed nothing: zero is shown as zero.
    expect(within(rowOf("ab65a498")).getByText("Rejected")).toBeInTheDocument();
    expect(within(rowOf("ab65a498")).getByText(formatUsd(0))).toBeInTheDocument();

    // A failed transaction has no corridor and no executed amount: "not available", never zero.
    const failed = rowOf("a121dc5c");
    expect(within(failed).getByText("Failed")).toBeInTheDocument();
    expect(within(failed).getByText("Not confirmed")).toBeInTheDocument();
    expect(within(failed).getByText("Not available")).toBeInTheDocument();
    expect(within(failed).queryByText(formatUsd(0))).not.toBeInTheDocument();

    // The PPO row keeps its Experimental label.
    expect(within(rowOf("80fa54b8")).getByText(/Experimental/)).toBeInTheDocument();
  });

  it("sends every filter under the contract's names, with the dates as UTC timestamps (to excluded)", async () => {
    mockWidth(1280);
    const calls = recordRequests();
    live(
      "/transactions?corridor=GBR-%3EPHL&policy=waterfall&stateMode=historicalReplay&completed=false&from=2026-11-01&to=2026-11-03&pageSize=50",
    );

    await findTable();
    const sent = Object.fromEntries(calls[0]!.url.searchParams.entries());
    expect(sent).toEqual({
      page: "1",
      pageSize: "50",
      corridor: "GBR->PHL",
      policy: "waterfall",
      stateMode: "historicalReplay",
      completed: "false",
      from: "2026-11-01T00:00:00.000Z",
      to: "2026-11-03T00:00:00.000Z",
    });
    // The fixture's only waterfall replay row that is not completed is the rejection.
    expect(dataRows()).toHaveLength(1);
    expect(within(dataRows()[0]!).getByText("Rejected")).toBeInTheDocument();
  });

  it("applies the date window: `to` is not included", async () => {
    mockWidth(1280);
    live("/transactions?to=2026-11-02");
    // Every fixture row was created on 2 Nov at 10:00, after the excluded midnight.
    expect(await screen.findByText("No transactions match these filters")).toBeInTheDocument();
  });

  it("changing a filter sends a new request and goes back to page 1", async () => {
    mockWidth(1280);
    const calls = recordRequests(makeRows(45));
    const user = userEvent.setup();
    const { router } = live("/transactions?page=2");
    await findTable();
    expect(calls.at(-1)!.url.searchParams.get("page")).toBe("2");

    await user.selectOptions(screen.getByRole("combobox", { name: "Policy" }), "waterfall");

    await waitFor(() => expect(calls.at(-1)!.url.searchParams.get("policy")).toBe("waterfall"));
    expect(calls.at(-1)!.url.searchParams.get("page")).toBe("1");
    expect(router.state.location.search).toBe("?policy=waterfall");
    await findTable();
  });

  it("pages through the API, keeps the page in the URL, and shows the API's total", async () => {
    mockWidth(1280);
    const calls = recordRequests(makeRows(45));
    const user = userEvent.setup();
    const { router } = live("/transactions");

    await findTable();
    expect(dataRows()).toHaveLength(20);
    expect(pagination()).toHaveTextContent("Showing 1–20 of 45 transactions");

    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(pagination()).toHaveTextContent("Showing 21–40 of 45"));
    expect(calls.at(-1)!.url.searchParams.get("page")).toBe("2");
    expect(router.state.location.search).toBe("?page=2");

    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(dataRows()).toHaveLength(5));
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("sends the chosen page size", async () => {
    mockWidth(1280);
    const calls = recordRequests(makeRows(45));
    const user = userEvent.setup();
    live("/transactions");
    await findTable();

    await user.selectOptions(screen.getByRole("combobox", { name: "Rows per page" }), "50");

    await waitFor(() => expect(calls.at(-1)!.url.searchParams.get("pageSize")).toBe("50"));
    await waitFor(() => expect(dataRows()).toHaveLength(45));
  });

  it("shows the last page, with a notice and a button, when the page asked for doesn't exist", async () => {
    mockWidth(1280);
    const calls = recordRequests(makeRows(45));
    live("/transactions?page=9");

    expect(await screen.findByText("Page 9 doesn't exist")).toBeInTheDocument();
    expect(calls.map((c) => c.url.searchParams.get("page"))).toEqual(["9", "3"]);
    expect(dataRows()).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Go to page 3" })).toBeInTheDocument();
  });

  it("makes no request while the URL has a parameter that can't be used", async () => {
    mockWidth(1280);
    const calls = recordRequests();
    live("/transactions?page=0&corridor=XXX");

    expect(await screen.findByText("Some parameters can't be used")).toBeInTheDocument();
    await delay(30);
    expect(calls).toHaveLength(0);
  });

  it("ignores the preview review states: ?state=error still loads the real data", async () => {
    mockWidth(1280);
    live("/transactions?state=error");
    await findTable();
    expect(screen.queryByText(/preview of an error/)).not.toBeInTheDocument();
    expect(dataRows()).toHaveLength(7);
  });

  it("shows an unknown policy, state mode and status as written instead of failing", async () => {
    mockWidth(1280);
    const [first] = fixtureRows();
    server.use(
      transactionsHandler([{ ...first!, policy: "someNewPolicy", stateMode: "futureMode", policyStatus: "gold", status: "weird" }]),
    );
    live("/transactions");

    await findTable();
    expect(screen.getByText("someNewPolicy")).toBeInTheDocument();
    expect(screen.getByText("futureMode")).toBeInTheDocument();
  });
});

describe("History (desktop) loading, empty and error states", () => {
  it("shows a loading state while the request runs", async () => {
    mockWidth(1280);
    server.use(
      http.get("*/api/v1/transactions", async () => {
        await delay(60);
        return HttpResponse.json({ items: [], page: 1, pageSize: 20, total: 0 });
      }),
    );
    live("/transactions");

    expect(screen.getByRole("status")).toHaveTextContent("Loading transactions");
    expect(await screen.findByText("No transactions yet")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the empty state, with a link to route one, when there are no transactions", async () => {
    mockWidth(1280);
    server.use(transactionsHandler([]));
    live("/transactions");

    expect(await screen.findByText("No transactions yet")).toBeInTheDocument();
    // The sidebar has a link of the same name; the empty state's comes later in the page.
    expect(screen.getAllByRole("link", { name: "New transaction" }).at(-1)).toHaveAttribute("href", "/transactions/new");
  });

  it("shows a different empty state when filters match nothing, and Clear filters brings the rows back", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    const { router } = live("/transactions?corridor=USA-%3EIND");

    expect(await screen.findByText("No transactions match these filters")).toBeInTheDocument();
    // The filter panel has a Clear filters button too; the empty state's comes later in the page.
    await user.click(screen.getAllByRole("button", { name: "Clear filters" }).at(-1)!);

    await findTable();
    expect(router.state.location.search).toBe("");
    expect(dataRows()).toHaveLength(7);
  });

  it("shows a server error with its request ID, does not retry by itself, and retries only on request", async () => {
    mockWidth(1280);
    let calls = 0;
    server.use(
      http.get("*/api/v1/transactions", () => {
        calls += 1;
        return HttpResponse.json(
          { error: { code: "INTERNAL_ERROR", message: "BACKEND TEXT", details: {}, requestId: "req-500" } },
          { status: 500 },
        );
      }),
    );
    const user = userEvent.setup();
    live("/transactions");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load transactions");
    expect(alert).toHaveTextContent("The server hit an unexpected error");
    expect(alert).toHaveTextContent("req-500");
    expect(alert).not.toHaveTextContent("BACKEND TEXT");
    await delay(80);
    expect(calls).toBe(1); // nothing was retried automatically
    expect(screen.queryByRole("table", { name: "Transactions" })).not.toBeInTheDocument();

    server.use(transactionsHandler());
    await user.click(screen.getByRole("button", { name: "Try again" }));

    await findTable();
    expect(dataRows()).toHaveLength(7);
    expect(calls).toBe(1);
  });

  it("says when the server could not be reached", async () => {
    mockWidth(1280);
    server.use(http.get("*/api/v1/transactions", () => HttpResponse.error()));
    live("/transactions");
    expect(await screen.findByRole("alert")).toHaveTextContent("The server could not be reached");
  });

  it("lists the field messages of a 422", async () => {
    mockWidth(1280);
    server.use(
      http.get("*/api/v1/transactions", () =>
        HttpResponse.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "Request failed validation.",
              details: { errors: [{ field: "pageSize", message: "must be at most 100" }] },
              requestId: "req-422",
            },
          },
          { status: 422 },
        ),
      ),
    );
    live("/transactions");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The server didn't accept these filters");
    expect(alert).toHaveTextContent("pageSize: must be at most 100");
  });

  it("treats a body that isn't a transaction page as an error, not as an empty list", async () => {
    mockWidth(1280);
    server.use(http.get("*/api/v1/transactions", () => HttpResponse.json({ items: "nope", page: 1 })));
    live("/transactions");

    expect(await screen.findByRole("alert")).toHaveTextContent("response this page couldn't read");
    expect(screen.queryByText("No transactions yet")).not.toBeInTheDocument();
  });

  it("ends the session on a 401 and returns to sign-in with a message", async () => {
    mockWidth(1280);
    sessionStorage.setItem(SESSION_TOKEN_KEY, "mock-analyst");
    server.use(
      http.get("*/api/v1/transactions", () =>
        HttpResponse.json({ error: { code: "UNAUTHENTICATED", message: "Missing or invalid token.", details: {} } }, { status: 401 }),
      ),
    );
    const { router } = renderRoute("/transactions", { auth: "real", data: "live" });

    expect(await screen.findByText("Your session has ended")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
  });
});

describe("preview mode and the narrow layout never call the API", () => {
  it("preview mode shows the preview data, labelled, without any request", async () => {
    mockWidth(1280);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderRoute("/transactions", { data: "preview" });

    expect(await findTable()).toBeInTheDocument();
    expect(screen.getByText(PREVIEW_NOTICE)).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.queryByText("Live data")).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("preview mode keeps the review states", () => {
    mockWidth(1280);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderRoute("/transactions?state=loading", { data: "preview" });
    expect(screen.getByRole("status")).toHaveTextContent("Loading transactions");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the narrow history (below 1024px) is still preview data, and makes no request, even in live mode", async () => {
    mockWidth(800);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    live("/transactions");

    expect(screen.getByText(PREVIEW_NOTICE)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
