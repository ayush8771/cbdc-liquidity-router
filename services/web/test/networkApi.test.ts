import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, INVALID_RESPONSE, NETWORK_ERROR } from "../src/api/client";
import { isApiNetwork, type ApiNetwork } from "../src/api/types";
import { describeNetworkError, fetchNetwork, mapNetwork } from "../src/features/network/networkApi";
import { dataSourceName, formatFeeFraction } from "../src/features/network/types";
import { fixtureNetwork } from "./msw/network";

const fixture = () => fixtureNetwork() as unknown as ApiNetwork;

function clientReturning(body: unknown) {
  const fetchImpl = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }),
  );
  return { api: createApiClient({ getToken: () => "t", fetchImpl }), fetchImpl };
}

describe("the contract's network fixture", () => {
  it("passes the strict check, with three corridors of three venues", () => {
    const network = fixture();
    expect(isApiNetwork(network)).toBe(true);
    expect(network.corridors.map((c) => [c.corridor, c.venues.length])).toEqual([
      ["USA->IND", 3],
      ["GBR->PHL", 3],
      ["ARE->MEX", 3],
    ]);
  });
});

describe("mapNetwork", () => {
  it("copies every field unchanged, in the API's order", () => {
    const raw = fixture();
    const view = mapNetwork(raw);
    expect(view.maxSingleTransferUsd).toBe(500000);
    expect(view.maxSingleTransferProvenance).toBe("project_assumption");
    expect(view.corridors.map((c) => c.corridor)).toEqual(raw.corridors.map((c) => c.corridor));
    for (const [i, corridor] of view.corridors.entries()) {
      expect(corridor.senderCountry).toBe(raw.corridors[i]!.senderCountry);
      expect(corridor.receiverCountry).toBe(raw.corridors[i]!.receiverCountry);
      expect(corridor.venues).toEqual(raw.corridors[i]!.venues);
    }
  });

  it("keeps fees as fractions: 0.012 stays 0.012, and only the formatter makes it a percentage", () => {
    const view = mapNetwork(fixture());
    const venue = view.corridors.find((c) => c.corridor === "ARE->MEX")!.venues[0]!;
    expect(venue.feePct).toBe(0.012);
    expect(formatFeeFraction(venue.feePct)).toBe("1.20%");
    for (const v of view.corridors.flatMap((c) => c.venues)) expect(v.feePct).toBeLessThan(1);
  });

  it("keeps the baseline capacity as reference metadata, in dollars", () => {
    const venue = mapNetwork(fixture()).corridors.find((c) => c.corridor === "ARE->MEX")!.venues[0]!;
    expect(venue.baselineCapacityUsd).toBe(750000);
  });

  it("keeps an unknown data-source tag as written, and the UI names it as written", () => {
    const raw = fixture();
    raw.corridors[0]!.venues[0]!.dataSourceTag = "future_source_tag";
    const view = mapNetwork(raw);
    expect(view.corridors[0]!.venues[0]!.dataSourceTag).toBe("future_source_tag");
    expect(dataSourceName("future_source_tag")).toBe("future_source_tag");
  });

  it("keeps the synthetic no-real-anchor tag the fixture carries for ARE->MEX venue 0", () => {
    const venue = mapNetwork(fixture()).corridors.find((c) => c.corridor === "ARE->MEX")!.venues[0]!;
    expect(venue.dataSourceTag).toBe("synthetic_no_real_anchor");
  });

  it("allows a corridor with no venues and a network with no corridors (the page shows its empty states)", () => {
    const raw = fixture();
    raw.corridors[0]!.venues = [];
    expect(isApiNetwork(raw)).toBe(true);
    expect(isApiNetwork({ ...raw, corridors: [] })).toBe(true);
  });
});

describe("isApiNetwork is strict", () => {
  /** A fresh fixture with one thing broken. */
  const broken = (change: (n: ApiNetwork) => unknown) => {
    const n = fixture();
    change(n);
    return n;
  };

  it("ignores extra fields", () => {
    const raw = { ...fixture(), extra: 1 } as unknown;
    (raw as ApiNetwork).corridors[0]!.venues[0] = { ...(raw as ApiNetwork).corridors[0]!.venues[0]!, extra: true } as never;
    expect(isApiNetwork(raw)).toBe(true);
  });

  it.each([
    ["null", () => null],
    ["no corridors list", () => ({ ...fixture(), corridors: undefined })],
    ["corridors that is not a list", () => ({ ...fixture(), corridors: {} })],
    ["no single-transfer limit", () => ({ ...fixture(), maxSingleTransferUsd: undefined })],
    ["a limit that is a string", () => ({ ...fixture(), maxSingleTransferUsd: "500000" })],
    ["a negative limit", () => ({ ...fixture(), maxSingleTransferUsd: -1 })],
    ["no provenance", () => ({ ...fixture(), maxSingleTransferProvenance: undefined })],
    ["a corridor with no countries", () => broken((n) => delete (n.corridors[0] as Partial<ApiNetwork["corridors"][0]>).senderCountry)],
    ["a corridor with no venues list", () => broken((n) => ((n.corridors[0] as unknown as Record<string, unknown>).venues = null))],
    ["a venue with no ID", () => broken((n) => delete (n.corridors[0]!.venues[0] as Partial<ApiNetwork["corridors"][0]["venues"][0]>).bridgeUid)],
    ["a fee that is a string", () => broken((n) => ((n.corridors[0]!.venues[0] as unknown as Record<string, unknown>).feePct = "0.015"))],
    ["a negative fee", () => broken((n) => (n.corridors[0]!.venues[0]!.feePct = -0.01))],
    ["a fee that is not finite", () => broken((n) => (n.corridors[0]!.venues[0]!.feePct = Number.POSITIVE_INFINITY))],
    ["a negative capacity", () => broken((n) => (n.corridors[0]!.venues[0]!.baselineCapacityUsd = -5))],
    ["a fractional slot", () => broken((n) => (n.corridors[0]!.venues[0]!.slot = 0.5))],
    ["a negative slot", () => broken((n) => (n.corridors[0]!.venues[0]!.slot = -1))],
    ["a missing data-source tag", () => broken((n) => delete (n.corridors[0]!.venues[0] as Partial<ApiNetwork["corridors"][0]["venues"][0]>).dataSourceTag)],
    ["a repeated corridor", () => broken((n) => (n.corridors[1]!.corridor = n.corridors[0]!.corridor))],
    ["a repeated venue ID", () => broken((n) => (n.corridors[0]!.venues[1]!.bridgeUid = n.corridors[0]!.venues[0]!.bridgeUid))],
  ])("rejects %s", (_name, make) => {
    expect(isApiNetwork(make())).toBe(false);
  });
});

describe("fetchNetwork", () => {
  it("asks for /network with no query and maps the body", async () => {
    const { api, fetchImpl } = clientReturning(fixtureNetwork());
    const view = await fetchNetwork(api);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(`${window.location.origin}/api/v1/network`);
    expect(view.corridors).toHaveLength(3);
  });

  it("refuses a body that isn't the network, instead of showing a partial or empty page", async () => {
    for (const body of [{ hello: "world" }, [], { ...fixtureNetwork(), maxSingleTransferUsd: "x" }]) {
      await expect(fetchNetwork(clientReturning(body).api)).rejects.toMatchObject({ code: INVALID_RESPONSE });
    }
  });
});

describe("describeNetworkError", () => {
  const api = (status: number, code: string, extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {}) =>
    new ApiError({ status, code, message: "BACKEND TEXT", ...extra });

  it("words every case itself, never with the backend's message", () => {
    for (const error of [
      api(0, NETWORK_ERROR),
      api(200, INVALID_RESPONSE),
      api(503, "INFERENCE_UNAVAILABLE"),
      api(503, "ENGINE_BUSY"),
      api(504, "ENGINE_TIMEOUT"),
      api(502, "INFERENCE_ERROR"),
      api(500, "INTERNAL_ERROR"),
      api(403, "FORBIDDEN_POLICY"),
      api(418, "TEAPOT"),
    ]) {
      expect(describeNetworkError(error).message).not.toContain("BACKEND TEXT");
    }
  });

  it("says the engine is starting up only for a 503 with cause NOT_READY", () => {
    expect(describeNetworkError(api(503, "INFERENCE_UNAVAILABLE", { details: { cause: "NOT_READY" } })).message).toMatch(/starting up/);
    const down = describeNetworkError(api(503, "INFERENCE_UNAVAILABLE")).message;
    expect(down).toMatch(/unavailable/);
    expect(down).not.toMatch(/starting up/);
  });

  it("offers a retry for everything that can pass, and not for a 403", () => {
    for (const error of [api(0, NETWORK_ERROR), api(200, INVALID_RESPONSE), api(503, "INFERENCE_UNAVAILABLE"), api(504, "ENGINE_TIMEOUT"), api(502, "INFERENCE_ERROR"), api(500, "INTERNAL_ERROR")]) {
      expect(describeNetworkError(error).canRetry).toBe(true);
    }
    expect(describeNetworkError(api(403, "FORBIDDEN_POLICY")).canRetry).toBe(false);
  });

  it("carries the request ID, and copes with an error that isn't an ApiError", () => {
    expect(describeNetworkError(api(500, "INTERNAL_ERROR", { requestId: "req-1" })).reference).toBe("req-1");
    expect(describeNetworkError(api(500, "INTERNAL_ERROR")).reference).toBeUndefined();
    expect(describeNetworkError(new Error("x")).message).toMatch(/went wrong/);
  });
});
