import { describe, expect, it } from "vitest";
import type { SubmitResult, TransactionPayload } from "../src/features/newTransaction/types";
import { MOCK_FAILURES, readMockFailure, submitPreviewTransaction } from "../src/preview/mockSubmit";
import { PREVIEW_ENGINE_MODEL, PREVIEW_REFERENCE } from "../src/preview/previewReference";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/;

const replay = (patch: Partial<TransactionPayload> = {}): TransactionPayload => ({
  senderCountry: "GBR",
  receiverCountry: "PHL",
  amountUsd: 100000,
  state: { mode: "historicalReplay", date: "2024-06-14" },
  policy: "waterfall",
  ...patch,
});
const explicit = (liquidity: [number, number, number], amountUsd = 100000, policy: TransactionPayload["policy"] = "waterfall"): TransactionPayload => ({
  senderCountry: "GBR",
  receiverCountry: "PHL",
  amountUsd,
  state: {
    mode: "explicit",
    referenceDate: "2024-06-14",
    venues: liquidity.map((liquidityUsd, i) => ({ bridgeUid: `GBR->PHL#${i}`, liquidityUsd, congestion: 0.2 })),
  },
  policy,
});
const submit = (payload: TransactionPayload, failure: Parameters<typeof submitPreviewTransaction>[1] = {}) =>
  submitPreviewTransaction(payload, { delayMs: 0, ...failure });

function routed(result: SubmitResult) {
  if (result.kind !== "routed") throw new Error(`expected a routed result, got ${result.error.code}`);
  return result.transaction;
}
function failed(result: SubmitResult) {
  if (result.kind !== "error") throw new Error("expected an error");
  return result.error;
}

describe("readMockFailure", () => {
  it.each(MOCK_FAILURES)("reads ?mock=%s", (value) => {
    expect(readMockFailure(new URLSearchParams({ mock: value }))).toBe(value);
  });
  it.each(["", "other", "BUSY", "state"])("ignores %j", (value) => {
    expect(readMockFailure(new URLSearchParams({ mock: value }))).toBeNull();
  });
  it("is null without the parameter", () => {
    expect(readMockFailure(new URLSearchParams())).toBeNull();
  });
});

describe("results that are business outcomes", () => {
  it("completes when the venues hold enough, filling the cheapest first", async () => {
    const t = routed(await submit(explicit([400000, 400000, 400000])));
    expect(t.outcome).toBe("completed");
    expect(t.status).toBe("routed");
    expect(t.failure).toBeNull();
    expect(t.corridor).toBe("GBR->PHL");
    const d = t.decision!;
    expect(d.totals).toMatchObject({ executedUsd: 100000, unroutedAmountBasedUsd: 0, completed: true, completionRatio: 1, bridgesUsed: 1 });
    // GBR->PHL#1 has the lowest fee in the preview reference data, so it is filled first.
    expect(d.allocations.find((a) => a.bridgeUid === "GBR->PHL#1")?.amountExecutedUsd).toBe(100000);
    expect(d.warnings.some((w) => w.code === "PARTIAL_COMPLETION")).toBe(false);
  });

  it("is a partial completion, not an error, when the venues hold too little", async () => {
    const t = routed(await submit(explicit([10000, 10000, 10000])));
    expect(t.outcome).toBe("partial");
    const d = t.decision!;
    expect(d.totals).toMatchObject({ executedUsd: 30000, unroutedAmountBasedUsd: 70000, completed: false, bridgesUsed: 3 });
    expect(d.totals.completionRatio).toBeCloseTo(0.3, 12);
    expect(d.warnings.map((w) => w.code)).toContain("PARTIAL_COMPLETION");
  });

  it("clips cheapestFeasible at the cheapest venue's liquidity", async () => {
    const t = routed(await submit(explicit([400000, 50000, 400000], 100000, "cheapestFeasible")));
    expect(t.outcome).toBe("partial");
    const cheapest = t.decision!.allocations.find((a) => a.bridgeUid === "GBR->PHL#1")!;
    expect(cheapest).toMatchObject({ amountRequestedUsd: 100000, amountExecutedUsd: 50000, amountClippedUsd: 50000 });
    expect(t.policyTier).toBe("baseline");
  });

  it("rejects an amount over the cap as a routed result with no allocations", async () => {
    const t = routed(await submit(replay({ amountUsd: 600000 })));
    expect(t.outcome).toBe("rejected");
    const d = t.decision!;
    expect(d.feasibility.allowed).toBe(false);
    expect(d.feasibility.reason).toBeTruthy();
    expect(d.allocations).toEqual([]);
    expect(d.totals).toMatchObject({ executedUsd: 0, unroutedAmountBasedUsd: 600000, completed: false });
  });

  it("accepts an amount exactly at the cap", async () => {
    expect(routed(await submit(explicit([900000, 900000, 900000], 500000))).decision!.feasibility.allowed).toBe(true);
  });

  it("routes replay and scenario states, and echoes the request", async () => {
    const replayed = routed(await submit(replay({ clientReference: "PO-9" })));
    expect(replayed).toMatchObject({ stateMode: "historicalReplay", simulationDate: "2024-06-14", clientReference: "PO-9", amountUsd: 100000 });
    const scenario = routed(await submit(replay({ state: { mode: "scenario", date: "2024-06-14", scenarioId: "baseline" } })));
    expect(scenario.stateMode).toBe("scenario");
  });

  it("keeps every result internally consistent", async () => {
    const payloads = [
      explicit([400000, 400000, 400000]),
      explicit([10000, 10000, 10000]),
      explicit([40000, 30000, 20000], 75000),
      explicit([400000, 50000, 400000], 100000, "cheapestFeasible"),
      replay({ amountUsd: 123456.78 }),
      replay({ senderCountry: "USA", receiverCountry: "IND", amountUsd: 480000, state: { mode: "scenario", date: "2025-02-11", scenarioId: "cheapest_venue_outage" } }),
      replay({ senderCountry: "ARE", receiverCountry: "MEX", amountUsd: 250000, state: { mode: "scenario", date: "2024-09-03", scenarioId: "liquidity_minus50" } }),
    ];
    for (const payload of payloads) {
      const t = routed(await submit(payload));
      const d = t.decision!;
      const executed = d.allocations.reduce((s, a) => s + a.amountExecutedUsd, 0);
      expect(d.totals.executedUsd).toBeCloseTo(executed, 2);
      expect(d.totals.unroutedAmountBasedUsd).toBeCloseTo(payload.amountUsd - d.totals.executedUsd, 2);
      expect(d.totals.completed).toBe(t.outcome === "completed");
      for (const a of d.allocations) {
        expect(a.amountExecutedUsd).toBeLessThanOrEqual(a.amountRequestedUsd + 1e-9);
        expect(a.amountExecutedUsd).toBeLessThanOrEqual(a.liquidityUsd + 1e-9);
      }
    }
  });

  it("gives each submission its own transaction ID, in UUID form", async () => {
    const a = routed(await submit(replay()));
    const b = routed(await submit(replay()));
    expect(a.id).toMatch(UUID);
    expect(b.id).toMatch(UUID);
    expect(a.id).not.toBe(b.id);
  });
});

describe("errors the engine would return", () => {
  it.each([
    ["a date after the data ends", { state: { mode: "historicalReplay", date: "2025-10-01" } }, "DATE_OUT_OF_RANGE"],
    ["a date before the data starts", { state: { mode: "historicalReplay", date: "2000-01-01" } }, "DATE_OUT_OF_RANGE"],
    ["an unknown scenario", { state: { mode: "scenario", date: "2024-06-14", scenarioId: "nope" } }, "UNKNOWN_SCENARIO"],
    ["an unsupported corridor", { senderCountry: "USA", receiverCountry: "MEX" }, "UNSUPPORTED_CORRIDOR"],
    ["ppoProjected", { policy: "ppoProjected" }, "POLICY_DISABLED"],
    ["a zero amount", { amountUsd: 0 }, "INVALID_AMOUNT"],
  ] as [string, Partial<TransactionPayload>, string][])("rejects %s", async (_label, patch, code) => {
    const error = failed(await submit(replay(patch)));
    expect(error.code).toBe(code);
    expect(error.status).toBe(code === "POLICY_DISABLED" ? 409 : 422);
    expect(error.details.transactionId).toBeUndefined(); // 4xx: nothing was saved
    expect(error.requestId).toMatch(/^preview-/);
    expect(error.message).toBeTruthy();
  });

  it("rejects explicit venues that don't belong to the corridor, or none at all", async () => {
    const wrong = explicit([1, 1, 1]);
    if (wrong.state.mode === "explicit") wrong.state.venues[0]!.bridgeUid = "USA->IND#0";
    expect(failed(await submit(wrong)).code).toBe("STATE_VENUE_MISMATCH");
    const none = explicit([1, 1, 1]);
    if (none.state.mode === "explicit") none.state.venues = [];
    expect(failed(await submit(none)).code).toBe("STATE_VENUE_MISMATCH");
  });

  it("rejects a negative explicit value the way the engine would", async () => {
    expect(failed(await submit(explicit([-1, 100, 100]))).code).toBe("INVALID_STATE_VALUE");
  });
});

describe("forced failures (?mock=...)", () => {
  it("validation: a 422 with a field error and a form-level error, nothing saved", async () => {
    const error = failed(await submit(replay(), { failure: "validation" }));
    expect(error).toMatchObject({ status: 422, code: "VALIDATION_ERROR" });
    expect(error.details.errors).toEqual([
      { field: "amountUsd", message: expect.any(String) },
      { message: expect.any(String) },
    ]);
    expect(error.details.errors![1]).not.toHaveProperty("field");
    expect(error.details.transactionId).toBeUndefined();
  });

  it.each([
    ["busy", 503, "ENGINE_BUSY"],
    ["timeout", 504, "ENGINE_TIMEOUT"],
    ["unavailable", 503, "INFERENCE_UNAVAILABLE"],
    ["error", 502, "INFERENCE_ERROR"],
  ] as const)("%s: a persisted %i %s with a transaction ID", async (failure, status, code) => {
    const error = failed(await submit(replay(), { failure }));
    expect(error).toMatchObject({ status, code });
    expect(error.details.transactionId).toMatch(UUID);
    expect(error.requestId).toMatch(/^preview-/);
    expect(error.message).toBeTruthy();
  });

  it("notready: a persisted 503 INFERENCE_UNAVAILABLE with details.cause NOT_READY", async () => {
    const error = failed(await submit(replay(), { failure: "notready" }));
    expect(error).toMatchObject({ status: 503, code: "INFERENCE_UNAVAILABLE" });
    expect(error.details.cause).toBe("NOT_READY");
    expect(error.details.transactionId).toMatch(UUID);
    expect(error.requestId).toMatch(/^preview-/);
    expect(error.message).toBe("The inference service is unavailable.");
    expect(Object.keys(error.details).sort()).toEqual(["cause", "transactionId"]); // nothing else, and no field or errors
  });

  it("notready is the only scenario with a cause: the plain unavailable scenario has none", async () => {
    for (const failure of ["validation", "busy", "timeout", "unavailable", "error"] as const) {
      expect(failed(await submit(replay(), { failure })).details.cause, failure).toBeUndefined();
    }
    expect(failed(await submit(replay(), { failure: "notready" })).details.cause).toBe("NOT_READY");
  });

  it("notready differs from unavailable only in the cause", async () => {
    const plain = failed(await submit(replay(), { failure: "unavailable" }));
    const starting = failed(await submit(replay(), { failure: "notready" }));
    expect(starting.status).toBe(plain.status);
    expect(starting.code).toBe(plain.code);
    expect(starting.message).toBe(plain.message);
  });

  it("notready models no Retry-After", async () => {
    expect(JSON.stringify(failed(await submit(replay(), { failure: "notready" })))).not.toMatch(/retry/i);
  });

  it("forces the failure whatever the inputs", async () => {
    expect(failed(await submit(replay({ amountUsd: 600000 }), { failure: "busy" })).code).toBe("ENGINE_BUSY");
  });

  // About the preview data only. Whether the real backend forwards a Retry-After on ENGINE_BUSY or NOT_READY
  // is unresolved (the contract says it does, the backend developer says it doesn't), so this makes no claim
  // about it: the preview error simply has no such value, and the screen has nothing to show one with.
  it("models no Retry-After in the preview error", async () => {
    const error = failed(await submit(replay(), { failure: "busy" }));
    expect(JSON.stringify(error)).not.toMatch(/retry/i);
  });

  it("does not retry by itself: one submission is one answer, however long it takes", async () => {
    const first = await submit(replay(), { failure: "busy" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Nothing runs on a timer after the answer: asking again is a new, separate submission with its own ID.
    const second = await submit(replay(), { failure: "busy" });
    expect(first.kind).toBe("error");
    expect(second.kind).toBe("error");
    expect(failed(first).details.transactionId).not.toBe(failed(second).details.transactionId);
  });
});

describe("preview scenarios", () => {
  const ids = PREVIEW_REFERENCE.scenarios.map((s) => s.scenarioId);

  it("are sorted by scenarioId in ordinal order, the order the API returns them in since contract rev 5", () => {
    const ordinal = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // code-point order, not a locale sort
    expect(ids).toEqual(ordinal);
    expect(ids).toEqual(["baseline", "cheapest_venue_outage", "combined_stress", "congestion_x2", "liquidity_minus30", "liquidity_minus50"]);
  });

  it("are still the same six scenarios, each with a description and its multipliers", () => {
    expect(new Set(ids).size).toBe(6);
    expect([...ids].sort()).toEqual(Object.keys(PREVIEW_ENGINE_MODEL.scenarioMultipliers).sort());
    for (const s of PREVIEW_REFERENCE.scenarios) expect(s.description.length).toBeGreaterThan(0);
    expect(PREVIEW_ENGINE_MODEL.scenarioMultipliers.cheapest_venue_outage).toEqual({ liquidity: 1, cheapest: 0.1 });
    expect(PREVIEW_ENGINE_MODEL.scenarioMultipliers.combined_stress).toEqual({ liquidity: 0.7, cheapest: 1 });
  });

  it("are all accepted by the mock engine, in any order", async () => {
    for (const scenarioId of [...ids].reverse()) {
      const result = await submit(replay({ state: { mode: "scenario", date: "2024-06-14", scenarioId } }));
      expect(result.kind, scenarioId).toBe("routed");
    }
  });
});
