import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, INVALID_RESPONSE, NETWORK_ERROR, REQUEST_TIMEOUT } from "../src/api/client";
import { isApiComparison, type ApiComparison } from "../src/api/types";
import {
  describeCompareUncertain,
  describeComparisonError,
  fetchComparison,
  mapComparison,
  policyFieldMessage,
  submitComparison,
  toComparePayload,
  type ComparePayload,
} from "../src/features/compare/compareApi";
import { validateCompare } from "../src/features/compare/compareValidate";
import type { ReferenceData, ServerError, TransactionPayload } from "../src/features/newTransaction/types";
import { initialValues } from "../src/features/newTransaction/validate";
import { SUBMIT_TIMEOUT_MS } from "../src/features/newTransaction/submitApi";
import { PREVIEW_REFERENCE } from "../src/preview/previewReference";
import { comparisonError, fixtureComparison, fixturePpoDecision, fixtureSavedComparison } from "./msw/compare";

afterEach(() => vi.useRealTimers());

const comparison = () => fixtureComparison() as unknown as ApiComparison;
const payload: ComparePayload = {
  senderCountry: "GBR",
  receiverCountry: "PHL",
  amountUsd: 300000,
  state: { mode: "scenario", date: "2024-06-14", scenarioId: "cheapest_venue_outage" },
  policies: ["waterfall", "cheapestFeasible", "ppoProjected"],
};

function clientReturning(body: unknown, init: ResponseInit = {}) {
  const fetchImpl = vi.fn<typeof fetch>(
    async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { headers: { "Content-Type": "application/json" }, ...init }),
  );
  return { api: createApiClient({ getToken: () => "t", fetchImpl }), fetchImpl };
}

describe("the contract's comparison fixtures", () => {
  it("pass the strict check", () => {
    expect(isApiComparison(fixtureComparison())).toBe(true);
    expect(isApiComparison(fixtureSavedComparison())).toBe(true);
    expect(isApiComparison(structuredClone(comparison()))).toBe(true);
  });

  it("have the waterfall and cheapest-feasible results and the PPO skipped, in the order asked", () => {
    const c = fixtureComparison();
    expect(c.policies).toEqual(["waterfall", "cheapestFeasible", "ppoProjected"]);
    expect(c.results.map((r) => r.policy)).toEqual(["waterfall", "cheapestFeasible"]);
    expect(c.skipped.map((s) => s.policy)).toEqual(["ppoProjected"]);
  });
});

describe("isApiComparison is strict", () => {
  const broken = (change: (c: ApiComparison) => void) => {
    const c = structuredClone(comparison());
    change(c);
    return c;
  };

  it("accepts a comparison where every policy ran, with a PPO result, and ignores extra fields", () => {
    const all = broken((c) => {
      c.results.push(fixturePpoDecision() as never);
      c.skipped = [];
    });
    expect(isApiComparison({ ...all, extra: 1 })).toBe(true);
  });

  it("accepts one where every policy was skipped, with no corridor", () => {
    const none = broken((c) => {
      c.policies = ["ppoProjected"];
      c.results = [];
      c.transaction.corridor = null;
    });
    expect(isApiComparison(none)).toBe(true);
  });

  it.each([
    ["null", () => null],
    ["no policies", () => broken((c) => (c.policies = []))],
    ["a policy listed twice", () => broken((c) => (c.policies = ["waterfall", "waterfall", "ppoProjected"]))],
    ["a result for a policy that wasn't asked for", () => broken((c) => (c.policies = ["waterfall", "ppoProjected"]))],
    ["a policy with neither a result nor a skipped entry", () => broken((c) => (c.skipped = []))],
    ["a policy with both a result and a skipped entry", () => broken((c) => c.skipped.push({ policy: "waterfall", code: "X", message: "m" }))],
    ["a skipped entry for a policy that wasn't asked for", () => broken((c) => (c.skipped = [{ policy: "baseline", code: "X", message: "m" }]))],
    ["results out of the order asked for", () => broken((c) => c.results.reverse())],
    ["the same result twice", () => broken((c) => (c.results[1] = c.results[0]!))],
    ["sameState false", () => broken((c) => ((c as unknown as Record<string, unknown>).sameState = false))],
    ["sameState missing", () => broken((c) => delete (c as unknown as Record<string, unknown>).sameState)],
    ["a corridor where nothing ran", () => broken((c) => { c.policies = ["ppoProjected"]; c.results = []; })],
    ["no corridor where something ran", () => broken((c) => (c.transaction.corridor = null))],
    ["a result with no metrics", () => broken((c) => delete (c.results[0] as unknown as Record<string, unknown>).metrics)],
    ["a result whose reward is a string", () => broken((c) => ((c.results[0]!.metrics as unknown as Record<string, unknown>).rewardAmountBased = "x"))],
    ["a result with no projection flag", () => broken((c) => delete (c.results[0]!.diagnostics as unknown as Record<string, unknown>).projectionApplied)],
    ["an allocation with no pre-projection share field", () => broken((c) => delete (c.results[0]!.allocations[0] as unknown as Record<string, unknown>).shareBeforeProjection)],
    ["a skipped entry with no message", () => broken((c) => delete (c.skipped[0] as unknown as Record<string, unknown>).message)],
    ["no note", () => broken((c) => delete (c as unknown as Record<string, unknown>).note)],
    ["a transaction with no amount", () => broken((c) => delete (c.transaction as unknown as Record<string, unknown>).amountUsd)],
  ])("rejects %s", (_name, make) => {
    expect(isApiComparison(make())).toBe(false);
  });
});

describe("mapComparison", () => {
  it("makes one column per requested policy, in the order requested, with a skipped one in place", () => {
    const view = mapComparison(comparison());
    expect(view.columns.map((c) => [c.kind, c.policy])).toEqual([
      ["result", "waterfall"],
      ["result", "cheapestFeasible"],
      ["skipped", "ppoProjected"],
    ]);
  });

  it("keeps a skipped policy in the middle of the order", () => {
    const c = structuredClone(comparison());
    c.policies = ["waterfall", "ppoProjected", "cheapestFeasible"];
    expect(isApiComparison(c)).toBe(true);
    expect(mapComparison(c).columns.map((x) => [x.kind, x.policy])).toEqual([
      ["result", "waterfall"],
      ["skipped", "ppoProjected"],
      ["result", "cheapestFeasible"],
    ]);
  });

  it("keeps the order the caller asked for, whatever it is", () => {
    const c = structuredClone(comparison());
    c.policies = ["cheapestFeasible", "waterfall", "ppoProjected"];
    c.results = [c.results[1]!, c.results[0]!];
    expect(mapComparison(c).columns.map((x) => x.policy)).toEqual(["cheapestFeasible", "waterfall", "ppoProjected"]);
  });

  it("copies a skipped policy's code and the engine's message, unchanged", () => {
    const skipped = mapComparison(comparison()).columns[2]!;
    expect(skipped).toEqual({ kind: "skipped", policy: "ppoProjected", code: "POLICY_DISABLED", message: "no approved checkpoint configured" });
  });

  it("copies each result's numbers, derives the outcome, and keeps the metrics' weight status", () => {
    const raw = comparison();
    const [waterfall, cheapest] = mapComparison(raw).columns;
    if (waterfall?.kind !== "result" || cheapest?.kind !== "result") throw new Error("expected two results");
    expect(waterfall.decision.outcome).toBe("completed");
    expect(cheapest.decision.outcome).toBe("partial");
    expect(waterfall.decision.metrics).toEqual({
      feeCostUsd: raw.results[0]!.metrics.feeCostUsd,
      latencyTerm: raw.results[0]!.metrics.latencyTerm,
      riskTerm: raw.results[0]!.metrics.riskTerm,
      rewardAmountBased: raw.results[0]!.metrics.rewardAmountBased,
      weightsStatus: "placeholder",
    });
    expect(cheapest.decision.totals).toMatchObject({
      executedUsd: 15000,
      unroutedAmountBasedUsd: raw.results[1]!.totals.unroutedAmountBasedUsd,
      completionRatio: raw.results[1]!.totals.completionRatio,
    });
    expect(waterfall.decision.allocations).toHaveLength(raw.results[0]!.allocations.length);
    expect(waterfall.decision.allocations[0]).toMatchObject({ bridgeUid: raw.results[0]!.allocations[0]!.bridgeUid, shareBeforeProjection: null });
    expect(cheapest.decision.warnings.map((w) => w.code)).toContain("PARTIAL_COMPLETION");
    expect(waterfall.decision.policyTier).toBe("default");
    expect(cheapest.decision.policyTier).toBe("baseline");
  });

  it("carries the PPO decision's tier, projection flag and pre-projection shares", () => {
    const c = structuredClone(comparison());
    c.results.push(fixturePpoDecision() as never);
    c.skipped = [];
    const ppo = mapComparison(c).columns[2]!;
    if (ppo.kind !== "result") throw new Error("expected a result");
    expect(ppo.decision.policyTier).toBe("experimental");
    expect(ppo.decision.projectionApplied).toBe(true);
    expect(ppo.decision.allocations[0]!.shareBeforeProjection).toBe(0.34);
  });

  it("copies the transaction, the note as written, and a rejection as a result", () => {
    const c = structuredClone(comparison());
    c.results[0]!.feasibility = { ...c.results[0]!.feasibility, allowed: false, reason: "Over the limit." };
    c.results[0]!.totals = { ...c.results[0]!.totals, completed: false };
    const view = mapComparison(c);
    expect(view.note).toBe(c.note);
    expect(view.note).toMatch(/Not evidence that one policy is better/);
    expect(view.transaction).toEqual(c.transaction);
    expect(view.stateMode).toBe("scenario");
    expect((view.columns[0] as { decision: { outcome: string } }).decision.outcome).toBe("rejected");
  });

  it("passes an unknown policy name through as written", () => {
    const c = structuredClone(comparison());
    c.policies = ["waterfall", "cheapestFeasible", "futurePolicy"];
    c.skipped = [{ policy: "futurePolicy", code: "POLICY_DISABLED", message: "x" }];
    expect(mapComparison(c).columns[2]!.policy).toBe("futurePolicy");
  });

  it("makes no field a ranking: no score, rank, winner or best among the model's fields", () => {
    const names: string[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (typeof value === "object" && value !== null) {
        for (const [key, inner] of Object.entries(value)) {
          names.push(key);
          walk(inner);
        }
      }
    };
    walk(mapComparison(comparison()));
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((n) => /rank|winner|best|score|better|order|position/i.test(n))).toEqual([]);
  });
});

describe("toComparePayload and validateCompare", () => {
  const form = (patch: Partial<ReturnType<typeof initialValues>> = {}) => ({
    ...initialValues(),
    corridor: "GBR->PHL",
    amountUsd: "100000",
    mode: "historicalReplay" as const,
    date: "2024-06-14",
    ...patch,
  });

  it("replaces the single policy with the chosen policies, in order, and keeps the rest", () => {
    const single: TransactionPayload = {
      senderCountry: "GBR",
      receiverCountry: "PHL",
      amountUsd: 5,
      state: { mode: "historicalReplay", date: "2024-06-14" },
      policy: "waterfall",
      clientReference: "ref",
    };
    const out = toComparePayload(single, ["cheapestFeasible", "waterfall"]);
    expect(out).toEqual({
      senderCountry: "GBR",
      receiverCountry: "PHL",
      amountUsd: 5,
      state: { mode: "historicalReplay", date: "2024-06-14" },
      policies: ["cheapestFeasible", "waterfall"],
      clientReference: "ref",
    });
    expect(out).not.toHaveProperty("policy");
  });

  it("builds the payload from the transaction form's own validation", () => {
    const result = validateCompare(form({ clientReference: " demo " }), PREVIEW_REFERENCE, ["waterfall", "cheapestFeasible"], "analyst");
    expect(result.errors).toEqual({});
    expect(result.payload).toEqual({
      senderCountry: "GBR",
      receiverCountry: "PHL",
      amountUsd: 100000,
      state: { mode: "historicalReplay", date: "2024-06-14" },
      policies: ["waterfall", "cheapestFeasible"],
      clientReference: "demo",
    });
  });

  it.each([[[]], [["waterfall"]]])("needs at least two policies (%j)", (chosen) => {
    const result = validateCompare(form(), PREVIEW_REFERENCE, chosen as never, "analyst");
    expect(result.payload).toBeNull();
    expect(result.errors.policies).toBe("Choose at least two policies to compare.");
  });

  it("keeps the transaction form's own errors, and reports the policies too", () => {
    const result = validateCompare(form({ corridor: "", amountUsd: "0" }), PREVIEW_REFERENCE, ["waterfall"], "analyst");
    expect(result.errors.corridor).toBe("Choose a corridor.");
    expect(result.errors.amountUsd).toBeTruthy();
    expect(result.errors.policies).toBeTruthy();
    expect(result.errors).not.toHaveProperty("policy");
  });

  it("lets an analyst send the experimental policy, and refuses a viewer", () => {
    expect(validateCompare(form(), PREVIEW_REFERENCE, ["waterfall", "ppoProjected"], "analyst").payload?.policies).toEqual(["waterfall", "ppoProjected"]);
    for (const role of ["viewer", undefined] as const) {
      const result = validateCompare(form(), PREVIEW_REFERENCE, ["waterfall", "ppoProjected"], role);
      expect(result.payload).toBeNull();
      expect(result.errors.policies).toBe("Only analysts can compare the experimental policy.");
    }
  });

  it("allows the experimental policy even when the engine has it switched off: the engine will skip it", () => {
    const off: ReferenceData = { ...PREVIEW_REFERENCE, policies: PREVIEW_REFERENCE.policies.map((p) => (p.policy === "ppoProjected" ? { ...p, enabled: false } : p)) };
    expect(validateCompare(form(), off, ["waterfall", "ppoProjected"], "analyst").payload).not.toBeNull();
  });

  it("refuses a policy the form doesn't list", () => {
    const result = validateCompare(form(), PREVIEW_REFERENCE, ["waterfall", "mystery" as never], "analyst");
    expect(result.errors.policies).toBe("Choose only the listed policies.");
  });

  it("sends only canonical names, never an alias", () => {
    const payload = validateCompare(form(), PREVIEW_REFERENCE, ["waterfall", "cheapestFeasible"], "analyst").payload!;
    expect(JSON.stringify(payload)).not.toMatch(/baseline|ruleBased/);
  });
});

describe("submitComparison", () => {
  it("sends the payload once, to /comparisons, and maps the saved comparison", async () => {
    const { api, fetchImpl } = clientReturning(fixtureComparison(), { status: 201 });
    const result = await submitComparison(api, payload);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`${window.location.origin}/api/v1/comparisons`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(payload);
    expect(result.kind).toBe("saved");
    if (result.kind === "saved") expect(result.comparison.columns).toHaveLength(3);
  });

  it.each([
    ["403_forbidden_policy_comparison", 403, "FORBIDDEN_POLICY"],
    ["422_validation_error", 422, "VALIDATION_ERROR"],
    ["422_invalid_amount", 422, "INVALID_AMOUNT"],
    ["422_date_in_gap_buffer_passthrough", 422, "DATE_IN_GAP_BUFFER"],
    ["503_engine_busy", 503, "ENGINE_BUSY"],
    ["503_inference_not_ready", 503, "INFERENCE_UNAVAILABLE"],
    ["504_engine_timeout", 504, "ENGINE_TIMEOUT"],
    ["502_inference_error", 502, "INFERENCE_ERROR"],
    ["500_internal_error", 500, "INTERNAL_ERROR"],
  ])("%s is a definite error that keeps the backend's message, code and request ID", async (file, status, code) => {
    const body = comparisonError(file) as { error: { message: string; details: Record<string, unknown>; requestId: string } };
    const { api, fetchImpl } = clientReturning(body, { status });
    const result = await submitComparison(api, payload);
    expect(result).toEqual({
      kind: "error",
      error: { status, code, message: body.error.message, details: body.error.details, requestId: body.error.requestId },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // never retried
  });

  it("a connection failure is uncertain (network), not a definite error", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    const result = await submitComparison(createApiClient({ getToken: () => "t", fetchImpl }), payload);
    expect(result).toEqual({ kind: "uncertain", reason: "network" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("no answer within 25 seconds is uncertain (timeout), and is never retried", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const pending = submitComparison(createApiClient({ getToken: () => "t", fetchImpl }), payload);
    await vi.advanceTimersByTimeAsync(SUBMIT_TIMEOUT_MS);
    expect(await pending).toEqual({ kind: "uncertain", reason: "timeout" });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a 201 whose body isn't JSON", "not json", 201],
    ["a 201 whose body isn't a comparison", { hello: "world" }, 201],
    ["a 201 comparison that contradicts itself", { ...fixtureComparison(), sameState: false }, 201],
    ["a gateway page with no envelope (a proxy 502)", "<html>Bad gateway</html>", 502],
  ])("%s is uncertain (unreadable)", async (_name, body, status) => {
    expect(await submitComparison(clientReturning(body, { status }).api, payload)).toEqual({ kind: "uncertain", reason: "unreadable" });
  });

  it("an error that isn't an ApiError is uncertain, never 'not saved'", async () => {
    const api = { get: vi.fn(), post: vi.fn().mockRejectedValue(new Error("boom")) };
    expect(await submitComparison(api, payload)).toEqual({ kind: "uncertain", reason: "unreadable" });
  });

  it("the warning says it may have been saved, that comparisons can't be listed, and that sending again makes another record", () => {
    for (const [reason, code] of [
      ["timeout", REQUEST_TIMEOUT],
      ["network", NETWORK_ERROR],
      ["unreadable", INVALID_RESPONSE],
    ] as const) {
      const view = describeCompareUncertain(reason);
      const text = view.messages.join(" ");
      expect(view.title).toMatch(/can't tell whether this comparison was saved/);
      expect(text).toMatch(/may have been saved/);
      expect(text).toMatch(/can't be listed/);
      expect(text).toMatch(/another, independent record/);
      expect(text).not.toMatch(/History before/);
      expect(text).not.toMatch(/nothing was saved/i);
      expect(view.code).toBe(code);
    }
    expect(describeCompareUncertain("timeout").messages[0]).toMatch(/25 seconds/);
  });
});

describe("policyFieldMessage", () => {
  const error = (patch: Partial<ServerError>): ServerError => ({ status: 422, code: "VALIDATION_ERROR", message: "M", details: {}, requestId: "r", ...patch });

  it("takes the server's message for a problem it puts on policies or one of its entries", () => {
    expect(policyFieldMessage(error({ details: { errors: [{ field: "policies", message: "Must be a list." }] } }))).toBe("Must be a list.");
    expect(policyFieldMessage(error({ details: { errors: [{ field: "amountUsd", message: "x" }, { field: "policies[1]", message: "Listed more than once." }] } }))).toBe("Listed more than once.");
    expect(policyFieldMessage(error({ code: "FORBIDDEN_POLICY", status: 403, message: "Only analysts may request ppoProjected." }))).toBe("Only analysts may request ppoProjected.");
    expect(policyFieldMessage(error({ code: "POLICY_UNAVAILABLE_FOR_STATE", details: { field: "policies" } }))).toBe("M");
  });

  it("leaves everything else alone", () => {
    expect(policyFieldMessage(error({ details: { errors: [{ field: "amountUsd", message: "x" }, { message: "no field" }] } }))).toBeNull();
    expect(policyFieldMessage(error({ code: "ENGINE_BUSY", status: 503 }))).toBeNull();
    expect(policyFieldMessage(error({ details: { errors: [{ field: "policy", message: "x" }] } }))).toBeNull();
  });
});

describe("fetchComparison and describeComparisonError", () => {
  const id = fixtureSavedComparison().id;

  it("asks for /comparisons/<id> and maps the comparison", async () => {
    const { api, fetchImpl } = clientReturning(fixtureSavedComparison());
    const view = await fetchComparison(api, id);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(`${window.location.origin}/api/v1/comparisons/${id}`);
    expect(view.id).toBe(id);
    expect(view.columns.map((c) => c.policy)).toEqual(["waterfall", "cheapestFeasible", "ppoProjected"]);
  });

  it("refuses a body that isn't a comparison, or is another comparison", async () => {
    await expect(fetchComparison(clientReturning({ nope: true }).api, id)).rejects.toMatchObject({ code: INVALID_RESPONSE });
    await expect(fetchComparison(clientReturning(fixtureSavedComparison()).api, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: INVALID_RESPONSE });
  });

  it("describes errors in its own words: not found without a retry, the rest with one", () => {
    const api = (status: number, code: string, requestId?: string) => new ApiError({ status, code, message: "BACKEND TEXT", requestId });
    expect(describeComparisonError(api(404, "NOT_FOUND"))).toMatchObject({ message: "This comparison doesn't exist.", canRetry: false });
    expect(describeComparisonError(api(403, "X")).canRetry).toBe(false);
    for (const e of [api(0, NETWORK_ERROR), api(200, INVALID_RESPONSE), api(500, "INTERNAL_ERROR"), api(418, "TEAPOT")]) {
      const view = describeComparisonError(e);
      expect(view.canRetry).toBe(true);
      expect(view.message).not.toContain("BACKEND TEXT");
    }
    expect(describeComparisonError(api(500, "INTERNAL_ERROR", "req-1")).reference).toBe("req-1");
    expect(describeComparisonError(new Error("x")).message).toMatch(/went wrong/);
  });
});
