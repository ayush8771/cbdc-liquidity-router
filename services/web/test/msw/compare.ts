/*
 * MSW handlers for POST /api/v1/comparisons and GET /api/v1/comparisons/:id
 * (contract §3.6). The decisions are the ones in the contract's comparison
 * fixtures (comparisons/201_scenario_outage.json: the waterfall and the
 * cheapest-feasible results, and the skipped PPO) and in
 * transactions/201_ppo_projected_analyst.json (a PPO decision). The POST
 * handler checks things in the order the backend does
 * (services/backend/src/routes/comparisons.ts):
 * 1. the token (401);
 * 2. a viewer who lists ppoProjected (403 FORBIDDEN_POLICY, before any validation);
 * 3. the body: an unknown top-level field (such as the transaction's `policy`), a
 *    missing required one, a policy that isn't a canonical name or alias, a
 *    repeated policy, or no policies is a 422 VALIDATION_ERROR with every
 *    problem in details.errors[]; an amount of zero or less is a 422 INVALID_AMOUNT;
 * 4. the record, with one entry per policy in the order asked: a result, or for
 *    ppoProjected, unless `ppoEnabled`, the engine's skipped entry. Aliases
 *    become canonical names. An error saves nothing and has no transactionId.
 * A test that needs a different answer puts its own handler in front.
 */
import { http, HttpResponse } from "msw";
import { contractFixture } from "./fixtures";

const ANALYST = "mock-analyst";
const VIEWER = "mock-viewer";
const ALLOWED = ["senderCountry", "receiverCountry", "amountUsd", "state", "policies", "clientReference"];
const REQUIRED = ["senderCountry", "receiverCountry", "amountUsd", "state"];
const CANONICAL = ["waterfall", "cheapestFeasible", "ppoProjected"];
const ALIASES: Record<string, string> = { baseline: "waterfall", ruleBased: "cheapestFeasible" };

type Json = Record<string, unknown>;
type Decision = Json & { policy: string };
export type ComparisonBody = Json & {
  id: string;
  transaction: Json;
  state: Json;
  policies: string[];
  results: Decision[];
  skipped: { policy: string; code: string; message: string }[];
};

/** The contract's saved comparison (waterfall and cheapest-feasible results, PPO skipped), a fresh copy. */
export const fixtureComparison = (): ComparisonBody =>
  structuredClone(contractFixture("comparisons/201_scenario_outage.json").response.body) as ComparisonBody;

/** The same comparison as GET :id returns it. */
export const fixtureSavedComparison = (): ComparisonBody =>
  structuredClone(contractFixture("comparisons/200_get.json").response.body) as ComparisonBody;

/** A PPO decision (experimental, with the capacity projection applied), a fresh copy. */
export const fixturePpoDecision = (): Decision =>
  structuredClone(
    (contractFixture("transactions/201_ppo_projected_analyst.json").response.body as { decision: Decision }).decision,
  );

export const comparisonError = (file: string): Json =>
  contractFixture(`errors/${file}.json`).response.body as Json;

export type CompareRequestInfo = { url: URL; authorization: string | null; body: Json | null };

export type CompareHandlerOptions = {
  onRequest?: (info: CompareRequestInfo) => void;
  /** Answer PPO with a result instead of the engine's "no approved checkpoint" skip. */
  ppoEnabled?: boolean;
};

const envelope = (code: string, message: string, details: unknown = {}) => ({
  error: { code, message, details, requestId: "msw-request-1" },
});

async function readBody(request: Request): Promise<Json | null> {
  try {
    const parsed: unknown = await request.json();
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

export function submitComparisonHandler(options: CompareHandlerOptions = {}) {
  return http.post("*/api/v1/comparisons", async ({ request }) => {
    const authorization = request.headers.get("Authorization");
    const body = await readBody(request);
    options.onRequest?.({ url: new URL(request.url), authorization, body });

    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    if (token !== ANALYST && token !== VIEWER) {
      return HttpResponse.json(envelope("UNAUTHENTICATED", "Missing or invalid token."), { status: 401 });
    }
    const asked = Array.isArray(body?.policies) ? (body!.policies as unknown[]) : [];
    if (token === VIEWER && asked.includes("ppoProjected")) {
      return HttpResponse.json(comparisonError("403_forbidden_policy_comparison"), { status: 403 });
    }
    if (body === null) return HttpResponse.json(envelope("MALFORMED_REQUEST", "The request body is not valid JSON."), { status: 400 });

    const errors: { field?: string; message: string }[] = [];
    for (const key of Object.keys(body)) if (!ALLOWED.includes(key)) errors.push({ field: key, message: "Unknown field." });
    for (const key of REQUIRED) if (!(key in body)) errors.push({ field: key, message: "Required." });
    const canonical: string[] = [];
    if (body.policies !== undefined) {
      if (!Array.isArray(body.policies) || body.policies.length === 0) {
        errors.push({ field: "policies", message: "Must be a non-empty list." });
      } else {
        body.policies.forEach((p, i) => {
          const name = typeof p === "string" ? (ALIASES[p] ?? p) : null;
          if (name === null || !CANONICAL.includes(name)) errors.push({ field: `policies[${i}]`, message: "Unknown policy." });
          else if (canonical.includes(name)) errors.push({ field: `policies[${i}]`, message: "Listed more than once." });
          else canonical.push(name);
        });
      }
    }
    if (errors.length > 0) {
      return HttpResponse.json(envelope("VALIDATION_ERROR", "Request failed validation.", { errors }), { status: 422 });
    }
    if (typeof body.amountUsd !== "number" || !(body.amountUsd > 0)) {
      return HttpResponse.json(comparisonError("422_invalid_amount"), { status: 422 });
    }

    const policies = canonical.length > 0 ? canonical : token === ANALYST ? [...CANONICAL] : ["waterfall", "cheapestFeasible"];
    const base = fixtureComparison();
    const byPolicy = new Map<string, Decision>(base.results.map((r) => [r.policy, r]));
    const skippedPpo = base.skipped[0]!;
    const results: Decision[] = [];
    const skipped: ComparisonBody["skipped"] = [];
    for (const policy of policies) {
      if (policy === "ppoProjected") {
        if (options.ppoEnabled) results.push(fixturePpoDecision());
        else skipped.push(skippedPpo);
      } else results.push(byPolicy.get(policy)!);
    }
    return HttpResponse.json(
      {
        ...base,
        transaction: { ...base.transaction, senderCountry: body.senderCountry, receiverCountry: body.receiverCountry, amountUsd: body.amountUsd, corridor: results.length > 0 ? `${String(body.senderCountry)}->${String(body.receiverCountry)}` : null },
        policies,
        results,
        skipped,
      },
      { status: 201 },
    );
  });
}

export type GetComparisonOptions = {
  onRequest?: (info: { url: URL; authorization: string | null }) => void;
};

/** GET :id: the contract's saved comparison for its own ID, 404 for any other, 401 without a token. */
export function getComparisonHandler(saved: ComparisonBody = fixtureSavedComparison(), options: GetComparisonOptions = {}) {
  return http.get("*/api/v1/comparisons/:id", ({ request, params }) => {
    const authorization = request.headers.get("Authorization");
    options.onRequest?.({ url: new URL(request.url), authorization });
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    if (token !== ANALYST && token !== VIEWER) {
      return HttpResponse.json(envelope("UNAUTHENTICATED", "Missing or invalid token."), { status: 401 });
    }
    return String(params.id).toLowerCase() === saved.id
      ? HttpResponse.json(saved)
      : HttpResponse.json(comparisonError("404_not_found"), { status: 404 });
  });
}
