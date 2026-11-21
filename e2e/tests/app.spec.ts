import { expect, test, type Page } from "@playwright/test";
import { analystToken, signIn, watchBrowser, type Watch } from "./helpers";

// Browser-level checks of the real app behind nginx, against the running Compose stack (seeded).
// Selectors follow what the app renders: the "Development token" field, the "Main" navigation,
// the "Result" region and the table named "Transactions". The transaction is the contract's
// waterfall replay scenario (GBR -> PHL, 300000 USD, replay date 2024-06-14).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });
const heading = (page: Page, name: string) => page.getByRole("heading", { level: 1, name });

test("an unauthenticated visitor is sent to the sign-in page", async ({ page }) => {
  const watch = watchBrowser(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole("heading", { level: 2, name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: /Liquidity routing/ })).toBeVisible();
  await expect(page.getByRole("note").filter({ hasText: "Development authentication" })).toBeVisible();
  await expect(page.getByLabel(/Development token/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

  // A protected page is guarded the same way.
  await page.goto("/transactions/new");
  await expect(page).toHaveURL(/\/sign-in$/);
  watch.assertClean();
});

// These tests depend on each other, in this order: they share one signed-in page and the transaction the
// form test creates (the History and deep-link tests look for it). If one fails, the rest are skipped.
test.describe("signed in as the analyst", () => {
  test.describe.configure({ mode: "serial" });

  let page: Page;
  let watch: Watch;
  let token = "";
  let transactionId = "";

  test.beforeAll(async ({ browser }) => {
    token = analystToken();
    page = await browser.newPage();
    watch = watchBrowser(page, [token]);
  });

  test.afterEach(() => watch.assertClean());

  test.afterAll(async () => {
    await page.close();
  });

  test("signing in reaches the dashboard through the real backend", async () => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/sign-in$/);

    const identity = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/v1/auth/me");
    await signIn(page, token); // empties the token field as soon as the form is submitted (see helpers.ts)
    expect((await identity).status()).toBe(200);

    await expect(page).toHaveURL(/\/$/);
    await expect(heading(page, "Dashboard")).toBeVisible();
    // The session panel is in the desktop sidebar (the mobile menu keeps a hidden copy, so scope to the sidebar).
    const sidebar = page.getByRole("complementary");
    await expect(sidebar.getByText("Role:")).toContainText("analyst");
    await expect(sidebar.getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  test("the token is kept only in sessionStorage, never in the URL, cookies or the page", async () => {
    const storage = await page.evaluate(() => ({
      session: Object.keys(window.sessionStorage),
      localCount: window.localStorage.length,
      cookies: document.cookie,
      html: document.documentElement.outerHTML,
    }));
    expect(storage.session).toContain("cbdc.devToken");
    expect(storage.localCount).toBe(0);
    expect(storage.cookies).toBe("");
    // Booleans only: a failed assertion must not print the page or the token.
    expect(storage.html.includes(token)).toBe(false);
    expect(page.url().includes(token)).toBe(false);
  });

  test("the sidebar navigates to History, Network and New transaction", async () => {
    await nav(page).getByRole("link", { name: "History" }).click();
    await expect(page).toHaveURL(/\/transactions$/);
    await expect(heading(page, "History")).toBeVisible();
    // A table once something is stored, the empty state before.
    await expect(page.getByRole("table", { name: "Transactions" }).or(page.getByText("No transactions yet"))).toBeVisible();

    await nav(page).getByRole("link", { name: "Network" }).click();
    await expect(page).toHaveURL(/\/network$/);
    await expect(heading(page, "Network")).toBeVisible();
    await expect(page.getByRole("region", { name: "Single-transfer limit" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Corridor GBR → PHL" })).toBeVisible();

    await nav(page).getByRole("link", { name: "New transaction" }).click();
    await expect(page).toHaveURL(/\/transactions\/new$/);
    await expect(heading(page, "New transaction")).toBeVisible();
    await expect(page.getByRole("region", { name: "New transaction form" })).toBeVisible();
  });

  test("routing a transaction through the form shows a successful result", async () => {
    const form = page.getByRole("region", { name: "New transaction form" });
    await expect(form).toBeVisible();

    // The options come from the API; wait for the corridor to be offered.
    const corridor = form.getByLabel("Corridor");
    await expect(corridor.locator("option", { hasText: "GBR → PHL" })).toHaveCount(1);
    await corridor.selectOption({ label: "GBR → PHL" });
    await form.getByLabel("Amount (USD)").fill("300000");
    await form.getByLabel("Date").fill("2024-06-14");
    // Defaults: policy Waterfall, state mode Historical replay.
    await expect(form.getByLabel("Policy")).toHaveValue("waterfall");
    await expect(form.getByLabel("State mode")).toHaveValue("historicalReplay");

    const created = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/transactions");
    await form.getByRole("button", { name: "Route transaction" }).click();
    expect((await created).status()).toBe(201);

    const result = page.getByRole("region", { name: "Result" });
    await expect(result).toBeVisible();
    await expect(page.getByText("Routed and fully executed")).toBeVisible();
    await expect(result.getByText("$300,000").first()).toBeVisible();
    transactionId = (await result.locator("dd").first().innerText()).trim();
    expect(transactionId).toMatch(UUID);
    await expect(result.getByRole("link", { name: "View transaction" })).toBeVisible();
  });

  test("the new transaction is listed in History", async () => {
    expect(transactionId).not.toBe("");
    await nav(page).getByRole("link", { name: "History" }).click();
    const table = page.getByRole("table", { name: "Transactions" });
    await expect(table).toBeVisible();
    await expect(table.getByRole("link", { name: `View transaction ${transactionId.split("-")[0]}` })).toBeVisible();
  });

  test("nested routes survive a full page load and a reload (nginx serves the app)", async () => {
    expect(transactionId).not.toBe("");
    for (const path of ["/transactions", `/transactions/${transactionId}`]) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      expect(response?.headers()["content-type"]).toContain("text/html");
      await expect(page).toHaveURL(new RegExp(`${path}$`));
    }
    // The last route is the transaction's own page; reload it too.
    await expect(heading(page, "Transaction details")).toBeVisible();
    await expect(page.getByText(transactionId).first()).toBeVisible();
    await page.reload();
    await expect(heading(page, "Transaction details")).toBeVisible();
    await expect(page.getByText(transactionId).first()).toBeVisible();
  });
});
