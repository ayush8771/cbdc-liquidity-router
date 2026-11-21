import { defineConfig, devices } from "@playwright/test";

// Browser tests for the Phase 2 stack (Compose full profile). They drive the real React app behind
// nginx and never start a dev server. Nothing here records the page: trace, screenshot and video are
// off, because a recording of the sign-in screen could contain the development token.
//
//   E2E_BASE_URL      where the web service is published (default http://127.0.0.1:8080)
//   E2E_TOKENS_FILE   JSON file with the disposable analyst token (see README.md); required
//   E2E_OUTPUT_DIR    where Playwright writes its output (default test-results, git-ignored)
//   E2E_ALLOW_REMOTE  set to 1 to allow a base URL that is not a loopback address

// Playwright writes error-context.md for a failed test, and it can contain a page snapshot that lists form field
// values (the typed token). This switch stops the snapshot taken when a test ends (checked on 1.64.1). It is
// only one layer: a failing expect(locator) attaches its own snapshot regardless, so signIn() in tests/helpers.ts
// empties the token field as soon as the form is submitted, and CI deletes the output directory.
process.env.PLAYWRIGHT_NO_COPY_PROMPT ??= "1";

const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:8080";
const host = new URL(baseURL).hostname;
if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host) && process.env.E2E_ALLOW_REMOTE !== "1") {
  throw new Error(`Refusing to run against ${host}: these tests create data, so they only target a loopback address (set E2E_ALLOW_REMOTE=1 to override).`);
}

export default defineConfig({
  testDir: "./tests",
  outputDir: process.env.E2E_OUTPUT_DIR ?? "test-results",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // One worker, in order: the flow tests share one signed-in page and the transaction it creates.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  use: {
    baseURL,
    // The data screens are desktop-only from 1024px (the sidebar and the live pages start there).
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timezoneId: "UTC",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } }],
});
