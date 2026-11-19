import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SESSION_TOKEN_KEY } from "../src/auth/tokenStore";
import { LIVE_RESULT_LABEL, PREVIEW_RESULT_LABEL } from "../src/features/newTransaction/ResultPanel";
import { fixtureNetwork, networkHandler } from "./msw/network";
import { fixtureMeta, fixtureMetaPpoEnabled, metaHandler, scenariosHandler } from "./msw/reference";
import { server } from "./msw/server";
import { errorFixture, submitHandler, type SubmitRequestInfo } from "./msw/submit";
import { renderRoute, type RenderOptions } from "./renderRoute";

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
  vi.useRealTimers();
  server.resetHandlers();
  sessionStorage.clear();
  window.matchMedia = original;
  vi.restoreAllMocks();
});
afterAll(() => server.close());

const live = (options: RenderOptions = {}, search = "") =>
  renderRoute(`/transactions/new${search}`, { data: "live", ...options });
const findForm = () => screen.findByRole("region", { name: "New transaction form" });
const corridorSelect = () => screen.getByRole("combobox", { name: "Corridor" });
const policySelect = () => screen.getByRole("combobox", { name: "Policy" });
const amountInput = () => screen.getByRole("textbox", { name: "Amount (USD)" });
const dateInput = () => screen.getByLabelText(/^Date/);
const submitButton = () => screen.getByRole("button", { name: "Route transaction" });
const alertsText = () => screen.getAllByRole("alert").map((a) => a.textContent ?? "").join(" | ");

type User = ReturnType<typeof userEvent.setup>;

async function fillReplay(user: User, amount = "100000", corridor = "GBR->PHL") {
  await user.selectOptions(corridorSelect(), corridor);
  await user.type(amountInput(), amount);
  fireEvent.change(dateInput(), { target: { value: "2024-06-14" } });
}

/** Records every request to the three reference endpoints and to POST /transactions. */
function recordRequests() {
  const reference: string[] = [];
  const submits: SubmitRequestInfo[] = [];
  const onRequest = (url: URL) => reference.push(url.pathname);
  server.use(
    networkHandler(undefined, { onRequest }),
    scenariosHandler(undefined, { onRequest }),
    metaHandler(undefined, { onRequest }),
    submitHandler({ onRequest: (info) => submits.push(info) }),
  );
  return { reference, submits };
}

const serverError = (code: string, status: number, message = "BACKEND TEXT", details: unknown = {}, requestId = "req-1") =>
  HttpResponse.json({ error: { code, message, details, requestId } }, { status });

describe("New transaction (desktop) on the live API: the form's reference data", () => {
  it("reads corridors, scenarios and policies once each, with the session's bearer token, and no submission", async () => {
    mockWidth(1280);
    const { reference, submits } = recordRequests();
    live();

    await findForm();
    await delay(30);
    expect(reference.sort()).toEqual(["/api/v1/meta", "/api/v1/network", "/api/v1/scenarios"]);
    expect(submits).toHaveLength(0);
  });

  it("builds the form from the API: the three corridors, the policies and the scenarios in the API's order", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    live();

    await findForm();
    expect(within(corridorSelect()).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Choose a corridor",
      "USA → IND",
      "GBR → PHL",
      "ARE → MEX",
    ]);
    expect(policySelect()).toHaveValue("waterfall");
    expect(screen.getByRole("option", { name: "Cheapest feasible" })).toBeEnabled();
    expect(screen.getByRole("option", { name: "PPO (projected) — unavailable" })).toBeDisabled();
    expect(screen.getByText(/Unavailable: no approved checkpoint configured/)).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "State mode" }), "scenario");
    expect(within(screen.getByRole("combobox", { name: "Scenario" })).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Choose a scenario",
      "baseline",
      "cheapest_venue_outage",
      "combined_stress",
      "congestion_x2",
      "liquidity_minus30",
      "liquidity_minus50",
    ]);
  });

  it("uses the API's single-transfer limit in the form's helper text", async () => {
    mockWidth(1280);
    const network = fixtureNetwork();
    network.maxSingleTransferUsd = 250000;
    server.use(networkHandler(network));
    live();
    await findForm();
    expect(screen.getByText(/The single-transfer limit is \$250,000/)).toBeInTheDocument();
  });

  it("is labelled live, with no preview notice and no preview failure mode", async () => {
    mockWidth(1280);
    live({}, "?mock=busy");
    await findForm();
    expect(screen.getByText("Live data")).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
    expect(screen.queryByText(/Preview data — illustrative/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Preview failure mode/)).not.toBeInTheDocument();
    expect(screen.getByText("No result yet")).toBeInTheDocument();
    expect(screen.getByText("Submit the form to route a transaction.")).toBeInTheDocument();
  });

  it("shows a loading state instead of the form until all three have loaded", async () => {
    mockWidth(1280);
    server.use(
      http.get("*/api/v1/scenarios", async () => {
        await delay(80);
        return HttpResponse.json(fixtureNetwork().corridors ? (await import("./msw/reference")).fixtureScenarios() : {});
      }),
    );
    live();

    expect(screen.getByRole("region", { name: "Form options" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "New transaction form" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
    await findForm();
    expect(screen.queryByRole("region", { name: "Form options" })).not.toBeInTheDocument();
  });

  it("a failed source shows its own error, the others are not shown again, and Try again asks for that source only", async () => {
    mockWidth(1280);
    const calls = { network: 0, scenarios: 0, meta: 0 };
    server.use(
      http.get("*/api/v1/network", () => {
        calls.network += 1;
        return HttpResponse.json(fixtureNetwork());
      }),
      http.get("*/api/v1/meta", () => {
        calls.meta += 1;
        return HttpResponse.json(fixtureMeta());
      }),
      http.get("*/api/v1/scenarios", () => {
        calls.scenarios += 1;
        return calls.scenarios === 1
          ? serverError("INTERNAL_ERROR", 500, "BACKEND TEXT", {}, "req-scenarios")
          : HttpResponse.json({ scenarios: [{ scenarioId: "baseline", description: "Unmodified." }] });
      }),
    );
    const user = userEvent.setup();
    live();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the scenarios");
    expect(alert).toHaveTextContent("The server hit an unexpected error");
    expect(alert).toHaveTextContent("req-scenarios");
    expect(alert).not.toHaveTextContent("BACKEND TEXT");
    expect(screen.getAllByRole("alert")).toHaveLength(1); // the corridors and policies are not reported
    await delay(60);
    expect(calls).toEqual({ network: 1, scenarios: 1, meta: 1 }); // nothing retried by itself

    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    await findForm();
    expect(calls).toEqual({ network: 1, scenarios: 2, meta: 1 });
  });

  it("several failed sources each show their own error with their own retry", async () => {
    mockWidth(1280);
    server.use(
      http.get("*/api/v1/network", () => HttpResponse.error()),
      http.get("*/api/v1/meta", () =>
        serverError("INFERENCE_UNAVAILABLE", 503, "BACKEND TEXT", { cause: "NOT_READY" }, "req-meta"),
      ),
    );
    live();

    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    const text = alertsText();
    expect(text).toContain("Couldn't load the corridors");
    expect(text).toContain("The server could not be reached");
    expect(text).toContain("Couldn't load the policies");
    expect(text).toContain("starting up");
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(2);
    expect(screen.queryByRole("region", { name: "New transaction form" })).not.toBeInTheDocument();
  });

  it("treats a source's unreadable body as an error, not as an empty list", async () => {
    mockWidth(1280);
    server.use(metaHandler({ policies: "no" }), scenariosHandler({ scenarios: [{ scenarioId: "a" }] }));
    live();

    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    expect(alertsText()).toMatch(/policies in a form this page couldn't read/);
    expect(alertsText()).toMatch(/scenarios in a form this page couldn't read/);
    expect(screen.queryByRole("region", { name: "New transaction form" })).not.toBeInTheDocument();
  });

  it("ends the session on a 401 from a reference request", async () => {
    mockWidth(1280);
    sessionStorage.setItem(SESSION_TOKEN_KEY, "mock-analyst");
    server.use(http.get("*/api/v1/network", () => serverError("UNAUTHENTICATED", 401, "x")));
    const { router } = renderRoute("/transactions/new", { auth: "real", data: "live" });

    expect(await screen.findByText("Your session has ended")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"));
  });
});

describe("New transaction (desktop): roles and the experimental policy", () => {
  it("an analyst can pick PPO when the engine enables it, and it is sent as ppoProjected", async () => {
    mockWidth(1280);
    server.use(metaHandler(fixtureMetaPpoEnabled()));
    const { submits } = recordRequests();
    server.use(metaHandler(fixtureMetaPpoEnabled()));
    const user = userEvent.setup();
    live({ role: "analyst" });
    await findForm();

    expect(screen.getByRole("option", { name: "PPO (projected)" })).toBeEnabled();
    await fillReplay(user);
    await user.selectOptions(policySelect(), "ppoProjected");
    await user.click(submitButton());

    expect(await screen.findByText(LIVE_RESULT_LABEL)).toBeInTheDocument();
    expect(submits).toHaveLength(1);
    expect(submits[0]!.body).toMatchObject({ policy: "ppoProjected" });
    expect(submits[0]!.authorization).toBe("Bearer mock-analyst");
    expect(screen.getByRole("link", { name: "View transaction" })).toHaveAttribute(
      "href",
      "/transactions/80fa54b8-7314-53de-aed4-fa530374768c",
    );
  });

  it("a viewer is not offered PPO even when the engine enables it, with the reason, and never sends it", async () => {
    mockWidth(1280);
    const { submits } = recordRequests();
    server.use(metaHandler(fixtureMetaPpoEnabled()));
    const user = userEvent.setup();
    live({ role: "viewer" });
    await findForm();

    expect(screen.getByRole("option", { name: "PPO (projected) — unavailable" })).toBeDisabled();
    expect(screen.getByText(/Unavailable: only analysts can use the experimental policy/)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Cheapest feasible" })).toBeEnabled();

    await fillReplay(user);
    await user.selectOptions(policySelect(), "ppoProjected"); // a disabled option cannot be chosen
    expect(policySelect()).toHaveValue("waterfall");
    await user.click(submitButton());

    expect(await screen.findByText(LIVE_RESULT_LABEL)).toBeInTheDocument();
    expect(submits).toHaveLength(1);
    expect(submits[0]!.body).toMatchObject({ policy: "waterfall" });
    expect(submits[0]!.authorization).toBe("Bearer mock-viewer");
  });

  it("a viewer keeps the engine's own reason when the engine has disabled PPO anyway", async () => {
    mockWidth(1280);
    live({ role: "viewer" });
    await findForm();
    expect(screen.getByText(/Unavailable: no approved checkpoint configured/)).toBeInTheDocument();
  });

  it("explicit mode with PPO is left to the backend: the request is sent, and its 422 is shown", async () => {
    mockWidth(1280);
    server.use(
      metaHandler(fixtureMetaPpoEnabled()),
      http.post("*/api/v1/transactions", () =>
        serverError("POLICY_UNAVAILABLE_FOR_STATE", 422, "Needs history on every venue.", { field: "policy" }, "req-ppo"),
      ),
    );
    const user = userEvent.setup();
    live({ role: "analyst" });
    await findForm();
    await user.selectOptions(corridorSelect(), "GBR->PHL");
    await user.type(amountInput(), "100000");
    await user.selectOptions(screen.getByRole("combobox", { name: "State mode" }), "explicit");
    fireEvent.change(screen.getByLabelText(/^Reference date/), { target: { value: "2024-06-14" } });
    for (const uid of ["GBR->PHL#0", "GBR->PHL#1", "GBR->PHL#2"]) {
      await user.type(screen.getByRole("textbox", { name: `${uid} liquidity (USD)` }), "100000");
      await user.type(screen.getByRole("textbox", { name: `${uid} congestion` }), "0.2");
    }
    await user.selectOptions(policySelect(), "ppoProjected");
    await user.click(submitButton());

    // The backend's message, on the policy field it named and in the form-level message.
    expect((await screen.findAllByText("Needs history on every venue.")).length).toBeGreaterThan(0);
    expect(screen.getByText("Not saved")).toBeInTheDocument();
  });
});

describe("New transaction (desktop): submitting", () => {
  it("sends exactly the form's payload, once, and shows the completed result with a link to the saved transaction", async () => {
    mockWidth(1280);
    const { submits } = recordRequests();
    const user = userEvent.setup();
    live();
    await findForm();
    await fillReplay(user);
    await user.click(submitButton());

    expect(await screen.findByText(LIVE_RESULT_LABEL)).toBeInTheDocument();
    expect(submits).toHaveLength(1);
    expect(submits[0]!.url.pathname).toBe("/api/v1/transactions");
    expect(submits[0]!.authorization).toBe("Bearer mock-analyst");
    expect(submits[0]!.body).toEqual({
      senderCountry: "GBR",
      receiverCountry: "PHL",
      amountUsd: 100000,
      state: { mode: "historicalReplay", date: "2024-06-14" },
      policy: "waterfall",
    });
    expect(screen.getByText("Routed and fully executed")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View transaction" })).toHaveAttribute(
      "href",
      "/transactions/56d0d708-62d6-59aa-aa8d-4df8d9b8d37f",
    );
    expect(screen.queryByText(PREVIEW_RESULT_LABEL)).not.toBeInTheDocument();
    expect(screen.queryByText(/preview transaction/)).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Allocations by venue" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("sends the client reference when one was typed", async () => {
    mockWidth(1280);
    const { submits } = recordRequests();
    const user = userEvent.setup();
    live();
    await findForm();
    await fillReplay(user);
    await user.type(screen.getByRole("textbox", { name: "Client reference" }), "demo-001");
    await user.click(submitButton());

    await screen.findByText(LIVE_RESULT_LABEL);
    expect(submits[0]!.body).toMatchObject({ clientReference: "demo-001" });
  });

  it("sends a scenario state with its scenario ID", async () => {
    mockWidth(1280);
    const { submits } = recordRequests();
    const user = userEvent.setup();
    live();
    await findForm();
    await user.selectOptions(corridorSelect(), "GBR->PHL");
    await user.type(amountInput(), "100000");
    await user.selectOptions(screen.getByRole("combobox", { name: "State mode" }), "scenario");
    fireEvent.change(dateInput(), { target: { value: "2024-06-14" } });
    await user.selectOptions(screen.getByRole("combobox", { name: "Scenario" }), "cheapest_venue_outage");
    await user.click(submitButton());

    await screen.findByText(LIVE_RESULT_LABEL);
    expect(submits[0]!.body).toMatchObject({
      state: { mode: "scenario", date: "2024-06-14", scenarioId: "cheapest_venue_outage" },
    });
  });

  it("sends an explicit state as numbers, and shows its partial result", async () => {
    mockWidth(1280);
    const { submits } = recordRequests();
    const user = userEvent.setup();
    live();
    await findForm();
    await user.selectOptions(corridorSelect(), "GBR->PHL");
    await user.type(amountInput(), "400000");
    await user.selectOptions(screen.getByRole("combobox", { name: "State mode" }), "explicit");
    fireEvent.change(screen.getByLabelText(/^Reference date/), { target: { value: "2024-06-14" } });
    for (const uid of ["GBR->PHL#0", "GBR->PHL#1", "GBR->PHL#2"]) {
      await user.type(screen.getByRole("textbox", { name: `${uid} liquidity (USD)` }), "100000");
      await user.type(screen.getByRole("textbox", { name: `${uid} congestion` }), "0.2");
    }
    await user.click(submitButton());

    expect(await screen.findByText("Partially completed")).toBeInTheDocument();
    expect(submits[0]!.body).toMatchObject({
      state: {
        mode: "explicit",
        referenceDate: "2024-06-14",
        venues: [
          { bridgeUid: "GBR->PHL#0", liquidityUsd: 100000, congestion: 0.2 },
          { bridgeUid: "GBR->PHL#1", liquidityUsd: 100000, congestion: 0.2 },
          { bridgeUid: "GBR->PHL#2", liquidityUsd: 100000, congestion: 0.2 },
        ],
      },
    });
  });

  it("shows a partial completion as a result, not an error", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    live();
    await findForm();
    await fillReplay(user);
    await user.selectOptions(policySelect(), "cheapestFeasible");
    await user.click(submitButton());

    expect(await screen.findByText("Partially completed")).toBeInTheDocument();
    expect(screen.getByText(/This is a routing result, not an error/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a rejection by the feasibility rules as a result, with no allocations", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    live();
    await findForm();
    await fillReplay(user, "600000");
    await user.click(submitButton());

    expect(await screen.findByText("Rejected by the feasibility rules")).toBeInTheDocument();
    expect(screen.getByText(/Nothing was allocated, because the transaction wasn't allowed/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View transaction" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the routing state while the request runs", async () => {
    mockWidth(1280);
    server.use(
      http.post("*/api/v1/transactions", async () => {
        await delay(80);
        return HttpResponse.json((await import("./msw/submit")).errorFixture("500_internal_error"), { status: 500 });
      }),
    );
    const user = userEvent.setup();
    live();
    await findForm();
    await fillReplay(user);
    await user.click(submitButton());

    expect(screen.getByRole("button", { name: "Routing…" })).toBeDisabled();
    expect(screen.getByText("Routing the transaction")).toBeInTheDocument();
    await screen.findByText("Not saved");
  });

  it("keeps the existing validation: nothing is sent while the form is incomplete", async () => {
    mockWidth(1280);
    const { submits } = recordRequests();
    const user = userEvent.setup();
    live();
    await findForm();
    await user.click(submitButton());

    expect(screen.getByText("Choose a corridor.")).toBeInTheDocument();
    expect(screen.getByText("Enter an amount.")).toBeInTheDocument();
    await delay(30);
    expect(submits).toHaveLength(0);
  });
});

describe("New transaction (desktop): double submission", () => {
  it("sends one request however many times Submit is activated while it runs", async () => {
    mockWidth(1280);
    let posts = 0;
    server.use(
      http.post("*/api/v1/transactions", async () => {
        posts += 1;
        await delay(100);
        return HttpResponse.json((await import("./msw/submit")).errorFixture("500_internal_error"), { status: 500 });
      }),
    );
    const user = userEvent.setup();
    live();
    await findForm();
    await fillReplay(user);

    const button = submitButton();
    await user.dblClick(button);
    fireEvent.submit(screen.getByRole("region", { name: "New transaction form" }).querySelector("form")!);
    fireEvent.submit(screen.getByRole("region", { name: "New transaction form" }).querySelector("form")!);

    await screen.findByText("Not saved");
    expect(posts).toBe(1);
  });

  it("never retries by itself after an error", async () => {
    mockWidth(1280);
    let posts = 0;
    server.use(
      http.post("*/api/v1/transactions", () => {
        posts += 1;
        return HttpResponse.json(errorFixture("503_engine_busy"), { status: 503, headers: { "Retry-After": "1" } });
      }),
    );
    const user = userEvent.setup();
    live();
    await findForm();
    await fillReplay(user);
    await user.click(submitButton());

    await screen.findByText("Routing failed — saved without a decision");
    await delay(120);
    expect(posts).toBe(1);
  });

  it("allows a new submission once the first has finished", async () => {
    mockWidth(1280);
    const { submits } = recordRequests();
    const user = userEvent.setup();
    live();
    await findForm();
    await fillReplay(user);
    await user.click(submitButton());
    await screen.findByText(LIVE_RESULT_LABEL);

    await user.click(submitButton());
    await waitFor(() => expect(submits).toHaveLength(2));
  });
});

describe("New transaction (desktop): definite errors", () => {
  it.each([
    ["503_engine_busy", 503, "Routing failed — saved without a decision", "a121dc5c-b250-5b30-8025-f9e07e76d4e0"],
    ["504_engine_timeout", 504, "Routing failed — saved without a decision", "c04b9f2b-7bea-5e19-8353-799bbeee0abc"],
    ["502_inference_error", 502, "Routing failed — saved without a decision", "1b12ba0b-f730-5cfe-9443-024e91ca3331"],
  ])("%s is saved as failed: the backend's message and reference are shown, with a link to the failed transaction", async (file, status, title, id) => {
    mockWidth(1280);
    const body = errorFixture(file) as { error: { code: string; message: string; requestId: string } };
    server.use(http.post("*/api/v1/transactions", () => HttpResponse.json(body, { status })));
    const user = userEvent.setup();
    live();
    await findForm();
    await fillReplay(user);
    await user.click(submitButton());

    expect(await screen.findByText(title)).toBeInTheDocument();
    const alert = screen.getAllByRole("alert").find((a) => a.textContent?.includes(body.error.code))!;
    expect(alert).toHaveTextContent(body.error.message);
    expect(alert).toHaveTextContent(body.error.requestId);
    expect(screen.getByText(id)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View the failed transaction" })).toHaveAttribute("href", `/transactions/${id}`);
    expect(screen.queryByText(/Shown as text only/)).not.toBeInTheDocument();
    expect(amountInput()).toHaveValue("100000"); // what was typed is kept
  });

  it("an engine that was still starting up is saved as failed, and says so", async () => {
    mockWidth(1280);
    server.use(
      http.post("*/api/v1/transactions", () =>
        HttpResponse.json(errorFixture("503_inference_not_ready"), { status: 503, headers: { "Retry-After": "5" } }),
      ),
    );
    const user = userEvent.setup();
    live();
    await findForm();
    await fillReplay(user);
    await user.click(submitButton());

    expect(await screen.findByText("Routing engine starting up — saved without a decision")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View the failed transaction" })).toHaveAttribute(
      "href",
      "/transactions/94f3896b-b9f1-5efa-90e7-2effa29d865b",
    );
    expect(screen.getByText(/submit again once the engine has started/)).toBeInTheDocument();
  });

  it("a 422 maps to the form's fields, with the backend's message, and nothing is saved", async () => {
    mockWidth(1280);
    server.use(
      http.post("*/api/v1/transactions", () =>
        serverError("VALIDATION_ERROR", 422, "Request failed validation.", {
          errors: [{ field: "amountUsd", message: "Must be a number." }, { message: "Something about the whole request." }],
        }),
      ),
    );
    const user = userEvent.setup();
    live();
    await findForm();
    await fillReplay(user);
    await user.click(submitButton());

    expect(await screen.findByText("Must be a number.")).toBeInTheDocument();
    expect(amountInput()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Something about the whole request.")).toBeInTheDocument();
    expect(screen.getByText("The request failed validation")).toBeInTheDocument();
    expect(screen.getByText("Not saved")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View the failed transaction" })).not.toBeInTheDocument();
  });

  it("an engine 422 with a field path goes to that field (the date)", async () => {
    mockWidth(1280);
    server.use(
      http.post("*/api/v1/transactions", () => HttpResponse.json(errorFixture("422_date_in_gap_buffer_passthrough"), { status: 422 })),
    );
    const user = userEvent.setup();
    live();
    await findForm();
    await fillReplay(user);
    await user.click(submitButton());

    expect(await screen.findAllByText("The date falls within a gap buffer.")).not.toHaveLength(0);
    expect(dateInput()).toHaveAttribute("aria-invalid", "true");
  });

  it("a 403 FORBIDDEN_POLICY shows the backend's message and does not sign out", async () => {
    mockWidth(1280);
    server.use(
      http.post("*/api/v1/transactions", () => HttpResponse.json(errorFixture("403_forbidden_policy_transaction"), { status: 403 })),
    );
    const user = userEvent.setup();
    const { router } = live();
    await findForm();
    await fillReplay(user);
    await user.click(submitButton());

    expect(await screen.findByText("Only analysts may request ppoProjected.")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/transactions/new");
    expect(screen.getByRole("region", { name: "New transaction form" })).toBeInTheDocument();
  });

  it("a 409 POLICY_DISABLED shows the backend's message, and nothing is saved", async () => {
    mockWidth(1280);
    server.use(
      http.post("*/api/v1/transactions", () => HttpResponse.json(errorFixture("409_policy_disabled_passthrough"), { status: 409 })),
    );
    const user = userEvent.setup();
    live();
    await findForm();
    await fillReplay(user);
    await user.click(submitButton());

    expect(await screen.findByText("The experimental PPO policy is disabled.")).toBeInTheDocument();
    expect(screen.getByText("Not saved")).toBeInTheDocument();
  });

  it("ends the session on a 401 from the submission", async () => {
    mockWidth(1280);
    sessionStorage.setItem(SESSION_TOKEN_KEY, "mock-analyst");
    server.use(http.post("*/api/v1/transactions", () => serverError("UNAUTHENTICATED", 401, "x")));
    const user = userEvent.setup();
    const { router } = renderRoute("/transactions/new", { auth: "real", data: "live" });
    await findForm();
    await fillReplay(user);
    await user.click(submitButton());

    expect(await screen.findByText("Your session has ended")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"));
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
  });
});

describe("New transaction (desktop): uncertain outcomes", () => {
  async function submitAndExpectWarning(user: User) {
    await fillReplay(user);
    await user.click(submitButton());
    expect(await screen.findByText("We can't tell whether it was saved")).toBeInTheDocument();
  }

  function expectCheckHistoryWarning(code: string) {
    // The result panel.
    const panel = screen.getByText("We can't tell whether it was saved").closest("[role='alert']") as HTMLElement;
    expect(panel).toHaveTextContent("may have been saved");
    expect(panel).toHaveTextContent("Check History before submitting again");
    expect(panel).toHaveTextContent("Nothing is retried automatically");
    expect(within(panel).getByRole("link", { name: "Open History" })).toHaveAttribute("href", "/transactions");
    // The form-level message.
    const formAlert = screen.getByText("We can't tell whether this transaction was saved").closest("[role='alert']") as HTMLElement;
    expect(formAlert).toHaveTextContent("Check History before submitting again");
    expect(formAlert).toHaveTextContent(code);
    // It is never reported as definitely not saved, and no saved ID or failed-transaction link is invented.
    expect(screen.queryByText("Not saved")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View the failed transaction" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View transaction" })).not.toBeInTheDocument();
    // What was typed is kept, so the user can resubmit after checking.
    expect(amountInput()).toHaveValue("100000");
    expect(submitButton()).toBeEnabled();
  }

  it("a connection failure is uncertain, not 'not saved'", async () => {
    mockWidth(1280);
    let posts = 0;
    server.use(
      http.post("*/api/v1/transactions", () => {
        posts += 1;
        return HttpResponse.error();
      }),
    );
    const user = userEvent.setup();
    live();
    await findForm();
    await submitAndExpectWarning(user);

    // Said in the result panel and in the form's own message.
    expect(screen.getAllByText("The connection to the server failed.")).toHaveLength(2);
    expectCheckHistoryWarning("NETWORK_ERROR");
    await delay(80);
    expect(posts).toBe(1);
  });

  it.each([
    ["a 201 whose body is not JSON", () => new HttpResponse("not json", { status: 201 })],
    ["a 201 whose body is not a record", () => HttpResponse.json({ hello: "world" }, { status: 201 })],
    ["a gateway page with no envelope (a proxy 502)", () => new HttpResponse("<html>Bad gateway</html>", { status: 502 })],
  ])("%s is uncertain (the answer can't be read)", async (_name, respond) => {
    mockWidth(1280);
    let posts = 0;
    server.use(
      http.post("*/api/v1/transactions", () => {
        posts += 1;
        return respond();
      }),
    );
    const user = userEvent.setup();
    live();
    await findForm();
    await submitAndExpectWarning(user);

    expect(screen.getAllByText("The server answered, but the answer could not be read.")).toHaveLength(2);
    expectCheckHistoryWarning("INVALID_RESPONSE");
    await delay(60);
    expect(posts).toBe(1);
  });

  it("no answer within 25 seconds is uncertain (timeout), after exactly 25 seconds, and is never retried", async () => {
    mockWidth(1280);
    const realFetch = globalThis.fetch;
    let posts = 0;
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "POST") return realFetch(input, init);
      posts += 1;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;
    const user = userEvent.setup();
    live({ fetchImpl });
    await findForm();
    await fillReplay(user);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(submitButton());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(24_999);
    });
    expect(screen.getByRole("button", { name: "Routing…" })).toBeDisabled();
    expect(screen.queryByText("We can't tell whether it was saved")).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    // Nothing is retried however long it is left: several more minutes pass.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    // Testing Library's async helpers need real timers.
    vi.useRealTimers();

    expect(await screen.findByText("We can't tell whether it was saved")).toBeInTheDocument();
    expect(screen.getAllByText("The server did not answer within 25 seconds.")).toHaveLength(2);
    expectCheckHistoryWarning("REQUEST_TIMEOUT");
    expect(posts).toBe(1);
  });
});

describe("preview mode and the narrow layout are unchanged", () => {
  it("preview mode shows the preview form and makes no request, even when submitting", async () => {
    mockWidth(1280);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const user = userEvent.setup();
    renderRoute("/transactions/new", { data: "preview" });

    expect(screen.getByText("Preview data — illustrative, not from the API")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.queryByText("Live data")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Form options" })).not.toBeInTheDocument();
    expect(screen.getByText("Submit the form to see an illustrative routing result.")).toBeInTheDocument();

    await fillReplay(user);
    await user.click(submitButton());

    expect(await screen.findByText(PREVIEW_RESULT_LABEL, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByText(LIVE_RESULT_LABEL)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View transaction" })).not.toBeInTheDocument();
    expect(screen.getByText(/Shown as text only: this preview transaction isn't in the History list/)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["validation", "busy", "timeout", "unavailable", "notready", "error"])(
    "preview mode keeps the ?mock=%s failure, with no request",
    async (mock) => {
      mockWidth(1280);
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const user = userEvent.setup();
      renderRoute(`/transactions/new?mock=${mock}`, { data: "preview" });

      expect(screen.getByText(`Preview failure mode: ${mock}`)).toBeInTheDocument();
      await fillReplay(user);
      await user.click(submitButton());
      expect(await screen.findByText(PREVIEW_RESULT_LABEL, {}, { timeout: 3000 })).toBeInTheDocument();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("below 1024px the page is still the unchanged placeholder, with no request, even in live mode", () => {
    mockWidth(800);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    live();

    expect(screen.getByText("This screen isn't connected yet")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Endpoints" })).toHaveTextContent("POST /api/v1/transactions");
    expect(screen.queryByRole("region", { name: "New transaction form" })).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
