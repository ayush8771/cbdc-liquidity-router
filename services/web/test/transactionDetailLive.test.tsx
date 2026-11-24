import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { TransactionRecord } from "../src/api/types";
import { SESSION_TOKEN_KEY } from "../src/auth/tokenStore";
import { PREVIEW_TRANSACTIONS } from "../src/preview/previewData";
import { server } from "./msw/server";
import {
  contractError,
  explanationHandler,
  fixtureExplanations,
  fixtureRecords,
  transactionDetailHandler,
} from "./msw/transactionDetail";
import { renderRoute } from "./renderRoute";

const ROUTED = "56d0d708-62d6-59aa-aa8d-4df8d9b8d37f";
const FAILED = "a121dc5c-b250-5b30-8025-f9e07e76d4e0";
const REJECTED = "ab65a498-5f10-50e0-b3be-4e50d3f5b908";
const PARTIAL = "30bfe62e-365d-533c-8da6-3cefa289f713";
const PPO = "80fa54b8-7314-53de-aed4-fa530374768c";
const UNKNOWN = "00000000-0000-4000-8000-000000000000";

const records = fixtureRecords();
const explanations = fixtureExplanations();
const recordOf = (id: string) => records.get(id) as unknown as TransactionRecord;

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
const live = (id: string, search = "") => renderRoute(`/transactions/${id}${search}`, { data: "live" });
const explainButton = () => screen.queryByRole("button", { name: "Explain" });
const explanationCard = () => screen.getByLabelText("Explanation");
/** The value shown next to a term in a description list. */
const valueOf = (term: string) => screen.getByText(term, { selector: "dt" }).nextElementSibling as HTMLElement;

type Seen = { path: string; authorization: string | null };

/** Counts the requests that reach the detail and explanation handlers. */
function recordRequests() {
  const seen: Seen[] = [];
  const onRequest = (url: URL, authorization: string | null) => seen.push({ path: url.pathname, authorization });
  server.use(
    transactionDetailHandler(undefined, { onRequest }),
    explanationHandler(undefined, undefined, { onRequest }),
  );
  return seen;
}

describe("Transaction Detail (desktop) on the live API: the transaction", () => {
  it("asks for the transaction with the session's bearer token, and nothing else", async () => {
    mockWidth(1280);
    const seen = recordRequests();
    live(ROUTED);

    await screen.findByLabelText("Allocations");
    await delay(30);
    expect(seen).toEqual([{ path: `/api/v1/transactions/${ROUTED}`, authorization: "Bearer mock-analyst" }]);
  });

  it("shows the same panels as the preview: amounts, transaction, decision, warnings and allocations", async () => {
    mockWidth(1280);
    live(ROUTED);

    expect(await screen.findByRole("table", { name: "Allocations by venue" })).toBeInTheDocument();
    const raw = recordOf(ROUTED);
    expect(screen.getByLabelText("Amounts")).toHaveTextContent("$300,000");
    expect(valueOf("Transaction ID")).toHaveTextContent(ROUTED);
    expect(valueOf("Corridor")).toHaveTextContent("GBR");
    expect(valueOf("Status")).toHaveTextContent("Completed");
    expect(valueOf("Policy")).toHaveTextContent("Default (waterfall)");
    expect(valueOf("State")).toHaveTextContent("Historical replay");
    expect(valueOf("Decision ID")).toHaveTextContent(raw.decision!.decisionId);
    expect(valueOf("Feasibility")).toHaveTextContent("Allowed");
    const rows = within(screen.getByRole("table", { name: "Allocations by venue" })).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(raw.decision!.allocations.length);
    expect(within(rows[0]!).getByText(raw.decision!.allocations[0]!.bridgeUid)).toBeInTheDocument();
    expect(screen.getByLabelText("Warnings")).toBeInTheDocument();
  });

  it("is labelled live, with the simulated-data label, and not as preview data", async () => {
    mockWidth(1280);
    live(ROUTED);
    await screen.findByLabelText("Allocations");
    expect(screen.getByText("Live data")).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
    expect(screen.queryByText(PREVIEW_NOTICE)).not.toBeInTheDocument();
  });

  it("asks for the lower-case ID when the address has capitals", async () => {
    mockWidth(1280);
    const seen = recordRequests();
    live(ROUTED.toUpperCase());
    await screen.findByLabelText("Allocations");
    expect(seen[0]!.path).toBe(`/api/v1/transactions/${ROUTED}`);
  });

  it("shows a rejection as a result, with its reason and no allocations", async () => {
    mockWidth(1280);
    live(REJECTED);
    expect(await screen.findByText("Rejected by the feasibility rules")).toBeInTheDocument();
    expect(valueOf("Feasibility")).toHaveTextContent("Not allowed");
    expect(screen.getByText("No allocations")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Allocations by venue" })).not.toBeInTheDocument();
  });

  it("shows a partial completion with its unrouted amount", async () => {
    mockWidth(1280);
    live(PARTIAL);
    expect(await screen.findByText("Partially completed")).toBeInTheDocument();
    expect(valueOf("Policy")).toHaveTextContent("Cheapest feasible");
  });

  it("shows an experimental policy with its label, and the user-supplied label for an explicit state", async () => {
    mockWidth(1280);
    live(PPO);
    await screen.findByLabelText("Allocations");
    expect(valueOf("Policy")).toHaveTextContent(/Experimental/);
  });

  it("shows a failed transaction with its failure, and — for the policy and the state mode", async () => {
    mockWidth(1280);
    live(FAILED);

    expect(await screen.findByText("Routing failed")).toBeInTheDocument();
    const failure = recordOf(FAILED).failure!;
    expect(screen.getByText(failure.code)).toBeInTheDocument();
    expect(screen.getByText(`Message: ${failure.message}`)).toBeInTheDocument();
    expect(valueOf("Status")).toHaveTextContent("Failed");
    expect(valueOf("Policy")).toHaveTextContent("Not available");
    expect(valueOf("Policy")).toHaveTextContent("—");
    expect(valueOf("State")).toHaveTextContent("—");
    expect(valueOf("State")).toHaveTextContent("Simulation date");
    expect(valueOf("Corridor")).toHaveTextContent("—");
    expect(valueOf("Decision ID")).toHaveTextContent("—");
    expect(screen.getByText("No allocations")).toBeInTheDocument();
  });

  it("shows 'not found' for an unknown transaction, with no retry", async () => {
    mockWidth(1280);
    live(UNKNOWN);
    expect(await screen.findByText("Transaction not found")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // The page's own back link, and the not-found state's button.
    expect(screen.getAllByRole("link", { name: "Back to history" })).toHaveLength(2);
  });

  it("makes no request for an address that isn't a transaction ID", async () => {
    mockWidth(1280);
    const seen = recordRequests();
    live("not-an-id");

    expect(await screen.findByText("No transaction to show")).toBeInTheDocument();
    await delay(30);
    expect(seen).toHaveLength(0);
  });

  it("shows a loading state while the request runs", async () => {
    mockWidth(1280);
    server.use(
      http.get("*/api/v1/transactions/:id", async () => {
        await delay(60);
        return HttpResponse.json(records.get(ROUTED)!);
      }),
    );
    live(ROUTED);

    expect(screen.getByRole("status")).toHaveTextContent("Loading the transaction");
    await screen.findByLabelText("Allocations");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows a server error with its request ID, does not retry by itself, and retries on request", async () => {
    mockWidth(1280);
    let calls = 0;
    server.use(
      http.get("*/api/v1/transactions/:id", () => {
        calls += 1;
        return HttpResponse.json(
          { error: { code: "INTERNAL_ERROR", message: "BACKEND TEXT", details: {}, requestId: "req-500" } },
          { status: 500 },
        );
      }),
    );
    const user = userEvent.setup();
    live(ROUTED);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load this transaction");
    expect(alert).toHaveTextContent("The server hit an unexpected error");
    expect(alert).toHaveTextContent("req-500");
    expect(alert).not.toHaveTextContent("BACKEND TEXT");
    await delay(80);
    expect(calls).toBe(1);

    server.use(transactionDetailHandler());
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Allocations")).toBeInTheDocument();
    expect(calls).toBe(1);
  });

  it("says when the server could not be reached", async () => {
    mockWidth(1280);
    server.use(http.get("*/api/v1/transactions/:id", () => HttpResponse.error()));
    live(ROUTED);
    expect(await screen.findByRole("alert")).toHaveTextContent("The server could not be reached");
  });

  it("treats a body that isn't a transaction as an error, not as 'not found'", async () => {
    mockWidth(1280);
    server.use(http.get("*/api/v1/transactions/:id", () => HttpResponse.json({ hello: "world" })));
    live(ROUTED);
    expect(await screen.findByRole("alert")).toHaveTextContent("response this page couldn't read");
    expect(screen.queryByText("Transaction not found")).not.toBeInTheDocument();
  });

  it("refuses another transaction's record under this address", async () => {
    mockWidth(1280);
    server.use(http.get("*/api/v1/transactions/:id", () => HttpResponse.json(records.get(PARTIAL)!)));
    live(ROUTED);
    expect(await screen.findByRole("alert")).toHaveTextContent("response this page couldn't read");
  });

  it("ends the session on a 401 and returns to sign-in with a message", async () => {
    mockWidth(1280);
    sessionStorage.setItem(SESSION_TOKEN_KEY, "mock-analyst");
    server.use(http.get("*/api/v1/transactions/:id", () => HttpResponse.json(contractError("404_not_found"), { status: 401 })));
    const { router } = renderRoute(`/transactions/${ROUTED}`, { auth: "real", data: "live" });

    expect(await screen.findByText("Your session has ended")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
  });

  it("ignores the preview review states: ?state=error still loads the real transaction", async () => {
    mockWidth(1280);
    live(ROUTED, "?state=error");
    await screen.findByLabelText("Allocations");
    expect(screen.queryByText(/preview of an error/)).not.toBeInTheDocument();
  });
});

describe("Transaction Detail (desktop): the Explanation card", () => {
  it("is under the allocations and only offers Explain: nothing is requested until the click", async () => {
    mockWidth(1280);
    const seen = recordRequests();
    live(ROUTED);

    await screen.findByLabelText("Allocations");
    const card = explanationCard();
    expect(within(card).getByRole("heading", { name: "Explanation" })).toBeInTheDocument();
    expect(explainButton()).toBeInTheDocument();
    expect(screen.getByLabelText("Allocations").compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await delay(40);
    expect(seen.filter((s) => s.path.endsWith("/explanation"))).toHaveLength(0);
  });

  it("requests the explanation on Explain, with the bearer token, and shows it", async () => {
    mockWidth(1280);
    const seen = recordRequests();
    const user = userEvent.setup();
    live(ROUTED);
    await screen.findByLabelText("Allocations");

    await user.click(screen.getByRole("button", { name: "Explain" }));

    const raw = explanations.get(ROUTED) as unknown as { summary: string; venueExplanations: { bridgeUid: string; text: string }[]; limitations: string[] };
    expect(await within(explanationCard()).findByText(raw.summary)).toBeInTheDocument();
    expect(seen.filter((s) => s.path.endsWith("/explanation"))).toEqual([
      { path: `/api/v1/transactions/${ROUTED}/explanation`, authorization: "Bearer mock-analyst" },
    ]);
    expect(explainButton()).not.toBeInTheDocument();

    const venues = within(explanationCard()).getByRole("table", { name: "Explanation by venue" });
    expect(within(venues).getAllByRole("row").slice(1)).toHaveLength(raw.venueExplanations.length);
    expect(within(venues).getByText(raw.venueExplanations[0]!.text)).toBeInTheDocument();
    expect(within(explanationCard()).getByText(raw.limitations[0]!)).toBeInTheDocument();
    expect(within(explanationCard()).getByRole("table", { name: "Facts applied" })).toBeInTheDocument();
    expect(within(explanationCard()).getByText("Allowed")).toBeInTheDocument();
  });

  it("sends one request even if Explain is clicked twice, and does not ask again on its own", async () => {
    mockWidth(1280);
    const seen = recordRequests();
    const user = userEvent.setup();
    live(ROUTED);
    await screen.findByLabelText("Allocations");

    await user.dblClick(screen.getByRole("button", { name: "Explain" }));
    await within(explanationCard()).findByRole("table", { name: "Explanation by venue" });
    await delay(60);

    expect(seen.filter((s) => s.path.endsWith("/explanation"))).toHaveLength(1);
  });

  it("shows the policy notes of a PPO decision", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    live(PPO);
    await screen.findByLabelText("Allocations");

    await user.click(screen.getByRole("button", { name: "Explain" }));

    const notes = (explanations.get(PPO) as unknown as { policyNotes: string[] }).policyNotes;
    expect(await within(explanationCard()).findByText("Policy notes")).toBeInTheDocument();
    expect(within(explanationCard()).getByText(notes[0]!)).toBeInTheDocument();
  });

  it("shows a rejection's explanation, with every venue as not used", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    live(REJECTED);
    await screen.findByText("Rejected by the feasibility rules");

    await user.click(screen.getByRole("button", { name: "Explain" }));

    const venues = await within(explanationCard()).findByRole("table", { name: "Explanation by venue" });
    expect(within(explanationCard()).getByText("Not allowed")).toBeInTheDocument();
    for (const row of within(venues).getAllByRole("row").slice(1)) expect(within(row).getByText("Not used")).toBeInTheDocument();
  });

  it("has nothing to explain for a failed transaction: no button, and no request", async () => {
    mockWidth(1280);
    const seen = recordRequests();
    live(FAILED);

    await screen.findByText("Routing failed");
    expect(within(explanationCard()).getByText(/no decision, so there is nothing to explain/)).toBeInTheDocument();
    expect(explainButton()).not.toBeInTheDocument();
    await delay(30);
    expect(seen.filter((s) => s.path.endsWith("/explanation"))).toHaveLength(0);
  });

  it("shows its own loading state while the transaction above stays as it is", async () => {
    mockWidth(1280);
    server.use(
      http.get("*/api/v1/transactions/:id/explanation", async () => {
        await delay(80);
        return HttpResponse.json(explanations.get(ROUTED)!);
      }),
    );
    const user = userEvent.setup();
    live(ROUTED);
    await screen.findByLabelText("Allocations");

    await user.click(screen.getByRole("button", { name: "Explain" }));

    expect(within(explanationCard()).getByRole("status")).toHaveTextContent("Loading the explanation");
    expect(screen.getByLabelText("Allocations")).toBeInTheDocument();
    expect(valueOf("Transaction ID")).toHaveTextContent(ROUTED);
    await within(explanationCard()).findByRole("table", { name: "Explanation by venue" });
  });

  it("shows an engine that is starting up inside the card, keeps the transaction, and retries only on request", async () => {
    mockWidth(1280);
    let calls = 0;
    server.use(
      http.get("*/api/v1/transactions/:id/explanation", () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json(
              { error: { code: "INFERENCE_UNAVAILABLE", message: "BACKEND TEXT", details: { cause: "NOT_READY" }, requestId: "req-503" } },
              { status: 503, headers: { "Retry-After": "5" } },
            )
          : HttpResponse.json(explanations.get(ROUTED)!);
      }),
    );
    const user = userEvent.setup();
    live(ROUTED);
    await screen.findByLabelText("Allocations");
    await user.click(screen.getByRole("button", { name: "Explain" }));

    const alert = await within(explanationCard()).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the explanation");
    expect(alert).toHaveTextContent("starting up");
    expect(alert).toHaveTextContent("req-503");
    expect(alert).not.toHaveTextContent("BACKEND TEXT");
    // The transaction is untouched, and there is no page-level error.
    expect(screen.getByLabelText("Allocations")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load this transaction")).not.toBeInTheDocument();
    await delay(80);
    expect(calls).toBe(1);

    await user.click(within(explanationCard()).getByRole("button", { name: "Try again" }));
    expect(await within(explanationCard()).findByRole("table", { name: "Explanation by venue" })).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it("tells a busy engine's Retry-After seconds, and offers a retry", async () => {
    mockWidth(1280);
    server.use(
      http.get("*/api/v1/transactions/:id/explanation", () =>
        HttpResponse.json(contractError("503_engine_busy"), { status: 503, headers: { "Retry-After": "7" } }),
      ),
    );
    const user = userEvent.setup();
    live(ROUTED);
    await screen.findByLabelText("Allocations");
    await user.click(screen.getByRole("button", { name: "Explain" }));

    const alert = await within(explanationCard()).findByRole("alert");
    expect(alert).toHaveTextContent("busy");
    expect(alert).toHaveTextContent("about 7 seconds");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it.each([
    ["409_decision_mismatch", "DECISION_MISMATCH", /can't be explained again/],
    ["409_transaction_failed", "TRANSACTION_FAILED", /no decision to explain/],
  ])("explains a permanent %s without a retry button", async (file, _code, message) => {
    mockWidth(1280);
    server.use(http.get("*/api/v1/transactions/:id/explanation", () => HttpResponse.json(contractError(file), { status: 409 })));
    const user = userEvent.setup();
    live(ROUTED);
    await screen.findByLabelText("Allocations");
    await user.click(screen.getByRole("button", { name: "Explain" }));

    const alert = await within(explanationCard()).findByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(within(alert).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Allocations")).toBeInTheDocument();
  });

  it("explains a disabled PPO policy without a retry button", async () => {
    mockWidth(1280);
    server.use(
      http.get("*/api/v1/transactions/:id/explanation", () =>
        HttpResponse.json({ error: { code: "POLICY_DISABLED", message: "x", details: {}, requestId: "r" } }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    live(PPO);
    await screen.findByLabelText("Allocations");
    await user.click(screen.getByRole("button", { name: "Explain" }));

    const alert = await within(explanationCard()).findByRole("alert");
    expect(alert).toHaveTextContent("currently disabled");
    expect(within(alert).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("refuses an explanation for a different decision, and shows none of it", async () => {
    mockWidth(1280);
    const other = {
      ...(explanations.get(ROUTED) as unknown as Record<string, unknown> & { summary: string }),
      decisionId: recordOf(PPO).decision!.decisionId,
    };
    server.use(http.get("*/api/v1/transactions/:id/explanation", () => HttpResponse.json(other)));
    const user = userEvent.setup();
    live(ROUTED);
    await screen.findByLabelText("Allocations");
    await user.click(screen.getByRole("button", { name: "Explain" }));

    const alert = await within(explanationCard()).findByRole("alert");
    expect(alert).toHaveTextContent("not for this decision");
    expect(within(explanationCard()).queryByText(other.summary)).not.toBeInTheDocument();
    expect(within(explanationCard()).queryByRole("table", { name: "Explanation by venue" })).not.toBeInTheDocument();
  });

  it("refuses an explanation for a different transaction", async () => {
    mockWidth(1280);
    server.use(http.get("*/api/v1/transactions/:id/explanation", () => HttpResponse.json(explanations.get(PPO)!)));
    const user = userEvent.setup();
    live(ROUTED);
    await screen.findByLabelText("Allocations");
    await user.click(screen.getByRole("button", { name: "Explain" }));

    expect(await within(explanationCard()).findByRole("alert")).toHaveTextContent("not for this decision");
  });

  it("treats a body that isn't an explanation as an error", async () => {
    mockWidth(1280);
    server.use(http.get("*/api/v1/transactions/:id/explanation", () => HttpResponse.json({ summary: "only" })));
    const user = userEvent.setup();
    live(ROUTED);
    await screen.findByLabelText("Allocations");
    await user.click(screen.getByRole("button", { name: "Explain" }));

    expect(await within(explanationCard()).findByRole("alert")).toHaveTextContent("response this page couldn't read");
  });

  it("ends the session on a 401 from the explanation", async () => {
    mockWidth(1280);
    sessionStorage.setItem(SESSION_TOKEN_KEY, "mock-analyst");
    server.use(
      http.get("*/api/v1/transactions/:id/explanation", () =>
        HttpResponse.json({ error: { code: "UNAUTHENTICATED", message: "x", details: {} } }, { status: 401 }),
      ),
    );
    const user = userEvent.setup();
    const { router } = renderRoute(`/transactions/${ROUTED}`, { auth: "real", data: "live" });
    await screen.findByLabelText("Allocations");

    await user.click(screen.getByRole("button", { name: "Explain" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"));
    expect(await screen.findByText("Your session has ended")).toBeInTheDocument();
  });

  it("starts unrequested for another transaction", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    const { router } = live(ROUTED);
    await screen.findByLabelText("Allocations");
    await user.click(screen.getByRole("button", { name: "Explain" }));
    await within(explanationCard()).findByRole("table", { name: "Explanation by venue" });

    await router.navigate(`/transactions/${PPO}`);

    await waitFor(() => expect(valueOf("Transaction ID")).toHaveTextContent(PPO));
    expect(await screen.findByRole("button", { name: "Explain" })).toBeInTheDocument();
  });
});

describe("preview mode and the narrow layout", () => {
  it("preview mode shows the preview transaction, labelled, with no Explanation card and no request", async () => {
    mockWidth(1280);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderRoute(`/transactions/${PREVIEW_TRANSACTIONS[0]!.id}`, { data: "preview" });

    expect(await screen.findByLabelText("Allocations")).toBeInTheDocument();
    expect(screen.getByText(PREVIEW_NOTICE)).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.queryByText("Live data")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Explanation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Explain" })).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("preview mode keeps its review states and an unknown ID's not-found page", async () => {
    mockWidth(1280);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderRoute(`/transactions/${UNKNOWN}`, { data: "preview" });
    expect(await screen.findByText("Transaction not found")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("below 1024px the page is still the unchanged placeholder, and makes no request, even in live mode", async () => {
    mockWidth(800);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    live(ROUTED);

    expect(screen.getByText("This screen isn't connected yet")).toBeInTheDocument();
    expect(screen.queryByLabelText("Explanation")).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
