/*
 * MSW handlers for GET /api/v1/scenarios and GET /api/v1/meta (contract §3.1,
 * §3.9), serving contracts/fixtures/app/meta/200_scenarios.json and
 * 200_meta.json (PPO disabled; 200_meta_ppo_enabled.json has it enabled). The
 * backend checks the token first, as here.
 */
import { http, HttpResponse } from "msw";
import { contractFixture } from "./fixtures";

const VALID_TOKENS = ["mock-analyst", "mock-viewer"];

export type ReferenceBody = Record<string, unknown>;

export const fixtureScenarios = (): ReferenceBody & { scenarios: Record<string, unknown>[] } =>
  structuredClone(contractFixture("meta/200_scenarios.json").response.body) as ReturnType<typeof fixtureScenarios>;

export const fixtureMeta = (): ReferenceBody & { policies: Record<string, unknown>[] } =>
  structuredClone(contractFixture("meta/200_meta.json").response.body) as ReturnType<typeof fixtureMeta>;

export const fixtureMetaPpoEnabled = (): ReferenceBody & { policies: Record<string, unknown>[] } =>
  structuredClone(contractFixture("meta/200_meta_ppo_enabled.json").response.body) as ReturnType<typeof fixtureMeta>;

export type ReferenceHandlerOptions = {
  /** Called with the request URL of every request that reaches the handler. */
  onRequest?: (url: URL, authorization: string | null) => void;
};

function guarded(path: string, body: () => unknown, options: ReferenceHandlerOptions) {
  return http.get(path, ({ request }) => {
    const authorization = request.headers.get("Authorization");
    options.onRequest?.(new URL(request.url), authorization);
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    if (token === null || !VALID_TOKENS.includes(token)) {
      return HttpResponse.json(
        { error: { code: "UNAUTHENTICATED", message: "Missing or invalid token.", details: {}, requestId: "msw-request-1" } },
        { status: 401 },
      );
    }
    return HttpResponse.json(body() as Record<string, unknown>);
  });
}

export const scenariosHandler = (body: unknown = fixtureScenarios(), options: ReferenceHandlerOptions = {}) =>
  guarded("*/api/v1/scenarios", () => body, options);

export const metaHandler = (body: unknown = fixtureMeta(), options: ReferenceHandlerOptions = {}) =>
  guarded("*/api/v1/meta", () => body, options);
