/*
 * MSW handlers for GET /api/v1/transactions/:id and
 * GET /api/v1/transactions/:id/explanation (contract §3.4, §3.5), built from
 * the contract fixtures in contracts/fixtures/app/transactions/ and errors/:
 * - the transaction records are every fixture there whose body is a record
 *   (200_get_*.json and 201_*.json, the same body as the POST 201);
 * - the explanations are the 200_explanation_*.json fixtures, by transactionId;
 * - an ID that isn't a UUID, or isn't known, is 404 NOT_FOUND (Q11a), as is an
 *   explanation with no fixture;
 * - the explanation of a failed transaction is 409 TRANSACTION_FAILED.
 * The backend checks the token first, as here.
 */
import { http, HttpResponse } from "msw";
import { contractFixture, contractFixtureNames } from "./fixtures";

export type DetailBody = Record<string, unknown> & { id: string; status: string };
export type ExplanationBody = Record<string, unknown> & { transactionId: string; decisionId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_TOKENS = ["mock-analyst", "mock-viewer"];

/** Every transaction record in the fixtures, by ID. */
export function fixtureRecords(): Map<string, DetailBody> {
  const records = new Map<string, DetailBody>();
  for (const name of contractFixtureNames("transactions")) {
    const body = contractFixture(`transactions/${name}`).response.body as Record<string, unknown>;
    if (typeof body.id === "string" && "transaction" in body && "failure" in body) records.set(body.id, body as DetailBody);
  }
  return records;
}

/** Every explanation in the fixtures, by transactionId. */
export function fixtureExplanations(): Map<string, ExplanationBody> {
  const explanations = new Map<string, ExplanationBody>();
  for (const name of contractFixtureNames("transactions")) {
    const body = contractFixture(`transactions/${name}`).response.body as Record<string, unknown>;
    if (typeof body.transactionId === "string" && "venueExplanations" in body) {
      explanations.set(body.transactionId, body as ExplanationBody);
    }
  }
  return explanations;
}

/** The error bodies of contracts/fixtures/app/errors/, by code. */
function errorBody(file: string) {
  return contractFixture(`errors/${file}.json`).response.body;
}

function envelope(code: string, message: string, details: unknown = {}, requestId = "msw-request-1") {
  return { error: { code, message, details, requestId } };
}

export type DetailHandlersOptions = {
  /** Called with the request URL of every request that reaches a handler. */
  onRequest?: (url: URL, authorization: string | null) => void;
};

function unauthenticated(authorization: string | null) {
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  return token === null || !VALID_TOKENS.includes(token)
    ? HttpResponse.json(envelope("UNAUTHENTICATED", "Missing or invalid token."), { status: 401 })
    : null;
}

export function transactionDetailHandler(
  records: Map<string, DetailBody> = fixtureRecords(),
  options: DetailHandlersOptions = {},
) {
  return http.get("*/api/v1/transactions/:id", ({ request, params }) => {
    const authorization = request.headers.get("Authorization");
    options.onRequest?.(new URL(request.url), authorization);
    const denied = unauthenticated(authorization);
    if (denied) return denied;

    const id = String(params.id);
    const record = UUID.test(id) ? records.get(id.toLowerCase()) : undefined;
    return record
      ? HttpResponse.json(record)
      : HttpResponse.json(errorBody("404_not_found") as Record<string, unknown>, { status: 404 });
  });
}

export function explanationHandler(
  records: Map<string, DetailBody> = fixtureRecords(),
  explanations: Map<string, ExplanationBody> = fixtureExplanations(),
  options: DetailHandlersOptions = {},
) {
  return http.get("*/api/v1/transactions/:id/explanation", ({ request, params }) => {
    const authorization = request.headers.get("Authorization");
    options.onRequest?.(new URL(request.url), authorization);
    const denied = unauthenticated(authorization);
    if (denied) return denied;

    const id = String(params.id).toLowerCase();
    const record = UUID.test(id) ? records.get(id) : undefined;
    if (!record) return HttpResponse.json(errorBody("404_not_found") as Record<string, unknown>, { status: 404 });
    if (record.status === "failed") {
      return HttpResponse.json(errorBody("409_transaction_failed") as Record<string, unknown>, { status: 409 });
    }
    const explanation = explanations.get(id);
    return explanation
      ? HttpResponse.json(explanation)
      : HttpResponse.json(errorBody("404_not_found") as Record<string, unknown>, { status: 404 });
  });
}

/** The error body of a contract error fixture, for tests that answer with a specific error. */
export function contractError(file: string) {
  return errorBody(file) as Record<string, unknown>;
}
