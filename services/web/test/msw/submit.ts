/*
 * MSW handler for POST /api/v1/transactions (contract §3.2). It answers with
 * the saved records of contracts/fixtures/app/transactions/201_*.json and the
 * error bodies of contracts/fixtures/app/errors/, in the order the backend
 * checks things (services/backend/src/routes/transactions.ts):
 * 1. the token (401);
 * 2. a viewer who asks for ppoProjected (403 FORBIDDEN_POLICY, before any validation);
 * 3. the body: an unknown top-level field or a missing required one is a 422
 *    VALIDATION_ERROR, and an amount of zero or less is a 422 INVALID_AMOUNT;
 * 4. a record, chosen by what was asked: an amount over the single-transfer
 *    limit is the rejection, otherwise the policy, state mode and corridor pick
 *    the fixture.
 * A test that needs a different answer (a persisted failure, a stalled request)
 * puts its own handler in front with server.use().
 */
import { http, HttpResponse } from "msw";
import { contractFixture } from "./fixtures";

const ANALYST = "mock-analyst";
const VIEWER = "mock-viewer";
const ALLOWED = ["senderCountry", "receiverCountry", "amountUsd", "state", "policy", "clientReference"];
const REQUIRED = ["senderCountry", "receiverCountry", "amountUsd", "state"];
const MAX_SINGLE_TRANSFER_USD = 500000;

type Body = Record<string, unknown>;

export type SubmitRequestInfo = { url: URL; authorization: string | null; body: Body | null };

export type SubmitHandlerOptions = {
  /** Called for every request that reaches the handler, with its parsed body. */
  onRequest?: (info: SubmitRequestInfo) => void;
};

export function errorFixture(file: string): Record<string, unknown> {
  return contractFixture(`errors/${file}.json`).response.body as Record<string, unknown>;
}

function record(file: string): Record<string, unknown> {
  return contractFixture(`transactions/${file}.json`).response.body as Record<string, unknown>;
}

/** Which saved record answers this request. */
export function recordFileFor(body: Body): string {
  const amount = body.amountUsd as number;
  const policy = (body.policy as string | undefined) ?? "waterfall";
  const state = body.state as { mode?: string } | undefined;
  if (amount > MAX_SINGLE_TRANSFER_USD) return "201_regulatory_rejection";
  if (policy === "ppoProjected") return "201_ppo_projected_analyst";
  if (policy === "cheapestFeasible") return "201_cheapest_feasible_partial";
  if (state?.mode === "explicit") return "201_explicit_exceeds_combined";
  if (body.receiverCountry === "MEX") return "201_are_mex_synthetic_anchor";
  return "201_waterfall_replay";
}

/** The JSON object the request carried, or null when it carried anything else. */
async function readBody(request: Request): Promise<Body | null> {
  try {
    const parsed: unknown = await request.json();
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Body) : null;
  } catch {
    return null;
  }
}

export function submitHandler(options: SubmitHandlerOptions = {}) {
  return http.post("*/api/v1/transactions", async ({ request }) => {
    const authorization = request.headers.get("Authorization");
    const body = await readBody(request);
    options.onRequest?.({ url: new URL(request.url), authorization, body });

    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    if (token !== ANALYST && token !== VIEWER) {
      return HttpResponse.json(
        { error: { code: "UNAUTHENTICATED", message: "Missing or invalid token.", details: {}, requestId: "msw-request-1" } },
        { status: 401 },
      );
    }
    if (body?.policy === "ppoProjected" && token === VIEWER) {
      return HttpResponse.json(errorFixture("403_forbidden_policy_transaction"), { status: 403 });
    }
    if (body === null) {
      return HttpResponse.json(
        { error: { code: "MALFORMED_REQUEST", message: "The request body is not valid JSON.", details: {}, requestId: "msw-request-1" } },
        { status: 400 },
      );
    }

    const errors: { field?: string; message: string }[] = [];
    for (const key of Object.keys(body)) if (!ALLOWED.includes(key)) errors.push({ field: key, message: "Unknown field." });
    for (const key of REQUIRED) if (!(key in body)) errors.push({ field: key, message: "Required." });
    if (errors.length > 0) {
      return HttpResponse.json(
        { error: { code: "VALIDATION_ERROR", message: "Request failed validation.", details: { errors }, requestId: "msw-request-1" } },
        { status: 422 },
      );
    }
    if (typeof body.amountUsd !== "number" || !(body.amountUsd > 0)) {
      return HttpResponse.json(errorFixture("422_invalid_amount"), { status: 422 });
    }

    return HttpResponse.json(record(recordFileFor(body)), { status: 201 });
  });
}
