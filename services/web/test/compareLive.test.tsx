import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SESSION_TOKEN_KEY } from "../src/auth/tokenStore";
import { fixtureNetwork, networkHandler } from "./msw/network";
import { comparisonError, fixtureSavedComparison, getComparisonHandler, submitComparisonHandler, type CompareRequestInfo } from "./msw/compare";
import { fixtureMeta, fixtureMetaPpoEnabled, metaHandler, scenariosHandler } from "./msw/reference";
import { server } from "./msw/server";
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

const SAVED_ID = fixtureSavedComparison().id;
const live = (options: RenderOptions = {}, path = "/compare") => renderRoute(path, { data: "live", ...options });
const findForm = () => screen.findByRole("region", { name: "Comparison form" });
const corridorSelect = () => screen.getByRole("combobox", { name: "Corridor" });
const amountInput = () => screen.getByRole("textbox", { name: "Amount (USD)" });
const dateInput = () => screen.getByLabelText(/^Date/);
const submitButton = () => screen.getByRole("button", { name: "Compare policies" });
const policy = (name: string) => screen.getByRole("checkbox", { name });
const results = () => screen.getByRole("region", { name: "Policy results" });
const columns = () => within(results()).getAllByRole("region");
const columnNames = () => columns().map((c) => c.getAttribute("aria-label"));
const alertsText = () => screen.getAllByRole("alert").map((a) => a.textContent ?? "").join(" | ");

type User = ReturnType<typeof userEvent.setup>;

async function fillReplay(user: User, amount = "300000", corridor = "GBR->PHL") {
  await user.selectOptions(corridorSelect(), corridor);
  await user.type(amountInput(), amount);
  fireEvent.change(dateInput(), { target: { value: "2024-06-14" } });
}

async function choose(user: User, ...names: string[]) {
  for (const name of names) await user.click(policy(name));
}

/** Records every request to the three reference endpoints and to POST /comparisons. */
function recordRequests(options: { ppoEnabled?: boolean } = {}) {
  const reference: string[] = [];
  const posts: CompareRequestInfo[] = [];
  const onRequest = (url: URL) => reference.push(url.pathname);
  server.use(
    networkHandler(fixtureNetwork(), { onRequest }),
    scenariosHandler(undefined, { onRequest }),
    metaHandler(options.ppoEnabled ? fixtureMetaPpoEnabled() : fixtureMeta(), { onRequest }),
    submitComparisonHandler({ ppoEnabled: options.ppoEnabled, onRequest: (info) => posts.push(info) }),
  );
  return { reference, posts };
}

const serverError = (code: string, status: number, message = "BACKEND TEXT", details: unknown = {}, requestId = "req-1") =>
  HttpResponse.json({ error: { code, message, details, requestId } }, { status });

describe("Compare (desktop) on the live API: the form", () => {
  it("builds the transaction form from the API's reference data, once each, plus a policy checklist", async () => {
    mockWidth(1280);
    const { reference, posts } = recordRequests();
    live();

    await findForm();
    await delay(30);
    expect(reference.sort()).toEqual(["/api/v1/meta", "/api/v1/network", "/api/v1/scenarios"]);
    expect(posts).toHaveLength(0);
    expect(within(corridorSelect()).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Choose a corridor",
      "USA → IND",
      "GBR → PHL",
      "ARE → MEX",
    ]);
    expect(screen.getByRole("textbox", { name: "Client reference" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "State mode" })).toBeInTheDocument();
    // The checklist replaces the transaction form's single policy select.
    expect(screen.queryByRole("combobox", { name: "Policy" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Policies/ })).toBeInTheDocument();
    for (const name of ["Waterfall", "Cheapest feasible", "PPO (projected)"]) expect(policy(name)).not.toBeChecked();
  });

  it("is labelled live, with the Placeholder weights and Simulated labels, and shows no result yet", async () => {
    mockWidth(1280);
    live();
    await findForm();
    expect(screen.getByRole("heading", { level: 1, name: "Compare policies" })).toBeInTheDocument();
    expect(screen.getByText("Live data")).toBeInTheDocument();
    expect(screen.getByText("Placeholder weights")).toBeInTheDocument();
    expect(screen.getAllByText("Simulated").length).toBeGreaterThan(0);
    expect(screen.getByText("No comparison yet")).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
  });

  it("shows the order the policies are chosen in, and removes one when it is unticked", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    live();
    await findForm();

    await choose(user, "Cheapest feasible", "Waterfall");
    expect(screen.getByText("Results are shown in this order: Cheapest feasible, Waterfall.")).toBeInTheDocument();
    await user.click(policy("Cheapest feasible"));
    expect(screen.getByText("Results are shown in this order: Waterfall.")).toBeInTheDocument();
  });

  it("loads the form's options independently: a failed source shows its own error and retries alone", async () => {
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
        return calls.scenarios === 1 ? serverError("INTERNAL_ERROR", 500) : HttpResponse.json({ scenarios: [{ scenarioId: "baseline", description: "x" }] });
      }),
    );
    const user = userEvent.setup();
    live();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the scenarios");
    expect(screen.queryByRole("region", { name: "Comparison form" })).not.toBeInTheDocument();
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    await findForm();
    expect(calls).toEqual({ network: 1, scenarios: 2, meta: 1 });
  });
});

describe("Compare (desktop): policies and roles", () => {
  it("an analyst can choose PPO, including when the engine has it switched off, with a note that it will be skipped", async () => {
    mockWidth(1280);
    live({ role: "analyst" });
    await findForm();
    expect(policy("PPO (projected)")).toBeEnabled();
    expect(screen.getByText(/The engine has it switched off \(no approved checkpoint configured\), so it will be skipped/)).toBeInTheDocument();
  });

  it("a viewer cannot choose PPO, with the reason, and the other policies are open to them", async () => {
    mockWidth(1280);
    const user = userEvent.setup();
    live({ role: "viewer" });
    await findForm();

    expect(policy("PPO (projected)")).toBeDisabled();
    expect(screen.getByText("Only analysts can use the experimental policy")).toBeInTheDocument();
    expect(policy("Waterfall")).toBeEnabled();
    expect(policy("Cheapest feasible")).toBeEnabled();
    await user.click(policy("PPO (projected)"));
    expect(policy("PPO (projected)")).not.toBeChecked();
  });

  it("a viewer is refused PPO even when the engine enables it, and never sends it", async () => {
    mockWidth(1280);
    const { posts } = recordRequests({ ppoEnabled: true });
    const user = userEvent.setup();
    live({ role: "viewer" });
    await findForm();
    expect(policy("PPO (projected)")).toBeDisabled();

    await fillReplay(user);
    await choose(user, "Waterfall", "Cheapest feasible");
    await user.click(submitButton());

    await screen.findByRole("region", { name: "Policy results" });
    expect(posts[0]!.body).toMatchObject({ policies: ["waterfall", "cheapestFeasible"] });
    expect(posts[0]!.authorization).toBe("Bearer mock-viewer");
  });

  it("needs at least two policies, and sends nothing until there are", async () => {
    mockWidth(1280);
    const { posts } = recordRequests();
    const user = userEvent.setup();
    live();
    await findForm();
    await fillReplay(user);

    await user.click(submitButton());
    expect(await screen.findByText("Choose at least two policies to compare.")).toBeInTheDocument();
    await choose(user, "Waterfall");
    expect(screen.queryByText("Choose at least two policies to compare.")).not.toBeInTheDocument(); // cleared once edited
    await user.click(submitButton());
    expect(await screen.findByText("Choose at least two policies to compare.")).toBeInTheDocument();
    await delay(30);
    expect(posts).toHaveLength(0);
  });

  it("keeps the transaction form's own validation", async () => {
    mockWidth(1280);
    const { posts } = recordRequests();
    const user = userEvent.setup();
    live();
    await findForm();
    await choose(user, "Waterfall", "Cheapest feasible");
    await user.click(submitButton());

    expect(screen.getByText("Choose a corridor.")).toBeInTheDocument();
    expect(screen.getByText("Enter an amount.")).toBeInTheDocument();
    await delay(30);
    expect(posts).toHaveLength(0);
  });
});

describe("Compare (desktop): comparing", () => {
  it("sends the form's fields with the chosen policies, in order, once, and no 'policy' field", async () => {
    mockWidth(1280);
    const { posts } = recordRequests();
    const user = userEvent.setup();
    live();
    await findForm();
    await fillReplay(user);
    await choose(user, "Waterfall", "Cheapest feasible", "PPO (projected)");
    await user.click(submitButton());

    await screen.findByRole("region", { name: "Policy results" });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url.pathname).toBe("/api/v1/comparisons");
    expect(posts[0]!.authorization).toBe("Bearer mock-analyst");
    expect(posts[0]!.body).toEqual({
      senderCountry: "GBR",
      receiverCountry: "PHL",
      amountUsd: 300000,
      state: { mode: "historicalReplay", date: "2024-06-14" },
      policies: ["waterfall", "cheapestFeasible", "ppoProjected"],
    });
    expect(JSON.stringify(posts[0]!.body)).not.toMatch(/baseline|ruleBased/);
  });

  it("sends a scenario state and a client reference too", async () => {
    mockWidth(1280);
    const { posts } = recordRequests();
    const user = userEvent.setup();
    live();
    await findForm();
    await user.selectOptions(corridorSelect(), "GBR->PHL");
    await user.type(amountInput(), "300000");
    await user.type(screen.getByRole("textbox", { name: "Client reference" }), "cmp-1");
    await user.selectOptions(screen.getByRole("combobox", { name: "State mode" }), "scenario");
    fireEvent.change(dateInput(), { target: { value: "2024-06-14" } });
    await user.selectOptions(screen.getByRole("combobox", { name: "Scenario" }), "cheapest_venue_outage");
    await choose(user, "Waterfall", "Cheapest feasible");
    await user.click(submitButton());

    await screen.findByRole("region", { name: "Policy results" });
    expect(posts[0]!.body).toMatchObject({
      state: { mode: "scenario", date: "2024-06-14", scenarioId: "cheapest_venue_outage" },
      clientReference: "cmp-1",
      policies: ["waterfall", "cheapestFeasible"],
    });
  });

  it("shows one column per policy in the order chosen, with a skipped policy in its place", async () => {
    mockWidth(1280);
    recordRequests();
    const user = userEvent.setup();
    live();
    await findForm();
    await fillReplay(user);
    await choose(user, "Cheapest feasible", "PPO (projected)", "Waterfall");
    await user.click(submitButton());

    await screen.findByRole("region", { name: "Policy results" });
    expect(columnNames()).toEqual(["Cheapest feasible result", "PPO (projected) result", "Waterfall result"]);
  });

  it("shows each result's totals, metrics, allocations and warnings, from the engine", async () => {
    mockWidth(1280);
    recordRequests();
    const user = userEvent.setup();
    live();
    await findForm();
    await fillReplay(user);
    await choose(user, "Waterfall", "Cheapest feasible");
    await user.click(submitButton());
    await screen.findByRole("region", { name: "Policy results" });

    const waterfall = within(screen.getByRole("region", { name: "Waterfall result" }));
    expect(waterfall.getByText("Completed")).toBeInTheDocument();
    expect(waterfall.getByText("Executed", { selector: "dt" }).nextElementSibling).toHaveTextContent("$300,000");
    expect(waterfall.getByText("Fee cost").nextElementSibling).toHaveTextContent("$5,910");
    expect(waterfall.getByText("Latency term").nextElementSibling).toHaveTextContent("0.3055");
    expect(waterfall.getByText("Risk term").nextElementSibling).toHaveTextContent("0");
    expect(waterfall.getByText("Reward (amount-based)").nextElementSibling).toHaveTextContent("-0.264");
    expect(waterfall.getByText("Placeholder weights")).toBeInTheDocument();
    expect(waterfall.getByText(/reward weights that are placeholders \(placeholder\)/)).toBeInTheDocument();
    const table = waterfall.getByRole("table", { name: "Allocations of Waterfall" });
    expect(within(table).getAllByRole("row").slice(1)).toHaveLength(3);
    expect(within(table).queryByRole("columnheader", { name: "Before projection" })).not.toBeInTheDocument();
    expect(waterfall.getByText("RISK_FALLBACK_USED")).toBeInTheDocument();
    expect(waterfall.queryByText(/capacity projection/)).not.toBeInTheDocument();

    const cheapest = within(screen.getByRole("region", { name: "Cheapest feasible result" }));
    expect(cheapest.getByText("Partial")).toBeInTheDocument();
    expect(cheapest.getByText("Executed", { selector: "dt" }).nextElementSibling).toHaveTextContent("$15,000");
    expect(cheapest.getByText("PARTIAL_COMPLETION")).toBeInTheDocument();
    expect(cheapest.getByText("Reward (amount-based)").nextElementSibling).toHaveTextContent("-0.9586");
  });

  it("shows a skipped policy as a result, with the engine's code and message unchanged, and says it was still saved", async () => {
    mockWidth(1280);
    recordRequests();
    const user = userEvent.setup();
    live();
    await findForm();
    await fillReplay(user);
    await choose(user, "Waterfall", "Cheapest feasible", "PPO (projected)");
    await user.click(submitButton());
    await screen.findByRole("region", { name: "Policy results" });

    const ppo = within(screen.getByRole("region", { name: "PPO (projected) result" }));
    expect(ppo.getByText("Skipped")).toBeInTheDocument();
    expect(ppo.getByText("POLICY_DISABLED")).toBeInTheDocument();
    expect(ppo.getByText(/no approved checkpoint configured/)).toBeInTheDocument();
    expect(ppo.getByText(/The comparison was still saved/)).toBeInTheDocument();
    expect(ppo.getByText("Experimental")).toBeInTheDocument();
    expect(ppo.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("Not saved")).not.toBeInTheDocument();
  });

  it("shows a PPO result, labelled experimental, with the pre-projection shares and the projection note", async () => {
    mockWidth(1280);
    recordRequests({ ppoEnabled: true });
    const user = userEvent.setup();
    live();
    await findForm();
    await fillReplay(user);
    await choose(user, "Waterfall", "PPO (projected)");
    await user.click(submitButton());
    await screen.findByRole("region", { name: "Policy results" });

    const ppo = within(screen.getByRole("region", { name: "PPO (projected) result" }));
    expect(ppo.getByText("Experimental")).toBeInTheDocument();
    const table = ppo.getByRole("table", { name: "Allocations of PPO (projected)" });
    expect(within(table).getByRole("columnheader", { name: "Before projection" })).toBeInTheDocument();
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("34.0%"); // 0.34 before projection
    expect(ppo.getByText(/The capacity projection adjusted this policy's allocation/)).toBeInTheDocument();
    expect(ppo.getByText("EXPERIMENTAL_POLICY")).toBeInTheDocument();
  });

  it("always shows the API's note as written, and the Placeholder weights label", async () => {
    mockWidth(1280);
    recordRequests();
    const user = userEvent.setup();
    live();
    await findForm();
    await fillReplay(user);
    await choose(user, "Waterfall", "Cheapest feasible");
    await user.click(submitButton());
    await screen.findByRole("region", { name: "Policy results" });

    expect(screen.getByText("A comparison, not a ranking")).toBeInTheDocument();
    expect(
      screen.getByText("Single-transaction comparison under placeholder reward weights. Not evidence that one policy is better; see docs/STAGE1F_RESULTS.md."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Placeholder weights").length).toBeGreaterThanOrEqual(3); // the page, and each result's metrics
  });

  it("makes no winner, ranking or 'best policy' claim, and orders and highlights nothing", async () => {
    mockWidth(1280);
    recordRequests({ ppoEnabled: true });
    const user = userEvent.setup();
    live();
    await findForm();
    await fillReplay(user);
    await choose(user, "Waterfall", "Cheapest feasible", "PPO (projected)");
    await user.click(submitButton());
    await screen.findByRole("region", { name: "Policy results" });

    const text = within(screen.getByRole("main")).getByRole("region", { name: "Policy results" }).textContent ?? "";
    const own = (screen.getByRole("main").textContent ?? "")
      // The API's own words (its note and its warnings) are shown as written; only this UI's wording is checked.
      .replace(screen.getByText(/Not evidence that one policy is better/).textContent ?? "", "")
      .replace(/ppo_projected is experimental[^.]*\.[^.]*\.[^.]*\./, "");
    expect(own).not.toMatch(/winner|best polic|top polic|outperform|beats?\b|\bwins?\b|recommended|ranked #|rank \d|1st|first place/i);
    expect(text).not.toMatch(/\bwinner\b|\bbest\b|recommended/i);
    expect(screen.queryByRole("columnheader", { name: /rank|score|place|position/i })).not.toBeInTheDocument();
    expect(within(results()).queryByRole("listitem", { name: /rank/i })).not.toBeInTheDocument();
    // The columns are in the order chosen, not sorted by any number.
    expect(columnNames()).toEqual(["Waterfall result", "Cheapest feasible result", "PPO (projected) result"]);
    for (const c of columns()) expect(c.className).not.toMatch(/ring|border-status|bg-status|highlight/);
  });

  it("links the comparison to its own page", async () => {
    mockWidth(1280);
    recordRequests();
    const user = userEvent.setup();
    live();
    await findForm();
    await fillReplay(user);
    await choose(user, "Waterfall", "Cheapest feasible");
    await user.click(submitButton());
    await screen.findByRole("region", { name: "Policy results" });

    expect(screen.getByRole("link", { name: "Open this comparison" })).toHaveAttribute("href", `/compare/${SAVED_ID.replace(SAVED_ID, "6be3eb41-9c9f-5caf-87ed-646d66645842")}`);
    expect(screen.getByText("6be3eb41-9c9f-5caf-87ed-646d66645842")).toBeInTheDocument();
  });

  it("shows the comparing state while the request runs", async () => {
    mockWidth(1280);
    server.use(
      http.post("*/api/v1/comparisons", async () => {
        await delay(80);
        return serverError("INTERNAL_ERROR", 500);
      }),
    );
    const user = userEvent.setup();
    live();
    await findForm();
    await fillReplay(user);
    await choose(user, "Waterfall", "Cheapest feasible");
    await user.click(submitButton());

    expect(screen.getByRole("button", { name: "Comparing…" })).toBeDisabled();
    expect(screen.getByText("Comparing the policies")).toBeInTheDocument();
    await screen.findByText("Not saved");
  });

  it("sends one request however many times Submit is activated while it runs", async () => {
    mockWidth(1280);
    let posts = 0;
    server.use(
      http.post("*/api/v1/comparisons", async () => {
        posts += 1;
        await delay(100);
        return serverError("INTERNAL_ERROR", 500);
      }),
    );
    const user = userEvent.setup();
    live();
    await findForm();
    await fillReplay(user);
    await choose(user, "Waterfall", "Cheapest feasible");
    await user.dblClick(submitButton());
    const form = screen.getByRole("region", { name: "Comparison form" }).querySelector("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);

    await screen.findByText("Not saved");
    expect(posts).toBe(1);
  });
});

describe("Compare (desktop): errors (nothing is saved, and there is no transaction ID)", () => {
  async function submitWith(handler: ReturnType<typeof http.post>, options: RenderOptions = {}) {
    server.use(handler);
    const user = userEvent.setup();
    const view = live(options);
    await findForm();
    await fillReplay(user);
    await choose(user, "Waterfall", "Cheapest feasible");
    await user.click(submitButton());
    return { user, ...view };
  }

  it.each([
    ["503_engine_busy", 503, "ENGINE_BUSY"],
    ["504_engine_timeout", 504, "ENGINE_TIMEOUT"],
    ["502_inference_error", 502, "INFERENCE_ERROR"],
    ["503_inference_unavailable", 503, "INFERENCE_UNAVAILABLE"],
  ])("%s shows the backend's message, reference and 'Not saved', with no failed-transaction record", async (file, status, code) => {
    mockWidth(1280);
    const body = comparisonError(file) as { error: { message: string; requestId: string } };
    await submitWith(http.post("*/api/v1/comparisons", () => HttpResponse.json(body, { status })));

    expect(await screen.findByText("Not saved")).toBeInTheDocument();
    const alert = screen.getAllByRole("alert").find((a) => a.textContent?.includes(code))!;
    expect(alert).toHaveTextContent(body.error.message);
    expect(alert).toHaveTextContent(body.error.requestId);
    expect(screen.queryByText(/saved as failed|saved without a decision/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /failed transaction/i })).not.toBeInTheDocument();
    expect(amountInput()).toHaveValue("300000"); // what was typed is kept
  });

  it("an engine that was still starting up says so, and says it was not saved", async () => {
    mockWidth(1280);
    await submitWith(
      http.post("*/api/v1/comparisons", () =>
        HttpResponse.json(comparisonError("503_inference_not_ready"), { status: 503, headers: { "Retry-After": "5" } }),
      ),
    );
    expect(await screen.findByText("Not saved")).toBeInTheDocument();
    expect(alertsText()).toContain("INFERENCE_UNAVAILABLE");
  });

  it("a 403 FORBIDDEN_POLICY goes to the policies control with the backend's message, and does not sign out", async () => {
    mockWidth(1280);
    const { router } = await submitWith(
      http.post("*/api/v1/comparisons", () => HttpResponse.json(comparisonError("403_forbidden_policy_comparison"), { status: 403 })),
    );
    expect((await screen.findAllByText("Only analysts may request ppoProjected.")).length).toBeGreaterThan(0);
    expect(screen.getByRole("group", { name: /Policies/ })).toHaveAttribute("aria-describedby");
    expect(router.state.location.pathname).toBe("/compare");
    expect(screen.getByRole("region", { name: "Comparison form" })).toBeInTheDocument();
  });

  it("a 422 on one of the policies goes to the policies control, one on the amount to the amount", async () => {
    mockWidth(1280);
    await submitWith(
      http.post("*/api/v1/comparisons", () =>
        serverError("VALIDATION_ERROR", 422, "Request failed validation.", {
          errors: [
            { field: "policies[1]", message: "Listed more than once." },
            { field: "amountUsd", message: "Must be a number." },
            { message: "Something about the whole request." },
          ],
        }),
      ),
    );
    expect(await screen.findByText("Listed more than once.")).toBeInTheDocument();
    expect(screen.getByText("Must be a number.")).toBeInTheDocument();
    expect(amountInput()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Something about the whole request.")).toBeInTheDocument();
    expect(screen.getByText("Not saved")).toBeInTheDocument();
  });

  it("an engine 422 about the date goes to the date field, as in the transaction form", async () => {
    mockWidth(1280);
    await submitWith(http.post("*/api/v1/comparisons", () => HttpResponse.json(comparisonError("422_date_in_gap_buffer_passthrough"), { status: 422 })));
    expect((await screen.findAllByText("The date falls within a gap buffer.")).length).toBeGreaterThan(0);
    expect(dateInput()).toHaveAttribute("aria-invalid", "true");
  });

  it("ends the session on a 401", async () => {
    mockWidth(1280);
    sessionStorage.setItem(SESSION_TOKEN_KEY, "mock-analyst");
    const user = userEvent.setup();
    server.use(http.post("*/api/v1/comparisons", () => serverError("UNAUTHENTICATED", 401, "x")));
    const { router } = renderRoute("/compare", { auth: "real", data: "live" });
    await findForm();
    await fillReplay(user);
    await choose(user, "Waterfall", "Cheapest feasible");
    await user.click(submitButton());

    expect(await screen.findByText("Your session has ended")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"));
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
  });

  it("never retries after an error", async () => {
    mockWidth(1280);
    let posts = 0;
    await submitWith(
      http.post("*/api/v1/comparisons", () => {
        posts += 1;
        return HttpResponse.json(comparisonError("503_engine_busy"), { status: 503, headers: { "Retry-After": "1" } });
      }),
    );
    await screen.findByText("Not saved");
    await delay(120);
    expect(posts).toBe(1);
  });
});

describe("Compare (desktop): uncertain submissions", () => {
  async function submitUncertain(user: User) {
    await fillReplay(user);
    await choose(user, "Waterfall", "Cheapest feasible");
    await user.click(submitButton());
    expect(await screen.findByText("We can't tell whether it was saved")).toBeInTheDocument();
  }

  function expectWarning(code: string) {
    const panel = screen.getByText("We can't tell whether it was saved").closest("[role='alert']") as HTMLElement;
    expect(panel).toHaveTextContent("may have been saved");
    expect(panel).toHaveTextContent("Comparisons can't be listed");
    expect(panel).toHaveTextContent("another, independent record");
    expect(panel).toHaveTextContent("Nothing is retried automatically");
    const formAlert = screen.getByText("We can't tell whether this comparison was saved").closest("[role='alert']") as HTMLElement;
    expect(formAlert).toHaveTextContent(code);
    expect(screen.queryByText("Not saved")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open this comparison" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open History" })).not.toBeInTheDocument(); // comparisons are not in History
    expect(amountInput()).toHaveValue("300000"); // what was typed is kept
    expect(submitButton()).toBeEnabled();
  }

  it("a connection failure is uncertain, and is not retried", async () => {
    mockWidth(1280);
    let posts = 0;
    server.use(
      http.post("*/api/v1/comparisons", () => {
        posts += 1;
        return HttpResponse.error();
      }),
    );
    const user = userEvent.setup();
    live();
    await findForm();
    await submitUncertain(user);
    expect(screen.getAllByText("The connection to the server failed.")).toHaveLength(2);
    expectWarning("NETWORK_ERROR");
    await delay(80);
    expect(posts).toBe(1);
  });

  it.each([
    ["a 201 whose body is not JSON", () => new HttpResponse("not json", { status: 201 })],
    ["a 201 comparison that contradicts itself", () => HttpResponse.json({ ...fixtureSavedComparison(), sameState: false }, { status: 201 })],
    ["a gateway page with no envelope", () => new HttpResponse("<html>Bad gateway</html>", { status: 502 })],
  ])("%s is uncertain (the answer can't be read)", async (_name, respond) => {
    mockWidth(1280);
    server.use(http.post("*/api/v1/comparisons", () => respond()));
    const user = userEvent.setup();
    live();
    await findForm();
    await submitUncertain(user);
    expect(screen.getAllByText("The server answered, but the answer could not be read.")).toHaveLength(2);
    expectWarning("INVALID_RESPONSE");
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
    await choose(user, "Waterfall", "Cheapest feasible");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(submitButton());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(24_999);
    });
    expect(screen.getByRole("button", { name: "Comparing…" })).toBeDisabled();
    expect(screen.queryByText("We can't tell whether it was saved")).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    vi.useRealTimers();

    expect(await screen.findByText("We can't tell whether it was saved")).toBeInTheDocument();
    expect(screen.getAllByText("The server did not answer within 25 seconds.")).toHaveLength(2);
    expectWarning("REQUEST_TIMEOUT");
    expect(posts).toBe(1);
  });
});

describe("Compare (desktop): a saved comparison at /compare/:id", () => {
  const savedPath = `/compare/${SAVED_ID}`;

  it("asks for it with the bearer token, once, and shows the same columns in the order saved", async () => {
    mockWidth(1280);
    const seen: { path: string; authorization: string | null }[] = [];
    server.use(getComparisonHandler(undefined, { onRequest: ({ url, authorization }) => seen.push({ path: url.pathname, authorization }) }));
    live({}, savedPath);

    await screen.findByRole("region", { name: "Policy results" });
    await delay(30);
    expect(seen).toEqual([{ path: `/api/v1/comparisons/${SAVED_ID}`, authorization: "Bearer mock-analyst" }]);
    expect(columnNames()).toEqual(["Waterfall result", "Cheapest feasible result", "PPO (projected) result"]);
    expect(screen.getByRole("heading", { level: 1, name: "Saved comparison" })).toBeInTheDocument();
    expect(screen.getAllByText(SAVED_ID).length).toBeGreaterThan(0);
    expect(screen.getByText("Live data")).toBeInTheDocument();
    expect(screen.getAllByText("Placeholder weights").length).toBeGreaterThanOrEqual(2); // the page, and each result's metrics
    expect(screen.getByText(/Not evidence that one policy is better/)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "PPO (projected) result" })).getByText("POLICY_DISABLED")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open this comparison" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New comparison" })).toHaveAttribute("href", "/compare");
  });

  it("the form does not load for a saved comparison: no reference requests, no POST", async () => {
    mockWidth(1280);
    const { reference, posts } = recordRequests();
    server.use(getComparisonHandler());
    live({}, savedPath);
    await screen.findByRole("region", { name: "Policy results" });
    await delay(30);
    expect(reference).toHaveLength(0);
    expect(posts).toHaveLength(0);
    expect(screen.queryByRole("region", { name: "Comparison form" })).not.toBeInTheDocument();
  });

  it("an upper-case ID is asked for in lower case", async () => {
    mockWidth(1280);
    const seen: string[] = [];
    server.use(getComparisonHandler(undefined, { onRequest: ({ url }) => seen.push(url.pathname) }));
    live({}, `/compare/${SAVED_ID.toUpperCase()}`);
    await screen.findByRole("region", { name: "Policy results" });
    expect(seen[0]).toBe(`/api/v1/comparisons/${SAVED_ID}`);
  });

  it("an unknown comparison is 'not found', with no retry", async () => {
    mockWidth(1280);
    live({}, "/compare/00000000-0000-4000-8000-000000000000");
    expect(await screen.findByText("Comparison not found")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "New comparison" }).length).toBeGreaterThan(0);
  });

  it("an address that isn't a comparison ID makes no request", async () => {
    mockWidth(1280);
    const seen: string[] = [];
    server.use(getComparisonHandler(undefined, { onRequest: ({ url }) => seen.push(url.pathname) }));
    live({}, "/compare/not-an-id");
    expect(await screen.findByText("No comparison to show")).toBeInTheDocument();
    await delay(30);
    expect(seen).toHaveLength(0);
  });

  it("shows a loading state while the request runs", async () => {
    mockWidth(1280);
    server.use(
      http.get("*/api/v1/comparisons/:id", async () => {
        await delay(60);
        return HttpResponse.json(fixtureSavedComparison());
      }),
    );
    live({}, savedPath);
    expect(screen.getByRole("status")).toHaveTextContent("Loading the comparison");
    await screen.findByRole("region", { name: "Policy results" });
  });

  it("shows a server error with its request ID, does not retry by itself, and retries on request", async () => {
    mockWidth(1280);
    let calls = 0;
    server.use(
      http.get("*/api/v1/comparisons/:id", () => {
        calls += 1;
        return calls === 1 ? serverError("INTERNAL_ERROR", 500, "BACKEND TEXT", {}, "req-500") : HttpResponse.json(fixtureSavedComparison());
      }),
    );
    const user = userEvent.setup();
    live({}, savedPath);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load this comparison");
    expect(alert).toHaveTextContent("The server hit an unexpected error");
    expect(alert).toHaveTextContent("req-500");
    expect(alert).not.toHaveTextContent("BACKEND TEXT");
    await delay(80);
    expect(calls).toBe(1);

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("region", { name: "Policy results" });
    expect(calls).toBe(2);
  });

  it("says when the server could not be reached, and refuses a body that isn't this comparison", async () => {
    mockWidth(1280);
    server.use(http.get("*/api/v1/comparisons/:id", () => HttpResponse.error()));
    const first = live({}, savedPath);
    expect(await screen.findByRole("alert")).toHaveTextContent("The server could not be reached");
    first.unmount();

    server.use(http.get("*/api/v1/comparisons/:id", () => HttpResponse.json({ ...fixtureSavedComparison(), id: "00000000-0000-4000-8000-000000000000" })));
    live({}, savedPath);
    expect(await screen.findByRole("alert")).toHaveTextContent("couldn't read");
    expect(screen.queryByRole("region", { name: "Policy results" })).not.toBeInTheDocument();
  });

  it("ends the session on a 401", async () => {
    mockWidth(1280);
    sessionStorage.setItem(SESSION_TOKEN_KEY, "mock-analyst");
    server.use(http.get("*/api/v1/comparisons/:id", () => serverError("UNAUTHENTICATED", 401, "x")));
    const { router } = renderRoute(savedPath, { auth: "real", data: "live" });
    expect(await screen.findByText("Your session has ended")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"));
  });

  it("a viewer can read it too", async () => {
    mockWidth(1280);
    const seen: (string | null)[] = [];
    server.use(getComparisonHandler(undefined, { onRequest: ({ authorization }) => seen.push(authorization) }));
    live({ role: "viewer" }, savedPath);
    await screen.findByRole("region", { name: "Policy results" });
    expect(seen).toEqual(["Bearer mock-viewer"]);
  });
});

describe("preview mode and the narrow layout keep the existing placeholder", () => {
  const PLACEHOLDER = "This screen isn't connected yet";

  it.each(["/compare", `/compare/${SAVED_ID}`])("preview mode shows the placeholder at %s, with its endpoints and label, and no request", (path) => {
    mockWidth(1280);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderRoute(path, { data: "preview" });

    expect(screen.getByRole("heading", { level: 1, name: "Compare policies" })).toBeInTheDocument();
    expect(screen.getByText(PLACEHOLDER)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Endpoints" })).toHaveTextContent("POST /api/v1/comparisons");
    expect(screen.getByRole("list", { name: "Endpoints" })).toHaveTextContent("GET /api/v1/comparisons/{id}");
    expect(screen.getByText("Placeholder weights")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Comparison form" })).not.toBeInTheDocument();
    expect(screen.queryByText("Live data")).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([1023, 768, 375])("below 1024px (%ipx) it is the same placeholder, with no form, no request, even in live mode", (width) => {
    mockWidth(width);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    live();

    expect(screen.getByText(PLACEHOLDER)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Endpoints" })).toHaveTextContent("POST /api/v1/comparisons");
    expect(screen.queryByRole("region", { name: "Comparison form" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /Policies/ })).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a saved comparison's address below 1024px is the placeholder and makes no request", () => {
    mockWidth(800);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    live({}, `/compare/${SAVED_ID}`);
    expect(screen.getByText(PLACEHOLDER)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("without matchMedia (as in jsdom) it is the placeholder", () => {
    // @ts-expect-error: simulating an environment with no matchMedia
    window.matchMedia = undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    live();
    expect(screen.getByText(PLACEHOLDER)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
