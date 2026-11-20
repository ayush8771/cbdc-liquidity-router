/*
 * MSW handler for GET /api/v1/network (contract §2.3, §3.1), serving the
 * contract fixture contracts/fixtures/app/meta/200_network.json. The endpoint
 * takes no parameters; the backend checks the token first, as here.
 */
import { http, HttpResponse } from "msw";
import { contractFixture } from "./fixtures";

const VALID_TOKENS = ["mock-analyst", "mock-viewer"];

/** The body of the contract's network fixture (a fresh copy each call, so a test can change it). */
export function fixtureNetwork(): Record<string, unknown> & {
  corridors: { corridor: string; senderCountry: string; receiverCountry: string; venues: Record<string, unknown>[] }[];
} {
  return structuredClone(contractFixture("meta/200_network.json").response.body) as ReturnType<typeof fixtureNetwork>;
}

export type NetworkHandlerOptions = {
  /** Called with the request URL of every request that reaches the handler. */
  onRequest?: (url: URL, authorization: string | null) => void;
};

export function networkHandler(body: unknown = fixtureNetwork(), options: NetworkHandlerOptions = {}) {
  return http.get("*/api/v1/network", ({ request }) => {
    const authorization = request.headers.get("Authorization");
    options.onRequest?.(new URL(request.url), authorization);
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    if (token === null || !VALID_TOKENS.includes(token)) {
      return HttpResponse.json(
        { error: { code: "UNAUTHENTICATED", message: "Missing or invalid token.", details: {}, requestId: "msw-request-1" } },
        { status: 401 },
      );
    }
    return HttpResponse.json(body as Record<string, unknown>);
  });
}
