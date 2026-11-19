import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, INVALID_RESPONSE, NETWORK_ERROR, REQUEST_TIMEOUT } from "../src/api/client";
import { isApiMetaPolicies, isApiScenarios } from "../src/api/types";
import {
  applyRole,
  buildReferenceData,
  describeReferenceError,
  fetchPolicies,
  fetchScenarios,
  toCorridorRefs,
  VIEWER_POLICY_REASON,
} from "../src/features/newTransaction/referenceApi";
import { describeUncertain, SUBMIT_TIMEOUT_MS, submitTransaction } from "../src/features/newTransaction/submitApi";
import type { TransactionPayload } from "../src/features/newTransaction/types";
import { mapNetwork } from "../src/features/network/networkApi";
import type { ApiNetwork } from "../src/api/types";
import { fixtureNetwork } from "./msw/network";
import { errorFixture, recordFileFor } from "./msw/submit";
import { contractFixture } from "./msw/fixtures";
import { fixtureMeta, fixtureMetaPpoEnabled, fixtureScenarios } from "./msw/reference";

afterEach(() => vi.useRealTimers());

const payload: TransactionPayload = {
  senderCountry: "GBR",
  receiverCountry: "PHL",
  amountUsd: 100000,
  state: { mode: "historicalReplay", date: "2024-06-14" },
  policy: "waterfall",
};
const record = (file: string) => contractFixture(`transactions/${file}.json`).response.body;

function clientReturning(body: unknown, init: ResponseInit = {}) {
  const fetchImpl = vi.fn<typeof fetch>(
    async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { headers: { "Content-Type": "application/json" }, ...init }),
  );
  return { api: createApiClient({ getToken: () => "t", fetchImpl }), fetchImpl };
}

describe("the client's request timeout", () => {
  /** A fetch that never answers, and rejects only if it is told to abort. */
  const hanging = (honourAbort: boolean) =>
    vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          if (honourAbort) init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );

  it.each([
    ["a fetch that honours the abort", true],
    ["a fetch that ignores the abort", false],
  ])("gives up after the deadline with REQUEST_TIMEOUT and status 0, for %s", async (_name, honour) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchImpl = hanging(honour);
    const api = createApiClient({ getToken: () => "t", fetchImpl });

    const pending = api.post("/transactions", {}, { timeoutMs: 25_000 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(24_999);
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const error = await pending;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: REQUEST_TIMEOUT, status: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // never retried
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("has no deadline unless one is asked for, and clears its timer when the answer comes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { api } = clientReturning({ ok: true });
    await api.post("/transactions", {});
    expect(vi.getTimerCount()).toBe(0);
    await api.post("/transactions", {}, { timeoutMs: 25_000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes the caller's own abort through unchanged, and is not mistaken for a timeout", async () => {
    const controller = new AbortController();
    const api = createApiClient({ getToken: () => "t", fetchImpl: hanging(true) });
    const pending = api.post("/transactions", {}, { timeoutMs: 25_000, signal: controller.signal }).catch((e: unknown) => e);
    controller.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
  });

  it("the form's timeout is 25 seconds", () => {
    expect(SUBMIT_TIMEOUT_MS).toBe(25_000);
  });
});

describe("submitTransaction: definite results", () => {
  it("sends the payload once, to /transactions, with the 25 s deadline", async () => {
    const { api, fetchImpl } = clientReturning(record("201_waterfall_replay"), { status: 201 });
    await submitTransaction(api, payload);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`${window.location.origin}/api/v1/transactions`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(payload);
  });

  it.each([
    ["201_waterfall_replay", "completed"],
    ["201_cheapest_feasible_partial", "partial"],
    ["201_regulatory_rejection", "rejected"],
    ["201_explicit_exceeds_combined", "partial"],
    ["201_ppo_projected_analyst", "completed"],
    ["201_are_mex_synthetic_anchor", "completed"],
  ])("maps the saved record %s to a routed result (%s)", async (file, outcome) => {
    const { api } = clientReturning(record(file), { status: 201 });
    const result = await submitTransaction(api, payload);
    expect(result.kind).toBe("routed");
    if (result.kind !== "routed") return;
    expect(result.transaction.outcome).toBe(outcome);
    expect(result.transaction.status).toBe("routed");
    expect(result.transaction.decision?.decisionId).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("keeps a rejection a result: allowed false, no allocations", async () => {
    const { api } = clientReturning(record("201_regulatory_rejection"), { status: 201 });
    const result = await submitTransaction(api, payload);
    if (result.kind !== "routed") throw new Error("expected a routed result");
    expect(result.transaction.decision!.feasibility.allowed).toBe(false);
    expect(result.transaction.decision!.allocations).toEqual([]);
  });
});

describe("submitTransaction: definite errors keep the backend's message, code, details and request ID", () => {
  it.each([
    ["422_validation_error", 422, "VALIDATION_ERROR"],
    ["422_invalid_amount", 422, "INVALID_AMOUNT"],
    ["422_date_in_gap_buffer_passthrough", 422, "DATE_IN_GAP_BUFFER"],
    ["403_forbidden_policy_transaction", 403, "FORBIDDEN_POLICY"],
    ["409_policy_disabled_passthrough", 409, "POLICY_DISABLED"],
    ["503_engine_busy", 503, "ENGINE_BUSY"],
    ["503_inference_not_ready", 503, "INFERENCE_UNAVAILABLE"],
    ["504_engine_timeout", 504, "ENGINE_TIMEOUT"],
    ["502_inference_error", 502, "INFERENCE_ERROR"],
    ["500_internal_error", 500, "INTERNAL_ERROR"],
  ])("%s", async (file, status, code) => {
    const body = errorFixture(file) as { error: { message: string; details: Record<string, unknown>; requestId: string } };
    const { api } = clientReturning(body, { status });
    const result = await submitTransaction(api, payload);
    expect(result).toEqual({
      kind: "error",
      error: { status, code, message: body.error.message, details: body.error.details, requestId: body.error.requestId },
    });
  });

  it("carries a persisted failure's transaction ID and the NOT_READY cause", async () => {
    const { api } = clientReturning(errorFixture("503_inference_not_ready"), { status: 503 });
    const result = await submitTransaction(api, payload);
    if (result.kind !== "error") throw new Error("expected an error");
    expect(result.error.details.transactionId).toBe("94f3896b-b9f1-5efa-90e7-2effa29d865b");
    expect(result.error.details.cause).toBe("NOT_READY");
  });

  it("does not retry after any error", async () => {
    const { api, fetchImpl } = clientReturning(errorFixture("503_engine_busy"), { status: 503 });
    await submitTransaction(api, payload);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("submitTransaction: uncertain outcomes are never reported as definite", () => {
  it("a connection failure is uncertain (network)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    const result = await submitTransaction(createApiClient({ getToken: () => "t", fetchImpl }), payload);
    expect(result).toEqual({ kind: "uncertain", reason: "network" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("no answer in time is uncertain (timeout), and is not retried", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const api = createApiClient({ getToken: () => "t", fetchImpl });

    const pending = submitTransaction(api, payload);
    await vi.advanceTimersByTimeAsync(SUBMIT_TIMEOUT_MS);

    expect(await pending).toEqual({ kind: "uncertain", reason: "timeout" });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a 201 whose body is not JSON", "not json", 201],
    ["a 201 whose body is not a record", { hello: "world" }, 201],
    ["a 201 record that is not routed", { ...(record("200_get_failed") as object) }, 201],
    ["a 200 with an empty body", "", 200],
    ["a gateway error page with no envelope (a proxy 502)", "<html>Bad gateway</html>", 502],
    ["a 504 with no envelope", "", 504],
  ])("%s is uncertain (unreadable)", async (_name, body, status) => {
    const { api } = clientReturning(body, { status });
    expect(await submitTransaction(api, payload)).toEqual({ kind: "uncertain", reason: "unreadable" });
  });

  it("an error that isn't an ApiError is uncertain, never 'not saved'", async () => {
    const api = { get: vi.fn(), post: vi.fn().mockRejectedValue(new Error("boom")) };
    expect(await submitTransaction(api, payload)).toEqual({ kind: "uncertain", reason: "unreadable" });
  });

  it("the form-level warning says it may have been saved, to check History, and never says nothing was saved", () => {
    for (const [reason, code] of [
      ["timeout", REQUEST_TIMEOUT],
      ["network", NETWORK_ERROR],
      ["unreadable", INVALID_RESPONSE],
    ] as const) {
      const view = describeUncertain(reason);
      const text = view.messages.join(" ");
      expect(view.title).toMatch(/can't tell whether/);
      expect(text).toMatch(/may have been saved/);
      expect(text).toMatch(/Check History before submitting again/);
      expect(text).not.toMatch(/nothing was saved/i);
      expect(view.code).toBe(code);
    }
    expect(describeUncertain("timeout").messages[0]).toMatch(/25 seconds/);
  });
});

describe("reference data: scenarios and policies", () => {
  it("the contract fixtures pass the strict checks", () => {
    expect(isApiScenarios(fixtureScenarios())).toBe(true);
    expect(isApiMetaPolicies(fixtureMeta())).toBe(true);
    expect(isApiMetaPolicies(fixtureMetaPpoEnabled())).toBe(true);
  });

  it("fetchScenarios keeps the API's order, ids and descriptions", async () => {
    const { api, fetchImpl } = clientReturning(fixtureScenarios());
    const scenarios = await fetchScenarios(api);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(`${window.location.origin}/api/v1/scenarios`);
    expect(scenarios.map((s) => s.scenarioId)).toEqual([
      "baseline",
      "cheapest_venue_outage",
      "combined_stress",
      "congestion_x2",
      "liquidity_minus30",
      "liquidity_minus50",
    ]);
    expect(Object.keys(scenarios[0]!).sort()).toEqual(["description", "scenarioId"]);
  });

  it("fetchPolicies keeps tier, enabled flag and the engine's reason", async () => {
    const { api } = clientReturning(fixtureMeta());
    expect(await fetchPolicies(api)).toEqual([
      { policy: "waterfall", status: "default", enabled: true },
      { policy: "cheapestFeasible", status: "baseline", enabled: true },
      { policy: "ppoProjected", status: "experimental", enabled: false, disabledReason: "no approved checkpoint configured" },
    ]);
  });

  it("fetchPolicies doesn't offer a policy it can't name", async () => {
    const body = fixtureMeta();
    body.policies.push({ policy: "someNewPolicy", status: "experimental", enabled: true });
    const policies = await fetchPolicies(clientReturning(body).api);
    expect(policies.map((p) => p.policy)).toEqual(["waterfall", "cheapestFeasible", "ppoProjected"]);
  });

  it.each([
    ["scenarios: no list", () => isApiScenarios({ note: "x" })],
    ["scenarios: a scenario with no description", () => isApiScenarios({ scenarios: [{ scenarioId: "a" }] })],
    ["scenarios: a repeated ID", () => isApiScenarios({ scenarios: [{ scenarioId: "a", description: "x" }, { scenarioId: "a", description: "y" }] })],
    ["meta: no policies", () => isApiMetaPolicies({ policies: [] })],
    ["meta: enabled is a string", () => isApiMetaPolicies({ policies: [{ policy: "waterfall", status: "default", enabled: "yes" }] })],
    ["meta: a disabled reason that isn't text", () => isApiMetaPolicies({ policies: [{ policy: "waterfall", status: "default", enabled: false, disabledReason: 5 }] })],
    ["meta: a repeated policy", () => isApiMetaPolicies({ policies: [{ policy: "waterfall", status: "default", enabled: true }, { policy: "waterfall", status: "default", enabled: true }] })],
    ["meta: null", () => isApiMetaPolicies(null)],
  ])("rejects %s", (_name, check) => {
    expect(check()).toBe(false);
  });

  it("refuses a body that isn't scenarios or a policy list", async () => {
    await expect(fetchScenarios(clientReturning({ x: 1 }).api)).rejects.toMatchObject({ code: INVALID_RESPONSE });
    await expect(fetchPolicies(clientReturning({ policies: "no" }).api)).rejects.toMatchObject({ code: INVALID_RESPONSE });
  });
});

describe("reference data: roles and the form's reference", () => {
  const meta = fixtureMetaPpoEnabled();
  const policies = async () => fetchPolicies(clientReturning(meta).api);

  it("an analyst keeps the experimental policy the engine enables", async () => {
    const list = applyRole(await policies(), "analyst");
    expect(list.find((p) => p.policy === "ppoProjected")).toMatchObject({ enabled: true });
  });

  it("a viewer doesn't get it, with the reason", async () => {
    const list = applyRole(await policies(), "viewer");
    expect(list.find((p) => p.policy === "ppoProjected")).toMatchObject({ enabled: false, disabledReason: VIEWER_POLICY_REASON });
    expect(list.find((p) => p.policy === "waterfall")!.enabled).toBe(true);
    expect(list.find((p) => p.policy === "cheapestFeasible")!.enabled).toBe(true);
  });

  it("a viewer, or no role, keeps the engine's own reason when the engine disabled it", async () => {
    const list = applyRole(await fetchPolicies(clientReturning(fixtureMeta()).api), "viewer");
    expect(list.find((p) => p.policy === "ppoProjected")!.disabledReason).toBe("no approved checkpoint configured");
    expect(applyRole(await policies(), undefined).find((p) => p.policy === "ppoProjected")!.enabled).toBe(false);
  });

  it("builds the form's reference from the network, keeping fees as fractions and the limit", async () => {
    const network = mapNetwork(fixtureNetwork() as unknown as ApiNetwork);
    const reference = buildReferenceData(network, await fetchScenarios(clientReturning(fixtureScenarios()).api), await policies());
    expect(reference.maxSingleTransferUsd).toBe(500000);
    expect(reference.corridors.map((c) => c.corridor)).toEqual(["USA->IND", "GBR->PHL", "ARE->MEX"]);
    expect(reference.corridors[0]).toMatchObject({ senderCountry: "USA", receiverCountry: "IND" });
    expect(reference.corridors[0]!.venues[0]).toEqual({ bridgeUid: "USA->IND#0", feePct: 0.015, dataSourceTag: "real_static_bridge" });
    expect(toCorridorRefs(network)[2]!.venues[0]!.dataSourceTag).toBe("synthetic_no_real_anchor");
  });

  it("recordFileFor picks the saved record by what was asked (the handler's own logic)", () => {
    expect(recordFileFor({ amountUsd: 600000 })).toBe("201_regulatory_rejection");
    expect(recordFileFor({ amountUsd: 1, policy: "ppoProjected" })).toBe("201_ppo_projected_analyst");
    expect(recordFileFor({ amountUsd: 1, policy: "cheapestFeasible" })).toBe("201_cheapest_feasible_partial");
    expect(recordFileFor({ amountUsd: 1, state: { mode: "explicit" } })).toBe("201_explicit_exceeds_combined");
    expect(recordFileFor({ amountUsd: 1, receiverCountry: "MEX" })).toBe("201_are_mex_synthetic_anchor");
    expect(recordFileFor({ amountUsd: 1 })).toBe("201_waterfall_replay");
  });
});

describe("describeReferenceError", () => {
  const api = (status: number, code: string, extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {}) =>
    new ApiError({ status, code, message: "BACKEND TEXT", ...extra });

  it("words every case itself, naming the source, never with the backend's message", () => {
    for (const source of ["network", "scenarios", "policies"] as const) {
      for (const error of [api(0, NETWORK_ERROR), api(200, INVALID_RESPONSE), api(503, "INFERENCE_UNAVAILABLE"), api(503, "ENGINE_BUSY"), api(504, "ENGINE_TIMEOUT"), api(500, "INTERNAL_ERROR"), api(403, "X"), api(418, "TEAPOT")]) {
        expect(describeReferenceError(error, source).message).not.toContain("BACKEND TEXT");
      }
    }
    expect(describeReferenceError(api(200, INVALID_RESPONSE), "scenarios").message).toMatch(/the scenarios/);
    expect(describeReferenceError(api(503, "INFERENCE_UNAVAILABLE"), "policies").message).toMatch(/the policies/);
  });

  it("says starting up only for NOT_READY, offers a retry except for a 403, and carries the request ID", () => {
    expect(describeReferenceError(api(503, "INFERENCE_UNAVAILABLE", { details: { cause: "NOT_READY" } }), "network").message).toMatch(/starting up/);
    expect(describeReferenceError(api(503, "INFERENCE_UNAVAILABLE"), "network").message).not.toMatch(/starting up/);
    expect(describeReferenceError(api(500, "INTERNAL_ERROR"), "network").canRetry).toBe(true);
    expect(describeReferenceError(api(403, "X"), "network").canRetry).toBe(false);
    expect(describeReferenceError(api(500, "INTERNAL_ERROR", { requestId: "req-1" }), "network").reference).toBe("req-1");
    expect(describeReferenceError(new Error("x"), "network").message).toMatch(/went wrong/);
  });
});
