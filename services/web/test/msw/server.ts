/*
 * MSW for the API tests: no live backend is needed. The /auth/me bodies are
 * read straight from the shared contract fixtures (contracts/fixtures/app/),
 * never copied. Their mock tokens are the only ones accepted here.
 */
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { contractFixture } from "./fixtures";
import { getComparisonHandler, submitComparisonHandler } from "./compare";
import { dashboardHandler } from "./dashboard";
import { calendarHandler, stateHandler } from "./monitor";
import { networkHandler } from "./network";
import { metaHandler, scenariosHandler } from "./reference";
import { submitHandler } from "./submit";
import { explanationHandler, transactionDetailHandler } from "./transactionDetail";
import { transactionsHandler } from "./transactions";

export const MOCK_ANALYST_TOKEN = "mock-analyst";
export const MOCK_VIEWER_TOKEN = "mock-viewer";

const fixture = (name: string) => contractFixture(`auth/${name}.json`);

/** GET /api/v1/auth/me, as the contract fixtures describe it. */
export const authMeHandler = http.get("*/api/v1/auth/me", ({ request }) => {
  const header = request.headers.get("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  const pick = (name: string) => {
    const { status, body } = fixture(name).response;
    return HttpResponse.json(body as Record<string, unknown>, { status });
  };
  if (token === MOCK_ANALYST_TOKEN) return pick("200_me_analyst");
  if (token === MOCK_VIEWER_TOKEN) return pick("200_me_viewer");
  return pick(token === null ? "401_missing_token" : "401_malformed_token");
});

// GET /transactions defaults to the contract fixture's seven rows; the detail and explanation handlers serve the
// contract's transaction records and explanations, the network handler the contract's network fixture, and the dashboard handler its summary fixture. A test overrides any of them with server.use().
export const server = setupServer(
  authMeHandler,
  transactionsHandler(),
  transactionDetailHandler(),
  explanationHandler(),
  networkHandler(),
  dashboardHandler(),
  scenariosHandler(),
  metaHandler(),
  submitHandler(),
  calendarHandler(),
  stateHandler(),
  submitComparisonHandler(),
  getComparisonHandler(),
);
