import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

/**
 * The disposable analyst token, read from the private JSON file that phase2-stack.yml generates
 * (outside the checkout). It is never printed, never put in a test title and never in a URL.
 */
export function analystToken(): string {
  const file = process.env.E2E_TOKENS_FILE;
  if (!file) throw new Error("E2E_TOKENS_FILE must name the JSON file with the disposable analyst token (see e2e/README.md).");
  let token: unknown;
  try {
    token = JSON.parse(readFileSync(file, "utf-8"))?.analyst?.token;
  } catch {
    // Deliberately generic: a JSON parse error can quote part of the file.
    throw new Error("E2E_TOKENS_FILE could not be read as JSON.");
  }
  if (typeof token !== "string" || token.length < 16) throw new Error("E2E_TOKENS_FILE has no usable analyst token.");
  return token;
}

/** An error with every occurrence of the secrets replaced, and a stack that cannot carry them. */
export function scrubbed(error: unknown, secrets: string[]): Error {
  let text = error instanceof Error ? error.message : String(error);
  for (const s of secrets) if (s) text = text.split(s).join("***");
  const clean = new Error(text);
  clean.stack = `Error: ${text}`;
  return clean;
}

/**
 * Runs an action that handles a secret. A failure is re-thrown with the secret removed. This is
 * defence in depth: Playwright 1.64.1 was not seen to quote the typed text in a failed `fill`, but a
 * later version, a custom matcher or the app could put the value in an error message.
 */
export async function handlingSecret<T>(secret: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw scrubbed(error, [secret]);
  }
}

/**
 * Types the token into the sign-in form and submits it, then empties the field at once.
 *
 * Playwright's failure snapshots (error-context.md) list the value of every form field, and no setting
 * switches all of them off: PLAYWRIGHT_NO_COPY_PROMPT stops the page snapshot taken when a test ends, but a
 * failing `expect(locator)` on a missing element attaches its own snapshot at the moment it fails (checked
 * on Playwright 1.64.1). The submit has already taken the token, so the field is emptied in `finally`:
 * whatever fails afterwards, the page no longer holds it.
 */
export async function signIn(page: Page, token: string): Promise<void> {
  const field = page.getByLabel(/Development token/);
  try {
    await handlingSecret(token, async () => {
      await field.fill(token);
      await page.getByRole("button", { name: "Sign in" }).click();
    });
  } finally {
    // After a successful sign-in the field is already gone; a failure to empty it must not hide the real error.
    if ((await field.count().catch(() => 0)) > 0) await field.fill("", { timeout: 2000 }).catch(() => {});
  }
}

/** What the browser did wrong while a page was in use. */
export type Watch = { problems: string[]; assertClean: () => void };

/**
 * Collects fatal problems: uncaught page errors, requests that failed, and same-origin responses with a
 * status of 400 or more (the API, but also a missing script or stylesheet). Console warnings and errors
 * are ignored on purpose. Only the method, the path and the status are recorded: no query, header or body.
 */
export function watchBrowser(page: Page, secrets: string[] = []): Watch {
  const problems: string[] = [];
  const origin = new URL(process.env.E2E_BASE_URL ?? "http://127.0.0.1:8080").origin;
  const clean = (text: string) => scrubbed(text, secrets).message.split("\n")[0].slice(0, 200);

  page.on("pageerror", (error) => problems.push(`page error: ${clean(`${error.name}: ${error.message}`)}`));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === origin && response.status() >= 400) {
      problems.push(`${response.request().method()} ${url.pathname} -> ${response.status()}`);
    }
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    const reason = request.failure()?.errorText ?? "failed";
    // A request cancelled by a navigation is normal.
    if (url.origin === origin && !reason.includes("ERR_ABORTED")) problems.push(`${request.method()} ${url.pathname} failed: ${reason}`);
  });

  return {
    problems,
    assertClean() {
      if (problems.length > 0) throw new Error(`the browser reported ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
    },
  };
}
