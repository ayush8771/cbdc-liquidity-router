import { execFileSync } from "node:child_process";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { analystToken, signIn, watchBrowser } from "./helpers";

// AD-1 v0.5 section 6 items 2, 8 and 9 and AD-6 T-2, T-3 and T-10, in a real browser against disposable stacks.
// Run by e2e/p3_browser_acceptance.py, which builds one stack per build flavour and selects tests by tag:
//   @on       web built with VITE_OBSERVATIONS=on, with the test-only fake ingestion (E2E_STACK_PROJECT, E2E_STACK_ROOT steer its faults)
//   @off      web built with VITE_OBSERVATIONS=off (the default build)
// Nothing here is skipped: a tag that is not selected is simply not run.

const STREAM = "/api/rt/v1/observations/stream";
const PAIRS = ["EUR/USD", "GBP/PHP", "USD/INR"];
const PYTHON = process.env.E2E_PYTHON ?? "python";
const SOAK_SECONDS = Number(process.env.E2E_SOAK_SECONDS ?? 300);
const FORBIDDEN = /live routing|routing on live data|real-time optimal route|real-time data|market data|\blive\b/i;

/** Sets the fake ingestion's scenario through the stack harness (docker compose exec, no shell). */
function fault(scenario: string): void {
  const project = process.env.E2E_STACK_PROJECT;
  const root = process.env.E2E_STACK_ROOT;
  if (!project || !root) throw new Error("E2E_STACK_PROJECT and E2E_STACK_ROOT are required for the fault tests.");
  execFileSync(PYTHON, [process.env.E2E_P3_STACK ?? "../infra/scripts/p3_stack.py", "fault", "--root", root, "--project", project, "--scenario", scenario], { stdio: "pipe", timeout: 60_000 });
}

/** Counts stream requests: started, and still open (neither finished nor failed). */
function trackStreams(page: Page) {
  const seen = { started: 0, ended: 0, urls: [] as string[], other: [] as string[] };
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (path === STREAM) { seen.started++; seen.urls.push(r.url()); }
    if (path.startsWith("/api/rt/") && path !== STREAM) seen.other.push(path);
  });
  const end = (r: { url(): string }) => { if (new URL(r.url()).pathname === STREAM) seen.ended++; };
  page.on("requestfinished", end);
  page.on("requestfailed", end);
  return { ...seen, get started() { return seen.started; }, get open() { return seen.started - seen.ended; }, get urls() { return seen.urls; }, get other() { return seen.other; } };
}

/** Records every request to the observation path and every transaction or comparison POST. */
function trackRequests(page: Page) {
  const rt: string[] = [];
  const routing: string[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith("/api/rt/")) rt.push(url.pathname);
    if (r.method() === "POST" && /^\/api\/v1\/(transactions|comparisons)/.test(url.pathname)) routing.push(url.pathname);
  });
  return { rt, routing };
}

const panel = (page: Page) => page.getByTestId("observation-panel");
const rows = (page: Page) => panel(page).getByRole("table").locator("tbody tr");
const cells = async (row: Locator) => (await row.locator("td").allInnerTexts()).map((c) => c.trim());
const status = (page: Page) => panel(page).getByRole("status");

async function signedIn(browser: Browser, token: string, viewport = { width: 1280, height: 800 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const watch = watchBrowser(page, [token]);
  const streams = trackStreams(page);
  const requests = trackRequests(page);
  await page.goto("/");
  await signIn(page, token);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  return { context, page, watch, streams, requests };
}

async function hide(page: Page, hidden: boolean) {
  await page.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

// --- flag on ---------------------------------------------------------------------------------------------------------

test.describe("@on the observation panel", () => {
  test.describe.configure({ mode: "serial" });
  let session: Awaited<ReturnType<typeof signedIn>>;
  let token = "";

  test.beforeAll(async ({ browser }) => {
    token = analystToken();
    fault("normal");
    session = await signedIn(browser, token);
  });
  test.afterAll(async () => {
    fault("normal");
    await session.context.close();
  });
  test.afterEach(() => session.watch.assertClean());

  test("@on the panel shows SIMULATED labels, source, transport and a growing age for every pair", async () => {
    const { page } = session;
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByText("Simulated FX observations").first()).toBeVisible();
    await expect(panel(page).getByText("Observations are shown for context. They do not affect routing.")).toBeVisible();
    await expect(status(page)).toContainText("Receiving");
    await expect(rows(page)).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      const [pair, rate, label, age, source, transport] = await cells(rows(page).nth(i));
      expect(pair).toMatch(/^[A-Z]{3}\/[A-Z]{3}$/);
      expect(rate).toMatch(/^\d/);
      expect(label).toBe("SIMULATED");
      expect(age).toMatch(/^\d+ s$/);
      expect(source).toMatch(/^synthetic\./);
      expect(transport).toBe("synthetic");
    }
    await expect(panel(page).getByText("Source synthetic", { exact: false }).first()).toContainText("ok");
    expect(await panel(page).innerText()).not.toMatch(FORBIDDEN);
    expect(session.streams.started).toBe(1);
    // The age advances between messages without any user action.
    const first = await cells(rows(page).first());
    await expect.poll(async () => (await cells(rows(page).first()))[3], { timeout: 10_000 }).not.toBe(first[3]);
  });

  test(`@on five minutes of streaming: one connection, always SIMULATED and fresh, rates keep changing, no routing call`, async () => {
    test.setTimeout((SOAK_SECONDS + 90) * 1000);
    const { page, streams, requests } = session;
    const distinct = new Map<string, Set<string>>();
    const routingBefore = requests.routing.length;
    const startedBefore = streams.started;
    let samples = 0;
    let maxAge = 0;
    const end = Date.now() + SOAK_SECONDS * 1000;
    while (Date.now() < end) {
      await expect(rows(page)).toHaveCount(4);
      for (let i = 0; i < 4; i++) {
        const [pair, rate, label, age, source, transport] = await cells(rows(page).nth(i));
        expect(label, `${pair} label`).toBe("SIMULATED");
        expect(source).toMatch(/^synthetic\./);
        expect(transport).toBe("synthetic");
        maxAge = Math.max(maxAge, parseInt(age, 10));
        (distinct.get(pair) ?? distinct.set(pair, new Set()).get(pair)!).add(rate);
      }
      await expect(status(page)).toContainText("Receiving");
      samples++;
      await page.waitForTimeout(5000);
    }
    expect(samples).toBeGreaterThanOrEqual(Math.floor(SOAK_SECONDS / 6));
    expect(maxAge).toBeLessThanOrEqual(6); // fresh means at most stale_after_ms (6 s)
    expect(distinct.size).toBe(4);
    for (const [pair, rates] of distinct) expect(rates.size, `${pair} produced new rates`).toBeGreaterThanOrEqual(Math.min(5, Math.floor(samples / 2)));
    expect(streams.started - startedBefore, "no reconnect during the soak").toBe(0);
    expect(streams.open).toBe(1);
    expect(requests.routing.length - routingBefore, "events triggered no routing request (T-2, AD6-Q1)").toBe(0);
    test.info().annotations.push({ type: "soak", description: `${samples} samples over ${SOAK_SECONDS} s, max age ${maxAge} s` });
  });

  test("@on fresh, stale, unavailable and recovery", async () => {
    test.setTimeout(150_000);
    const { page } = session;
    const labels = async () => Promise.all([0, 1, 2, 3].map(async (i) => (await cells(rows(page).nth(i)))[2]));
    const rates = async () => Promise.all([0, 1, 2, 3].map(async (i) => (await cells(rows(page).nth(i)))[1]));

    fault("stale");
    await expect.poll(labels, { timeout: 40_000 }).toEqual(Array(4).fill("SIMULATED · stale"));
    expect((await rates()).every((r) => /^\d/.test(r)), "a stale value keeps its number").toBe(true);

    fault("normal");
    await expect.poll(labels, { timeout: 40_000 }).toEqual(Array(4).fill("SIMULATED"));

    fault("unavailable");
    await expect.poll(labels, { timeout: 60_000 }).toEqual(Array(4).fill("Unavailable"));
    expect(await rates(), "an unavailable value shows no number").toEqual(Array(4).fill("Unavailable"));
    for (let i = 0; i < 4; i++) expect((await cells(rows(page).nth(i))).slice(3)).toEqual(["", "", ""]); // no age, source or transport either

    fault("normal");
    await expect.poll(labels, { timeout: 40_000 }).toEqual(Array(4).fill("SIMULATED"));
    await expect(status(page)).toContainText("Source synthetic");
    await expect(page.getByText("The simulated source reports an outage")).toHaveCount(0);

    // A source outage is shown, and recovery clears it.
    fault("http:503");
    await expect(page.getByText("The simulated source reports an outage")).toBeVisible({ timeout: 40_000 });
    await expect(status(page)).toContainText("outage");
    fault("normal");
    await expect(page.getByText("The simulated source reports an outage")).toHaveCount(0, { timeout: 40_000 });
    await expect.poll(labels, { timeout: 40_000 }).toEqual(Array(4).fill("SIMULATED"));
    expect(session.streams.started, "the faults needed no reconnect").toBe(1);
  });

  test("@on a hidden tab aborts the stream at once and a visible one reconnects once", async () => {
    const { page, streams } = session;
    const started = streams.started;
    await hide(page, true);
    await expect(status(page)).toContainText("Paused (tab hidden)");
    await expect.poll(() => streams.open, { timeout: 3000 }).toBe(0);
    await hide(page, false);
    await expect(status(page)).toContainText("Receiving");
    expect(streams.started - started, "exactly one new stream").toBe(1);
    expect(streams.open).toBe(1);
    await expect(rows(page)).toHaveCount(4);
  });

  test("@on leaving the dashboard closes the stream, and returning opens exactly one", async () => {
    const { page, streams } = session;
    const started = streams.started;
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "History" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "History" })).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    await expect.poll(() => streams.open, { timeout: 3000 }).toBe(0);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Dashboard" }).click();
    await expect(panel(page)).toBeVisible();
    await expect(status(page)).toContainText("Receiving");
    expect(streams.started - started).toBe(1);
    expect(streams.open).toBe(1);
    // A reload also leaves one open stream, not two.
    await page.reload();
    await expect(status(page)).toContainText("Receiving");
    expect(streams.open).toBe(1);
    expect(streams.urls.every((u) => !u.includes("?") && !u.includes(token)), "the token is never in the stream URL").toBe(true);
  });

  test("@on T-3: events change no form field, and the routing workflow is unchanged (T-10: no converted currency)", async ({ browser }) => {
    test.setTimeout(150_000);
    // The dashboard page keeps its stream open and receives events while a second signed-in tab uses the form.
    const { page: dash, streams } = session;
    await expect(status(dash)).toContainText("Receiving");
    const second = await signedIn(browser, token);
    try {
      const { page } = second;
      await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "New transaction" }).click();
      const form = page.getByRole("region", { name: "New transaction form" });
      await expect(form).toBeVisible();
      await expect(panel(page)).toHaveCount(0);
      const corridor = form.getByLabel("Corridor");
      await expect(corridor.locator("option", { hasText: "GBR → PHL" })).toHaveCount(1);
      const snapshot = async () => ({
        corridor: await corridor.inputValue(), amount: await form.getByLabel("Amount (USD)").inputValue(), date: await form.getByLabel("Date").inputValue(),
        policy: await form.getByLabel("Policy").inputValue(), mode: await form.getByLabel("State mode").inputValue(),
        html: (await form.innerHTML()).replace(/\s+/g, " ")});
      const before = await snapshot();
      const dashRates = async () => (await cells(rows(dash).first()))[1];
      const rateBefore = await dashRates();
      for (const s of ["normal", "extreme", "stale", "normal"]) { fault(s); await dash.waitForTimeout(3000); }
      expect(await dashRates(), "the observation panel did change meanwhile").not.toBe(rateBefore);
      expect(await snapshot(), "no form field, default, option or selection changed").toEqual(before);
      expect(second.requests.routing, "no routing request without the user").toEqual([]);

      await corridor.selectOption({ label: "GBR → PHL" });
      await form.getByLabel("Amount (USD)").fill("300000");
      await form.getByLabel("Date").fill("2024-06-14");
      await expect(form.getByLabel("Policy")).toHaveValue("waterfall");
      await expect(form.getByLabel("State mode")).toHaveValue("historicalReplay");
      const sent = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/v1/transactions");
      const created = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/transactions");
      await form.getByRole("button", { name: "Route transaction" }).click();
      const body = (await sent).postDataJSON();
      expect(Object.keys(body).sort(), "the request carries exactly the form's fields").toEqual(["amountUsd", "policy", "receiverCountry", "senderCountry", "state"]);
      expect(JSON.stringify(body)).not.toMatch(/synthetic|observation|EUR|INR|PHP/i);
      expect((await created).status()).toBe(201);
      const result = page.getByRole("region", { name: "Result" });
      await expect(page.getByText("Routed and fully executed")).toBeVisible();
      await expect(result.getByText("$300,000").first()).toBeVisible();
      // T-10: the result is in USD only; no observed rate, currency code or symbol appears in it.
      const text = await result.innerText();
      expect(text).not.toMatch(/\b(EUR|GBP|PHP|INR)\b|[€£₱₹]/);
      expect(text).not.toMatch(/convert|exchange rate|FX/i);
      expect(second.streams.started, "the form tab opened no observation stream").toBe(1); // only its own dashboard visit
      second.watch.assertClean();
    } finally {
      await second.context.close();
    }
    expect(streams.open).toBe(1);
  });

  test("@on signing out closes the stream", async () => {
    const { page, streams } = session;
    await expect(status(page)).toContainText("Receiving");
    await page.getByRole("complementary").getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect.poll(() => streams.open, { timeout: 3000 }).toBe(0);
  });
});

test.describe("@on narrow screens", () => {
  test("@on below 1024 px there is no panel and no stream, and the page does not scroll sideways; at 1024 px the panel fits", async ({ browser }) => {
    const token = analystToken();
    fault("normal");
    const narrow = await signedIn(browser, token, { width: 390, height: 844 });
    try {
      await narrow.page.waitForTimeout(4000);
      await expect(panel(narrow.page)).toHaveCount(0);
      expect(narrow.streams.started, "the narrow dashboard opens no observation stream").toBe(0);
      expect(await narrow.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      narrow.watch.assertClean();
    } finally {
      await narrow.context.close();
    }
    const edge = await signedIn(browser, token, { width: 1024, height: 768 });
    try {
      await expect(panel(edge.page)).toBeVisible();
      await expect(rows(edge.page)).toHaveCount(4);
      expect(await edge.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal page scroll at 1024 px").toBe(true);
      expect(edge.streams.started).toBe(1);
      edge.watch.assertClean();
    } finally {
      await edge.context.close();
    }
  });
});

// --- flag off and preview ------------------------------------------------------------------------------------------

// @preview needs a bundle built with VITE_API_MODE=preview, which the web Dockerfile cannot do (no build argument). p3_browser_acceptance.py
// builds it in a throwaway Node container from the unmodified sources and copies it into the stack's nginx; the notice below proves the mode.
const PREVIEW_NOTICE = "Preview data — illustrative, not from the API";
for (const mode of ["off", "preview"] as const) {
  test(`@${mode} no observation panel and no stream or /api/rt request, on any screen, with the backend ${mode === "off" ? "able to serve it" : "in preview mode"}`, async ({ browser }) => {
    test.setTimeout(120_000);
    const token = analystToken();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const watch = watchBrowser(page, [token]);
    const requests = trackRequests(page);
    const streams = trackStreams(page);
    try {
      await page.goto("/");
      const tokenField = page.getByLabel(/Development token/);
      await tokenField.or(page.getByRole("heading", { level: 1, name: "Dashboard" })).first().waitFor();
      if (await tokenField.count()) await signIn(page, token);
      await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
      if (mode === "preview") await expect(page.getByText(PREVIEW_NOTICE)).toBeVisible(); // the app really is in preview mode
      else await expect(page.getByText(PREVIEW_NOTICE)).toHaveCount(0);
      await page.waitForTimeout(5000);
      for (const link of ["History", "Network", "New transaction", "Dashboard"]) {
        await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: link }).click();
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(3000);
      await expect(panel(page)).toHaveCount(0);
      if (mode === "preview") await expect(page.getByText(PREVIEW_NOTICE)).toBeVisible();
      await expect(page.getByText("Simulated FX observations")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Retry now" })).toHaveCount(0);
      expect(requests.rt, "no request to /api/rt").toEqual([]);
      expect(streams.started).toBe(0);
      watch.assertClean();
    } finally {
      await context.close();
    }
  });
}
