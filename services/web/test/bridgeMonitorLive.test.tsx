import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_TOKEN_KEY } from "../src/auth/tokenStore";
import { ILLUSTRATIVE_CORRIDORS } from "../src/features/globe/illustrativeData";
import { calendarHandler, fixtureCalendar, fixtureReplayState, generatedState, stateHandler } from "./msw/monitor";
import { scenariosHandler } from "./msw/reference";
import { server } from "./msw/server";
import { renderRoute } from "./renderRoute";

// The real Globe imports three, which needs WebGL. The mock records that it was rendered, and draws nothing.
const globeRenders = vi.fn();
vi.mock("../src/features/globe/Globe", () => ({
  Globe: (props: { locations: unknown[]; connections: unknown[]; label: string }) => {
    globeRenders(props);
    return <div data-testid="globe" role="img" aria-label={props.label} />;
  },
}));

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
beforeEach(() => globeRenders.mockClear());
afterEach(() => {
  server.resetHandlers();
  sessionStorage.clear();
  window.matchMedia = original;
  vi.restoreAllMocks();
});
afterAll(() => server.close());

const CORRIDORS = ["USA->IND", "GBR->PHL", "ARE->MEX"] as const;
const FIXTURE_DAY = "2024-06-14";
const live = (search = "") => renderRoute(`/bridges${search}`, { data: "live" });
const card = (corridor: string) => screen.getByRole("region", { name: `Bridge state ${corridor.replace("->", " → ")}` });
const findCard = (corridor: string) => screen.findByRole("region", { name: `Bridge state ${corridor.replace("->", " → ")}` });
const venueRows = (corridor: string) =>
  within(within(card(corridor)).getByRole("table", { name: `Venues of ${corridor.replace("->", " → ")}` })).getAllByRole("row").slice(1);
const dateInput = () => screen.getByLabelText("Date");

type Seen = { kind: "state" | "calendar" | "scenarios"; url: URL; authorization: string | null };

/** Records every request to the calendar, the state and the scenarios. */
function recordRequests() {
  const seen: Seen[] = [];
  const log = (kind: Seen["kind"]) => (url: URL, authorization: string | null) => seen.push({ kind, url, authorization });
  server.use(
    calendarHandler(undefined, { onRequest: log("calendar") }),
    stateHandler({ onRequest: log("state") }),
    scenariosHandler(undefined, { onRequest: log("scenarios") }),
  );
  return seen;
}
const ofKind = (seen: Seen[], kind: Seen["kind"]) => seen.filter((s) => s.kind === kind);

const error = (code: string, status: number, details: unknown = {}, requestId = "req-1") =>
  HttpResponse.json({ error: { code, message: "BACKEND TEXT", details, requestId } }, { status });

describe("Bridge monitor (desktop) on the live API: requests and the default date", () => {
  it("asks for the calendar once, then for each corridor's state on the latest eligible date, with the bearer token", async () => {
    mockWidth(1280);
    const seen = recordRequests();
    live();

    for (const c of CORRIDORS) await within(await findCard(c)).findByRole("table");
    await delay(30);

    expect(ofKind(seen, "calendar")).toHaveLength(1);
    expect(ofKind(seen, "calendar")[0]!.authorization).toBe("Bearer mock-analyst");
    expect(ofKind(seen, "scenarios")).toHaveLength(0); // only the scenario mode needs them
    const states = ofKind(seen, "state");
    expect(states).toHaveLength(3);
    expect(states.map((s) => s.url.searchParams.get("corridor")).sort()).toEqual([...CORRIDORS].sort());
    for (const s of states) {
      expect(s.authorization).toBe("Bearer mock-analyst");
      expect(Object.fromEntries(s.url.searchParams)).toMatchObject({ mode: "historicalReplay", date: "2025-08-30" });
      expect(s.url.searchParams.has("scenarioId")).toBe(false);
      expect(s.url.searchParams.has("includeHistory")).toBe(false);
    }
  });

  it("shows the default date in the control and says it is the latest eligible one", async () => {
    mockWidth(1280);
    live();
    await within(await findCard("GBR->PHL")).findByRole("table"); // the card exists, waiting, before the default date does
    expect(dateInput()).toHaveValue("2025-08-30");
    expect(screen.getByText(/Showing the latest eligible date/)).toBeInTheDocument();
    expect(dateInput()).toHaveAttribute("min", "2011-01-01");
    expect(dateInput()).toHaveAttribute("max", "2025-09-30");
  });

  it("skips every excluded range when it picks the default, not only the one at the end", async () => {
    mockWidth(1280);
    const calendar = fixtureCalendar();
    calendar.excludedRanges.push({ start: "2025-08-01", end: "2025-08-30" }); // touches the one that ends the data
    const seen: Seen[] = [];
    server.use(calendarHandler(calendar), stateHandler({ onRequest: (url, authorization) => seen.push({ kind: "state", url, authorization }) }));
    live();

    await within(await findCard("GBR->PHL")).findByRole("table"); // the card exists, waiting, before the default date does
    expect(dateInput()).toHaveValue("2025-07-31");
    expect(seen.every((s) => s.url.searchParams.get("date") === "2025-07-31")).toBe(true);
  });

  it("uses the date in the URL, and does not call it the default", async () => {
    mockWidth(1280);
    const seen = recordRequests();
    live(`?date=${FIXTURE_DAY}`);

    await findCard("GBR->PHL");
    expect(dateInput()).toHaveValue(FIXTURE_DAY);
    expect(screen.queryByText(/Showing the latest eligible date/)).not.toBeInTheDocument();
    expect(ofKind(seen, "state").every((s) => s.url.searchParams.get("date") === FIXTURE_DAY)).toBe(true);
  });
});

describe("Bridge monitor (desktop): what the cards show", () => {
  it("keeps the globe and its disclaimer exactly as they are, and adds one card per corridor below", async () => {
    mockWidth(1280);
    live();
    await findCard("GBR->PHL");

    expect(screen.getByTestId("globe")).toBeInTheDocument();
    expect(globeRenders.mock.calls[0]![0]).toMatchObject({ locations: expect.any(Array), connections: expect.any(Array) });
    expect((globeRenders.mock.calls[0]![0] as { connections: unknown[] }).connections).toHaveLength(ILLUSTRATIVE_CORRIDORS.length);
    expect(screen.getByText("Illustrative — not live bridge availability.")).toBeInTheDocument();
    expect(screen.getByText(/They show no liquidity, availability or status/)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Corridors shown" }).querySelectorAll("li")).toHaveLength(3);
    for (const c of CORRIDORS) expect(card(c)).toBeInTheDocument();
    // The cards come after the globe in the page.
    expect(screen.getByTestId("globe").compareDocumentPosition(card("USA->IND")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the contract's replay state: every venue's ID, slot, fee, liquidity, raw congestion, data source and provenance", async () => {
    mockWidth(1280);
    live(`?date=${FIXTURE_DAY}&corridor=GBR-%3EPHL`);

    await within(await findCard("GBR->PHL")).findByRole("table");
    const raw = fixtureReplayState();
    const table = within(card("GBR->PHL")).getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Venue",
      "Slot",
      "Fee",
      "Liquidity",
      "Congestion (raw)",
      "Data source",
      "Values",
    ]);
    const rows = venueRows("GBR->PHL");
    expect(rows).toHaveLength(raw.venues.length);
    const first = within(rows[0]!).getAllByRole("cell");
    expect(first[0]).toHaveTextContent("GBR->PHL#0");
    expect(first[1]).toHaveTextContent("0");
    expect(first[2]).toHaveTextContent("2.00%"); // 0.02, a fraction
    expect(first[3]).toHaveTextContent("$412,346"); // 412345.6
    expect(first[4]).toHaveTextContent("0.31"); // raw, not a percentage
    expect(first[5]).toHaveTextContent("Real static bridge");
    expect(first[6]).toHaveTextContent("Synthetic simulation");
    const second = within(rows[1]!).getAllByRole("cell");
    expect(second[2]).toHaveTextContent("1.40%");
    expect(second[3]).toHaveTextContent("$150,000");
    expect(second[4]).toHaveTextContent("0.22");
    expect(second[5]).toHaveTextContent("Synthetic expansion");
    expect(within(rows[1]!).getByText("Synthetic venue")).toBeInTheDocument();
  });

  it("shows the corridor's risk, baseline cost, data split and warnings as the API gave them", async () => {
    mockWidth(1280);
    live(`?date=${FIXTURE_DAY}&corridor=GBR-%3EPHL`);
    await within(await findCard("GBR->PHL")).findByRole("table");

    const gbr = card("GBR->PHL");
    expect(within(gbr).getByText("Data split").nextElementSibling).toHaveTextContent("test");
    expect(within(gbr).getByText("Corridor risk").nextElementSibling).toHaveTextContent("0");
    expect(within(gbr).getByText("Baseline cost").nextElementSibling).toHaveTextContent("0.0612"); // raw, no unit added
    expect(gbr).toHaveTextContent(/the contract doesn't define a unit or scale/);
    const warnings = within(gbr).getByRole("region", { name: "Warnings for GBR → PHL" });
    expect(warnings).toHaveTextContent("RISK_FALLBACK_USED");
    expect(warnings).toHaveTextContent("The corridor risk proxy is unavailable for this date");
    expect(gbr).toHaveTextContent("14 Jun 2024");
    expect(gbr).toHaveTextContent("Historical replay");
  });

  it("shows no warnings section when there are none", async () => {
    mockWidth(1280);
    live(`?date=2024-03-01&corridor=USA-%3EIND`);
    await within(await findCard("USA->IND")).findByRole("table");
    expect(within(card("USA->IND")).queryByRole("region", { name: /Warnings/ })).not.toBeInTheDocument();
  });

  it("never shows an availability, health or status indicator, and says the API provides none", async () => {
    mockWidth(1280);
    live(`?date=${FIXTURE_DAY}`);
    for (const c of CORRIDORS) await within(await findCard(c)).findByRole("table");

    expect(screen.getByText("Simulated values — not availability or status")).toBeInTheDocument();
    expect(screen.getByText(/The API provides no availability or bridge status, so none is shown/)).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /status|health|available|online|offline|up\b|down\b/i })).not.toBeInTheDocument();
    const main = screen.getByRole("main");
    expect(within(main).queryByText(/^(operational|healthy|degraded|online|offline|available|unavailable|down)$/i)).not.toBeInTheDocument();
  });

  it("says the API is connected, and keeps the Simulated label on the page and on every card", async () => {
    mockWidth(1280);
    live(`?date=${FIXTURE_DAY}`);
    for (const c of CORRIDORS) await within(await findCard(c)).findByRole("table");

    expect(screen.getByText("Live data")).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
    expect(screen.queryByText("The monitor's data isn't connected yet")).not.toBeInTheDocument();
    expect(screen.getAllByText("Simulated").length).toBeGreaterThanOrEqual(4); // the page and three cards
    for (const c of CORRIDORS) expect(within(card(c)).getByText("Simulated")).toBeInTheDocument();
    for (const c of CORRIDORS) {
      for (const row of venueRows(c)) expect(within(row).getAllByRole("cell")[6]).toHaveTextContent("Synthetic simulation");
    }
  });
});

describe("Bridge monitor (desktop): the controls and the URL", () => {
  it("offers all corridors, the three corridors, the two modes and a date", async () => {
    mockWidth(1280);
    live();
    await findCard("GBR->PHL");
    expect(within(screen.getByRole("combobox", { name: "Corridor" })).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "All corridors",
      "USA → IND",
      "GBR → PHL",
      "ARE → MEX",
    ]);
    expect(within(screen.getByRole("combobox", { name: "Mode" })).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Historical replay",
      "Scenario",
    ]);
    expect(screen.queryByRole("combobox", { name: "Scenario" })).not.toBeInTheDocument();
  });

  it("choosing a corridor keeps it in the URL and shows only that card, asking only for it", async () => {
    mockWidth(1280);
    const seen = recordRequests();
    const user = userEvent.setup();
    const { router } = live(`?date=${FIXTURE_DAY}`);
    await within(await findCard("USA->IND")).findByRole("table");
    const before = ofKind(seen, "state").length;

    await user.selectOptions(screen.getByRole("combobox", { name: "Corridor" }), "GBR->PHL");

    await waitFor(() => expect(router.state.location.search).toContain("corridor=GBR-%3EPHL"));
    expect(screen.queryByRole("region", { name: "Bridge state USA → IND" })).not.toBeInTheDocument();
    expect(card("GBR->PHL")).toBeInTheDocument();
    await delay(40);
    // The GBR card was already loaded for this key: no card of another corridor was asked for again.
    expect(ofKind(seen, "state").slice(before).every((s) => s.url.searchParams.get("corridor") === "GBR->PHL")).toBe(true);
  });

  it("choosing a date keeps it in the URL and asks for that date; clearing it returns to the default", async () => {
    mockWidth(1280);
    const seen = recordRequests();
    const { router } = live();
    await findCard("GBR->PHL");
    await within(card("GBR->PHL")).findByRole("table");

    fireEvent.change(dateInput(), { target: { value: FIXTURE_DAY } });

    await waitFor(() => expect(router.state.location.search).toBe(`?date=${FIXTURE_DAY}`));
    await waitFor(() => expect(ofKind(seen, "state").some((s) => s.url.searchParams.get("date") === FIXTURE_DAY)).toBe(true));
    expect(await within(card("GBR->PHL")).findByText("$412,346")).toBeInTheDocument();

    fireEvent.change(dateInput(), { target: { value: "" } });
    await waitFor(() => expect(router.state.location.search).toBe(""));
    await waitFor(() => expect(dateInput()).toHaveValue("2025-08-30"));
  });

  it("the scenario mode fetches the scenarios (not before), lists them, and asks for each corridor with the scenario", async () => {
    mockWidth(1280);
    const seen = recordRequests();
    const user = userEvent.setup();
    const { router } = live(`?date=${FIXTURE_DAY}&corridor=GBR-%3EPHL`);
    await within(await findCard("GBR->PHL")).findByRole("table");
    expect(ofKind(seen, "scenarios")).toHaveLength(0);

    await user.selectOptions(screen.getByRole("combobox", { name: "Mode" }), "scenario");

    await waitFor(() => expect(ofKind(seen, "scenarios")).toHaveLength(1));
    const options = await screen.findByRole("option", { name: "cheapest_venue_outage" });
    expect(options).toBeInTheDocument();
    expect(within(screen.getByRole("combobox", { name: "Scenario" })).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Choose a scenario",
      "baseline",
      "cheapest_venue_outage",
      "combined_stress",
      "congestion_x2",
      "liquidity_minus30",
      "liquidity_minus50",
    ]);
    expect(router.state.location.search).toContain("mode=scenario");
    // Until a scenario is chosen, no state is asked for, and the card says why.
    expect(within(card("GBR->PHL")).getByText("Choose a scenario to see this corridor.")).toBeInTheDocument();

    const requestsBefore = ofKind(seen, "state").length;
    await user.selectOptions(screen.getByRole("combobox", { name: "Scenario" }), "cheapest_venue_outage");

    await waitFor(() => expect(router.state.location.search).toContain("scenarioId=cheapest_venue_outage"));
    await waitFor(() => expect(within(card("GBR->PHL")).getByText(/cheapest_venue_outage/)).toBeInTheDocument());
    const scenarioRequests = ofKind(seen, "state").slice(requestsBefore);
    expect(scenarioRequests).toHaveLength(1);
    expect(Object.fromEntries(scenarioRequests[0]!.url.searchParams)).toMatchObject({
      corridor: "GBR->PHL",
      mode: "scenario",
      date: FIXTURE_DAY,
      scenarioId: "cheapest_venue_outage",
    });
    const rows = venueRows("GBR->PHL");
    expect(within(rows[0]!).getAllByRole("cell")[6]).toHaveTextContent("Synthetic scenario");
    expect(scenarioRequests[0]!.url.searchParams.has("includeHistory")).toBe(false);
  });

  it("leaving the scenario mode drops the scenario from the URL and goes back to replay requests", async () => {
    mockWidth(1280);
    const seen = recordRequests();
    const user = userEvent.setup();
    const { router } = live(`?mode=scenario&scenarioId=baseline&date=${FIXTURE_DAY}&corridor=GBR-%3EPHL`);
    await within(await findCard("GBR->PHL")).findByRole("table");

    await user.selectOptions(screen.getByRole("combobox", { name: "Mode" }), "historicalReplay");

    await waitFor(() => expect(router.state.location.search).toBe(`?date=${FIXTURE_DAY}&corridor=GBR-%3EPHL`));
    await waitFor(() => expect(ofKind(seen, "state").at(-1)!.url.searchParams.get("mode")).toBe("historicalReplay"));
    expect(ofKind(seen, "state").at(-1)!.url.searchParams.has("scenarioId")).toBe(false);
  });

  it("a scenario that is in the URL is used straight away", async () => {
    mockWidth(1280);
    const seen = recordRequests();
    live(`?mode=scenario&scenarioId=baseline&date=${FIXTURE_DAY}&corridor=USA-%3EIND`);
    const c = await findCard("USA->IND");
    await within(c).findByRole("table");
    expect(screen.getByRole("combobox", { name: "Scenario" })).toHaveValue("baseline");
    expect(ofKind(seen, "state")[0]!.url.searchParams.get("scenarioId")).toBe("baseline");
  });
});

describe("Bridge monitor (desktop): date and scenario problems appear at their controls", () => {
  it.each([
    ["a date in an excluded range", "2025-09-15", /excluded range \(2025-08-31 to 2025-09-30\)/],
    ["a date inside a gap buffer", "2023-12-15", /excluded range/],
    ["a date after the data", "2026-01-01", /No data for this date/],
    ["a date before the data", "2010-06-01", /No data for this date/],
  ])("%s is refused at the date control, with no request", async (_name, date, message) => {
    mockWidth(1280);
    const seen = recordRequests();
    live(`?date=${date}`);

    await screen.findByText(message);
    expect(dateInput()).toHaveAttribute("aria-invalid", "true");
    for (const c of CORRIDORS) expect(within(card(c)).getByText("Fix the highlighted selection to see this corridor.")).toBeInTheDocument();
    await delay(40);
    expect(ofKind(seen, "state")).toHaveLength(0);
  });

  it.each([
    ["a date that isn't a date", "?date=soon", "Use the format YYYY-MM-DD."],
    ["a corridor that isn't one", "?corridor=XXX", "Choose one of the listed corridors."],
    ["a mode that isn't one", "?mode=other", "Choose Historical replay or Scenario."],
    ["a scenario with the replay mode", "?scenarioId=baseline", "A scenario can only be used with the Scenario mode."],
    ["a date given twice", "?date=2024-06-14&date=2024-06-15", "Given more than once. Use it once."],
  ])("%s in the URL is reported at its control and nothing is requested", async (_name, search, message) => {
    mockWidth(1280);
    const seen = recordRequests();
    live(search);

    expect(await screen.findByText(message)).toBeInTheDocument();
    await delay(40);
    expect(ofKind(seen, "state")).toHaveLength(0);
  });

  it("a scenario that isn't in the engine's list is refused at the scenario control", async () => {
    mockWidth(1280);
    const seen = recordRequests();
    live(`?mode=scenario&scenarioId=mystery&date=${FIXTURE_DAY}`);

    expect(await screen.findByText(/This scenario isn't in the engine's list/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Scenario" })).toHaveAttribute("aria-invalid", "true");
    await delay(40);
    expect(ofKind(seen, "state")).toHaveLength(0);
  });

  it("the server's DATE_IN_GAP_BUFFER (when the calendar could not say) lands on the date control, not on the cards", async () => {
    mockWidth(1280);
    server.use(http.get("*/api/v1/replay/calendar", () => error("INTERNAL_ERROR", 500)));
    live("?date=2025-09-15");

    expect(await screen.findByText(/within 30 days of a split boundary/)).toBeInTheDocument();
    expect(dateInput()).toHaveAttribute("aria-invalid", "true");
    for (const c of CORRIDORS) {
      expect(await within(card(c)).findByText(/Not shown: the date can't be used/)).toBeInTheDocument();
      expect(within(card(c)).queryByRole("alert")).not.toBeInTheDocument();
      expect(within(card(c)).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    }
  });

  it("the server's DATE_OUT_OF_RANGE lands on the date control", async () => {
    mockWidth(1280);
    server.use(http.get("*/api/v1/replay/calendar", () => error("INTERNAL_ERROR", 500)));
    live("?date=2030-01-01");
    expect(await screen.findByText(/The engine has no data for this date/)).toBeInTheDocument();
    expect(dateInput()).toHaveAttribute("aria-invalid", "true");
  });

  it("the server's UNKNOWN_SCENARIO lands on the scenario control, and the date control is untouched", async () => {
    mockWidth(1280);
    // The list offers a scenario the engine then refuses.
    server.use(scenariosHandler({ scenarios: [{ scenarioId: "mystery", description: "Not known to the engine." }] }));
    live(`?mode=scenario&scenarioId=mystery&date=${FIXTURE_DAY}&corridor=GBR-%3EPHL`);

    expect(await screen.findByText(/The engine doesn't know this scenario/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Scenario" })).toHaveAttribute("aria-invalid", "true");
    expect(dateInput()).not.toHaveAttribute("aria-invalid", "true");
    expect(await within(card("GBR->PHL")).findByText(/Not shown: the scenario can't be used/)).toBeInTheDocument();
  });

  it("a VALIDATION_ERROR that names the date goes to the date control with the server's message", async () => {
    mockWidth(1280);
    server.use(
      http.get("*/api/v1/state", () =>
        error("VALIDATION_ERROR", 422, { errors: [{ field: "date", message: "Must be a calendar date, YYYY-MM-DD." }] }),
      ),
    );
    live(`?date=${FIXTURE_DAY}`);
    expect(await screen.findByText("Must be a calendar date, YYYY-MM-DD.")).toBeInTheDocument();
    expect(dateInput()).toHaveAttribute("aria-invalid", "true");
  });

  it("fixing the date asks again, and the cards fill in", async () => {
    mockWidth(1280);
    const seen = recordRequests();
    live("?date=2025-09-15");
    await screen.findByText(/excluded range/);

    fireEvent.change(dateInput(), { target: { value: FIXTURE_DAY } });

    for (const c of CORRIDORS) await within(card(c)).findByRole("table");
    expect(ofKind(seen, "state")).toHaveLength(3);
  });

  it("the scenarios list failing is reported at the scenario control, and retried there alone", async () => {
    mockWidth(1280);
    let scenarioCalls = 0;
    let calendarCalls = 0;
    server.use(
      http.get("*/api/v1/replay/calendar", () => {
        calendarCalls += 1;
        return HttpResponse.json(fixtureCalendar());
      }),
      http.get("*/api/v1/scenarios", () => {
        scenarioCalls += 1;
        return scenarioCalls === 1
          ? error("INTERNAL_ERROR", 500)
          : HttpResponse.json({ scenarios: [{ scenarioId: "baseline", description: "Unmodified." }] });
      }),
    );
    const user = userEvent.setup();
    live(`?mode=scenario&date=${FIXTURE_DAY}&corridor=GBR-%3EPHL`);

    expect(await screen.findByText("The server hit an unexpected error. Try again in a moment.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Scenario" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("option", { name: "baseline" })).toBeInTheDocument();
    expect(scenarioCalls).toBe(2);
    expect(calendarCalls).toBe(1);
  });
});

describe("Bridge monitor (desktop): each corridor loads, fails and retries on its own", () => {
  it("shows a loading state per corridor, and each card fills in as its own answer arrives", async () => {
    mockWidth(1280);
    server.use(
      http.get("*/api/v1/state", async ({ request }) => {
        const corridor = new URL(request.url).searchParams.get("corridor")!;
        await delay(corridor === "USA->IND" ? 10 : 150);
        return HttpResponse.json(generatedState(corridor, "historicalReplay", FIXTURE_DAY, null));
      }),
    );
    live(`?date=${FIXTURE_DAY}`);

    await within(await findCard("USA->IND")).findByRole("table");
    // USA→IND is in; the others are still loading.
    expect(within(card("GBR->PHL")).getByRole("status")).toHaveTextContent("Loading GBR → PHL");
    expect(within(card("ARE->MEX")).getByRole("status")).toHaveTextContent("Loading ARE → MEX");
    await within(card("GBR->PHL")).findByRole("table");
    await within(card("ARE->MEX")).findByRole("table");
  });

  it("one corridor failing shows its own error with its request ID, leaves the others, and retries only itself", async () => {
    mockWidth(1280);
    const calls: Record<string, number> = { "USA->IND": 0, "GBR->PHL": 0, "ARE->MEX": 0 };
    server.use(
      http.get("*/api/v1/state", ({ request }) => {
        const corridor = new URL(request.url).searchParams.get("corridor")!;
        calls[corridor] = (calls[corridor] ?? 0) + 1;
        if (corridor === "USA->IND" && calls[corridor] === 1) return error("INTERNAL_ERROR", 500, {}, "req-usa");
        return HttpResponse.json(generatedState(corridor, "historicalReplay", FIXTURE_DAY, null));
      }),
    );
    const user = userEvent.setup();
    live(`?date=${FIXTURE_DAY}`);

    const alert = await within(await findCard("USA->IND")).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load USA → IND");
    expect(alert).toHaveTextContent("The server hit an unexpected error");
    expect(alert).toHaveTextContent("req-usa");
    expect(alert).not.toHaveTextContent("BACKEND TEXT");
    await within(card("GBR->PHL")).findByRole("table");
    await within(card("ARE->MEX")).findByRole("table");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    await delay(60);
    expect(calls).toEqual({ "USA->IND": 1, "GBR->PHL": 1, "ARE->MEX": 1 }); // nothing retried by itself

    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    await within(card("USA->IND")).findByRole("table");
    expect(calls).toEqual({ "USA->IND": 2, "GBR->PHL": 1, "ARE->MEX": 1 });
  });

  it("all three can fail in different ways, each with its own message and retry", async () => {
    mockWidth(1280);
    server.use(
      http.get("*/api/v1/state", ({ request }) => {
        const corridor = new URL(request.url).searchParams.get("corridor")!;
        if (corridor === "USA->IND") return HttpResponse.error();
        if (corridor === "GBR->PHL") return error("INFERENCE_UNAVAILABLE", 503, { cause: "NOT_READY" });
        return HttpResponse.json({ hello: "world" });
      }),
    );
    live(`?date=${FIXTURE_DAY}`);

    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(3));
    expect(card("USA->IND")).toHaveTextContent("The server could not be reached");
    expect(card("GBR->PHL")).toHaveTextContent("starting up");
    expect(card("ARE->MEX")).toHaveTextContent("a response this page couldn't read");
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(3);
  });

  it("refuses a state for another corridor, date or scenario instead of showing it under this heading", async () => {
    mockWidth(1280);
    server.use(
      http.get("*/api/v1/state", () => HttpResponse.json(generatedState("USA->IND", "historicalReplay", FIXTURE_DAY, null))),
    );
    live(`?date=${FIXTURE_DAY}&corridor=GBR-%3EPHL`);
    expect(await within(await findCard("GBR->PHL")).findByRole("alert")).toHaveTextContent("couldn't read");
    expect(within(card("GBR->PHL")).queryByRole("table")).not.toBeInTheDocument();
  });

  it("refuses a state with a negative liquidity as unreadable", async () => {
    mockWidth(1280);
    const bad = fixtureReplayState();
    (bad.venues[0] as Record<string, unknown>).liquidityUsd = -5;
    server.use(http.get("*/api/v1/state", () => HttpResponse.json(bad)));
    live(`?date=${FIXTURE_DAY}&corridor=GBR-%3EPHL`);
    expect(await within(await findCard("GBR->PHL")).findByRole("alert")).toHaveTextContent("couldn't read");
  });

  it("an UNSUPPORTED_CORRIDOR is a card error with no retry", async () => {
    mockWidth(1280);
    server.use(http.get("*/api/v1/state", () => error("UNSUPPORTED_CORRIDOR", 422, { field: "corridor" })));
    live(`?date=${FIXTURE_DAY}&corridor=GBR-%3EPHL`);
    const alert = await within(await findCard("GBR->PHL")).findByRole("alert");
    expect(alert).toHaveTextContent("doesn't support GBR->PHL");
    expect(within(alert).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("ends the session on a 401 from a state request", async () => {
    mockWidth(1280);
    sessionStorage.setItem(SESSION_TOKEN_KEY, "mock-analyst");
    server.use(http.get("*/api/v1/state", () => error("UNAUTHENTICATED", 401)));
    const { router } = renderRoute(`/bridges?date=${FIXTURE_DAY}`, { auth: "real", data: "live" });

    expect(await screen.findByText("Your session has ended")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/sign-in"));
    expect(sessionStorage.getItem(SESSION_TOKEN_KEY)).toBeNull();
  });
});

describe("Bridge monitor (desktop): the calendar", () => {
  it("while the calendar loads and there is no date, the cards say so, and nothing is asked for", async () => {
    mockWidth(1280);
    const seen: Seen[] = [];
    server.use(
      http.get("*/api/v1/replay/calendar", async () => {
        await delay(100);
        return HttpResponse.json(fixtureCalendar());
      }),
      stateHandler({ onRequest: (url, authorization) => seen.push({ kind: "state", url, authorization }) }),
    );
    live();

    expect(within(card("GBR->PHL")).getByText("Loading the available dates…")).toBeInTheDocument();
    expect(seen).toHaveLength(0);
    await within(await findCard("GBR->PHL")).findByRole("table");
  });

  it("a failed calendar with a date in the URL is a warning only: the cards still load, and it retries alone", async () => {
    mockWidth(1280);
    let calendarCalls = 0;
    const states: string[] = [];
    server.use(
      http.get("*/api/v1/replay/calendar", () => {
        calendarCalls += 1;
        return calendarCalls === 1 ? error("INTERNAL_ERROR", 500) : HttpResponse.json(fixtureCalendar());
      }),
      stateHandler({ onRequest: (url) => states.push(url.pathname) }),
    );
    const user = userEvent.setup();
    live(`?date=${FIXTURE_DAY}`);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the calendar");
    expect(alert).toHaveTextContent("Date hints are unavailable");
    for (const c of CORRIDORS) await within(await findCard(c)).findByRole("table");
    expect(states).toHaveLength(3);

    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(screen.queryByText("Couldn't load the calendar")).not.toBeInTheDocument());
    expect(calendarCalls).toBe(2);
    expect(states).toHaveLength(3); // the corridors were not asked again
    expect(dateInput()).toHaveAttribute("min", "2011-01-01");
  });

  it("a failed calendar with no date leaves the cards waiting, and choosing a date lets them load", async () => {
    mockWidth(1280);
    server.use(http.get("*/api/v1/replay/calendar", () => error("INTERNAL_ERROR", 500)));
    live();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Without it there is no default date: choose one below");
    for (const c of CORRIDORS) expect(within(card(c)).getByText("Choose a date to see this corridor.")).toBeInTheDocument();

    fireEvent.change(dateInput(), { target: { value: FIXTURE_DAY } });
    for (const c of CORRIDORS) await within(card(c)).findByRole("table");
  });

  it("treats a calendar that isn't one as an error, and picks no default from it", async () => {
    mockWidth(1280);
    const seen = recordRequests();
    server.use(calendarHandler({ start: "2011-01-01", end: "2025-09-30" })); // no excluded ranges list
    live();

    expect(await screen.findByText(/Couldn't load the calendar/)).toBeInTheDocument();
    expect(dateInput()).toHaveValue("");
    await delay(40);
    expect(ofKind(seen, "state")).toHaveLength(0);
  });
});

describe("preview mode and the narrow layout are unchanged", () => {
  it("preview mode shows the globe, the 'not connected' notice and no cards, with no request", async () => {
    mockWidth(1280);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderRoute("/bridges", { data: "preview" });

    expect(screen.getByTestId("globe")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.queryByText("Live data")).not.toBeInTheDocument();
    expect(screen.getByText("The monitor's data isn't connected yet")).toBeInTheDocument();
    expect(screen.getByText("Simulated")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Corridor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Bridge state/ })).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("preview mode ignores a corridor, date or scenario in the URL, and still makes no request", () => {
    mockWidth(1280);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderRoute(`/bridges?corridor=GBR-%3EPHL&date=${FIXTURE_DAY}&mode=scenario&scenarioId=baseline`, { data: "preview" });
    expect(screen.getByText("The monitor's data isn't connected yet")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([1023, 768, 375])("below 1024px (%ipx) it is the unchanged placeholder: no globe, no controls, no cards, no request", (width) => {
    mockWidth(width);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    live(`?date=${FIXTURE_DAY}`);

    expect(screen.getByText("This screen isn't connected yet")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Endpoints" })).toHaveTextContent("GET /api/v1/state");
    expect(screen.queryByTestId("globe")).not.toBeInTheDocument();
    expect(globeRenders).not.toHaveBeenCalled(); // the 3D code is never loaded
    expect(screen.queryByRole("combobox", { name: "Corridor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Bridge state/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Live data")).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("without matchMedia (as in jsdom) it is the placeholder, with no request", () => {
    // @ts-expect-error: simulating an environment with no matchMedia
    window.matchMedia = undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    live();
    expect(screen.getByText("This screen isn't connected yet")).toBeInTheDocument();
    expect(globeRenders).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
